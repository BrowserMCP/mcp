import http from "node:http";
import { WebSocketServer } from "ws";

import { mcpConfig } from "@repo/config/mcp.config";
import { wait } from "@repo/utils";

import type { Context } from "@/context";
import { killListenerOnPort, waitPortFree } from "@/utils/port";

/**
 * The extension only ever connects to one fixed port, so only one MCP server
 * (i.e. one MCP client session) can drive the browser at a time.
 *
 * Previously every new server killed whatever was listening on that port,
 * which silently broke any other session using Browser MCP (and every
 * `claude mcp list`-style health check did the same). Instead, servers now
 * coordinate:
 *
 * - The owner serves the WebSocket plus two HTTP endpoints on the same port.
 * - A server that cannot bind stands by. When one of its tools is called, it
 *   asks the owner to hand over; the owner agrees only when it has no command
 *   in flight and has been idle for IDLE_HANDOFF_MS, so it is never
 *   interrupted mid-task. The extension reconnects to the new owner within ~1s.
 * - If the port is held by a process that does not answer at all (a stale
 *   server), only that listening process is killed.
 */

const STATUS_PATH = "/__browsermcp/status";
const HANDOFF_PATH = "/__browsermcp/handoff";

export const IDLE_HANDOFF_MS =
  Number(process.env.BROWSERMCP_IDLE_HANDOFF_MS) || 30_000;
/** How long a normal tool call waits for the browser before BROWSER_BUSY. */
export const FAST_WAIT_MS = Number(process.env.BROWSERMCP_FAST_WAIT_MS) || 5_000;
const EXTENSION_CONNECT_WAIT_MS = 4_000;

type OwnerInfo = { pid: number; busy: number; idleMs: number };

export class BrowserBusyError extends Error {
  constructor(info: OwnerInfo, etaMs: number) {
    const state = info.busy
      ? "is running a browser command right now"
      : `used the browser ${Math.round(info.idleMs / 1000)}s ago`;
    const eta = info.busy
      ? `after its current command finishes plus ${IDLE_HANDOFF_MS / 1000}s of inactivity`
      : `in about ${Math.max(1, Math.ceil(etaMs / 1000))}s`;
    super(
      [
        `BROWSER_BUSY (temporary lock, not a refusal): another session (pid ${info.pid}) ${state}.`,
        `Control is handed over automatically and safely once that session has been idle for ${IDLE_HANDOFF_MS / 1000}s - it is never interrupted mid-command. Expected availability: ${eta}.`,
        "Do not block the conversation, and do not stop just to ask the user about this lock. Prefer waiting in the background: start a background task or background subagent that calls browser_wait_for_access and then carries out the browser steps. If background tasks are not available, call this tool again later.",
        "While waiting, decide yourself, based on the user's instructions, what other work to do and in what order (for example non-browser parts of the task, or keeping the user informed).",
      ].join("\n"),
    );
    this.name = "BrowserBusyError";
  }
}

function httpRequest(
  port: number,
  method: string,
  path: string,
  timeoutMs = 1500,
): Promise<{ status: number; json?: any }> {
  return new Promise((resolve) => {
    const req = http.request(
      { host: "localhost", port, method, path, timeout: timeoutMs },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          let json: any;
          try {
            json = JSON.parse(body);
          } catch {}
          resolve({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.on("timeout", () => {
      req.destroy();
      resolve({ status: 0 });
    });
    req.on("error", () => resolve({ status: 0 }));
    req.end();
  });
}

export class PortOwner {
  /** Number of tool calls currently in flight in this server. */
  busy = 0;
  /** Timestamp of the last tool call start/end in this server. */
  lastActivity = 0;

  private httpServer: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private acquiring: Promise<void> | null = null;

  constructor(
    private context: Context,
    private port: number = mcpConfig.defaultWsPort,
  ) {}

  get isOwner() {
    return !!this.httpServer;
  }

  /** Bind the port if it is free. Returns false if it is in use. */
  async tryListen(): Promise<boolean> {
    const server = http.createServer((req, res) => this.onHttp(req, res));
    const ok = await new Promise<boolean>((resolve, reject) => {
      server.once("error", (e: NodeJS.ErrnoException) =>
        e.code === "EADDRINUSE" ? resolve(false) : reject(e),
      );
      server.listen(this.port, () => resolve(true));
    });
    if (!ok) {
      return false;
    }
    const wss = new WebSocketServer({ server });
    wss.on("connection", (websocket) => {
      // Close any existing connections
      if (this.context.hasWs()) {
        this.context.ws.close();
      }
      this.context.ws = websocket;
      websocket.on("close", () => this.context.clearWs(websocket));
    });
    this.httpServer = server;
    this.wss = wss;
    return true;
  }

  private onHttp(req: http.IncomingMessage, res: http.ServerResponse) {
    const idleMs = Date.now() - this.lastActivity;
    const send = (code: number, body: object) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.url === STATUS_PATH) {
      return send(200, { pid: process.pid, busy: this.busy, idleMs });
    }
    if (req.url === HANDOFF_PATH && req.method === "POST") {
      if (this.busy > 0 || idleMs < IDLE_HANDOFF_MS) {
        return send(409, {
          pid: process.pid,
          busy: this.busy,
          idleMs,
          retryAfterMs: Math.max(IDLE_HANDOFF_MS - idleMs, 500),
        });
      }
      send(200, { pid: process.pid, released: true });
      setImmediate(() => this.release());
      return;
    }
    // Same response a plain `ws` server gives to non-upgrade requests.
    res.writeHead(426);
    res.end();
  }

  /** Stop serving the port (the extension will reconnect to the next owner). */
  async release() {
    const server = this.httpServer;
    const wss = this.wss;
    if (!server || !wss) {
      return;
    }
    this.httpServer = null;
    this.wss = null;
    for (const client of wss.clients) {
      client.terminate();
    }
    this.context.clearWs();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /**
   * Make sure this server owns the port, waiting at most `maxWaitMs` for the
   * current owner to become idle. Throws BrowserBusyError otherwise.
   */
  async ensureOwner(maxWaitMs = FAST_WAIT_MS) {
    while (!this.isOwner) {
      if (this.acquiring) {
        await this.acquiring.catch(() => {});
        continue;
      }
      this.acquiring = this.acquire(maxWaitMs).finally(() => {
        this.acquiring = null;
      });
      await this.acquiring;
    }
  }

  private async waitForExtension() {
    const deadline = Date.now() + EXTENSION_CONNECT_WAIT_MS;
    while (!this.context.hasWs() && Date.now() < deadline) {
      await wait(100);
    }
  }

  private async acquire(maxWaitMs: number) {
    const deadline = Date.now() + maxWaitMs;
    let kills = 0;
    for (;;) {
      if (await this.tryListen()) {
        await this.waitForExtension();
        return;
      }

      const status = await httpRequest(this.port, "GET", STATUS_PATH);
      if (status.status === 200 && status.json) {
        const handoff = await httpRequest(this.port, "POST", HANDOFF_PATH);
        if (handoff.status === 200) {
          await waitPortFree(this.port, 3_000);
          continue;
        }
        const info: OwnerInfo = handoff.json ?? status.json;
        const etaMs = info.busy
          ? IDLE_HANDOFF_MS
          : (handoff.json?.retryAfterMs ?? 1_000);
        if (Date.now() + etaMs > deadline) {
          throw new BrowserBusyError(info, etaMs);
        }
        await wait(info.busy ? 1_000 : Math.min(etaMs, 2_000));
        continue;
      }

      if (status.status === 426) {
        throw new Error(
          `Browser MCP: port ${this.port} is owned by an older Browser MCP server (without hand-off support) started by another app or session. Close it and retry.`,
        );
      }

      // Something holds the port but does not answer: a stale process.
      if (++kills > 2) {
        throw new Error(
          `Browser MCP: port ${this.port} is held by an unresponsive process that could not be stopped.`,
        );
      }
      killListenerOnPort(this.port);
      await waitPortFree(this.port, 3_000);
    }
  }
}
