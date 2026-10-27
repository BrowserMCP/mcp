import { Command } from "commander";

import type { CreateCommandEngine } from "@/contracts";
import { DaemonAlreadyRunningError, startDaemon } from "@/daemon/daemon";
import { createFileLogger } from "@/daemon/log";
import { browserMcpHome, daemonLogPath, ensureHome } from "@/daemon/paths";

/**
 * The daemon process's entry: `node dist/daemon.js [--port <port>]`, started detached by a thin process. Logs to `~/.browsermcp/daemon.log` (and stderr with `--stderr`, for running it by hand)
 */
export async function runDaemon(options: {
  argv: string[];
  version: string;
  createEngine: CreateCommandEngine;
  idleExitMs?: number;
}) {
  const command = new Command()
    .name("browsermcp-daemon")
    .option("--port <port>", "listen on this port only", (value) =>
      Number.parseInt(value, 10),
    )
    .option("--stderr", "also log to stderr")
    .parse(options.argv);
  const { port, stderr } = command.opts<{ port?: number; stderr?: boolean }>();

  const home = browserMcpHome();
  ensureHome(home);
  const log = createFileLogger(daemonLogPath(home, port), { echo: stderr });
  process.on("uncaughtException", (error) => log("Uncaught exception:", error));
  process.on("unhandledRejection", (error) =>
    log("Unhandled rejection:", error),
  );

  try {
    const daemon = await startDaemon({
      home,
      port,
      version: options.version,
      createEngine: options.createEngine,
      idleExitMs: options.idleExitMs,
      log,
    });
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.on(signal, () => void daemon.stop(signal));
    }
    await daemon.stopped;
    process.exit(0);
  } catch (error) {
    if (error instanceof DaemonAlreadyRunningError) {
      log(error.message, "- exiting");
      process.exit(0);
    }
    log("The daemon couldn't start:", error);
    process.exit(1);
  }
}
