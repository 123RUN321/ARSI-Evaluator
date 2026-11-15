import type { AttemptKey } from "../../core/contracts/result.js";
import { DOCKER_ATTEMPT_LABEL, dockerAttemptLabels } from "./attempt-labels.js";
import type { DockerCommand } from "./runtime-contract.js";

/** The three allocation labels jointly identify resources; never prune by name. */
export async function recoverDockerAttempts(
  command: DockerCommand,
  keys: AttemptKey[],
  signal: AbortSignal,
): Promise<void> {
  for (const key of keys) {
    signal.throwIfAborted();
    const expected = dockerAttemptLabels(key);
    const output = await command(
      [
        "ps",
        "--all",
        "--quiet",
        ...Object.entries(expected).flatMap(([name, value]) => ["--filter", `label=${name}=${value}`]),
      ],
      { signal },
    );
    const ids = output.stdout.trim().split(/\s+/u).filter(Boolean);
    for (const id of ids) {
      if (!/^[a-f0-9]{12,64}$/u.test(id)) throw new Error("Invalid Docker container identity during recovery");
      const inspected = JSON.parse((await command(["inspect", id], { signal })).stdout) as {
        Config?: { Labels?: Record<string, string> };
      }[];
      const actual = inspected[0]?.Config?.Labels;
      if (
        !actual ||
        Object.entries(expected).some(([name, value]) => actual[name] !== value) ||
        !["solve", "verify"].includes(actual[DOCKER_ATTEMPT_LABEL.phase] ?? "")
      )
        throw new Error("Docker recovery label identity changed");
      await command(["rm", "--force", id], { signal });
    }
  }
}
