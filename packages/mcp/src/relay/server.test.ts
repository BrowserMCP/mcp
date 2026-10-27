import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";

import {
  CHROME_WEB_STORE_EXTENSION_ID,
  RELAY_PRODUCT,
  RELAY_PROTOCOL_VERSION,
} from "@browsermcp/protocol";

import {
  isAllowedExtensionOrigin,
  isAllowedHost,
  RelayServer,
} from "@/relay/server";

const STORE_ORIGIN = `chrome-extension://${CHROME_WEB_STORE_EXTENSION_ID}`;

let server: RelayServer | undefined;
const opened: string[] = [];

async function start() {
  server = await RelayServer.listen(0, {
    token: "secret",
    version: "2.0.0",
    extensionIds: [CHROME_WEB_STORE_EXTENSION_ID],
    log: () => {},
    onExtension: (ws) => {
      opened.push("extension");
      ws.close();
    },
    onCdp: (ws) => {
      opened.push("cdp");
      ws.close();
    },
    onClient: (ws) => {
      opened.push("client");
      ws.close();
    },
    onShutdown: async () => void opened.push("shutdown"),
  });
  return server.port;
}

afterEach(async () => {
  await server?.close();
  server = undefined;
  opened.length = 0;
});

function request(
  port: number,
  options: { path: string; method?: string; headers?: Record<string, string> },
): Promise<{
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, ...options },
      (response) => {
        let body = "";
        response.on("data", (chunk) => (body += chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode!,
            headers: response.headers,
            body,
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** Resolves the HTTP status of a WebSocket upgrade: 101 when accepted */
function upgrade(
  port: number,
  path: string,
  headers: Record<string, string> = {},
): Promise<number> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers });
    ws.on("upgrade", () => resolve(101));
    ws.on("unexpected-response", (_request, response) =>
      resolve(response.statusCode!),
    );
    ws.on("error", () => {});
  });
}

describe("RelayServer", () => {
  it("serves the status with CORS for extension origins", async () => {
    const port = await start();
    const response = await request(port, {
      path: "/browsermcp/status",
      headers: { Origin: "chrome-extension://abc" },
    });
    expect(response.status).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBe(
      "chrome-extension://abc",
    );
    expect(JSON.parse(response.body)).toMatchObject({
      product: RELAY_PRODUCT,
      version: "2.0.0",
      protocol: RELAY_PROTOCOL_VERSION,
      pid: process.pid,
    });

    const fromPage = await request(port, {
      path: "/browsermcp/status",
      headers: { Origin: "https://example.com" },
    });
    expect(fromPage.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("rejects other Host headers (DNS rebinding)", async () => {
    const port = await start();
    const response = await request(port, {
      path: "/browsermcp/status",
      headers: { Host: `evil.example:${port}` },
    });
    expect(response.status).toBe(403);
    expect(
      await upgrade(port, "/extension", {
        Host: `evil.example:${port}`,
        Origin: STORE_ORIGIN,
      }),
    ).toBe(403);
  });

  it("accepts only allowed extension origins on /extension", async () => {
    const port = await start();
    expect(await upgrade(port, "/extension", { Origin: STORE_ORIGIN })).toBe(
      101,
    );
    expect(
      await upgrade(port, "/extension", {
        Origin: `chrome-extension://${"a".repeat(32)}`,
      }),
    ).toBe(403);
    expect(
      await upgrade(port, "/extension", { Origin: "https://example.com" }),
    ).toBe(403);
    expect(await upgrade(port, "/extension")).toBe(403);
    // 1.x extensions dial `/` on 9009; nothing answers there
    expect(await upgrade(port, "/", { Origin: STORE_ORIGIN })).toBe(404);
  });

  it("requires the token on /cdp, /client and /shutdown, and no browser origin", async () => {
    const port = await start();
    expect(await upgrade(port, "/cdp")).toBe(403);
    expect(await upgrade(port, "/cdp?token=wrong")).toBe(403);
    expect(await upgrade(port, "/cdp?token=secret")).toBe(101);
    expect(await upgrade(port, "/client?token=secret")).toBe(101);
    expect(
      await upgrade(port, "/client?token=secret", { Origin: STORE_ORIGIN }),
    ).toBe(403);
    expect(
      (await request(port, { path: "/shutdown?token=nope", method: "POST" }))
        .status,
    ).toBe(403);
    expect(
      (await request(port, { path: "/shutdown?token=secret", method: "POST" }))
        .status,
    ).toBe(200);
    expect(opened).toEqual(["cdp", "client", "shutdown"]);
  });

  it("fails to listen on a port another program holds", async () => {
    const holder = http.createServer();
    await new Promise<void>((resolve) =>
      holder.listen(0, "127.0.0.1", resolve),
    );
    const port = (holder.address() as { port: number }).port;
    await expect(
      RelayServer.listen(port, {
        token: "t",
        version: "2.0.0",
        extensionIds: [],
        log: () => {},
        onExtension: () => {},
        onCdp: () => {},
        onClient: () => {},
        onShutdown: async () => {},
      }),
    ).rejects.toMatchObject({ code: "EADDRINUSE" });
    holder.close();
  });
});

describe("isAllowedHost", () => {
  it("allows loopback names only", () => {
    expect(isAllowedHost("127.0.0.1:9010")).toBe(true);
    expect(isAllowedHost("localhost:9010")).toBe(true);
    expect(isAllowedHost("[::1]:9010")).toBe(true);
    expect(isAllowedHost("LOCALHOST")).toBe(true);
    expect(isAllowedHost("127.0.0.1.evil.example")).toBe(false);
    expect(isAllowedHost(undefined)).toBe(false);
  });
});

describe("isAllowedExtensionOrigin", () => {
  it("reads a set, which can grow", () => {
    const id = "a".repeat(32);
    const ids = new Set<string>();
    expect(isAllowedExtensionOrigin(`chrome-extension://${id}`, ids)).toBe(
      false,
    );
    ids.add(id);
    expect(isAllowedExtensionOrigin(`chrome-extension://${id}`, ids)).toBe(
      true,
    );
  });

  it("matches chrome-extension origins by ID", () => {
    const id = "b".repeat(32);
    expect(isAllowedExtensionOrigin(`chrome-extension://${id}`, [id])).toBe(
      true,
    );
    expect(isAllowedExtensionOrigin(`chrome-extension://${id}/`, [id])).toBe(
      false,
    );
    expect(isAllowedExtensionOrigin(`moz-extension://${id}`, [id])).toBe(false);
  });
});
