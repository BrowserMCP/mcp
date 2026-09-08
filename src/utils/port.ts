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

export function killProcessOnPort(port: number) {
  try {
    if (process.platform === "win32") {
      execSync(
        `FOR /F "tokens=5" %a in ('netstat -ano ^| findstr :${port}') do taskkill /F /PID %a 2>nul`,
        { stdio: "ignore" },
      );
    } else {
      execSync(`lsof -ti:${port} | xargs kill -9 2>/dev/null`, {
        stdio: "ignore",
      });
    }
  } catch {
    // Port might not be in use, ignore expected exit code
  }
}
