import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/** `~/.browsermcp`, or `BROWSER_MCP_HOME` (tests use a temp directory, so they never touch the user's daemon) */
export function browserMcpHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.BROWSER_MCP_HOME || path.join(homedir(), ".browsermcp");
}

/** Creates the directory (0700) if needed */
export function ensureHome(home: string) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    chmodSync(home, 0o700);
  }
}

/** `daemon.json`, or `daemon-<port>.json` for a daemon on a `--port` of its own, so it doesn't overwrite the default daemon's */
export function daemonInfoPath(home: string, port?: number): string {
  return path.join(home, port ? `daemon-${port}.json` : "daemon.json");
}

/** Written by a thin process that starts or replaces the daemon, with its version, so older thin processes wait for that daemon instead of starting an old one */
export function daemonStartingPath(home: string, port?: number): string {
  return path.join(
    home,
    port ? `daemon-${port}.starting.json` : "daemon.starting.json",
  );
}

export function daemonLogPath(home: string, port?: number): string {
  return path.join(home, port ? `daemon-${port}.log` : "daemon.log");
}

export function identityPath(home: string): string {
  return path.join(home, "identity.json");
}

/** `dev-extension-ids`: extension IDs of dev builds, one per line, which the daemon allows on `/extension` as they connect (a build tool can append its ID here instead of the AI app's MCP config being edited) */
export function devExtensionIdsPath(home: string): string {
  return path.join(home, "dev-extension-ids");
}
