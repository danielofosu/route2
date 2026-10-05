import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { MODEL, SENTINEL } from '../scripts/router_proxy.mjs';

test('persistent service warms at startup and serves prompts while classification is loading', { timeout: 15000 }, async context => {
  const executable = resolve('target/debug', 'route2');
  if (!existsSync(executable)) { context.skip('build the native route2 executable first'); return; }
  const directory = mkdtempSync(join(tmpdir(), 'route2 startup '));
  let releaseWarmup;
  let inferenceCalls = 0;
  const backend = http.createServer(async (req, res) => {
    for await (const chunk of req) { }
    inferenceCalls++;
    const respond = () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ answers: { tier: { choice: 'small', confidence: 0.9 } } }));
    };
    if (inferenceCalls === 1) releaseWarmup = respond;
    else respond();
  });
  await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
  const forwarded = [];
  const upstream = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    forwarded.push(JSON.parse(body));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: {"type":"response.completed"}\n\n');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const reservation = http.createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const policy = join(directory, 'policy.json');
  writeFileSync(policy, JSON.stringify({ policy_version: 'startup-fixture', backend: 'decision', decision: {
    endpoint: `http://127.0.0.1:${backend.address().port}/v1/systemone`, model: 'fixture', timeout_ms: 10000,
  } }));
  const child = spawn(process.execPath, [resolve('scripts/serve_proxy.mjs'), '--router', executable,
    '--port', String(port), '--upstream', `http://127.0.0.1:${upstream.address().port}/v1`], {
    env: { ...process.env, ROUTE2_CONFIG: policy, ROUTE2_INSTANCE_ID: 'startup-fixture', CODEX_HOME: directory },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let diagnostic = '';
  child.stdout.on('data', () => {});
  child.stderr.on('data', chunk => { diagnostic += chunk; });
  context.after(async () => {
    releaseWarmup?.();
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      await exited;
    }
    backend.closeAllConnections();
    upstream.closeAllConnections();
    await Promise.all([new Promise(resolve => backend.close(resolve)), new Promise(resolve => upstream.close(resolve))]);
    rmSync(directory, { recursive: true, force: true });
  });
  const healthUrl = `http://127.0.0.1:${port}/health`;
  const poll = async predicate => {
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      try {
        const health = await (await fetch(healthUrl, { signal: AbortSignal.timeout(500) })).json();
        if (predicate(health)) return health;
      } catch { }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.fail(`service did not reach expected status: ${diagnostic}`);
  };
  const loading = await poll(health => health.classifier?.state === 'loading' && releaseWarmup);
  assert.equal(loading.instanceId, 'startup-fixture');
  assert.equal(inferenceCalls, 1);
  const send = async key => {
    const response = await fetch(`http://127.0.0.1:${port}/responses`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: SENTINEL, input: 'correct a typo', prompt_cache_key: key }),
      signal: AbortSignal.timeout(2000),
    });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'data: {"type":"response.completed"}\n\n');
  };
  await send('loading-session');
  assert.equal(forwarded[0].model, MODEL);
  assert.equal(forwarded[0].reasoning.effort, 'high');
  releaseWarmup();
  releaseWarmup = undefined;
  await poll(health => health.classifier?.state === 'ready');
  await send('ready-session');
  assert.equal(forwarded[1].reasoning.effort, 'low');
  assert.match(diagnostic, /Route2 startup/);
  assert.match(diagnostic, /upstream_first_byte/);
});
