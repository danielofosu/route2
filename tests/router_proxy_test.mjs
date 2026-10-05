import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishEvent, normalizeHookEvent } from '../scripts/routing_state.mjs';
import { gzipSync } from 'node:zlib';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { startProxy, SENTINEL, MODEL, addRouterModel, freshPrompt, requestIdentity, routerClassifier } from '../scripts/router_proxy.mjs';

function deferredClassifier(onStatus = () => {}) {
  const calls = [];
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new Writable({ write(chunk, _encoding, done) {
    const message = JSON.parse(chunk.toString());
    if (message.method === 'initialize') {
      setImmediate(() => child.stdout.write(JSON.stringify({ id: message.id, result: {} }) + '\n'));
    } else if (message.method === 'tools/call') calls.push(message);
    done();
  } });
  child.kill = () => child.emit('exit', 1);
  const classify = routerClassifier('fixture', '.', { spawnProcess: () => child, onStatus });
  const respond = (result = { task_class: 'small', recommended_reasoning_effort: 'low' }) => {
    child.stdout.write(JSON.stringify({ id: calls.at(-1).id, result: { structuredContent: result } }) + '\n');
  };
  const waitForCall = async () => { while (!calls.length) await new Promise(resolve => setImmediate(resolve)); };
  return { classify, child, calls, respond, waitForCall };
}

test('startup warmup is single-flight and prompts fall back without waiting for model load', async context => {
  const statuses = [];
  const classifier = deferredClassifier(event => statuses.push(event));
  context.after(() => classifier.classify.close());
  const loading = classifier.classify.warmup();
  assert.equal(classifier.classify.warmup(), loading);
  await classifier.waitForCall();
  const receipts = [];
  const service = await fixture(context, classifier.classify, { onRequest: event => receipts.push(event) });
  const response = await service.send(body([user('fix typo')]));
  assert.equal(response.status, 200);
  assert.equal(receipts[0].fallback, true);
  assert.equal(receipts[0].appliedEffort, 'high');
  assert.equal(classifier.calls.length, 1);
  classifier.respond();
  await loading;
  assert.equal(classifier.classify.status().state, 'ready');
  assert.deepEqual(statuses.map(event => event.state), ['loading', 'ready']);
  const real = classifier.classify('real prompt');
  await new Promise(resolve => setImmediate(resolve));
  classifier.respond();
  assert.equal((await real).recommended_reasoning_effort, 'low');
  assert.equal(classifier.calls.length, 2);
});

test('failed warmup is visible and retry can recover', async context => {
  const classifier = deferredClassifier();
  context.after(() => classifier.classify.close());
  const loading = classifier.classify.warmup();
  await classifier.waitForCall();
  classifier.respond({ task_class: 'error', recommended_reasoning_effort: '' });
  await assert.rejects(loading, /warmup failed/);
  assert.equal(classifier.classify.status().state, 'error');
  const retry = classifier.classify.warmup();
  await new Promise(resolve => setImmediate(resolve));
  classifier.respond();
  await retry;
  assert.equal(classifier.classify.status().state, 'ready');
});

test('classifier stages are surfaced without reflecting arbitrary diagnostic text', async context => {
  const classifier = deferredClassifier();
  context.after(() => classifier.classify.close());
  const loading = classifier.classify.warmup();
  await classifier.waitForCall();
  classifier.child.stderr.write('[Route2 classifier] {"stage":"loading_model","message":"private task text"}\n');
  assert.equal(classifier.classify.status().stage, 'loading_model');
  assert.doesNotMatch(classifier.classify.status().message, /private task text/);
  classifier.respond();
  await loading;
});

test('closing during warmup never reports ready afterward', async () => {
  const classifier = deferredClassifier();
  const loading = classifier.classify.warmup();
  await classifier.waitForCall();
  await classifier.classify.close();
  classifier.respond();
  await loading;
  assert.equal(classifier.classify.status().state, 'stopped');
  await assert.rejects(classifier.classify('new task'), /stopped/);
});

test('classifier recovers after a child exits and ignores late events from that child', async () => {
  const children = [];
  const classify = routerClassifier('fixture', '.', { spawnProcess: () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stdin = new Writable({ write(chunk, _encoding, done) {
      const message = JSON.parse(chunk.toString());
      if (message.id !== undefined) setImmediate(() => {
        if (message.method === 'tools/call' && children.length === 1) child.emit('exit', 1);
        else child.stdout.write(JSON.stringify({ id: message.id, result: message.method === 'initialize' ? {} : { structuredContent: { recommended_reasoning_effort: 'medium' } } }) + '\n');
      });
      done();
    } });
    child.kill = () => child.emit('exit', 1);
    children.push(child);
    return child;
  } });
  await assert.rejects(classify('first task'), /classifier unavailable/);
  const recovered = classify('next task');
  children[0].emit('exit', 1);
  assert.equal((await recovered).recommended_reasoning_effort, 'medium');
  assert.equal(children.length, 2);
  await classify.close();
});

async function fixture(t, classify, options = {}) {
  const requests = [];
  const bytes = 'event: response.created\ndata: {"type":"response.created"}\n\nevent: response.completed\ndata: {"type":"response.completed"}\n\n';
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({ path: req.url, headers: req.headers, body: Buffer.concat(chunks) });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(bytes.slice(0, 20));
    res.end(bytes.slice(20));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const proxy = await startProxy({ upstream: `http://127.0.0.1:${upstream.address().port}/v1`, classify, ...options });
  t.after(async () => { await proxy.close(); await new Promise(resolve => { upstream.close(resolve); upstream.closeAllConnections(); }); });
  return { requests, bytes, async send(body, extraHeaders = {}) {
    const response = await fetch(`http://127.0.0.1:${proxy.port}/responses`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer fixture-token', ...extraHeaders },
      body: typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body),
    });
    return { status: response.status, text: await response.text() };
  } };
}

const body = (input, model = SENTINEL) => ({ model, prompt_cache_key: 'fixture-session', stream: true,
  reasoning: { effort: 'high', summary: 'auto' }, input });
const user = text => ({ role: 'user', content: [{ type: 'input_text', text }] });
const tools = { type: 'function_call_output', call_id: 'call-1', output: 'test passed' };

test('routing rewrites only model/effort and preserves authentication and SSE bytes', async t => {
  const f = await fixture(t, async () => ({ task_class: 'small', recommended_reasoning_effort: 'low' }));
  const request = body([user('fix typo')]);
  const response = await f.send(request);
  assert.equal(response.status, 200);
  assert.equal(response.text, f.bytes);
  const forwarded = JSON.parse(f.requests[0].body);
  assert.deepEqual(forwarded, { ...request, model: MODEL, reasoning: { ...request.reasoning, effort: 'low' } });
  assert.equal(f.requests[0].headers.authorization, 'Bearer fixture-token');
  assert.equal(f.requests[0].path, '/v1/responses');
});

test('tool continuations and retries hold effort; new steering reclassifies', async t => {
  let calls = 0;
  const f = await fixture(t, async () => ({ task_class: 'semi_big', recommended_reasoning_effort: ++calls === 1 ? 'medium' : 'max' }));
  await f.send(body([user('implement parser')]));
  await f.send(body([user('implement parser')]));
  await f.send(body([user('implement parser'), tools]));
  assert.equal(calls, 1);
  assert.equal(JSON.parse(f.requests[2].body).reasoning.effort, 'medium');
  await f.send(body([user('implement parser'), tools, user('handle leaked secrets')]));
  assert.equal(calls, 2);
  assert.equal(JSON.parse(f.requests[3].body).reasoning.effort, 'max');
});

test('simultaneous retries share one classifier call', async t => {
  let calls = 0;
  const f = await fixture(t, async () => { calls++; await new Promise(resolve => setTimeout(resolve, 25)); return { task_class: 'small', recommended_reasoning_effort: 'low' }; });
  await Promise.all([f.send(body([user('typo')])), f.send(body([user('typo')]))]);
  assert.equal(calls, 1);
});

test('router failure retains prior effort; initial failure uses high', async t => {
  let calls = 0;
  const f = await fixture(t, async () => { if (++calls === 2) return { task_class: 'large', recommended_reasoning_effort: 'max' }; throw new Error('unavailable'); });
  await f.send(body([user('first')]));
  await f.send(body([user('second')]));
  await f.send(body([user('third')]));
  assert.deepEqual(f.requests.map(x => JSON.parse(x.body).reasoning.effort), ['high', 'max', 'max']);
});

test('manual selection bypasses routing and preserves compressed bytes', async t => {
  const f = await fixture(t, async () => { throw new Error('must not route'); });
  const raw = gzipSync(JSON.stringify(body([user('manual task')], MODEL)));
  await f.send(raw, { 'content-encoding': 'gzip' });
  assert.deepEqual(f.requests[0].body, raw);
  assert.equal(f.requests[0].headers['content-encoding'], 'gzip');
});

test('compressed routing request is rewritten with correct framing', async t => {
  const f = await fixture(t, async () => ({ task_class: 'small', recommended_reasoning_effort: 'low' }));
  await f.send(gzipSync(JSON.stringify(body([user('typo')]))), { 'content-encoding': 'gzip' });
  assert.equal(f.requests[0].headers['content-encoding'], undefined);
  assert.equal(Number(f.requests[0].headers['content-length']), f.requests[0].body.length);
  assert.equal(JSON.parse(f.requests[0].body).model, MODEL);
});

test('content encoding tokens are case insensitive', async t => {
  const f = await fixture(t, async () => ({ task_class: 'small', recommended_reasoning_effort: 'low' }));
  const response = await f.send(gzipSync(JSON.stringify(body([user('typo')]))), { 'content-encoding': 'GZIP' });
  assert.equal(response.status, 200);
  assert.equal(JSON.parse(f.requests[0].body).reasoning.effort, 'low');
});

test('catalog advertises Route2 only when Sol is available', () => {
  const catalog = { models: [{ slug: MODEL, visibility: 'list', supported_reasoning_levels: [{ effort: 'low' }] }] };
  const result = addRouterModel(catalog);
  assert.equal(result.models[0].slug, SENTINEL);
  assert.equal(catalog.models.length, 1);
  assert.equal(addRouterModel({ models: [] }).models.length, 0);
  assert.equal(addRouterModel(result).models.length, 2);
});

test('tool continuation is not a fresh user turn', () => {
  assert.equal(freshPrompt(body([user('task'), tools])), null);
  assert.equal(freshPrompt(body([user('task'), tools, user('new steering')])), 'new steering');
});

test('credential-bearing and remote plaintext upstreams are rejected', async () => {
  await assert.rejects(startProxy({ upstream: 'https://user:password@example.com', classify: async () => null }));
  await assert.rejects(startProxy({ upstream: 'http://example.com', classify: async () => null }));
});

test('invalid JSON is a visible request error and never forwarded', async t => {
  const f = await fixture(t, async () => null);
  const response = await f.send('{');
  assert.equal(response.status, 400);
  assert.equal(f.requests.length, 0);
});

test('health check is local and never forwards account headers upstream', async t => {
  const proxy = await startProxy({ upstream: 'http://127.0.0.1:1/v1', classify: async () => { throw new Error('must not classify'); } });
  t.after(() => proxy.close());
  const response = await fetch(`http://127.0.0.1:${proxy.port}/health`);
  assert.deepEqual(await response.json(), { service: 'route2', model: MODEL });
});

test('local status exposes classifier readiness but no account data', async context => {
  const classify = async () => { throw new Error('must not classify'); };
  classify.status = () => ({ state: 'loading', stage: 'loading_model', elapsed_ms: 1000, message: 'Loading the model.' });
  const proxy = await startProxy({ upstream: 'http://127.0.0.1:1/v1', classify });
  context.after(() => proxy.close());
  const health = await fetch(`http://127.0.0.1:${proxy.port}/health`);
  assert.equal((await health.json()).classifier.state, 'loading');
  const status = await fetch(`http://127.0.0.1:${proxy.port}/status`);
  assert.equal(status.status, 200);
  assert.equal(status.headers.get('cache-control'), 'no-store');
  assert.match(status.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const page = await status.text();
  assert.match(page, /Route2 classifier/);
  assert.match(page, /fetch\('\/health'/);
});

test('transport timing separates routing from upstream wait without changing SSE', async context => {
  const events = [];
  const service = await fixture(context, async () => ({ recommended_reasoning_effort: 'low' }), { onTransport: event => events.push(event) });
  const response = await service.send(body([user('private prompt')]));
  assert.equal(response.text, service.bytes);
  assert.deepEqual(events.map(event => event.eventType), ['routing_started', 'upstream_started', 'upstream_headers', 'upstream_first_byte']);
  assert.ok(events[1].routing_ms >= 0);
  assert.ok(events[3].upstream_ms >= 0);
  assert.ok(events.every(event => event.timestamp && event.logicalRequestId));
  assert.doesNotMatch(JSON.stringify(events), /private prompt|fixture-token/);
});

test('supervised health identifies the intended service instance', async t => {
  const proxy = await startProxy({ upstream: 'http://127.0.0.1:1/v1', instanceId: 'installer-instance', classify: async () => { throw new Error('must not classify'); } });
  t.after(() => proxy.close());
  const response = await fetch(`http://127.0.0.1:${proxy.port}/health`);
  assert.deepEqual(await response.json(), { service: 'route2', model: MODEL, instanceId: 'installer-instance' });
});


test('Codex metadata identifies hook sessions and separates simultaneous turns', () => {
  const metadata = { session_id: 'parent-session', thread_id: 'child-thread', turn_id: 'turn-a' };
  const one = requestIdentity({ model: SENTINEL, input: 'task', client_metadata: metadata }, {});
  assert.equal(one.sessionId, 'parent-session');
  assert.equal(one.turnId, 'turn-a');
  const two = requestIdentity({ input: 'task' }, { 'x-codex-turn-metadata': JSON.stringify(metadata) });
  assert.equal(two.sessionId, 'parent-session');
  assert.equal(two.turnId, 'turn-a');
  assert.equal(requestIdentity({ input: 'task' }, {}).stableIdentity, false);
});

test('atomic post-tool events affect the next request but never its retry', async t => {
  const eventDirectory = mkdtempSync(join(tmpdir(), 'route2 hooks '));
  t.after(() => rmSync(eventDirectory, { recursive: true, force: true }));
  const receipts = [];
  const summaries = [];
  const f = await fixture(t, async (text, summary) => {
    summaries.push(summary);
    return { task_class: summaries.length === 1 ? 'small' : 'large', recommended_reasoning_effort: summaries.length === 1 ? 'low' : 'high' };
  }, { eventDirectory, hookIntegration: 'configured', policy: { minimumHold: 0 }, onRequest: event => receipts.push(event) });
  const headers = { 'session-id': 'session-a', 'turn-id': 'turn-a' };
  const initial = body([user('investigate intermittent parser failure')]);
  await f.send(initial, headers);
  await publishEvent(eventDirectory, normalizeHookEvent({ hook_event_name: 'PostToolUse', session_id: 'session-a', turn_id: 'turn-a',
    tool_use_id: 'failed-test', tool_name: 'run_tests', tool_response: { ok: false, exit_code: 1, output: 'AssertionError: race invariant violated' } }));
  await f.send(initial, headers);
  assert.equal(summaries.length, 1);
  assert.equal(receipts.at(-1).reason, 'logical_request_retry');
  await f.send({ ...initial, previous_response_id: 'response-next' }, headers);
  assert.equal(summaries.length, 2);
  assert.equal(receipts.at(-1).appliedEffort, 'high');
  assert.match(receipts.at(-1).reason, /tool_failure/);
  assert.equal(summaries.at(-1).recentToolOutcomes.at(-1).substantive, true);
  assert.equal(JSON.parse(f.requests.at(-1).body).reasoning.effort, 'high');
});

test('unconfigured hooks are explicitly recorded as prompt-only', async t => {
  const receipts = [];
  const f = await fixture(t, async () => ({ recommended_reasoning_effort: 'medium' }), { onRequest: event => receipts.push(event) });
  await f.send(body([user('task')]));
  assert.equal(receipts[0].integration, 'prompt-only');
  assert.ok(receipts[0].unsupportedPaths.includes('post_tool_use_hooks_unconfigured'));
});
