"""Build the pinned upstream runtime through configured transports, preserving its lock."""
from __future__ import annotations

import os
import re
import signal
import subprocess
import sys
import time
import tomllib
from pathlib import Path
from tempfile import TemporaryDirectory, TemporaryFile
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from urllib.parse import urlsplit

WORKBUDDY_REPOSITORY = "https://github.com/Tencent/workbuddy-bench.git"
WORKBUDDY_COMMIT = "625b2233093ae4f23e76be28c1f341d41cc70373"
OFFICIAL_PYPI = "https://pypi.org/simple"
REPOSITORY_PYPI_MIRROR = "https://mirrors.aliyun.com/pypi/simple"
PUBLIC_PYPI_MIRRORS = {
    REPOSITORY_PYPI_MIRROR,
    "https://pypi.tuna.tsinghua.edu.cn/simple",
    "https://mirrors.tuna.tsinghua.edu.cn/pypi/web/simple",
    "https://pypi.mirrors.ustc.edu.cn/simple",
    "https://mirrors.ustc.edu.cn/pypi/simple",
}


def run_bounded(args: list[str], *, timeout: float, check: bool = True,
                capture_failure: bool = False, **options) -> subprocess.CompletedProcess:
    if capture_failure:
        with TemporaryFile() as log:
            result = run_bounded(args, timeout=timeout, check=False, stdout=log, stderr=subprocess.STDOUT, **options)
            size = log.seek(0, os.SEEK_END)
            log.seek(max(size - 65536, 0))
            diagnostic = log.read().decode(errors="replace")
            # Proxy authentication belongs to the process environment, not the build log.
            diagnostic = re.sub(r"(https?://)[^/\s@]+@", r"\1[redacted]@", diagnostic)
            if check and result.returncode:
                raise subprocess.CalledProcessError(result.returncode, args, output=diagnostic)
            if diagnostic:
                print(diagnostic, end="", file=sys.stderr, flush=True)
            return result
    process = subprocess.Popen(args, start_new_session=os.name == "posix", **options)
    try:
        code = process.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        try:
            if os.name == "posix":
                os.killpg(process.pid, signal.SIGKILL)
            else:
                process.kill()
        except ProcessLookupError:
            pass
        process.wait()
        raise
    if check and code:
        raise subprocess.CalledProcessError(code, args)
    return subprocess.CompletedProcess(args, code)


def transient_pypi_error(output: str) -> bool:
    return bool(re.search(r"\b(?:408|429|500|502|503|504) (?:Server Error|Service Unavailable|Bad Gateway|Gateway Timeout|error responses)|"
                          r"(?:HTTP|status(?: code)?)[: =]+(?:408|429|500|502|503|504)\b|"
                          r"too many (?:408|429|500|502|503|504) error responses|"
                          r"connection (?:refused|reset|timed out|aborted)|timed out|temporary failure in name resolution|"
                          r"failed to resolve|name or service not known|failed to establish a new connection|"
                          r"network is unreachable|remote end closed connection", output, re.IGNORECASE))


def pypi_mirror_failure(error: subprocess.CalledProcessError, index: str, remaining: float) -> bool:
    output = error.output or ""
    host = urlsplit(index).hostname
    if not host or host not in output:
        return False
    if re.search(r"\b(?:401|403|407) (?:Client Error|Forbidden|Unauthorized)|(?:HTTP|status(?: code)?)[: =]+(?:401|403|407)\b|"
                 r"certificate verify failed|invalid peer certificate|hash(?:es)? (?:do not match|mismatch)|"
                 r"THESE PACKAGES DO NOT MATCH THE HASHES", output, re.IGNORECASE):
        return False
    if transient_pypi_error(output):
        return True
    if "tunnel error: unsuccessful" not in output:
        return False
    # uv omits the CONNECT response code. A probe distinguishes temporary
    # proxy failures from access denial before trying another index.
    try:
        with urlopen(Request(index + "/", method="HEAD"), timeout=min(remaining, 10)):
            return False
    except HTTPError as probe:
        return probe.code in (408, 429, 500, 502, 503, 504)
    except OSError as probe:
        return transient_pypi_error(str(probe))


def install_from_public_index(command, index: str, *, run=run_bounded, timeout: float, env: dict) -> None:
    index = index.rstrip("/")
    declared = index.startswith("https:") and index == env.get("EVALUATOR_PYPI_PUBLIC_MIRROR")
    if index == OFFICIAL_PYPI or (not declared and index not in PUBLIC_PYPI_MIRRORS) or any(
            env.get(key) for key in ("PIP_EXTRA_INDEX_URL", "UV_INDEX", "UV_EXTRA_INDEX_URL")):
        run(command(index), check=True, env=env, timeout=timeout)
        return
    candidates = list(dict.fromkeys([index, *([REPOSITORY_PYPI_MIRROR] if declared else []), OFFICIAL_PYPI]))
    deadline = time.monotonic() + timeout
    failures = []
    for position, source in enumerate(candidates):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise subprocess.TimeoutExpired(command(source), timeout)
        selected = env
        if position:
            print("PyPI mirror unavailable; trying " + source, file=sys.stderr, flush=True)
            selected = {key: value for key, value in env.items()
                        if not re.fullmatch(r"UV_INDEX_.*_(?:USERNAME|PASSWORD)", key)}
            selected.update(PIP_INDEX_URL=source, UV_INDEX_URL=source, UV_DEFAULT_INDEX=source,
                            NETRC=os.devnull, PIP_KEYRING_PROVIDER="disabled", UV_KEYRING_PROVIDER="disabled")
        try:
            run(command(source), check=True, env=selected, timeout=remaining, capture_failure=True)
            return
        except subprocess.CalledProcessError as failure:
            failures.append(failure.output or "")
            remaining = deadline - time.monotonic()
            if position == len(candidates) - 1 or remaining <= 0 or not pypi_mirror_failure(failure, source, remaining):
                print(*failures, sep="\n", end="", file=sys.stderr, flush=True)
                raise


def install_uv(*, run=run_bounded) -> None:
    env = {**os.environ, "PIP_DISABLE_PIP_VERSION_CHECK": "1"}
    index = env.get("PIP_INDEX_URL", OFFICIAL_PYPI)
    with TemporaryDirectory(prefix="evaluator-uv-wheels-") as wheels:
        install_from_public_index(
            lambda source: [sys.executable, "-m", "pip", "download", "--no-cache-dir", "--retries", "3",
                            "--timeout", "60", "--only-binary=:all:", "--no-deps", "--verbose",
                            "--index-url", source, "--dest", wheels, "uv==0.10.2"],
            index, run=run, timeout=300, env=env,
        )
        run([sys.executable, "-m", "pip", "install", "--no-index", "--no-deps", "--find-links", wheels, "uv==0.10.2"],
            check=True, env=env, timeout=120)


def fetch_checkout(repository: str, commit: str, target: Path, *, run=run_bounded, sleep=time.sleep) -> None:
    if not re.fullmatch(r"[a-f0-9]{40}", commit):
        raise ValueError("Upstream Git revision must be an immutable commit")
    if not repository.startswith("https://github.com/"):
        raise ValueError("Unexpected upstream repository")
    mirror = os.environ.get("EVALUATOR_GITHUB_MIRROR", "https://github.com/").rstrip("/") + "/"
    parsed = urlsplit(mirror)
    if parsed.scheme not in ("http", "https") or not parsed.netloc or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("GitHub mirror must be a credential-free HTTP(S) URL prefix")
    url = mirror + repository.removeprefix("https://github.com/")
    run(["git", "init", str(target)], check=True, timeout=30)
    run(["git", "-C", str(target), "remote", "add", "origin", url], check=True, timeout=30)
    for attempt in range(3):
        try:
            run(["git", "-C", str(target), "-c", "http.lowSpeedLimit=1024", "-c", "http.lowSpeedTime=30",
                 "fetch", "--depth=1", "origin", commit], check=True, timeout=120,
                env={**os.environ, "GIT_TERMINAL_PROMPT": "0"})
            break
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
            if attempt == 2:
                raise
            sleep(2 ** (attempt + 1))
    run(["git", "-C", str(target), "checkout", "--detach", commit], check=True, timeout=30)


def locked_harbor(lock: dict) -> tuple[str, str]:
    package = next(package for package in lock["package"] if package["name"] == "harbor")
    source = urlsplit(package["source"]["git"])
    if source.scheme != "https" or source.netloc != "github.com" or source.path != "/harbor-framework/harbor.git":
        raise ValueError("Unexpected locked Harbor repository")
    if not re.fullmatch(r"[a-f0-9]{40}", source.fragment):
        raise ValueError("Harbor lock must contain an immutable Git commit")
    return "https://github.com" + source.path, source.fragment


def main() -> None:
    runtime = Path("/runtime")
    fetch_checkout(WORKBUDDY_REPOSITORY, WORKBUDDY_COMMIT, runtime)
    original_lock = (runtime / "uv.lock").read_bytes()
    harbor_repository, harbor_commit = locked_harbor(tomllib.loads(original_lock.decode()))
    harbor = Path("/harbor")
    fetch_checkout(harbor_repository, harbor_commit, harbor)
    install_dependencies(runtime, harbor)


def install_dependencies(runtime: Path, harbor: Path, *, run=run_bounded) -> None:
    original_lock = (runtime / "uv.lock").read_bytes()
    # Export only registry packages. Their versions and hashes come from the
    # upstream lock; uv pip resolves download locations against the selected
    # mirror instead of following uv.lock's files.pythonhosted.org URLs.
    requirements = "/tmp/verifier-requirements.txt"
    run(["uv", "export", "--frozen", "--offline", "--no-dev", "--no-emit-project",
                    "--no-emit-package", "harbor", "--format", "requirements-txt", "--output-file", requirements],
                   cwd=runtime, check=True, timeout=60)
    python = str(runtime / ".venv/bin/python")
    run(["uv", "venv", "--no-python-downloads", "--python", sys.executable, str(runtime / ".venv")],
                   check=True, timeout=60)
    index = os.environ["PIP_INDEX_URL"]
    environment = {**os.environ, "UV_HTTP_TIMEOUT": "60", "UV_HTTP_RETRIES": "3", "UV_PYTHON_DOWNLOADS": "never"}
    install_from_public_index(
        lambda source: ["uv", "pip", "install", "--python", python, "--no-config", "--no-deps", "--require-hashes",
                        "--default-index", source, "--requirements", requirements],
        index, run=run, timeout=900, env=environment,
    )
    run(["uv", "pip", "install", "--python", python, "--no-config", "--no-deps", "--default-index", index,
                    str(harbor), str(runtime)], check=True, env=environment, timeout=300)
    if (runtime / "uv.lock").read_bytes() != original_lock:
        raise RuntimeError("Verifier build changed the upstream dependency lock")


if __name__ == "__main__":
    if sys.argv[1:] == ["install-uv"]:
        install_uv()
    else:
        main()
