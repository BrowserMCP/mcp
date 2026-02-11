import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import { GetConsoleLogsTool, ScreenshotTool } from "@repo/types/mcp/tool";

import { Tool } from "./tool";

const ScreenshotToolArgs = ScreenshotTool.shape.arguments.extend({
  fullPage: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "Whether to capture the full scrollable page instead of just the visible viewport",
    ),
});

export const getConsoleLogs: Tool = {
  schema: {
    name: GetConsoleLogsTool.shape.name.value,
    description: GetConsoleLogsTool.shape.description.value,
    inputSchema: zodToJsonSchema(GetConsoleLogsTool.shape.arguments),
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
    inputSchema: zodToJsonSchema(ScreenshotToolArgs),
  },
  handle: async (context, params) => {
    const { fullPage } = ScreenshotToolArgs.parse(params);
    const screenshot = await context.sendSocketMessage(
      "browser_screenshot",
      { fullPage } as any,
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
