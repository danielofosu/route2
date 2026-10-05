import http from 'node:http';
import https from 'node:https';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { gunzipSync, brotliDecompressSync, zstdDecompressSync } from 'node:zlib';
import { STATUS_PAGE } from './classifier_status.mjs';

export const SENTINEL = 'route2-router';
export const MODEL = 'gpt-6.1-sol';
import { createRoutingEngine, logicalRequestHash, normalizeHookEvent, latestHookTurn } from './routing_state.mjs';
const HOP_HEADERS = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

const textOf = content => typeof content === 'string' ? content : Array.isArray(content)
  ? content.filter(x => ['text', 'input_text'].includes(x?.type)).map(x => x.text ?? '').join('\n') : '';

export function freshPrompt(body) {
  if (!Array.isArray(body.input)) return typeof body.input === 'string' ? body.input : null;
  for (const item of [...body.input].reverse()) {
    if (['function_call_output', 'custom_tool_call_output'].includes(item?.type)) return null;
    if (item?.role === 'user') {
      const text = textOf(item.content).replace(/<environment_context>[\s\S]*?<\/environment_context>/g, '').trim();
      return text || null;
    }
  }
  return null;
}

export function requestIdentity(body, headers) {
  let metadata = body.client_metadata ?? {};
  try { if (headers['x-codex-turn-metadata']) metadata = { ...metadata, ...JSON.parse(headers['x-codex-turn-metadata']) }; } catch { /* Optional metadata only. */ }
  const explicit = metadata.session_id ?? headers.session_id ?? headers['session-id'] ?? headers['x-codex-session-id']
    ?? headers['thread-id'] ?? headers.thread_id ?? metadata.thread_id;
  const logicalRequestId = logicalRequestHash(body);
  return { sessionId: String(explicit ?? body.prompt_cache_key ?? `anonymous:${logicalRequestId}`),
    logicalRequestId, stableIdentity: Boolean(explicit ?? body.prompt_cache_key),
    turnId: metadata.turn_id ?? headers['x-codex-turn-id'] ?? headers.turn_id ?? headers['turn-id'] };
}

// Only the current continuation batch is used; replayed conversation history
// must not count old failures as new evidence.
export function wireToolOutcomes(body, sessionId, turnId) {
  if (!Array.isArray(body.input)) return [];
  let start = body.input.length;
  while (start > 0 && ['function_call_output', 'custom_tool_call_output'].includes(body.input[start - 1]?.type)) start--;
  return body.input.slice(start).map(item => {
    const call = item.call_id ? body.input.find(x => x.call_id === item.call_id && ['function_call', 'custom_tool_call'].includes(x.type)) : null;
    let input = call?.arguments ?? call?.input ?? {};
    try { if (typeof input === 'string') input = JSON.parse(input); } catch { input = { command: input }; }
    let output = item.output;
    try { if (typeof output === 'string') output = JSON.parse(output); } catch { /* Native shell results can be text. */ }
    return normalizeHookEvent({ hook_event_name: 'PostToolUse', session_id: sessionId, turn_id: turnId,
      tool_use_id: item.call_id, tool_name: call?.name ?? 'unknown', tool_input: input, tool_response: output });
  });
}

function headersWithoutHop(headers) {
  const extra = String(headers.connection ?? '').toLowerCase().split(',').map(x => x.trim());
  return Object.fromEntries(Object.entries(headers).filter(([key]) => !HOP_HEADERS.has(key.toLowerCase()) && !extra.includes(key.toLowerCase())));
}

export function routerClassifier(executable, cwd, { spawnProcess = spawn, onStatus = () => {}, onDiagnostic = () => {} } = {}) {
  let child;
  let ready;
  let warming;
  let supervised = false;
  let closed = false;
  let started;
  let status = { state: 'starting', stage: 'starting', elapsed_ms: 0, updated_at: new Date().toISOString(), message: 'Classifier has not started yet.' };
  let sequence = 0;
  const waiting = new Map();
  const updateStatus = (state, stage, message) => {
    status = { state, stage, message, elapsed_ms: started === undefined ? 0 : Date.now() - started, updated_at: new Date().toISOString() };
    try { onStatus({ ...status }); } catch { }
  };
  const request = (method, params) => new Promise((resolve, reject) => {
    const active = child;
    if (!active) { reject(new Error('classifier unavailable')); return; }
    const id = sequence++;
    const timer = setTimeout(() => { waiting.delete(id); active.kill(); reject(new Error('classifier timeout')); }, 960000);
    waiting.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    active.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const initialize = () => {
    if (closed) throw new Error('classifier stopped');
    const active = spawnProcess(executable, ['--mcp'], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    child = active;
    const fail = () => {
      if (child !== active) return;
      ready = undefined;
      child = undefined;
      for (const value of waiting.values()) value.reject(new Error('classifier unavailable'));
      waiting.clear();
      active.stdin.end();
      if (!closed) updateStatus('error', 'error', 'Classifier unavailable. Check service logs and rerun route2 install-codex --install.');
    };
    active.on('error', fail);
    active.on('exit', fail);
    active.stdin.on('error', fail);
    if (active.stderr) createInterface({ input: active.stderr }).on('line', line => {
      if (child !== active || closed) return;
      try { onDiagnostic(line); } catch { }
      const prefix = '[Route2 classifier] ';
      if (!line.startsWith(prefix)) return;
      try {
        const event = JSON.parse(line.slice(prefix.length));
        const messages = {
          starting: 'Starting the local classifier.',
          loading_dependencies: 'Loading the prepared Python environment.',
          checking_weights: 'Checking cached model weights.',
          downloading_weights: 'Downloading model weights. Normal installs prepare these during setup.',
          materializing_weights: 'Preparing cached model files.',
          loading_model: 'Loading the local model into memory.',
          ready: 'Model loaded; warming up classification.',
          error: 'Classifier startup failed. Check service logs.',
        };
        if (messages[event.stage]) updateStatus(event.stage === 'error' ? 'error' : 'loading', event.stage, messages[event.stage]);
      } catch { }
    });
    createInterface({ input: active.stdout }).on('line', line => {
      if (child !== active) return;
      try {
        const response = JSON.parse(line);
        const value = waiting.get(response.id);
        if (!value) return;
        waiting.delete(response.id);
        if (response.error || response.result?.isError) value.reject(new Error('classifier request failed'));
        else value.resolve(response.result);
      } catch { fail(); }
    });
    return request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'route2-proxy', version: '1' } })
      .then(() => active.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n'))
      .catch(error => { fail(); throw error; });
  };
  const performRoute = async task => {
    if (!ready) {
      const pending = initialize();
      ready = pending;
      pending.catch(() => { if (ready === pending) ready = undefined; });
    }
    await ready;
    const result = await request('tools/call', { name: 'route', arguments: { task, report_decision_time_ms: true } });
    return result.structuredContent;
  };
  const classify = async task => {
    if (closed) throw new Error('classifier stopped');
    if (supervised && status.state !== 'ready') {
      classify.warmup().catch(() => {});
      throw new Error('classifier unavailable while loading; using fallback routing');
    }
    try {
      const result = await performRoute(task);
      if (supervised && (result?.task_class === 'error' || !['low', 'medium', 'high', 'max'].includes(result?.recommended_reasoning_effort))) {
        updateStatus('error', 'error', 'Classification failed. Requests use fallback routing while the classifier recovers.');
      } else if (supervised && status.state !== 'ready') {
        updateStatus('ready', 'ready', 'Classifier ready. Model stays loaded until the service stops.');
      }
      return result;
    } catch (error) {
      if (supervised && !closed) updateStatus('error', 'error', 'Classification failed. Requests use fallback routing while the classifier recovers.');
      throw error;
    }
  };
  classify.status = () => ({ ...status, elapsed_ms: status.state === 'loading' ? Date.now() - started : status.elapsed_ms });
  classify.warmup = () => {
    supervised = true;
    if (closed) return Promise.reject(new Error('classifier stopped'));
    if (warming) return warming;
    if (status.state === 'ready') return Promise.resolve();
    started = Date.now();
    updateStatus('loading', 'starting', 'Starting the local classifier before user requests.');
    const pending = performRoute('Classify this warmup task: correct a spelling typo in documentation.')
      .then(result => {
        if (!['low', 'medium', 'high', 'max'].includes(result?.recommended_reasoning_effort) || result?.task_class === 'error') {
          throw new Error('classifier warmup failed');
        }
        if (!closed) updateStatus('ready', 'ready', 'Classifier ready. Model stays loaded until the service stops.');
      })
      .catch(error => {
        if (!closed) updateStatus('error', 'error', 'Classifier unavailable. Check service logs and rerun route2 install-codex --install.');
        throw error;
      })
      .finally(() => { if (warming === pending) warming = undefined; });
    warming = pending;
    return pending;
  };
  classify.close = () => {
    closed = true;
    updateStatus('stopped', 'stopped', 'Classifier service stopped.');
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    return new Promise(resolve => {
      child.once('exit', resolve);
      child.stdin.end();
    });
  };
  return classify;
}

export function addRouterModel(catalog) {
  if (!Array.isArray(catalog?.models) || catalog.models.some(m => m.slug === SENTINEL)) return catalog;
  const template = catalog.models.find(m => m.slug === MODEL);
  if (!template) return catalog; // Never advertise an unavailable upstream model.
  return { ...catalog, models: [{ ...template, slug: SENTINEL, display_name: 'Route2',
    description: 'Decision 2.0 chooses reasoning effort for GPT-6.1 Sol.', visibility: 'list',
    supported_in_api: true, priority: 0, upgrade: null }, ...catalog.models] };
}

export async function startProxy({ upstream, classify, port = 0, onDecision = () => {}, onRequest = () => {}, onTransport = () => {},
  eventDirectory, policy = {}, hookIntegration = 'unconfigured', instanceId }) {
  const target = new URL(upstream);
  if (target.username || target.password || target.search || target.hash) throw new Error('upstream URL cannot contain credentials, query or fragment');
  if (target.protocol !== 'https:' && !(target.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname))) {
    throw new Error('upstream must use HTTPS or loopback HTTP');
  }
  const engine = createRoutingEngine({ classify, policy, eventDirectory,
    onDecision: receipt => onDecision({ ...receipt, model: MODEL, effort: receipt.appliedEffort,
      task_class: receipt.classifier?.taskClass ?? (receipt.fallback ? 'error' : null),
      confidence: receipt.classifier?.confidence ?? null, confidence_calibration: 'uncalibrated' }) });
  const server = http.createServer(async (req, res) => {
    const receivedAt = Date.now();
    let requestIdentityFields;
    const transportEvent = (eventType, fields = {}) => {
      if (!requestIdentityFields) return;
      try { onTransport({ eventType, timestamp: new Date().toISOString(), ...requestIdentityFields, ...fields }); } catch { }
    };
    if (req.method === 'GET' && req.url === '/status') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
        'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'" });
      res.end(STATUS_PAGE);
      return;
    }
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ service: 'route2', model: MODEL, ...(instanceId ? { instanceId } : {}),
        ...(typeof classify.status === 'function' ? { classifier: classify.status() } : {}) }));
      return;
    }
    let size = 0;
    const chunks = [];
    try {
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 64 * 1024 * 1024) { res.writeHead(413); res.end(); return; }
        chunks.push(chunk);
      }
      let out = Buffer.concat(chunks);
      const headers = headersWithoutHop(req.headers);
      if (req.method === 'POST' && /\/responses(?:\?|$)/.test(req.url)) {
        const encoding = String(headers['content-encoding'] ?? '').trim().toLowerCase();
        let decoded = out;
        if (encoding === 'gzip') decoded = gunzipSync(out, { maxOutputLength: 64 * 1024 * 1024 });
        else if (encoding === 'br') decoded = brotliDecompressSync(out, { maxOutputLength: 64 * 1024 * 1024 });
        else if (encoding === 'zstd') decoded = zstdDecompressSync(out, { maxOutputLength: 64 * 1024 * 1024 });
        else if (encoding && encoding !== 'identity') throw new Error('unsupported request encoding');
        const body = JSON.parse(decoded.toString('utf8'));
        if (body.model === SENTINEL) {
          const identity = requestIdentity(body, req.headers);
          requestIdentityFields = { sessionId: identity.sessionId, turnId: identity.turnId, logicalRequestId: identity.logicalRequestId };
          transportEvent('routing_started');
          const turnId = identity.turnId ?? (eventDirectory && identity.stableIdentity
            ? await latestHookTurn(eventDirectory, identity.sessionId) : null) ?? 'default';
          const outcomes = wireToolOutcomes(body, identity.sessionId, turnId);
          const result = await engine.select({ ...identity, turnId, prompt: freshPrompt(body), toolOutcomes: outcomes,
            integration: { body, headers: req.headers, hooks: hookIntegration, stableIdentity: identity.stableIdentity } });
          const receipt = { ...result.receipt, model: MODEL,
            integration: result.receipt.integration === 'hooks-active' ? 'hooks-active' : 'prompt-only',
            hookStatus: result.receipt.integration,
            unsupportedPaths: [...(result.receipt.unsupportedPaths ?? []),
              ...(!identity.stableIdentity ? ['stable_session_identity_unavailable'] : []),
              ...(hookIntegration !== 'configured' ? ['post_tool_use_hooks_unconfigured'] : !result.receipt.hooksObserved ? ['post_tool_use_hooks_pending_or_unavailable'] : [])] };
          try { await onRequest(receipt); } catch { /* Telemetry cannot break transport. */ }
          const state = { effort: result.effort };
          body.model = MODEL;
          body.reasoning = { ...body.reasoning, effort: state.effort };
          out = Buffer.from(JSON.stringify(body));
          delete headers['content-encoding'];
        }
      }
      headers.host = target.host;
      headers['content-length'] = out.length;
      const prefix = target.pathname.replace(/\/$/, '');
      const requestPath = req.url.startsWith(`${prefix}/`) ? req.url : prefix + req.url;
      const transport = target.protocol === 'https:' ? https : http;
      const forwardedAt = Date.now();
      transportEvent('upstream_started', { routing_ms: forwardedAt - receivedAt });
      const forwarded = transport.request({ hostname: target.hostname, port: target.port || undefined,
        path: requestPath, method: req.method, headers }, response => {
        transportEvent('upstream_headers', { upstream_ms: Date.now() - forwardedAt, status: response.statusCode });
        response.once('data', () => transportEvent('upstream_first_byte', { upstream_ms: Date.now() - forwardedAt }));
        const replyHeaders = headersWithoutHop(response.headers);
        // Preserve streaming bytes and terminal events exactly; do not inject synthetic SSE.
        res.writeHead(response.statusCode, replyHeaders);
        response.pipe(res);
        response.on('error', () => res.destroy());
      });
      forwarded.on('error', () => {
        transportEvent('upstream_error', { upstream_ms: Date.now() - forwardedAt });
        if (!res.headersSent) { res.writeHead(502, { 'content-type': 'application/json' }); res.end('{"error":{"message":"Route2 upstream unavailable"}}'); }
        else res.destroy();
      });
      forwarded.setTimeout(180000, () => forwarded.destroy());
      res.on('close', () => { if (!res.writableEnded) forwarded.destroy(); });
      forwarded.end(out);
    } catch {
      if (!res.headersSent) { res.writeHead(400, { 'content-type': 'application/json' }); res.end('{"error":{"message":"Invalid Route2 request"}}'); }
      else res.destroy();
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return { port: server.address().port, engine, close: async () => { await engine.close(); await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); } };
}
