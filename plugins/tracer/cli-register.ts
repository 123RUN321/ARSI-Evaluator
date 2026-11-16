import type { PluginCliRegistrar } from "arsi-evaluator";

export function registerCli(cli: PluginCliRegistrar): void {
  cli.addCommand({
    name: "tracer",
    description: "Manage the tracer Collector (serve, stop, status, logs)",
    async run(argv, io, signal) {
      const { runPluginCli } = await import("./cli.js");
      return runPluginCli(argv, io, signal);
    },
  });
}
