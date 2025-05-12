import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { Context } from "@/context";
import type { Resource } from "@/resources/resource";
import type { Tool } from "@/tools/tool";
import { createWebSocketServer } from "@/ws";

type Options = {
  name: string;
  version: string;
  tools: Tool[];
  resources: Resource[];
  authToken: string;
};

export async function createServerWithTools(options: Options): Promise<Server> {
  const { name, version, tools, resources, authToken } = options;
  const context = new Context();
  const server = new Server(
    { name, version },
    {
      capabilities: {
        tools: {},
        resources: {},
      },
    },
  );

  const wss = await createWebSocketServer();
  wss.on("connection", (websocket) => {
    let authenticated = false;
    const authTimeout = setTimeout(() => {
      if (!authenticated) {
        websocket.close(4001, "Authentication required");
      }
    }, 5000);
    websocket.once("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (typeof msg.token === "string" && msg.token === authToken) {
          authenticated = true;
          clearTimeout(authTimeout);
          // Close any existing connections
          if (context.hasWs()) {
            context.ws.close();
          }
          context.ws = websocket;
          context.setAuthenticated(true);
        } else {
          websocket.close(4002, "Invalid authentication token");
        }
      } catch {
        websocket.close(4003, "Malformed authentication message");
      }
    });
    websocket.on("close", () => {
      context.setAuthenticated(false);
    });
  });

  function ensureAuthenticated() {
    if (!context.isAuthenticated()) {
      return {
        content: [{ type: "text", text: "Not authenticated. Please connect with a valid token." }],
        isError: true,
      };
    }
    return null;
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const err = ensureAuthenticated();
    if (err) return err;
    return { tools: tools.map((tool) => tool.schema) };
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const err = ensureAuthenticated();
    if (err) return err;
    return { resources: resources.map((resource) => resource.schema) };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const err = ensureAuthenticated();
    if (err) return err;
    const tool = tools.find((tool) => tool.schema.name === request.params.name);
    if (!tool) {
      return {
        content: [
          { type: "text", text: `Tool "${request.params.name}" not found` },
        ],
        isError: true,
      };
    }

    try {
      const result = await tool.handle(context, request.params.arguments);
      return result;
    } catch (error) {
      return {
        content: [{ type: "text", text: String(error) }],
        isError: true,
      };
    }
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const err = ensureAuthenticated();
    if (err) return err;
    const resource = resources.find(
      (resource) => resource.schema.uri === request.params.uri,
    );
    if (!resource) {
      return { contents: [] };
    }

    const contents = await resource.read(context, request.params.uri);
    return { contents };
  });

  server.close = async () => {
    await server.close();
    await wss.close();
    await context.close();
  };

  return server;
}
