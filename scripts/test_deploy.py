"""Exercise the real deployment script with simulated Docker and HTTP failures."""

import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
NEW_SHA = "a" * 40
OLD_SHA = "b" * 40
OLD_IMAGE = "sha256:" + "c" * 64
NEW_IMAGE = f"ghcr.io/trybenon/web-dev:{NEW_SHA}"

STUB = r'''#!/usr/bin/env python3
import json, os, pathlib, sys
p = pathlib.Path(os.environ["FAKE_STATE"])
s = json.loads(p.read_text())
tool, args = pathlib.Path(sys.argv[0]).name, sys.argv[1:]
s["calls"].append([tool] + args)
code, out = 0, ""
if tool in ("flock", "sleep"):
    pass
elif tool == "curl":
    sha = s.get("current_sha", "")
    if s.get("public_mismatch") and args[-1].startswith("https:") and sha == s["new_sha"]:
        sha = "stale"
    if s.get("local_mismatch") and args[-1].startswith("http:") and sha == s["new_sha"]:
        sha = "wrong-image"
    out = json.dumps({"status": "ok", "sha": sha})
elif args[:1] == ["pull"]:
    code = 1 if s.get("pull_failure") else 0
elif args[:2] == ["container", "inspect"]:
    code = 0 if s.get("exists") else 1
elif args[:1] == ["inspect"]:
    fmt = args[2]
    if fmt == "{{.Image}}": out = s["old_image"]
    elif "Config.Env" in fmt: out = "APP_RELEASE=" + s.get("old_sha", "")
    else: out = s.get("project", "")
elif args[:1] == ["stop"]:
    s["stopped"] = True
elif args[:1] == ["rename"]:
    if s.get("rename_failure") and args[1] == "watch-together-web":
        code = 1
    else:
        s["backup"] = args[2] != "watch-together-web"
elif args[:1] == ["start"]:
    s["exists"], s["stopped"], s["current_sha"] = True, False, s.get("old_sha", "")
elif args[:1] == ["compose"]:
    if "pull" in args:
        code = 1 if s.get("pull_failure") else 0
    elif "config" in args:
        code = 1 if s.get("config_failure") else 0
    elif "up" in args:
        env = dict(line.split("=", 1) for line in pathlib.Path(".env").read_text().splitlines())
        candidate = env["APP_IMAGE"] != s["old_image"]
        s["current_sha"] = s["new_sha"] if candidate else s["old_sha"]
        s["exists"] = True
        code = 1 if candidate and s.get("up_failure") else 0
    elif "rm" in args:
        s["exists"] = False
p.write_text(json.dumps(s))
if out: print(out)
sys.exit(code)
'''


class DeployTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="deploy-test-")
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.bin = self.directory / "bin"
        self.bin.mkdir()
        for tool in ("docker", "curl", "sleep", "flock"):
            stub = self.bin / tool
            stub.write_text(STUB)
            stub.chmod(0o755)
        self.state_dir = self.directory / "deployment"
        self.state_dir.mkdir()
        self.state_file = self.directory / "docker.json"
        self.state = {
            "calls": [], "exists": True, "project": "watch-together",
            "old_image": OLD_IMAGE, "old_sha": OLD_SHA,
            "current_sha": OLD_SHA, "new_sha": NEW_SHA,
        }
        self.old_env = f"APP_IMAGE=ghcr.io/trybenon/web-dev:{OLD_SHA}\nAPP_SHA={OLD_SHA}\n"
        (self.state_dir / ".env").write_text(self.old_env)
        shutil.copyfile(ROOT / "deploy/compose.yml", self.state_dir / "compose.yml")

    def run_deploy(self, monitoring_env=None, **changes):
        self.state.update(changes)
        self.state_file.write_text(json.dumps(self.state))
        args = ["bash", str(ROOT / "scripts/deploy.sh"), NEW_IMAGE, NEW_SHA,
                str(ROOT / "deploy/compose.yml"), str(self.state_dir)]
        if monitoring_env is not None:
            candidate = self.directory / "candidate-monitoring.env"
            candidate.write_text(monitoring_env)
            args.extend(["https://krozmo.online/api/health", str(candidate)])
        result = subprocess.run(
            args,
            env={**os.environ, "PATH": f"{self.bin}:{os.environ['PATH']}",
                 "FAKE_STATE": str(self.state_file)},
            capture_output=True, text=True, timeout=30,
        )
        self.state = json.loads(self.state_file.read_text())
        return result

    def test_success_records_exact_previous_image(self):
        result = self.run_deploy()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(NEW_SHA, (self.state_dir / ".env").read_text())
        self.assertIn(OLD_IMAGE, (self.state_dir / "previous.env").read_text())
        self.assertEqual(self.state["current_sha"], NEW_SHA)

    def test_monitoring_configuration_is_deployed_and_saved_for_rollback(self):
        old_monitoring = "BUGSINK_DSN='https://old@bugsink.invalid/1'\n"
        new_monitoring = "BUGSINK_DSN='https://new@bugsink.invalid/1'\n"
        (self.state_dir / "monitoring.env").write_text(old_monitoring)
        result = self.run_deploy(monitoring_env=new_monitoring)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.state_dir / "monitoring.env").read_text(), new_monitoring)
        self.assertEqual((self.state_dir / "previous-monitoring.env").read_text(), old_monitoring)

    def test_failed_deploy_restores_previous_monitoring_configuration(self):
        old_monitoring = "BUGSINK_DSN='https://old@bugsink.invalid/1'\n"
        (self.state_dir / "monitoring.env").write_text(old_monitoring)
        result = self.run_deploy(monitoring_env="BUGSINK_DSN='https://new@bugsink.invalid/1'\n", public_mismatch=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((self.state_dir / "monitoring.env").read_text(), old_monitoring)

    def test_failed_first_deploy_removes_new_monitoring_configuration(self):
        result = self.run_deploy(monitoring_env="BUGSINK_DSN='https://new@bugsink.invalid/1'\n", up_failure=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.state_dir / "monitoring.env").exists())

    def test_registry_failure_leaves_running_application_untouched(self):
        result = self.run_deploy(pull_failure=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((self.state_dir / ".env").read_text(), self.old_env)
        self.assertFalse(any("up" in call or "stop" in call for call in self.state["calls"]))

    def test_invalid_compose_restores_state_without_restarting(self):
        result = self.run_deploy(config_failure=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((self.state_dir / ".env").read_text(), self.old_env)
        self.assertFalse(any("up" in call for call in self.state["calls"]))

    def test_failed_container_start_rolls_back(self):
        result = self.run_deploy(up_failure=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.state["current_sha"], OLD_SHA)
        self.assertEqual((self.state_dir / ".env").read_text(), self.old_env)

    def test_public_sha_mismatch_rolls_back(self):
        result = self.run_deploy(public_mismatch=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.state["current_sha"], OLD_SHA)
        self.assertIn("Previous state restored", result.stderr)

    def test_wrong_local_image_rolls_back_before_public_check(self):
        result = self.run_deploy(local_mismatch=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.state["current_sha"], OLD_SHA)

    def test_first_deployment_preserves_legacy_container(self):
        (self.state_dir / ".env").unlink()
        (self.state_dir / "compose.yml").unlink()
        result = self.run_deploy(project="", old_sha="")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(self.state["backup"])
        self.assertIn("Original container retained", result.stdout)

    def test_first_deployment_failure_restores_legacy_container(self):
        (self.state_dir / ".env").unlink()
        (self.state_dir / "compose.yml").unlink()
        result = self.run_deploy(project="", old_sha="", public_mismatch=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.state["current_sha"], "")
        self.assertFalse(self.state["backup"])
        self.assertFalse(self.state["stopped"])
        self.assertFalse((self.state_dir / ".env").exists())

    def test_rename_failure_restarts_original_container(self):
        result = self.run_deploy(project="", rename_failure=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.state["stopped"])
        self.assertEqual(self.state["current_sha"], OLD_SHA)
        self.assertEqual((self.state_dir / ".env").read_text(), self.old_env)

    def test_other_compose_project_is_rejected(self):
        result = self.run_deploy(project="other-project")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(any("stop" in call or "up" in call for call in self.state["calls"]))

    def test_empty_server_failure_removes_failed_candidate(self):
        (self.state_dir / ".env").unlink()
        (self.state_dir / "compose.yml").unlink()
        result = self.run_deploy(exists=False, up_failure=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.state["exists"])
        self.assertFalse((self.state_dir / ".env").exists())
        self.assertFalse((self.state_dir / "compose.yml").exists())


if __name__ == "__main__":
    unittest.main()
