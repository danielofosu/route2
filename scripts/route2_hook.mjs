import { normalizeHookEvent, publishEvent } from './routing_state.mjs';

// PostToolUse is an outcome signal, never a permission decision. This command
// emits no model-facing feedback and never calls the classifier.
const index = process.argv.indexOf('--event-dir');
const directory = index >= 0 ? process.argv[index + 1] : process.env.ROUTE2_HOOK_EVENT_DIR;
try {
  const chunks = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    length += chunk.length;
    if (length > 1024 * 1024) throw new Error('hook payload exceeds bound');
    chunks.push(chunk);
  }
  const raw = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!directory) throw new Error('event directory unconfigured');
  await publishEvent(directory, normalizeHookEvent(raw));
} catch {
  // An unavailable observer must not change tool permissions or execution.
  process.stderr.write('[Route2] Hook event unavailable; routing may use prompt-only evidence.\n');
}
