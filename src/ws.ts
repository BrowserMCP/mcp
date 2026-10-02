import {
  createServer as createHttpServer,
  get as httpGet,
} from "node:http";

import { WebSocket, WebSocketServer, type RawData } from "ws";

import { mcpConfig } from "@repo/config/mcp.config";
import { wait } from "@repo/utils";

import { Context } from "@/context";

const relayPath = "/__browsermcp_relay_v1";
const relayHealthPath = "/__browsermcp_relay_health_v1";
const relayReadyType = "browsermcpRelayReady";
const messageResponseType = "messageResponse";

type BrowserTransportMode = "primary" | "relay";

export type BrowserTransport = {
  readonly mode: BrowserTransportMode;
  close(): Promise<void>;
};

function getRequestId(data: RawData): string | undefined {
  try {
    const message = JSON.parse(data.toString());
    if (typeof message.id === "string") {
      return message.id;
    }
    if (
      message.type === messageResponseType &&
      typeof message.payload?.requestId === "string"
    ) {
      return message.payload.requestId;
    }
  } catch {
    // Unknown extension messages remain local to the primary.
  }
  return undefined;
}

function sendNoConnectedTab(websocket: WebSocket, requestId?: string) {
  if (!requestId || websocket.readyState !== WebSocket.OPEN) {
    return;
  }
  websocket.send(
    JSON.stringify({
      type: messageResponseType,
      payload: {
        requestId,
        error: mcpConfig.errors.noConnectedTab,
      },
    }),
  );
}

function listenForBrowserConnections(
  context: Context,
  port: number,
): Promise<BrowserTransport> {
  return new Promise((resolve, reject) => {
    const relayPeers = new Set<WebSocket>();
    const relayedRequests = new Map<string, WebSocket>();
    const httpServer = createHttpServer((request, response) => {
      if (request.method === "GET" && request.url === relayHealthPath) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ name: "Browser MCP", relayVersion: 1 }));
        return;
      }
      response.writeHead(404);
      response.end();
    });
    const wss = new WebSocketServer({ server: httpServer });

    wss.on("error", (error) => {
      // WebSocketServer re-emits HTTP listen errors. The HTTP server handles
      // startup rejection; only report errors after it is listening.
      if (httpServer.listening) {
        console.error("Browser MCP WebSocket server error:", error);
      }
    });

    const handleStartupError = (error: NodeJS.ErrnoException) => reject(error);
    httpServer.once("error", handleStartupError);
    httpServer.listen(port, "127.0.0.1", () => {
      httpServer.removeListener("error", handleStartupError);
      httpServer.on("error", (error) => {
        console.error("Browser MCP HTTP server error:", error);
      });
      resolve({
        mode: "primary",
        close: async () => {
          for (const peer of relayPeers) {
            peer.close();
          }
          await new Promise<void>((closeResolve) =>
            wss.close(() => closeResolve()),
          );
          await new Promise<void>((closeResolve) =>
            httpServer.close(() => closeResolve()),
          );
        },
      });
    });

    wss.on("connection", (websocket, request) => {
      if (request.url === relayPath) {
        relayPeers.add(websocket);
        websocket.once("close", () => {
          relayPeers.delete(websocket);
          for (const [requestId, peer] of relayedRequests) {
            if (peer === websocket) {
              relayedRequests.delete(requestId);
            }
          }
        });
        websocket.on("message", (data, isBinary) => {
          const requestId = getRequestId(data);
          if (context.hasWs() && context.ws.readyState === WebSocket.OPEN) {
            if (requestId) {
              relayedRequests.set(requestId, websocket);
            }
            context.ws.send(data, { binary: isBinary });
            return;
          }
          sendNoConnectedTab(websocket, requestId);
        });
        websocket.send(JSON.stringify({ type: relayReadyType, version: 1 }));
        return;
      }

      if (context.hasWs()) {
        context.ws.close();
      }
      context.ws = websocket;
      websocket.on("message", (data, isBinary) => {
        const requestId = getRequestId(data);
        if (!requestId) {
          return;
        }
        const peer = relayedRequests.get(requestId);
        if (peer?.readyState === WebSocket.OPEN) {
          peer.send(data, { binary: isBinary });
        }
        relayedRequests.delete(requestId);
      });
      websocket.once("close", () => {
        for (const [requestId, peer] of relayedRequests) {
          sendNoConnectedTab(peer, requestId);
        }
        relayedRequests.clear();
      });
    });
  });
}

function probePrimary(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (result: boolean) => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };
    const request = httpGet(
      {
        host: "127.0.0.1",
        port,
        path: relayHealthPath,
        timeout: 500,
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
          if (body.length > 1024) {
            request.destroy();
            settle(false);
          }
        });
        response.on("end", () => {
          try {
            const health = JSON.parse(body);
            settle(
              response.statusCode === 200 &&
                health.name === "Browser MCP" &&
                health.relayVersion === 1,
            );
          } catch {
            settle(false);
          }
        });
      },
    );
    request.once("timeout", () => {
      request.destroy();
      settle(false);
    });
    request.once("error", () => settle(false));
  });
}

function connectToPrimary(
  context: Context,
  port: number,
  onUnexpectedClose: () => void,
): Promise<BrowserTransport> {
  return new Promise((resolve, reject) => {
    const websocket = new WebSocket(`ws://127.0.0.1:${port}${relayPath}`);
    let connected = false;
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const timeout = setTimeout(() => {
      websocket.close();
      fail(new Error(`Timed out connecting to Browser MCP on port ${port}`));
    }, 3000);

    websocket.once("error", fail);
    websocket.once("message", (data) => {
      try {
        const message = JSON.parse(data.toString());
        if (message.type !== relayReadyType || message.version !== 1) {
          throw new Error(
            `Port ${port} is occupied by an incompatible WebSocket server`,
          );
        }
        settled = true;
        connected = true;
        clearTimeout(timeout);
        websocket.removeListener("error", fail);
        websocket.on("error", (error) => {
          console.error("Browser MCP relay connection error:", error);
        });
        websocket.once("close", onUnexpectedClose);
        context.ws = websocket;
        resolve({
          mode: "relay",
          close: async () => websocket.close(),
        });
      } catch (error) {
        websocket.close();
        fail(error);
      }
    });
    websocket.once("close", () => {
      if (!connected) {
        fail(
          new Error(
            `Browser MCP on port ${port} closed during relay handshake`,
          ),
        );
      }
    });
  });
}

export async function createBrowserTransport(
  context: Context,
  port: number = mcpConfig.defaultWsPort,
): Promise<BrowserTransport> {
  let activeTransport: BrowserTransport | undefined;
  let closed = false;
  let electionPromise: Promise<void> | undefined;

  const scheduleElection = () => {
    if (closed || electionPromise) {
      return;
    }
    electionPromise = elect(false).finally(() => {
      electionPromise = undefined;
    });
  };

  const elect = async (initial: boolean) => {
    let attempts = 0;
    while (!closed) {
      if (!initial) {
        await wait(25 + Math.floor(Math.random() * 100));
      }
      try {
        activeTransport = await listenForBrowserConnections(context, port);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") {
          if (initial) {
            throw error;
          }
          attempts++;
          continue;
        }
      }

      if (!(await probePrimary(port))) {
        if (initial) {
          throw new Error(
            `Port ${port} is occupied by an incompatible server; Browser MCP left it untouched`,
          );
        }
        attempts++;
        if (attempts % 20 === 0) {
          console.error(
            `Still waiting to rejoin or replace the Browser MCP primary on port ${port}`,
          );
        }
        continue;
      }

      try {
        activeTransport = await connectToPrimary(
          context,
          port,
          scheduleElection,
        );
        return;
      } catch (error) {
        if (initial) {
          throw error;
        }
        attempts++;
      }
    }
  };

  await elect(true);
  if (!activeTransport) {
    throw new Error(`Unable to start or join Browser MCP on port ${port}`);
  }

  return {
    get mode() {
      return activeTransport!.mode;
    },
    close: async () => {
      closed = true;
      await activeTransport?.close();
      await electionPromise;
    },
  };
}
