# Automatic Route2 in Codex CLI and the app

The automatic experience is a model selection: **Route2**. With that model
selected, write ordinary coding requests. A local provider proxy classifies the
request and applies the reasoning effort to GPT-6.1 Sol before forwarding it.
There is no skill invocation in the coding workflow.

## Fresh installation on macOS

Route2 supports Codex CLI and the Codex app on macOS 14 or later with Apple
Silicon. Install Git, Rust stable, Node.js 24+, `uv` and curl on your PATH.

Install Codex CLI or the Codex app and sign in with ChatGPT. Start either
client once so it fetches the account model catalog containing GPT-6.1 Sol.
For CLI-only installations, use `codex login`, then open `codex` once. Route2 copies that model's metadata into
its own selectable entry and preserves the other models.

From your terminal, replacing `<repository-url>` with the clone URL of this
repository (private repositories also require Git authentication):

```sh
git clone <repository-url> route2
cd route2
cargo install --path . --locked
route2 install-codex --install
```

For an existing checkout, update and reinstall both the CLI and provider:

```sh
git pull --ff-only origin main
cargo install --path . --locked --force
route2 install-codex --install
```

Reinstallation updates the service configuration and prepares any changed
classifier dependencies or weights before activation. Fully quit and reopen
Codex afterward. If `route2` is not found, add Cargo's binary directory to PATH
or open a new terminal. The equivalent source-checkout command is
`cargo run --locked -- install-codex --install`.

## Use the same installation in both clients

The installer writes user-level `config.toml`, the Route2 model catalog, and a
background provider. Both the native CLI and the app read those same settings.
There is no separate app plugin or CLI wrapper to install.

| Client | After installation |
| --- | --- |
| Codex CLI, interactive | Start a new `codex` session and type the task normally. `/status` shows the active model and provider. |
| Codex CLI, noninteractive | Run `codex exec "your task"`. The installed defaults apply without `-m`, `-c` or a Route2 launcher. |
| Codex app | Fully quit and reopen the app, then start a new chat. Route2 appears in its model picker and is the installed default. |

Existing chats or resumed CLI sessions may retain their earlier model choice.
Use a new chat/session, or select Route2 in that client. Selecting a concrete
model bypasses routing; named configuration profiles and explicit model/provider
overrides can also override the installed defaults.

Both clients must use the same Codex home (normally `~/.codex`). A custom
`CODEX_HOME` or another Mac is a separate configuration environment; install
Route2 in that environment too.

Keep the checkout in place while installed: the service uses its proxy scripts
and classifier assets. Setup prepares the pinned Python environment and model
weights before switching Codex to Route2, then waits for a successful classifier
warmup. This preparation can take several minutes on a fresh machine and prints
progress in the setup terminal. Dependencies and weights are not yet bundled
in a standalone release: setup downloads them once, outside the prompt path.
A GPU is optional.

The service warms the classifier as soon as it starts, rather than waiting for
the first coding prompt. Model weights are read from the local cache during
normal runtime. The default idle timeout is disabled (`idle_timeout_secs: 0`):
the model stays in memory until service shutdown. Set a nonzero timeout in a
custom policy, or `ROUTE2_CLASSIFIER_IDLE_TIMEOUT_SECS` at install time, to trade memory for cold starts.

Open `http://127.0.0.1:10509/status` to see loading stages, readiness, errors,
and startup elapsed time (use the installed port if customized). `/health`
also reports `classifier.state` for machine-readable checks. Requests received
while startup is in progress use the existing fallback effort immediately;
they do not wait for the model to load. The service retries failed warmup in
the background. Startup status cannot replace Codex's own "Thinking" indicator,
and the proxy does not inject synthetic events into the coding response stream.

## macOS menu bar

macOS setup also builds and starts a lightweight native companion with a
monochrome octopus icon and a status indicator. It shows classifier readiness,
loading, fallback routing, or a stopped/unresponsive service—not the coding
model's thinking. Older services show "Running (legacy status)" rather than
claiming the classifier is ready.

- **Start Route2:** enables and starts the installed service.
- **Restart Route2:** restarts the service and warms the classifier again.
- **Stop Route2:** stops the service; the menu-bar icon disappears with it.
- **Quit Route2:** stops the service, then removes the menu-bar icon. If stopping
  fails, the app reports an error and stays visible rather than claiming success.
- **Open Status:** opens the existing local loading/status page.

While the service runs, it keeps the companion open: if the app exits or is
killed, the service relaunches it within a few seconds. Stopping the service
ends that supervision, so the icon hides until the service starts again.

Stop and Quit disable automatic service startup until Start, Restart, or a
successful provider reinstall enables it again. While stopped, Codex requests
using the Route2 provider cannot run; select a concrete provider/model if you
want to work without Route2. Stopping or restarting can interrupt active requests.

The companion appears at login, without a Dock icon. Reopen it with
`route2 menu-bar`, or open `Route2 Menu.app` inside your Codex home, then choose
Start. Opening the companion alone does not start a deliberately stopped service.
Only one instance runs at a time; extra launches exit silently.

The optional companion is prebuilt in release packages. From a source checkout
it requires the local Swift compiler (Xcode Command Line Tools); setup warns and
leaves the routing service usable if compilation is unavailable.
`route2 install-codex --install --no-menu-bar` skips it, and the service accepts
the same flag to run without the companion. `route2 menu-bar --uninstall`
removes only the companion and its login item; full provider uninstall removes
both. Install/removal preserves unowned or user-edited files. The app polls
loopback health only and does not read prompts or credentials.

## Preview, custom paths and removal

Run `route2 install-codex` to preview setup without changing files. `--node`
and `--router` accept explicit executable paths. `--uv` and `--curl` can select
classifier dependencies outside PATH. `--codex-home` supports a
custom Codex home. Normal ChatGPT sign-in uses the built-in ChatGPT upstream;
custom provider configurations require an explicit `--upstream`.

```sh
route2 install-codex --uninstall
```

Uninstall removes owned settings and the service. It preserves unrelated user
configuration and reports conflicts when installer-owned values have changed.
Restart Codex afterward.

```text
Install once → restart Codex → Route2 selected
                                  ↓
                         "Fix the parser bug"
                                  ↓
                    local classification + effort
                                  ↓
                         GPT-6.1 Sol does the work
```

## Troubleshooting a fresh machine

Run `route2 diagnostics` on that machine for a read-only JSON report of the
installed provider, local classifier health, log location, and recent applied
model/effort decisions with timing. For one chat, use
`route2 diagnostics --session SESSION_ID`. It does not send coding requests,
prepare model assets, or include prompts and credentials. Missing logs are
reported as missing evidence, not successful routing. `--codex-home` and
`--port` support non-default installations.

Codex session logs record the `route2-router` alias and the client's requested
effort before the proxy rewrites the request. They confirm Route2 selection,
not the downstream applied effort. Use the service's request receipts and
transport timing to verify the latter.

- **No model catalog or Sol entry:** open authenticated Codex once, wait for its
  model list, then rerun the installer. Route2 does not invent account metadata.
- **Missing Node, uv or curl:** install the prerequisite, open a new terminal,
  and rerun setup. `--node` can select a Node executable outside PATH.
- **Provider connection error:** inspect `route2-service.stderr.log` in the
  Codex home and check that the platform's user service is running. The proxy
  must be available for Codex to send requests through Route2.
- **Classification fallback:** the proxy keeps prior effort, or uses high for
  an initial failure. Check `/status` and the same log for classifier startup
  errors. If cached model weights or dependencies are missing, rerun
  `route2 install-codex --install` with a working download connection.
- **Slow first output:** startup logs identify model loading, while timestamped
  transport events separate `routing_ms` from `upstream_ms` at response headers
  and first response bytes. A warm classifier does not eliminate coding-model
  reasoning or provider/network delays.
- **Moved or deleted checkout:** restore it to its installed path, or uninstall
  and reinstall from the new location. The service has absolute runtime paths.

## What the installer supplies

- A background service for the local Responses proxy, started at login and
  restarted by the operating system when it exits.
- A Codex model catalog containing Route2 and the existing account models.
- User-level provider settings pointing Codex at the loopback proxy, with
  Route2 selected by default.
- A backup and installation record for removing the Route2 settings later.

The macOS service uses launchd. It starts immediately during setup and its
installation health identity is checked before Codex settings are committed.

Codex continues to supply its existing authentication. Route2 does not create a
key or save provider credentials. Selecting a concrete model instead of Route2
bypasses classification; its requests pass through the proxy unchanged.

## Automatic routing and hooks

The provider applies effort at each applicable request boundary and observes
Responses tool outcomes directly. Automatic routing does not require installing
or invoking a skill, MCP plugin or hook. Internal hook adapters remain for
benchmark reproducibility and supplemental evidence; they do not set the
active model or reasoning effort.

The previous advisory plugin, manual MCP setup and one-task user launchers are
no longer supported installation paths. Existing installations of that plugin
or an old Route2 MCP entry should be removed from Codex before testing the new
workflow.

## Verification and limits

Codex CLI 0.160.0's app-server returned Route2 as a visible default model from
an isolated configuration with a custom catalog and provider. That checks the
backend used to supply the model picker; it is not a visual check of a restarted
desktop app.

The proxy's fixture tests check ordinary prompts, follow-up instructions,
continuations, retries, model bypass, authentication forwarding and streaming.
A real Codex CLI 0.160.0 process also sent an ordinary coding prompt through a
local fixture proxy: the classifier ran once and the forwarded request selected
GPT-6.1 Sol with medium effort, without a skill invocation. This used a mock
classifier and a local test upstream, not a live model completion.
The installed macOS service completed ordinary, ephemeral requests from both
Codex CLI and the desktop app's bundled app-server using the existing ChatGPT
sign-in and real upstream. Both used the installed default model/provider.
Route2's real local classifier selected low effort without a fallback, and the
live model returned each requested answer without a skill invocation.

The opt-in `tests/codex_clients_test.mjs` also checks a real CLI completion and
an app-server initial request plus follow-up against a loopback test upstream.
It verifies the app's model-selector data lists Route2 as the default and keeps
Sol available. It was run successfully with the desktop-bundled Codex 0.160.0
executable. A separately installed CLI with another version should be checked
separately. See [how to run those checks](HARNESS_GUIDE.md#check-both-codex-clients).
These backend checks do not replace a visual check of the restarted app.
Normal installation now prepares the classifier cache and verifies warmup
before enabling routing. If classification fails or the service is still
warming up after a restart, the proxy keeps the prior effort, or uses high for
the first request, and reports a fallback. If the proxy service is unavailable,
Codex reports a provider connection error.

Official Codex documentation describes
[custom model catalogs and desktop restart](https://learn.chatgpt.com/docs/enterprise/roll-out-a-gateway),
[user-level provider configuration](https://learn.chatgpt.com/docs/config-file/config-advanced),
and [hook input/output](https://learn.chatgpt.com/docs/hooks).
