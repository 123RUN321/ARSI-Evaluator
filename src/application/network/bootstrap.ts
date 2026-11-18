import { packageManagerCli } from "../../infrastructure/network/package-manager.js";
import { spawn } from "node:child_process";
import { loadNetworkConfig } from "../../config/network.js";
import { networkEnvironment } from "../../infrastructure/network/environment.js";
import { npmDependencyInstall, publicNpmMirror, withNpmRegistryFallback } from "../../infrastructure/network/package-mirror.mjs";

const args = process.argv.slice(2);
const separator = args.indexOf("--");
if (separator < 0 || !args[separator + 1] || separator !== 0 && (separator !== 2 || args[0] !== "--network"))
  throw new Error("Usage: node scripts/network/bootstrap.mjs [--network network.yaml] -- executable [args...]");
const document = await loadNetworkConfig(separator === 2 ? args[1] : undefined);
const env = networkEnvironment(document.settings, "host", process.env);
env.EVALUATOR_NETWORK_CONFIG = document.origin;
const command = args[separator + 1]!;
const commandArgs = args.slice(separator + 2);
let executable = command;
let packageManagerArgs: string[] = [];
// Avoid cmd.exe interpolation of arguments on Windows. npm and pnpm ship JS entry points.
if (process.platform === "win32" && (command === "npm" || command === "pnpm")) {
  packageManagerArgs = [await packageManagerCli(command)];
  executable = process.execPath;
}
const controller = new AbortController();
const cancel = () => controller.abort();
process.once("SIGINT", cancel);
process.once("SIGTERM", cancel);

async function run(args: string[], environment: NodeJS.ProcessEnv, capture = false) {
  const child = spawn(executable, [...packageManagerArgs, ...args], {
    env: environment, stdio: capture ? ["inherit", "pipe", "pipe"] : "inherit",
    shell: false, windowsHide: true, signal: controller.signal,
  });
  let stdout = "", stderr = "";
  child.stdout?.on("data", chunk => { process.stdout.write(chunk); stdout = (stdout + chunk).slice(-32768); });
  child.stderr?.on("data", chunk => { process.stderr.write(chunk); stderr = (stderr + chunk).slice(-32768); });
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", code => resolve(code ?? 1));
  });
  return { stdout, stderr, exitCode };
}

try {
  const [operation, ...flags] = commandArgs;
  const mirror = publicNpmMirror(env);
  const pnpmPrefetch = mirror && command === "pnpm" && operation === "install"
    && flags.includes("--frozen-lockfile") && flags.every(flag => ["--frozen-lockfile", "--prod", "--dev"].includes(flag));
  const pnpmFetch = mirror && command === "pnpm" && operation === "fetch" && !flags.some(flag => /^--registry(?:=|$)/u.test(flag));
  const npmInstall = mirror && command === "npm" && npmDependencyInstall(commandArgs);
  if (pnpmPrefetch || pnpmFetch || npmInstall) {
    const download = pnpmPrefetch ? ["fetch", ...flags.filter(flag => flag !== "--frozen-lockfile")] : commandArgs;
    let selectedEnvironment: NodeJS.ProcessEnv = env;
    const fetched = await withNpmRegistryFallback(env, environment => {
      selectedEnvironment = environment;
      const registry = command === "pnpm" && environment.npm_config_registry ? ["--registry", environment.npm_config_registry] : [];
      return run([...download, ...registry], environment, true);
    }, controller.signal, message => process.stderr.write(message + "\n"));
    process.exitCode = fetched.exitCode === 0 && pnpmPrefetch
      ? (await run([...commandArgs, "--offline"], selectedEnvironment)).exitCode : fetched.exitCode;
  } else {
    process.exitCode = (await run(commandArgs, env)).exitCode;
  }
} catch {
  if (!controller.signal.aborted) process.stderr.write("Cannot start the requested network-configured command\n");
  process.exitCode = controller.signal.aborted ? 130 : 1;
} finally {
  process.removeListener("SIGINT", cancel);
  process.removeListener("SIGTERM", cancel);
}
