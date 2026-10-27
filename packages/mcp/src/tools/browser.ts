/**
 * The one MCP tool, `browser`. Every turn pays for its definition again, so the description lists the everyday commands with short syntax and only names the rest, whose syntax `help` prints (`eval/RESULTS.md` measured what the definition costs)
 */
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

import type { Capability } from "@/contracts";

/** Listed with their syntax */
const EVERYDAY = [
  "goto <url> | back | forward | reload",
  "click <target>",
  'fill <target> "<text>" [--submit]',
  'type "<text>"',
  "press <key>",
  'select <target> "<value>"',
  "check <target> | uncheck <target>",
  'wait <ms> | wait --text "<text>" | wait <target>',
  "tab list | tab new [<url>] | tab select <id> | tab close",
  "snapshot [<target>] [-i] [--depth N]",
  'find "<text>"',
  "get text|value|count|url|title [<target>]",
  "screenshot [<target>]",
  'eval "<js function>"   # runs in the page',
];

/** Named only; `help <command>` prints their syntax */
export const MORE_COMMANDS = [
  "scroll",
  "hover",
  "drag",
  "upload",
  "dialog",
  "console",
  "requests",
  "request",
];

/** Named only, and only for sessions with the capability */
const CAPABILITY_COMMANDS: Record<Capability, string> = { cdp: "cdp" };

export function browserDescription(
  capabilities: readonly Capability[] = [],
): string {
  const more = [
    ...MORE_COMMANDS,
    ...capabilities.map((capability) => CAPABILITY_COMMANDS[capability]),
  ];
  return [
    "Controls the user's Chrome. Runs one command per line, stopping at the first error. Actions print one ✓ line, reads print their output. Do many steps per call.",
    ...EVERYDAY,
    `More (help <command>): ${more.join(", ")}`,
    "Targets: e12 (a snapshot ref), getByRole('button', { name: 'Go' }), getByLabel/getByText/getByPlaceholder('…'), or CSS.",
    'Quote text with spaces: "like this".',
  ].join("\n");
}

export function browserTool(capabilities: readonly Capability[] = []): Tool {
  return {
    name: "browser",
    description: browserDescription(capabilities),
    inputSchema: {
      type: "object",
      properties: {
        commands: {
          type: "string",
          description: "Command lines, one per line",
        },
      },
      required: ["commands"],
    },
    annotations: {
      title: "Browser",
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    },
  };
}
