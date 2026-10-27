import { spawn } from "node:child_process";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import WebSocket from "ws";

import { RelayPaths, type RelayStatus } from "@browsermcp/protocol";

import {
  type Capability,
  CLIENT_PROTOCOL_VERSION,
  type ClientHello,
  type ClientToDaemonMethods,
  type DaemonInfo,
  type DaemonToClientMethods,
  type DaemonWelcome,
} from "@/contracts";
import { fetchStatus, readDaemonInfo } from "@/daemon/info";
import { daemonInfoPath, daemonStartingPath } from "@/daemon/paths";
import { RELAY_HOST } from "@/relay/constants";
import { extensionIdsFromEnv } from "@/relay/extension-ids";
import type { Logger } from "@/utils/log";
import { RpcPeer, type RpcHandlers, TOOL_CALL_TIMEOUT_MS } from "@/utils/rpc";
import { compareVersions } from "@/version";

export type DaemonClientOptions = {
  home: string;
  /** `--port`: the daemon on this port only */
  port?: number;
  /** This thin process's version: an older daemon is replaced */
  version: string;
  /** Starts the daemon: `[node, <package>/dist/daemon.js]`; `--port` is appended */
  daemonCommand: string[];
  client(): ClientHello["client"];
  capabilities: Capability[];
  files: RpcHandlers<DaemonToClientMethods>;
  log: Logger;
  startTimeoutMs?: number;
  /** How long `hello` waits for the daemon's `welcome` (10 s) */
  welcomeTimeoutMs?: number;
  /** How long `tools/call` waits for the daemon's answer: a little longer than the daemon lets a call run, so its message arrives first */
  toolCallTimeoutMs?: number;
};

/** `daemon.starting.json`: a thin process is starting (or replacing) the daemon with this version */
type DaemonStarting = { version: string; pid: number; at: number };

/** How long after a newer thin process said it's starting a daemon an older one waits for it, rather than starting its own */
const STARTING_GRACE_MS = 15_000;

type Peer = RpcPeer<ClientToDaemonMethods, DaemonToClientMethods>;

/**
 * The thin process's connection to the daemon, made on demand: finds the daemon from `daemon.json` and its status, starts one (detached) if none runs, replaces an older one, and reconnects (starting a new daemon if needed) after the daemon goes away. While a newer thin process replaces the daemon, older ones wait for the newer daemon rather than start an old one
 */
export class DaemonClient {
  private peer: Peer | null = null;
  private connecting: Promise<Peer> | null = null;

  constructor(private readonly options: DaemonClientOptions) {}

  async call<M extends keyof ClientToDaemonMethods & string>(
    method: M,
    params: ClientToDaemonMethods[M]["params"],
  ): Promise<ClientToDaemonMethods[M]["result"]> {
    const peer = await this.connect();
    return await peer.request(method, params, {
      timeoutMs:
        method === "tools/call"
          ? (this.options.toolCallTimeoutMs ?? TOOL_CALL_TIMEOUT_MS + 30_000)
          : undefined,
    });
  }

  close() {
    this.peer?.close();
    this.peer = null;
  }

  connect(): Promise<Peer> {
    if (this.peer?.open) {
      return Promise.resolve(this.peer);
    }
    this.connecting ??= this.findOrStart().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async findOrStart(): Promise<Peer> {
    const { log } = this.options;
    let lastError: unknown;
    for (let attempt = 0; attempt < 4; attempt++) {
      const found = await this.findDaemon();
      if (!found) {
        if (!(await this.waitForNewerDaemon())) {
          await this.startDaemon();
        }
        continue;
      }
      if (compareVersions(this.options.version, found.status.version) > 0) {
        log(
          `Replacing the Browser MCP daemon ${found.status.version} with ${this.options.version}`,
        );
        await this.replace(found.info);
        continue;
      }
      try {
        this.peer = await this.open(found.info);
        return this.peer;
      } catch (error) {
        lastError = error;
        log("Couldn't connect to the Browser MCP daemon:", error);
      }
    }
    throw new Error(
      `Couldn't start the Browser MCP daemon (see ${this.options.home}/daemon.log)${lastError ? `: ${String(lastError)}` : ""}`,
    );
  }

  private async findDaemon(): Promise<{
    info: DaemonInfo;
    status: RelayStatus;
  } | null> {
    const info = readDaemonInfo(
      daemonInfoPath(this.options.home, this.options.port),
    );
    if (!info) {
      return null;
    }
    const status = await fetchStatus(info.port);
    return status && status.pid === info.pid ? { info, status } : null;
  }

  /** When a newer thin process is starting its daemon (e.g. it just replaced ours), waits for that daemon instead of starting an older one that would race it. Resolves whether a daemon appeared */
  private async waitForNewerDaemon(): Promise<boolean> {
    const starting = this.readStarting();
    if (
      !starting ||
      compareVersions(starting.version, this.options.version) <= 0
    ) {
      return false;
    }
    const until = starting.at + STARTING_GRACE_MS;
    if (Date.now() >= until) {
      return false;
    }
    this.options.log(
      `A newer Browser MCP daemon (${starting.version}) is starting; waiting for it`,
    );
    while (Date.now() < until) {
      if (await this.findDaemon()) {
        return true;
      }
      await sleep(100);
    }
    return false;
  }

  /** Starts a daemon and waits until one (it, or another that won the port) answers */
  private async startDaemon() {
    const [command, ...args] = this.options.daemonCommand;
    if (this.options.port) {
      args.push("--port", String(this.options.port));
    }
    this.options.log("Starting the Browser MCP daemon");
    this.markStarting();
    const child = spawn(command!, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: { ...process.env, BROWSER_MCP_HOME: this.options.home },
    });
    child.unref();
    const deadline = Date.now() + (this.options.startTimeoutMs ?? 15_000);
    try {
      while (Date.now() < deadline) {
        if (await this.findDaemon()) {
          return;
        }
        await sleep(100);
      }
    } finally {
      this.unmarkStarting();
    }
    throw new Error(
      `The Browser MCP daemon didn't start (see ${this.options.home}/daemon.log)`,
    );
  }

  /** Asks an older daemon to exit once no calls are in flight, and waits until it's gone */
  private async replace(info: DaemonInfo) {
    await fetch(
      `http://${RELAY_HOST}:${info.port}${RelayPaths.shutdown}?token=${encodeURIComponent(info.token)}`,
      { method: "POST", signal: AbortSignal.timeout(70_000) },
    ).catch(() => {});
    // Older thin processes would otherwise start the old version again as soon as it's gone
    this.markStarting();
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const status = await fetchStatus(info.port, 300);
      if (!status || status.pid !== info.pid) {
        return;
      }
      await sleep(100);
    }
  }

  private get startingPath() {
    return daemonStartingPath(this.options.home, this.options.port);
  }

  private readStarting(): DaemonStarting | null {
    try {
      const starting = JSON.parse(
        readFileSync(this.startingPath, "utf8"),
      ) as DaemonStarting;
      return typeof starting.version === "string" &&
        typeof starting.at === "number"
        ? starting
        : null;
    } catch {
      return null;
    }
  }

  private markStarting() {
    const starting: DaemonStarting = {
      version: this.options.version,
      pid: process.pid,
      at: Date.now(),
    };
    try {
      const temp = `${this.startingPath}.${process.pid}.tmp`;
      writeFileSync(temp, JSON.stringify(starting), { mode: 0o600 });
      renameSync(temp, this.startingPath);
    } catch (error) {
      this.options.log("Couldn't write daemon.starting.json:", error);
    }
  }

  private unmarkStarting() {
    if (this.readStarting()?.pid === process.pid) {
      rmSync(this.startingPath, { force: true });
    }
  }

  private open(info: DaemonInfo): Promise<Peer> {
    const ws = new WebSocket(
      `ws://${RELAY_HOST}:${info.port}${RelayPaths.client}?token=${encodeURIComponent(info.token)}`,
      { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 },
    );
    return new Promise((resolve, reject) => {
      const fail = (error: Error) => {
        clearTimeout(timeout);
        ws.removeAllListeners();
        ws.on("error", () => {});
        ws.terminate();
        reject(error);
      };
      const timeout = setTimeout(
        () => fail(new Error("The daemon didn't answer hello")),
        this.options.welcomeTimeoutMs ?? 10_000,
      );
      ws.once("error", fail);
      ws.once("close", (code, reason) =>
        fail(new Error(`Closed: ${code} ${reason.toString()}`)),
      );
      ws.once("open", () => {
        const hello: ClientHello = {
          type: "hello",
          protocol: CLIENT_PROTOCOL_VERSION,
          version: this.options.version,
          client: this.options.client(),
          capabilities: this.options.capabilities,
          pid: process.pid,
          extensionIds: extensionIdsFromEnv(),
        };
        ws.send(JSON.stringify(hello));
      });
      ws.once("message", (data) => {
        let welcome: DaemonWelcome | undefined;
        try {
          welcome = JSON.parse(data.toString()) as DaemonWelcome;
        } catch {
          welcome = undefined;
        }
        if (welcome?.type !== "welcome") {
          fail(new Error("The daemon didn't answer hello"));
          return;
        }
        clearTimeout(timeout);
        ws.removeAllListeners();
        ws.on("close", () => {
          this.options.log("Disconnected from the Browser MCP daemon");
        });
        ws.on("error", () => {});
        this.options.log(
          `Connected to the Browser MCP daemon ${welcome.version} on port ${info.port}`,
        );
        resolve(new RpcPeer(ws, this.options.files));
      });
    });
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
