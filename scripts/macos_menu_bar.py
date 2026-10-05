"""Build and manage the optional native macOS Route2 menu-bar companion."""

import argparse
import hashlib
import json
import os
import platform
import plistlib
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
LABEL = "com.route2.menubar"
MANIFEST = ".route2-menubar.json"
APP_NAME = "Route2 Menu.app"
PREBUILT = ROOT / "apps" / "macos" / "prebuilt" / "Route2Menu"


class MenuBarError(RuntimeError):
    pass


def _run(arguments, runner, *, check=True):
    try:
        result = runner(arguments, capture_output=True, text=True, timeout=120, check=False)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise MenuBarError(f"Could not run menu-bar setup: {error}") from error
    if check and result.returncode:
        raise MenuBarError(f"Menu-bar command failed: {arguments[0]} ({result.returncode})")
    return result


def _hash(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _app_hashes(app):
    return {str(path.relative_to(app)): _hash(path)
            for path in sorted(app.rglob("*")) if path.is_file()}


def _write(path, content):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_bytes(content)
    os.replace(temporary, path)


def build_app(output, configuration, *, compiler=None, runner=subprocess.run, prebuilt=None):
    output = Path(output)
    executable = output / "Contents" / "MacOS" / "Route2Menu"
    resources = output / "Contents" / "Resources"
    executable.parent.mkdir(parents=True, exist_ok=True)
    resources.mkdir(parents=True, exist_ok=True)
    prebuilt = PREBUILT if prebuilt is None else Path(prebuilt)
    if prebuilt.is_file():
        shutil.copyfile(prebuilt, executable)
    else:
        compiler = compiler or shutil.which("swiftc")
        if not compiler:
            raise MenuBarError("swiftc is unavailable; install Xcode Command Line Tools, then run route2 menu-bar")
        _run([compiler, "-O", "-swift-version", "5", "-target",
              f"{platform.machine()}-apple-macosx13.0", str(ROOT / "apps/macos/MenuBarState.swift"),
              str(ROOT / "apps/macos/main.swift"), "-o", str(executable)], runner)
        if not executable.is_file():
            raise MenuBarError("Swift compilation did not produce the menu-bar executable")
    executable.chmod(0o755)
    (resources / "configuration.json").write_text(json.dumps(configuration), encoding="utf-8")
    shutil.copyfile(ROOT / "assets/route2-icon.png", resources / "route2-icon.png")
    (output / "Contents" / "Info.plist").write_bytes(plistlib.dumps({
        "CFBundleIdentifier": LABEL,
        "CFBundleName": "Route2 Menu",
        "CFBundleDisplayName": "Route2",
        "CFBundleExecutable": "Route2Menu",
        "CFBundlePackageType": "APPL",
        "CFBundleVersion": "1",
        "LSMinimumSystemVersion": "13.0",
        "LSUIElement": True,
        "NSHighResolutionCapable": True,
    }))
    return output


def _paths(codex_home, home):
    return (codex_home / APP_NAME, home / "Library/LaunchAgents" / f"{LABEL}.plist",
            codex_home / MANIFEST)


def _check_owned(app, agent, manifest):
    if not manifest.exists():
        if app.exists() or agent.exists():
            raise MenuBarError("An unowned menu-bar app or login item exists; refusing to overwrite it")
        return None
    try:
        state = json.loads(manifest.read_text())
        if state.get("app") != str(app) or state.get("agent") != str(agent):
            raise ValueError("ownership paths differ")
        if app.exists() and _app_hashes(app) != state.get("files"):
            raise ValueError("app was edited")
        if agent.exists() and _hash(agent) != state.get("agent_sha256"):
            raise ValueError("login item was edited")
    except (OSError, ValueError, AttributeError) as error:
        raise MenuBarError("Menu-bar ownership changed; preserving existing files") from error
    return state


def install_menu_bar(codex_home, *, home=None, uid=None, compiler=None, runner=subprocess.run, prebuilt=None):
    if platform.system() != "Darwin":
        raise MenuBarError("The menu-bar companion is macOS-only")
    codex_home = Path(codex_home).expanduser().resolve()
    home = Path(home or Path.home()).expanduser().resolve()
    try:
        state = json.loads((codex_home / ".route2-codex-installer.json").read_text())
        service = state["service"]
        agent_path = home / "Library/LaunchAgents/com.route2.codex.plist"
        if service["kind"] != "launchd" or Path(service["path"]).expanduser().resolve() != agent_path:
            raise ValueError("not the owned macOS service")
        if not agent_path.is_file() or _hash(agent_path) != service["sha256"]:
            raise ValueError("service definition changed")
        port = service["port"]
        instance_id = service["instance_id"]
        if type(port) is not int or not 1 <= port <= 65535 or not isinstance(instance_id, str) or not instance_id:
            raise ValueError("invalid service identity")
    except (OSError, ValueError, KeyError, TypeError) as error:
        raise MenuBarError("Install Route2's macOS service first; its ownership record must be intact") from error
    app, agent, manifest = _paths(codex_home, home)
    previous_state = _check_owned(app, agent, manifest)
    configuration = {"port": port, "instanceID": instance_id, "servicePlist": str(agent_path)}
    domain = f"gui/{uid if uid is not None else os.getuid()}"
    target = f"{domain}/{LABEL}"
    agent_content = plistlib.dumps({
        "Label": LABEL,
        "ProgramArguments": [str(app / "Contents/MacOS/Route2Menu")],
        "RunAtLoad": True,
        "KeepAlive": False,
        "StandardErrorPath": str(codex_home / "route2-menubar.stderr.log"),
        "StandardOutPath": str(codex_home / "route2-menubar.stdout.log"),
    })
    old_agent = agent.read_bytes() if agent.exists() else None
    old_manifest = manifest.read_bytes() if manifest.exists() else None
    with tempfile.TemporaryDirectory(prefix=".route2-menubar-", dir=codex_home) as temporary:
        staging = Path(temporary)
        built = build_app(staging / APP_NAME, configuration, compiler=compiler, runner=runner, prebuilt=prebuilt)
        new_state = {"app": str(app), "agent": str(agent), "files": _app_hashes(built),
                     "agent_sha256": hashlib.sha256(agent_content).hexdigest()}
        _check_owned(app, agent, manifest)
        _run(["/bin/launchctl", "bootout", target], runner, check=False)
        backup = staging / "previous.app"
        if app.exists():
            os.replace(app, backup)
        try:
            os.replace(built, app)
            _write(agent, agent_content)
            _run(["/bin/launchctl", "enable", target], runner)
            _run(["/bin/launchctl", "bootstrap", domain, str(agent)], runner)
            _write(manifest, json.dumps(new_state, indent=2).encode())
        except Exception:
            _run(["/bin/launchctl", "bootout", target], runner, check=False)
            if app.exists():
                shutil.rmtree(app)
            if backup.exists():
                os.replace(backup, app)
            if old_agent is None:
                agent.unlink(missing_ok=True)
            else:
                _write(agent, old_agent)
            if old_manifest is None:
                manifest.unlink(missing_ok=True)
            else:
                _write(manifest, old_manifest)
            if previous_state and old_agent:
                _run(["/bin/launchctl", "bootstrap", domain, str(agent)], runner, check=False)
            raise
    return {"app": str(app), "login_item": str(agent), "installed": True}


def uninstall_menu_bar(codex_home, *, home=None, uid=None, runner=subprocess.run):
    codex_home = Path(codex_home).expanduser().resolve()
    home = Path(home or Path.home()).expanduser().resolve()
    app, agent, manifest = _paths(codex_home, home)
    if not manifest.exists() and not app.exists() and not agent.exists():
        return {"uninstalled": True}
    _check_owned(app, agent, manifest)
    domain = f"gui/{uid if uid is not None else os.getuid()}"
    _run(["/bin/launchctl", "bootout", f"{domain}/{LABEL}"], runner, check=False)
    if app.exists():
        shutil.rmtree(app)
    agent.unlink(missing_ok=True)
    manifest.unlink(missing_ok=True)
    return {"uninstalled": True}


def main(argv=None):
    parser = argparse.ArgumentParser(description="Install or remove the Route2 macOS menu-bar companion")
    parser.add_argument("--codex-home", type=Path, default=Path(os.environ.get("CODEX_HOME", Path.home() / ".codex")))
    parser.add_argument("--uninstall", action="store_true", help="remove only the menu-bar companion")
    args = parser.parse_args(argv)
    if platform.system() != "Darwin":
        parser.error("the menu-bar companion is macOS-only")
    try:
        result = uninstall_menu_bar(args.codex_home) if args.uninstall else install_menu_bar(args.codex_home)
    except MenuBarError as error:
        print(f"route2 menu bar: {error}", file=sys.stderr)
        return 2
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
