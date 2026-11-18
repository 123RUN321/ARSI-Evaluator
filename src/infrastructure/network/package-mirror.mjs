import { request as requestHttp } from "node:http";
import { request as requestHttps } from "node:https";
import { stripVTControlCharacters } from "node:util";

const officialRegistry = "https://registry.npmjs.org";
const repositoryMirror = "https://registry.npmmirror.com";
const publicMirrors = new Set([repositoryMirror, "https://registry.npm.taobao.org"]);
const transientStatus = [408, 429, 500, 502, 503, 504];
const transport = /\b(?:ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ENETUNREACH|UND_ERR_SOCKET|ETIMEDOUT|ESOCKETTIMEDOUT|ERR_SOCKET_TIMEOUT)\b|socket hang up|tunneling socket could not be established/iu;

export function npmRegistrySources(env) {
  const source = (env.npm_config_registry ?? env.NPM_CONFIG_REGISTRY)?.replace(/\/$/u, "");
  if (!source || source === officialRegistry) return [];
  if (source.startsWith("https:") && source === env.EVALUATOR_NPM_PUBLIC_MIRROR)
    return [...new Set([source, repositoryMirror, officialRegistry])];
  return publicMirrors.has(source) ? [source, officialRegistry] : [];
}

export function publicNpmMirror(env) {
  return npmRegistrySources(env)[0];
}

export function npmDependencyInstall(args) {
  return args[0] === "ci" && args.includes("--ignore-scripts")
    && !args.some(arg => /^--(?:registry|userconfig|globalconfig|no-ignore-scripts)(?:=|$)|^--ignore-scripts=/u.test(arg));
}

/** Check the final failure, not warnings about individual retries. */
async function npmMirrorFailure(result, mirror, env, signal) {
  if (result.exitCode <= 0) return false;
  const host = new URL(mirror).hostname;
  const diagnostic = stripVTControlCharacters(result.stderr + "\n" + result.stdout);
  if (/\b(?:E401|E403|EAUTH|EINTEGRITY|ERR_PNPM_TARBALL_INTEGRITY|ERESOLVE|ERR_PNPM_(?:OUTDATED|BROKEN)_LOCKFILE)\b|certificate|integrity checksum/iu.test(diagnostic)) return false;
  const lines = diagnostic.split(/\r?\n/u);
  const terminalLines = lines.filter(line => !/\b(?:WARN|warning)\b/iu.test(line));
  const details = terminalLines.filter(line => line.includes(host));
  if (details.some(line => {
    const safeStatus = /\b(?:E|ERR_PNPM_FETCH_|HTTP(?: status)?[: ]+)(?:408|429|500|502|503|504)\b|\b(?:408|429|500|502|503|504) (?:Server Error|Service Unavailable|Bad Gateway|Gateway Timeout|Too Many Requests)\b/iu;
    return safeStatus.test(line) || transport.test(line);
  })) return true;
  // pnpm 11 can report a bare fetch error, with the URL only in its retry
  // warning. Newer releases expose the tunnel failure without the HTTP code.
  const pnpmFetchFailed = terminalLines.some(line => /^\[ERROR\] fetch failed\s*$/u.test(line))
    && lines.some(line => line.includes(host) && /^\[WARN\] GET https?:\/\/\S+ error \(0\)\. Will retry/iu.test(line));
  const pnpmTunnelFailed = details.length > 0 && /tunnel error:\s*unsuccessful/iu.test(terminalLines.join("\n"));
  return (pnpmFetchFailed || pnpmTunnelFailed) && await probeMirror(new URL(mirror), env, signal);
}

async function probeMirror(target, env, signal) {
  const host = target.hostname;
  const proxyValue = env.https_proxy || env.HTTPS_PROXY;
  const bypass = (env.no_proxy ?? env.NO_PROXY ?? "").split(",").some(value => {
    const domain = value.trim().toLowerCase().replace(/^\.|:443$/gu, "");
    return domain === "*" || host === domain || host.endsWith("." + domain);
  });
  const authority = target.port ? target.host : host + ":443";
  let request = requestHttps;
  let options = { hostname: host.replace(/^\[|\]$/gu, ""), port: target.port || undefined, method: "HEAD", path: target.pathname };
  if (proxyValue && !bypass) {
    let proxy;
    try { proxy = new URL(proxyValue); }
    catch { return false; }
    if (proxy.protocol !== "http:" && proxy.protocol !== "https:") return false;
    const headers = { host: authority };
    if (proxy.username || proxy.password) {
      const credentials = decodeURIComponent(proxy.username) + ":" + decodeURIComponent(proxy.password);
      headers["proxy-authorization"] = "Basic " + Buffer.from(credentials).toString("base64");
    }
    request = proxy.protocol === "https:" ? requestHttps : requestHttp;
    options = { hostname: proxy.hostname.replace(/^\[|\]$/gu, ""), port: proxy.port || undefined,
      method: "CONNECT", path: authority, headers };
  }
  const deadline = AbortSignal.timeout(10_000);
  const active = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const retryable = await new Promise(resolve => {
    const probe = request({ ...options, agent: false, signal: active });
    probe.once("connect", (response, socket) => { socket.destroy(); resolve(transientStatus.includes(response.statusCode)); });
    probe.once("response", response => { response.destroy(); resolve(transientStatus.includes(response.statusCode)); });
    probe.once("error", error => resolve(transport.test(error.code ?? "")));
    probe.end();
  });
  signal?.throwIfAborted();
  return retryable;
}

export async function withNpmRegistryFallback(env, run, signal, log) {
  signal?.throwIfAborted();
  const sources = npmRegistrySources(env);
  let result = await run(env);
  const priorFailures = [];
  for (let index = 1; index < sources.length; index++) {
    if (!await npmMirrorFailure(result, sources[index - 1], env, signal)) break;
    signal?.throwIfAborted();
    const registry = sources[index];
    log("npm registry mirror unavailable; trying " + registry);
    priorFailures.push(result.stderr || result.stdout);
    const fallbackEnv = Object.fromEntries(Object.entries(env).filter(([key]) =>
      !/^(?:NPM_TOKEN|NODE_AUTH_TOKEN|NPM_CONFIG_(?:_AUTH|_AUTHTOKEN|_PASSWORD|USERNAME))$/iu.test(key)));
    result = await run({ ...fallbackEnv, NPM_CONFIG_REGISTRY: registry, npm_config_registry: registry, COREPACK_NPM_REGISTRY: registry });
  }
  return result.exitCode === 0 || !priorFailures.length ? result : { ...result,
    stderr: [...priorFailures, result.stderr || result.stdout].join("\n") };
}
