import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from scripts.diagnostics import collect_diagnostics, recent_events
from scripts.install_codex import main


class DiagnosticsTests(unittest.TestCase):
    def test_reports_downstream_decisions_without_prompt_or_credentials(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            (home / "config.toml").write_text('model_provider="route2"\nmodel="route2-router"\napi_key="secret"\n')
            (home / ".route2-codex-installer.json").write_text(json.dumps({"service": {"port": 12345}}))
            event = {"sessionId": "wanted", "model": "gpt-6.1-sol", "appliedEffort": "low",
                     "decision_time_ms": 1234, "task": "private prompt", "authorization": "secret"}
            (home / "route2-service.stderr.log").write_text("[Route2 request] " + json.dumps(event) + "\n")
            response = io.BytesIO(json.dumps({"service": "route2", "model": "gpt-6.1-sol",
                                             "classifier": {"state": "ready", "stage": "ready"},
                                             "token": "secret"}).encode())
            opener = mock.Mock(return_value=response)
            report = collect_diagnostics(home, session="wanted", opener=opener)
            opener.assert_called_once_with("http://127.0.0.1:12345/health", timeout=2)
            self.assertEqual(report["configured_model"], "route2-router")
            self.assertEqual(report["recent_events"][0]["appliedEffort"], "low")
            self.assertEqual(report["recent_events"][0]["decision_time_ms"], 1234)
            self.assertEqual(report["health"]["classifier"]["state"], "ready")
            self.assertNotIn("secret", json.dumps(report))
            self.assertNotIn("private prompt", json.dumps(report))

    def test_missing_logs_and_service_report_unknown_not_success(self):
        with tempfile.TemporaryDirectory() as directory:
            opener = mock.Mock(side_effect=OSError("offline"))
            report = collect_diagnostics(directory, opener=opener)
            self.assertFalse(report["log_available"])
            self.assertIsNone(report["health"])
            self.assertIn("cannot be verified", report["telemetry_note"])
            self.assertIsNotNone(report["health_error"])

    def test_session_filter_and_limit_ignore_unrelated_and_malformed_lines(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "log"
            lines = ["[Route2 request] not-json", "raw private task", "[Route2 request] []"]
            for index in range(15):
                lines.append("[Route2 request] " + json.dumps({"sessionId": "wanted", "latencyMs": index}))
            lines.append('[Route2 request] {"sessionId":"other","latencyMs":999}')
            path.write_text("\n".join(lines))
            events = recent_events(path, session="wanted", limit=3)
            self.assertEqual([event["latencyMs"] for event in events], [12, 13, 14])

    def test_diagnostic_cli_never_resolves_tools_provisions_or_installs(self):
        with tempfile.TemporaryDirectory() as directory, \
                mock.patch("scripts.install_codex.install") as install, \
                mock.patch("scripts.install_codex.provision_classifier") as provision, \
                mock.patch("scripts.install_codex.collect_diagnostics", return_value={"health": None}) as collect, \
                mock.patch("sys.stdout", new_callable=io.StringIO) as output:
            self.assertEqual(main(["--diagnostics", "--codex-home", directory, "--session", "wanted"]), 0)
            install.assert_not_called()
            provision.assert_not_called()
            collect.assert_called_once_with(Path(directory).resolve(), port=None, session="wanted")
            self.assertEqual(json.loads(output.getvalue()), {"health": None})


if __name__ == "__main__":
    unittest.main()
