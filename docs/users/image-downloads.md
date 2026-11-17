# Download Docker and ModelScope images

> English | [中文](image-downloads.zh-CN.md)

[Network configuration](network.md)

Image acquisition has two configuration levels:

1. Select a default with `docker.pull.method` for shared images and task images without a benchmark-specific setting. Examples: [Docker native pull](#docker-native-pull), [Node.js backend](#nodejs-download-backend), and [skopeo backend](#skopeo-download-backend).
2. Optionally add `docker.benchmarks.<benchmark>` to select acquisition for a specific benchmark's task images. Example: [add ModelScope task image downloads to the default configuration](#download-task-images-from-modelscope).

## Download task images from ModelScope

Keep `docker.pull` in the network configuration and add `docker.benchmarks.terminalbench` in the same file. Evaluator downloads the Terminal-Bench task images from ModelScope and loads them into Docker. Shared images such as Node still use `docker.pull`.

Prepare Docker, model settings, and task selection using the [Terminal-Bench quick start](quick-start/terminalbench.md), then run from the repository root:

```bash
arsi-evaluator warmup playbook/terminalbench/terminalbench-4.0.yaml --network playbook/network/archives.yaml
arsi-evaluator run playbook/terminalbench/terminalbench-4.0.yaml --network playbook/network/archives.yaml
```

The contents of `archives.yaml` are:

```yaml
docker:
  # Shared images (such as Node): acquire with docker pull.
  # Task images without a benchmark-specific setting also use this method.
  pull:
    method: docker
  # Download Terminal-Bench task images from ModelScope and load them into Docker.
  benchmarks:
    terminalbench:
      method: archive
      provider: modelscope
      # Official image repository; adjust the benchmark directory as needed.
      baseUrl: https://modelscope.cn/datasets/evolving-foundry/ember-evaluator/resolve/master/terminalbench4.0
```

`terminalbench` matches the experiment's `benchmark.name`. `baseUrl` points to the ModelScope directory for that version. Evaluator downloads the solve, verification, and service images for the selected tasks and platform, then loads them into Docker automatically. A missing ModelScope file can trigger a download from the task's original registry. [Task image downloads and fallback](#task-image-downloads-and-fallback)

This example uses `docker.pull.method: docker` as the default and adds a separate source for Terminal-Bench task images:

| Image category | Configuration | Acquisition |
| --- | --- | --- |
| Shared images such as Node | `docker.pull` | Run `docker pull` |
| Terminal-Bench solve, verify, and service images | `docker.benchmarks.terminalbench` | Download task images from ModelScope and load them into Docker automatically |
| Other benchmarks' task images without a separate setting | `docker.pull` | Run `docker pull` |

You can also change `docker.pull` to `method: registry-client` with `backend: nodejs` or `skopeo`. Shared images and task images without a separate setting then use that backend, while Terminal-Bench task images still download from ModelScope.

Task data and package download URLs remain controlled by `sources`. To also use package mirrors, copy `mirrors.yaml` to your own `network.yaml` and add the `benchmarks` block above under its existing `docker` key, keeping `pull` and `mirrors`. Do not duplicate the top-level `docker:` key. Pass only `--network network.yaml`.

The example selects all tasks, and warmup prepares all selected tasks. Follow the quick start to limit the task count for a first attempt.

## Image acquisition

First select the default acquisition method with `docker.pull`; omitting it selects `method: docker`. `docker.pull.method` accepts only `docker` or `registry-client`, with Node.js or skopeo as registry-client backends:

| Method | Behavior | Example |
| --- | --- | --- |
| `docker` | Default native pull; daemon controls HTTP proxies | [Docker native pull](#docker-native-pull) |
| `registry-client`, backend `nodejs` | Download image content, then import into Docker | [Node.js backend](#nodejs-download-backend) |
| `registry-client`, backend `skopeo` | Use preinstalled skopeo, optionally at `skopeoExecutable` | [skopeo backend](#skopeo-download-backend) |

To download task images from ModelScope for a benchmark, set `method: archive` and `provider: modelscope` under `docker.benchmarks.<benchmark>`. This works with any `docker.pull` method in the table. [Task image downloads and fallback](#task-image-downloads-and-fallback)

The three examples below demonstrate default acquisition without benchmark-specific settings, each using a separate network file. Replace `experiment.yaml` with your Docker experiment configuration. See the [Terminal-Bench quick start](quick-start/terminalbench.md) to prepare Docker, model settings, and task selection.

### Docker native pull

To let the Docker daemon pull registry images, save the following as `network-docker.yaml`:

```yaml
docker:
  pull:
    method: docker
```

Warm up the selected tasks to download their images and dependencies:

```bash
arsi-evaluator warmup experiment.yaml --network network-docker.yaml
```

With no benchmark-specific override, this example uses `docker pull` for both task images and shared images such as Node. Add `docker.mirrors` to the same file to use a registry mirror such as DockerProxy; see [changing download URLs](reference/network.md#change-download-urls). For daemon proxies, see [deployment networking](deployment/network.md#docker-builds-and-daemon-proxies).

### Node.js download backend

To let the Evaluator process perform registry downloads, save the following as `network-nodejs.yaml`:

```yaml
docker:
  pull:
    method: registry-client
    backend: nodejs
```

```bash
arsi-evaluator warmup experiment.yaml --network network-nodejs.yaml
```

The built-in Node.js downloader fetches registry content for task and shared images, then imports it into Docker. No skopeo installation is needed, but a working Docker daemon is required. Downloads use the Evaluator process proxy; see [proxy configuration](reference/network.md#set-proxies). Omitting `backend` also selects `nodejs`.

### skopeo download backend

To use skopeo installed on the execution node for registry downloads, save the following as `network-skopeo.yaml`:

```yaml
docker:
  pull:
    method: registry-client
    backend: skopeo
    skopeoExecutable: skopeo
```

```bash
arsi-evaluator warmup experiment.yaml --network network-skopeo.yaml
```

`skopeoExecutable` is optional and defaults to `skopeo` on `PATH`; you can also specify its absolute path on the execution node. skopeo must support `copy --preserve-digests` and is not installed automatically. Images are still imported into Docker. For Ray, install skopeo on every node that performs downloads; see [source bootstrap and deployment](deployment/network.md#source-bootstrap-and-deployment).

After warmup, replace `warmup` with `run` in the corresponding command to start evaluation with the same network file. If preparation fails, use `doctor` with the same arguments; see [network diagnosis](faq/network.md).

### Registry mirrors, login, and caching

`docker.mirrors` selects a mirror for a specific registry. For example, `docker.io: https://dockerproxy.net/` downloads `ubuntu:24.04` as `dockerproxy.net/library/ubuntu:24.04`. The tag or pinned digest stays the same. This mapping affects Docker Hub only, leaving GHCR and other registries unchanged.

Before downloading private images, use `docker login` on the machine performing the download. `registry-client` uses the current execution user's Docker login information. Ray downloads run on execution nodes, so configure credentials on the relevant nodes.

With `registry-client`, Evaluator reuses a local cache for the registry reference that supplied the image and the target platform. With `method: docker`, Docker manages its own image layer cache.

Evaluator retries the configured mirror after connection failures, rate limits, or transient server errors. If its retries are exhausted, the same backend tries the original image reference. Authentication, digest verification, platform selection, and Docker import failures are reported immediately. Native Docker pulls still use the daemon's own registry configuration.

### Task image downloads and fallback

The opening example shows how to download task images from ModelScope. For images published on Hugging Face, set `provider: huggingface` and the corresponding `baseUrl`. [ModelScope example](#download-task-images-from-modelscope) · [Hugging Face configuration example (Chinese)](../development/image-archives.md#网络配置)

Download URLs combine `baseUrl`, task path, platform, and phase. For `terminal-bench/vf2-speedup-networkx`, the solve image is at `<baseUrl>/vf2-speedup-networkx/linux/amd64/solve.tar.gz`, and the verification image uses `verify.tar.gz`. Service images use `<phase>/services/<service>.tar.gz`. [File layout for publishing task images (Chinese)](../development/image-archives.md#文件布局)

For a solve image, a local tag such as `arsi-evaluator/terminalbench4.0/vf2-speedup-networkx:linux-amd64-base` maps to `vf2-speedup-networkx/linux/amd64/solve.tar.gz`. Evaluator assigns local tags from the image ID and reuses any existing reference. Solver images are built on the execution node.

If ModelScope or Hugging Face returns `404` for a task image, or the download exhausts its retries for a transient network failure, Evaluator uses `docker.pull` to get the image from the registry declared by the task. It preserves the platform and pinned digest. For example, if a Terminal-Bench 4.0 solve image is missing on ModelScope, Evaluator uses the task's original Docker Hub reference. This fallback skips `docker.mirrors` and caches the registry image separately from ModelScope and Hugging Face downloads. Evaluator reports an error if the task has no registry image reference, or if authentication, file validation, or `docker load` fails.

Evaluator checks the downloaded image's platform and ID, then imports it under a temporary reference. Images with the same ID reuse one local reference, and the publisher's tags are discarded. Follow the steps below to compare a downloaded image with the original registry image.

Select the platform with `environment.platform`. The value `auto` uses the execution node's native platform. Evaluator reuses an existing image for the same URL and can load the cached image file again after cleanup. Each URL has its own download record. Use a new version URL when publishing an update.

The Evaluator ModelScope repository hosts official task images for selected benchmarks. Check its file tree for available images. [ModelScope repository](https://www.modelscope.cn/datasets/evolving-foundry/ember-evaluator) · [Single-file and batch upload guide (Chinese)](../development/image-archives.md#上传到-modelscope)

### Verify a ModelScope Image

Compare full image IDs for the same platform: **matching IDs mean the same image, even if names and tags differ.**

The example uses `linux/amd64`. Replace the image references and downloaded file path, then run the commands in order.

```bash
# 1. Pull the official image and note its full ID
docker pull --platform linux/amd64 'official-image:tag'
docker image inspect --platform linux/amd64 --format '{{.Id}}' 'official-image:tag'

# 2. Load the task image downloaded from ModelScope
docker load --input solve.tar.gz

# 3. Use the reference printed after Loaded image and compare this ID with step 1
docker image inspect --platform linux/amd64 --format '{{.Id}}' 'loaded-image-reference'
```

Note the official image ID before loading the downloaded file, since loading may overwrite the same tag. If the IDs differ, check the version, platform, and image type. An updated official tag can also explain a mismatch.

## Task image download credentials

ModelScope uses `MODELSCOPE_API_TOKEN` on the execution node; Hugging Face uses `HF_TOKEN`. Public files need no token. Supply credentials through environment variables rather than the network file.
