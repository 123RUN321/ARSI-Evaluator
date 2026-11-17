import { NetworkRuntime } from "../../src/infrastructure/network/runtime.js";
import { networkDocument } from "../../src/config/network-schema.js";
import { createDockerImagePuller } from "../../src/infrastructure/containers/image-pull.js";
import { mirrorImageReference } from "../../src/infrastructure/containers/registry-image.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { DockerRuntime } from "../../src/infrastructure/containers/runtime.js";
import { PINNED_NODE_IMAGE, type DockerCommand } from "../../src/infrastructure/containers/runtime-contract.js";

afterEach(() => vi.unstubAllEnvs());
const runtimeWithMirror = (command: DockerCommand, platform: "linux/amd64" | "linux/arm64" = "linux/amd64") => new DockerRuntime(command, PINNED_NODE_IMAGE, platform,
  createDockerImagePuller(command, { network: new NetworkRuntime(networkDocument({ docker: { mirrors: { "docker.io": origin } } }, {})) }));
const origin = "https://fixture.mirror.example.test";
const mirrored = `${new URL(origin).host}/library/${PINNED_NODE_IMAGE}`;
const digest = "sha256:" + "a".repeat(64);

test.each(["docker.io", "registry-1.docker.io", "index.docker.io"])("does not rewrite a Docker Hub reference to its own alias %s", host => {
  expect(mirrorImageReference(PINNED_NODE_IMAGE, { "docker.io": `https://${host}` })).toBe(PINNED_NODE_IMAGE);
});

test.each(["linux/amd64", "linux/arm64"] as const)("shares a configured Node mirror pull and builds with its pinned reference on %s", async platform => {
  vi.stubEnv("EVALUATOR_NODE_IMAGE_MIRROR", "");
  const calls: string[][] = [];
  let pulled = false;
  const command: DockerCommand = async args => {
    if (args.at(-1) === "{{json .Config.User}}") return { stdout: JSON.stringify(""), stderr: "" };
    calls.push(args);
    if (args[0] === "info") return { stdout: JSON.stringify(["https://other.test", origin + "/"]), stderr: "" };
    if (args[0] === "pull") { pulled = true; return { stdout: "", stderr: "" }; }
    if (args[0] === "build") {
      expect(args).toContain(`NODE_IMAGE=${mirrored}`);
      expect(await readFile(join(args.at(-1)!, "Dockerfile"), "utf8")).toContain("FROM ${NODE_IMAGE}");
      return { stdout: "", stderr: "" };
    }
    const ref = args[4];
    if (ref === PINNED_NODE_IMAGE || (ref === mirrored && !pulled)) throw new Error("No such image");
    if (ref?.includes(":solve-runtime-") && !calls.some(call => call[0] === "build")) throw new Error("No such image");
    if (args.at(-1)?.includes(".Os")) return { stdout: JSON.stringify([digest, "linux", platform.split("/")[1]]), stderr: "" };
    return { stdout: args.at(-1)?.includes("RepoDigests") ? `${digest} ${JSON.stringify([mirrored])}` : digest, stderr: "" };
  };
  const runtime = runtimeWithMirror(command, platform);
  await Promise.all([runtime.prepare("base", [], AbortSignal.timeout(5000)), runtime.prepare("base", [], AbortSignal.timeout(5000))]);
  expect(runtime.nodeImage).toBe(mirrored);
  expect(calls.filter(args => args[0] === "pull")).toEqual([["pull", "--platform", platform, mirrored]]);
  expect(calls.filter(args => args[0] === "info")).toHaveLength(0);
  expect(calls.filter(args => args[0] === "build")).toHaveLength(1);
});

test("keeps a locally cached official Node image without contacting a registry", async () => {
  const command = vi.fn<DockerCommand>().mockResolvedValue({ stdout: `${digest} ${JSON.stringify([PINNED_NODE_IMAGE])}`, stderr: "" });
  const runtime = new DockerRuntime(command);
  expect(await runtime.nodeImageDigest(AbortSignal.timeout(5000))).toBe(digest);
  expect(runtime.nodeImage).toBe(PINNED_NODE_IMAGE);
  expect(command).toHaveBeenCalledTimes(1);
});

test("an explicit mirror still rejects the wrong digest without falling back", async () => {
  const calls: string[][] = [];
  const command: DockerCommand = async args => {
    calls.push(args);
    if (args[4] === PINNED_NODE_IMAGE) throw new Error("No such image");
    if (args.at(-1)?.includes(".Os")) return { stdout: JSON.stringify([digest, "linux", "amd64"]), stderr: "" };
    return { stdout: `${digest} ["registry.test/node@sha256:${"b".repeat(64)}"]`, stderr: "" };
  };
  await expect(runtimeWithMirror(command).nodeImageDigest(AbortSignal.timeout(5000))).rejects.toThrow("expected sha256:");
  expect(calls.some(args => args[0] === "pull")).toBe(false);
});

test("retries a transient mirror failure before pulling the original pinned Node image", async () => {
  vi.stubEnv("EVALUATOR_NODE_IMAGE_MIRROR", "");
  const pulls: string[] = [];
  let installed = false;
  const command: DockerCommand = async args => {
    if (args[0] === "pull") {
      const ref = args.at(-1)!;
      pulls.push(ref);
      if (ref === mirrored) throw new Error("dial tcp: lookup fixture.mirror.example.test: no such host");
      installed = true;
      return { stdout: "", stderr: "" };
    }
    if (installed && args[4] === PINNED_NODE_IMAGE)
      return { stdout: `${digest} ${JSON.stringify([PINNED_NODE_IMAGE])}`, stderr: "" };
    throw new Error("No such image");
  };
  const runtime = runtimeWithMirror(command);
  await expect(runtime.nodeImageDigest(AbortSignal.timeout(10_000))).resolves.toBe(digest);
  expect(runtime.nodeImage).toBe(PINNED_NODE_IMAGE);
  expect(pulls).toEqual([mirrored, mirrored, mirrored, PINNED_NODE_IMAGE]);
}, 15_000);

test("a registry authorization error does not try the original source", async () => {
  const command = vi.fn<DockerCommand>().mockImplementation(async args => {
    throw new Error(args[0] === "pull" ? "Registry request failed (HTTP 403)" : "No such image");
  });
  await expect(runtimeWithMirror(command).nodeImageDigest(AbortSignal.timeout(5000))).rejects.toThrow("HTTP 403");
  expect(command.mock.calls.map(([args]) => args).filter(args => args[0] === "pull")).toEqual([["pull", "--platform", "linux/amd64", mirrored]]);
});
