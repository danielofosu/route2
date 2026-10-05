# Developer and migration notes

For user installations on macOS, use the
[automatic Codex setup](AUTOMATIC_CODEX.md). The supported workflow is to select
Route2 and write normal prompts.

## Internal tools

The Rust CLI provides `validate`, `info`, `tiers`, `diagnostics` and task classification for
policy inspection, diagnostics and automated tests. Its stdio MCP transport is
used internally by the provider classifier. It is not a separate Codex setup.

`scripts/serve_proxy.mjs` is the service entry point managed by the installer.
`scripts/route2_codex.mjs`, the hook fixtures, and the command helpers in
remain for development fixtures. They are not supported end-user launchers.

## Migration from v0.1.0

- The supported product is now macOS + Codex only. Windows Task Scheduler,
  Linux systemd, Windows command shims and cross-platform release support are
  removed. Frozen benchmark records and Linux-only official scorers remain
  historical evaluation tooling, not supported product integrations.

- Decision 2.0 is the only supported runtime backend. Migrate legacy `backend: kev`
  policies to `backend: decision` with a `decision` configuration based on
  `config/route2.json`. The obsolete model launcher and repository cloning path
  are removed; `jev` and `rules` policies are also unsupported.
- Runtime overrides now use `ROUTE2_CLASSIFIER_*`, replacing `ROUTE2_KEV_*`.
  Rust callers use `ClassifierConfig`, `ClassifierManager` and the corresponding
  `classifier_manager`/`ensure_classifier_running`/`stop_classifier` methods.
  Reinstall the user service after migrating configuration.
- The coding target is GPT-6.1 Sol, with tier-to-effort mappings and generation
  windows. The earlier per-tier model roster is not the configuration contract.
- Historical `.route2/rules.json` fixtures do not override classification.
- Classification failures produce no actionable recommendation. The automatic
  provider retains the last valid effort or uses high on an initial failure.
- Use `route2 validate`, `route2 info` and `route2 tiers --pretty` to inspect
  policies. Old API-key and `ROUTE2_BACKEND=rules` instructions do not apply.

The previous advisory plugin and manual host configuration examples have been
removed. Remove an old Route2 MCP entry or plugin from Codex if it is still
installed, then follow the automatic installer once.

## Check both Codex clients

`tests/codex_clients_test.mjs` is an opt-in compatibility check with a real
Codex executable and its matching account model catalog. All inference goes to
a temporary loopback upstream with a fixture classifier. No user configuration,
credentials, background services or paid model calls are used.

Set `ROUTE2_CODEX_BIN` to a native macOS Codex executable and
`ROUTE2_CODEX_CATALOG` to its `models_cache.json`, then run:

```sh
node --test tests/codex_clients_test.mjs
```

Use the desktop app's bundled executable to check the app-server version it
ships, and rerun with a separately installed CLI when the versions differ. The
checks verify a flag-free CLI completion, the app's model-selector data and
default provider, and an app-server initial request plus follow-up. Every
forwarded request must target Sol with the fixture's chosen effort. These checks
cover the app backend; the visible app model picker must be checked after a
restart on macOS.
