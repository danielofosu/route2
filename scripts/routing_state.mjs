import { promises as fs } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';

/**
 * Per-conversation effort state for the provider proxy.
 *
 * This module deliberately does not make a routing decision about permission
 * to run a tool.  Hooks can publish compact outcome signals here, while the
 * host remains responsible for PreToolUse permission enforcement.
 */

export const ROUTING_STATE_SCHEMA = 'route2.routing-state.v1';
export const HOOK_EVENT_SCHEMA = 'route2.hook-event.v1';
export const DECISION_EVENT_SCHEMA = 'route2.routing-decision.v1';
export const EFFORTS = Object.freeze(['low', 'medium', 'high', 'max']);

const EFFORT_SET = new Set(EFFORTS);
const EFFORT_RANK = new Map(EFFORTS.map((effort, index) => [effort, index]));
const DEFAULT_POLICY = Object.freeze({
  // A window counts model requests, never tool calls or transport retries.
  windowGenerations: 2,
  minimumHold: 2,
  repeatedFailures: 2,
  // A valid assessment cannot ignore a persistent, validated failure streak.
  // The floor advances one step at a time (low -> medium -> high); it never
  // jumps to the legacy `max` effort.
  repeatedFailureEscalation: true,
  allowDeescalation: true,
  fallbackEffort: 'high',
  ttlMs: 30 * 60 * 1000,
  maxSessions: 256,
  maxTurnsPerSession: 16,
  maxRequestsPerTurn: 64,
  maxRecentOutcomes: 8,
  maxEventsPerTurn: 64,
  maxEventFilesPerRead: 128,
  maxPromptChars: 1200,
  maxEvidenceItems: 12,
});

const ROUTINE_TOOL_NAMES = new Set([
  'cat', 'head', 'tail', 'sed', 'awk', 'cut', 'sort', 'uniq', 'tr', 'wc',
  'ls', 'find', 'fd', 'pwd', 'read', 'read_file', 'readfile', 'list',
  'git_status', 'git-status', 'status', 'search', 'grep', 'rg', 'ripgrep',
  'run_tests', 'run-tests', 'test', 'pytest',
]);

const text = value => typeof value === 'string' ? value : value == null ? '' : String(value);
const nonEmpty = value => text(value).trim() || null;

function integer(value, fallback, minimum = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(minimum, Math.floor(number)) : fallback;
}

function timestamp(now) {
  const value = typeof now === 'function' ? now() : Date.now();
  return Number.isFinite(Number(value)) ? Number(value) : Date.now();
}

function truncate(value, limit = 256) {
  const result = text(value).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return result.length > limit ? `${result.slice(0, Math.max(0, limit - 1))}…` : result;
}

function bool(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value !== 'string') return null;
  if (/^(?:1|true|yes|y|success|succeeded|ok|passed)$/i.test(value.trim())) return true;
  if (/^(?:0|false|no|n|failure|failed|error)$/i.test(value.trim())) return false;
  return null;
}

function firstValue(object, names) {
  if (!object || typeof object !== 'object') return undefined;
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(object, name) && object[name] != null) return object[name];
  }
  return undefined;
}

function headerValue(integration, names) {
  const containers = [
    integration?.headers,
    integration?.requestHeaders,
    integration?.request?.headers,
    integration?.body?.headers,
    integration,
  ];
  const wanted = names.map(name => name.toLowerCase());
  for (const container of containers) {
    if (!container || typeof container !== 'object') continue;
    for (const [key, value] of Object.entries(container)) {
      if (wanted.includes(key.toLowerCase()) && value != null && text(value).trim()) return text(value).trim();
    }
  }
  return null;
}

function metadataObject(integration) {
  const direct = integration?.client_metadata ?? integration?.clientMetadata ?? integration?.metadata
    ?? integration?.body?.client_metadata ?? integration?.body?.clientMetadata
    ?? integration?.request?.client_metadata ?? integration?.request?.clientMetadata;
  if (direct && typeof direct === 'object') return direct;
  const encoded = headerValue(integration, ['x-codex-turn-metadata']);
  if (!encoded) return null;
  try {
    const parsed = JSON.parse(encoded);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch { return null; }
}

/** Resolve identity from the headers used by the Codex CLI and hook payloads. */
export function resolveSessionId(request = {}) {
  const integration = request.integration ?? {};
  const metadata = metadataObject(integration);
  return nonEmpty(request.sessionId)
    ?? nonEmpty(metadata?.session_id)
    ?? nonEmpty(metadata?.sessionId)
    ?? nonEmpty(metadata?.thread_id)
    ?? nonEmpty(metadata?.threadId)
    ?? headerValue(integration, ['session_id', 'session-id', 'x-codex-session-id', 'thread-id', 'thread_id', 'threadId'])
    ?? nonEmpty(integration.sessionId)
    ?? nonEmpty(integration.threadId)
    ?? 'anonymous';
}

export function resolveTurnId(request = {}) {
  const integration = request.integration ?? {};
  const metadata = metadataObject(integration);
  return nonEmpty(request.turnId)
    ?? nonEmpty(metadata?.turn_id)
    ?? nonEmpty(metadata?.turnId)
    ?? headerValue(integration, ['turn_id', 'turn-id', 'turnId', 'x-codex-turn-id'])
    ?? nonEmpty(integration.turnId)
    ?? 'default';
}

function strippedRoutingFields(value, key = '', topLevel = true) {
  if (Array.isArray(value)) return value.map(item => strippedRoutingFields(item, '', false));
  if (!value || typeof value !== 'object') return value;
  const output = {};
  for (const name of Object.keys(value).sort()) {
    const lower = name.toLowerCase().replace(/[-_]/g, '');
    // The proxy rewrites these fields.  They must never distinguish a retry
    // from its original logical model request.
    if ((topLevel && (lower === 'model' || lower === 'modeleffort' || lower === 'reasoningeffort'
      || lower === 'routedeffort' || lower === 'appliedeffort'))
      || (!topLevel && lower === 'modeleffort')) continue;
    if (topLevel && lower === 'reasoning' && value[name] && typeof value[name] === 'object') {
      const reasoning = {};
      for (const [reasoningName, reasoningValue] of Object.entries(value[name])) {
        const reasoningLower = reasoningName.toLowerCase().replace(/[-_]/g, '');
        if (reasoningLower === 'effort' || reasoningLower === 'reasoningeffort') continue;
        reasoning[reasoningName] = strippedRoutingFields(reasoningValue, reasoningName, false);
      }
      output[name] = reasoning;
      continue;
    }
    output[name] = strippedRoutingFields(value[name], name, false);
  }
  return output;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) return null;
    return value;
  }
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
}

/** Hash a logical request after removing provider-rewritten model/effort fields. */
export function logicalRequestHash(value) {
  const normalized = stableValue(strippedRoutingFields(value));
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

export function resolveLogicalRequestId(request = {}) {
  const explicit = nonEmpty(request.logicalRequestId)
    ?? nonEmpty(request.integration?.logicalRequestId)
    ?? nonEmpty(request.integration?.logical_request_id);
  if (explicit) return explicit;
  const integration = request.integration ?? {};
  const body = integration.body ?? integration.requestBody ?? integration.request ?? integration.payload;
  if (body != null) return logicalRequestHash(body);
  return logicalRequestHash({ input: request.prompt ?? '', turnId: request.turnId ?? null });
}

function eventName(raw) {
  return nonEmpty(firstValue(raw, ['hook_event_name', 'hookEventName', 'event_type', 'eventType', 'event', 'type', 'name'])) ?? '';
}

function normalizedEventName(value) {
  return text(value).toLowerCase().replace(/[\s_-]/g, '');
}

function commandFrom(raw) {
  const input = firstValue(raw, ['tool_input', 'toolInput', 'input']);
  const command = typeof input === 'string' ? input : input && typeof input === 'object'
    ? firstValue(input, ['command', 'cmd', 'script']) : undefined;
  return text(firstValue(raw, ['command', 'cmd']) ?? command);
}

function routineTool(tool, command = '') {
  const normalized = text(tool).toLowerCase().replace(/[\s-]+/g, '_');
  if (ROUTINE_TOOL_NAMES.has(normalized)) return true;
  const first = text(command).trim().split(/\s+/)[0]?.split('/').pop()?.toLowerCase();
  return ROUTINE_TOOL_NAMES.has(first) || ['grep', 'rg', 'find', 'ls'].includes(first);
}

function expectedSearchNonzero(tool, command) {
  const normalized = text(tool).toLowerCase().replace(/[\s-]+/g, '_');
  if (['grep', 'rg', 'ripgrep', 'find', 'ls'].includes(normalized)) return true;
  const first = text(command).trim().split(/\s+/)[0]?.split('/').pop()?.toLowerCase();
  return ['grep', 'rg', 'ripgrep', 'find', 'ls'].includes(first);
}

function exitCodeFrom(raw, outcome) {
  const value = firstValue(outcome, ['exit_code', 'exitCode', 'returncode', 'return_code', 'code'])
    ?? firstValue(raw, ['exit_code', 'exitCode', 'returncode', 'return_code']);
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function responseText(raw, nested, response) {
  const values = [
    firstValue(raw, ['tool_response', 'output', 'message']),
    firstValue(nested, ['output', 'message']),
    firstValue(response, ['output', 'message']),
  ];
  return values.filter(value => typeof value === 'string').map(value => text(value)).join(' ').slice(0, 500);
}

function verificationCommand(command, tool) {
  const value = `${tool} ${command}`.toLowerCase();
  return /(?:\b(?:test|tests|pytest|jest|vitest|mocha|run[_ -]?tests?|cargo\s+test|go\s+test|mvn\s+test|gradle\s+test|npm\s+(?:test|run\s+(?:test|lint|check|build))|yarn\s+(?:test|lint|check|build)|make\s+(?:test|check|verify)|\b(?:lint|check|verify|build|compile)\b))/.test(value);
}

function searchCommand(command) {
  return /(?:^|\s)(?:git\s+)?(?:grep|rg|ripgrep|find|ls|cat|head|tail|sed)\b/i.test(text(command).trim());
}

function executionTool(tool, command) {
  if (searchCommand(command)) return false;
  const value = text(tool).toLowerCase().replace(/[\s-]+/g, '_');
  return ['bash', 'shell', 'exec', 'exec_command', 'terminal', 'run', 'command', 'powershell', 'cmd'].includes(value)
    || /(?:^|\s)(?:node|python(?:3)?|ruby|go|cargo|npm|yarn|pytest|jest|make|gradle|mvn)\b/i.test(text(command).trim());
}

function normalizeToolOutcome(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : { status: raw };
  const nested = source.outcome && typeof source.outcome === 'object' ? source.outcome : {};
  const response = source.tool_response && typeof source.tool_response === 'object' ? source.tool_response : {};
  const tool = nonEmpty(firstValue(source, ['tool', 'tool_name', 'toolName', 'name']))
    ?? nonEmpty(firstValue(response, ['tool', 'tool_name', 'toolName'])) ?? 'unknown';
  const command = commandFrom(source);
  const exitCode = exitCodeFrom(source, nested) ?? exitCodeFrom(response, response);
  const statusValue = firstValue(source, ['status', 'state', 'result_status'])
    ?? firstValue(nested, ['status', 'state']) ?? firstValue(response, ['status', 'state']);
  const status = text(statusValue).toLowerCase();
  const success = bool(firstValue(source, ['success', 'ok', 'passed']))
    ?? bool(firstValue(nested, ['success', 'ok', 'passed']))
    ?? bool(firstValue(response, ['success', 'ok', 'passed']));
  const explicitError = firstValue(source, ['error', 'error_message', 'errorMessage', 'failure_reason', 'failureReason'])
    ?? firstValue(nested, ['error', 'error_message', 'errorMessage', 'failure_reason', 'failureReason'])
    ?? firstValue(response, ['error', 'error_message', 'errorMessage', 'failure_reason', 'failureReason']);
  const output = responseText(source, nested, response);
  const timedOut = bool(firstValue(source, ['timed_out', 'timedOut', 'timeout', 'stalled'])) === true
    || /(?:timeout|timed[ _-]?out|stalled|deadline)/i.test(status)
    || /(?:timeout|timed[ _-]?out|deadline\s+exceeded)/i.test(output);
  const expectedNonzero = bool(firstValue(source, ['expected_nonzero', 'expectedNonzero', 'expectedExit'])) === true
    || bool(firstValue(nested, ['expected_nonzero', 'expectedNonzero', 'expectedExit'])) === true
    || (exitCode === 1 && expectedSearchNonzero(tool, command) && !/(?:error|failed|failure)/i.test(status));
  const explicitlyRoutine = bool(firstValue(source, ['routine', 'routine_tool', 'routineTool'])) === true;
  const routine = explicitlyRoutine || routineTool(tool, command);
  const explicitProgress = bool(firstValue(source, ['verified_progress', 'verifiedProgress', 'progress'])) === true
    || bool(firstValue(nested, ['verified_progress', 'verifiedProgress', 'progress'])) === true;
  const verificationMarker = /(?:\b(?:FAIL(?:ED)?|ERROR|TRACEBACK|ASSERTIONERROR|BUILD\s+FAILED|COMPIL(?:ATION|E)\s+FAILED|TEST(?:S)?\s+FAILED|\d+\s+FAILED)\b)/i.test(output);
  const runtimeMarker = executionTool(tool, command)
    && /(?:\b(?:ERROR|EXCEPTION|TRACEBACK|ASSERTIONERROR|PANIC|FATAL)\b|\bat\s+[^\n]+\([^\n]+\))/i.test(output);
  const marker = verificationMarker || runtimeMarker;
  const successMarker = verificationCommand(command, tool)
    && /(?:\b(?:PASS(?:ED)?|OK|SUCCESS(?:FUL(?:LY)?)?)\b|all\s+tests?\s+(?:pass|passed))/i.test(output);
  const verifiedNonzero = exitCode != null && exitCode !== 0 && verificationCommand(command, tool);
  // An exit code by itself is deliberately neutral.  Shell search commands
  // commonly use 1 for "no match"; only explicit failure/status evidence or
  // a recognized test/build/check command turns it into a substantive failure.
  const failureStatus = /^(?:error|failed|failure|cancelled|canceled|rejected|invalid)$/i.test(status)
    || success === false || Boolean(explicitError)
    || (marker && (verificationCommand(command, tool) || runtimeMarker || Boolean(explicitError)))
    || verifiedNonzero;
  let kind = 'success';
  let normalizedStatus = 'success';
  let substantive = false;
  let verifiedProgress = explicitProgress;
  const markerDetail = output.match(/\b(?:Error|Exception|Traceback|AssertionError|panic|fatal)\s*:\s*([^\n]+)/i);
  let detail = nonEmpty(typeof explicitError === 'string' ? explicitError : '')
    ?? (markerDetail ? `${markerDetail[0].split(':')[0]}: ${truncate(markerDetail[1], 120)}`
      : runtimeMarker ? 'runtime_error_marker' : verificationMarker ? 'verification_failure_marker'
        : verifiedNonzero ? 'verification_command_nonzero' : null);
  if (timedOut) {
    kind = 'stalled';
    normalizedStatus = 'timeout';
    substantive = true;
    detail ??= 'tool_timeout';
  } else if (failureStatus) {
    kind = 'substantive_failure';
    normalizedStatus = 'failure';
    substantive = true;
  } else if (expectedNonzero) {
    kind = 'expected_nonzero';
    normalizedStatus = 'neutral';
  } else if (exitCode != null && exitCode !== 0) {
    kind = 'neutral';
    normalizedStatus = 'neutral';
  } else if (explicitlyRoutine || explicitProgress || (routine && (success === true || status === 'success' || status === 'ok' || status === 'passed'))) {
    kind = 'routine_progress';
    normalizedStatus = 'progress';
    verifiedProgress = true;
  } else if (successMarker) {
    kind = 'routine_progress';
    normalizedStatus = 'progress';
    verifiedProgress = true;
  } else if (success === null && !status && exitCode == null) {
    kind = 'unknown';
    normalizedStatus = 'unknown';
  }
  return {
    tool: truncate(tool, 80),
    kind,
    status: normalizedStatus,
    exitCode,
    expectedNonzero,
    routine,
    substantive,
    verifiedProgress,
    stalled: kind === 'stalled',
    detail: detail ? truncate(detail, 160) : null,
  };
}

/**
 * Convert a Codex hook payload into a compact signal.  Raw tool input/output
 * is intentionally discarded; the state engine only needs outcome classes.
 */
export function normalizeHookEvent(raw) {
  if (!raw || typeof raw !== 'object') {
    return {
      schema: HOOK_EVENT_SCHEMA,
      eventId: randomUUID(),
      eventType: 'unknown',
      kind: 'unsupported_path',
      supported: false,
      unsupportedPath: 'invalid_hook_payload',
      timestampMs: Date.now(),
    };
  }
  const name = eventName(raw);
  const normalizedName = normalizedEventName(name);
  const sessionId = nonEmpty(firstValue(raw, ['session_id', 'session-id', 'sessionId', 'thread_id', 'thread-id', 'threadId']))
    ?? headerValue(raw, ['session_id', 'session-id', 'thread-id', 'thread_id']);
  const turnId = nonEmpty(firstValue(raw, ['turn_id', 'turn-id', 'turnId']));
  const logicalRequestId = nonEmpty(firstValue(raw, ['logical_request_id', 'logicalRequestId', 'request_id', 'requestId']));
  const tool = nonEmpty(firstValue(raw, ['tool_name', 'toolName', 'tool', 'name'])) ?? 'unknown';
  const outcome = normalizeToolOutcome({ ...raw, tool });
  const base = {
    schema: HOOK_EVENT_SCHEMA,
    eventId: nonEmpty(firstValue(raw, ['event_id', 'eventId', 'id', 'tool_use_id', 'toolUseId'])) ?? randomUUID(),
    eventType: 'unknown',
    kind: 'unsupported_path',
    supported: false,
    sessionId,
    turnId,
    logicalRequestId,
    tool: outcome.tool,
    outcome,
    source: nonEmpty(firstValue(raw, ['source', 'event_source', 'eventSource'])) ?? 'hook',
    timestampMs: Number(firstValue(raw, ['timestamp_ms', 'timestampMs', 'timestamp'])) || Date.now(),
  };
  if (normalizedName === 'posttooluse') {
    return { ...base, eventType: 'post_tool_use', kind: 'tool_outcome', supported: true };
  }
  if (normalizedName === 'pretooluse') {
    return { ...base, eventType: 'pre_tool_use', unsupportedPath: 'pre_tool_use_permission_path' };
  }
  if (normalizedName === 'userpromptsubmit' || normalizedName === 'userprompt') {
    return { ...base, eventType: 'user_prompt_submit', kind: 'user_prompt', supported: true };
  }
  return { ...base, unsupportedPath: name ? `unsupported_hook:${truncate(name, 80)}` : 'missing_hook_event_name' };
}

function normalizePolicy(policy = {}) {
  const get = (camel, snake, fallback, minimum = 0) => integer(policy[camel] ?? policy[snake], fallback, minimum);
  const configuredRepeatedFailureEscalation = bool(
    policy.repeatedFailureEscalation ?? policy.repeated_failure_escalation,
  );
  const configuredAllowDeescalation = bool(
    policy.allowDeescalation ?? policy.allow_deescalation,
  );
  const fallback = EFFORT_SET.has(policy.fallbackEffort) ? policy.fallbackEffort
    : EFFORT_SET.has(policy.fallback_effort) ? policy.fallback_effort : DEFAULT_POLICY.fallbackEffort;
  return {
    windowGenerations: get('windowGenerations', 'window_generations', DEFAULT_POLICY.windowGenerations, 1),
    minimumHold: get('minimumHold', 'minimum_hold', DEFAULT_POLICY.minimumHold, 0),
    repeatedFailures: get('repeatedFailures', 'repeated_failures', DEFAULT_POLICY.repeatedFailures, 1),
    repeatedFailureEscalation: configuredRepeatedFailureEscalation == null
      ? DEFAULT_POLICY.repeatedFailureEscalation : configuredRepeatedFailureEscalation,
    allowDeescalation: configuredAllowDeescalation == null
      ? DEFAULT_POLICY.allowDeescalation : configuredAllowDeescalation,
    fallbackEffort: fallback,
    ttlMs: get('ttlMs', 'ttl_ms', DEFAULT_POLICY.ttlMs, 1),
    maxSessions: get('maxSessions', 'max_sessions', DEFAULT_POLICY.maxSessions, 1),
    maxTurnsPerSession: get('maxTurnsPerSession', 'max_turns_per_session', DEFAULT_POLICY.maxTurnsPerSession, 1),
    maxRequestsPerTurn: get('maxRequestsPerTurn', 'max_requests_per_turn', DEFAULT_POLICY.maxRequestsPerTurn, 1),
    maxRecentOutcomes: get('maxRecentOutcomes', 'max_recent_outcomes', DEFAULT_POLICY.maxRecentOutcomes, 1),
    maxEventsPerTurn: get('maxEventsPerTurn', 'max_events_per_turn', DEFAULT_POLICY.maxEventsPerTurn, 1),
    maxEventFilesPerRead: get('maxEventFilesPerRead', 'max_event_files_per_read', DEFAULT_POLICY.maxEventFilesPerRead, 1),
    maxPromptChars: get('maxPromptChars', 'max_prompt_chars', DEFAULT_POLICY.maxPromptChars, 80),
    maxEvidenceItems: get('maxEvidenceItems', 'max_evidence_items', DEFAULT_POLICY.maxEvidenceItems, 1),
  };
}

function compactOutcome(outcome) {
  return {
    tool: truncate(outcome.tool, 80),
    kind: outcome.kind,
    status: outcome.status,
    exitCode: outcome.exitCode,
    expectedNonzero: outcome.expectedNonzero === true,
    routine: outcome.routine === true,
    substantive: outcome.substantive === true,
    verifiedProgress: outcome.verifiedProgress === true,
    detail: outcome.detail ? truncate(outcome.detail, 160) : null,
  };
}

function genericStoredEvent(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const result = {
    schema: DECISION_EVENT_SCHEMA,
    eventId: nonEmpty(firstValue(source, ['eventId', 'event_id', 'id'])) ?? randomUUID(),
    eventType: nonEmpty(firstValue(source, ['eventType', 'event_type', 'type', 'event'])) ?? 'event',
    timestampMs: Number(firstValue(source, ['timestampMs', 'timestamp_ms', 'timestamp'])) || Date.now(),
  };
  for (const key of ['sessionId', 'turnId', 'logicalRequestId', 'reason', 'decisionReason', 'appliedEffort',
    'recommendedEffort', 'classifierRecommendedEffort', 'policyFloor', 'policy_floor', 'previousEffort', 'effort',
    'fallback', 'classified', 'reused', 'latencyMs',
    'decision_time_ms', 'decision_reason', 'applied_effort', 'unsupportedPath', 'supported', 'hooksObserved', 'integration']) {
    if (source[key] != null) result[key] = typeof source[key] === 'string' ? truncate(source[key], 160) : source[key];
  }
  if (Array.isArray(source.unsupportedPaths)) result.unsupportedPaths = source.unsupportedPaths.slice(0, 16).map(x => truncate(x, 120));
  if (Array.isArray(source.evidence)) result.evidence = source.evidence.slice(0, 16).map(x => typeof x === 'string' ? truncate(x, 160) : compactObject(x));
  else if (source.evidence && typeof source.evidence === 'object') result.evidence = compactObject(source.evidence);
  return result;
}

function compactObject(value, depth = 0) {
  if (depth > 2) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 16).map(item => compactObject(item, depth + 1));
  if (!value || typeof value !== 'object') return typeof value === 'string' ? truncate(value, 160) : value;
  const result = {};
  for (const key of Object.keys(value).slice(0, 24)) {
    if (/^(?:prompt|input|output|body|context|tool_input|tool_response|raw)$/i.test(key)) continue;
    result[key] = compactObject(value[key], depth + 1);
  }
  return result;
}

/**
 * Publish one event as a unique JSON file using write-then-rename.  Unique
 * files avoid read/modify/write races between concurrent hook processes.
 */
export async function publishEvent(directory, event) {
  if (!directory) return { published: false, supported: false, unsupportedPath: 'event_directory_unconfigured' };
  const normalized = event?.schema === HOOK_EVENT_SCHEMA
    ? compactObject(event)
    : event?.eventType === 'post_tool_use' || event?.eventType === 'pre_tool_use' || event?.hook_event_name || event?.hookEventName
      ? compactObject(normalizeHookEvent(event))
      : genericStoredEvent(event);
  normalized.eventId ??= randomUUID();
  normalized.timestampMs ??= Date.now();
  const folder = resolve(text(directory));
  await fs.mkdir(folder, { recursive: true, mode: 0o700 });
  const filename = `event-${normalized.timestampMs}-${process.pid}-${randomUUID()}.json`;
  const target = join(folder, filename);
  const temporary = `${target}.tmp-${randomUUID()}`;
  const data = `${JSON.stringify(normalized)}\n`;
  try {
    await fs.writeFile(temporary, data, { flag: 'wx', mode: 0o600 });
    await fs.rename(temporary, target);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
  return { ...normalized, published: true, path: target };
}

function eventMatches(event, sessionId, turnId) {
  if (!event || typeof event !== 'object') return false;
  if (event.sessionId && event.sessionId !== sessionId) return false;
  if (!event.sessionId || !event.turnId) return false;
  return event.turnId === turnId;
}

function eventFingerprint(event) {
  return event.eventId ?? logicalRequestHash({
    eventType: event.eventType,
    sessionId: event.sessionId,
    turnId: event.turnId,
    logicalRequestId: event.logicalRequestId,
    tool: event.tool,
    outcome: event.outcome,
    timestampMs: event.timestampMs,
  });
}

async function readMatchingEvents(directory, sessionId, turnId, config, seenFiles, now) {
  if (!directory) return [];
  let entries;
  try {
    entries = await fs.readdir(resolve(text(directory)), { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    return [{
      schema: HOOK_EVENT_SCHEMA,
      eventId: randomUUID(),
      eventType: 'unsupported_path',
      kind: 'unsupported_path',
      supported: false,
      unsupportedPath: 'event_directory_unreadable',
      sessionId,
      turnId,
      errorCode: error?.code ?? 'read_error',
      timestampMs: timestamp(now),
    }];
  }
  const files = entries.filter(entry => entry.isFile() && entry.name.endsWith('.json'))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(-Math.min(config.maxEventFilesPerRead, config.maxEventsPerTurn));
  const events = [];
  const current = timestamp(now);
  for (const entry of files) {
    const path = join(resolve(text(directory)), entry.name);
    if (seenFiles.has(path)) continue;
    let raw;
    try { raw = JSON.parse(await fs.readFile(path, 'utf8')); } catch { continue; }
    // Decision receipts share the directory with hook events.  They are audit
    // records, never new tool outcomes, and must not become unsupported-hook
    // signals on the next model request.
    if (raw?.schema === DECISION_EVENT_SCHEMA || raw?.eventType === 'decision') continue;
    const event = raw?.schema === HOOK_EVENT_SCHEMA
      ? { ...raw, source: raw.source ?? 'hook' }
      : normalizeHookEvent(raw);
    if (!eventMatches(event, sessionId, turnId)) continue;
    const eventTime = Number(event.timestampMs);
    if (Number.isFinite(eventTime) && current - eventTime > config.ttlMs) continue;
    seenFiles.set(path, timestamp(now));
    events.push(event);
  }
  return events;
}

/**
 * Resolve the most recent live hook turn for a session when the transport has
 * no turn header.  UserPromptSubmit is preferred because a late PostToolUse
 * belongs to the prompt that created the turn; a post-tool event is the
 * bounded fallback for hosts that do not emit prompt hooks.
 */
export async function latestHookTurn(directory, sessionId, { ttlMs = DEFAULT_POLICY.ttlMs, maxFiles = 128, now = Date.now } = {}) {
  if (!directory || !sessionId) return null;
  let entries;
  try {
    entries = await fs.readdir(resolve(text(directory)), { withFileTypes: true });
  } catch { return null; }
  const current = timestamp(now);
  const files = entries.filter(entry => entry.isFile() && entry.name.endsWith('.json'))
    .sort((a, b) => a.name.localeCompare(b.name)).slice(-integer(maxFiles, 128, 1));
  let latestPrompt = null;
  let latestPostTool = null;
  for (const entry of files) {
    let raw;
    try { raw = JSON.parse(await fs.readFile(join(resolve(text(directory)), entry.name), 'utf8')); } catch { continue; }
    if (raw?.schema === DECISION_EVENT_SCHEMA || raw?.eventType === 'decision') continue;
    const event = raw?.schema === HOOK_EVENT_SCHEMA ? raw : normalizeHookEvent(raw);
    if (event.sessionId !== String(sessionId) || !event.turnId) continue;
    const eventTime = Number(event.timestampMs) || current;
    if (current - eventTime > ttlMs) continue;
    if (event.eventType === 'user_prompt_submit') latestPrompt = event;
    else if (event.eventType === 'post_tool_use') latestPostTool = event;
  }
  return (latestPrompt ?? latestPostTool)?.turnId ?? null;
}

function asOutcomes(values) {
  if (values == null) return [];
  const array = Array.isArray(values) ? values : [values];
  return array.map(value => {
    if (value?.schema === HOOK_EVENT_SCHEMA && value.outcome) return { event: { ...value, source: 'wire' }, outcome: value.outcome };
    if (value?.eventType === 'post_tool_use' && value.outcome) return { event: { ...value, source: 'wire' }, outcome: value.outcome };
    if (value?.eventType === 'pre_tool_use') return { event: value, outcome: null };
    if (value?.hook_event_name || value?.hookEventName || value?.eventType === 'post_tool_use') {
      const event = value?.schema === HOOK_EVENT_SCHEMA ? value : normalizeHookEvent(value);
      return { event: { ...event, source: 'wire' }, outcome: event.supported ? event.outcome : null };
    }
    return { event: null, outcome: normalizeToolOutcome(value) };
  });
}

function classifyEffort(result) {
  if (typeof result === 'string') return EFFORT_SET.has(result) ? result : null;
  if (!result || typeof result !== 'object') return null;
  if (String(result.task_class ?? result.taskClass ?? '').toLowerCase() === 'error' || result.error) return null;
  const value = firstValue(result, ['effort', 'recommended_reasoning_effort', 'recommendedReasoningEffort', 'reasoning_effort']);
  return EFFORT_SET.has(value) ? value : null;
}

function higherEffort(first, second) {
  if (!first) return second ?? null;
  if (!second) return first;
  return EFFORT_RANK.get(second) > EFFORT_RANK.get(first) ? second : first;
}

// Persistent failures move the policy floor one supported step at a time.
// In particular, `high` remains `high`; this policy does not resurrect the
// legacy `max` jump.
function repeatedFailureStep(effort) {
  if (effort === 'low') return 'medium';
  if (effort === 'medium') return 'high';
  return effort;
}

function classifyWindow(result, fallback) {
  if (!result || typeof result !== 'object') return fallback;
  const value = firstValue(result, ['window_generations', 'windowGenerations', 'generation_window', 'generationWindow', 'windows']);
  const number = Number(value);
  return Number.isFinite(number) && number >= 1 ? Math.min(64, Math.floor(number)) : fallback;
}

function classifyFailureReason(error) {
  const message = text(error?.message ?? error).toLowerCase();
  if (message.includes('timeout')) return 'classifier_timeout';
  if (message.includes('unavailable')) return 'classifier_unavailable';
  return 'classifier_error';
}

function resultFor(turn, cached, request, reusedReason = 'logical_request_retry') {
  const receipt = {
    ...cached.receipt,
    effort: cached.effort,
    appliedEffort: cached.effort,
    reused: true,
    classified: false,
    fallback: cached.receipt.fallback === true,
    reason: reusedReason,
    decisionReason: cached.receipt.decisionReason,
    logicalRequestId: request.logicalRequestId,
    modelRequestNumber: turn.modelRequests,
    window: {
      generations: cached.receipt.window?.generations ?? null,
      requestsSinceDecision: Math.max(0, turn.modelRequests - turn.decisionGeneration),
    },
  };
  return { effort: cached.effort, receipt };
}

function buildSummary(turn, request, reason, evidence, config) {
  const objective = truncate(request.prompt ?? turn.objective ?? '', config.maxPromptChars);
  const recent = turn.recentOutcomes.slice(-config.maxRecentOutcomes).map(compactOutcome);
  const unresolved = turn.failureStreak > 0
    ? `${turn.failureStreak} substantive failure${turn.failureStreak === 1 ? '' : 's'} unresolved`
    : turn.stalledCount > 0 ? `${turn.stalledCount} stalled check${turn.stalledCount === 1 ? '' : 's'} unresolved` : 'none recorded';
  return {
    objective,
    phase: turn.phase,
    unresolvedIssue: unresolved,
    recentToolOutcomes: recent,
    currentEffort: turn.effort ?? turn.inheritedEffort,
    requestsSinceReassessment: Math.max(0, turn.modelRequests - turn.decisionGeneration),
    reason,
    evidence: evidence.slice(0, config.maxEvidenceItems),
  };
}

function summaryText(summary) {
  const outcomes = summary.recentToolOutcomes.length
    ? summary.recentToolOutcomes.map(item => `${item.tool}:${item.kind}${item.detail ? `(${item.detail})` : ''}`).join(', ')
    : 'none';
  const evidence = summary.evidence.length ? summary.evidence.join(', ') : 'none';
  return [
    `Task objective: ${summary.objective || '(not supplied)'}`,
    `Current phase: ${summary.phase || 'unknown'}`,
    `Unresolved issue: ${summary.unresolvedIssue}`,
    `Recent tool outcomes: ${outcomes}`,
    `Current effort: ${summary.currentEffort || 'unset'}`,
    `Requests since reassessment: ${summary.requestsSinceReassessment}`,
    `Outcome evidence: ${JSON.stringify(summary.recentToolOutcomes)}`,
    `Routing trigger: ${summary.reason}`,
    `Evidence: ${evidence}`,
  ].join('\n');
}

function integrationStatus(turn, integration = {}) {
  const configured = integration.hooks === 'configured';
  const stableIdentity = integration.stableIdentity !== false && integration.stable_identity !== false;
  if (!configured || !stableIdentity) return 'prompt-only';
  return turn.hooksObserved ? 'hooks-active' : 'hooks-pending_or_unavailable';
}

function inferPhase(prompt, outcomes, prior = 'unknown') {
  const recent = outcomes.at(-1);
  if (recent?.substantive) return 'remediation';
  if (recent && /(?:test|check|verify|lint|build|compile|validate|score)/i.test(recent.tool)) return 'verification';
  if (recent && /(?:write|edit|patch)/i.test(recent.tool)) return 'implementation';
  // A request to implement something and later test it starts in implementation.
  // The actual recent action takes precedence once progress is available.
  if (outcomes.length && prior !== 'unknown') return prior;
  const value = String(prompt ?? '').toLowerCase();
  if (/(?:fail|error|bug|broken|regression|fix|repair|timeout|stalled)/.test(value)) return 'remediation';
  if (/(?:implement|create|add|write|refactor|change|update|design)/.test(value)) return 'implementation';
  if (/(?:test|check|verify|lint|build|compile|validate|score)/.test(value)) return 'verification';
  return prior;
}

function transitionAllowed(turn, recommendation, reason, config, signals = {}) {
  const currentEffort = turn.effort ?? turn.inheritedEffort;
  if (!currentEffort || currentEffort === recommendation) return true;
  const currentRank = EFFORT_RANK.get(currentEffort);
  const nextRank = EFFORT_RANK.get(recommendation);
  if (nextRank < currentRank && config.allowDeescalation === false) return false;
  // A new user instruction is explicit steering and should not be trapped by
  // the hold window.  Other transitions wait for the conservative hold.
  if (reason === 'new_user') return true;
  if (nextRank < currentRank && !signals.routineProgress && !signals.routineNextStep
    && turn.progressTotal <= turn.progressAtApplication) return false;
  const sinceApplied = turn.modelRequests - turn.appliedGeneration;
  return sinceApplied >= config.minimumHold;
}

function makeEvidence(turn, reason, signals, config) {
  const evidence = [];
  if (reason) evidence.push(reason);
  if (signals.substantiveFailures) evidence.push(`substantive_failures:${signals.substantiveFailures}`);
  if (signals.stalled) evidence.push('stalled');
  if (signals.repeatedFailure) evidence.push(`repeated_failure_threshold:${config.repeatedFailures}`);
  if (signals.repeatedFailurePending) evidence.push('repeated_failure_pending');
  if (signals.routineProgress) evidence.push(`verified_routine_progress:${signals.routineProgress}`);
  if (signals.windowExpired) evidence.push('generation_window_expired');
  if (signals.newUser) evidence.push('new_user_instruction');
  if (signals.explicitReassessment) evidence.push('explicit_reassessment');
  if (signals.routineNextStep) evidence.push('next_step_routine');
  if (signals.nextStepRequiresDeepReasoning) evidence.push('next_step_requires_deep_reasoning');
  if (signals.unsupportedPaths?.length) evidence.push(`unsupported:${signals.unsupportedPaths.join('|')}`);
  return [...new Set(evidence)].slice(0, config.maxEvidenceItems);
}

function shouldReassess(turn, signals, config) {
  if (!turn.effort) return 'initial';
  if (signals.newUser) return 'new_user';
  if (signals.repeatedFailurePending) return 'repeated_failure_pending';
  if (signals.explicitReassessment) return 'reassessment';
  if (signals.stalled) return 'stalled';
  if (signals.substantiveFailures > 0) return 'tool_failure';
  if (signals.windowExpired) return 'window_expired';
  return null;
}

function updateTurnFromSignals(turn, outcomes, config) {
  const signals = {
    substantiveFailures: 0,
    stalled: false,
    routineProgress: 0,
    repeatedFailure: false,
    repeatedFailurePending: false,
    windowExpired: false,
    newUser: false,
    explicitReassessment: false,
    hooksObserved: false,
    routineNextStep: false,
    nextStepRequiresDeepReasoning: false,
    unsupportedPaths: [],
  };
  const unique = new Set();
  for (const { event, outcome } of outcomes) {
    // A wire-derived copy can precede the persisted hook copy in the same
    // request.  Observation provenance still counts even when the outcome is
    // deduplicated for failure/progress accounting.
    if (event?.eventType === 'post_tool_use' && event.supported === true && event.source === 'hook') {
      signals.hooksObserved = true;
    }
    if (event?.eventId && (unique.has(event.eventId) || turn.eventIds.has(event.eventId))) continue;
    if (event?.eventId) {
      unique.add(event.eventId);
      turn.eventIds.add(event.eventId);
      while (turn.eventIds.size > config.maxEventsPerTurn) turn.eventIds.delete(turn.eventIds.values().next().value);
    }
    if (event && event.supported === false) {
      if (event.unsupportedPath) signals.unsupportedPaths.push(event.unsupportedPath);
      continue;
    }
    if (event?.eventType === 'user_prompt_submit') continue;
    if (!outcome) continue;
    const compact = compactOutcome(outcome);
    turn.recentOutcomes.push(compact);
    if (turn.recentOutcomes.length > config.maxRecentOutcomes) turn.recentOutcomes.splice(0, turn.recentOutcomes.length - config.maxRecentOutcomes);
    if (outcome.substantive) {
      signals.substantiveFailures += 1;
      turn.failureStreak += 1;
      turn.failureTotal += 1;
    } else if (outcome.verifiedProgress || outcome.kind === 'routine_progress') {
      signals.routineProgress += 1;
      turn.failureStreak = 0;
      turn.repeatedFailureFloorPending = false;
      turn.progressTotal += 1;
      turn.stalledCount = 0;
    } else if (outcome.kind !== 'expected_nonzero' && outcome.kind !== 'neutral') {
      // A verified successful non-routine action resolves the current failure
      // streak without pretending that it is a routing trigger.
      if (outcome.status === 'success') turn.failureStreak = 0;
    }
    if (outcome.stalled) {
      signals.stalled = true;
      turn.stalledCount += 1;
    }
  }
  signals.repeatedFailure = turn.failureStreak >= config.repeatedFailures;
  signals.windowExpired = turn.effort != null
    && turn.modelRequests - turn.decisionGeneration >= config.windowGenerations;
  return signals;
}

function stateKey(sessionId, turnId) {
  return `${sessionId}\u0000${turnId}`;
}

/**
 * Create a bounded, per-session/per-turn routing state engine.
 *
 * `classify` receives a bounded text summary as its first argument for
 * compatibility with the existing MCP classifier and the structured summary
 * as its second argument for classifiers that consume outcome evidence.
 */
export function createRoutingEngine({ classify, onDecision = () => {}, policy = {}, eventDirectory, now = Date.now } = {}) {
  if (typeof classify !== 'function') throw new TypeError('createRoutingEngine requires classify(prompt, summary)');
  const config = { ...DEFAULT_POLICY, ...normalizePolicy(policy) };
  const sessions = new Map();
  const seenEventFiles = new Map();
  let closed = false;

  function prune(currentTime = timestamp(now)) {
    for (const [path, seenAt] of seenEventFiles) {
      if (currentTime - seenAt > config.ttlMs) seenEventFiles.delete(path);
    }
    for (const [key, session] of sessions) {
      if (currentTime - session.touchedAt > config.ttlMs) sessions.delete(key);
      else {
        for (const [turnId, turn] of session.turns) {
          if (currentTime - turn.touchedAt > config.ttlMs) session.turns.delete(turnId);
        }
      }
    }
    const maxSeenFiles = config.maxSessions * config.maxTurnsPerSession * config.maxEventsPerTurn;
    while (seenEventFiles.size > maxSeenFiles) seenEventFiles.delete(seenEventFiles.keys().next().value);
    while (sessions.size > config.maxSessions) sessions.delete(sessions.keys().next().value);
    for (const session of sessions.values()) {
      while (session.turns.size > config.maxTurnsPerSession) session.turns.delete(session.turns.keys().next().value);
    }
  }

  function getTurn(sessionId, turnId, currentTime) {
    let session = sessions.get(sessionId);
    if (!session) {
      session = { sessionId, turns: new Map(), touchedAt: currentTime, lastEffort: null };
      sessions.set(sessionId, session);
    }
    session.touchedAt = currentTime;
    let turn = session.turns.get(turnId);
    if (!turn) {
      turn = {
        sessionId,
        turnId,
        effort: null,
        inheritedEffort: session.lastEffort,
        objective: '',
        phase: 'unknown',
        promptHash: null,
        modelRequests: 0,
        decisionGeneration: 0,
        appliedGeneration: 0,
        lastDecisionBatchId: null,
        failureStreak: 0,
        failureTotal: 0,
        failureTotalAtApplication: 0,
        stalledCount: 0,
        progressTotal: 0,
        progressAtApplication: 0,
        deepReasoningFloorPending: false,
        repeatedFailureFloorPending: false,
        windowGenerations: null,
        hooksObserved: false,
        recentOutcomes: [],
        requests: new Map(),
        pending: new Map(),
        queue: Promise.resolve(),
        touchedAt: currentTime,
        unsupportedPaths: new Set(),
        eventIds: new Set(),
      };
      session.turns.set(turnId, turn);
    }
    while (sessions.size > config.maxSessions) sessions.delete(sessions.keys().next().value);
    while (session.turns.size > config.maxTurnsPerSession) session.turns.delete(session.turns.keys().next().value);
    turn.touchedAt = currentTime;
    return { session, turn };
  }

  async function emitDecision(event) {
    try {
      await onDecision(event);
    } catch {
      // A reporting callback cannot invalidate the selected effort.
    }
    if (eventDirectory) {
      try { await publishEvent(eventDirectory, { ...event, schema: DECISION_EVENT_SCHEMA, eventType: 'decision' }); } catch {
        // Keep transport usable when the optional event directory is unavailable.
      }
    }
  }

  async function performSelection(request, session, turn, logicalRequestId, currentTime) {
    if (turn.requests.has(logicalRequestId)) return resultFor(turn, turn.requests.get(logicalRequestId), request);

    const explicitPrompt = nonEmpty(request.prompt);
    const promptHash = explicitPrompt ? logicalRequestHash({ prompt: explicitPrompt }) : null;
    const newUser = request.integration?.newUser === true
      || request.integration?.new_user === true
      || (promptHash && turn.promptHash && promptHash !== turn.promptHash);
    if (explicitPrompt) {
      turn.objective = explicitPrompt;
      turn.promptHash = promptHash;
    }
    const requestedPhase = nonEmpty(request.integration?.phase);
    if (requestedPhase) turn.phase = truncate(requestedPhase, 80);
    const provided = asOutcomes(request.toolOutcomes);
    const stored = (await readMatchingEvents(eventDirectory, session.sessionId, turn.turnId,
      config, seenEventFiles, now)).map(event => ({ event, outcome: event.outcome ?? null }));
    const outcomes = [...provided, ...stored];
    const currentTimeAfterEvents = timestamp(now);

    // This is a model request count.  Exact retries returned above never get
    // here, so tool calls cannot consume a generation window.
    turn.modelRequests += 1;
    session.touchedAt = currentTimeAfterEvents;
    turn.touchedAt = currentTimeAfterEvents;
    const signals = updateTurnFromSignals(turn, outcomes, config);
    if (signals.hooksObserved) turn.hooksObserved = true;
    turn.phase = inferPhase(explicitPrompt ?? turn.objective, turn.recentOutcomes, turn.phase);
    signals.newUser = newUser;
    const integrationTrigger = text(request.integration?.trigger
      ?? request.integration?.reassessmentTrigger
      ?? request.integration?.reassessment_trigger).toLowerCase().replace(/[\s-]/g, '_');
    if (['new_user', 'user_input', 'user_prompt'].includes(integrationTrigger)) signals.newUser = true;
    if (['stalled', 'timeout', 'timed_out'].includes(integrationTrigger)) signals.stalled = true;
    const explicitlyRequiresDeepReasoning = request.integration?.nextStepRequiresDeepReasoning === true
      || request.integration?.next_step_requires_deep_reasoning === true
      || ['deep_reasoning', 'next_step_requires_deeper_reasoning'].includes(integrationTrigger);
    // A new user objective supersedes a deferred floor from the previous
    // objective.  Keep an explicit deep-reasoning request pending until a
    // valid assessment can apply it after the hold window.
    if (signals.newUser && !explicitlyRequiresDeepReasoning) turn.deepReasoningFloorPending = false;
    if (explicitlyRequiresDeepReasoning) turn.deepReasoningFloorPending = true;
    signals.nextStepRequiresDeepReasoning = explicitlyRequiresDeepReasoning || turn.deepReasoningFloorPending;
    if (signals.nextStepRequiresDeepReasoning) signals.explicitReassessment = true;
    if (['tool_failure', 'failure', 'reassessment', 'deep_reasoning', 'next_step_requires_deeper_reasoning'].includes(integrationTrigger)) {
      signals.explicitReassessment = true;
    }
    if (request.integration?.reassess === true || request.integration?.reassessment === true
      || request.integration?.nextStepRequiresDeepReasoning === true
      || request.integration?.next_step_requires_deep_reasoning === true) {
      signals.explicitReassessment = true;
    }
    if (request.integration?.stalled === true) signals.stalled = true;
    signals.routineNextStep = request.integration?.nextStepRoutine === true
      || request.integration?.next_step_routine === true;
    const unsupported = request.integration?.unsupportedPaths ?? request.integration?.unsupported_paths;
    if (Array.isArray(unsupported)) signals.unsupportedPaths.push(...unsupported.map(value => truncate(value, 120)));
    if (request.integration?.hooksSupported === false || request.integration?.hooks_supported === false) {
      signals.unsupportedPaths.push('hooks_unavailable_prompt_only');
    }
    if (request.integration?.hooks && request.integration.hooks !== 'configured') {
      signals.unsupportedPaths.push('post_tool_use_hooks_unconfigured');
    }
    if (request.integration?.stableIdentity === false || request.integration?.stable_identity === false) {
      signals.unsupportedPaths.push('stable_session_identity_unavailable');
    }
    const activeWindow = turn.windowGenerations ?? config.windowGenerations;
    signals.windowExpired = turn.effort != null
      && turn.modelRequests - turn.decisionGeneration >= activeWindow;
    if (signals.newUser) turn.repeatedFailureFloorPending = false;
    signals.repeatedFailurePending = turn.repeatedFailureFloorPending
      && !signals.routineProgress
      && turn.failureTotal > turn.failureTotalAtApplication
      && turn.modelRequests - turn.appliedGeneration >= config.minimumHold;
    if (signals.repeatedFailurePending) signals.explicitReassessment = true;
    // Multiple model requests can be queued by one transport turn while the
    // first classifier call is still pending.  Their tool outcomes are one
    // reassessment batch; the first decision is reused for the remainder of
    // that batch unless a genuinely new user instruction is present.
    const batchedAfterDecision = Boolean(request._routingBatchId)
      && turn.lastDecisionBatchId === request._routingBatchId && !signals.newUser;
    if (batchedAfterDecision) {
      signals.batched = true;
      signals.stalled = false;
      signals.explicitReassessment = false;
      signals.nextStepRequiresDeepReasoning = false;
      signals.repeatedFailurePending = false;
      signals.substantiveFailures = 0;
      signals.windowExpired = false;
    }
    for (const unsupported of signals.unsupportedPaths) turn.unsupportedPaths.add(unsupported);
    const reason = shouldReassess(turn, signals, config);
    const evidence = makeEvidence(turn, reason, signals, config);

    if (!reason) {
      const frozen = { effort: turn.effort ?? config.fallbackEffort, receipt: {
        schema: ROUTING_STATE_SCHEMA,
        sessionId: session.sessionId,
        turnId: turn.turnId,
        logicalRequestId,
        effort: turn.effort ?? config.fallbackEffort,
        appliedEffort: turn.effort ?? config.fallbackEffort,
        recommendedEffort: turn.effort ?? config.fallbackEffort,
        previousEffort: turn.effort,
        reason: signals.batched ? 'batched_outcomes' : signals.routineProgress ? 'routine_progress' : 'window_hold',
        decisionReason: turn.lastDecisionReason ?? 'prior_valid_decision',
        decision_reason: turn.lastDecisionReason ?? 'prior_valid_decision',
        applied_effort: turn.effort ?? config.fallbackEffort,
        evidence,
        latencyMs: 0,
        decision_time_ms: 0,
        fallback: turn.lastFallback === true,
        classified: false,
        reused: true,
        modelRequestNumber: turn.modelRequests,
        window: {
          generations: turn.windowGenerations ?? config.windowGenerations,
          requestsSinceDecision: Math.max(0, turn.modelRequests - turn.decisionGeneration),
        },
        hooksObserved: turn.hooksObserved,
        integration: integrationStatus(turn, request.integration),
        unsupportedPaths: [...turn.unsupportedPaths].slice(0, 16),
      } };
      turn.requests.set(logicalRequestId, frozen);
      while (turn.requests.size > config.maxRequestsPerTurn) turn.requests.delete(turn.requests.keys().next().value);
      return resultFor(turn, frozen, request, frozen.receipt.reason);
    }

    const summary = buildSummary(turn, { ...request, prompt: explicitPrompt ?? turn.objective }, reason, evidence, config);
    const started = timestamp(now);
    let recommendation = null;
    let classifierResult = null;
    let fallback = false;
    let fallbackReason = null;
    try {
      classifierResult = await classify(summaryText(summary), summary);
      recommendation = classifyEffort(classifierResult);
      if (!recommendation) {
        fallback = true;
        fallbackReason = 'classifier_invalid';
      }
    } catch (error) {
      fallback = true;
      fallbackReason = classifyFailureReason(error);
    }
    const latencyMs = Math.max(0, timestamp(now) - started);
    const previousEffort = turn.effort ?? turn.inheritedEffort;
    const validPrior = EFFORT_SET.has(previousEffort) ? previousEffort : null;
    const recommendedEffort = recommendation ?? validPrior ?? config.fallbackEffort;
    let repeatedFailureFloor = null;
    if (!fallback && config.repeatedFailureEscalation && validPrior && signals.repeatedFailure
      && turn.failureTotal > turn.failureTotalAtApplication && !signals.routineProgress) {
      const stepped = repeatedFailureStep(validPrior);
      if (EFFORT_RANK.get(stepped) > EFFORT_RANK.get(validPrior)) repeatedFailureFloor = stepped;
    }
    const deepReasoningFloor = !fallback && signals.nextStepRequiresDeepReasoning ? 'high' : null;
    const policyFloor = higherEffort(repeatedFailureFloor, deepReasoningFloor);
    const policyTarget = higherEffort(recommendedEffort, policyFloor);
    const policyEvidence = [];
    if (repeatedFailureFloor) policyEvidence.push('repeated_failure_escalation');
    if (deepReasoningFloor) policyEvidence.push('next_step_deep_reasoning_floor');
    let appliedEffort = policyTarget;
    let held = false;
    if (!fallback && validPrior && policyTarget !== validPrior
      && !transitionAllowed(turn, policyTarget, reason, config, signals)) {
      appliedEffort = validPrior;
      held = true;
    }
    // First failure can trigger a fresh assessment, but repeated failures are
    // the conservative signal that permits escalation during that path.
    if (!fallback && validPrior && EFFORT_RANK.get(policyTarget) > EFFORT_RANK.get(validPrior)
      && reason === 'tool_failure' && !signals.repeatedFailure && turn.modelRequests - turn.appliedGeneration < config.minimumHold) {
      appliedEffort = validPrior;
      held = true;
    }
    if (fallback && validPrior) appliedEffort = validPrior;
    if (!fallback && signals.nextStepRequiresDeepReasoning
      && EFFORT_RANK.get(appliedEffort) >= EFFORT_RANK.get('high')) {
      turn.deepReasoningFloorPending = false;
    }
    if (!fallback && repeatedFailureFloor) {
      if (EFFORT_RANK.get(appliedEffort) >= EFFORT_RANK.get(repeatedFailureFloor)) {
        turn.repeatedFailureFloorPending = false;
      } else {
        turn.repeatedFailureFloorPending = true;
      }
    }
    turn.effort = appliedEffort;
    turn.windowGenerations = classifyWindow(classifierResult, turn.windowGenerations ?? config.windowGenerations);
    turn.decisionGeneration = turn.modelRequests;
    const firstApplication = turn.appliedGeneration === 0;
    if (!previousEffort || previousEffort !== appliedEffort) {
      turn.appliedGeneration = turn.modelRequests;
      turn.progressAtApplication = turn.progressTotal;
    }
    else if (!turn.appliedGeneration) turn.appliedGeneration = turn.modelRequests;
    if (firstApplication || !previousEffort || previousEffort !== appliedEffort) {
      turn.failureTotalAtApplication = turn.failureTotal;
    }
    turn.lastDecisionReason = reason;
    turn.lastFallback = fallback;
    turn.lastDecisionBatchId = request._routingBatchId ?? null;
    session.lastEffort = appliedEffort;
    const decisionReason = fallback
      ? `${reason}:${fallbackReason}`
      : held ? `${reason}:minimum_hold` : reason;
    const receipt = {
      schema: ROUTING_STATE_SCHEMA,
      sessionId: session.sessionId,
      turnId: turn.turnId,
      logicalRequestId,
      effort: appliedEffort,
      appliedEffort,
      recommendedEffort,
      classifierRecommendedEffort: recommendation,
      policyFloor,
      policy_floor: policyFloor,
      previousEffort,
      reason: decisionReason,
      decisionReason,
      decision_reason: decisionReason,
      applied_effort: appliedEffort,
      evidence: [...evidence, ...policyEvidence, ...(held ? ['minimum_hold'] : [])].slice(0, config.maxEvidenceItems),
      latencyMs,
      decision_time_ms: latencyMs,
      fallback,
      classified: true,
      reused: false,
      modelRequestNumber: turn.modelRequests,
      window: {
        generations: turn.windowGenerations,
        requestsSinceDecision: 0,
      },
      hooksObserved: turn.hooksObserved,
      integration: integrationStatus(turn, request.integration),
      unsupportedPaths: [...turn.unsupportedPaths].slice(0, 16),
      classifier: classifierResult && typeof classifierResult === 'object'
        ? { taskClass: truncate(classifierResult.task_class ?? classifierResult.taskClass ?? '', 80), confidence: classifierResult.confidence ?? null }
        : null,
    };
    const decisionEvent = {
      ...receipt,
      eventType: 'decision',
      recommendedEffort,
      appliedEffort,
      latencyMs,
    };
    await emitDecision(decisionEvent);
    const storedResult = { effort: appliedEffort, receipt };
    turn.requests.set(logicalRequestId, storedResult);
    while (turn.requests.size > config.maxRequestsPerTurn) turn.requests.delete(turn.requests.keys().next().value);
    return storedResult;
  }

  async function select(input = {}) {
    if (closed) throw new Error('routing engine is closed');
    const request = input && typeof input === 'object' ? input : { prompt: text(input) };
    const sessionId = resolveSessionId(request);
    const turnId = resolveTurnId(request);
    const logicalRequestId = resolveLogicalRequestId({ ...request, sessionId, turnId });
    const currentTime = timestamp(now);
    prune(currentTime);
    const { session, turn } = getTurn(sessionId, turnId, currentTime);
    const identity = stateKey(sessionId, turnId);
    const normalizedRequest = { ...request, sessionId, turnId, logicalRequestId };
    // A retry returns before event consumption so queued hook events cannot
    // change a frozen effort for the logical request being retried.
    if (turn.requests.has(logicalRequestId)) return resultFor(turn, turn.requests.get(logicalRequestId), normalizedRequest);
    if (turn.pending.has(logicalRequestId)) return turn.pending.get(logicalRequestId);
    if (!turn.enqueueBatchId) {
      turn.enqueueBatchId = randomUUID();
      queueMicrotask(() => {
        turn.enqueueBatchId = null;
      });
    }
    normalizedRequest._routingBatchId = turn.enqueueBatchId;
    const run = turn.queue.then(
      () => performSelection(normalizedRequest, session, turn, logicalRequestId, currentTime),
      () => performSelection(normalizedRequest, session, turn, logicalRequestId, currentTime),
    );
    turn.queue = run.catch(() => {});
    turn.pending.set(logicalRequestId, run);
    const cleanup = () => { if (turn.pending.get(logicalRequestId) === run) turn.pending.delete(logicalRequestId); };
    run.then(cleanup, cleanup);
    void identity;
    return run;
  }

  function reset({ sessionId, turnId } = {}) {
    if (sessionId == null) {
      sessions.clear();
      seenEventFiles.clear();
      return;
    }
    const session = sessions.get(text(sessionId));
    if (!session) return;
    if (turnId == null) sessions.delete(text(sessionId));
    else {
      session.turns.delete(text(turnId));
      if (session.turns.size === 0) session.lastEffort = null;
    }
  }

  async function close() {
    closed = true;
    sessions.clear();
    seenEventFiles.clear();
  }

  return Object.freeze({
    select,
    reset,
    close,
    snapshot: () => [...sessions.values()].map(session => ({
      sessionId: session.sessionId,
      touchedAt: session.touchedAt,
      lastEffort: session.lastEffort,
      turns: [...session.turns.values()].map(turn => ({
        turnId: turn.turnId,
        effort: turn.effort,
        modelRequests: turn.modelRequests,
        decisionGeneration: turn.decisionGeneration,
        appliedGeneration: turn.appliedGeneration,
        failureStreak: turn.failureStreak,
        failureTotal: turn.failureTotal,
        failureTotalAtApplication: turn.failureTotalAtApplication,
        repeatedFailureFloorPending: turn.repeatedFailureFloorPending,
        deepReasoningFloorPending: turn.deepReasoningFloorPending,
        recentOutcomes: turn.recentOutcomes.map(compactOutcome),
      })),
    })),
    policy: Object.freeze({ ...config }),
  });
}

export default createRoutingEngine;
