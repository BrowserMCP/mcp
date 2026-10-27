import { randomBytes, randomUUID } from "node:crypto";
import net from "node:net";
import WebSocket from "ws";

import { RELAY_PORTS, RelayPaths } from "@browsermcp/protocol";

import {
  CLIENT_PROTOCOL_VERSION,
  type ClientHello,
  type ClientToDaemonMethods,
  type CommandEngine,
  type CreateCommandEngine,
  type DaemonToClientMethods,
  type DaemonWelcome,
} from "@/contracts";
import { appFromClient } from "@/daemon/app-info";
import { loadIdentity } from "@/daemon/identity";
import {
  fetchStatus,
  readDaemonInfo,
  removeDaemonInfo,
  writeDaemonInfo,
} from "@/daemon/info";
import {
  daemonInfoPath,
  devExtensionIdsPath,
  ensureHome,
} from "@/daemon/paths";
import { RelayBackend } from "@/relay/backend";
import { RELAY_HOST } from "@/relay/constants";
import {
  allowedExtensionIds,
  extensionIdsFromEnv,
  readDevExtensionIds,
} from "@/relay/extension-ids";
import { RelayServer } from "@/relay/server";
import type { Logger } from "@/utils/log";
import {
  RpcPeer,
  seconds,
  TOOL_CALL_TIMEOUT_MS,
  withTimeout,
} from "@/utils/rpc";

export type DaemonOptions = {
  /** `~/.browsermcp` (or a test's temp directory) */
  home: string;
  /** `--port`: only this port */
  port?: number;
  /** The ports to try in order when there's no `port` (`RELAY_PORTS`; tests pass their own) */
  ports?: readonly number[];
  version: string;
  createEngine: CreateCommandEngine;
  log: Logger;
  /** Exits this long after the last session leaves (10 minutes) */
  idleExitMs?: number;
  extensionIds?: readonly string[];
  /** How long one `tools/call` may run (`TOOL_CALL_TIMEOUT_MS`) */
  toolCallTimeoutMs?: number;
};

/** Another daemon already holds the port: this one exits and the thin processes use that one */
export class DaemonAlreadyRunningError extends Error {
  constructor(readonly port: number) {
    super(`A Browser MCP daemon is already running on port ${port}`);
  }
}

export type Daemon = {
  port: number;
  backend: RelayBackend;
  engine: CommandEngine;
  /** Resolves with the reason once the daemon stopped */
  stopped: Promise<string>;
  stop(reason: string): Promise<void>;
};

const IDLE_EXIT_MS = 10 * 60 * 1000;
const SHUTDOWN_BUSY_WAIT_MS = 60_000;

/**
 * The daemon: binds the first free port of 9010–9012 (skipping ports other programs hold, never killing them), writes `daemon.json`, serves the relay, and runs one session per thin process over `/client`. Exits 10 minutes after the last session leaves, or when a newer thin process asks (`POST /shutdown`)
 */
export async function startDaemon(options: DaemonOptions): Promise<Daemon> {
  const { home, log } = options;
  ensureHome(home);
  const token = randomBytes(32).toString("base64url");
  const identity = loadIdentity(home);
  const sessions = new Map<string, WebSocket>();
  const extensionIds = new Set(options.extensionIds ?? allowedExtensionIds());
  // An ID that isn't allowed yet is looked up in the `dev-extension-ids` file, which dev tooling appends to, so a new dev build connects without a config edit (read only on a miss, so ordinary connections cost nothing)
  const allowedExtensions = {
    has(id: string) {
      if (extensionIds.has(id)) {
        return true;
      }
      if (!readDevExtensionIds(devExtensionIdsPath(home)).includes(id)) {
        return false;
      }
      extensionIds.add(id);
      log(`Allowing extension ${id} (dev-extension-ids file)`);
      return true;
    },
  };
  const backend = new RelayBackend({
    daemonVersion: options.version,
    identity,
    log,
    hasSessions: () => sessions.size > 0,
  });
  const engine = options.createEngine({ backend, log });
  let idleTimer: NodeJS.Timeout | undefined;
  let stopping: Promise<void> | null = null;
  let resolveStopped: (reason: string) => void = () => {};
  const stopped = new Promise<string>((resolve) => (resolveStopped = resolve));

  const startIdleTimer = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (sessions.size === 0) {
        void stop("idle");
      }
    }, options.idleExitMs ?? IDLE_EXIT_MS);
    idleTimer.unref?.();
  };

  const onClient = (ws: WebSocket) => {
    const timeout = setTimeout(() => ws.close(1008, "Expected hello"), 10_000);
    ws.once("close", () => clearTimeout(timeout));
    ws.once("message", (data) => {
      clearTimeout(timeout);
      let hello: ClientHello;
      try {
        hello = JSON.parse(data.toString());
      } catch {
        ws.close(1008, "Expected hello");
        return;
      }
      if (hello.type !== "hello" || typeof hello.protocol !== "number") {
        ws.close(1008, "Expected hello");
        return;
      }
      if (hello.protocol > CLIENT_PROTOCOL_VERSION) {
        ws.close(4001, "update-server");
        return;
      }
      // Only IDs of the right shape, from a client that holds the token (`extensionIdsFromEnv` filters them)
      const forwarded = extensionIdsFromEnv({
        BROWSER_MCP_EXTENSION_IDS: Array.isArray(hello.extensionIds)
          ? hello.extensionIds.filter((id) => typeof id === "string").join(",")
          : "",
      });
      for (const id of forwarded) {
        if (!extensionIds.has(id)) {
          extensionIds.add(id);
          log(
            `Allowing extension ${id} (BROWSER_MCP_EXTENSION_IDS of a session)`,
          );
        }
      }
      const sessionId = randomUUID();
      const welcome: DaemonWelcome = {
        type: "welcome",
        protocol: CLIENT_PROTOCOL_VERSION,
        version: options.version,
        sessionId,
      };
      ws.send(JSON.stringify(welcome));
      const peer = new RpcPeer<DaemonToClientMethods, ClientToDaemonMethods>(
        ws,
        {
          "tools/list": async () => ({ tools: engine.tools(sessionId) }),
          "tools/call": async ({ name, arguments: args }) =>
            await withTimeout(
              engine.callTool(sessionId, name, args),
              options.toolCallTimeoutMs ?? TOOL_CALL_TIMEOUT_MS,
              `The call didn't finish within ${seconds(options.toolCallTimeoutMs ?? TOOL_CALL_TIMEOUT_MS)}. The page or the browser may be stuck: try again with fewer steps, or ask the user to check the browser`,
            ),
        },
      );
      const app = appFromClient(hello.client);
      log(
        `Session ${sessionId} opened: ${app.name} (${hello.client.name} ${hello.client.version ?? ""}, thin ${hello.version}, pid ${hello.pid})`,
      );
      sessions.set(sessionId, ws);
      clearTimeout(idleTimer);
      engine.openSession({
        id: sessionId,
        app,
        capabilities: hello.capabilities ?? [],
        io: {
          async readFile(path) {
            const file = await peer.request("readFile", { path });
            return {
              name: file.name,
              mimeType: file.mimeType,
              buffer: Buffer.from(file.base64, "base64"),
            };
          },
          async writeFile(path, data) {
            const result = await peer.request("writeFile", {
              path,
              base64: data.toString("base64"),
            });
            return result.path;
          },
        },
      });
      ws.on("close", () => {
        sessions.delete(sessionId);
        log(`Session ${sessionId} closed`);
        engine
          .closeSession(sessionId)
          .catch((error) => log(`Closing session ${sessionId}:`, error));
        if (sessions.size === 0 && !stopping) {
          startIdleTimer();
        }
      });
    });
  };

  const infoFile = daemonInfoPath(home, options.port);
  const relay = await listenOnFirstFreePort(options, infoFile, {
    token,
    version: options.version,
    extensionIds: allowedExtensions,
    log,
    onRejectedExtension: (id) => backend.noteRejectedExtension(id),
    onExtension: (ws, port) => void backend.acceptExtension(ws, port),
    onCdp: (ws) => backend.acceptCdp(ws),
    onClient,
    onShutdown: async () => {
      const deadline = Date.now() + SHUTDOWN_BUSY_WAIT_MS;
      while (engine.busy() && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      // After the response is sent
      setTimeout(() => void stop("replaced by a newer version"), 50);
    },
  });
  const port = relay.port;
  backend.setCdpUrl(
    `ws://${RELAY_HOST}:${port}${RelayPaths.cdp}?token=${encodeURIComponent(token)}`,
  );
  writeDaemonInfo(infoFile, {
    port,
    pid: process.pid,
    version: options.version,
    token,
  });
  log(`Daemon ${options.version} listening on ${RELAY_HOST}:${port}`);
  startIdleTimer();

  async function stop(reason: string) {
    stopping ??= (async () => {
      log(`Stopping: ${reason}`);
      clearTimeout(idleTimer);
      removeDaemonInfo(infoFile);
      for (const ws of sessions.values()) {
        ws.close(4003, "The daemon is exiting");
      }
      await backend
        .close()
        .catch((error) => log("Closing the backend:", error));
      await relay.close();
      resolveStopped(reason);
    })();
    return stopping;
  }

  return { port, backend, engine, stopped, stop };
}

async function listenOnFirstFreePort(
  options: DaemonOptions,
  infoFile: string,
  serverOptions: Parameters<typeof RelayServer.listen>[1],
): Promise<RelayServer> {
  const ports = options.port ? [options.port] : (options.ports ?? RELAY_PORTS);
  for (const port of ports) {
    if (await isOurDaemon(port, infoFile)) {
      throw new DaemonAlreadyRunningError(port);
    }
    if (await isPortAnswering(port)) {
      options.log(`Port ${port} is held by another program; skipping it`);
      continue;
    }
    try {
      return await RelayServer.listen(port, serverOptions);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") {
        throw error;
      }
      // Lost a race to another daemon starting at the same moment (which writes daemon.json before it answers anything), or another program
      if (await isOurDaemon(port, infoFile)) {
        throw new DaemonAlreadyRunningError(port);
      }
      options.log(`Port ${port} is held by another program; skipping it`);
    }
  }
  throw new Error(
    `Ports ${ports.join(", ")} are held by other programs. Free one, or pass --port to the MCP server and set the same port in the extension`,
  );
}

/**
 * Whether one of our daemons serves the port: our `daemon.json` (for this port setting) names the port and the pid that `/browsermcp/status` reports, and the token in it opens `/client`. Any program can answer `/status` as `browsermcp`; one that isn't ours is skipped like any other program on the port
 */
async function isOurDaemon(port: number, infoFile: string): Promise<boolean> {
  const status = await fetchStatus(port, 500);
  if (!status) {
    return false;
  }
  const info = readDaemonInfo(infoFile);
  if (!info || info.port !== port || info.pid !== status.pid) {
    return false;
  }
  return await opensClient(port, info.token);
}

/** Whether `/client?token=` accepts the token (closing at once: without a hello, no session starts) */
function opensClient(port: number, token: string): Promise<boolean> {
  return new Promise((resolve) => {
    const ws = new WebSocket(
      `ws://${RELAY_HOST}:${port}${RelayPaths.client}?token=${encodeURIComponent(token)}`,
    );
    const done = (accepted: boolean) => {
      clearTimeout(timeout);
      ws.removeAllListeners();
      ws.on("error", () => {});
      ws.terminate();
      resolve(accepted);
    };
    const timeout = setTimeout(() => done(false), 1000);
    ws.once("open", () => done(true));
    ws.once("unexpected-response", () => done(false));
    ws.once("error", () => done(false));
  });
}

/** Whether something accepts connections on the port. Binding alone isn't enough: on macOS a socket on 0.0.0.0 doesn't stop us binding 127.0.0.1 */
function isPortAnswering(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: RELAY_HOST });
    const done = (answering: boolean) => {
      socket.destroy();
      resolve(answering);
    };
    socket.setTimeout(300, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}
