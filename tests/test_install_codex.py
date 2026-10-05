"""Fixture-only tests for the Codex automatic-routing installer."""

from __future__ import annotations

import json
import dataclasses
import plistlib
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import tomllib

from scripts.install_codex import (
    CatalogError,
    ConfigConflict,
    InstallerError,
    ServiceManager,
    ServiceSpec,
    ServiceError,
    build_classifier_prepare_command,
    resolve_node,
    resolve_uv,
    add_router_model,
    install,
    uninstall,
)


class FixtureService(ServiceManager):
    """A temp-file service adapter; no host service manager is invoked."""

    def __init__(self, home: Path, healthy: bool = True) -> None:
        calls: list[list[str]] = []

        def runner(argv, **_kwargs):
            calls.append(list(argv))
            return SimpleNamespace(returncode=0, stdout="", stderr="")

        super().__init__(
            system="Darwin",
            home=home,
            runner=runner,
            health_checker=lambda _port: healthy,
        )
        self.calls = calls


class InstallerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.home = Path(self.temp.name) / ".codex"
        self.home.mkdir()
        self.node = Path(self.temp.name) / "node"
        self.router = Path(self.temp.name) / "route2"
        # Resolution and Node's platform-specific executable probe are unit
        # tested separately; these fixture tests inject the already-resolved
        # paths rather than depending on the developer's macOS installation.
        self._node_resolution = mock.patch(
            "scripts.install_codex.resolve_node", return_value=self.node
        )
        self._router_resolution = mock.patch(
            "scripts.install_codex.resolve_router", return_value=self.router
        )
        self._uv_resolution = mock.patch("scripts.install_codex.resolve_uv", return_value=Path(self.temp.name) / "tools" / "uv")
        self._curl_resolution = mock.patch("scripts.install_codex.resolve_curl", return_value=Path(self.temp.name) / "tools" / "curl")
        self._provision = mock.patch(
            "scripts.install_codex.provision_classifier",
            return_value={"cache_root": str(Path(self.temp.name) / "classifier-cache")},
        )
        self._uv_resolution.start()
        self._curl_resolution.start()
        self.provision_mock = self._provision.start()
        self.addCleanup(self._uv_resolution.stop)
        self.addCleanup(self._curl_resolution.stop)
        self.addCleanup(self._provision.stop)
        self._node_resolution.start()
        self._router_resolution.start()
        self.addCleanup(self._node_resolution.stop)
        self.addCleanup(self._router_resolution.stop)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def write_catalog(self, models: list[dict]) -> None:
        (self.home / "models_cache.json").write_text(
            json.dumps(
                {
                    "fetched_at": "fixture",
                    "identity": "fixture-account",
                    "models": models,
                }
            ),
            encoding="utf-8",
        )

    def install_once(self, *, config: str, upstream: str = "https://provider.example/v1"):
        (self.home / "config.toml").write_text(config, encoding="utf-8")
        self.write_catalog(
            [
                {
                    "slug": "gpt-6.1-sol",
                    "display_name": "GPT-6.1-Sol",
                    "description": "fixture",
                    "supported_reasoning_levels": [{"effort": "low"}],
                },
                {"slug": "keep-model", "display_name": "Keep"},
            ]
        )
        service = FixtureService(self.home)
        result = install(
            codex_home=self.home,
            upstream=upstream,
            router=self.router,
            node=self.node,
            dry_run=False,
            service_manager=service,
        )
        return result, service

    def test_catalog_clone_preserves_all_existing_entries(self) -> None:
        original = {
            "meta": {"etag": "keep"},
            "models": [
                {"slug": "gpt-6.1-sol", "priority": 1, "nested": {"keep": True}},
                {"slug": "other", "display_name": "Other"},
            ],
        }
        result = add_router_model(original)
        self.assertEqual(result["meta"], original["meta"])
        self.assertEqual(result["models"][1:], original["models"])
        self.assertEqual(result["models"][0]["slug"], "route2-router")
        self.assertEqual(result["models"][0]["nested"], {"keep": True})
        self.assertEqual(original["models"][0]["slug"], "gpt-6.1-sol")

    def test_prepare_command_reuses_pinned_classifier_dependencies(self) -> None:
        command = build_classifier_prepare_command(
            self.temp.name + "/uv",
            source_dir=Path(self.temp.name) / "route2",
            cache_root=Path(self.temp.name) / "cache",
        )
        self.assertEqual(command[0], self.temp.name + "/uv")
        self.assertIn("--prepare-only", command)
        self.assertIn("--with", command)
        self.assertIn("transformers==5.17.0", command)
        self.assertIn("torch==2.12.0", command)
        self.assertIn("safetensors==0.8.0", command)

    def test_dry_run_never_provisions_classifier(self) -> None:
        self.write_catalog([{"slug": "gpt-6.1-sol"}])
        (self.home / "config.toml").write_text(
            'model = "gpt-6.1-sol"\nmodel_provider = "openai"\n',
            encoding="utf-8",
        )
        result = install(
            codex_home=self.home,
            upstream="https://provider.example/v1",
            router=self.router,
            node=self.node,
            dry_run=True,
            service_manager=FixtureService(self.home),
        )
        self.assertTrue(result["dry_run"])
        self.provision_mock.assert_not_called()
        self.assertFalse((self.home / "route2-models.json").exists())

    def test_provision_runs_before_service_and_config_switch(self) -> None:
        original = 'model = "gpt-6.1-sol"\nmodel_provider = "openai"\n'
        (self.home / "config.toml").write_text(original, encoding="utf-8")
        self.write_catalog([{"slug": "gpt-6.1-sol"}])
        observed: list[str] = []

        def provision(*_args, **_kwargs):
            observed.append((self.home / "config.toml").read_text())
            return {"cache_root": str(self.home / "classifier-cache")}

        result = install(
            codex_home=self.home,
            upstream="https://provider.example/v1",
            router=self.router,
            node=self.node,
            dry_run=False,
            service_manager=FixtureService(self.home),
            provisioner=provision,
        )
        self.assertTrue(result["installed"])
        self.assertEqual(observed, [original])
        self.assertNotEqual((self.home / "config.toml").read_text(), original)

    def test_provision_failure_leaves_service_and_config_untouched(self) -> None:
        original = 'model = "gpt-6.1-sol"\nmodel_provider = "openai"\n'
        (self.home / "config.toml").write_text(original, encoding="utf-8")
        self.write_catalog([{"slug": "gpt-6.1-sol"}])
        service = FixtureService(self.home)

        def fail(*_args, **_kwargs):
            raise InstallerError("classifier provisioning failed")

        with self.assertRaisesRegex(InstallerError, "classifier provisioning failed"):
            install(
                codex_home=self.home,
                upstream="https://provider.example/v1",
                router=self.router,
                node=self.node,
                dry_run=False,
                service_manager=service,
                provisioner=fail,
            )
        self.assertEqual((self.home / "config.toml").read_text(), original)
        self.assertFalse(service.path.exists())
        self.assertFalse((self.home / "route2-models.json").exists())

    def test_external_classifier_policy_skips_embedded_provisioning(self) -> None:
        policy = Path(self.temp.name) / "external-route2.json"
        policy.write_text(
            json.dumps({
                "backend": "decision",
                "decision": {
                    "endpoint": "https://classifier.example/v1/systemone",
                    "model": "external-classifier",
                    "command": "external-classifier",
                    "args": [],
                },
            }),
            encoding="utf-8",
        )
        self.write_catalog([{"slug": "gpt-6.1-sol"}])
        (self.home / "config.toml").write_text(
            'model = "gpt-6.1-sol"\nmodel_provider = "openai"\n',
            encoding="utf-8",
        )
        with mock.patch.dict(os.environ, {"ROUTE2_CONFIG": str(policy)}):
            result = install(
                codex_home=self.home,
                upstream="https://provider.example/v1",
                router=self.router,
                node=self.node,
                dry_run=False,
                service_manager=FixtureService(self.home),
            )
        self.assertEqual(result["classifier_provision"], "external-policy")
        self.assertFalse(result["classifier_provisioned"])
        self.provision_mock.assert_not_called()
        service_definition = self.home / "Library" / "LaunchAgents" / "com.route2.codex.plist"
        self.assertIn("ROUTE2_CONFIG", service_definition.read_text())

    def test_health_checker_waits_for_classifier_ready(self) -> None:
        states = [
            {"classifier": {"state": "loading", "phase": "loading weights"}},
            {"classifier": {"state": "ready"}},
        ]
        progress: list[str] = []
        manager = ServiceManager(
            system="Darwin",
            home=Path(self.temp.name),
            health_checker=lambda _port: states.pop(0),
        )
        manager.wait_for_health(10509, timeout=2, progress=progress.append)
        self.assertEqual(
            progress,
            ["Classifier state is loading; phase loading weights", "Classifier is ready"],
        )

    def test_health_checker_rejects_listener_without_classifier_state(self) -> None:
        manager = ServiceManager(
            system="Darwin",
            home=Path(self.temp.name),
            health_checker=lambda _port: {"service": "route2", "model": "gpt-6.1-sol"},
        )
        with self.assertRaisesRegex(ServiceError, "classifier.state"):
            manager.wait_for_health(10509, timeout=1)

    def test_install_preserves_unrelated_toml_and_repeat_is_idempotent(self) -> None:
        original = (
            "# user comment\n"
            'model = "gpt-6.1-sol" # selected by user\n'
            'model_provider = "openai"\n'
            'custom_setting = "keep"\n\n'
            "[features]\n"
            "js_repl = false\n"
        )
        result, service = self.install_once(config=original)
        self.assertTrue(result["installed"])
        config_path = self.home / "config.toml"
        installed_bytes = config_path.read_bytes()
        parsed = tomllib.loads(installed_bytes.decode())
        self.assertEqual(parsed["model"], "route2-router")
        self.assertEqual(parsed["model_provider"], "route2")
        self.assertEqual(parsed["custom_setting"], "keep")
        self.assertFalse(parsed["features"]["js_repl"])
        self.assertEqual(parsed["model_providers"]["route2"]["base_url"], "http://127.0.0.1:10509")
        self.assertTrue((self.home / "config.toml.route2-backup").is_file())
        self.assertEqual(len(json.loads((self.home / "route2-models.json").read_text())["models"]), 3)
        self.assertGreaterEqual(len(service.calls), 2)

        second_service = FixtureService(self.home)
        second = install(
            codex_home=self.home,
            upstream="https://provider.example/v1",
            router=self.router,
            node=self.node,
            dry_run=False,
            service_manager=second_service,
        )
        self.assertTrue(second["installed"])
        self.assertEqual(config_path.read_bytes(), installed_bytes)
        text = config_path.read_text()
        self.assertEqual(text.count("[model_providers.route2]"), 1)
        self.assertEqual(text.count("model = "), 1)
        self.assertEqual(text.count("model_provider = "), 1)
        removed = uninstall(
            codex_home=self.home,
            dry_run=False,
            service_manager=FixtureService(self.home),
        )
        self.assertTrue(removed["uninstalled"])
        self.assertEqual(config_path.read_text(), original)

    def test_install_handles_config_without_final_newline(self) -> None:
        original = 'unrelated = "keep"'
        self.install_once(config=original)
        config_path = self.home / "config.toml"
        self.assertEqual(tomllib.loads(config_path.read_text())["model"], "route2-router")
        removed = uninstall(
            codex_home=self.home,
            dry_run=False,
            service_manager=FixtureService(self.home),
        )
        self.assertTrue(removed["uninstalled"])
        self.assertEqual(config_path.read_text(), original)

    def test_uninstall_restores_owned_lines_and_preserves_later_user_edit(self) -> None:
        original = 'model = "gpt-6.1-sol"\nmodel_provider = "openai"\n\n[features]\nkeep = true\n'
        self.install_once(config=original)
        config_path = self.home / "config.toml"
        with config_path.open("a", encoding="utf-8") as handle:
            handle.write('\n[user_later]\nvalue = "preserve"\n')
        result = uninstall(
            codex_home=self.home,
            dry_run=False,
            service_manager=FixtureService(self.home),
        )
        self.assertTrue(result["uninstalled"])
        restored = config_path.read_text()
        self.assertIn('model = "gpt-6.1-sol"', restored)
        self.assertIn('model_provider = "openai"', restored)
        self.assertIn('value = "preserve"', restored)
        self.assertNotIn("[model_providers.route2]", restored)
        self.assertFalse((self.home / "route2-models.json").exists())
        self.assertFalse((self.home / ".route2-codex-installer.json").exists())

    def test_missing_sol_rejects_without_writing(self) -> None:
        config = 'model = "gpt-6.1-sol"\nmodel_provider = "openai"\n'
        (self.home / "config.toml").write_text(config, encoding="utf-8")
        self.write_catalog([{"slug": "gpt-6-astra"}])
        with self.assertRaises(CatalogError):
            install(
                codex_home=self.home,
                upstream="https://provider.example/v1",
                router=self.router,
                node=self.node,
                dry_run=False,
                service_manager=FixtureService(self.home),
            )
        self.assertEqual((self.home / "config.toml").read_text(), config)
        self.assertFalse((self.home / ".route2-codex-installer.json").exists())

    def test_health_failure_rolls_back_service_before_config_switch(self) -> None:
        config = 'model = "gpt-6.1-sol"\nmodel_provider = "openai"\n'
        (self.home / "config.toml").write_text(config, encoding="utf-8")
        self.write_catalog([{"slug": "gpt-6.1-sol"}])
        service = FixtureService(self.home, healthy=False)
        with self.assertRaises(InstallerError):
            install(
                codex_home=self.home,
                upstream="https://provider.example/v1",
                router=self.router,
                node=self.node,
                dry_run=False,
                service_manager=service,
            )
        self.assertEqual((self.home / "config.toml").read_text(), config)
        self.assertFalse((self.home / "config.toml.route2-backup").exists())
        self.assertFalse((self.home / "route2-models.json").exists())
        self.assertFalse((self.home / ".route2-codex-installer.json").exists())
        self.assertFalse(service.path.exists())

    def test_alternate_provider_requires_explicit_upstream(self) -> None:
        config = 'model = "gpt-6.1-sol"\nmodel_provider = "anthropic"\n'
        (self.home / "config.toml").write_text(config, encoding="utf-8")
        self.write_catalog([{"slug": "gpt-6.1-sol"}])
        (self.home / "auth.json").write_text(
            json.dumps({"auth_mode": "chatgpt", "tokens": {"access_token": "secret"}}),
            encoding="utf-8",
        )
        with self.assertRaises(InstallerError):
            install(
                codex_home=self.home,
                upstream=None,
                router=self.router,
                node=self.node,
                dry_run=True,
                service_manager=FixtureService(self.home),
            )
        self.assertEqual((self.home / "config.toml").read_text(), config)

    def test_chatgpt_default_requires_metadata_but_does_not_persist_auth(self) -> None:
        config = 'model = "gpt-6.1-sol"\nmodel_provider = "openai"\n'
        (self.home / "config.toml").write_text(config, encoding="utf-8")
        self.write_catalog([{"slug": "gpt-6.1-sol"}])
        with self.assertRaises(InstallerError):
            install(
                codex_home=self.home,
                upstream=None,
                router=self.router,
                node=self.node,
                dry_run=True,
                service_manager=FixtureService(self.home),
            )
        (self.home / "auth.json").write_text(
            json.dumps({"auth_mode": "chatgpt", "OPENAI_API_KEY": "secret"}),
            encoding="utf-8",
        )
        result = install(
            codex_home=self.home,
            upstream=None,
            router=self.router,
            node=self.node,
            dry_run=True,
            service_manager=FixtureService(self.home),
        )
        self.assertEqual(result["upstream"], "https://chatgpt.com/backend-api/codex")
        self.assertNotIn("OPENAI_API_KEY", json.dumps(result))

    def test_uninstall_preserves_owned_line_if_user_changed_it(self) -> None:
        self.install_once(config='model = "gpt-6.1-sol"\nmodel_provider = "openai"\n')
        config_path = self.home / "config.toml"
        text = config_path.read_text().replace('model = "route2-router"', 'model = "user-selected-model"')
        config_path.write_text(text, encoding="utf-8")
        result = uninstall(
            codex_home=self.home,
            dry_run=False,
            service_manager=FixtureService(self.home),
        )
        self.assertFalse(result["uninstalled"])
        self.assertIn("model = \"user-selected-model\"", config_path.read_text())
        self.assertIn('model_provider = "openai"', config_path.read_text())
        self.assertNotIn("[model_providers.route2]", config_path.read_text())
        self.assertTrue((self.home / ".route2-codex-installer.json").exists())


class PlatformServiceTests(unittest.TestCase):
    def spec(self, directory):
        home = Path(directory)
        return ServiceSpec(home / "node path" / "node", home / "router path" / "route2",
                           "https://provider.example/v1", 10509, home / "checkout space",
                           home / ".codex", "fixture-instance", "/opt/homebrew/bin:/usr/bin:/bin")

    def test_macos_reinstall_starts_a_stopped_unchanged_service_without_restarting_a_running_one(self):
        with tempfile.TemporaryDirectory() as directory:
            calls = []
            loaded = True
            def runner(arguments, **kwargs):
                calls.append(list(arguments))
                return SimpleNamespace(returncode=1 if "print" in arguments and not loaded else 0)
            manager = ServiceManager(system="Darwin", home=Path(directory), runner=runner)
            spec = self.spec(directory)
            original = manager.install(spec)
            state = {"service": {"sha256": original.new_hash}}
            for loaded in (True, False):
                calls.clear()
                result = manager.install(spec, state)
                self.assertFalse(result.changed)
                self.assertTrue(any("enable" in command for command in calls))
                self.assertTrue(any("kickstart" in command for command in calls))
                self.assertFalse(any("bootout" in command or "-k" in command for command in calls))
                self.assertEqual(any("bootstrap" in command for command in calls), not loaded)

    def test_macos_install_start_and_remove_without_host_mutation(self):
        with tempfile.TemporaryDirectory() as directory:
            calls = []
            runner = lambda argv, **kwargs: calls.append(list(argv)) or SimpleNamespace(returncode=0, stdout="", stderr="")
            manager = ServiceManager(system="Darwin", home=Path(directory), runner=runner, health_checker=lambda port: True)
            spec = self.spec(directory)
            result = manager.install(spec)
            rendered = plistlib.loads(result.path.read_bytes())
            self.assertTrue(rendered["KeepAlive"])
            self.assertTrue(rendered["RunAtLoad"])
            self.assertEqual(rendered["EnvironmentVariables"]["PATH"], spec.path_env)
            manager.wait_for_health(10509, instance_id=spec.instance_id)
            self.assertTrue(any("bootstrap" in call for call in calls))
            manager.rollback(result)
            self.assertFalse(result.path.exists())

    def test_non_macos_platforms_are_rejected_before_runtime_or_config_reads(self):
        for system in ("Windows", "Linux"):
            with self.subTest(system=system), tempfile.TemporaryDirectory() as directory:
                manager = ServiceManager(system=system, home=Path(directory), runner=mock.Mock())
                self.assertFalse(manager.supported)
                with self.assertRaisesRegex(ServiceError, "macOS and Codex only"):
                    manager.render(self.spec(directory))
                with mock.patch("scripts.install_codex._read_config") as read_config:
                    with self.assertRaisesRegex(ServiceError, "macOS and Codex only"):
                        install(codex_home=Path(directory), upstream=None, service_manager=manager, dry_run=False)
                    read_config.assert_not_called()
                with mock.patch("scripts.install_codex._load_state") as load_state:
                    with self.assertRaisesRegex(ServiceError, "macOS and Codex only"):
                        uninstall(codex_home=Path(directory), service_manager=manager, dry_run=False)
                    load_state.assert_not_called()
                manager.runner.assert_not_called()

    def test_missing_uv_has_actionable_error(self):
        with mock.patch("scripts.install_codex.shutil.which", return_value=None), \
             mock.patch("scripts.install_codex._tool_candidates", return_value=[]):
            with self.assertRaisesRegex(InstallerError, "uv is required"):
                resolve_uv()

    def test_explicit_invalid_tool_path_does_not_silently_use_another_install(self):
        with mock.patch("scripts.install_codex._tool_candidates") as fallback:
            with self.assertRaises(InstallerError):
                resolve_node("/missing/explicit/node")
            fallback.assert_not_called()


if __name__ == "__main__":
    unittest.main()
