export const BUILTIN_RUNTIME_ID = "arsi-evaluator:builtin-runtime";
export const PACKAGE_RUNTIME_ID = "arsi-evaluator:package";

export function isEvaluatorRuntimeId(id: string): boolean {
  return id === BUILTIN_RUNTIME_ID || id === PACKAGE_RUNTIME_ID;
}
