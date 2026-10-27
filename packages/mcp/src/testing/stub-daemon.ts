import { runDaemon } from "@/daemon/run";
import { createStubEngine } from "@/testing/stub-engine";

// The daemon with the stub engine, built by `global-setup.ts` for the daemon tests. `--test-version=<v>` and `--test-idle-ms=<ms>` stand in for the package version and the 10-minute idle exit
const testArg = (name: string) =>
  process.argv.find((arg) => arg.startsWith(`--${name}=`))?.split("=")[1];

void runDaemon({
  argv: process.argv.filter((arg) => !arg.startsWith("--test-")),
  version: testArg("test-version") ?? "2.0.0",
  createEngine: createStubEngine,
  idleExitMs: Number(testArg("test-idle-ms")) || undefined,
});
