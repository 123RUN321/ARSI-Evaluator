import type { LoadedConfig } from "../../config/loaded.js";
import { expectRecord, rejectUnknown } from "../../core/validation/input.js";
import { DEFINED_BENCHMARKS } from "../../plugins/benchmarks/agent-harness/definitions/index.js";
import { DROP_ARCHIVE_URL } from "../../plugins/benchmarks/agent-harness/definitions/drop.js";

const HOST_PROBES = ["huggingface", "github-api", "github-file", "npm", "python-index"] as const;
type HostProbe = typeof HOST_PROBES[number];
export type NetworkProbePlan = {
  host: readonly HostProbe[];
  datasetUrl?: string;
  docker: boolean;
  dockerBuild: boolean;
};

const npmSolvers = new Set(["claudecode", "codex", "codebuddy", "zcode"]);

/** Plan probes from resolved selections without materializing tasks or installing runtimes. */
export function networkProbePlan({ experiment }: LoadedConfig): NetworkProbePlan {
  const { benchmark, environment, solver, verifier } = experiment;
  const configuredSource = benchmark.config.source;
  const source = configuredSource && typeof configuredSource === "object" && !Array.isArray(configuredSource)
    ? configuredSource : undefined;
  const kind = source && "kind" in source ? source.kind : undefined;
  const localDataset = typeof benchmark.config.localPath === "string" || kind === "local";
  const host: HostProbe[] = [];
  let datasetUrl: string | undefined;
  if (!localDataset) {
    if (kind === "archive" && source && "url" in source && typeof source.url === "string") datasetUrl = source.url;
    else if (kind === "github" || (benchmark.name === "harbor" && kind === undefined)) host.push("github-api", "github-file");
    else if (benchmark.name === "drop") datasetUrl = DROP_ARCHIVE_URL;
    else if (benchmark.name === "agentx" || benchmark.name === "officeqa-pro-v2" ||
      DEFINED_BENCHMARKS.some(({ definition }) => definition.name === benchmark.name)) host.push("huggingface");
  }

  const docker = environment.name === "docker";
  const pythonVerifier = docker && verifier?.name === "harbor-python";
  const dockerBuild = pythonVerifier || (docker && benchmark.name === "officeqa-pro-v2");
  if ((docker && solver.name === "simpleagent") || npmSolvers.has(solver.name)) host.push("npm");
  if (pythonVerifier) host.push("python-index");
  return { host, ...(datasetUrl === undefined ? {} : { datasetUrl }), docker, dockerBuild };
}

/** The Ray worker receives only the probe choices, never experiment credentials. */
export function parseNetworkProbePlan(value: unknown): NetworkProbePlan {
  const plan = expectRecord(value, "network probe plan");
  rejectUnknown(plan, ["host", "datasetUrl", "docker", "dockerBuild"], "network probe plan");
  if (!Array.isArray(plan.host) || typeof plan.docker !== "boolean" || typeof plan.dockerBuild !== "boolean" ||
    (plan.dockerBuild && !plan.docker)) throw new TypeError("Invalid network probe plan");
  const host = plan.host.map(value => {
    const probe = HOST_PROBES.find(name => name === value);
    if (probe === undefined) throw new TypeError("Invalid host download probe");
    return probe;
  });
  let datasetUrl: string | undefined;
  if (plan.datasetUrl !== undefined) {
    if (typeof plan.datasetUrl !== "string") throw new TypeError("Invalid dataset probe URL");
    const url = new URL(plan.datasetUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
      throw new TypeError("Dataset probe requires an HTTP(S) URL without credentials");
    datasetUrl = plan.datasetUrl;
  }
  return { host, ...(datasetUrl === undefined ? {} : { datasetUrl }), docker: plan.docker, dockerBuild: plan.dockerBuild };
}
