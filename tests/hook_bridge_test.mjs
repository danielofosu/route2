import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { hookCommand, hookOverrides } from '../scripts/hook_config.mjs';

function invoke(directory, event) {
  return new Promise(resolvePromise => {
    const child = spawn(process.execPath, [resolve('scripts/route2_hook.mjs'), '--event-dir', directory], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('close', code => resolvePromise({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(event));
  });
}

test('concurrent bridge processes publish independent atomic outcome files without feedback', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'route2 event bridge '));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const results = await Promise.all(Array.from({ length: 4 }, (_, index) => invoke(directory, {
    hook_event_name: 'PostToolUse', session_id: 'session', turn_id: 'turn', tool_use_id: `tool-${index}`,
    tool_name: 'Bash', tool_input: { command: 'node --test' }, tool_response: { exit_code: 1, output: 'AssertionError: fixture failed' },
  })));
  assert.ok(results.every(x => x.code === 0 && x.stdout === ''));
  const files = readdirSync(directory);
  assert.equal(files.length, 4);
  assert.ok(files.every(name => name.endsWith('.json')));
  const events = files.map(name => JSON.parse(readFileSync(join(directory, name), 'utf8')));
  assert.equal(new Set(events.map(x => x.eventId)).size, 4);
  assert.ok(events.every(x => x.sessionId === 'session' && x.turnId === 'turn' && x.supported));
});

test('hook definition uses outcome hooks and retains the host trust gate', () => {
  const command = hookCommand('/node path', '/repo path/hook.mjs', '/events path', 'darwin');
  assert.match(command, /'\/node path'/);
  const args = hookOverrides(command);
  assert.ok(args.some(x => x.startsWith('hooks.PostToolUse=')));
  assert.ok(args.some(x => x.startsWith('hooks.UserPromptSubmit=')));
  assert.ok(args.every(x => !/PreToolUse|bypass/.test(x)));
  assert.throws(() => hookCommand('node', 'bad%path', 'events', 'win32'));
  assert.throws(() => hookCommand('node', 'hook.mjs', 'events', 'linux'), /macOS and Codex only/);
});
