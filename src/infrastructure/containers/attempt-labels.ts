import type { AttemptKey } from "../../core/contracts/result.js";

export const DOCKER_ATTEMPT_LABEL = {
  run: "arsi-evaluator.run",
  task: "arsi-evaluator.task",
  attempt: "arsi-evaluator.attempt",
  phase: "arsi-evaluator.phase",
} as const;

export function dockerLabelValue(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/gu, "_");
}

export function dockerAttemptLabels(key: AttemptKey, phase?: "solve" | "verify"): Record<string, string> {
  return {
    [DOCKER_ATTEMPT_LABEL.run]: dockerLabelValue(key.runId),
    [DOCKER_ATTEMPT_LABEL.task]: dockerLabelValue(key.taskId),
    [DOCKER_ATTEMPT_LABEL.attempt]: dockerLabelValue(key.attemptId),
    ...(phase === undefined ? {} : { [DOCKER_ATTEMPT_LABEL.phase]: phase }),
  };
}
