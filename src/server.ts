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
import { BrowserBusyError, IDLE_HANDOFF_MS, PortOwner } from "@/ws";

type Options = {
  name: string;
  version: string;
  tools: Tool[];
  resources: Resource[];
};

const WAIT_FOR_ACCESS_DEFAULT_SECONDS = 600;

const waitForAccessSchema = {
  name: "browser_wait_for_access",
  description: `Block until this session gets control of the browser, then return. Use after another tool returned BROWSER_BUSY. The browser is handed over only after the other session has been idle for ${IDLE_HANDOFF_MS / 1000}s, so waiting never interrupts it. This call can block for minutes, so prefer running it in a background task or background subagent (which can then carry out the browser steps) instead of blocking the conversation.`,
  inputSchema: {
    type: "object" as const,
    properties: {
      timeoutSeconds: {
        type: "number",
        description: `Maximum seconds to wait (default ${WAIT_FOR_ACCESS_DEFAULT_SECONDS}).`,
      },
    },
  },
};

function errorResult(error: unknown) {
  return {
    content: [
      {
        type: "text",
        text: error instanceof BrowserBusyError ? error.message : String(error),
      },
    ],
    isError: true,
  };
}

export async function createServerWithTools(options: Options): Promise<Server> {
  const { name, version, tools, resources } = options;
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

  // Take the port only if it is free; otherwise stand by until a tool is
  // called (never kill another session's server).
  const owner = new PortOwner(context);
  await owner.tryListen();

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [...tools.map((tool) => tool.schema), waitForAccessSchema],
    };
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    return { resources: resources.map((resource) => resource.schema) };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name === waitForAccessSchema.name) {
      const timeoutSeconds =
        Number(request.params.arguments?.timeoutSeconds) ||
        WAIT_FOR_ACCESS_DEFAULT_SECONDS;
      const started = Date.now();
      try {
        await owner.ensureOwner(timeoutSeconds * 1000);
        owner.lastActivity = Date.now();
        return {
          content: [
            {
              type: "text",
              text: `Browser access granted after ${Math.round((Date.now() - started) / 1000)}s. You now control the browser; continue with your browser task (take a fresh browser_snapshot first).`,
            },
          ],
        };
      } catch (error) {
        return errorResult(error);
      }
    }

    const tool = tools.find((tool) => tool.schema.name === request.params.name);
    if (!tool) {
      return {
        content: [
          { type: "text", text: `Tool "${request.params.name}" not found` },
        ],
        isError: true,
      };
    }

    owner.busy++;
    owner.lastActivity = Date.now();
    try {
      await owner.ensureOwner();
      const result = await tool.handle(context, request.params.arguments);
      return result;
    } catch (error) {
      return errorResult(error);
    } finally {
      owner.busy--;
      owner.lastActivity = Date.now();
    }
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const resource = resources.find(
      (resource) => resource.schema.uri === request.params.uri,
    );
    if (!resource) {
      return { contents: [] };
    }

    const contents = await resource.read(context, request.params.uri);
    return { contents };
  });

  const originalClose = server.close.bind(server);
  server.close = async () => {
    await originalClose();
    await owner.release();
    await context.close();
  };

  return server;
}
