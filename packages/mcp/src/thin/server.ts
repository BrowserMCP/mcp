import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { fileURLToPath } from "node:url";

import { INSTRUCTIONS } from "@/commands/instructions";
import type { Capability } from "@/contracts";
import { browserMcpHome } from "@/daemon/paths";
import { DaemonClient } from "@/thin/daemon-client";
import { createFileAccess } from "@/thin/files";
import { debugLog, type Logger } from "@/utils/log";
import { errorMessage } from "@/utils/rpc";
import { VERSION } from "@/version";

export type ThinOptions = {
  capabilities: Capability[];
  port?: number;
  home?: string;
  version?: string;
  /** Starts the daemon. Default: this package's `dist/daemon.js` with the current Node */
  daemonCommand?: string[];
  log?: Logger;
};

/**
 * Creates the thin process's MCP server: one per AI app, over stdio. It forwards `tools/list` and `tools/call` to the daemon (started on demand) and answers the daemon's file requests
 */
export function createThinServer(options: ThinOptions) {
  const log = options.log ?? debugLog;
  const server = new Server(
    { name: "Browser MCP", version: options.version ?? VERSION },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  );

  /** The AI app's MCP roots, or the working directory when it has none, which relative file paths resolve against */
  const roots = async (): Promise<string[]> => {
    if (server.getClientCapabilities()?.roots) {
      try {
        const { roots } = await server.listRoots(undefined, { timeout: 5000 });
        const paths = roots
          .filter((root) => root.uri.startsWith("file://"))
          .map((root) => fileURLToPath(root.uri));
        if (paths.length > 0) {
          return paths;
        }
      } catch (error) {
        log("Couldn't list the MCP roots:", errorMessage(error));
      }
    }
    return [process.cwd()];
  };

  const daemon = new DaemonClient({
    home: options.home ?? browserMcpHome(),
    port: options.port,
    version: options.version ?? VERSION,
    daemonCommand: options.daemonCommand ?? [
      process.execPath,
      fileURLToPath(new URL("./daemon.js", import.meta.url)),
    ],
    client: () => {
      const client = server.getClientVersion();
      return {
        name: client?.name ?? "MCP client",
        title: client?.title,
        version: client?.version,
      };
    },
    capabilities: options.capabilities,
    files: createFileAccess(roots),
    log,
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return await daemon.call("tools/list", {});
  });

  server.setRequestHandler(
    CallToolRequestSchema,
    async (request): Promise<CallToolResult> => {
      try {
        return await daemon.call("tools/call", {
          name: request.params.name,
          arguments: request.params.arguments,
        });
      } catch (error) {
        const message = errorMessage(error);
        return {
          content: [
            {
              type: "text",
              text:
                message === "Connection closed"
                  ? "The Browser MCP daemon stopped while handling this call. Run it again: a new daemon starts, and the browser reconnects within seconds"
                  : message,
            },
          ],
          isError: true,
        };
      }
    },
  );

  return { server, daemon };
}

/** The `bin` entry: serves MCP over stdio until the AI app closes stdin */
export async function runThin(options: ThinOptions) {
  const { server, daemon } = createThinServer(options);
  process.stdin.on("close", () => {
    daemon.close();
    void server.close().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
  await server.connect(new StdioServerTransport());
}
