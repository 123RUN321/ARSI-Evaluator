"""Controlled Git failures and frozen-runtime install protocol; no network or Docker."""
import importlib.util
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("verifier_build", sys.argv.pop(1))
build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build)
COMMIT = "a" * 40


class VerifierBuildTests(unittest.TestCase):
    def test_command_timeouts_and_nonzero_exits_propagate(self):
        with self.assertRaises(subprocess.TimeoutExpired):
            build.run_bounded([sys.executable, "-c", "import time; time.sleep(10)"], timeout=0.05)
        with self.assertRaises(subprocess.CalledProcessError):
            build.run_bounded([sys.executable, "-c", "raise SystemExit(7)"], timeout=5)

    def test_locked_harbor_uses_the_commit_not_a_mutable_tag(self):
        lock = {"package": [{"name": "harbor", "source": {"git": "https://github.com/harbor-framework/harbor.git?tag=v0.18.0#" + COMMIT}}]}
        self.assertEqual(build.locked_harbor(lock), ("https://github.com/harbor-framework/harbor.git", COMMIT))
        lock["package"][0]["source"]["git"] = "https://github.com/harbor-framework/harbor.git?tag=main"
        with self.assertRaises(ValueError):
            build.locked_harbor(lock)

    def test_git_mirror_and_transient_timeout_preserve_the_pinned_checkout(self):
        calls, sleeps = [], []
        def run(args, **options):
            calls.append((args, options))
            if "fetch" in args and sum("fetch" in call[0] for call in calls) < 3:
                raise subprocess.TimeoutExpired(args, options["timeout"])
        with patch.dict(os.environ, {"EVALUATOR_GITHUB_MIRROR": "https://git.example/https://github.com/"}):
            build.fetch_checkout(build.WORKBUDDY_REPOSITORY, COMMIT, Path("fixture"), run=run, sleep=sleeps.append)
        self.assertEqual(sleeps, [2, 4])
        self.assertEqual([call[0][-1] for call in calls if "fetch" in call[0]], [COMMIT] * 3)
        self.assertTrue(all(call[1]["timeout"] == 120 for call in calls if "fetch" in call[0]))
        self.assertTrue(all(call[1]["env"]["GIT_TERMINAL_PROMPT"] == "0" for call in calls if "fetch" in call[0]))
        self.assertIn("https://git.example/https://github.com/Tencent/workbuddy-bench.git", calls[1][0])
        self.assertEqual(calls[-1][0][-3:], ["checkout", "--detach", COMMIT])

    def test_git_stops_after_three_failed_attempts(self):
        attempts = []
        def run(args, **options):
            if "fetch" in args:
                attempts.append(args)
                raise subprocess.CalledProcessError(128, args)
        with self.assertRaises(subprocess.CalledProcessError):
            build.fetch_checkout(build.WORKBUDDY_REPOSITORY, COMMIT, Path("fixture"), run=run, sleep=lambda _: None)
        self.assertEqual(len(attempts), 3)

    def test_git_rejects_credentials_and_mutable_revisions_before_running(self):
        calls = []
        with patch.dict(os.environ, {"EVALUATOR_GITHUB_MIRROR": "https://user:secret@git.example/"}):
            with self.assertRaisesRegex(ValueError, "credential-free"):
                build.fetch_checkout(build.WORKBUDDY_REPOSITORY, COMMIT, Path("fixture"), run=lambda *args, **kwargs: calls.append(args))
        with self.assertRaises(ValueError):
            build.fetch_checkout(build.WORKBUDDY_REPOSITORY, "main", Path("fixture"), run=lambda *args, **kwargs: calls.append(args))
        self.assertEqual(calls, [])

    def test_install_uses_locked_hashes_and_the_selected_index(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "uv.lock").write_bytes(b"locked input")
            calls = []
            with patch.dict(os.environ, {"PIP_INDEX_URL": "https://python.example/simple"}):
                build.install_dependencies(root, root / "harbor", run=lambda args, **options: calls.append((args, options)))
            self.assertIn("--frozen", calls[0][0])
            self.assertIn("--offline", calls[0][0])
            installs = [call for call in calls if "install" in call[0]]
            self.assertIn("--require-hashes", installs[0][0])
            self.assertTrue(all("--no-deps" in call[0] and "https://python.example/simple" in call[0] for call in installs))
            self.assertEqual((root / "uv.lock").read_bytes(), b"locked input")

    def test_a_changed_dependency_lock_fails_the_build(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "uv.lock").write_bytes(b"locked input")
            def run(args, **options):
                (root / "uv.lock").write_bytes(b"changed input")
            with patch.dict(os.environ, {"PIP_INDEX_URL": "https://python.example/simple"}):
                with self.assertRaisesRegex(RuntimeError, "changed the upstream dependency lock"):
                    build.install_dependencies(root, root / "harbor", run=run)

    def test_public_index_retries_only_the_download_with_the_same_requirements(self):
        mirror = "https://mirrors.aliyun.com/pypi/simple"
        calls = []
        def run(args, **options):
            calls.append(args)
            if len(calls) == 1:
                raise subprocess.CalledProcessError(1, args, output=mirror + " HTTP 503")
        build.install_from_public_index(
            lambda index: ["uv", "pip", "install", "--require-hashes", "-r", "locked.txt", "--default-index", index],
            mirror, run=run, timeout=5, env={},
        )
        self.assertEqual(calls[0][:-1], calls[1][:-1])
        self.assertEqual([call[-1] for call in calls], [mirror, build.OFFICIAL_PYPI])

    def test_private_indices_and_integrity_errors_keep_the_configured_source(self):
        for index, diagnostic in [
            ("https://private.example/simple", "HTTP 503"),
            ("https://mirrors.aliyun.com/pypi/simple", "hash mismatch"),
        ]:
            calls = []
            def run(args, **options):
                calls.append(args)
                raise subprocess.CalledProcessError(1, args, output=index + " " + diagnostic)
            with self.assertRaises(subprocess.CalledProcessError):
                build.install_from_public_index(lambda source: ["pip", "download", "--index-url", source], index,
                                                run=run, timeout=5, env={})
            self.assertEqual(len(calls), 1)

    def test_declared_public_index_tries_repository_mirror_then_official(self):
        index = "https://public.example/simple"
        calls = []
        def run(args, **options):
            calls.append((args[-1], options["env"]))
            if args[-1] != build.OFFICIAL_PYPI:
                raise subprocess.CalledProcessError(1, args, output=args[-1] + " HTTP 503")
        build.install_from_public_index(lambda source: ["pip", "download", "--index-url", source],
                                        index, run=run, timeout=5,
                                        env={"EVALUATOR_PYPI_PUBLIC_MIRROR": index, "UV_INDEX_USER_PASSWORD": "fixture"})
        self.assertEqual([source for source, _ in calls], [index, build.REPOSITORY_PYPI_MIRROR, build.OFFICIAL_PYPI])
        self.assertEqual(calls[0][1]["UV_INDEX_USER_PASSWORD"], "fixture")
        for source, environment in calls[1:]:
            self.assertNotIn("UV_INDEX_USER_PASSWORD", environment)
            self.assertEqual(environment["PIP_INDEX_URL"], source)


unittest.main()
