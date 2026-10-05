"""Loopback System One adapter for a pinned Decision 2.0 package."""

import argparse
import json
import os
import shutil
import sys
import tempfile
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path


MODEL = "vllm-sr/Decision-2.0-Kai-0.6B"
REVISION = "cd49ea3813fd8ba0928a9a23ef6c9a0f2f0cd764"
MAX_BODY = 1024 * 1024
MATERIALIZED_CACHE_ENV = "ROUTE2_DECISION_CACHE"
SOURCE_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CACHE_ROOT = SOURCE_ROOT / "target" / "decision-cache"
PINNED_DEPENDENCIES = (
    "transformers==5.17.0",
    "torch==2.12.0",
    "safetensors==0.8.0",
)
PROGRESS_PREFIX = "[Route2 classifier] "
PROGRESS_STAGES = frozenset(
    {
        "loading_dependencies",
        "checking_weights",
        "downloading_weights",
        "materializing_weights",
        "loading_model",
        "ready",
    }
)


def classifier_progress(stage, message):
    if stage not in PROGRESS_STAGES:
        raise ValueError(f"unsupported classifier progress stage: {stage}")
    print(
        PROGRESS_PREFIX
        + json.dumps(
            {"stage": stage, "message": str(message)},
            ensure_ascii=False,
            separators=(",", ":"),
        ),
        file=sys.stderr,
        flush=True,
    )


def default_cache_root(cache_root=None):
    configured = (
        str(cache_root).strip()
        if cache_root is not None
        else os.environ.get(MATERIALIZED_CACHE_ENV, "").strip()
    )
    return Path(configured).expanduser() if configured else DEFAULT_CACHE_ROOT


def _transient_path(relative):
    parts = relative.parts
    return "__pycache__" in parts or parts[:2] == (".cache", "huggingface")


def _within(path, root):
    try:
        path.relative_to(root)
    except ValueError:
        return False
    return True


def _snapshot_files(snapshot, revision):
    raw_root = Path(snapshot).expanduser()
    if raw_root.is_symlink():
        raise ValueError("Snapshot root cannot be a link")
    if raw_root.parent.name == "snapshots" and raw_root.name != revision:
        raise ValueError("Snapshot path does not match the pinned revision")
    root = raw_root.resolve(strict=True)
    if raw_root.parent.name == "snapshots":
        model_cache = raw_root.parent.parent.resolve(strict=True)
        allowed_roots = (model_cache, (model_cache.parent / "blobs").resolve())
    else:
        allowed_roots = (raw_root.parent.resolve(strict=True),)
    files = []
    for path in sorted(root.rglob("*")):
        relative = path.relative_to(root)
        if _transient_path(relative):
            continue
        if path.is_symlink():
            source = path.resolve(strict=True)
            if not any(_within(source, allowed) for allowed in allowed_roots) or not source.is_file():
                raise ValueError(f"Unsafe snapshot entry: {relative.as_posix()}")
            files.append((relative, source))
        elif path.is_dir():
            continue
        elif path.is_file():
            files.append((relative, path))
        else:
            raise ValueError(f"Unsafe snapshot entry: {relative.as_posix()}")
    return root, files


def _materialized_cache_is_valid(target, expected):
    target = Path(target)
    if not target.is_dir() or target.is_symlink():
        return False
    actual = set()
    for path in target.rglob("*"):
        relative = path.relative_to(target)
        if _transient_path(relative) or path.is_symlink():
            return False
        if path.is_dir():
            continue
        if not path.is_file():
            return False
        actual.add(relative.as_posix())
    return actual == {relative.as_posix() for relative, _ in expected}


def _remove_cache_entry(path):
    path = Path(path)
    if path.is_symlink() or path.is_file():
        path.unlink()
    elif path.is_dir():
        shutil.rmtree(path)


def materialize_snapshot(snapshot, cache_root=None, revision=REVISION):
    """Copy a pinned HF snapshot to a link-free, revision-keyed cache."""

    source_root, files = _snapshot_files(snapshot, revision)
    if cache_root is None:
        configured = os.environ.get(MATERIALIZED_CACHE_ENV)
        cache_root = configured or (
            source_root.parent.parent / "route2-materialized"
            if source_root.parent.name == "snapshots"
            else source_root.parent / ".route2-materialized"
        )
    cache_root = Path(cache_root).expanduser()
    cache_root.mkdir(parents=True, exist_ok=True)
    target = cache_root / revision
    if _materialized_cache_is_valid(target, files):
        return target

    staging = Path(tempfile.mkdtemp(prefix=f".{revision}.", dir=cache_root))
    try:
        for relative, source in files:
            destination = staging / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, destination)
        if target.exists() or target.is_symlink():
            if _materialized_cache_is_valid(target, files):
                shutil.rmtree(staging)
                return target
            _remove_cache_entry(target)
        staging.replace(target)
    except Exception:
        shutil.rmtree(staging, ignore_errors=True)
        raise
    return target


def _cached_package_is_usable(package):
    package = Path(package).expanduser()
    if not package.is_dir() or package.is_symlink():
        return False
    if not (package / "config.json").is_file():
        return False
    if not any(path.is_file() and path.suffix == ".safetensors" for path in package.rglob("*")):
        return False
    return not any(path.is_symlink() for path in package.rglob("*"))


def cached_package(cache_root=None):
    """Return a complete local package without contacting Hugging Face."""

    candidates = [default_cache_root(cache_root) / REVISION]
    if cache_root is None and not os.environ.get(MATERIALIZED_CACHE_ENV, "").strip():
        candidates.append(SOURCE_ROOT / "target" / f"decision-model-{REVISION}")
    return next((target for target in candidates if _cached_package_is_usable(target)), None)


def _snapshot_download(*, allow_download):
    from huggingface_hub import snapshot_download

    return snapshot_download(
        MODEL,
        revision=REVISION,
        local_files_only=not allow_download,
    )


def _missing_cache_message(error):
    return (
        f"Route2 classifier weights for {MODEL} revision {REVISION} are not cached. "
        "Run `route2 install-codex --install` to provision them, or run "
        f"`uv run --directory {SOURCE_ROOT} "
        "--with transformers==5.17.0 --with torch==2.12.0 "
        "--with safetensors==0.8.0 python scripts/decision_server.py "
        "--prepare-only --download` for standalone development. "
        "Runtime downloads are disabled by default."
        + (f" ({error})" if str(error) else "")
    )


def prepare_classifier_package(*, allow_download=False, cache_root=None):
    """Return the pinned package, downloading only when explicitly allowed."""

    classifier_progress("checking_weights", "Checking the pinned local classifier cache")
    prepared = cached_package(cache_root)
    if prepared is not None:
        return prepared

    if allow_download:
        classifier_progress("downloading_weights", "Downloading the pinned classifier weights")
        os.environ.pop("HF_HUB_OFFLINE", None)
    else:
        classifier_progress("checking_weights", "Looking for a local Hugging Face snapshot")
    try:
        snapshot = _snapshot_download(allow_download=allow_download)
    except Exception as error:
        raise RuntimeError(_missing_cache_message(error)) from error

    classifier_progress("materializing_weights", "Materializing link-free classifier weights")
    try:
        prepared = materialize_snapshot(snapshot, default_cache_root(cache_root), REVISION)
    except Exception as error:
        raise RuntimeError(
            f"Route2 classifier cache could not be materialized for revision {REVISION}: {error}"
        ) from error
    if not _cached_package_is_usable(prepared):
        raise RuntimeError(
            f"Route2 classifier cache is incomplete at {prepared}; "
            "run setup-time provisioning again"
        )
    return prepared


def prepare_classifier(cache_root=None):
    """Prepare the pinned classifier for setup-time provisioning."""
    return prepare_classifier_package(allow_download=True, cache_root=cache_root)


def resolve_classifier_package(cache_root=None, *, allow_download=False):
    return prepare_classifier_package(
        allow_download=allow_download,
        cache_root=cache_root,
    )


def handler_for(model):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def reply(self, status, body):
            data = json.dumps(body, allow_nan=False).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            self.reply(200 if self.path == "/health" else 404, {"model": MODEL, "revision": REVISION})

        def do_POST(self):
            if self.path != "/v1/systemone":
                self.reply(404, {"error": "unknown endpoint"})
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= MAX_BODY:
                    self.reply(413, {"error": "invalid body length"})
                    return
                request = json.loads(self.rfile.read(length))
                if request.get("model", MODEL) != MODEL:
                    raise ValueError("unknown model")
                if not isinstance(request.get("state"), (str, dict, list)):
                    raise ValueError("state must be text or JSON")
                if not isinstance(request.get("questions"), dict) or not request["questions"]:
                    raise ValueError("questions must be a nonempty object")
                result = model.system_one(state=request["state"], questions=request["questions"])
                self.reply(200, result)
            except (ValueError, KeyError, TypeError):
                self.reply(400, {"error": "invalid System One request or answer"})
            except Exception:
                self.reply(500, {"error": "Decision inference failed"})

    return Handler


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8009)
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--cache-root", help="materialized classifier cache root")
    parser.add_argument(
        "--prepare-only",
        action="store_true",
        help="download and materialize assets without starting HTTP or loading the model",
    )
    parser.add_argument(
        "--download",
        "--allow-download",
        dest="allow_download",
        action="store_true",
        help="explicitly allow Hugging Face downloads for standalone development",
    )
    args = parser.parse_args(argv)
    if sys.platform != "darwin":
        parser.error("Route2 supports macOS and Codex only")
    setup_download = bool(args.prepare_only or args.allow_download)
    classifier_progress("loading_dependencies", "Loading the pinned classifier runtime dependencies")
    if setup_download:
        os.environ.pop("HF_HUB_OFFLINE", None)
    else:
        os.environ.setdefault("HF_HUB_OFFLINE", "1")
    try:
        package = prepare_classifier_package(
            allow_download=setup_download,
            cache_root=args.cache_root,
        )
    except RuntimeError as error:
        print(PROGRESS_PREFIX + str(error), file=sys.stderr, flush=True)
        return 2
    if args.prepare_only:
        classifier_progress("ready", "Pinned classifier dependencies and weights are ready")
        print(f"Route2 classifier prepared at {package}")
        return 0

    sys.dont_write_bytecode = True
    sys.path.insert(0, str(package))
    classifier_progress("loading_model", "Loading the pinned classifier model")
    try:
        from decision2.api import Decision2
        model = Decision2.from_pretrained(package, device=args.device)
    except Exception as error:
        print(f"route2 decision server: {error}", file=sys.stderr, flush=True)
        return 2
    classifier_progress("ready", "Classifier model is ready")
    HTTPServer(("127.0.0.1", args.port), handler_for(model)).serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
