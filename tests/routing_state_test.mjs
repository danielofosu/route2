import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createRoutingEngine,
  logicalRequestHash,
  latestHookTurn,
  normalizeHookEvent,
  publishEvent,
} from '../scripts/routing_state.mjs';

const result = effort => ({ task_class: effort === 'low' ? 'small' : effort === 'high' ? 'large' : 'semi_big',
  recommended_reasoning_effort: effort, window_generations: 2, confidence: 0.5 });

test('freezes exact retries, holds routine continuations, and reclassifies new user input', async () => {
  const calls = [];
  const engine = createRoutingEngine({
    classify: async (summary, context) => { calls.push({ summary, context }); return calls.length === 1 ? result('medium') : result('max'); },
  });
  const first = await engine.select({ sessionId: 'session-a', turnId: 'turn-a', logicalRequestId: 'request-1', prompt: 'implement a parser' });
  const retry = await engine.select({ sessionId: 'session-a', turnId: 'turn-a', logicalRequestId: 'request-1', prompt: 'implement a parser',
    toolOutcomes: [{ tool: 'apply_patch', status: 'failed', error: 'queued event must wait' }] });
  const routine = await engine.select({ sessionId: 'session-a', turnId: 'turn-a', logicalRequestId: 'request-2', prompt: 'implement a parser',
    toolOutcomes: [{ tool: 'grep', command: 'grep absent file', exit_code: 1 }] });
  const newUser = await engine.select({ sessionId: 'session-a', turnId: 'turn-a', logicalRequestId: 'request-3', prompt: 'also handle leaked secrets' });
  assert.equal(first.effort, 'medium');
  assert.equal(retry.effort, 'medium');
  assert.equal(retry.receipt.reused, true);
  assert.equal(routine.effort, 'medium');
  assert.equal(routine.receipt.reused, true);
  assert.equal(newUser.effort, 'max');
  assert.equal(newUser.receipt.reason, 'new_user');
  assert.equal(calls.length, 2);
  assert.equal(engine.snapshot()[0].turns[0].modelRequests, 3);
  assert.equal(calls[1].context.recentToolOutcomes.at(-1).kind, 'expected_nonzero');
  await engine.close();
});

test('isolates sessions and resolves Codex metadata/header identities', async () => {
  let calls = 0;
  const engine = createRoutingEngine({ classify: async () => { calls += 1; return result('medium'); } });
  await engine.select({ logicalRequestId: 'a', prompt: 'task a', integration: {
    headers: { 'session-id': 'A', 'x-codex-turn-id': 'TA' },
  } });
  await engine.select({ logicalRequestId: 'b', prompt: 'task b', integration: {
    headers: { 'session_id': 'B', 'x-codex-turn-id': 'TA' },
  } });
  await engine.select({ logicalRequestId: 'c', prompt: 'task c', integration: {
    headers: { 'x-codex-turn-metadata': JSON.stringify({ session_id: 'C', turn_id: 'TC' }) },
  } });
  assert.equal(calls, 3);
  assert.deepEqual(engine.snapshot().map(item => item.sessionId).sort(), ['A', 'B', 'C']);
  await engine.close();
});

test('escalates after repeated substantive failures while honoring the hold window', async () => {
  let calls = 0;
  const engine = createRoutingEngine({
    classify: async () => { calls += 1; return result(calls === 1 ? 'medium' : 'high'); },
  });
  const first = await engine.select({ sessionId: 'fail', turnId: 't', logicalRequestId: 'r1', prompt: 'fix the failing tests' });
  const second = await engine.select({ sessionId: 'fail', turnId: 't', logicalRequestId: 'r2', prompt: 'fix the failing tests',
    toolOutcomes: [{ tool: 'apply_patch', status: 'failed', error: 'patch rejected' }] });
  const third = await engine.select({ sessionId: 'fail', turnId: 't', logicalRequestId: 'r3', prompt: 'fix the failing tests',
    toolOutcomes: [{ tool: 'run_tests', status: 'failed', exit_code: 1, command: 'run_tests' }] });
  assert.equal(first.effort, 'medium');
  assert.equal(second.effort, 'medium');
  assert.match(second.receipt.reason, /minimum_hold/);
  assert.equal(third.effort, 'high');
  assert.equal(calls, 3);
  await engine.close();
});

test('repeated validated failures impose a one-step floor when the classifier underestimates', async () => {
  let calls = 0;
  const engine = createRoutingEngine({
    classify: async () => { calls += 1; return result('low'); },
  });
  const first = await engine.select({ sessionId: 'underestimated', turnId: 't', logicalRequestId: 'r1', prompt: 'fix the failing tests' });
  const oneFailure = await engine.select({ sessionId: 'underestimated', turnId: 't', logicalRequestId: 'r2', prompt: 'fix the failing tests',
    toolOutcomes: [{ tool: 'run_tests', command: 'run_tests', status: 'failed', exit_code: 1 }] });
  const twoFailures = await engine.select({ sessionId: 'underestimated', turnId: 't', logicalRequestId: 'r3', prompt: 'fix the failing tests',
    toolOutcomes: [{ tool: 'run_tests', command: 'run_tests', status: 'failed', exit_code: 1 }] });
  assert.equal(first.effort, 'low');
  assert.equal(oneFailure.effort, 'low');
  assert.equal(twoFailures.effort, 'medium');
  assert.equal(twoFailures.receipt.recommendedEffort, 'low');
  assert.equal(twoFailures.receipt.classifierRecommendedEffort, 'low');
  assert.equal(twoFailures.receipt.policyFloor, 'medium');
  assert.ok(twoFailures.receipt.evidence.includes('repeated_failure_escalation'));
  assert.equal(calls, 3);
  await engine.close();
});

test('a held repeated-failure floor is reassessed after the hold without new tool outcomes', async () => {
  let calls = 0;
  const engine = createRoutingEngine({
    policy: { windowGenerations: 5 },
    classify: async () => { calls += 1; return result('low'); },
  });
  const failure = { tool: 'run_tests', command: 'run_tests', status: 'failed', exit_code: 1 };
  const first = await engine.select({ sessionId: 'pending-floor', turnId: 't', logicalRequestId: 'r1', prompt: 'fix the failing tests' });
  const held = await engine.select({ sessionId: 'pending-floor', turnId: 't', logicalRequestId: 'r2', prompt: 'fix the failing tests',
    toolOutcomes: [failure, { ...failure }] });
  const escalated = await engine.select({ sessionId: 'pending-floor', turnId: 't', logicalRequestId: 'r3', prompt: 'fix the failing tests' });
  const unchanged = await engine.select({ sessionId: 'pending-floor', turnId: 't', logicalRequestId: 'r4', prompt: 'fix the failing tests' });
  assert.equal(first.effort, 'low');
  assert.equal(held.effort, 'low');
  assert.ok(held.receipt.evidence.includes('repeated_failure_escalation'));
  assert.equal(escalated.effort, 'medium');
  assert.equal(escalated.receipt.reason, 'repeated_failure_pending');
  assert.equal(escalated.receipt.recommendedEffort, 'low');
  assert.equal(unchanged.effort, 'medium');
  assert.equal(unchanged.receipt.reused, true);
  assert.equal(calls, 3);
  await engine.close();
});

test('explicit deep next-step requests apply a high floor after the hold window', async () => {
  let calls = 0;
  const engine = createRoutingEngine({
    classify: async () => { calls += 1; return result('low'); },
  });
  const first = await engine.select({ sessionId: 'deep-floor', turnId: 't', logicalRequestId: 'r1', prompt: 'implement the change' });
  const held = await engine.select({ sessionId: 'deep-floor', turnId: 't', logicalRequestId: 'r2', prompt: 'implement the change',
    integration: { nextStepRequiresDeepReasoning: true } });
  const applied = await engine.select({ sessionId: 'deep-floor', turnId: 't', logicalRequestId: 'r3', prompt: 'implement the change' });
  assert.equal(first.effort, 'low');
  assert.equal(held.effort, 'low');
  assert.match(held.receipt.reason, /minimum_hold/);
  assert.equal(applied.effort, 'high');
  assert.equal(applied.receipt.recommendedEffort, 'low');
  assert.equal(applied.receipt.policyFloor, 'high');
  assert.ok(applied.receipt.evidence.includes('next_step_requires_deep_reasoning'));
  assert.equal(calls, 3);
  await engine.close();
});

test('routine progress does not force a repeated-failure escalation', async () => {
  let calls = 0;
  const engine = createRoutingEngine({
    classify: async () => { calls += 1; return result('low'); },
  });
  const first = await engine.select({ sessionId: 'routine-floor', turnId: 't', logicalRequestId: 'r1', prompt: 'inspect and fix the change' });
  const failure = await engine.select({ sessionId: 'routine-floor', turnId: 't', logicalRequestId: 'r2', prompt: 'inspect and fix the change',
    toolOutcomes: [{ tool: 'run_tests', command: 'run_tests', status: 'failed', exit_code: 1 }] });
  const progress = await engine.select({ sessionId: 'routine-floor', turnId: 't', logicalRequestId: 'r3', prompt: 'inspect and fix the change',
    toolOutcomes: [{ tool: 'run_tests', command: 'run_tests', status: 'success', exit_code: 0 }] });
  assert.equal(first.effort, 'low');
  assert.equal(failure.effort, 'low');
  assert.equal(progress.effort, 'low');
  assert.equal(progress.receipt.reused, true);
  assert.equal(calls, 2);
  await engine.close();
});

test('verified routine progress permits de-escalation after a generation window', async () => {
  let calls = 0;
  const engine = createRoutingEngine({ classify: async () => { calls += 1; return result(calls === 1 ? 'high' : 'low'); } });
  const first = await engine.select({ sessionId: 'progress', turnId: 't', logicalRequestId: 'r1', prompt: 'implement and test the change' });
  const progress = await engine.select({ sessionId: 'progress', turnId: 't', logicalRequestId: 'r2', prompt: 'implement and test the change',
    toolOutcomes: [{ tool: 'run_tests', command: 'run_tests', status: 'success', exit_code: 0 }] });
  const reassessed = await engine.select({ sessionId: 'progress', turnId: 't', logicalRequestId: 'r3', prompt: 'implement and test the change' });
  assert.equal(first.effort, 'high');
  assert.equal(progress.effort, 'high');
  assert.equal(progress.receipt.reused, true);
  assert.equal(reassessed.effort, 'low');
  assert.equal(calls, 2);
  await engine.close();
});

test('disabled de-escalation keeps high effort after verified progress and a new-user trigger', async () => {
  let calls = 0;
  const engine = createRoutingEngine({
    policy: { allow_deescalation: false },
    classify: async () => {
      calls += 1;
      return { recommended_reasoning_effort: calls === 1 ? 'high' : 'low', window_generations: 1 };
    },
  });
  const first = await engine.select({ sessionId: 'no-deescalation', turnId: 't', logicalRequestId: 'r1', prompt: 'implement the change' });
  const progress = await engine.select({ sessionId: 'no-deescalation', turnId: 't', logicalRequestId: 'r2', prompt: 'implement the change',
    toolOutcomes: [{ tool: 'run_tests', command: 'run_tests', status: 'success', exit_code: 0 }] });
  const newUser = await engine.select({ sessionId: 'no-deescalation', turnId: 't', logicalRequestId: 'r3', prompt: 'also improve the error message' });
  assert.equal(first.effort, 'high');
  assert.equal(progress.effort, 'high');
  assert.equal(newUser.effort, 'high');
  assert.equal(newUser.receipt.recommendedEffort, 'low');
  assert.match(newUser.receipt.reason, /minimum_hold/);
  assert.equal(calls, 3);
  await engine.close();
});

test('disabled de-escalation applies to inherited effort across turns', async () => {
  let calls = 0;
  const engine = createRoutingEngine({
    policy: { allowDeescalation: false, minimumHold: 0 },
    classify: async () => { calls += 1; return result(calls === 1 ? 'high' : 'low'); },
  });
  const first = await engine.select({ sessionId: 'inherited-no-deescalation', turnId: 'one', logicalRequestId: 'r1', prompt: 'implement the change' });
  const inherited = await engine.select({ sessionId: 'inherited-no-deescalation', turnId: 'two', logicalRequestId: 'r2', prompt: 'start a new task' });
  assert.equal(first.effort, 'high');
  assert.equal(inherited.effort, 'high');
  assert.equal(inherited.receipt.recommendedEffort, 'low');
  assert.equal(inherited.receipt.previousEffort, 'high');
  assert.equal(calls, 2);
  await engine.close();
});

test('invalid de-escalation policy values fall back to enabled', async () => {
  const invalid = createRoutingEngine({ policy: { allowDeescalation: 'sometimes' }, classify: async () => result('medium') });
  const snakeFalse = createRoutingEngine({ policy: { allow_deescalation: false }, classify: async () => result('medium') });
  assert.equal(invalid.policy.allowDeescalation, true);
  assert.equal(snakeFalse.policy.allowDeescalation, false);
  await invalid.close();
  await snakeFalse.close();
});

test('nonzero shell exits remain neutral without validated failure evidence', async () => {
  const summaries = [];
  const engine = createRoutingEngine({ classify: async (summary, context) => { summaries.push({ summary, context }); return result('medium'); } });
  await engine.select({ sessionId: 'neutral', turnId: 't', logicalRequestId: 'r1', prompt: 'inspect the repository' });
  const next = await engine.select({ sessionId: 'neutral', turnId: 't', logicalRequestId: 'r2', prompt: 'inspect the repository',
    toolOutcomes: [{ tool: 'shell', command: 'printf hello', exit_code: 2 }] });
  assert.equal(next.effort, 'medium');
  assert.equal(next.receipt.reused, true);
  assert.equal(engine.snapshot()[0].turns[0].recentOutcomes.at(-1).kind, 'neutral');
  assert.equal(summaries.length, 1);
  await engine.close();
});

test('wire outcome summaries do not claim hooks were observed', async () => {
  const engine = createRoutingEngine({ classify: async () => result('medium') });
  const first = await engine.select({ sessionId: 'wire', turnId: 't', logicalRequestId: 'r1', prompt: 'task',
    integration: { hooks: 'configured', stableIdentity: true } });
  const second = await engine.select({ sessionId: 'wire', turnId: 't', logicalRequestId: 'r2', prompt: 'task',
    integration: { hooks: 'configured', stableIdentity: true }, toolOutcomes: [normalizeHookEvent({
      hook_event_name: 'PostToolUse', session_id: 'wire', turn_id: 't', tool_name: 'grep', tool_response: { exit_code: 1 },
    })] });
  assert.equal(first.receipt.hooksObserved, false);
  assert.equal(first.receipt.integration, 'hooks-pending_or_unavailable');
  assert.equal(second.receipt.hooksObserved, false);
  await engine.close();
});

test('persisted hook provenance is retained when wire and hook copies share an event id', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'route2-provenance-'));
  try {
    const raw = { hook_event_name: 'PostToolUse', session_id: 'provenance', turn_id: 't', tool_use_id: 'same-event',
      tool_name: 'grep', tool_input: { command: 'grep absent file' }, tool_response: { exit_code: 1 } };
    const stored = normalizeHookEvent(raw);
    await publishEvent(directory, stored);
    const engine = createRoutingEngine({ eventDirectory: directory, classify: async () => result('medium') });
    const selected = await engine.select({ sessionId: 'provenance', turnId: 't', logicalRequestId: 'r', prompt: 'inspect',
      toolOutcomes: [{ ...stored, source: 'wire' }], integration: { hooks: 'configured', stableIdentity: true } });
    assert.equal(selected.receipt.hooksObserved, true);
    assert.equal(selected.receipt.integration, 'hooks-active');
    await engine.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('hook events are normalized, atomic, turn-matched, and omit raw telemetry', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'route2-routing-'));
  try {
    const pre = normalizeHookEvent({ hook_event_name: 'PreToolUse', session_id: 'hooks', turn_id: 'T', tool_name: 'shell' });
    const post = normalizeHookEvent({ hook_event_name: 'PostToolUse', session_id: 'hooks', turn_id: 'T',
      tool_use_id: 'post-t', tool_name: 'run_tests', tool_input: { command: 'run_tests' },
      tool_response: { status: 'failed', exit_code: 1, output: 'private raw output' } });
    assert.equal(pre.supported, false);
    assert.equal(post.supported, true);
    assert.equal(post.outcome.substantive, true);
    const runtimeFailure = normalizeHookEvent({ hook_event_name: 'PostToolUse', session_id: 'hooks', turn_id: 'T',
      tool_name: 'Bash', tool_input: { command: "node -e \"throw new Error('fixture invariant failure')\"" },
      tool_response: 'Error: fixture invariant failure\n    at [eval]:1:1\nNode.js' });
    assert.equal(runtimeFailure.outcome.substantive, true);
    assert.match(runtimeFailure.outcome.detail, /fixture invariant failure/);
    const searchOutput = normalizeHookEvent({ hook_event_name: 'PostToolUse', session_id: 'hooks', turn_id: 'T',
      tool_name: 'Bash', tool_input: { command: 'cat file' }, tool_response: 'Error: this is file content' });
    assert.equal(searchOutput.outcome.substantive, false);
    const prompt = await publishEvent(directory, { hook_event_name: 'UserPromptSubmit', session_id: 'hooks', turn_id: 'PROMPT' });
    await Promise.all([
      publishEvent(directory, pre),
      publishEvent(directory, post),
      publishEvent(directory, { hook_event_name: 'PostToolUse', session_id: 'hooks', turn_id: 'OTHER', tool_name: 'run_tests',
        tool_response: { status: 'failed', exit_code: 1, output: 'wrong turn' } }),
    ]);
    const files = (await readdir(directory)).filter(name => name.endsWith('.json'));
    assert.equal(new Set(files).size, files.length);
    assert.equal(await latestHookTurn(directory, 'hooks'), 'PROMPT');
    const stored = await readFile(join(directory, files.find(name => name.includes(prompt.eventId) ?? false) ?? files[0]), 'utf8');
    assert.equal(stored.includes('private raw output'), false);

    const decisions = [];
    const engine = createRoutingEngine({ eventDirectory: directory, classify: async () => result('medium'),
      onDecision: event => decisions.push(event) });
    const selected = await engine.select({ sessionId: 'hooks', turnId: 'T', logicalRequestId: 'logical', prompt: 'run verification',
      integration: { hooks: 'configured', stableIdentity: true } });
    assert.equal(selected.receipt.hooksObserved, true);
    assert.equal(selected.receipt.integration, 'hooks-active');
    assert.match(selected.receipt.unsupportedPaths.join(','), /pre_tool_use_permission_path/);
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0].appliedEffort, 'medium');
    await engine.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('concurrent same logical request shares one pending classification', async () => {
  let calls = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const engine = createRoutingEngine({ classify: async () => { calls += 1; await gate; return result('low'); } });
  const one = engine.select({ sessionId: 'concurrent', turnId: 't', logicalRequestId: 'same', prompt: 'small edit' });
  const two = engine.select({ sessionId: 'concurrent', turnId: 't', logicalRequestId: 'same', prompt: 'small edit',
    toolOutcomes: [{ tool: 'apply_patch', status: 'failed', error: 'queued failure' }] });
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(calls, 1);
  release();
  const [first, second] = await Promise.all([one, two]);
  assert.deepEqual(first, second);
  assert.equal(first.effort, 'low');
  await engine.close();
});

test('concurrent distinct requests batch tool outcomes into one reassessment', async () => {
  let calls = 0;
  const engine = createRoutingEngine({ classify: async () => { calls += 1; return result(calls === 1 ? 'medium' : 'high'); } });
  await engine.select({ sessionId: 'batch', turnId: 't', logicalRequestId: 'initial', prompt: 'investigate the failure' });
  const [one, two] = await Promise.all([
    engine.select({ sessionId: 'batch', turnId: 't', logicalRequestId: 'next-a', prompt: 'investigate the failure',
      toolOutcomes: [{ tool: 'run_tests', status: 'failed', exit_code: 1, command: 'run_tests' }] }),
    engine.select({ sessionId: 'batch', turnId: 't', logicalRequestId: 'next-b', prompt: 'investigate the failure',
      toolOutcomes: [{ tool: 'apply_patch', status: 'failed', error: 'conflict' }] }),
  ]);
  assert.equal(calls, 2);
  assert.equal(one.effort, 'medium');
  assert.equal(two.effort, 'medium');
  assert.equal(two.receipt.reason, 'batched_outcomes');
  await engine.close();
});

test('classifier fallback uses the prior valid effort across turns, then high initially', async () => {
  let calls = 0;
  const engine = createRoutingEngine({ classify: async () => {
    calls += 1;
    if (calls === 1) return result('medium');
    throw new Error('classifier unavailable');
  } });
  const first = await engine.select({ sessionId: 'fallback', turnId: 'one', logicalRequestId: 'r1', prompt: 'task' });
  const second = await engine.select({ sessionId: 'fallback', turnId: 'two', logicalRequestId: 'r2', prompt: 'new task' });
  assert.equal(first.effort, 'medium');
  assert.equal(second.effort, 'medium');
  assert.equal(second.receipt.fallback, true);
  const fresh = createRoutingEngine({ classify: async () => { throw new Error('unavailable'); } });
  const initial = await fresh.select({ sessionId: 'fresh', turnId: 't', logicalRequestId: 'r', prompt: 'task' });
  assert.equal(initial.effort, 'high');
  assert.equal(initial.receipt.fallback, true);
  await engine.close();
  await fresh.close();
});

test('logical request hashing strips only provider rewrites', () => {
  const a = { model: 'route2-router', reasoning: { effort: 'low', summary: 'auto' }, input: [{ role: 'user', content: [{ model: 'keep-a' }] }] };
  const b = { model: 'gpt-6.1-sol', reasoning: { effort: 'high', summary: 'auto' }, input: [{ role: 'user', content: [{ model: 'keep-a' }] }] };
  const c = { ...b, input: [{ role: 'user', content: [{ model: 'keep-c' }] }] };
  assert.equal(logicalRequestHash(a), logicalRequestHash(b));
  assert.notEqual(logicalRequestHash(a), logicalRequestHash(c));
});

test('TTL and bounded session state expire without cross-session leakage', async () => {
  let clock = 1000;
  const engine = createRoutingEngine({ now: () => clock, policy: { ttlMs: 10, maxSessions: 1 }, classify: async () => result('medium') });
  await engine.select({ sessionId: 'old', turnId: 't', logicalRequestId: 'r', prompt: 'old' });
  clock += 20;
  await engine.select({ sessionId: 'new', turnId: 't', logicalRequestId: 'r', prompt: 'new' });
  assert.deepEqual(engine.snapshot().map(item => item.sessionId), ['new']);
  await engine.close();
});

test('phase follows recent work rather than a later testing instruction', async () => {
  const summaries = [];
  const engine = createRoutingEngine({ policy: { windowGenerations: 1, minimumHold: 0 },
    classify: async (_, summary) => { summaries.push(summary); return { recommended_reasoning_effort: 'medium' }; } });
  await engine.select({ sessionId: 'phase', turnId: 'one', logicalRequestId: 'initial', prompt: 'Implement a parser and run tests before finishing' });
  assert.equal(summaries[0].phase, 'implementation');
  await engine.select({ sessionId: 'phase', turnId: 'one', logicalRequestId: 'tests', toolOutcomes: [{ tool: 'run_tests', ok: false, error: 'parser assertion failed' }] });
  assert.equal(summaries[1].phase, 'remediation');
});
