// Opt-in checks with a real Codex executable; all inference stays on loopback.
// Use the desktop app's bundled executable to check its app-server version.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';
import { addRouterModel, startProxy, MODEL, SENTINEL } from '../scripts/router_proxy.mjs';
import { codexCommand } from '../scripts/codex_command.mjs';

const executable = process.env.ROUTE2_CODEX_BIN;
const catalogPath = process.env.ROUTE2_CODEX_CATALOG;
const enabled = Boolean(executable && catalogPath);
const marker = 'ROUTE2_CLIENT_OK';

function completeResponse(res) {
  const item = { id: 'msg_fixture', type: 'message', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text: marker, annotations: [] }] };
  const response = { id: 'resp_fixture', object: 'response', model: MODEL, status: 'completed',
    output: [item], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15,
      input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
  const events = [
    { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
    { type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] } },
    { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: marker },
    { type: 'response.output_text.done', item_id: item.id, output_index: 0, content_index: 0, text: marker },
    { type: 'response.content_part.done', item_id: item.id, output_index: 0, content_index: 0, part: item.content[0] },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response },
  ];
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
}

function runClient(args, env, cwd) {
  const command = codexCommand(executable);
  return spawn(command.executable, [...command.args, ...args], { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
}

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'route2 client '));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const requests = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks)));
    completeResponse(res);
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const decisions = [];
  const proxy = await startProxy({ upstream: `http://127.0.0.1:${upstream.address().port}/v1`,
    classify: async () => ({ task_class: 'semi_big', recommended_reasoning_effort: 'medium', confidence: 0.9 }),
    onDecision: decision => decisions.push(decision) });
  t.after(() => proxy.close());
  const catalog = addRouterModel(JSON.parse(readFileSync(catalogPath, 'utf8')));
  assert.ok(catalog.models.some(model => model.slug === SENTINEL));
  writeFileSync(join(directory, 'route2-models.json'), JSON.stringify(catalog));
  // Same user-level model/catalog/provider settings as the installer. Auth is
  // disabled ONLY for this fake upstream; real auth forwarding has other tests.
  writeFileSync(join(directory, 'config.toml'), `model = "${SENTINEL}"
model_provider = "route2"
model_catalog_json = ${JSON.stringify(join(directory, 'route2-models.json'))}
web_search = "disabled"
[model_providers.route2]
name = "Route2"
base_url = "http://127.0.0.1:${proxy.port}/v1"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
`);
  return { directory, requests, decisions,
    env: { ...process.env, CODEX_HOME: directory, OPENAI_API_KEY: 'fixture-only',
      CODEX_DISABLE_LOCAL_PLUGINS: '1' } };
}

test('real Codex CLI uses the installed default without a model flag or skill invocation',
  { skip: !enabled, timeout: 60000 }, async t => {
    const f = await fixture(t);
    const child = runClient(['exec', '--ephemeral', '--skip-git-repo-check', '--json',
      'Fix the parser bug. Reply with the requested test marker only.'], f.env, f.directory);
    t.after(() => child.kill());
    child.stdin.end();
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const code = await new Promise(resolve => child.once('exit', resolve));
    assert.equal(code, 0, stderr);
    const events = stdout.trim().split('\n').map(line => JSON.parse(line));
    assert.ok(events.some(event => event.type === 'item.completed' && event.item.text === marker));
    assert.equal(f.decisions.length, 1);
    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0].model, MODEL);
    assert.equal(f.requests[0].reasoning.effort, 'medium');
  });

test('real Codex app-server exposes Route2 and routes default prompts and follow-ups',
  { skip: !enabled, timeout: 60000 }, async t => {
    const f = await fixture(t);
    const child = runClient(['app-server', '--listen', 'stdio://'], f.env, f.directory);
    t.after(() => { child.stdin.end(); child.kill(); });
    child.stderr.resume();
    const pending = new Map();
    const notifications = [];
    let nextId = 0;
    const lines = createInterface({ input: child.stdout });
    lines.on('line', line => {
      const message = JSON.parse(line);
      if (message.id !== undefined && pending.has(message.id)) {
        const { resolve, reject } = pending.get(message.id);
        pending.delete(message.id);
        message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result);
      } else if (message.method) notifications.push(message);
    });
    const call = (method, params) => new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
    child.once('exit', code => {
      for (const item of pending.values()) item.reject(new Error(`app-server exited: ${code}`));
    });
    await call('initialize', { clientInfo: { name: 'route2_compatibility_test', version: '0.2.0' } });
    child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
    const models = await call('model/list', {});
    const router = models.data.find(model => model.model === SENTINEL);
    assert.ok(router, 'Route2 must appear in the app model selector data');
    assert.equal(router.isDefault, true);
    assert.ok(models.data.some(model => model.model === MODEL));
    const thread = await call('thread/start', { cwd: f.directory, ephemeral: true,
      approvalPolicy: 'never', sandbox: 'read-only' });
    assert.equal(thread.model, SENTINEL);
    assert.equal(thread.modelProvider, 'route2');
    for (const text of ['Fix the parser bug.', 'Also cover an empty input.']) {
      const { turn } = await call('turn/start', { threadId: thread.thread.id,
        input: [{ type: 'text', text }] });
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { clearInterval(poll); reject(new Error('turn completion timed out')); }, 15000);
        const poll = setInterval(() => {
          const event = notifications.find(event => event.method === 'turn/completed' && event.params.turn.id === turn.id);
          if (event) { clearInterval(poll); clearTimeout(timeout);
            event.params.turn.status === 'completed' ? resolve() : reject(new Error(JSON.stringify(event.params.turn))); }
        }, 10);
      });
    }
    assert.equal(f.requests.length, 2);
    assert.equal(f.decisions.length, 2);
    assert.ok(f.requests.every(request => request.model === MODEL && request.reasoning.effort === 'medium'));
    assert.ok(notifications.some(event => event.method === 'item/completed'
      && event.params.item.type === 'agentMessage' && event.params.item.text === marker));
  });
