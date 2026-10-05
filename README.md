# route2

[![CI](https://github.com/danielofosu/route2/actions/workflows/ci.yml/badge.svg)](https://github.com/danielofosu/route2/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Rust: 2021](https://img.shields.io/badge/rust-2021-orange.svg)](Cargo.toml)

<p align="center">
  <img src="assets/route2-banner.png" alt="route2 mechanical octopus banner">
</p>

**Automatic reasoning-effort routing for Codex CLI and the Codex app on macOS.**

Select **Route2** in Codex and write an ordinary coding request. A small local
[Decision 2.0 Kai 0.6B](https://huggingface.co/vllm-sr/Decision-2.0-Kai-0.6B) classifier chooses the reasoning effort for GPT-6.1 Sol,
and the background provider applies it automatically. Route2 is selected by
default after installation. No skill invocation or per-task command is needed.

```text
Your normal Codex prompt → Route2 chooses effort → Sol does the work
```

![Route2 selected in the Codex app](assets/route2-codex-app.png)

Route2 in the Codex app’s model selector. Write a normal coding prompt; the
local provider handles effort routing automatically.

## Fresh installation

**Release package (macOS on Apple Silicon):** download the latest
`route2-*-macos-arm64.tar.gz` from
[Releases](https://github.com/danielofosu/route2/releases), extract it, and from the
extracted directory run `bin/route2 install-codex --install`. The binary finds its
scripts relative to itself; keep the extracted directory in place, because the
background service uses its scripts and classifier assets.

**From source:** install Git, Rust stable, Node.js 24+, [uv](https://docs.astral.sh/uv/getting-started/installation/)
and curl on macOS 14 or later with Apple Silicon.
Install Codex CLI or the Codex app, sign in with ChatGPT, and start it once
so its account model catalog is available. Then run these commands in a terminal, replacing `<repository-url>` with this repository's clone URL:

```sh
git clone <repository-url> route2
cd route2
cargo install --path . --locked
route2 install-codex --install
```

Restart the Codex app or start a new CLI session. Both use the installed
Route2 default: run `codex` or `codex exec "your task"`, or start a new app chat
with **Route2** selected. Keep this checkout in place: the background service uses its
scripts and classifier assets. To remove it, run
`route2 install-codex --uninstall` and restart Codex.

[The installation guide](docs/AUTOMATIC_CODEX.md) covers prerequisites,
the macOS service, custom paths, troubleshooting and removal. This is the sole
supported Codex integration. The CLI and internal MCP transport remain for
classification, development and benchmarks; they are not additional Codex setup
paths.

## macOS and models

| Component | Support | Notes |
| --- | --- | --- |
| Codex CLI and app | Automatic local provider | Uses your existing Codex ChatGPT sign-in; selects the Route2 model entry. |
| macOS | Apple Silicon, macOS 14+ | Background service uses launchd. The supported local installation requires Apple Silicon. |
| Coding model | `gpt-6.1-sol` | Route2 currently chooses Sol's reasoning effort. Other models are not routing targets. |
| Local classifier | [`vllm-sr/Decision-2.0-Kai-0.6B`](https://huggingface.co/vllm-sr/Decision-2.0-Kai-0.6B), revision `cd49ea3…` | CPU inference by default; setup prepares model weights and Python dependencies before enabling routing. |

Allow several minutes and enough disk space for initial setup, which prints
dependency and model preparation progress. The service warms the classifier at
startup and keeps it loaded by default; prompts during warmup use fallback
routing instead of waiting. Open `http://127.0.0.1:10509/status` for live loading
status (or your configured port). The adapter materializes a real-file cache
because its package rejects symlinked Hugging Face snapshots; this is handled
automatically. Classification stays local; coding requests go to the existing
provider. See the installation guide for offline caches and optional idle shutdown.

On macOS, setup also adds a small octopus menu-bar companion with running/loading
status and Start, Restart, Stop, and Quit controls. The companion appears
automatically whenever the Route2 service is running, and the service relaunches
it if it exits. Quit stops Route2 and hides the icon. Use `route2 menu-bar` to
install or reopen it without reinstalling the provider; `--no-menu-bar` skips it
during setup, and the service accepts the same flag to run without the companion.

## Tiers and decision contract

| Tier | Sol reasoning effort | Suggested generation window |
| --- | --- | ---: |
| `small` | low | 5 |
| `semi_big` | medium | 2 |
| `large` | high | 1 |
| `safety_sensitive` | max | 1 |
| `decision` | low | 5 |

Decisions include task class, target model, recommended effort, generation window, confidence, rationale, provenance and request/event IDs. Use `route2 tiers --pretty` to inspect the active mapping. `--detail compact` reduces response detail; `--report-time` includes decision latency; `--timeout` overrides the inference request timeout.

The provider proxy assesses next-step difficulty from a bounded objective and tool-outcome summary. It reassesses on new instructions, substantive failures, stalled progress and expired model-request windows. Conservative hold and progress rules control changes; transport retries reuse the original choice. Optional PostToolUse hooks publish session-and-turn-scoped events before the next request. Without observed hooks it records prompt-only operation. Explicit concrete model selections pass through. Confidence is uncalibrated. See the [architecture and routing limits](docs/ARCHITECTURE.md).

## Configuration and compatibility

Policy lookup order is explicit `--config`, `ROUTE2_CONFIG`, workspace `.route2/config.json` or `.route2.json`, user `~/.route2/config.json`, then the embedded policy. `route2 info` shows the active backend and configuration source. Event logs omit task text unless you explicitly enable it.

This development version changes the v0.1 behavior: Decision 2.0 is the only runtime backend, with one target model and effort selection. Legacy backend policies and the old deterministic rules backend are no longer supported. The checked-in historical rules are not an active routing layer. An unavailable or invalid classification returns `task_class: error` with no actionable recommendation. The provider proxy retains the prior effort, or uses high for an initial failure, and reports a fallback. Use `route2 diagnostics` to inspect recent applied decisions and timing. See [developer and migration notes](docs/HARNESS_GUIDE.md).

## Benchmarks

The official SWE-bench Verified pilot resolved one task in each arm. It is not a full benchmark score.

The completed comparison uses **164 HumanEval+ tasks**, identical public prompts, GPT-6.1 Sol and one completion per task. The fixed-high baseline **without Route2** is reused unchanged from the previous run; only corrected Route2 generated new answers. Both were scored with official EvalPlus 0.3.1 full base and expanded tests in the official scoring environment.

| Run | Full base + expanded passes | Estimated generation cost | Mean end-to-end time |
| --- | ---: | ---: | ---: |
| Previous fixed high, without Route2 | 156/164 (95.1%) | $0.249572 | 5.97 s |
| Corrected Route2 | 157/164 (95.7%) | $0.211472 | 8.39 s |

In this run, Route2 used **15.3% less estimated generation cost** and took **40.5% longer**, including local classification. It passed every task the baseline passed, plus one additional task. Route2 selected medium on 151 tasks and low on 13, with no classifier fallbacks. The first classifier request took 24.10 s; subsequent requests averaged 1.17 s.

These are observed results from one completion per task, not evidence of general quality equivalence or a guaranteed savings rate. The 95% Wilson intervals are 90.7–97.5% for the baseline and 91.5–97.9% for Route2. The baseline and adaptive requests ran at different times, so provider load can affect latency. Cost is an API-equivalent token estimate on an existing subscription, not a subscription charge.

See [benchmark results](docs/benchmarks/results.md). HumanEval is one-shot; the three separate custom repository checks passed their tests and exercised tool outcomes, with no matched fixed-effort comparison.

## Limitations / not yet proven

- One-shot benchmark results; no quality-equivalence or savings guarantee.
- Cost figures are API-equivalent token estimates on a subscription, not bills.
- Product scope is macOS (Apple Silicon) plus the Codex CLI/app only.
- The classifier weights and Python dependencies are downloaded at setup time; they are not bundled into the source checkout.
- Only `gpt-6.1-sol` is a routing target; other models are not routed.
- A failed classification falls back to the prior effort (or high) and is reported, not retried indefinitely.

## Development and validation

```sh
cargo fmt --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
python -m unittest discover -s tests -p "test_*.py"
node --test tests/*_test.mjs
```

Development checks and CI fixtures do not expand product support beyond Codex on macOS. An additional [opt-in client compatibility check](docs/HARNESS_GUIDE.md#check-both-codex-clients) verifies a real CLI and the app backend against a local fixture. Tests exercise lifecycle cleanup, native MCP subprocesses and provider transport with controlled model/upstream fixtures; they make no paid calls. A live classifier requires downloading its weights. Official HumanEval+ scoring uses a separate environment with pinned EvalPlus.

## Documentation and acknowledgments

- [Architecture](docs/ARCHITECTURE.md)
- [Automatic Codex setup](docs/AUTOMATIC_CODEX.md)
- [Developer notes](docs/HARNESS_GUIDE.md)
- [Benchmark results](docs/benchmarks/results.md)

Thanks to the Decision 2.0 authors and Peter Steinberger for the MCP tooling inspiration.

[MIT license](LICENSE). External model packages retain their own licenses.
