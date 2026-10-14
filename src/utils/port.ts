import { execSync } from "node:child_process";
import net from "node:net";

export async function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(true)); // Port is still in use
    server.once("listening", () => {
      server.close(() => resolve(false)); // Port is free
    });
    server.listen(port);
  });
}

/**
 * Collect the unique PIDs bound to `port` on Windows by parsing
 * `netstat -ano` in-process.
 *
 * The local-address column is matched exactly (`...:${port}` at end of
 * field) so e.g. port 9009 does not match 90090 or 19009. PIDs are
 * deduped because IPv4 and IPv6 rows for the same listener share one PID,
 * and killing the same PID twice fails with "process not found".
 */
function getPidsOnPortWindows(port: number): string[] {
  let output: string;
  try {
    output = execSync("netstat -ano", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return []; // netstat itself failed; nothing sensible to do
  }
  const pids = new Set<string>();
  for (const line of output.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) continue;
    if (!parts[1].endsWith(`:${port}`)) continue;
    const pid = parts[parts.length - 1];
    if (/^\d+$/.test(pid)) pids.add(pid);
  }
  return [...pids];
}

export function killProcessOnPort(port: number) {
  try {
    if (process.platform === "win32") {
      for (const pid of getPidsOnPortWindows(port)) {
        try {
          execSync(`taskkill /F /PID ${pid}`, { stdio: "ignore" });
        } catch {
          // Already exited (e.g. a PID shared by several rows) — ignore.
        }
      }
    } else {
      execSync(`lsof -ti:${port} | xargs kill -9`, { stdio: "ignore" });
    }
  } catch {
    // Port already free — nothing to do. Stays silent so MCP hosts that
    // treat stderr output as startup failure are not confused.
  }
}
