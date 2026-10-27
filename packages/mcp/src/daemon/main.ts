import { createCommandEngine } from "@/commands/engine";
import { runDaemon } from "@/daemon/run";
import { VERSION } from "@/version";

// Built to `dist/daemon.js`. The only importer of the command engine, so the rest of the daemon is tested with stub engines
void runDaemon({
  argv: process.argv,
  version: VERSION,
  createEngine: createCommandEngine,
});
