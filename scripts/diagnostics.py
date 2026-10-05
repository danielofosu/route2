"""Read-only, credential-free diagnostics for the local Route2 provider."""

import json
import tomllib
import urllib.request
from pathlib import Path


MAX_LOG_BYTES = 512 * 1024
EVENT_FIELDS = (
    "timestamp", "eventType", "sessionId", "turnId", "logicalRequestId",
    "model", "effort", "appliedEffort", "recommendedEffort", "reason",
    "fallback", "classified", "reused", "decision_time_ms", "latencyMs",
    "routing_ms", "upstream_ms", "status",
)


def recent_events(path, session=None, limit=10):
    events = []
    try:
        with Path(path).open("rb") as stream:
            stream.seek(0, 2)
            size = stream.tell()
            stream.seek(max(0, size - MAX_LOG_BYTES))
            if size > MAX_LOG_BYTES:
                stream.readline()
            lines = stream.read(MAX_LOG_BYTES).decode("utf-8", "replace").splitlines()
    except OSError:
        return events
    for line in lines:
        if not line.startswith(("[Route2 request] ", "[Route2 transport] ")):
            continue
        try:
            event = json.loads(line.split("] ", 1)[1])
        except (ValueError, IndexError):
            continue
        if not isinstance(event, dict) or (session is not None and event.get("sessionId") != session):
            continue
        events.append({key: event[key] for key in EVENT_FIELDS
                       if key in event and isinstance(event[key], (str, int, float, bool, type(None)))})
    return events[-limit:]


def collect_diagnostics(codex_home, port=None, session=None, opener=None):
    home = Path(codex_home)
    state = {}
    try:
        parsed = json.loads((home / ".route2-codex-installer.json").read_text())
        if isinstance(parsed, dict):
            state = parsed
    except (OSError, ValueError):
        pass
    service = state.get("service")
    installed_port = service.get("port") if isinstance(service, dict) else None
    selected_port = port if port is not None else installed_port or 10509
    if not isinstance(selected_port, int) or not 1 <= selected_port <= 65535:
        raise ValueError("diagnostic port must be between 1 and 65535")
    log_path = home / "route2-service.stderr.log"
    report = {
        "codex_home": str(home),
        "port": selected_port,
        "status_url": f"http://127.0.0.1:{selected_port}/status",
        "log_path": str(log_path),
        "log_available": log_path.is_file(),
        "health": None,
        "health_error": None,
        "recent_events": recent_events(log_path, session),
        "scope": "Config fields are defaults, not per-chat overrides. Local Route2 receipts show applied routing; Codex session effort is not the downstream decision.",
    }
    try:
        config = tomllib.loads((home / "config.toml").read_text())
        report["configured_provider"] = config.get("model_provider") if isinstance(config.get("model_provider"), str) else None
        report["configured_model"] = config.get("model") if isinstance(config.get("model"), str) else None
    except (OSError, ValueError):
        report["config_available"] = False
    try:
        fetch = opener or urllib.request.urlopen
        with fetch(f"http://127.0.0.1:{selected_port}/health", timeout=2) as response:
            health = json.loads(response.read(8192))
        if not isinstance(health, dict) or health.get("service") != "route2":
            report["health_error"] = "The loopback endpoint did not identify itself as Route2."
        else:
            report["health"] = {key: health[key] for key in ("service", "model", "instanceId")
                                if isinstance(health.get(key), str)}
            classifier = health.get("classifier")
            if isinstance(classifier, dict):
                report["health"]["classifier"] = {
                    key: classifier[key] for key in ("state", "stage", "elapsed_ms", "updated_at")
                    if isinstance(classifier.get(key), (str, int, float))
                }
            else:
                report["classifier_note"] = "This running service does not report classifier readiness; reinstall and restart to activate the updated proxy."
    except (OSError, ValueError):
        report["health_error"] = "Local service is unavailable or returned invalid health data."
    if not report["recent_events"]:
        report["telemetry_note"] = "No matching decisions in the bounded log tail; timing and downstream effort cannot be verified from this report."
    return report
