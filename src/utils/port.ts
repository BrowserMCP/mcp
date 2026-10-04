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
 * Kill only the process that is LISTENING on the port (never clients connected
 * to it, such as the browser, and never this process).
 */
export function killListenerOnPort(port: number) {
  try {
    if (process.platform === "win32") {
      const output = execSync("netstat -ano -p tcp", { encoding: "utf8" });
      const pids = new Set<string>();
      for (const line of output.split(/\r?\n/)) {
        const cols = line.trim().split(/\s+/);
        if (
          cols.length >= 5 &&
          cols[3] === "LISTENING" &&
          cols[1].endsWith(`:${port}`)
        ) {
          pids.add(cols[4]);
        }
      }
      for (const pid of pids) {
        if (Number(pid) !== process.pid) {
          execSync(`taskkill /F /PID ${pid}`, { stdio: "ignore" });
        }
      }
    } else {
      execSync(`lsof -ti tcp:${port} -sTCP:LISTEN | xargs kill -9`, {
        stdio: "ignore",
      });
    }
  } catch {
    // Nothing to kill, or the process already exited.
  }
}

export async function waitPortFree(port: number, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (await isPortInUse(port)) {
    if (Date.now() > deadline) {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return true;
}
