#!/usr/bin/env node
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { program } from "commander";

import { appConfig } from "@repo/config/app.config";

import type { Resource } from "@/resources/resource";
import { createServerWithTools } from "@/server";
import * as common from "@/tools/common";
import * as custom from "@/tools/custom";
import * as snapshot from "@/tools/snapshot";
import type { Tool } from "@/tools/tool";

import packageJSON from "../package.json";

function setupExitWatchdog(server: Server) {
  process.stdin.on("close", async () => {
    setTimeout(() => process.exit(0), 15000);
    await server.close();
    process.exit(0);
  });
}

const commonTools: Tool[] = [common.pressKey, common.wait];

const customTools: Tool[] = [custom.getConsoleLogs, custom.screenshot];

const snapshotTools: Tool[] = [
  common.navigate(true),
  common.goBack(true),
  common.goForward(true),
  snapshot.snapshot,
  snapshot.click,
  snapshot.hover,
  snapshot.type,
  snapshot.selectOption,
  ...commonTools,
  ...customTools,
];

const resources: Resource[] = [];

let authToken: string | undefined = process.env.BROWSER_MCP_AUTH_TOKEN;

program
  .option('-t, --token <token>', 'Authentication token (up to 64 characters)')
  .version("Version " + packageJSON.version)
  .name(packageJSON.name)
  .action(async (options) => {
    if (options.token) {
      if (options.token.length > 64) {
        console.error('Token must be 64 characters or less.');
        process.exit(1);
      }
      authToken = options.token;
    }
    if (!authToken) {
      console.error('Authentication token required. Set via --token or BROWSER_MCP_AUTH_TOKEN.');
      process.exit(1);
    }
    const server = await createServer(authToken);
    setupExitWatchdog(server);

    const transport = new StdioServerTransport();
    await server.connect(transport);
  });
program.parse(process.argv);

async function createServer(authToken: string): Promise<Server> {
  return createServerWithTools({
    name: appConfig.name,
    version: packageJSON.version,
    tools: snapshotTools,
    resources,
    authToken,
  });
}
