import { WebSocketServer } from "ws";

import { mcpConfig } from "@repo/config/mcp.config";
import { wait } from "@repo/utils";

import { isPortInUse, killProcessOnPort } from "@/utils/port";

export async function createWebSocketServer(
  port: number = mcpConfig.defaultWsPort,
  killExisting: boolean = true,
): Promise<WebSocketServer> {
  if (killExisting) {
    killProcessOnPort(port);
    // Wait until the port is free
    while (await isPortInUse(port)) {
      await wait(100);
    }
  } else if (await isPortInUse(port)) {
    throw new Error(
      `Port ${port} is already in use. Stop the existing Browser MCP server or omit --no-kill-existing to replace it.`,
    );
  }

  return new WebSocketServer({ port });
}
