# Architecture

`route2` is a macOS-only local provider for Codex CLI and the Codex app, with a Rust classifier CLI and internal stdio MCP transport. It sends a bounded task summary through a loopback System One HTTP adapter, assesses the reasoning difficulty of the next step, and maps the selected tier to reasoning effort and a generation hold window. The classifier's confidence is an uncalibrated score; it is recorded for inspection and is not a probability guarantee.

The default backend is `decision`, configured under `decision` in `config/route2.json`. Decision 2.0 Kai 0.6B uses revision `cd49ea3813fd8ba0928a9a23ef6c9a0f2f0cd764`. `scripts/decision_server.py` loads the package's native runtime, which verifies package files and model identity.

The lifecycle manager is `ClassifierConfig`/`ClassifierManager` in `src/classifier.rs`. Decision 2.0 is the only supported backend, including when the backend field is omitted. Default model and launch arguments use the pinned Decision adapter; no legacy repository checkout or model download path remains. `{route2_source_dir}` resolves to the build checkout or `ROUTE2_SOURCE_DIR`. Runtime overrides use `ROUTE2_CLASSIFIER_ENDPOINT`, `ROUTE2_CLASSIFIER_CMD`, `ROUTE2_CLASSIFIER_ARGS`, `ROUTE2_CLASSIFIER_IDLE_TIMEOUT_SECS` and `ROUTE2_CLASSIFIER_STARTUP_TIMEOUT_MS`.

The classifier server starts listening after model initialization. Managed child trees are stopped on manager teardown and an explicitly configured idle timeout; the default timeout is zero (keep warm). macOS launchers run in a separate owned process group. An already listening external server is used without taking ownership. The lifecycle manager checks TCP connectivity; provider warmup also validates a real inference result. HTTP failure, an unknown tier or invalid confidence yields an error with no recommendation.

Installation prepares the pinned Python dependencies and cached model snapshot before changing Codex's provider. The persistent proxy starts listening independently of classifier readiness and performs a single-flight warmup at startup. Requests during warmup use safe fallback routing immediately. Failed warmup is retried in the background. `/health` includes classifier readiness, while `/status` is a local human-readable loading page. Child diagnostics are streamed to the service log; timestamped transport events separate routing time from upstream time-to-headers and time-to-first-byte without exposing prompts or authentication. No synthetic SSE is injected into coding responses.

## Execution boundary

The only supported host integration is automatic routing in Codex. The default coding target is GPT-6.1 Sol. The Rust CLI and stdio MCP contract provide the internal classifier transport and diagnostic tools; they do not install a separate advisory host integration.

`route2 install-codex --install` runs `scripts/install_codex.py` for persistent
automatic routing. It supervises the proxy as a user service, clones Sol's
account catalog metadata into the Route2 alias, and selects the alias through
user-level Codex configuration. Ordinary prompts then pass through the proxy,
which applies effort before forwarding each applicable model request. The
installer records ownership and backs up configuration so removal can preserve
later user edits. See [automatic Codex setup](AUTOMATIC_CODEX.md).

The tier identifiers remain `small`, `semi_big`, `large` and `safety_sensitive` for policy compatibility. Their default effort mapping is low, medium, high and max. The Rust classifier receives the task objective, current phase, unresolved issue, recent tool outcomes, current effort and requests since reassessment; it chooses the difficulty needed for the next step rather than inferring effort from work type alone. Sol testing does not depend on Astra-only `configuration_update` behavior.

## Adaptive proxy state

`scripts/routing_state.mjs` keeps state per session and turn. A logical request hash freezes the selected effort across transport retries, while a new model request is the unit that advances the generation window. Tool calls do not consume that window. The default policy reassesses after substantive failures, stalled progress, an explicit new user instruction, or window expiry. Routine reads and directory listings are retained as bounded evidence and do not trigger classification by themselves.

The state policy accepts `windowGenerations`, `minimumHold`, `repeatedFailures`, `fallbackEffort`, `ttlMs` and bounded event/session limits (snake_case spellings are accepted as well). `allowDeescalation` (snake_case `allow_deescalation`) independently enables automatic effort decreases and defaults to true. Disabling it keeps the prior effort even after verified routine progress, including across turns. `repeatedFailureEscalation` independently controls the repeated-failure floor. `minimumHold` limits rapid effort changes; the window controls how many model requests can reuse a decision. A classifier failure retains the last valid effort and uses high when no valid decision exists. Every decision receipt records the trigger, evidence, latency, applied effort, fallback status, request identity and unsupported integration paths.

## Hooks and trust boundary

`scripts/route2_hook.mjs` reads a host hook payload from standard input, keeps only a compact outcome signal, and atomically publishes a JSON event keyed by session and turn. `PostToolUse` supplies outcome evidence. `UserPromptSubmit` can identify the active turn but is only a prompt signal; it never grants permission or directly selects an effort. `PreToolUse` remains the host's permission path and is not used for effort selection. Hook writes use a private event directory with bounded payloads; a failed observer does not block or alter tool execution.

`scripts/route2_codex.mjs` and `scripts/serve_proxy.mjs` accept `--hook-events DIR` and `--routing-policy JSON`, with `ROUTE2_HOOK_EVENT_DIR` and `ROUTE2_UPSTREAM_URL` available for the corresponding environment values. The historical benchmark launcher and hook example are retained for benchmark reproducibility, not as user installation paths. The automatic provider observes Responses tool outcomes without requiring hook setup. Hooks never bypass Codex's normal trust or approval review. Supplying an event directory only enables the integration path; it does not prove that the host accepted or ran a hook. Receipts must be read for unsupported paths and missing stable identity.

When the event directory is absent or a stable session identity is unavailable, the proxy reports prompt-only routing. It can still use a fresh user prompt and tool results included in the current Responses continuation, but it cannot safely associate asynchronous hook events with a conversation. A configured directory alone does not prove that the host accepted or ran its hooks, so receipts must be checked for unsupported paths and observed outcomes. The proxy does not classify each routine hook event and does not infer failure from a nonzero command exit alone; expected search misses and other neutral outcomes remain neutral.

## Telemetry and privacy

Routing event logs omit raw task text unless explicitly enabled. CLI benchmark traces can contain issue text, commands and repository content; generated runs stay under ignored `target/verified`. No prompt-cache guarantee or measured improvement follows from this architecture.
