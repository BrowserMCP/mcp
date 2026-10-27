import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, inject, it } from "vitest";
import { WebSocketServer } from "ws";

import { fetchStatus, readDaemonInfo, writeDaemonInfo } from "@/daemon/info";
import {
  daemonInfoPath,
  daemonLogPath,
  daemonStartingPath,
} from "@/daemon/paths";
import { DaemonClient } from "@/thin/daemon-client";
import { createFileAccess } from "@/thin/files";

// Starts real daemon processes (the stub daemon from `global-setup.ts`) on a random port, with a temp BROWSER_MCP_HOME
let home: string;
let port: number;
const clients: DaemonClient[] = [];
/** PIDs of the daemons these tests started, to stop them afterwards */
const pids = new Set<number>();

beforeEach(async () => {
  home = mkdtempSync(path.join(tmpdir(), "browsermcp-home-"));
  port = await freePort();
});

afterEach(async () => {
  for (const client of clients.splice(0)) {
    client.close();
  }
  const info = readDaemonInfo(daemonInfoPath(home, port));
  if (info) {
    pids.add(info.pid);
  }
  for (const pid of pids) {
    try {
      process.kill(pid);
    } catch {
      // Already gone
    }
  }
  pids.clear();
  // Daemons that lost the race to start may still be writing their log
  rmSync(home, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
});

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port >= 9009 && port <= 9012 ? await freePort() : port;
}

function client({
  version = "2.0.0",
  name = "claude-code",
  idleMs,
}: { version?: string; name?: string; idleMs?: number } = {}) {
  const daemonClient = new DaemonClient({
    home,
    port,
    version,
    daemonCommand: [
      process.execPath,
      inject("stubDaemon"),
      `--test-version=${version}`,
      ...(idleMs ? [`--test-idle-ms=${idleMs}`] : []),
    ],
    client: () => ({ name }),
    capabilities: ["cdp"],
    files: createFileAccess(async () => [home]),
    log: () => {},
  });
  clients.push(daemonClient);
  return daemonClient;
}

async function run(daemonClient: DaemonClient, commands: string) {
  const result = (await daemonClient.call("tools/call", {
    name: "browser",
    arguments: { commands },
  })) as CallToolResult;
  const text = (result.content[0] as { text: string }).text;
  if (result.isError) {
    throw new Error(text);
  }
  return text;
}

async function daemonPid(daemonClient: DaemonClient) {
  const pid = Number(await run(daemonClient, "pid"));
  pids.add(pid);
  return pid;
}

describe("DaemonClient", () => {
  it("starts the daemon on demand and forwards tools/list and tools/call", async () => {
    expect(readDaemonInfo(daemonInfoPath(home, port))).toBeNull();
    const thin = client();
    const { tools } = await thin.call("tools/list", {});
    expect(tools.map((tool) => tool.name)).toEqual(["browser"]);
    expect(await run(thin, "echo hello")).toBe("hello");
    expect(await run(thin, "app")).toBe("claude-code Claude Code");
    expect(await run(thin, "caps")).toBe("cdp");
    const pid = await daemonPid(thin);
    expect(pid).not.toBe(process.pid);
    expect(readDaemonInfo(daemonInfoPath(home, port))?.pid).toBe(pid);
  });

  it("shares one daemon when two thin processes start at once", async () => {
    const [first, second] = [client(), client({ name: "cursor-vscode" })];
    const [a, b] = await Promise.all([daemonPid(first), daemonPid(second)]);
    expect(a).toBe(b);
    expect(await run(second, "app")).toBe("cursor-vscode Cursor");
  });

  it("replaces an older daemon once its calls finish; an older thin process uses the newer daemon", async () => {
    const old = client({ version: "2.0.0" });
    const oldPid = await daemonPid(old);
    const slow = run(old, "sleep 800");

    const newer = client({ version: "2.1.0" });
    const newPid = await daemonPid(newer);
    expect(newPid).not.toBe(oldPid);
    // The call in flight finished before the old daemon exited
    expect(await slow).toBe("slept");
    expect((await fetchStatus(port))?.version).toBe("2.1.0");

    // The old thin process reconnects to the newer daemon rather than replacing it
    expect(await daemonPid(old)).toBe(newPid);
    expect((await fetchStatus(port))?.version).toBe("2.1.0");
  });

  it("starts a new daemon after the daemon exits while idle", async () => {
    const thin = client({ idleMs: 300 });
    const first = await daemonPid(thin);
    thin.close();
    const deadline = Date.now() + 5000;
    while ((await fetchStatus(port, 200)) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(await fetchStatus(port)).toBeNull();
    expect(readDaemonInfo(daemonInfoPath(home, port))).toBeNull();

    const second = await daemonPid(thin);
    expect(second).not.toBe(first);
  });

  it("starts a new daemon on the next call after the daemon is killed mid-session", async () => {
    const thin = client();
    const first = await daemonPid(thin);
    process.kill(first, "SIGKILL");
    // daemon.json still names the dead daemon; the status check finds it gone
    const deadline = Date.now() + 5000;
    while ((await fetchStatus(port, 200)) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const second = await daemonPid(thin);
    expect(second).not.toBe(first);
    expect(await run(thin, "echo back")).toBe("back");
  });

  it("waits for a newer daemon that another thin process is starting, rather than starting an older one", async () => {
    // A newer thin process just replaced the daemon and is starting its own
    writeFileSync(
      daemonStartingPath(home, port),
      JSON.stringify({ version: "2.1.0", pid: 1, at: Date.now() }),
    );
    const old = client({ version: "2.0.0" });
    const oldPid = daemonPid(old);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const newer = client({ version: "2.1.0" });
    const newPid = await daemonPid(newer);
    expect(await oldPid).toBe(newPid);
    expect((await fetchStatus(port))?.version).toBe("2.1.0");
    // No 2.0.0 daemon ever started
    const log = readFileSync(daemonLogPath(home, port), "utf8");
    expect(log).toContain("Daemon 2.1.0 listening");
    expect(log).not.toContain("Daemon 2.0.0");
  });

  it("gives up on a daemon that doesn't answer hello, and on calls it doesn't answer", async () => {
    // Answers /status as the daemon in daemon.json, and accepts /client, but `silent` never answers
    let silent = true;
    const server = http.createServer((_, response) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({ product: "browsermcp", version: "2.0.0", pid: 4242 }),
      );
    });
    const wss = new WebSocketServer({ server });
    wss.on("connection", (ws) =>
      ws.once("message", () => {
        if (!silent) {
          ws.send(
            JSON.stringify({ type: "welcome", protocol: 1, version: "2.0.0" }),
          );
        }
      }),
    );
    await new Promise<void>((resolve) =>
      server.listen(port, "127.0.0.1", resolve),
    );
    writeDaemonInfo(daemonInfoPath(home, port), {
      port,
      pid: 4242,
      version: "2.0.0",
      token: "t",
    });
    try {
      const thin = new DaemonClient({
        home,
        port,
        version: "2.0.0",
        daemonCommand: ["false"],
        client: () => ({ name: "claude-code" }),
        capabilities: [],
        files: createFileAccess(async () => [home]),
        log: () => {},
        welcomeTimeoutMs: 100,
        toolCallTimeoutMs: 200,
      });
      clients.push(thin);
      await expect(thin.call("tools/list", {})).rejects.toThrow(
        "didn't answer hello",
      );
      // Not stuck on the failed attempt
      await expect(thin.call("tools/list", {})).rejects.toThrow(
        "didn't answer hello",
      );

      silent = false;
      await expect(
        thin.call("tools/call", { name: "browser", arguments: {} }),
      ).rejects.toThrow("No answer to tools/call within 0 s");
    } finally {
      wss.close();
      server.closeAllConnections();
      server.close();
      rmSync(daemonInfoPath(home, port), { force: true });
    }
  });

  it("asks the thin process for files, within the MCP roots", async () => {
    const thin = client();
    expect(await run(thin, "write shot.txt hello")).toBe(
      path.join(home, "shot.txt"),
    );
    expect(await run(thin, "read shot.txt")).toBe("shot.txt text/plain hello");
    await expect(run(thin, "read /etc/hosts")).rejects.toThrow(
      /outside the AI app's MCP roots/,
    );
  });
});
