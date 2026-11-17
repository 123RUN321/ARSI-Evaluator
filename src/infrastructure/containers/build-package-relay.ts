import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, open, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { networkInterfaces, tmpdir } from "node:os";
import { join, posix } from "node:path";
import { pipeline } from "node:stream/promises";
import { isIP } from "node:net";
import type { NetworkAccess } from "../../core/contracts/network.js";
import { declaredErrorCode } from "../../core/errors/classify.js";
import { formatError } from "../../core/errors/diagnostics.js";
import { npmRegistrySources } from "../network/package-mirror.mjs";
import { retryNetworkOperation } from "../network/retry.js";
import { withSourceFallbacks } from "../network/source-fallback.js";
import { rewritePythonIndex, type PythonIndexLink } from "./python-index.js";
import type { DockerCommand } from "./runtime-contract.js";
import { dockerActivity } from "./progress.js";

const pypi = "https://pypi.org/simple";
const repositoryPyPI = "https://mirrors.aliyun.com/pypi/simple";
const npm = "https://registry.npmjs.org";
const tunaHosts = ["pypi.tuna.tsinghua.edu.cn", "mirrors.tuna.tsinghua.edu.cn", "nanomirrors.tuna.tsinghua.edu.cn"];
const ustcHosts = ["pypi.mirrors.ustc.edu.cn", "mirrors.ustc.edu.cn", ...tunaHosts];
const pythonMirrors = new Map([
  [repositoryPyPI, ["mirrors.aliyun.com"]],
  ["https://pypi.tuna.tsinghua.edu.cn/simple", tunaHosts],
  ["https://mirrors.tuna.tsinghua.edu.cn/pypi/web/simple", tunaHosts],
  ["https://pypi.mirrors.ustc.edu.cn/simple", ustcHosts],
  ["https://mirrors.ustc.edu.cn/pypi/simple", ustcHosts],
]);
const transient = new Set([408, 429, 500, 502, 503, 504]);
const metadataLimit = 16 * 1024 ** 2;
const auditLimit = 1024 ** 2;
const spoolLimit = 4 * 1024 ** 3;
const preferredPort = 39172;
const upstreamIdleMs = 30_000;

type SourceChain = readonly [string, ...string[]];
type Sources = { python?: SourceChain; npm?: SourceChain };
type PythonArtifact = { source: URL; index: string; project: string; filename: string; sha256?: string; metadata?: true | string };
type Payload = { status: number; type?: string; bytes?: Buffer; path?: string; size?: number; release?(): Promise<void> };

export function buildPackageSources(access: NetworkAccess): Sources {
  const { python, npm: registry } = access.settings.sources;
  const index = python.index.replace(/\/$/u, "");
  const [npmPrimary, ...npmFallbacks] = npmRegistrySources({ NPM_CONFIG_REGISTRY: registry.registry,
    ...(registry.registryPublicMirror ? { EVALUATOR_NPM_PUBLIC_MIRROR: registry.registry } : {}) });
  return {
    ...(index !== pypi && (python.indexPublicMirror || pythonMirrors.has(index)) && !python.extraIndexes.length
      ? { python: [index, ...(python.indexPublicMirror && index !== repositoryPyPI ? [repositoryPyPI] : []), pypi] } : {}),
    ...(npmPrimary ? { npm: [npmPrimary, ...npmFallbacks] } : {}),
  };
}

/** Use the host that actually owns the local Docker daemon. Remote builders need their own relay. */
export async function localPackageRelayBinding(command: DockerCommand, signal: AbortSignal) {
  const dockerHost = process.env.DOCKER_HOST;
  const endpoint = !process.env.DOCKER_CONTEXT && dockerHost
    ? dockerHost
    : (await command(["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"], { signal })).stdout.trim();
  const desktopPipe = /^npipe:\/\/\/\/\.\/pipe\/docker(?:DesktopLinux)?Engine$/iu.test(endpoint);
  if (process.platform === "win32" && desktopPipe) return { bind: "127.0.0.1", hostname: "host.docker.internal" };
  if (process.platform !== "linux" || !/^unix:\/\/\//u.test(endpoint)) return undefined;
  try {
    const gateway = (await command(["network", "inspect", "bridge", "--format", "{{(index .IPAM.Config 0).Gateway}}"], { signal })).stdout.trim();
    if (isIP(gateway) === 4 && Object.values(networkInterfaces()).some(addresses => addresses?.some(address => address.address === gateway)))
      return { bind: gateway, hostname: "host.docker.internal" };
  } catch { signal.throwIfAborted(); }
}

function statusError(response: Response): Error {
  const retryAfter = response.headers.get("retry-after");
  return Object.assign(new Error("HTTP " + response.status), { status: response.status,
    ...(retryAfter && /^\d+(?:\.\d+)?$/u.test(retryAfter) ? { retryAfterMs: Math.min(upstreamIdleMs, Number(retryAfter) * 1000) } : {}) });
}

function length(response: Response): number | undefined {
  const header = response.headers.get("content-length");
  const encoding = response.headers.get("content-encoding");
  if (header && /^\d+$/u.test(header) && (!encoding || encoding === "identity")) return Number(header);
}

function publicUrl(url: URL, hosts: ReadonlySet<string>): boolean {
  return url.protocol === "https:" && !url.username && !url.password && hosts.has(url.host);
}

function npmPath(path: string): boolean {
  let decoded: string;
  try { decoded = decodeURIComponent(path); } catch { return false; }
  return /^\/(?:@[a-z0-9_.-]+\/)?[a-z0-9_-][a-z0-9_.-]*(?:\/-\/[a-z0-9_.+-]+\.tgz)?$/iu.test(decoded)
    && !decoded.split("/").some(part => part === "." || part === "..");
}

function dictionary(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export async function openBuildPackageRelay(access: NetworkAccess, sources: Sources,
  binding: { bind: string; hostname: string }, signal: AbortSignal) {
  signal.throwIfAborted();
  const directory = await mkdtemp(join(tmpdir(), "evaluator-build-packages-"));
  const shutdown = new AbortController();
  const work = new Set<Promise<void>>();
  const artifacts = new Map<string, PythonArtifact>();
  const npmOfficialHosts = new Set([new URL(npm).hostname]);
  const npmHosts = new Set([...npmOfficialHosts, "registry.npm.taobao.org", "registry.npmmirror.com", "cdn.npmmirror.com",
    ...(sources.npm?.map(source => new URL(source).host) ?? [])]);
  const pypiHosts = new Set(["pypi.org", "files.pythonhosted.org"]);
  const pythonHosts = (index: string) => index === pypi ? pypiHosts
    : new Set([...pypiHosts, ...(pythonMirrors.get(index) ?? [new URL(index).host])]);
  const report = dockerActivity();
  let stagedBytes = 0;
  let origin = "";

  async function requestUpstream(target: URL, hosts: ReadonlySet<string>, accept: string, active: AbortSignal): Promise<{ response: Response; url: URL }> {
    let url = target;
    for (let redirects = 0; redirects <= 5; redirects++) {
      if (!publicUrl(url, hosts)) throw new Error("Package response redirects outside the public source");
      const response = await access.fetch(url, { headers: { accept }, redirect: "manual", signal: active });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location) throw new Error("Package redirect has no location");
        url = new URL(location, url);
        continue;
      }
      if (transient.has(response.status)) {
        await response.body?.cancel();
        throw statusError(response);
      }
      return { response, url };
    }
    throw new Error("Too many package source redirects");
  }

  async function receive<T>(target: URL, hosts: ReadonlySet<string>, accept: string, active: AbortSignal,
    consume: (response: Response, url: URL, progress: () => void) => Promise<T>): Promise<T> {
    const idle = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const progress = () => {
      clearTimeout(timer);
      timer = setTimeout(() => idle.abort(Object.assign(new Error("Package upstream stopped responding"), { code: "ETIMEDOUT" })), upstreamIdleMs);
      timer.unref();
    };
    progress();
    try {
      const { response, url } = await requestUpstream(target, hosts, accept, AbortSignal.any([active, idle.signal]));
      progress();
      return await consume(response, url, progress);
    } catch (error) {
      active.throwIfAborted();
      idle.signal.throwIfAborted();
      throw error;
    } finally { clearTimeout(timer); }
  }

  async function read(target: URL, hosts: ReadonlySet<string>, accept: string, limit: number, active: AbortSignal) {
    return retryNetworkOperation(() => receive(target, hosts, accept, active, async (response, url, progress) => {
      const size = length(response);
      if (size !== undefined && size > limit) {
        await response.body?.cancel();
        throw new Error("Package metadata exceeds its size limit");
      }
      const chunks: Buffer[] = [];
      let total = 0;
      if (response.body) for await (const chunk of response.body) {
        progress();
        total += chunk.length;
        if (total > limit) throw new Error("Package metadata exceeds its size limit");
        chunks.push(Buffer.from(chunk));
      }
      if (size !== undefined && total !== size) throw new Error("Unexpected EOF in package metadata");
      const type = response.headers.get("content-type") ?? "application/octet-stream";
      return { status: response.status, type, bytes: Buffer.concat(chunks), url };
    }), { signal: active, context: { phase: "prepare", component: "source" } });
  }

  async function artifact(target: URL, hosts: ReadonlySet<string>, active: AbortSignal, expected?: string): Promise<Payload> {
    return retryNetworkOperation(() => receive<Payload>(target, hosts, "*/*", active, async (response, _url, progress) => {
      if (!response.ok) {
        await response.body?.cancel();
        return { status: response.status };
      }
      const size = length(response);
      if (size !== undefined && size > spoolLimit) {
        await response.body?.cancel();
        throw new Error("Package artifact exceeds its size limit");
      }
      const path = join(directory, randomUUID());
      const checksum = expected ? createHash("sha256") : undefined;
      let bytes = 0;
      let retained = false;
      const release = async () => {
        try { await rm(path, { force: true }); }
        finally { stagedBytes -= bytes; }
      };
      try {
        const handle = await open(path, "wx", 0o600);
        try {
          if (response.body) for await (const chunk of response.body) {
            progress();
            active.throwIfAborted();
            if (stagedBytes + chunk.length > spoolLimit) throw new Error("Package relay temporary file limit exceeded");
            bytes += chunk.length;
            stagedBytes += chunk.length;
            checksum?.update(chunk);
            await handle.writeFile(chunk);
          }
        } finally { await handle.close(); }
        if (size !== undefined && bytes !== size) throw new Error("Unexpected EOF in package artifact");
        if (checksum && checksum.digest("hex") !== expected) throw new Error("Package SHA-256 mismatch");
        retained = true;
        return { status: response.status, type: response.headers.get("content-type") ?? "application/octet-stream", size: bytes, path, release };
      } finally { if (!retained) await release(); }
    }), { signal: active, context: { phase: "prepare", component: "source" } });
  }

  class PackageFileUnavailable extends Error {}

  function fallback<T>([primary, ...alternates]: SourceChain, attempt: (source: string) => Promise<T>, active: AbortSignal) {
    return withSourceFallbacks(primary, alternates, attempt, { signal: active,
      shouldFallback: error => declaredErrorCode(error) === "NETWORK_FAILURE" || error instanceof PackageFileUnavailable,
      onFallback: (source, next) => report?.({
        message: "Build package mirror " + new URL(source).host + " unavailable; trying " + new URL(next).host, activity: true,
      }),
    });
  }

  const pythonIndex = (base: string, project: string) => new URL(base + "/" + project + "/");

  function pythonFile(link: PythonIndexLink, base: URL, hosts: ReadonlySet<string>) {
    let url: URL;
    try { url = new URL(link.url, base); } catch { return undefined; }
    if (!publicUrl(url, hosts)) return undefined;
    const encoded = posix.basename(url.pathname);
    let filename: string;
    try { filename = decodeURIComponent(encoded); } catch { return undefined; }
    if (!/^[A-Za-z0-9_.+-]+$/u.test(filename) || filename === "." || filename === ".."
      || link.filename && link.filename !== filename) return undefined;
    return { url, filename };
  }

  async function answerPythonIndex(project: string, indexes: SourceChain, accept: string, active: AbortSignal): Promise<Payload> {
    const result = await fallback(indexes, async index => ({
      ...await read(pythonIndex(index, project), pythonHosts(index), accept, metadataLimit, active), index,
    }), active);
    if (result.status !== 200) return result;
    const hosts = pythonHosts(result.index);
    const contents = rewritePythonIndex(result.bytes.toString("utf8"), link => {
      const file = pythonFile(link, result.url, hosts);
      if (!file) return undefined;
      const token = createHash("sha256").update(JSON.stringify([project, file.url.href, link.sha256, link.metadata, result.index])).digest("hex");
      artifacts.set(token, { source: file.url, filename: file.filename, project, index: result.index,
        ...(link.sha256 ? { sha256: link.sha256 } : {}), ...(link.metadata ? { metadata: link.metadata } : {}) });
      return origin + "/files/" + token + "/" + encodeURIComponent(file.filename) + file.url.hash;
    });
    return { ...result, bytes: Buffer.from(contents) };
  }

  async function answerPythonFile(file: PythonArtifact, metadata: boolean, active: AbortSignal): Promise<Payload> {
    const requested = (url: URL, hosts: ReadonlySet<string>) => {
      const target = new URL(url.href);
      target.hash = "";
      if (metadata) target.pathname += ".metadata";
      const expected = metadata ? typeof file.metadata === "string" ? file.metadata : undefined : file.sha256;
      return artifact(target, hosts, active, expected);
    };
    if (file.index === pypi || pypiHosts.has(file.source.host)) return requested(file.source, pypiHosts);
    if (!file.sha256) return requested(file.source, pythonHosts(file.index));
    const indexes: readonly string[] = sources.python ?? [];
    const remaining = indexes.slice(indexes.indexOf(file.index) + 1);
    return fallback([file.index, ...remaining], async source => {
      const hosts = pythonHosts(source);
      if (source === file.index) return requested(file.source, hosts);
      const index = await read(pythonIndex(source, file.project), hosts, "application/vnd.pypi.simple.v1+json", metadataLimit, active);
      if (index.status !== 200 && index.status !== 404) return index;
      let matching: URL | undefined;
      if (index.status === 200) rewritePythonIndex(index.bytes.toString("utf8"), link => {
        const candidate = pythonFile(link, index.url, hosts);
        if (candidate?.filename === file.filename && link.sha256 === file.sha256
          && (!metadata || link.metadata && (typeof file.metadata !== "string" || link.metadata === file.metadata))) matching = candidate.url;
        return undefined;
      });
      if (!matching) throw new PackageFileUnavailable("PyPI has no package file matching the selected filename and SHA-256");
      return requested(matching, hosts);
    }, active);
  }

  async function answerNpm(path: string, registries: SourceChain, accept: string, active: AbortSignal): Promise<Payload> {
    const hosts = (registry: string) => registry === npm ? npmOfficialHosts : npmHosts;
    if (path.endsWith(".tgz")) return fallback(registries, registry => artifact(new URL(registry + path), hosts(registry), active), active);
    const result = await fallback(registries, registry => read(new URL(registry + path), hosts(registry), accept, metadataLimit, active), active);
    if (result.status !== 200) return result;
    const page = dictionary(JSON.parse(result.bytes.toString("utf8")));
    if (!page) throw new Error("Invalid npm registry metadata");
    for (const version of [page, ...Object.values(dictionary(page.versions) ?? {}).map(dictionary)]) {
      const dist = dictionary(version?.dist);
      if (typeof dist?.tarball !== "string") continue;
      const url = new URL(dist.tarball);
      if (publicUrl(url, npmHosts) && !url.search && npmPath(url.pathname) && url.pathname.endsWith(".tgz"))
        dist.tarball = origin + "/npm" + url.pathname;
    }
    return { ...result, bytes: Buffer.from(JSON.stringify(page)) };
  }

  async function answerNpmAudit(request: IncomingMessage, target: URL, active: AbortSignal): Promise<Payload> {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of request) {
      bytes += chunk.length;
      if (bytes > auditLimit) return { status: 413 };
      chunks.push(chunk);
    }
    // Audit reports disclose the dependency graph. Keep sending them to the configured registry only.
    const result = await access.fetch(target, {
      method: "POST", redirect: "manual", signal: active,
      headers: { "content-type": "application/json", ...(request.headers["content-encoding"] === "gzip" ? { "content-encoding": "gzip" } : {}) },
      body: new Uint8Array(Buffer.concat(chunks)),
    });
    if (!result.ok) {
      await result.body?.cancel();
      return { status: result.status >= 400 ? result.status : 502 };
    }
    const body = result.body;
    const responseChunks: Buffer[] = [];
    let responseBytes = 0;
    if (body) for await (const chunk of body) {
      responseBytes += chunk.length;
      if (responseBytes > metadataLimit) return { status: 502 };
      responseChunks.push(Buffer.from(chunk));
    }
    return { status: result.status, type: result.headers.get("content-type") ?? "application/json", bytes: Buffer.concat(responseChunks) };
  }

  async function route(request: IncomingMessage, active: AbortSignal): Promise<Payload> {
    const target = new URL(request.url ?? "/", origin);
    if (target.origin !== origin || target.search) return { status: 404 };
    if (request.method === "POST") {
      const endpoint = /^\/npm(\/-\/npm\/v1\/security\/(?:advisories\/bulk|audits\/quick))$/u.exec(target.pathname)?.[1];
      return sources.npm && endpoint ? answerNpmAudit(request, new URL(sources.npm[0] + endpoint), active) : { status: 405 };
    }
    const accept = request.headers.accept ?? "*/*";
    const project = /^\/pypi\/simple\/([a-z0-9][a-z0-9._-]*)\/?$/iu.exec(target.pathname)?.[1];
    if (project && sources.python) return answerPythonIndex(project, sources.python, accept, active);
    const file = /^\/files\/([a-f0-9]{64})\/([^/]+)$/u.exec(target.pathname);
    const entry = file?.[1] ? artifacts.get(file[1]) : undefined;
    if (entry && file?.[2]) {
      const name = decodeURIComponent(file[2]);
      if (name === entry.filename) return answerPythonFile(entry, false, active);
      if (entry.metadata && name === entry.filename + ".metadata") return answerPythonFile(entry, true, active);
    }
    const path = target.pathname.slice("/npm".length);
    if (sources.npm && target.pathname.startsWith("/npm/") && npmPath(path)) return answerNpm(path, sources.npm, accept, active);
    return { status: 404 };
  }

  async function serve(request: IncomingMessage, response: ServerResponse) {
    const client = new AbortController();
    const active = AbortSignal.any([signal, shutdown.signal, client.signal]);
    response.once("close", () => client.abort());
    let payload: Payload | undefined;
    try {
      payload = ["GET", "HEAD", "POST"].includes(request.method ?? "") ? await route(request, active) : { status: 405 };
      active.throwIfAborted();
      response.statusCode = payload.status;
      if (payload.type) response.setHeader("content-type", payload.type);
      if (payload.bytes) response.setHeader("content-length", payload.bytes.length);
      if (payload.size !== undefined) response.setHeader("content-length", payload.size);
      if (request.method === "GET" && payload.path) await pipeline(createReadStream(payload.path), response, { signal: active });
      else response.end(request.method === "HEAD" ? undefined : payload.bytes);
    } catch (error) {
      if (active.aborted || response.headersSent) { response.destroy(); return; }
      report?.({ message: formatError(error, access.secrets).slice(0, 1024), activity: true });
      response.statusCode = 502;
      response.end("Build package download failed");
    } finally { await payload?.release?.(); }
  }

  const server = createServer((request, response) => {
    const job = serve(request, response);
    work.add(job);
    void job.then(() => work.delete(job), () => { work.delete(job); response.destroy(); });
  });
  const listen = (port: number) => new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, binding.bind, () => { server.off("error", reject); resolve(); });
  });
  try {
    try { await listen(preferredPort); }
    catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EADDRINUSE") throw error;
      await listen(0);
    }
    signal.throwIfAborted();
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Build package relay has no address");
    origin = "http://" + binding.hostname + ":" + address.port;
    return {
      hostname: binding.hostname,
      ...(sources.python ? { pipIndex: origin + "/pypi/simple", pipTrustedHost: binding.hostname + ":" + address.port } : {}),
      ...(sources.npm ? { npmRegistry: origin + "/npm/" } : {}),
      async close() {
        shutdown.abort();
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        try { await Promise.allSettled(work); }
        finally { await rm(directory, { recursive: true, force: true }); }
      },
    };
  } catch (error) {
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
