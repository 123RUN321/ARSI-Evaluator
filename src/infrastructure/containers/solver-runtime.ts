import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { ContainerPlatform, RuntimeInstallation, RuntimeLocation } from "../../core/contracts/environment.js";
import { EVALUATOR_NODE_EXECUTABLE } from "./runtime-contract.js";
import { copyRuntimeInventory, runtimeInventory } from "../runtime-installation/install.js";

const root = "/opt/evaluator-agent";
const installer = String.raw`import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve, relative, isAbsolute } from "node:path";
import { npmDependencyInstall, publicNpmMirror, withNpmRegistryFallback } from "./package-mirror.mjs";
const root = process.argv[2] ?? "/opt/evaluator-agent";
const manifest = JSON.parse(await readFile(process.argv[3] ?? "/opt/evaluator/installation.json", "utf8"));
for (const command of [...manifest.commands, ...manifest.probes]) {
  const expand = value => value.replaceAll("{root}", root);
  const cwd = resolve(root, command.cwd ?? ".");
  const rel = relative(root, cwd);
  if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) throw new Error("unsafe runtime cwd");
  // Probes must use the Node running this trusted installer, even when a task PATH shadows it.
  const executable = command.executable === "node" ? process.execPath : expand(command.executable);
  const args = command.args.map(expand);
  const env = { ...process.env, ...Object.fromEntries(Object.entries(command.env ?? {}).map(([key, value]) => [key, expand(value)])) };
  const fallback = command.executable === "npm" && npmDependencyInstall(args) && publicNpmMirror(env);
  const run = async environment => {
    const child = spawn(executable, args, { cwd, env: environment, stdio: fallback ? ["inherit", "pipe", "pipe"] : "inherit", shell: false });
    let stdout = "", stderr = "";
    child.stdout?.on("data", chunk => { process.stdout.write(chunk); stdout = (stdout + chunk).slice(-32768); });
    child.stderr?.on("data", chunk => { process.stderr.write(chunk); stderr = (stderr + chunk).slice(-32768); });
    const exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", code => resolve(code ?? -1));
    });
    return { exitCode, stdout, stderr };
  };
  const result = fallback
    ? await withNpmRegistryFallback(env, run, undefined, message => console.error(message))
    : await run(env);
  if (result.exitCode !== 0) throw new Error("runtime command failed: " + command.executable + " (" + result.exitCode + ")");
}
`;
/** The install stage uses only the pinned Node image and the solver inventory. */
export async function prepareSolverLayer(installation: RuntimeInstallation, platform: ContainerPlatform, signal: AbortSignal) {
  const inventory = await runtimeInventory(installation, platform, signal);
  const packageMirror = await readFile(new URL("../network/package-mirror.mjs", import.meta.url), { signal });
  const installerSource = installer + "// Package mirror: " + createHash("sha256").update(packageMirror).digest("hex") + "\n";
  return {
    identity: inventory.identity,
    installer: installerSource,
    runtime: { root, stateRoot: `${root}/state`, persistent: false, identity: inventory.identity } satisfies RuntimeLocation,
    installStage: [
      "FROM evaluator_node AS solver_runtime",
      `COPY inputs/ ${root}/`,
      "COPY install-runtime.mjs /opt/evaluator/install-runtime.mjs",
      "COPY package-mirror.mjs /opt/evaluator/package-mirror.mjs",
      "COPY installation.json /opt/evaluator/installation.json",
      "ARG NPM_CONFIG_REGISTRY",
      "ARG PIP_INDEX_URL",
      `RUN ${EVALUATOR_NODE_EXECUTABLE} /opt/evaluator/install-runtime.mjs && chmod -R a+rX ${root} && mkdir -p ${root}/state && chmod 1777 ${root}/state`,
    ].join("\n"),
    copy: [
      `COPY --from=solver_runtime ${root} ${root}`,
      "COPY --chmod=0444 install-runtime.mjs /opt/evaluator/install-runtime.mjs",
      "COPY --chmod=0444 package-mirror.mjs /opt/evaluator/package-mirror.mjs",
      "COPY --chmod=0444 probes.json /opt/evaluator/installation.json",
    ].join("\n"),
    probe: `RUN ["${EVALUATOR_NODE_EXECUTABLE}", "/opt/evaluator/install-runtime.mjs"]`,
    async write(context: string, active: AbortSignal) {
      const inputs = join(context, "inputs");
      await mkdir(inputs);
      await copyRuntimeInventory(inventory, inputs, active);
      await Promise.all([
        writeFile(join(context, "install-runtime.mjs"), installerSource),
        writeFile(join(context, "package-mirror.mjs"), packageMirror),
        writeFile(join(context, "installation.json"), JSON.stringify({ commands: inventory.commands, probes: inventory.probes })),
        writeFile(join(context, "probes.json"), JSON.stringify({ commands: [], probes: inventory.probes })),
      ]);
    },
  };
}
