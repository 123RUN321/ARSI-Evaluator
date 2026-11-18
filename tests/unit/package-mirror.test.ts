import { expect, test, vi } from "vitest";
import { createServer } from "node:http";
import { npmDependencyInstall, withNpmRegistryFallback } from "../../src/infrastructure/network/package-mirror.mjs";

const mirror = "https://registry.npmmirror.com";
const official = "https://registry.npmjs.org";
const selected = { npm_config_registry: mirror, NPM_CONFIG_REGISTRY: mirror, COREPACK_NPM_REGISTRY: mirror };
const result = (exitCode: number, stderr = "", stdout = "") => ({ exitCode, stderr, stdout });

test.each([
  result(1, "npm error 503 Service Unavailable - GET https://registry.npmmirror.com/package"),
  result(1, "", "ERR_PNPM_FETCH_503 GET https://registry.npmmirror.com/package"),
])("switches the registry only after the package manager reports a mirror failure", async failure => {
  const success = result(0);
  const run = vi.fn<(env: NodeJS.ProcessEnv) => Promise<typeof success>>().mockResolvedValueOnce(failure).mockResolvedValueOnce(success);
  await expect(withNpmRegistryFallback(selected, run, new AbortController().signal, vi.fn())).resolves.toEqual(success);
  expect(run.mock.calls.map(([env]) => env)).toEqual([selected, {
    npm_config_registry: official, NPM_CONFIG_REGISTRY: official, COREPACK_NPM_REGISTRY: official,
  }]);
});

test.each([
  "npm error E403 Forbidden - GET https://registry.npmmirror.com/fixture",
  "npm error EINTEGRITY integrity checksum failed at https://registry.npmmirror.com/fixture",
  "npm error 503 Service Unavailable - GET https://private.example/fixture",
  "npm error missing package at https://registry.npmmirror.com/package-503",
  "WARN GET https://registry.npmmirror.com/package error HTTP 503",
])("leaves an unrelated or permanent package failure at the original source", async diagnostic => {
  const failure = result(1, diagnostic);
  const run = vi.fn().mockResolvedValue(failure);
  await expect(withNpmRegistryFallback(selected, run, new AbortController().signal, vi.fn())).resolves.toEqual(failure);
  expect(run).toHaveBeenCalledTimes(1);
});

test("keeps both diagnostics and stops on cancellation before switching", async () => {
  const primary = result(1, "npm error E503 at https://registry.npmmirror.com/fixture");
  const fallback = result(1, "npm error E403 at https://registry.npmjs.org/fixture");
  const run = vi.fn().mockResolvedValueOnce(primary).mockResolvedValueOnce(fallback);
  await expect(withNpmRegistryFallback(selected, run, new AbortController().signal, vi.fn())).resolves.toEqual({
    ...fallback, stderr: primary.stderr + "\n" + fallback.stderr,
  });
  const cancelled = new AbortController();
  const attempt = vi.fn().mockImplementation(async () => { cancelled.abort(new Error("cancelled")); return primary; });
  await expect(withNpmRegistryFallback(selected, attempt, cancelled.signal, vi.fn())).rejects.toThrow("cancelled");
  expect(attempt).toHaveBeenCalledTimes(1);
});

test("managed npm retries require a locked install with scripts disabled", () => {
  expect(npmDependencyInstall(["ci", "--ignore-scripts"])).toBe(true);
  expect(npmDependencyInstall(["ci"])).toBe(false);
  expect(npmDependencyInstall(["ci", "--ignore-scripts", "--registry=https://private.example"])).toBe(false);
  expect(npmDependencyInstall(["ci", "--ignore-scripts", "--no-ignore-scripts"])).toBe(false);
});

test("tries the selected public registry, npmmirror, then npm without forwarding unscoped tokens", async () => {
  const registry = "https://custom.example/npm";
  const env = { npm_config_registry: registry, EVALUATOR_NPM_PUBLIC_MIRROR: registry, NPM_TOKEN: "fixture-token" };
  const run = vi.fn().mockResolvedValueOnce(result(1, "E503 " + registry))
    .mockResolvedValueOnce(result(1, "E503 " + mirror)).mockResolvedValueOnce(result(0));
  const expected = await withNpmRegistryFallback(env, run, AbortSignal.timeout(5000), vi.fn());
  expect(expected.exitCode).toBe(0);
  expect(run.mock.calls.map(([environment]) => [environment.npm_config_registry, environment.NPM_TOKEN])).toEqual([
    [registry, "fixture-token"], [mirror, undefined], [official, undefined],
  ]);
});

test.each([
  [503, "Failed to fetch https://registry.npmmirror.com/fixture.tgz\n  tunnel error: unsuccessful"],
  [503, "[WARN] GET https://registry.npmmirror.com/fixture.tgz error (0). Will retry in 10 seconds.\n[ERROR] fetch failed"],
  [407, "Failed to fetch https://registry.npmmirror.com/fixture.tgz\n  tunnel error: unsuccessful"],
] as const)("checks proxy CONNECT HTTP %i before switching an opaque pnpm failure", async (status, diagnostic) => {
  const targets: (string | undefined)[] = [];
  const proxy = createServer();
  proxy.on("connect", (request, socket) => {
    targets.push(request.url);
    socket.end("HTTP/1.1 " + status + " Fixture\r\nConnection: close\r\n\r\n");
  });
  await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));
  try {
    const address = proxy.address();
    if (!address || typeof address === "string") throw new Error("Proxy fixture did not start");
    const failure = result(1, diagnostic);
    const run = vi.fn().mockResolvedValueOnce(failure).mockResolvedValueOnce(result(0));
    const outcome = await withNpmRegistryFallback({ ...selected, https_proxy: "http://127.0.0.1:" + address.port },
      run, AbortSignal.timeout(5000), vi.fn());
    expect(targets).toEqual(["registry.npmmirror.com:443"]);
    expect(run).toHaveBeenCalledTimes(status === 503 ? 2 : 1);
    expect(outcome.exitCode).toBe(status === 503 ? 0 : 1);
  } finally {
    await new Promise<void>(resolve => proxy.close(() => resolve()));
  }
});
