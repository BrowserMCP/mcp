import { timingSafeEqual } from "node:crypto";
import http from "node:http";
import type { Duplex } from "node:stream";
import { type WebSocket, WebSocketServer } from "ws";

import {
  RELAY_PRODUCT,
  RELAY_PROTOCOL_VERSION,
  RelayPaths,
  type RelayStatus,
} from "@browsermcp/protocol";

import { RELAY_HOST, RELAY_MIN_PROTOCOL_VERSION } from "@/relay/constants";
import type { Logger } from "@/utils/log";

const ALLOWED_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);

export type RelayServerOptions = {
  /** Required on `/cdp`, `/client` and `/shutdown` */
  token: string;
  version: string;
  /** Chrome extension IDs allowed on `/extension`; anything with `has` is asked on each connection, so the daemon can add to it */
  extensionIds: readonly string[] | { has(id: string): boolean };
  /** An extension was refused on `/extension`: its ID, or undefined for any other Origin */
  onRejectedExtension?(extensionId: string | undefined): void;
  log: Logger;
  /** `port`: the port the extension dialed (this server's), which the daemon signs with its challenge */
  onExtension(ws: WebSocket, port: number): void;
  onCdp(ws: WebSocket): void;
  onClient(ws: WebSocket): void;
  /** `POST /shutdown`: resolves once the daemon is ready to exit (no calls in flight); the response is sent then */
  onShutdown(): Promise<void>;
};

/**
 * The daemon's HTTP + WebSocket server: `GET /browsermcp/status`, `WS /extension`, `WS /cdp`, `WS /client` and `POST /shutdown`, on 127.0.0.1 only, rejecting other Host headers against DNS rebinding
 */
export class RelayServer {
  private readonly wss = new WebSocketServer({
    noServer: true,
    maxPayload: 256 * 1024 * 1024,
  });

  private constructor(
    private readonly server: http.Server,
    readonly port: number,
  ) {}

  /** Listens on `port`, rejecting with the listen error (e.g. `EADDRINUSE`) if it can't */
  static async listen(
    port: number,
    options: RelayServerOptions,
  ): Promise<RelayServer> {
    const server = http.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen({ port, host: RELAY_HOST, exclusive: true }, () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    const relay = new RelayServer(
      server,
      typeof address === "object" && address ? address.port : port,
    );
    relay.handle(options);
    return relay;
  }

  async close(): Promise<void> {
    for (const client of this.wss.clients) {
      client.terminate();
    }
    this.wss.close();
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private handle(options: RelayServerOptions) {
    const { log } = options;
    const hasToken = (url: URL) =>
      safeEqual(url.searchParams.get("token") ?? "", options.token);

    this.server.on("request", (request, response) => {
      if (!isAllowedHost(request.headers.host)) {
        response.writeHead(403).end();
        return;
      }
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const origin = request.headers.origin;
      if (origin?.startsWith("chrome-extension://")) {
        response.setHeader("Access-Control-Allow-Origin", origin);
        response.setHeader("Vary", "Origin");
      }
      if (request.method === "OPTIONS") {
        response.setHeader("Access-Control-Allow-Methods", "GET");
        response.writeHead(204).end();
        return;
      }
      if (request.method === "GET" && url.pathname === RelayPaths.status) {
        const status: RelayStatus = {
          product: RELAY_PRODUCT,
          version: options.version,
          protocol: RELAY_PROTOCOL_VERSION,
          minProtocol: RELAY_MIN_PROTOCOL_VERSION,
          pid: process.pid,
        };
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify(status));
        return;
      }
      if (request.method === "POST" && url.pathname === RelayPaths.shutdown) {
        if (!hasToken(url) || origin) {
          response.writeHead(403).end();
          return;
        }
        log("Shutdown requested");
        options.onShutdown().then(
          () => response.writeHead(200).end(),
          () => response.writeHead(500).end(),
        );
        return;
      }
      response.writeHead(404).end();
    });

    this.server.on("upgrade", (request, socket, head) => {
      const reject = (status: number) => rejectUpgrade(socket, status);
      if (!isAllowedHost(request.headers.host)) {
        reject(403);
        return;
      }
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const origin = request.headers.origin;
      const accept = (onConnection: (ws: WebSocket) => void) =>
        this.wss.handleUpgrade(request, socket, head, onConnection);

      switch (url.pathname) {
        case RelayPaths.extension: {
          if (!isAllowedExtensionOrigin(origin, options.extensionIds)) {
            log(
              `Rejected an extension connection from ${origin ?? "no origin"}`,
            );
            options.onRejectedExtension?.(
              origin?.match(/^chrome-extension:\/\/([a-p]{32})$/)?.[1],
            );
            reject(403);
            return;
          }
          accept((ws) => options.onExtension(ws, this.port));
          return;
        }
        case RelayPaths.cdp:
        case RelayPaths.client: {
          // Browsers always send an Origin; our own clients (Playwright, the thin processes) don't
          if (!hasToken(url) || origin) {
            reject(403);
            return;
          }
          accept(
            url.pathname === RelayPaths.cdp ? options.onCdp : options.onClient,
          );
          return;
        }
        default:
          reject(404);
      }
    });
  }
}

/** Against DNS rebinding: a page on `evil.example` rebound to 127.0.0.1 still sends its own Host */
export function isAllowedHost(host: string | undefined): boolean {
  if (!host) {
    return false;
  }
  const hostname = host.toLowerCase().replace(/:\d+$/, "");
  return ALLOWED_HOSTNAMES.has(hostname);
}

export function isAllowedExtensionOrigin(
  origin: string | undefined,
  extensionIds: readonly string[] | { has(id: string): boolean },
): boolean {
  const match = origin?.match(/^chrome-extension:\/\/([a-p]{32})$/);
  if (!match) {
    return false;
  }
  return Array.isArray(extensionIds)
    ? extensionIds.includes(match[1]!)
    : (extensionIds as { has(id: string): boolean }).has(match[1]!);
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function rejectUpgrade(socket: Duplex, status: number) {
  socket.end(
    `HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
}
