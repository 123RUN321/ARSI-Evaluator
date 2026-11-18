import { createHash } from "node:crypto";
import { expect, test, vi } from "vitest";
import { networkDocument } from "../../src/config/network-schema.js";
import { buildPackageSources, openBuildPackageRelay } from "../../src/infrastructure/containers/build-package-relay.js";
import { dockerBuildNetwork } from "../../src/infrastructure/containers/build-network.js";
import { rewritePythonIndex } from "../../src/infrastructure/containers/python-index.js";
import { NetworkRuntime } from "../../src/infrastructure/network/runtime.js";

const mirror = "https://mirrors.aliyun.com";
const registry = "https://registry.npmmirror.com";
const network = () => new NetworkRuntime(networkDocument({ sources: {
  python: { index: mirror + "/pypi/simple" }, npm: { registry },
} }, {}));
const accept = { accept: "application/vnd.pypi.simple.v1+json" };

test("preserves PyPI HTML file hashes, yanks, requirements and sidecar digests", () => {
  const fileDigest = "a".repeat(64);
  const metadataDigest = "b".repeat(64);
  const contents = `<a data-yanked="reason > missing" data-requires-python='&gt;=3.11' href='../../foo.whl?x=1&amp;y=2#sha256=${fileDigest}' data-core-metadata="sha256=${metadataDigest}">foo.whl</a>`;
  const replace = vi.fn(() => "http://relay/files/foo.whl#sha256=" + fileDigest);
  const result = rewritePythonIndex(contents, replace);
  expect(replace).toHaveBeenCalledWith({ url: "../../foo.whl?x=1&y=2#sha256=" + fileDigest, sha256: fileDigest, metadata: metadataDigest });
  expect(result).toBe(`<a data-yanked="reason > missing" data-requires-python='&gt;=3.11' href="http://relay/files/foo.whl#sha256=${fileDigest}" data-core-metadata="sha256=${metadataDigest}">foo.whl</a>`);
});

test("extra Python indexes and private registries keep their configured routes", () => {
  const access = new NetworkRuntime(networkDocument({ sources: {
    python: { index: mirror + "/pypi/simple", extraIndexes: ["https://private.example/simple"] },
    npm: { registry: "https://private.example/npm" },
  } }, {}));
  expect(buildPackageSources(access)).toEqual({});
  const publicBuild = dockerBuildNetwork(network(), {}, {
    hostname: "host.docker.internal", pipIndex: "http://host.docker.internal:1234/pypi/simple",
    pipTrustedHost: "host.docker.internal:1234", npmRegistry: "http://host.docker.internal:1234/npm/",
  });
  expect(publicBuild.environment).toMatchObject({
    NO_PROXY: expect.stringContaining("host.docker.internal"), PIP_TRUSTED_HOST: "host.docker.internal:1234",
    NPM_CONFIG_REGISTRY: "http://host.docker.internal:1234/npm/", npm_config_registry: "http://host.docker.internal:1234/npm/",
  });
  expect(publicBuild.recipe("FROM scratch\nRUN pip install six\nRUN npm ci\n")).toContain("RUN pip install six\nRUN npm ci\n");
});

test("retries an interrupted Python download and returns only a matching official file", async () => {
  const access = network();
  const wheel = "wheel contents";
  const filename = "sample-1.0-py3-none-any.whl";
  const digest = createHash("sha256").update(wheel).digest("hex");
  const requests: string[] = [];
  vi.spyOn(access, "fetch").mockImplementation(async input => {
    const target = String(input);
    requests.push(target);
    const file = (url: string, sha256: string) => ({ filename, url, hashes: { sha256 }, "requires-python": ">=3.11" });
    if (target === mirror + "/pypi/simple/sample/") return Response.json({ files: [file(mirror + "/packages/" + filename, digest)] });
    if (target === mirror + "/packages/" + filename) return new Response("truncated", { headers: { "content-length": String(wheel.length) } });
    if (target === "https://pypi.org/simple/sample/") return Response.json({ files: [
      file("https://files.pythonhosted.org/wrong/" + filename, "a".repeat(64)), file("https://files.pythonhosted.org/correct/" + filename, digest),
    ] });
    expect(target).toBe("https://files.pythonhosted.org/correct/" + filename);
    return new Response(wheel);
  });
  const relay = await openBuildPackageRelay(access, buildPackageSources(access), { bind: "127.0.0.1", hostname: "127.0.0.1" }, AbortSignal.timeout(10_000));
  try {
    const page = await fetch(relay.pipIndex + "/sample/", { headers: accept });
    const data = await page.json() as { files: { url: string; "requires-python": string }[] };
    const wheelLink = data.files[0]!;
    expect(wheelLink["requires-python"]).toBe(">=3.11");
    const result = await fetch(wheelLink.url);
    expect(result.status).toBe(200);
    expect(await result.text()).toBe(wheel);
    expect(requests).toEqual([mirror + "/pypi/simple/sample/", ...Array<string>(3).fill(mirror + "/packages/" + filename),
      "https://pypi.org/simple/sample/", "https://files.pythonhosted.org/correct/" + filename]);
  } finally { await relay.close(); }
}, 12_000);

test("does not switch registries after npm authorization failure, including audit", async () => {
  const access = network();
  const requests = vi.spyOn(access, "fetch").mockImplementation(async () => new Response(null, { status: 403 }));
  const relay = await openBuildPackageRelay(access, buildPackageSources(access), { bind: "127.0.0.1", hostname: "127.0.0.1" }, AbortSignal.timeout(10_000));
  try {
    const registryUrl = relay.npmRegistry!;
    expect((await fetch(registryUrl + "sample/-/sample-1.0.0.tgz")).status).toBe(403);
    expect((await fetch(registryUrl + "-/npm/v1/security/advisories/bulk", { method: "POST", body: '{"sample":["1.0.0"]}' })).status).toBe(403);
    expect(requests.mock.calls.map(([target]) => String(target))).toEqual([
      registry + "/sample/-/sample-1.0.0.tgz", registry + "/-/npm/v1/security/advisories/bulk",
    ]);
  } finally { await relay.close(); }
});
