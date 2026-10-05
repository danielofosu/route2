import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { codexCommand } from '../scripts/codex_command.mjs';
import { routerClassifier, startProxy, SENTINEL, MODEL } from '../scripts/router_proxy.mjs';

// Exercise Node -> native Rust stdio MCP -> HTTP backend -> upstream on macOS.
// Only the model and paid upstream are doubled; executable paths include spaces.
test('native MCP classifier applies effort through the provider proxy', { timeout: 15000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'route2 provider '));
  const backend = http.createServer(async (req, res) => {
    let data = '';
    for await (const chunk of req) data += chunk;
    const request = JSON.parse(data);
    assert.match(request.state, /Implement a parser/);
    assert.match(request.state, /Current effort/);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ answers: { tier: { choice: 'semi_big', confidence: 0.91 } } }));
  });
  await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
  const config = join(directory, 'policy.json');
  writeFileSync(config, JSON.stringify({ policy_version: 'provider-smoke', backend: 'decision',
    decision: { endpoint: `http://127.0.0.1:${backend.address().port}/v1/systemone`, model: 'fixture' } }));
  const previous = process.env.ROUTE2_CONFIG;
  process.env.ROUTE2_CONFIG = config;
  const classifier = routerClassifier(resolve('target/debug', 'route2'), directory);
  t.after(async () => {
    await classifier.close();
    if (previous === undefined) delete process.env.ROUTE2_CONFIG;
    else process.env.ROUTE2_CONFIG = previous;
    backend.closeAllConnections();
    backend.close();
    rmSync(directory, { recursive: true, force: true });
  });
  let forwarded;
  const upstream = http.createServer(async (req, res) => {
    let data = '';
    for await (const chunk of req) data += chunk;
    forwarded = JSON.parse(data);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: {"type":"response.completed"}\n\n');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const decisions = [];
  const proxy = await startProxy({ upstream: `http://127.0.0.1:${upstream.address().port}/v1`,
    classify: classifier, onDecision: decision => decisions.push(decision) });
  t.after(() => proxy.close());
  const response = await fetch(`http://127.0.0.1:${proxy.port}/v1/responses`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: SENTINEL, input: 'Implement a parser', reasoning: { effort: 'high' } }),
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'data: {"type":"response.completed"}\n\n');
  assert.equal(forwarded.model, MODEL);
  assert.equal(forwarded.reasoning.effort, 'medium');
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].fallback, false);
});


test('Codex command supports macOS only and preserves the explicit executable', () => {
  assert.deepEqual(codexCommand('/Applications/Codex.app/Contents/MacOS/codex', 'darwin'), {
    executable: '/Applications/Codex.app/Contents/MacOS/codex', args: [],
  });
  for (const platform of ['win32', 'linux']) {
    assert.throws(() => codexCommand('codex', platform), /macOS and Codex only/);
  }
});
