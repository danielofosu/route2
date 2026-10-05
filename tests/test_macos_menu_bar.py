import hashlib
import json
import platform
import plistlib
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from scripts.macos_menu_bar import (
    APP_NAME, LABEL, MANIFEST, ROOT, MenuBarError, build_app, install_menu_bar, uninstall_menu_bar,
)
from scripts import install_codex


class MenuBarTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.home = Path(self.temporary.name).resolve()
        self.codex_home = self.home / "custom codex home"
        self.codex_home.mkdir()
        service = self.home / "Library/LaunchAgents/com.route2.codex.plist"
        service.parent.mkdir(parents=True)
        service.write_bytes(b"owned service")
        self.service = service
        (self.codex_home / ".route2-codex-installer.json").write_text(json.dumps({
            "service": {"kind": "launchd", "path": str(service), "port": 12345,
                        "instance_id": "owned-instance", "sha256": hashlib.sha256(service.read_bytes()).hexdigest()},
        }))
        self.calls = []

    def runner(self, arguments, **kwargs):
        self.calls.append(arguments)
        if arguments[0] == "fixture-swiftc":
            Path(arguments[arguments.index("-o") + 1]).write_bytes(b"compiled fixture")
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    def install(self, runner=None):
        with mock.patch("scripts.macos_menu_bar.platform.system", return_value="Darwin"):
            return install_menu_bar(self.codex_home, home=self.home, uid=501, compiler="fixture-swiftc",
                                    runner=runner or self.runner)

    def test_installs_owned_accessory_app_with_login_start_and_custom_port(self):
        result = self.install()
        app = Path(result["app"])
        info = plistlib.loads((app / "Contents/Info.plist").read_bytes())
        self.assertTrue(info["LSUIElement"])
        config = json.loads((app / "Contents/Resources/configuration.json").read_text())
        self.assertEqual(config, {"port": 12345, "instanceID": "owned-instance", "servicePlist": str(self.service)})
        agent = plistlib.loads(Path(result["login_item"]).read_bytes())
        self.assertTrue(agent["RunAtLoad"])
        self.assertFalse(agent["KeepAlive"])
        self.assertIn(["/bin/launchctl", "bootstrap", "gui/501", result["login_item"]], self.calls)
        self.assertTrue((self.codex_home / MANIFEST).is_file())
        self.assertFalse(any("com.route2.codex" in argument for call in self.calls for argument in call))

    def test_reinstall_and_remove_do_not_change_the_routing_service(self):
        self.install()
        self.install()
        result = uninstall_menu_bar(self.codex_home, home=self.home, uid=501, runner=self.runner)
        self.assertTrue(result["uninstalled"])
        self.assertFalse((self.codex_home / APP_NAME).exists())
        self.assertEqual(self.service.read_bytes(), b"owned service")
        self.assertTrue((self.codex_home / ".route2-codex-installer.json").exists())

    def test_preserves_user_edited_companion_files(self):
        self.install()
        executable = self.codex_home / APP_NAME / "Contents/MacOS/Route2Menu"
        executable.write_bytes(b"user edit")
        self.calls.clear()
        with self.assertRaisesRegex(MenuBarError, "preserving"):
            self.install()
        with self.assertRaisesRegex(MenuBarError, "preserving"):
            uninstall_menu_bar(self.codex_home, home=self.home, uid=501, runner=self.runner)
        self.assertEqual(executable.read_bytes(), b"user edit")
        self.assertEqual(self.calls, [])

    def test_refuses_unowned_login_item_and_changed_service(self):
        agent = self.home / f"Library/LaunchAgents/{LABEL}.plist"
        agent.write_bytes(b"user login item")
        with self.assertRaisesRegex(MenuBarError, "unowned"):
            self.install()
        agent.unlink()
        self.service.write_bytes(b"modified service")
        with self.assertRaisesRegex(MenuBarError, "ownership record"):
            self.install()
        self.assertEqual(self.calls, [])

    def test_failed_reinstall_restores_previous_app_and_ownership(self):
        self.install()
        manifest = self.codex_home / MANIFEST
        original = manifest.read_bytes()
        def failing_runner(arguments, **kwargs):
            result = self.runner(arguments, **kwargs)
            if arguments[:2] == ["/bin/launchctl", "bootstrap"]:
                result.returncode = 1
            return result
        with self.assertRaisesRegex(MenuBarError, "command failed"):
            self.install(failing_runner)
        self.assertEqual(manifest.read_bytes(), original)
        self.assertEqual((self.codex_home / APP_NAME / "Contents/MacOS/Route2Menu").read_bytes(), b"compiled fixture")

    def test_compiler_failure_makes_no_service_changes(self):
        def failing_runner(arguments, **kwargs):
            return SimpleNamespace(returncode=1)
        with self.assertRaises(MenuBarError):
            self.install(failing_runner)
        self.assertFalse((self.codex_home / APP_NAME).exists())
        self.assertFalse((self.codex_home / MANIFEST).exists())

    def test_prebuilt_companion_installs_without_swiftc(self):
        prebuilt = self.home / "prebuilt" / "Route2Menu"
        prebuilt.parent.mkdir(parents=True)
        prebuilt.write_bytes(b"prebuilt fixture")
        with mock.patch("scripts.macos_menu_bar.platform.system", return_value="Darwin"), \
             mock.patch("scripts.macos_menu_bar.shutil.which", return_value=None):
            result = install_menu_bar(self.codex_home, home=self.home, uid=501,
                                      prebuilt=prebuilt, runner=self.runner)
        executable = Path(result["app"]) / "Contents/MacOS/Route2Menu"
        self.assertEqual(executable.read_bytes(), b"prebuilt fixture")
        self.assertFalse(any(call[0] == "fixture-swiftc" for call in self.calls))

    def test_missing_prebuilt_and_compiler_errors(self):
        with mock.patch("scripts.macos_menu_bar.platform.system", return_value="Darwin"), \
             mock.patch("scripts.macos_menu_bar.shutil.which", return_value=None), \
             self.assertRaisesRegex(MenuBarError, "swiftc is unavailable"):
            install_menu_bar(self.codex_home, home=self.home, uid=501,
                             prebuilt=self.home / "missing", runner=self.runner)
        self.assertFalse((self.codex_home / APP_NAME).exists())

    def test_cli_setup_installs_companion_by_default_and_opt_out_skips_it(self):
        for extra, expected in [([], True), (["--no-menu-bar"], False)]:
            with self.subTest(extra=extra), mock.patch.object(install_codex, "install", return_value={"installed": True}), \
                 mock.patch.object(install_codex.platform, "system", return_value="Darwin"), \
                 mock.patch.object(install_codex, "install_menu_bar", return_value={"app": "fixture"}) as companion, \
                 mock.patch("builtins.print"):
                self.assertEqual(install_codex.main(["--install", "--codex-home", str(self.codex_home), *extra]), 0)
                self.assertEqual(companion.called, expected)

    def test_cli_companion_failure_does_not_fail_successful_provider_setup(self):
        with mock.patch.object(install_codex, "install", return_value={"installed": True}), \
             mock.patch.object(install_codex.platform, "system", return_value="Darwin"), \
             mock.patch.object(install_codex, "install_menu_bar", side_effect=MenuBarError("no compiler")), \
             mock.patch("builtins.print"):
            self.assertEqual(install_codex.main(["--install", "--codex-home", str(self.codex_home)]), 0)

    def test_cli_removes_companion_before_provider_and_refuses_changed_ownership(self):
        with mock.patch.object(install_codex.platform, "system", return_value="Darwin"), \
             mock.patch.object(install_codex, "uninstall") as provider, \
             mock.patch.object(install_codex, "uninstall_menu_bar", side_effect=MenuBarError("ownership changed")), \
             mock.patch("builtins.print"):
            self.assertEqual(install_codex.main(["--uninstall", "--codex-home", str(self.codex_home)]), 2)
            provider.assert_not_called()

    def test_preview_does_not_build_or_remove_companion(self):
        with mock.patch.object(install_codex.platform, "system", return_value="Darwin"), \
             mock.patch.object(install_codex, "install", return_value={"dry_run": True}), \
             mock.patch.object(install_codex, "install_menu_bar") as install_companion, \
             mock.patch.object(install_codex, "uninstall_menu_bar") as remove_companion, \
             mock.patch("builtins.print"):
            self.assertEqual(install_codex.main(["--codex-home", str(self.codex_home)]), 0)
            install_companion.assert_not_called()
            remove_companion.assert_not_called()

    @unittest.skipUnless(platform.system() == "Darwin" and shutil.which("swiftc"), "requires macOS Swift compiler")
    def test_native_bundle_compiles_and_pure_lifecycle_checks_pass(self):
        app = build_app(self.home / "native.app", {"port": 12345, "instanceID": "test", "servicePlist": str(self.service)},
                        prebuilt=self.home / "missing")
        self.assertTrue((app / "Contents/MacOS/Route2Menu").is_file())
        checks = self.home / "native-checks"
        subprocess.run([shutil.which("swiftc"), "-swift-version", "5", str(ROOT / "apps/macos/MenuBarState.swift"),
                        str(ROOT / "tests/macos_menu_bar_state_test.swift"), "-o", str(checks)], check=True, timeout=120)
        result = subprocess.run([str(checks)], check=True, capture_output=True, text=True, timeout=10)
        self.assertIn("checks passed", result.stdout)


if __name__ == "__main__":
    unittest.main()
