import { WebSocketServer } from "ws";

import { mcpConfig } from "@repo/config/mcp.config";
import { wait } from "@repo/utils";

import { isPortInUse, killProcessOnPort } from "@/utils/port";

export async function createWebSocketServer(
  port: number = mcpConfig.defaultWsPort,
): Promise<WebSocketServer> {
  // Only evict the previous owner when the port is actually occupied;
  // otherwise this is a noisy no-op (and on Windows a failing one).
  if (await isPortInUse(port)) {
    killProcessOnPort(port);
  }
  // Wait until the port is free
  while (await isPortInUse(port)) {
    await wait(100);
  }
  return new WebSocketServer({ port });
}
