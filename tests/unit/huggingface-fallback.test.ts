import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { networkDocument } from "../../src/config/network-schema.js";
import { DatasetCache } from "../../src/infrastructure/datasets/cache.js";
import { fetchHuggingFaceFile, fetchHuggingFaceMetadata, huggingfaceTransport } from "../../src/infrastructure/datasets/sources/huggingface/endpoint.js";
import { NetworkRuntime } from "../../src/infrastructure/network/runtime.js";

const mirror = "https://hf-mirror.com";
const official = "https://huggingface.co";
const metadata = "/api/datasets/example/release/revision/v1?blobs=true";
const path = `/datasets/example/release/resolve/${"a".repeat(40)}/fixture.jsonl`;
const headers = { Authorization: "Bearer fixture-hub-token" };
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(endpoint: string | { mirror: string } = mirror) {
  const root = await mkdtemp(join(tmpdir(), "hf-fallback-"));
  roots.push(root);
  const network = new NetworkRuntime(networkDocument({ sources: { huggingface: endpoint } }, {}));
  const fetch = vi.spyOn(network, "fetch");
  const cache = new DatasetCache(root, network);
  const transport = huggingfaceTransport({}, network);
  return { network, fetch, cache, transport };
}

test("falls back to the official origin without sending the mirror's credentials", async () => {
  const f = await fixture();
  const bytes = "locked fixture";
  const digest = createHash("sha256").update(bytes).digest("hex");
  f.fetch.mockImplementation(async input => new Response(String(input) === official + path ? bytes : "{}", {
    status: String(input) === mirror + metadata ? 503 : String(input) === mirror + path ? 404 : 200,
  }));
  const signal = AbortSignal.timeout(10_000);
  await expect(fetchHuggingFaceMetadata(mirror + metadata, f.transport, signal, headers, f.network)).resolves.toMatchObject({ status: 200 });
  const downloaded = await fetchHuggingFaceFile(f.cache, mirror + path, f.transport, digest, signal, headers);
  expect(await readFile(downloaded.path, "utf8")).toBe(bytes);
  expect(f.fetch.mock.calls.map(([url]) => url)).toEqual([
    mirror + metadata, mirror + metadata, mirror + metadata, official + metadata, mirror + path, official + path,
  ]);
  expect(f.fetch.mock.calls.map(([, init]) => new Headers(init?.headers).get("authorization"))).toEqual([
    headers.Authorization, headers.Authorization, headers.Authorization, null, headers.Authorization, null,
  ]);
}, 15_000);

test("tries the configured public mirror, the repository mirror, then the official Hub", async () => {
  const endpoint = "https://public-mirror.example.test";
  const f = await fixture({ mirror: endpoint });
  f.fetch.mockImplementation(async input => {
    const target = String(input);
    if (target === official + metadata) return new Response("{}");
    if (target === official + path) return new Response("public file");
    return new Response(null, { status: target.endsWith(metadata) ? 503 : 404 });
  });
  const signal = AbortSignal.timeout(12_000);
  await expect(fetchHuggingFaceMetadata(endpoint + metadata, f.transport, signal, headers, f.network)).resolves.toMatchObject({ status: 200 });
  const downloaded = await fetchHuggingFaceFile(f.cache, endpoint + path, f.transport, null, signal, headers);
  expect(await readFile(downloaded.path, "utf8")).toBe("public file");
  expect(f.fetch.mock.calls.map(([url, init]) => [url, new Headers(init?.headers).get("authorization")])).toEqual([
    ...Array.from({ length: 3 }, () => [endpoint + metadata, headers.Authorization]),
    ...Array.from({ length: 3 }, () => [mirror + metadata, null]),
    [official + metadata, null], [endpoint + path, headers.Authorization], [mirror + path, null], [official + path, null],
  ]);
}, 15_000);

test("stops at a permanent error on the repository mirror", async () => {
  const endpoint = "https://public-mirror.example.test";
  const f = await fixture({ mirror: endpoint });
  f.fetch.mockImplementation(async input => new Response(null, { status: String(input) === endpoint + path ? 404 : 403 }));
  await expect(fetchHuggingFaceFile(f.cache, endpoint + path, f.transport, null, AbortSignal.timeout(5000), headers))
    .rejects.toMatchObject({ errors: [expect.objectContaining({ message: expect.stringContaining("HTTP 404") }),
      expect.objectContaining({ message: expect.stringContaining("HTTP 403") })] });
  expect(f.fetch.mock.calls.map(([url]) => url)).toEqual([endpoint + path, mirror + path]);
});

test("uses the same anonymous chain when the cache rewrites an official download to a configured mirror", async () => {
  const endpoint = "https://public-mirror.example.test";
  const f = await fixture({ mirror: endpoint });
  f.fetch.mockImplementation(async input => String(input) === official + path ? new Response("public file") : new Response(null, { status: 404 }));
  await f.cache.fetch(official + path, null, AbortSignal.timeout(5000), headers);
  expect(f.fetch.mock.calls.map(([url, init]) => [url, new Headers(init?.headers).get("authorization")])).toEqual([
    [endpoint + path, null], [mirror + path, null], [official + path, null],
  ]);
});

test("keeps authenticated metadata and file requests on the self-hosted Hub", async () => {
  const endpoint = "https://hub.internal.test";
  const f = await fixture(endpoint);
  f.fetch.mockImplementation(async input => new Response(null, { status: String(input).includes("/api/") ? 503 : 404 }));
  const signal = AbortSignal.timeout(10_000);
  await expect(fetchHuggingFaceMetadata(endpoint + metadata, f.transport, signal, headers, f.network))
    .rejects.toMatchObject({ code: "NETWORK_FAILURE" });
  await expect(fetchHuggingFaceFile(f.cache, endpoint + path, f.transport, null, signal, headers)).rejects.toThrow("HTTP 404");
  expect(f.fetch.mock.calls.map(([url, init]) => [url, new Headers(init?.headers).get("authorization")])).toEqual([
    [endpoint + metadata, headers.Authorization], [endpoint + metadata, headers.Authorization],
    [endpoint + metadata, headers.Authorization], [endpoint + path, headers.Authorization],
  ]);
}, 15_000);

test.each(["https://hf-mirror.com.internal.test", "https://hf-mirror.com:8443", "http://hf-mirror.com"])(
  "does not interpret %s as the public mirror origin", async endpoint => {
    const f = await fixture(endpoint);
    f.fetch.mockResolvedValueOnce(new Response(null, { status: 404 }));
    await expect(fetchHuggingFaceFile(f.cache, endpoint + path, f.transport, null, AbortSignal.timeout(5000), headers)).rejects.toThrow("HTTP 404");
    expect(f.fetch.mock.calls.map(([url]) => url)).toEqual([endpoint + path]);
  },
);

test.each([mirror, "https://hub.internal.test"])("binds credentials to the original URL when the cache rewrites downloads to %s", async endpoint => {
  const f = await fixture(endpoint);
  f.fetch.mockImplementation(async input => String(input) === official + path ? new Response("public file") : new Response(null, { status: 404 }));
  const result = f.cache.fetch(official + path, null, AbortSignal.timeout(5000), headers);
  if (endpoint === mirror) await expect(result).resolves.toMatchObject({ sha256: createHash("sha256").update("public file").digest("hex") });
  else await expect(result).rejects.toThrow("HTTP 404");
  expect(f.fetch.mock.calls.map(([url, init]) => [url, new Headers(init?.headers).get("authorization")])).toEqual(
    endpoint === mirror ? [[endpoint + path, null], [official + path, null]] : [[endpoint + path, null]],
  );
});

test.each([200, 403])("keeps the first error on HF checksum failure or authorization rejection (HTTP %i)", async status => {
  const f = await fixture();
  f.fetch.mockImplementation(async () => new Response("wrong fixture", { status }));
  await expect(fetchHuggingFaceFile(f.cache, mirror + path, f.transport, "a".repeat(64), AbortSignal.timeout(5000)))
    .rejects.toThrow(status === 200 ? "checksum mismatch" : "HTTP 403");
  expect(f.fetch.mock.calls.map(([url]) => url)).toEqual([mirror + path]);
});

test("keeps both failures when the mirror and official file downloads fail", async () => {
  const f = await fixture();
  f.fetch.mockImplementation(async input => new Response(null, { status: String(input) === mirror + path ? 404 : 403 }));
  await expect(fetchHuggingFaceFile(f.cache, mirror + path, f.transport, null, AbortSignal.timeout(5000)))
    .rejects.toMatchObject({ errors: [expect.objectContaining({ message: expect.stringContaining("HTTP 404") }),
      expect.objectContaining({ message: expect.stringContaining("HTTP 403") })] });
  expect(f.fetch.mock.calls.map(([url]) => url)).toEqual([mirror + path, official + path]);
});

test("does not switch origins after cancellation", async () => {
  const f = await fixture();
  const cancelled = new AbortController();
  f.fetch.mockImplementation(async () => {
    cancelled.abort(new Error("cancelled fixture"));
    return new Response(null, { status: 404 });
  });
  await expect(fetchHuggingFaceFile(f.cache, mirror + path, f.transport, null, cancelled.signal)).rejects.toThrow("cancelled fixture");
  expect(f.fetch.mock.calls.map(([url]) => url)).toEqual([mirror + path]);
});

test("keeps credentials on a directly configured official endpoint", async () => {
  const direct = await fixture(official);
  direct.fetch.mockImplementation(async input => new Response(null, { status: String(input) === official + metadata ? 200 : 404 }));
  const signal = AbortSignal.timeout(5000);
  await expect(fetchHuggingFaceMetadata(official + metadata, direct.transport, signal, headers, direct.network)).resolves.toMatchObject({ status: 200 });
  await expect(fetchHuggingFaceFile(direct.cache, official + path, direct.transport, null, signal, headers)).rejects.toThrow("HTTP 404");
  expect(direct.fetch.mock.calls.map(([url, init]) => [url, new Headers(init?.headers).get("authorization")])).toEqual([
    [official + metadata, headers.Authorization], [official + path, headers.Authorization],
  ]);
});
