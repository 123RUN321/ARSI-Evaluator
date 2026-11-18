import type { ProcessEnv } from "node:process";

type PackageCommandResult = { exitCode: number; stderr: string; stdout: string };
export function npmRegistrySources(env: ProcessEnv): [] | [string, ...string[]];
export function publicNpmMirror(env: ProcessEnv): string | undefined;
export function npmDependencyInstall(args: readonly string[]): boolean;
export function withNpmRegistryFallback<T extends PackageCommandResult>(env: ProcessEnv,
  run: (environment: ProcessEnv) => Promise<T>, signal: AbortSignal | undefined, log: (message: string) => void): Promise<T>;
