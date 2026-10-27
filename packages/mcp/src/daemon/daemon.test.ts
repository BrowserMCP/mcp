import {
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";

import { RELAY_PORTS } from "@browsermcp/protocol";

import { CLIENT_PROTOCOL_VERSION, type ClientHello } from "@/contracts";
import {
  type Daemon,
  DaemonAlreadyRunningError,
  startDaemon,
} from "@/daemon/daemon";
import { generateIdentity, loadIdentity } from "@/daemon/identity";
import { fetchStatus, readDaemonInfo, writeDaemonInfo } from "@/daemon/info";
import {
  daemonInfoPath,
  devExtensionIdsPath,
  identityPath,
} from "@/daemon/paths";
import { createStubEngine } from "@/testing/stub-engine";

let home: string;
const daemons: Daemon[] = [];
const servers: net.Server[] = [];

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "browsermcp-home-"));
});

afterEach(async () => {
  for (const daemon of daemons.splice(0)) {
    await daemon.stop("test over");
  }
  for (const server of servers.splice(0)) {
    server.close();
  }
  rmSync(home, { recursive: true, force: true });
});

/** A free port, by binding port 0 and letting it go. Never one of 9009–9012 */
async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  if (port >= 9009 && port <= 9012) {
    return await freePort();
  }
  return port;
}

/** Another program holding a port */
async function holdPort(): Promise<number> {
  const server = net.createServer((socket) => socket.end());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return (server.address() as net.AddressInfo).port;
}

async function start(options: Partial<Parameters<typeof startDaemon>[0]> = {}) {
  const daemon = await startDaemon({
    home,
    version: "2.0.0",
    createEngine: createStubEngine,
    log: () => {},
    ...options,
  });
  daemons.push(daemon);
  return daemon;
}

function openSession(
  port: number,
  token: string,
  client = "claude-code",
  extensionIds?: string[],
) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/client?token=${token}`);
  return new Promise<WebSocket>((resolve, reject) => {
    ws.once("error", reject);
    ws.once("open", () => {
      const hello: ClientHello = {
        type: "hello",
        protocol: CLIENT_PROTOCOL_VERSION,
        version: "2.0.0",
        client: { name: client },
        capabilities: [],
        pid: process.pid,
        extensionIds,
      };
      ws.send(JSON.stringify(hello));
    });
    ws.once("message", () => resolve(ws));
  });
}

describe("startDaemon", () => {
  it("never uses 0.1.x's port 9009", () => {
    expect(RELAY_PORTS).not.toContain(9009);
  });

  it("writes daemon.json (0600, in a 0700 directory) and a lasting identity", async () => {
    const port = await freePort();
    const daemon = await start({ port });
    const info = readDaemonInfo(daemonInfoPath(home, port));
    expect(info).toMatchObject({ port, pid: process.pid, version: "2.0.0" });
    expect(info!.token.length).toBeGreaterThan(20);
    if (process.platform !== "win32") {
      expect(statSync(home).mode & 0o777).toBe(0o700);
      expect(statSync(daemonInfoPath(home, port)).mode & 0o777).toBe(0o600);
      expect(statSync(identityPath(home)).mode & 0o777).toBe(0o600);
    }
    expect(await fetchStatus(port)).toMatchObject({
      product: "browsermcp",
      version: "2.0.0",
    });
    const identity = statSync(identityPath(home)).mtimeMs;

    await daemon.stop("restart");
    daemons.length = 0;
    expect(readDaemonInfo(daemonInfoPath(home, port))).toBeNull();
    await start({ port });
    // The key survives restarts, so the extension's pairing does too
    expect(statSync(identityPath(home)).mtimeMs).toBe(identity);
  });

  it("skips ports other programs hold, without touching them", async () => {
    const held = await holdPort();
    const free = await freePort();
    const daemon = await start({ ports: [held, free] });
    expect(daemon.port).toBe(free);
    // The other program still answers
    await new Promise<void>((resolve, reject) => {
      const socket = net.connect(held, "127.0.0.1", () => {
        socket.destroy();
        resolve();
      });
      socket.once("error", reject);
    });
  });

  it("fails when every port is held", async () => {
    const held = await holdPort();
    await expect(start({ ports: [held] })).rejects.toThrow(
      /held by other programs/,
    );
  });

  it("gives way to a daemon already on the port", async () => {
    const port = await freePort();
    await start({ port });
    await expect(
      startDaemon({
        home,
        port,
        version: "2.0.0",
        createEngine: createStubEngine,
        log: () => {},
      }),
    ).rejects.toBeInstanceOf(DaemonAlreadyRunningError);
  });

  it("takes another home's daemon for another program", async () => {
    const port = await freePort();
    await start({ port });
    const otherHome = mkdtempSync(path.join(tmpdir(), "browsermcp-home-"));
    await expect(
      startDaemon({
        home: otherHome,
        port,
        version: "2.0.0",
        createEngine: createStubEngine,
        log: () => {},
      }),
    ).rejects.toThrow(/held by other programs/);
    rmSync(otherHome, { recursive: true, force: true });
  });

  it("skips a program that answers /status as Browser MCP but isn't the daemon in daemon.json", async () => {
    const impostor = http.createServer((request, response) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          product: "browsermcp",
          version: "2.0.0",
          protocol: 1,
          minProtocol: 1,
          pid: process.pid,
        }),
      );
    });
    await new Promise<void>((resolve) =>
      impostor.listen(0, "127.0.0.1", resolve),
    );
    servers.push(impostor as unknown as net.Server);
    const held = (impostor.address() as net.AddressInfo).port;
    const free = await freePort();
    // Even naming the impostor's port and pid, daemon.json's token must open /client
    writeDaemonInfo(daemonInfoPath(home), {
      port: held,
      pid: process.pid,
      version: "2.0.0",
      token: "stale",
    });
    const daemon = await start({ ports: [held, free] });
    expect(daemon.port).toBe(free);
    expect(readDaemonInfo(daemonInfoPath(home))?.port).toBe(free);
  });

  it("answers a tools/call that runs too long with an error", async () => {
    const port = await freePort();
    await start({ port, toolCallTimeoutMs: 200 });
    const { token } = readDaemonInfo(daemonInfoPath(home, port))!;
    const ws = await openSession(port, token);
    ws.send(
      JSON.stringify({
        id: 1,
        method: "tools/call",
        params: { name: "browser", arguments: { commands: "sleep 2000" } },
      }),
    );
    const response = await new Promise<{ error?: { message: string } }>(
      (resolve) =>
        ws.on("message", (data) => resolve(JSON.parse(data.toString()))),
    );
    expect(response.error?.message).toMatch(/didn't finish within/);
    ws.close();
  });

  it("opens a session per thin process and exits once idle", async () => {
    const port = await freePort();
    const daemon = await start({ port, idleExitMs: 300 });
    const { token } = readDaemonInfo(daemonInfoPath(home, port))!;
    const engine = daemon.engine as ReturnType<typeof createStubEngine> & {
      sessions: Map<string, { app: { id: string; name: string } }>;
    };
    const first = await openSession(port, token);
    const second = await openSession(port, token, "cursor-vscode");
    expect([...engine.sessions.values()].map((session) => session.app)).toEqual(
      [
        { id: "claude-code", name: "Claude Code" },
        { id: "cursor-vscode", name: "Cursor" },
      ],
    );
    // Not idle while sessions remain
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await fetchStatus(port)).not.toBeNull();

    first.close();
    second.close();
    expect(await daemon.stopped).toBe("idle");
    daemons.length = 0;
    expect(engine.sessions.size).toBe(0);
    expect(await fetchStatus(port)).toBeNull();
    expect(readDaemonInfo(daemonInfoPath(home, port))).toBeNull();
  });
});

describe("extension IDs from sessions", () => {
  const dev = "a".repeat(32);

  /** Whether `/extension` upgrades for an extension with this ID (a refused upgrade errors with 403) */
  function connectsAs(port: number, id: string): Promise<boolean> {
    return new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/extension`, {
        origin: `chrome-extension://${id}`,
      });
      ws.once("open", () => {
        ws.terminate();
        resolve(true);
      });
      ws.once("unexpected-response", () => resolve(false));
      ws.once("error", () => resolve(false));
    });
  }

  it("allows the IDs a session's hello carries, without a restart", async () => {
    const port = await freePort();
    await start({ port, extensionIds: [] });
    const { token } = readDaemonInfo(daemonInfoPath(home, port))!;
    expect(await connectsAs(port, dev)).toBe(false);

    const session = await openSession(port, token, "claude-code", [
      dev,
      "not-an-id",
    ]);
    expect(await connectsAs(port, dev)).toBe(true);
    expect(await connectsAs(port, "b".repeat(32))).toBe(false);
    session.close();
  });

  it("allows the IDs in the dev-extension-ids file as they connect, without a restart", async () => {
    const port = await freePort();
    await start({ port, extensionIds: [] });
    expect(await connectsAs(port, dev)).toBe(false);

    writeFileSync(
      devExtensionIdsPath(home),
      `# a worktree's build\n${dev}\nnot-an-id\n`,
    );
    expect(await connectsAs(port, dev)).toBe(true);
    expect(await connectsAs(port, "b".repeat(32))).toBe(false);
  });
});

describe("loadIdentity", () => {
  it("keeps the key, replaces an unreadable file, and leaves no temp files", () => {
    const first = loadIdentity(home);
    expect(loadIdentity(home).publicKey).toBe(first.publicKey);

    writeFileSync(identityPath(home), "{");
    const replaced = loadIdentity(home);
    expect(replaced.publicKey).not.toBe(first.publicKey);
    expect(loadIdentity(home).publicKey).toBe(replaced.publicKey);
    expect(readdirSync(home)).toEqual(["identity.json"]);
  });

  it("uses the key another daemon wrote first", () => {
    const winner = generateIdentity();
    writeFileSync(identityPath(home), JSON.stringify(winner));
    expect(loadIdentity(home).publicKey).toBe(winner.publicKey);
  });
});
