import { randomBytes } from "node:crypto";

import { RelayPaths } from "@browsermcp/protocol";

import { generateIdentity, pairingKey } from "@/daemon/identity";
import { RelayBackend, type RelayBackendOptions } from "@/relay/backend";
import { RELAY_HOST } from "@/relay/constants";
import { allowedExtensionIds } from "@/relay/extension-ids";
import { RelayServer } from "@/relay/server";

/**
 * A relay and `RelayBackend` on a random port, as the daemon runs them, without sessions or `daemon.json`. With `FakeExtension.connect({ port, chromium })` it's a `BrowserBackend` over real Chromium for engine and integration tests:
 *
 * ```ts
 * const relay = await startTestBackend();
 * const extension = await FakeExtension.connect({ port: relay.port, chromium });
 * const page = await relay.backend.page(await extension.openTab(url));
 * ```
 */
export async function startTestBackend(
  options: Partial<RelayBackendOptions> = {},
) {
  const token = randomBytes(16).toString("hex");
  const logs: string[] = [];
  const log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
    if (process.env.BROWSER_MCP_TEST_LOG) {
      console.error(...args);
    }
  };
  const backend = new RelayBackend({
    daemonVersion: "2.0.0",
    identity: pairingKey(generateIdentity()),
    log,
    ...options,
  });
  const shutdown = { requested: 0 };
  const server = await RelayServer.listen(0, {
    token,
    version: "2.0.0",
    extensionIds: allowedExtensionIds(),
    log,
    onExtension: (ws, port) => void backend.acceptExtension(ws, port),
    onCdp: (ws) => backend.acceptCdp(ws),
    onClient: (ws) => ws.close(),
    onShutdown: async () => void shutdown.requested++,
  });
  backend.setCdpUrl(
    `ws://${RELAY_HOST}:${server.port}${RelayPaths.cdp}?token=${token}`,
  );
  return {
    backend,
    server,
    port: server.port,
    token,
    logs,
    shutdown,
    async close() {
      await backend.close();
      await server.close();
    },
  };
}
