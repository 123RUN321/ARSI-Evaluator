# Network configuration fields and proxies

> English | [中文](network.zh-CN.md)

[Network configuration](../network.md)

To customize networking, copy an example, edit download URLs or proxies, then check for environment overrides. Once it works, you can select it as your default file.

## Edit mirrors.yaml

The bundled [mirrors.yaml](../../../playbook/network/mirrors.yaml) provides example download mirrors. Copy it to your own `network.yaml` from the repository root and use that copy in subsequent commands:

```powershell
# PowerShell
Copy-Item -LiteralPath playbook/network/mirrors.yaml -Destination network.yaml
```

```bash
# Bash
cp playbook/network/mirrors.yaml network.yaml
```

Edit existing fields in the copy. For example, to restore the official Python package source, change only `sources.python.index` to the following value and keep other fields:

```yaml
sources:
  python:
    index: https://pypi.org/simple
```

Update the existing `sources` block using this fragment. Download and proxy fields are listed below. To also download task images from ModelScope, add `docker.benchmarks` to the same file. [Configure ModelScope task image downloads](../image-downloads.md#download-task-images-from-modelscope)

Inspect the effective settings, then run your experiment:

```bash
arsi-evaluator inspect experiment.yaml --network network.yaml
arsi-evaluator run experiment.yaml --network network.yaml
```

## Change download URLs

`sources` selects data and package download URLs. Replace the relevant field with a source reachable from execution nodes that provides the same content and path layout:

| Field | Downloads |
| --- | --- |
| `sources.huggingface` | Hub address for datasets, files, and tokenizer assets. Use `mirror` to declare a public mirror. |
| `sources.python.index/extraIndexes` | pip and uv packages |
| `sources.python.interpreter` | uv Python installations; null keeps uv's default |
| `sources.npm.registry` | npm, pnpm, Corepack |
| `sources.node.dist` | Node distributions |
| `sources.github.api/raw/repository` | GitHub API, raw files and HTTPS Git |
| `sources.apt` | Full `debian`, `debianSecurity`, `ubuntu`, `ubuntuSecurity`, `ubuntuPorts` repository roots |

To use your own public Hugging Face mirror, put its address in the YAML file passed to `--network`.

```yaml
sources:
  huggingface:
    mirror: https://public-mirror.example
```

Evaluator tries the configured mirror first. After exhausting retries for a transient network failure, it tries the repository example's `https://hf-mirror.com` mirror, then `https://huggingface.co`. File requests also fall back after a `404`. Each request uses the same path and keeps the revision and digest checks. Fallback requests are anonymous, and tokens are sent only to the preferred address.

The string value `https://hf-mirror.com` falls back directly to the official Hub. Use a string address for a self-hosted Hub to keep retries on that Hub. Select `https://huggingface.co` directly for authenticated access to official data. `HF_ENDPOINT` overrides the YAML setting and is treated as a string address.

### Public package mirror fallback

Use `mirror` to declare a custom public HTTPS mirror in the YAML file passed to the existing `--network network.yaml` option.

```yaml
sources:
  python:
    index:
      mirror: https://pypi-mirror.example/simple
  npm:
    registry:
      mirror: https://npm-mirror.example
```

- PyPI tries the configured public mirror, the Aliyun PyPI mirror in the repository example, then official PyPI. The Python verifier uses this order for uv and its locked dependencies. Existing strings for the supported Aliyun, Tsinghua, and USTC addresses still fall back to official PyPI.
- npm tries the configured public mirror, npmmirror from the repository example, then `registry.npmjs.org`. This applies to Evaluator-managed lockfile installs with scripts disabled, DSH's npm resolution, and the network launcher's supported `pnpm fetch` and `pnpm install --frozen-lockfile` commands. Existing string settings for npmmirror and Taobao still fall back to the official registry.
- Task-image builds fall back per package request for `RUN pip install` and `RUN npm ci`, with three attempts per source after a transient failure. Docker runs the build once, using the original lockfile and package digests. PyPI relay requests cover the selected mirror, recognized mirror file hosts, and official file hosts. Package managers still handle explicit extra indexes, private registries, and direct download URLs. The relay uses Evaluator's host proxy and requires Docker Desktop on Windows or Docker Engine with a local bridge on Linux.
- APT keeps the existing URL strings under `sources.apt`. For supported Debian, Ubuntu, and Ubuntu Ports repositories, Docker builds use native APT mirror rules to try the configured mirror, the Aliyun mirror in the repository example, and the official distribution repository. Duplicate URLs are removed, and signature verification still applies.

Docker image settings live under `docker`: `docker.pull` selects acquisition for shared images and task images without a benchmark-specific setting; `docker.benchmarks` selects acquisition for a specific benchmark's task images. See the [annotated example](../image-downloads.md#download-task-images-from-modelscope) for ModelScope task images alongside shared images acquired with `docker pull`. `docker.mirrors` only rewrites registry download addresses.

For example, `docker.mirrors.docker.io` in `mirrors.yaml` selects DockerProxy. Delete that entry to pull directly from Docker Hub again. To disable all registry mirror mappings, set `mirrors: {}` under the existing `docker:` key. See [image downloads](../image-downloads.md#image-acquisition) for configuration and matching rules.

## Set proxies

Download URLs select destinations; `proxy` selects whether requests go through a proxy. Edit the existing block when a proxy is needed:

```yaml
proxy:
  http: http://127.0.0.1:7890
  https: http://127.0.0.1:7890
  noProxy: [localhost, 127.0.0.1, "::1"]
```

`http` and `https` apply to their respective request protocols and accept HTTP(S) proxy URLs. Set a field to `null` for direct connections. Neither protocol falls back to the other. `noProxy` lists direct destinations.

`127.0.0.1` always refers to the execution location itself. If the proxy is on the host but execution is in a container or Ray node, use an address reachable from that location. Evaluator does not rewrite it to `host.docker.internal`.

Use these fields for location-specific settings. Omitted fields inherit the common proxy above; setting an entire location to `null` makes it direct:

| Field | Location |
| --- | --- |
| `proxy.overrides.host` | Evaluator process |
| `proxy.overrides.daemon` | Docker daemon |
| `proxy.overrides.build` | Dockerfile `RUN` |
| `proxy.overrides.runtime` | Runtime installation commands |

Native Docker pulls use the daemon's proxy. For an existing daemon, apply the settings as described in [deployment networking](../deployment/network.md), which also covers `docker.buildNetwork`.

For Git SSH connections, `git.ssh.route` defaults to `direct`. Set it to `proxy` for HTTP CONNECT routing and configure a reachable HTTP or HTTPS proxy for the Evaluator process. SSH repository URLs remain unchanged.

Use environment references such as `${NODE_PROXY}` for authenticated proxies. Ray rejects proxy URLs containing literal usernames or passwords. Set referenced variables on each execution node and check whether other network environment variables override them.

## Check environment overrides

Field precedence is **nonempty supported environment variables → YAML → built-in defaults**, including with `--network`. If editing YAML does not change the effective URL, use `inspect` and check the following variables.

| Environment variables (first nonempty value wins within each row) | Overridden field |
| --- | --- |
| `HTTP_PROXY`, `http_proxy` | `proxy.http` at every location |
| `HTTPS_PROXY`, `https_proxy` | `proxy.https` at every location |
| `NO_PROXY`, `no_proxy` | `proxy.noProxy` at every location; comma-separated |
| `HF_ENDPOINT` | `sources.huggingface` |
| `UV_DEFAULT_INDEX`, `UV_INDEX_URL`, `PIP_INDEX_URL` | `sources.python.index` |
| `PIP_EXTRA_INDEX_URL` | `sources.python.extraIndexes`; whitespace-separated, replaces the YAML list |
| `UV_PYTHON_INSTALL_MIRROR` | `sources.python.interpreter` |
| `NPM_CONFIG_REGISTRY`, `npm_config_registry` | `sources.npm.registry` |
| `EVALUATOR_NODE_MIRROR` | `sources.node.dist` |
| `EVALUATOR_GITHUB_MIRROR` | `sources.github.repository`; API/raw addresses are retained |
| `EVALUATOR_DEBIAN_MIRROR` | `sources.apt`; appends `debian`, `debian-security`, `ubuntu`, and `ubuntu-ports` paths |
| `EVALUATOR_DOCKER_BUILD_NETWORK` | `docker.buildNetwork` |

For example, `HTTPS_PROXY` overrides `proxy.https` at every location, including explicit YAML URLs and `null`; other fields are retained. To use the YAML HTTPS proxy again, clear the variable in the current terminal and check its lowercase alias `https_proxy`:

```powershell
# PowerShell: clear the variable if set
Remove-Item Env:HTTPS_PROXY -ErrorAction SilentlyContinue
```

```bash
# Bash: clear both aliases
unset HTTPS_PROXY https_proxy
```

Empty environment values are treated as unset and do not clear YAML. Invalid environment values fail. `ALL_PROXY` is not a configuration input.

## Set a default network file

Each command selects one network file in this order:

| Priority | File source |
| --- | --- |
| 1 | CLI `--network`, or SDK `networkConfigPath` |
| 2 | `EVALUATOR_NETWORK_CONFIG` environment variable |
| 3 | `~/.arsi-evaluator/network.yaml` on Linux/macOS, or `%USERPROFILE%\.arsi-evaluator\network.yaml` on Windows |

Relative paths resolve from the working directory. The selected file is not merged with the user default; omitted fields use built-in defaults. Missing or invalid explicitly selected files fail. A missing default file is created with official sources and direct connections; existing files are never overwritten.

To keep using your own settings, edit the default file above or set `EVALUATOR_NETWORK_CONFIG` in the current terminal:

```powershell
# PowerShell: replace with the absolute path to an existing file
$env:EVALUATOR_NETWORK_CONFIG = "C:\configs\network.yaml"
```

```bash
# Bash
export EVALUATOR_NETWORK_CONFIG=/path/to/network.yaml
```

Commands in that terminal can then omit `--network`. Pass it explicitly to temporarily select a different file.

Running processes retain settings loaded at startup. Manual recovery of a stopped run with `retry --run <run-id-or-directory>` reloads the current network file; `--network` can select another. Model endpoints, authentication, and task network permissions remain in the experiment configuration.

## File format requirements

- Optional top-level fields are `proxy`, `sources`, `docker`, and `git`. `version` and unknown fields are rejected.
- Empty files, comments only, and `{}` are accepted. Fields without environment overrides use built-in defaults.
- `${VARIABLE}` references are supported. A field overridden by a supported environment variable does not expand its original references.

See [network diagnosis](../faq/network.md) for missing tools, connectivity failures, and download verification.
