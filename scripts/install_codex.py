#!/usr/bin/env python3
"""Install Route2 as Codex's persistent automatic-routing provider.

The installer intentionally uses only the Python standard library.  It edits
Codex's TOML as text after parsing it with ``tomllib`` so comments and
unrelated user configuration remain intact.  A small ownership record lets
uninstall restore only lines and files which are still exactly as the
installer wrote them.

This module is also useful as a library for fixture tests.  The service
manager accepts an injected command runner and health checker; tests therefore
never need to touch a user's real service manager.
"""

from __future__ import annotations

import argparse
import dataclasses
import hashlib
import json
import os
import platform
import plistlib
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import tomllib
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping, Sequence

try:
    from .macos_menu_bar import MenuBarError, install_menu_bar, uninstall_menu_bar
    from .diagnostics import collect_diagnostics
    from .decision_server import (
        DEFAULT_CACHE_ROOT,
        MODEL as DECISION_MODEL,
        PINNED_DEPENDENCIES,
        classifier_progress,
    )
except ImportError:
    from macos_menu_bar import MenuBarError, install_menu_bar, uninstall_menu_bar
    from diagnostics import collect_diagnostics
    from decision_server import (
        DEFAULT_CACHE_ROOT,
        MODEL as DECISION_MODEL,
        PINNED_DEPENDENCIES,
        classifier_progress,
    )


ROOT = Path(__file__).resolve().parents[1]
SERVE_PROXY = ROOT / "scripts" / "serve_proxy.mjs"
SENTINEL = "route2-router"
MODEL = "gpt-6.1-sol"
DEFAULT_PORT = 10509
DEFAULT_CHATGPT_UPSTREAM = "https://chatgpt.com/backend-api/codex"
DEFAULT_DECISION_ENDPOINT = "http://127.0.0.1:8009/v1/systemone"
CLASSIFIER_READY_TIMEOUT = 900.0
STATE_FILE_NAME = ".route2-codex-installer.json"
CATALOG_FILE_NAME = "route2-models.json"
SERVICE_LABEL = "com.route2.codex"


class InstallerError(RuntimeError):
    """A user-actionable installer failure."""


class ConfigConflict(InstallerError):
    """The requested edit would overwrite an unknown user change."""


class CatalogError(InstallerError):
    """The account catalog cannot safely provide the Route2 model."""


class ServiceError(InstallerError):
    """The persistent service could not be installed or started."""


@dataclasses.dataclass(frozen=True)
class Assignment:
    """A single simple TOML assignment line."""

    section: str
    key: str
    index: int
    raw: str

    @property
    def line(self) -> str:
        return self.raw.rstrip("\r\n")


@dataclasses.dataclass
class ConfigEdit:
    """An owned config-line mutation recorded for safe uninstall."""

    section: str
    key: str
    action: str  # ``replace`` or ``insert``
    original_line: str | None
    new_line: str

    def as_dict(self) -> dict[str, Any]:
        return {
            "section": self.section,
            "key": self.key,
            "action": self.action,
            "original_line": self.original_line,
            "new_line": self.new_line,
        }


@dataclasses.dataclass
class ConfigPlan:
    path: Path
    original_text: str
    new_text: str
    edits: list[ConfigEdit]
    changed: bool


@dataclasses.dataclass(frozen=True)
class ServiceSpec:
    node: Path
    router: Path
    upstream: str
    port: int
    repo_root: Path
    codex_home: Path
    instance_id: str
    # A login-independent PATH captured at install time.  The GUI service
    # managers do not inherit the shell which ran the installer, so this must
    # include the directories containing uv and curl.
    path_env: str = ""
    route2_config: Path | None = None
    decision_cache: Path | None = None
    classifier_offline: bool = False
    classifier_overrides: Mapping[str, str] = dataclasses.field(default_factory=dict)


@dataclasses.dataclass
class ServiceInstallResult:
    platform: str
    path: Path | None
    existed: bool
    previous_bytes: bytes | None
    previous_hash: str | None
    new_hash: str | None
    changed: bool
    activated: bool


def _sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _sha256_file(path: Path) -> str:
    return _sha256_bytes(path.read_bytes())


def _json_string(value: str) -> str:
    """Return a TOML basic string using JSON's compatible escaping."""

    return json.dumps(value, ensure_ascii=False)


def _render_replacement(assignment: Assignment, rendered: str, newline: str) -> str:
    """Replace a managed value while retaining a user's inline comment."""

    comment = _inline_comment(assignment.line)
    if comment:
        rendered = f"{rendered}  {comment}"
    return rendered + newline


def _line_ending(lines: Sequence[str]) -> str:
    for line in lines:
        if line.endswith("\r\n"):
            return "\r\n"
        if line.endswith("\n"):
            return "\n"
    return "\n"


_TABLE_RE = re.compile(r"^\s*\[([^\[\]]+)\]\s*(?:#.*)?(?:\r?\n)?$")
_ARRAY_TABLE_RE = re.compile(r"^\s*\[\[([^\[\]]+)\]\]\s*(?:#.*)?(?:\r?\n)?$")
_ASSIGNMENT_RE = re.compile(r"^\s*(?:\"([^\"]+)\"|'([^']+)'|([A-Za-z0-9_-]+))\s*=")
_DOTTED_ASSIGNMENT_RE = re.compile(
    r"^\s*(?:\"([^\"]+)\"|'([^']+)'|([A-Za-z0-9_.-]+))\s*="
)


def _table_header(raw: str) -> tuple[str, bool] | None:
    array = _ARRAY_TABLE_RE.match(raw)
    if array:
        return array.group(1).strip(), True
    table = _TABLE_RE.match(raw)
    if table:
        return table.group(1).strip(), False
    return None


def _assignment_key(match: re.Match[str]) -> str:
    return next(value for value in match.groups() if value is not None)


def _inline_comment(line: str) -> str:
    """Return a TOML comment suffix, honoring quoted strings."""

    quote: str | None = None
    triple = False
    index = 0
    while index < len(line):
        char = line[index]
        if quote is None:
            if line.startswith('"""', index) or line.startswith("'''", index):
                quote = line[index]
                triple = True
                index += 3
                continue
            if char in {'"', "'"}:
                quote = char
                triple = False
                index += 1
                continue
            if char == "#":
                return line[index:].strip()
        elif triple:
            marker = quote * 3
            if line.startswith(marker, index):
                quote = None
                triple = False
                index += 3
                continue
        elif char == quote:
            quote = None
        elif char == "\\" and quote == '"':
            index += 1
        index += 1
    return ""


def _assignments(text: str) -> list[Assignment]:
    """Find simple assignment lines while retaining their original spelling.

    Managed Codex settings are all simple top-level or provider-table keys.
    Dotted assignments and multiline values are deliberately left alone and
    treated as conflicts when they could shadow a managed key.
    """

    result: list[Assignment] = []
    section = ""
    for index, raw in enumerate(text.splitlines(keepends=True)):
        stripped = raw.lstrip()
        if not stripped or stripped.startswith("#"):
            continue
        table = _table_header(raw)
        if table:
            section = f"[[{table[0]}]]" if table[1] else table[0]
            continue
        match = _ASSIGNMENT_RE.match(raw)
        if match:
            result.append(Assignment(section, _assignment_key(match), index, raw))
    return result


def _section_spans(lines: Sequence[str]) -> dict[str, tuple[int, int]]:
    """Return exact-table spans, rejecting duplicate table declarations."""

    starts: list[tuple[int, str]] = []
    for index, raw in enumerate(lines):
        match = _table_header(raw)
        if match:
            section = f"[[{match[0]}]]" if match[1] else match[0]
            starts.append((index, section))
    spans: dict[str, tuple[int, int]] = {}
    for offset, (start, section) in enumerate(starts):
        end = starts[offset + 1][0] if offset + 1 < len(starts) else len(lines)
        if section in spans:
            raise ConfigConflict(f"config has duplicate TOML table [{section}]")
        spans[section] = (start, end)
    return spans


def _read_config(path: Path) -> tuple[str, dict[str, Any]]:
    if not path.exists():
        return "", {}
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as error:
        raise InstallerError(f"cannot read Codex config {path}: {error}") from error
    try:
        data = tomllib.loads(text)
    except tomllib.TOMLDecodeError as error:
        raise InstallerError(f"Codex config is not valid TOML: {path}: {error}") from error
    return text, data


def _assignment_map(text: str, section: str) -> dict[str, list[Assignment]]:
    result: dict[str, list[Assignment]] = {}
    for assignment in _assignments(text):
        if assignment.section == section:
            result.setdefault(assignment.key, []).append(assignment)
    return result


def _single_assignment(text: str, section: str, key: str) -> Assignment | None:
    values = _assignment_map(text, section).get(key, [])
    if len(values) > 1:
        raise ConfigConflict(f"config has duplicate key {key!r} in [{section}]" if section else f"config has duplicate top-level key {key!r}")
    return values[0] if values else None


def _reject_ambiguous_spellings(text: str) -> None:
    """Fail closed for TOML spellings the line editor cannot preserve safely."""

    top_keys = {"model", "model_provider", "model_catalog_json"}
    provider_keys = {
        "name",
        "base_url",
        "wire_api",
        "requires_openai_auth",
        "supports_websockets",
    }
    section = ""
    for raw in text.splitlines(keepends=True):
        header = _table_header(raw)
        if header:
            if header[1] and header[0] == "model_providers.route2":
                raise ConfigConflict(
                    "config uses [[model_providers.route2]]; refusing to merge an array table"
                )
            section = f"[[{header[0]}]]" if header[1] else header[0]
            continue
        match = _DOTTED_ASSIGNMENT_RE.match(raw)
        if not match:
            continue
        key = _assignment_key(match)
        if "." in key:
            first = key.split(".", 1)[0]
            if not section and (first in top_keys or key.startswith("model_providers.route2.")):
                raise ConfigConflict(
                    f"config uses dotted assignment {key!r}; refusing to duplicate it"
                )
            continue
        if (not section and key in top_keys) or (
            section == "model_providers.route2" and key in provider_keys
        ):
            value = raw.split("=", 1)[1]
            if '"""' in value or "'''" in value:
                raise ConfigConflict(
                    f"managed key {key!r} uses a multiline TOML string; edit it explicitly first"
                )


def _toml_value(data: Mapping[str, Any], section: str, key: str) -> Any:
    if not section:
        return data.get(key)
    current: Any = data
    for part in section.split("."):
        if not isinstance(current, Mapping):
            return None
        current = current.get(part)
    return current.get(key) if isinstance(current, Mapping) else None


def _config_catalog_source(config: Mapping[str, Any], codex_home: Path) -> Path:
    configured = config.get("model_catalog_json")
    if configured is None:
        return codex_home / "models_cache.json"
    if not isinstance(configured, str) or not configured.strip():
        raise CatalogError("model_catalog_json must be a non-empty path")
    path = Path(configured).expanduser()
    if not path.is_absolute():
        path = codex_home / path
    return path.resolve()


def add_router_model(catalog: Mapping[str, Any]) -> dict[str, Any]:
    """Clone GPT-6.1 Sol into a catalog exactly like router_proxy.mjs."""

    if not isinstance(catalog, Mapping):
        raise CatalogError("model catalog must be a JSON object")
    models = catalog.get("models")
    if not isinstance(models, list):
        raise CatalogError("model catalog has no models array")
    template = next((model for model in models if isinstance(model, Mapping) and model.get("slug") == MODEL), None)
    if template is None:
        raise CatalogError(f"model catalog does not contain required {MODEL!r}")
    if any(isinstance(model, Mapping) and model.get("slug") == SENTINEL for model in models):
        return dict(catalog)
    clone = dict(template)
    clone.update(
        {
            "slug": SENTINEL,
            "display_name": "Route2",
            "description": "Decision 2.0 chooses reasoning effort for GPT-6.1 Sol.",
            "visibility": "list",
            "supported_in_api": True,
            "priority": 0,
            "upgrade": None,
        }
    )
    result = dict(catalog)
    result["models"] = [clone, *models]
    return result


def load_catalog(source: Path) -> tuple[dict[str, Any], str]:
    if not source.is_file():
        raise CatalogError(f"model catalog not found: {source}")
    try:
        catalog = json.loads(source.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise CatalogError(f"cannot read model catalog {source}: {error}") from error
    return add_router_model(catalog), source.read_text(encoding="utf-8")


def resolve_codex_home(value: str | os.PathLike[str] | None = None) -> Path:
    selected = value or os.environ.get("CODEX_HOME") or (Path.home() / ".codex")
    return Path(selected).expanduser().resolve()


def _looks_like_path(raw: str) -> bool:
    return raw.startswith((".", "~")) or Path(raw).is_absolute() or "/" in raw


def _tool_candidates(name: str) -> list[Path]:
    home = Path.home()
    directories = [
        home / ".local/bin", home / ".cargo/bin", home / ".volta/bin",
        home / ".nvm/current/bin", Path("/opt/homebrew/bin"),
        Path("/usr/local/bin"), Path("/usr/bin"),
    ]
    return [directory / name for directory in directories]


def _resolve_tool(
    value: str | os.PathLike[str] | None,
    *,
    name: str,
    not_found: str,
    candidates: Iterable[Path] = (),
) -> Path:
    raw = str(value) if value is not None else name
    resolved: Path | None = None
    if _looks_like_path(raw):
        resolved = Path(raw).expanduser()
    else:
        located = shutil.which(raw)
        if located:
            resolved = Path(located)
    if value is None and (resolved is None or not resolved.is_file()):
        for candidate in [*candidates, *_tool_candidates(name)]:
            if candidate.is_file():
                resolved = candidate
                break
    if resolved is None:
        raise InstallerError(not_found)
    resolved = resolved.resolve()
    if not resolved.is_file() or not os.access(resolved, os.X_OK):
        raise InstallerError(f"{name} executable is not usable: {resolved}")
    try:
        completed = subprocess.run(
            [str(resolved), "--version"],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise InstallerError(f"cannot run {name} at {resolved}: {error}") from error
    if completed.returncode != 0:
        detail = completed.stderr.strip() or completed.stdout.strip()
        raise InstallerError(f"cannot query {name} at {resolved}{': ' + detail if detail else ''}")
    return resolved


def resolve_node(value: str | os.PathLike[str] | None = None) -> Path:
    resolved = _resolve_tool(
        value,
        name="node",
        not_found="Node.js 24+ is required; node was not found on PATH or common install locations",
    )
    try:
        completed = subprocess.run(
            [str(resolved), "--version"],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise InstallerError(f"cannot run Node.js at {resolved}: {error}") from error
    match = re.search(r"(?:^|\s)v?(\d+)(?:\.\d+){0,2}", completed.stdout.strip())
    if not match or int(match.group(1)) < 24:
        version = completed.stdout.strip() or completed.stderr.strip() or "unknown"
        raise InstallerError(f"Node.js 24+ is required; found {version}")
    return resolved


def resolve_uv(value: str | os.PathLike[str] | None = None) -> Path:
    return _resolve_tool(
        value,
        name="uv",
        not_found="uv is required to start Route2's local classifier; install uv or pass --uv",
    )


def resolve_curl(value: str | os.PathLike[str] | None = None) -> Path:
    return _resolve_tool(
        value,
        name="curl",
        not_found="curl is required by Route2's local classifier; install curl or pass --curl",
    )


def _load_routing_policy(path: Path) -> Mapping[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise InstallerError(f"cannot read Route2 routing policy {path}: {error}") from error
    if not isinstance(value, Mapping):
        raise InstallerError(f"Route2 routing policy is not an object: {path}")
    return value


def routing_policy_context() -> tuple[Path | None, Mapping[str, Any], Path | None]:
    """Return the active policy, its path, and any explicit env override."""

    configured = os.environ.get("ROUTE2_CONFIG")
    configured_path = Path(configured).expanduser().resolve() if configured else None
    if configured_path is not None:
        if not configured_path.is_file():
            raise InstallerError(f"ROUTE2_CONFIG points to a missing routing policy: {configured_path}")
        return configured_path, _load_routing_policy(configured_path), configured_path
    candidates = [
        Path.cwd() / ".route2" / "config.json",
        Path.cwd() / ".route2.json",
        Path.home() / ".route2" / "config.json",
    ]
    for candidate in candidates:
        if candidate is not None and candidate.is_file():
            return candidate, _load_routing_policy(candidate), configured_path

    built_in = ROOT / "config" / "route2.json"
    if built_in.is_file():
        return built_in, _load_routing_policy(built_in), configured_path
    return None, {
        "backend": "decision",
        "decision": {
            "endpoint": DEFAULT_DECISION_ENDPOINT,
            "model": DECISION_MODEL,
            "command": "uv",
            "args": ["scripts/decision_server.py"],
        },
    }, configured_path


def _uses_embedded_classifier(policy: Mapping[str, Any]) -> bool:
    if any(
        os.environ.get(name)
        for name in ("ROUTE2_CLASSIFIER_ENDPOINT", "ROUTE2_CLASSIFIER_CMD", "ROUTE2_CLASSIFIER_ARGS")
    ):
        return False
    if policy.get("backend") != "decision":
        return False
    decision = policy.get("decision")
    if not isinstance(decision, Mapping):
        return False
    if decision.get("model") != DECISION_MODEL:
        return False
    if decision.get("endpoint", DEFAULT_DECISION_ENDPOINT) != DEFAULT_DECISION_ENDPOINT:
        return False
    if decision.get("command", "uv") != "uv":
        return False
    args = decision.get("args")
    if not isinstance(args, list):
        return False
    return any(Path(str(argument)).name == "decision_server.py" for argument in args)


def resolve_router(value: str | os.PathLike[str] | None = None) -> Path:
    if value is not None:
        path = Path(value).expanduser().resolve()
        if not path.is_file() or not os.access(path, os.X_OK):
            raise InstallerError(f"Route2 router executable is not usable: {path}")
        return path
    candidate = ROOT / "target" / "debug" / "route2"
    if candidate.is_file() and os.access(candidate, os.X_OK):
        return candidate.resolve()
    located = shutil.which("route2")
    if located:
        return Path(located).resolve()
    raise InstallerError("Route2 router was not found; build target/debug/route2 or pass --router")


def validate_upstream(value: str) -> str:
    if not value or not value.strip():
        raise InstallerError("--upstream must be a non-empty URL")
    from urllib.parse import urlsplit

    try:
        parsed = urlsplit(value)
    except ValueError as error:
        raise InstallerError(f"invalid upstream URL: {error}") from error
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise InstallerError("upstream URL cannot contain credentials, query or fragment")
    if parsed.scheme != "https" and not (parsed.scheme == "http" and parsed.hostname in {"127.0.0.1", "localhost", "::1"}):
        raise InstallerError("upstream must use HTTPS or loopback HTTP")
    if not parsed.netloc:
        raise InstallerError("upstream URL must include a host")
    return value.rstrip("/")


def read_auth_mode(codex_home: Path) -> str | None:
    """Read only the non-secret auth_mode metadata from auth.json."""

    path = codex_home / "auth.json"
    if not path.is_file():
        return None
    try:
        # Codex's auth file is a JSON object.  We intentionally retain only
        # this one field and never print, persist, or inspect token values.
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise InstallerError(f"cannot inspect Codex auth mode in {path}: {error}") from error
    mode = value.get("auth_mode") if isinstance(value, Mapping) else None
    return mode.lower() if isinstance(mode, str) else None


def infer_upstream(
    requested: str | None,
    config: Mapping[str, Any],
    *,
    auth_mode: str | None = None,
) -> tuple[str, bool]:
    """Return (URL, explicit) without inspecting credential files.

    A missing provider or the built-in ``openai`` provider is treated as the
    ChatGPT sign-in flow only when there is no custom base URL and no API-key
    auth mode.  Any other provider requires an explicit ``--upstream`` so a
    config cannot be silently redirected to an incompatible endpoint.
    """

    if requested is not None:
        return validate_upstream(requested), True

    if auth_mode != "chatgpt":
        raise InstallerError(
            "ChatGPT auth mode was not confirmed; pass --upstream explicitly"
        )
    provider = config.get("model_provider")
    if provider not in (None, "openai"):
        raise InstallerError(
            f"config uses provider {provider!r}; pass --upstream explicitly to install Route2"
        )
    providers = config.get("model_providers")
    if isinstance(providers, Mapping):
        openai = providers.get("openai")
        if isinstance(openai, Mapping):
            for key in ("base_url", "openai_base_url", "chatgpt_base_url"):
                if openai.get(key):
                    raise InstallerError(
                        f"config has custom openai base URL; pass --upstream explicitly"
                    )
            auth_mode = openai.get("auth_mode")
            if isinstance(auth_mode, str) and auth_mode.lower() in {"api", "api_key", "apikey"}:
                raise InstallerError("config uses API-key auth; pass --upstream explicitly")
    for key in ("openai_base_url", "chatgpt_base_url"):
        if config.get(key):
            raise InstallerError("config has a custom OpenAI base URL; pass --upstream explicitly")
    auth_mode = config.get("auth_mode")
    if isinstance(auth_mode, str) and auth_mode.lower() in {"api", "api_key", "apikey"}:
        raise InstallerError("config uses API-key auth; pass --upstream explicitly")
    return DEFAULT_CHATGPT_UPSTREAM, False


def plan_config(
    path: Path,
    original_text: str,
    data: Mapping[str, Any],
    catalog_path: Path,
    port: int,
    prior_state: Mapping[str, Any] | None = None,
) -> ConfigPlan:
    """Build an in-memory edit while detecting duplicate/conflicting keys."""

    _reject_ambiguous_spellings(original_text)
    lines = original_text.splitlines(keepends=True)
    newline = _line_ending(lines)
    edits: list[ConfigEdit] = []
    if lines and not lines[-1].endswith(("\n", "\r")):
        original_last = lines[-1]
        lines[-1] = original_last + newline
        edits.append(ConfigEdit("", "__eof_newline__", "eof", original_last, original_last))
    desired_top = {
        "model": SENTINEL,
        "model_provider": "route2",
        "model_catalog_json": str(catalog_path.resolve()),
    }

    prior_edits = {
        (item.get("section", ""), item.get("key", "")): item
        for item in (prior_state or {}).get("config_edits", [])
        if isinstance(item, Mapping)
    }

    def prior_conflict(section: str, key: str, assignment: Assignment | None) -> None:
        previous = prior_edits.get((section, key))
        if previous is None:
            return
        expected = str(previous.get("new_line", "")).rstrip("\r\n")
        if assignment is None or assignment.line != expected:
            raise ConfigConflict(
                f"user changed installer-owned config key {key!r}; refusing to overwrite it"
            )

    # Detect duplicate managed keys up front.  tomllib also rejects them, but
    # the explicit message is much more useful and covers a missing file.
    for section, keys in (("", desired_top.keys()), ("model_providers.route2", ("name", "base_url", "wire_api", "requires_openai_auth", "supports_websockets"))):
        assignment_map = _assignment_map(original_text, section)
        for key in keys:
            if len(assignment_map.get(key, [])) > 1:
                raise ConfigConflict(f"config has duplicate key {key!r} in [{section}]" if section else f"config has duplicate top-level key {key!r}")

    # Replace existing top-level values in place.  This is intentional for
    # model/provider selection: explicit or safely inferred upstream selection
    # makes that redirect concrete, and uninstall can restore each line.
    for key, value in desired_top.items():
        assignment = _single_assignment(original_text, "", key)
        rendered = f"{key} = {_json_string(value)}"
        if assignment is not None:
            prior_conflict("", key, assignment)
            current = _toml_value(data, "", key)
            if current == value:
                continue
            replacement = _render_replacement(assignment, rendered, newline)
            lines[assignment.index] = replacement
            edits.append(ConfigEdit("", key, "replace", assignment.line, replacement.rstrip("\r\n")))
        else:
            # Missing top-level keys must be inserted before the first table,
            # otherwise TOML would interpret them as members of the last table.
            first_table = next((idx for idx, raw in enumerate(lines) if _table_header(raw)), len(lines))
            lines.insert(first_table, rendered + newline)
            edits.append(ConfigEdit("", key, "insert", None, rendered))

    # Add or extend the Route2 provider table.  Existing provider keys with
    # different values are a hard conflict; they may belong to a user's own
    # provider and silently replacing them would be unsafe.
    provider_values = {
        "name": "Route2",
        "base_url": f"http://127.0.0.1:{port}",
        "wire_api": "responses",
        "requires_openai_auth": True,
        "supports_websockets": False,
    }
    spans = _section_spans(lines)
    provider_section = "model_providers.route2"
    if provider_section in spans:
        start, end = spans[provider_section]
        section_text = "".join(lines[start:end])
        section_assignments = _assignment_map(section_text, provider_section)
        # _assignment_map sees the first table as the section; use original
        # line offsets directly to avoid confusion after top-level insertion.
        current_assignments = {
            assignment.key: assignment
            for assignment in _assignments("".join(lines[start:end]))
            if assignment.section in (provider_section, "")
        }
        for key, value in provider_values.items():
            assignment = current_assignments.get(key)
            rendered_value = _json_string(value) if isinstance(value, str) else ("true" if value else "false")
            rendered = f"{key} = {rendered_value}"
            if assignment is not None:
                current = _toml_value(data, provider_section, key)
                if current != value:
                    raise ConfigConflict(
                        f"config provider table already defines model_providers.route2.{key} differently"
                    )
                continue
            # append to the exact table's end, before any next table
            lines.insert(end, rendered + newline)
            end += 1
            edits.append(ConfigEdit(provider_section, key, "insert", None, rendered))
    else:
        block = [f"[model_providers.route2]{newline}"]
        edits.append(ConfigEdit(provider_section, "__table__", "insert", None, "[model_providers.route2]"))
        for key, value in provider_values.items():
            rendered_value = _json_string(value) if isinstance(value, str) else ("true" if value else "false")
            rendered = f"{key} = {rendered_value}"
            block.append(rendered + newline)
            edits.append(ConfigEdit(provider_section, key, "insert", None, rendered))
        lines.extend(block)

    new_text = "".join(lines)
    try:
        tomllib.loads(new_text)
    except tomllib.TOMLDecodeError as error:
        raise ConfigConflict(f"generated Codex config is invalid TOML: {error}") from error
    return ConfigPlan(path, original_text, new_text, edits, new_text != original_text)


def _atomic_write(path: Path, text: str, mode: int | None = None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=str(path.parent))
    temporary_path = Path(temporary)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        if mode is not None:
            os.chmod(temporary_path, mode)
        os.replace(temporary_path, path)
    finally:
        try:
            temporary_path.unlink()
        except FileNotFoundError:
            pass


def _write_catalog(path: Path, catalog: Mapping[str, Any]) -> tuple[bool, str]:
    text = json.dumps(catalog, ensure_ascii=False, indent=2) + "\n"
    encoded = text.encode("utf-8")
    changed = not path.exists() or path.read_bytes() != encoded
    if changed:
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=str(path.parent))
        temporary_path = Path(temporary)
        try:
            with os.fdopen(fd, "wb") as handle:
                handle.write(encoded)
                handle.flush()
                os.fsync(handle.fileno())
            os.chmod(temporary_path, stat.S_IRUSR | stat.S_IWUSR)
            os.replace(temporary_path, path)
        finally:
            try:
                temporary_path.unlink()
            except FileNotFoundError:
                pass
    return changed, _sha256_bytes(encoded)


def _backup_config(path: Path, codex_home: Path) -> Path | None:
    if not path.exists():
        return None
    backup = codex_home / f"config.toml.route2-backup"
    if not backup.exists():
        backup.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, backup)
    return backup


def _backup_file(path: Path, backup: Path) -> Path | None:
    """Copy an existing generated artifact before the first overwrite."""

    if not path.exists():
        return None
    if not backup.exists():
        backup.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, backup)
    return backup


def _remove_line_edits(text: str, edits: Iterable[Mapping[str, Any]]) -> tuple[str, bool, list[str]]:
    """Undo exact owned lines and leave later user edits untouched."""

    lines = text.splitlines(keepends=True)
    changed = False
    unresolved: list[str] = []
    # Remove/revert from the end so indexes remain stable for the first pass.
    for edit in reversed(list(edits)):
        section = str(edit.get("section", ""))
        key = str(edit.get("key", ""))
        action = str(edit.get("action", ""))
        new_line = str(edit.get("new_line", ""))
        original_line = edit.get("original_line")
        if key in {"__table__", "__separator__", "__eof_newline__"}:
            # A table is removable only when none of its owned assignments
            # remain.  The caller handles the table after key edits.
            continue
        spans = _section_spans(lines)
        if section:
            start, end = spans.get(section, (0, len(lines)))
        else:
            # The empty section is the prefix before the first TOML table.
            # Searching through the whole file could mistake a nested key
            # with the same spelling for the owned top-level assignment.
            start = 0
            end = min((span[0] for span in spans.values()), default=len(lines))
        candidates: list[int] = []
        for index in range(start, end):
            assignment = _ASSIGNMENT_RE.match(lines[index])
            if assignment and _assignment_key(assignment) == key:
                candidates.append(index)
        if len(candidates) != 1:
            unresolved.append(f"{section}.{key}" if section else key)
            continue
        index = candidates[0]
        if lines[index].rstrip("\r\n") != new_line.rstrip("\r\n"):
            unresolved.append(f"{section}.{key}" if section else key)
            continue
        if action == "insert":
            del lines[index]
        elif action == "replace" and isinstance(original_line, str):
            ending = "\r\n" if lines[index].endswith("\r\n") else "\n"
            lines[index] = original_line + ending
        else:
            unresolved.append(f"{section}.{key}" if section else key)
            continue
        changed = True

    # If the installer created the entire provider table, remove it only when
    # all of its owned lines were reverted and it is now empty.
    table_removed = False
    if any(str(edit.get("key")) == "__table__" for edit in edits):
        spans = _section_spans(lines)
        section = next((str(edit.get("section")) for edit in edits if str(edit.get("key")) == "__table__"), None)
        if section and section in spans:
            start, end = spans[section]
            # Comments are user content too.  Only a truly empty table body
            # can be removed without losing a later edit.
            body = [line for line in lines[start + 1 : end] if line.strip()]
            if not body:
                del lines[start:end]
                changed = True
                table_removed = True
            else:
                unresolved.append(f"[{section}]")
    if table_removed:
        section = next((str(edit.get("section")) for edit in edits if str(edit.get("key")) == "__separator__"), None)
        if section is not None:
            # The separator is the blank line immediately before the table
            # which the installer appended to a non-empty file.
            spans = _section_spans(lines)
            if section not in spans:
                # The table was removed above, so locate the first blank line
                # at EOF only when it is the one recorded by this edit.
                if lines and not lines[-1].strip():
                    lines.pop()
                    changed = True
    eof_marker = next(
        (edit for edit in edits if str(edit.get("key")) == "__eof_newline__"),
        None,
    )
    if eof_marker is not None:
        original_last = str(eof_marker.get("original_line", ""))
        candidates = [
            index
            for index, line in enumerate(lines)
            if index == len(lines) - 1
            and line.endswith(("\n", "\r"))
            and line.rstrip("\r\n") == original_last
        ]
        if len(candidates) == 1:
            lines[candidates[0]] = original_last
            changed = True
        else:
            unresolved.append("__eof_newline__")
    return "".join(lines), changed, unresolved


def _default_runner(args: Sequence[str], **kwargs: Any) -> subprocess.CompletedProcess[str]:
    return subprocess.run(list(args), **kwargs)


def build_classifier_prepare_command(
    uv: str | os.PathLike[str],
    *,
    source_dir: Path = ROOT,
    cache_root: Path | None = None,
) -> list[str]:
    source_dir = Path(source_dir).expanduser().resolve()
    script = source_dir / "scripts" / "decision_server.py"
    command = [str(uv), "run", "--directory", str(source_dir)]
    for dependency in PINNED_DEPENDENCIES:
        command.extend(["--with", dependency])
    command.extend(["python", str(script), "--prepare-only", "--download"])
    command.extend(["--cache-root", str(Path(cache_root or DEFAULT_CACHE_ROOT).expanduser().resolve())])
    return command


def provision_classifier(
    uv: str | os.PathLike[str],
    *,
    source_dir: Path = ROOT,
    cache_root: Path | None = None,
    runner: Callable[..., Any] | None = None,
) -> dict[str, Any]:
    """Provision pinned classifier dependencies and weights before activation."""

    selected_cache = Path(cache_root or DEFAULT_CACHE_ROOT).expanduser().resolve()
    command = build_classifier_prepare_command(uv, source_dir=source_dir, cache_root=selected_cache)
    classifier_progress(
        "loading_dependencies",
        "Provisioning pinned classifier dependencies and weights",
    )
    execute = runner or _default_runner
    provision_env = os.environ.copy()
    provision_env.pop("UV_OFFLINE", None)
    provision_env.pop("HF_HUB_OFFLINE", None)
    try:
        try:
            completed = execute(
                command,
                cwd=str(Path(source_dir).expanduser().resolve()),
                env=provision_env,
                text=True,
                stdout=sys.stderr,
                stderr=sys.stderr,
                check=False,
                timeout=CLASSIFIER_READY_TIMEOUT,
            )
        except TypeError:
            completed = execute(command)
    except subprocess.TimeoutExpired as error:
        raise InstallerError(
            f"classifier provisioning exceeded the {int(CLASSIFIER_READY_TIMEOUT)} second setup deadline"
        ) from error
    except (OSError, subprocess.SubprocessError) as error:
        raise InstallerError(f"classifier provisioning could not start: {error}") from error
    returncode = getattr(completed, "returncode", 0 if completed is True or completed is None else 1)
    if returncode != 0:
        detail = getattr(completed, "stderr", "") or getattr(completed, "stdout", "") or ""
        detail = str(detail).strip()
        suffix = f": {detail[-2000:]}" if detail else ""
        raise InstallerError(f"classifier provisioning failed (exit {returncode}){suffix}")
    classifier_progress(
        "ready",
        f"Classifier dependencies and weights are ready at {selected_cache}",
    )
    return {"cache_root": str(selected_cache), "command": command}


def _health_progress_stage(state: str, stage: str) -> str:
    value = f"{state} {stage}".lower()
    if state == "ready":
        return "ready"
    if "depend" in value:
        return "loading_dependencies"
    if "download" in value:
        return "downloading_weights"
    if "weight" in value or "check" in value:
        return "checking_weights"
    if "material" in value:
        return "materializing_weights"
    if "model" in value or "warm" in value or state == "loading":
        return "loading_model"
    return "loading_dependencies"


def _health_progress_message(classifier: Mapping[str, Any], state: str, stage: str) -> str:
    message = classifier.get("message") or classifier.get("error")
    if isinstance(message, str) and message.strip():
        return " ".join(message.split())[:240]
    return f"Classifier state is {state}; phase {stage or 'startup'}"


class ServiceManager:
    """Platform service adapter with injectable process execution for tests."""

    def __init__(
        self,
        *,
        system: str | None = None,
        home: Path | None = None,
        runner: Callable[..., Any] | None = None,
        health_checker: Callable[[int], bool] | None = None,
    ) -> None:
        self.system = system or platform.system()
        self.home = (home or Path.home()).expanduser().resolve()
        self.runner = runner or _default_runner
        self.health_checker = health_checker

    @property
    def supported(self) -> bool:
        return self.system == "Darwin"

    @property
    def kind(self) -> str:
        return "launchd"

    @property
    def path(self) -> Path:
        return self.home / "Library/LaunchAgents" / f"{SERVICE_LABEL}.plist"

    def _run(self, args: Sequence[str], *, check: bool = True) -> Any:
        try:
            result = self.runner(list(args), capture_output=True, text=True, check=False)
        except TypeError:
            # Tiny fixture runners often accept only argv.
            result = self.runner(list(args))
        except OSError as error:
            raise ServiceError(f"could not run {' '.join(map(str, args))}: {error}") from error
        returncode = getattr(result, "returncode", 0 if result is True or result is None else 1)
        if check and returncode != 0:
            stderr = getattr(result, "stderr", "") or getattr(result, "stdout", "") or ""
            raise ServiceError(f"service command failed ({returncode}): {' '.join(map(str, args))}: {stderr.strip()}")
        return result

    def render(self, spec: ServiceSpec) -> str:
        if not self.supported:
            raise ServiceError("Route2 supports macOS and Codex only")
        environment = {
            "ROUTE2_UPSTREAM_URL": spec.upstream,
            "ROUTE2_SOURCE_DIR": str(spec.repo_root),
            "ROUTE2_INSTANCE_ID": spec.instance_id,
            "PATH": spec.path_env or _captured_service_path(),
        }
        if spec.route2_config is not None:
            environment["ROUTE2_CONFIG"] = str(spec.route2_config)
        if spec.decision_cache is not None:
            environment["ROUTE2_DECISION_CACHE"] = str(spec.decision_cache)
        environment.update(spec.classifier_overrides)
        if spec.classifier_offline:
            environment.update({"UV_OFFLINE": "1", "HF_HUB_OFFLINE": "1"})
        return plistlib.dumps({
            "Label": SERVICE_LABEL,
            "ProgramArguments": [str(spec.node), str(SERVE_PROXY.resolve()), "--router", str(spec.router), "--port", str(spec.port)],
            "WorkingDirectory": str(spec.repo_root),
            "EnvironmentVariables": environment,
            "RunAtLoad": True,
            "KeepAlive": True,
            "StandardOutPath": str(spec.codex_home / "route2-service.stdout.log"),
            "StandardErrorPath": str(spec.codex_home / "route2-service.stderr.log"),
        }).decode("utf-8")

    def _activate(self, spec: ServiceSpec) -> None:
        domain = f"gui/{os.getuid()}"
        self._run(["launchctl", "bootout", domain, str(self.path)], check=False)
        self._run(["launchctl", "enable", f"{domain}/{SERVICE_LABEL}"])
        self._run(["launchctl", "bootstrap", domain, str(self.path)])

    def _deactivate(self, result: ServiceInstallResult) -> None:
        if result.path is not None:
            self._run(["launchctl", "bootout", f"gui/{os.getuid()}", str(result.path)], check=False)

    def install(self, spec: ServiceSpec, prior: Mapping[str, Any] | None = None, *, activate: bool = True) -> ServiceInstallResult:
        if not self.supported:
            raise ServiceError(f"automatic service installation is unsupported on {self.system}")
        rendered = self.render(spec)
        payload = rendered.encode("utf-8")
        expected = ((prior or {}).get("service") or {}).get("sha256")
        path = self.path
        existed = bool(path and path.exists())
        previous = path.read_bytes() if path and existed else None
        previous_hash = _sha256_bytes(previous) if previous is not None else None
        if path and existed and expected is None:
            raise ServiceError(f"service definition already exists; refusing to overwrite {path}")
        if path and existed and expected and previous_hash != expected:
            raise ServiceError(f"service definition was changed outside Route2: {path}")
        changed = previous != payload if path else True
        if path and changed:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(payload)
        activated = False
        result = ServiceInstallResult(self.kind, path, existed, previous, previous_hash, _sha256_bytes(payload), changed, False)
        if activate and changed:
            try:
                self._activate(spec)
                activated = True
            except Exception:
                try:
                    self._deactivate(result)
                except Exception:
                    pass
                if path and changed:
                    _restore_file(path, previous)
                    if previous is not None:
                        try:
                            self._reactivate_restored(result)
                        except Exception:
                            pass
                raise
            result.activated = activated
        elif activate and path is not None:
            domain = f"gui/{os.getuid()}"
            target = f"{domain}/{SERVICE_LABEL}"
            self._run(["launchctl", "enable", target])
            loaded = self._run(["launchctl", "print", target], check=False)
            if getattr(loaded, "returncode", 0) != 0:
                self._run(["launchctl", "bootstrap", domain, str(path)])
            self._run(["launchctl", "kickstart", target])
        return result

    def rollback(self, result: ServiceInstallResult) -> None:
        if not result.changed:
            # An idempotent install did not replace the service definition;
            # leave the user's already-running service alone on a later
            # config/catalog failure.
            return
        self._deactivate(result)
        if result.path is not None and result.changed:
            _restore_file(result.path, result.previous_bytes)
            if result.previous_bytes is not None:
                self._reactivate_restored(result)

    def _reactivate_restored(self, result: ServiceInstallResult) -> None:
        if result.path is not None:
            domain = f"gui/{os.getuid()}"
            self._run(["launchctl", "enable", f"{domain}/{SERVICE_LABEL}"])
            self._run(["launchctl", "bootstrap", domain, str(result.path)])

    def uninstall(self, state: Mapping[str, Any], *, activate: bool = True) -> tuple[bool, str | None]:
        if not self.supported:
            raise ServiceError("Route2 supports macOS and Codex only")
        service = state.get("service") if isinstance(state, Mapping) else None
        if not isinstance(service, Mapping) or service.get("kind") != "launchd":
            return False, "installer has no macOS service ownership record"
        path = Path(str(service["path"])).expanduser().resolve() if service.get("path") else None
        if path != self.path.resolve() or not service.get("sha256"):
            return False, "installer service ownership does not match this macOS user"
        expected = service["sha256"]
        if not path.exists():
            return True, None
        if _sha256_file(path) != expected:
            return False, f"service definition changed outside Route2: {path}"
        result = ServiceInstallResult(self.kind, path, True, path.read_bytes(), expected, expected, True, True)
        if activate:
            self._deactivate(result)
        path.unlink(missing_ok=True)
        return True, None

    def wait_for_health(
        self,
        port: int,
        timeout: float = CLASSIFIER_READY_TIMEOUT,
        instance_id: str | None = None,
        progress: Callable[[str], None] | None = None,
    ) -> None:
        deadline = time.monotonic() + timeout
        url = f"http://127.0.0.1:{port}/health"
        last_error: Exception | None = None
        last_progress: tuple[str, str, str] | None = None

        def report(stage: str, message: str) -> None:
            if progress is not None:
                progress(message)
            else:
                classifier_progress(stage, message)

        def inspect_payload(payload: Mapping[str, Any], *, strict_identity: bool) -> str:
            nonlocal last_progress
            if strict_identity and (
                payload.get("service") != "route2"
                or payload.get("model") != MODEL
                or (
                    instance_id is not None
                    and payload.get("instanceId", payload.get("instance_id")) != instance_id
                )
            ):
                raise ServiceError("health response did not identify this Route2 service")
            classifier = payload.get("classifier")
            if classifier is None:
                raise ServiceError("health response did not report classifier.state")
            if not isinstance(classifier, Mapping):
                raise ServiceError("health response has an invalid classifier status")
            state = str(classifier.get("state") or "").lower()
            phase = str(classifier.get("stage") or classifier.get("phase") or "startup")
            if state == "ready":
                report("ready", "Classifier is ready")
                return "ready"
            if state in {"error", "stopped"}:
                detail = _health_progress_message(classifier, state, phase)
                raise ServiceError(f"Route2 classifier failed during setup: {detail}")
            if state in {"starting", "loading"}:
                marker = (str(state), phase, _health_progress_message(classifier, state, phase))
                if marker != last_progress:
                    report(_health_progress_stage(state, phase), marker[2])
                    last_progress = marker
                return "loading"
            raise ServiceError(f"health response reported unknown classifier.state {state!r}")

        if self.health_checker is not None:
            while time.monotonic() < deadline:
                try:
                    checked = self.health_checker(port)
                    if isinstance(checked, Mapping):
                        state = inspect_payload(checked, strict_identity=False)
                        if state == "ready":
                            return
                    elif checked:
                        return
                    else:
                        raise ServiceError(f"Route2 service did not become healthy on port {port}")
                except ServiceError:
                    raise
                except Exception as error:
                    last_error = error
                time.sleep(min(0.25, max(0.0, deadline - time.monotonic())))
            detail = f": {last_error}" if last_error else ""
            raise ServiceError(
                f"Route2 classifier did not become ready on port {port} "
                f"within {int(timeout)} seconds{detail}"
            )

        while time.monotonic() < deadline:
            status = None
            body = ""
            try:
                with urllib.request.urlopen(url, timeout=0.75) as response:
                    status = response.status
                    body = response.read(4096).decode("utf-8", "replace")
            except urllib.error.HTTPError as error:
                status = error.code
                try:
                    body = error.read(4096).decode("utf-8", "replace")
                except OSError:
                    body = ""
            except (OSError, urllib.error.URLError) as error:
                last_error = error
            if body:
                try:
                    parsed = json.loads(body)
                    state = inspect_payload(parsed, strict_identity=True)
                    if state == "ready":
                        return
                    last_error = ServiceError(f"classifier is still loading (HTTP {status})")
                except ServiceError:
                    raise
                except (TypeError, ValueError) as error:
                    last_error = error
            elif status is not None:
                last_error = ServiceError(f"health endpoint returned HTTP {status}")
            time.sleep(min(0.25, max(0.0, deadline - time.monotonic())))
        detail = f": {last_error}" if last_error else ""
        raise ServiceError(
            f"Route2 classifier did not become ready on port {port} "
            f"within {int(timeout)} seconds{detail}"
        )


def _captured_service_path(extra: Iterable[Path] = ()) -> str:
    """Capture executable directories needed by a login-independent service."""

    separator = os.pathsep
    candidates: list[str] = [str(path.parent) for path in extra]
    current = os.environ.get("PATH", "")
    if current:
        candidates.extend(current.split(separator))
    for executable in ("uv", "curl"):
        located = shutil.which(executable)
        if located:
            candidates.append(str(Path(located).resolve().parent))
    if sys.platform == "darwin":
        candidates.extend(["/opt/homebrew/bin", "/usr/local/bin", str(Path.home() / ".local" / "bin")])
    seen: set[str] = set()
    unique: list[str] = []
    for item in candidates:
        if item and item not in seen:
            seen.add(item)
            unique.append(item)
    return separator.join(unique)


def _restore_file(path: Path, previous: bytes | None) -> None:
    if previous is None:
        path.unlink(missing_ok=True)
    else:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(previous)


def _load_state(path: Path) -> dict[str, Any] | None:
    if not path.is_file():
        return None
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise InstallerError(f"cannot read installer state {path}: {error}") from error
    if not isinstance(value, dict):
        raise InstallerError(f"installer state is not an object: {path}")
    return value


def _write_state(path: Path, state: Mapping[str, Any]) -> None:
    _atomic_write(path, json.dumps(state, ensure_ascii=False, indent=2) + "\n", stat.S_IRUSR | stat.S_IWUSR)


def _catalog_matches(path: Path, expected_hash: str | None) -> bool:
    return bool(path.exists() and expected_hash and _sha256_file(path) == expected_hash)


def _merge_config_edits(
    prior: Mapping[str, Any] | None,
    current: Iterable[ConfigEdit],
) -> list[dict[str, Any]]:
    """Keep first-install ownership metadata across idempotent re-runs."""

    merged: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    for item in (prior or {}).get("config_edits", []):
        if not isinstance(item, Mapping):
            continue
        key = (str(item.get("section", "")), str(item.get("key", "")))
        if key in seen:
            continue
        seen.add(key)
        merged.append(dict(item))
    for edit in current:
        key = (edit.section, edit.key)
        if key in seen:
            continue
        seen.add(key)
        merged.append(edit.as_dict())
    return merged


def install(
    *,
    codex_home: Path,
    upstream: str | None,
    router: str | os.PathLike[str] | None = None,
    node: str | os.PathLike[str] | None = None,
    uv: str | os.PathLike[str] | None = None,
    curl: str | os.PathLike[str] | None = None,
    port: int = DEFAULT_PORT,
    dry_run: bool = True,
    service_manager: ServiceManager | None = None,
    classifier_cache: str | os.PathLike[str] | None = None,
    provisioner: Callable[..., Mapping[str, Any] | None] | None = None,
) -> dict[str, Any]:
    """Plan or perform an install and return a reviewable result."""

    manager = service_manager or ServiceManager()
    if not manager.supported:
        raise ServiceError("Route2 supports macOS and Codex only")
    if not (1 <= int(port) <= 65535):
        raise InstallerError("port must be between 1 and 65535")
    codex_home = resolve_codex_home(codex_home)
    config_path = codex_home / "config.toml"
    state_path = codex_home / STATE_FILE_NAME
    original_text, config = _read_config(config_path)
    prior = _load_state(state_path)
    policy_path, routing_policy, explicit_policy_path = routing_policy_context()
    provision_required = _uses_embedded_classifier(routing_policy)
    selected_cache = classifier_cache or os.environ.get("ROUTE2_DECISION_CACHE")
    cache_root = (
        Path(selected_cache).expanduser().resolve()
        if selected_cache is not None
        else DEFAULT_CACHE_ROOT.resolve()
    )
    prior_upstream = ((prior or {}).get("service") or {}).get("upstream")
    if upstream is None and isinstance(prior_upstream, str) and prior_upstream:
        upstream_url, explicit_upstream = validate_upstream(prior_upstream), False
    else:
        auth_mode = read_auth_mode(codex_home) if upstream is None else None
        upstream_url, explicit_upstream = infer_upstream(upstream, config, auth_mode=auth_mode)
    node_path = resolve_node(node)
    router_path = resolve_router(router)
    uv_path = resolve_uv(uv) if provision_required else None
    curl_path = resolve_curl(curl)
    source = _config_catalog_source(config, codex_home)
    catalog, _source_text = load_catalog(source)
    catalog_path = codex_home / CATALOG_FILE_NAME
    config_plan = plan_config(config_path, original_text, config, catalog_path, int(port), prior)
    prior_instance_id = ((prior or {}).get("service") or {}).get("instance_id")
    instance_id = str(prior_instance_id) if isinstance(prior_instance_id, str) and prior_instance_id else str(uuid.uuid4())
    built_in_policy = (ROOT / "config" / "route2.json").resolve()
    service_policy = (explicit_policy_path if explicit_policy_path and explicit_policy_path.is_file() else None) or (
        policy_path if policy_path is not None and policy_path.resolve() != built_in_policy else None
    )
    classifier_overrides = {
        name: os.environ[name]
        for name in (
            "ROUTE2_CLASSIFIER_ENDPOINT", "ROUTE2_CLASSIFIER_CMD", "ROUTE2_CLASSIFIER_ARGS",
            "ROUTE2_CLASSIFIER_IDLE_TIMEOUT_SECS", "ROUTE2_CLASSIFIER_STARTUP_TIMEOUT_MS",
        )
        if os.environ.get(name)
    }
    spec = ServiceSpec(node_path, router_path, upstream_url, int(port), ROOT, codex_home, instance_id,
                       _captured_service_path(
                           [path for path in (uv_path, curl_path) if path is not None],
                       ),
                       service_policy,
                       cache_root if provision_required else None,
                       provision_required,
                       classifier_overrides)
    service_path = manager.path
    manager.render(spec)  # Validate platform-specific serialization during dry-run too.
    result: dict[str, Any] = {
        "action": "install",
        "dry_run": dry_run,
        "codex_home": str(codex_home),
        "config": str(config_path),
        "catalog_source": str(source),
        "catalog": str(catalog_path),
        "router": str(router_path),
        "node": str(node_path),
        "uv": str(uv_path) if uv_path is not None else None,
        "curl": str(curl_path),
        "upstream": upstream_url,
        "upstream_explicit": explicit_upstream,
        "port": int(port),
        "instance_id": instance_id,
        "service": manager.kind,
        "service_path": str(service_path) if service_path else None,
        "config_changed": config_plan.changed,
        "catalog_has_route2": True,
        "classifier_provision": "embedded" if provision_required else "external-policy",
        "classifier_provision_required": provision_required,
        "classifier_cache": str(cache_root) if provision_required else None,
        "routing_policy": str(policy_path) if policy_path else None,
    }
    if dry_run:
        return result

    transaction_config_existed = config_path.exists()
    config_existed_before = bool(prior.get("config_existed_before")) if prior is not None else transaction_config_existed
    backup = Path(str(prior.get("backup_path"))) if prior and prior.get("backup_path") else None
    service_result: ServiceInstallResult | None = None
    config_written = False
    provision_result: Mapping[str, Any] | None = None
    catalog_before = catalog_path.read_bytes() if catalog_path.exists() else None
    catalog_existed_before = bool(prior.get("catalog_existed_before")) if prior is not None else catalog_before is not None
    catalog_backup = (
        Path(str(prior.get("catalog_backup_path")))
        if prior and prior.get("catalog_backup_path")
        else codex_home / f"{catalog_path.name}.route2-backup"
    )
    if prior and catalog_before is not None and prior.get("catalog_sha256") and _sha256_bytes(catalog_before) != prior.get("catalog_sha256"):
        raise ConfigConflict("generated catalog was changed outside Route2; refusing to overwrite it")
    try:
        if provision_required:
            prepare = provisioner or provision_classifier
            provision_result = prepare(uv_path, source_dir=ROOT, cache_root=cache_root)
        else:
            print(
                "Route2 setup: custom classifier policy detected; skipping embedded model provisioning.",
                file=sys.stderr,
                flush=True,
            )
        service_result = manager.install(spec, prior, activate=True)
        manager.wait_for_health(int(port), instance_id=instance_id)
        if config_plan.changed:
            backup = _backup_config(config_path, codex_home)
        if catalog_before is not None and prior is None:
            _backup_file(catalog_path, catalog_backup)
        catalog_changed, catalog_hash = _write_catalog(catalog_path, catalog)
        if config_plan.changed:
            _atomic_write(config_path, config_plan.new_text)
            config_written = True
        state = {
            "version": 1,
            "config_path": str(config_path),
            "backup_path": str(backup) if backup else None,
            "catalog_path": str(catalog_path),
            "catalog_sha256": catalog_hash,
            "catalog_existed_before": catalog_existed_before,
            "catalog_backup_path": str(catalog_backup) if catalog_existed_before and catalog_backup.exists() else None,
            "config_existed_before": config_existed_before,
            "config_edits": _merge_config_edits(prior, config_plan.edits),
            "service": {
                "kind": manager.kind,
                "path": str(service_result.path) if service_result.path else None,
                "sha256": service_result.new_hash,
                "upstream": upstream_url,
                "port": int(port),
                "instance_id": instance_id,
            },
        }
        _write_state(state_path, state)
        result.update({
            "installed": True,
            "backup": str(backup) if backup else None,
            "catalog_changed": catalog_changed,
            "classifier_provisioned": provision_result is not None,
        })
        return result
    except Exception:
        # Restore only files written by this transaction.  The service is
        # rolled back before propagating the error, and a concurrent edit is
        # never overwritten by the rollback path.
        if service_result is not None:
            try:
                manager.rollback(service_result)
            except Exception:
                pass
        if catalog_before is None:
            catalog_path.unlink(missing_ok=True)
        elif catalog_path.exists() and catalog_path.read_bytes() != catalog_before:
            catalog_path.write_bytes(catalog_before)
        if config_written and config_path.exists() and config_path.read_text(encoding="utf-8") == config_plan.new_text:
            if transaction_config_existed:
                _atomic_write(config_path, config_plan.original_text)
            else:
                config_path.unlink(missing_ok=True)
        raise


def uninstall(
    *,
    codex_home: Path,
    dry_run: bool = True,
    service_manager: ServiceManager | None = None,
) -> dict[str, Any]:
    manager = service_manager or ServiceManager()
    if not manager.supported:
        raise ServiceError("Route2 supports macOS and Codex only")
    codex_home = resolve_codex_home(codex_home)
    state_path = codex_home / STATE_FILE_NAME
    state = _load_state(state_path)
    if state is None:
        raise InstallerError(f"no Route2 installer state found in {codex_home}; refusing to guess ownership")
    config_path = Path(str(state.get("config_path") or codex_home / "config.toml"))
    catalog_path = Path(str(state.get("catalog_path") or codex_home / CATALOG_FILE_NAME))
    result: dict[str, Any] = {
        "action": "uninstall",
        "dry_run": dry_run,
        "codex_home": str(codex_home),
        "config": str(config_path),
        "catalog": str(catalog_path),
        "service": manager.kind,
        "service_path": str(manager.path) if manager.path else None,
    }
    if dry_run:
        return result
    config_text = config_path.read_text(encoding="utf-8") if config_path.exists() else ""
    restored_text, changed, unresolved = _remove_line_edits(config_text, state.get("config_edits", []))
    if changed:
        if not restored_text and not state.get("config_existed_before", True):
            config_path.unlink(missing_ok=True)
        else:
            _atomic_write(config_path, restored_text)
    result["config_changed"] = changed
    result["preserved_user_edits"] = unresolved
    service_ok, service_error = manager.uninstall(state, activate=True)
    if not service_ok:
        result["service_error"] = service_error
    catalog_owned = _catalog_matches(catalog_path, state.get("catalog_sha256"))
    catalog_restored = False
    if catalog_owned:
        if state.get("catalog_existed_before") and state.get("catalog_backup_path"):
            backup_path = Path(str(state["catalog_backup_path"]))
            if backup_path.is_file():
                catalog_path.write_bytes(backup_path.read_bytes())
                result["catalog_removed"] = False
                catalog_restored = True
            else:
                # The original was expected but its safety copy is gone; do
                # not delete the generated file without a recoverable source.
                result["catalog_removed"] = False
                unresolved.append("catalog backup missing")
        else:
            catalog_path.unlink(missing_ok=True)
            result["catalog_removed"] = True
    else:
        result["catalog_removed"] = False
    complete = not unresolved and service_ok and (not catalog_path.exists() or not catalog_owned or catalog_restored)
    if complete:
        state_path.unlink(missing_ok=True)
        result["uninstalled"] = True
    else:
        result["uninstalled"] = False
        # Preserve ownership metadata when a later user edit prevented full
        # restoration; a future uninstall can still act safely.
        unresolved_set = set(unresolved)
        remaining_edits = []
        for edit in state.get("config_edits", []):
            section = str(edit.get("section", ""))
            key = str(edit.get("key", ""))
            identifier = f"{section}.{key}" if section else key
            if identifier in unresolved_set or f"[{section}]" in unresolved_set:
                remaining_edits.append(edit)
        state["config_edits"] = remaining_edits
        _write_state(state_path, state)
    return result


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Install Route2 automatic routing for Codex")
    action = parser.add_mutually_exclusive_group()
    action.add_argument("--install", action="store_true", help="perform the install (writes config/service)")
    action.add_argument("--uninstall", action="store_true", help="remove only Route2-owned changes")
    action.add_argument("--diagnostics", action="store_true", help="read local health and recent routing decisions without changing setup")
    parser.add_argument("--session", help="filter diagnostics to an exact Codex session ID")
    parser.add_argument("--no-menu-bar", action="store_true", help="skip the optional macOS menu-bar companion")
    parser.add_argument("--dry-run", action="store_true", help="show the plan without writing (the default)")
    parser.add_argument("--codex-home", help="Codex home (default CODEX_HOME or ~/.codex)")
    parser.add_argument("--upstream", help="existing provider base URL; safely inferred for ChatGPT sign-in")
    parser.add_argument("--router", help="Route2 executable (default target/debug/route2 or PATH)")
    parser.add_argument("--node", help="Node.js 24+ executable (default PATH)")
    parser.add_argument("--uv", help="uv executable (default PATH or common install locations)")
    parser.add_argument("--curl", help="curl executable (default PATH or common install locations)")
    parser.add_argument("--classifier-cache", help="materialized local classifier cache root")
    parser.add_argument("--port", type=int, help=f"loopback proxy port (setup default {DEFAULT_PORT}; diagnostics use the installed port)")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if platform.system() != "Darwin":
        parser.error("Route2 supports macOS and Codex only")
    dry_run = bool(args.dry_run or not args.install and not args.uninstall)
    codex_home = resolve_codex_home(args.codex_home)
    if args.diagnostics:
        try:
            report = collect_diagnostics(codex_home, port=args.port, session=args.session)
        except ValueError as error:
            parser.error(str(error))
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return 0
    try:
        if args.uninstall:
            if not dry_run and platform.system() == "Darwin":
                uninstall_menu_bar(codex_home)
            result = uninstall(codex_home=codex_home, dry_run=dry_run)
        else:
            result = install(
                codex_home=codex_home,
                upstream=args.upstream,
                router=args.router,
                node=args.node,
                uv=args.uv,
                curl=args.curl,
                classifier_cache=args.classifier_cache,
                port=args.port if args.port is not None else DEFAULT_PORT,
                dry_run=dry_run,
            )
    except (InstallerError, MenuBarError) as error:
        print(f"route2 installer: {error}", file=sys.stderr)
        return 2
    if dry_run:
        result["menu_bar"] = "optional macOS companion" if platform.system() == "Darwin" and not args.no_menu_bar else "skipped"
        print(json.dumps({"DRY RUN": result}, ensure_ascii=False, indent=2))
    elif args.uninstall:
        if not result.get("uninstalled"):
            print("Route2 removal is incomplete; user-edited settings were preserved.", file=sys.stderr)
            print(json.dumps(result, ensure_ascii=False, indent=2))
            return 1
        print("Route2 uninstalled; restart the app or open a new CLI session to apply restored settings.")
    else:
        if platform.system() == "Darwin" and not args.no_menu_bar:
            try:
                companion = install_menu_bar(codex_home)
                print(f"Route2 menu-bar companion installed: {companion['app']}")
            except (MenuBarError, OSError) as error:
                print(f"Route2 service installed; optional menu bar unavailable: {error}", file=sys.stderr)
        status_url = f"http://127.0.0.1:{result.get('port', DEFAULT_PORT)}/status"
        print(
            "Route2 installed for Codex CLI and the app; restart the app or open a new CLI session. "
            f"Status: {status_url}"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
