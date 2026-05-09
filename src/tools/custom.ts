import { zodToJsonSchema } from "zod-to-json-schema";

import { GetConsoleLogsTool, ScreenshotTool } from "@repo/types/mcp/tool";

import { Tool } from "./tool";

export const getConsoleLogs: Tool = {
  schema: {
    name: GetConsoleLogsTool.shape.name.value,
    description: GetConsoleLogsTool.shape.description.value,
    inputSchema: zodToJsonSchema(GetConsoleLogsTool.shape.arguments),
    annotations: { readOnlyHint: true },
  },
  handle: async (context, _params) => {
    const consoleLogs = await context.sendSocketMessage(
      "browser_get_console_logs",
      {},
    );
    const text: string = consoleLogs
      .map((log) => JSON.stringify(log))
      .join("\n");
    return {
      content: [{ type: "text", text }],
    };
  },
};

export const screenshot: Tool = {
  schema: {
    name: ScreenshotTool.shape.name.value,
    description: ScreenshotTool.shape.description.value,
    inputSchema: zodToJsonSchema(ScreenshotTool.shape.arguments),
    annotations: { readOnlyHint: true },
  },
  handle: async (context, _params) => {
    const screenshot = await context.sendSocketMessage(
      "browser_screenshot",
      {},
    );
    return {
      content: [
        {
          type: "image",
          data: screenshot,
          mimeType: "image/png",
        },
      ],
    };
  },
};
