/**
 * The tool sets the eval compares, each driving the same launched Chromium:
 * - `cli-string` / `cli-array`: the `browser` tool, with `commands` as one string or an array of lines;
 * - `typed`: per-action tools like 0.1.x, each action returning a full snapshot;
 * - `playwright`: one `execute` tool running Playwright code in Node, like Playwriter.
 */
import type Anthropic from "@anthropic-ai/sdk";
import type { Page } from "playwright-core";

import type { Harness } from "@/commands/testing/harness";
import { browserTool } from "@/tools/browser";

export type ToolRun = (
  name: string,
  input: Record<string, unknown>,
) => Promise<string>;

export type Config = {
  name: string;
  system: string;
  tools: Anthropic.Tool[];
  /** Starts a run: a fresh session or tab */
  start(h: Harness): Promise<{ run: ToolRun; stop: () => Promise<void> }>;
};

const BASE_SYSTEM =
  "You control a web browser with tools to do the user's task. When you're done, reply with the answer only.";

function cliTool(shape: "string" | "array"): Anthropic.Tool {
  const tool = browserTool();
  const schema = tool.inputSchema as Anthropic.Tool.InputSchema;
  if (shape === "array") {
    schema.properties = {
      commands: {
        type: "array",
        items: { type: "string" },
        description:
          'Command lines, one per item, e.g. ["goto https://example.com", "fill getByLabel(\'Email\') \\"a@b.c\\"", "snapshot -i"]',
      },
    };
  }
  return {
    name: tool.name,
    description: tool.description,
    input_schema: schema,
  };
}

function cli(shape: "string" | "array"): Config {
  return {
    name: `cli-${shape}`,
    system: BASE_SYSTEM,
    tools: [cliTool(shape)],
    async start(h) {
      const session = h.openSession(`eval-${shape}`);
      return {
        run: async (_name, input) =>
          (await h.call(session, input.commands as string)).text,
        stop: () => h.engine.closeSession(session),
      };
    },
  };
}

async function freshPage(h: Harness): Promise<{ page: Page; tabId: number }> {
  const tabId = await h.backend.createTab({
    app: { id: "eval", name: "eval" },
  });
  return { page: await h.backend.page(tabId), tabId };
}

/** The 0.1.x shape: every action answers with the URL, title and a full AI snapshot */
async function fullSnapshot(page: Page, status: string) {
  await page.waitForLoadState("load").catch(() => {});
  const snapshot = await page
    .ariaSnapshot({ mode: "ai" })
    .catch((e: Error) => `(${e.message})`);
  return `${status}\n\n- Page URL: ${page.url()}\n- Page Title: ${await page.title()}\n- Page Snapshot\n\`\`\`yaml\n${snapshot}\n\`\`\`\n`;
}

const element = {
  element: {
    type: "string",
    description:
      "Human-readable element description used to obtain permission to interact with the element",
  },
  ref: {
    type: "string",
    description: "Exact target element reference from the page snapshot",
  },
};

const TYPED_TOOLS: Anthropic.Tool[] = [
  {
    name: "browser_navigate",
    description: "Navigate to a URL",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The URL to navigate to" },
      },
      required: ["url"],
    },
  },
  {
    name: "browser_go_back",
    description: "Go back to the previous page",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "browser_snapshot",
    description:
      "Capture accessibility snapshot of the current page. Use this for getting references to elements to interact with.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "browser_click",
    description: "Perform click on a web page",
    input_schema: {
      type: "object",
      properties: element,
      required: ["element", "ref"],
    },
  },
  {
    name: "browser_hover",
    description: "Hover over element on page",
    input_schema: {
      type: "object",
      properties: element,
      required: ["element", "ref"],
    },
  },
  {
    name: "browser_type",
    description: "Type text into editable element",
    input_schema: {
      type: "object",
      properties: {
        ...element,
        text: { type: "string", description: "Text to type into the element" },
        submit: {
          type: "boolean",
          description: "Whether to submit entered text (press Enter after)",
        },
      },
      required: ["element", "ref", "text", "submit"],
    },
  },
  {
    name: "browser_select_option",
    description: "Select an option in a dropdown",
    input_schema: {
      type: "object",
      properties: {
        ...element,
        values: {
          type: "array",
          items: { type: "string" },
          description: "Array of values to select in the dropdown.",
        },
      },
      required: ["element", "ref", "values"],
    },
  },
  {
    name: "browser_press_key",
    description: "Press a key on the keyboard",
    input_schema: {
      type: "object",
      properties: {
        key: {
          type: "string",
          description:
            "Name of the key to press or a character to generate, such as `ArrowLeft` or `a`",
        },
      },
      required: ["key"],
    },
  },
  {
    name: "browser_wait",
    description: "Wait for a specified time in seconds",
    input_schema: {
      type: "object",
      properties: {
        time: { type: "number", description: "The time to wait in seconds" },
      },
      required: ["time"],
    },
  },
];

const typed: Config = {
  name: "typed",
  system: BASE_SYSTEM,
  tools: TYPED_TOOLS,
  async start(h) {
    const { page, tabId } = await freshPage(h);
    const at = (input: Record<string, unknown>) =>
      page.locator(`aria-ref=${String(input.ref)}`);
    return {
      async run(name, input) {
        switch (name) {
          case "browser_navigate":
            await page.goto(String(input.url));
            return fullSnapshot(page, `Navigated to ${String(input.url)}`);
          case "browser_go_back":
            await page.goBack();
            return fullSnapshot(page, "Navigated back");
          case "browser_snapshot":
            return fullSnapshot(page, "");
          case "browser_click":
            await at(input).click({ timeout: 5000 });
            return fullSnapshot(page, `Clicked "${String(input.element)}"`);
          case "browser_hover":
            await at(input).hover({ timeout: 5000 });
            return fullSnapshot(
              page,
              `Hovered over "${String(input.element)}"`,
            );
          case "browser_type":
            await at(input).fill(String(input.text), { timeout: 5000 });
            if (input.submit) await page.keyboard.press("Enter");
            return fullSnapshot(
              page,
              `Typed "${String(input.text)}" into "${String(input.element)}"`,
            );
          case "browser_select_option":
            await at(input).selectOption(input.values as string[], {
              timeout: 5000,
            });
            return fullSnapshot(
              page,
              `Selected option in "${String(input.element)}"`,
            );
          case "browser_press_key":
            await page.keyboard.press(String(input.key));
            return fullSnapshot(page, `Pressed key ${String(input.key)}`);
          case "browser_wait":
            await page.waitForTimeout(
              Math.min(Number(input.time) * 1000, 10_000),
            );
            return `Waited for ${String(input.time)} seconds`;
        }
        throw new Error(`Unknown tool ${name}`);
      },
      stop: () => h.backend.closeTab(tabId),
    };
  },
};

const playwright: Config = {
  name: "playwright",
  system: BASE_SYSTEM,
  tools: [
    {
      name: "execute",
      description: `Runs Playwright code (JavaScript, playwright-core) against the user's browser tab. In scope: \`page\` (a Playwright Page, the current tab) and \`context\`. The code is the body of an async function: use await, and \`return\` a value to see it (strings as is, other values as JSON); console.log output is returned too. Examples:
await page.goto('https://example.com'); return await page.title();
return await page.locator('body').ariaSnapshot();   // accessibility tree
await page.getByRole('button', { name: 'Submit' }).click();
Keep the output small: snapshot or read only what you need. Timeouts are 5 s.`,
      input_schema: {
        type: "object",
        properties: {
          code: { type: "string", description: "JavaScript to run" },
        },
        required: ["code"],
      },
    },
  ],
  async start(h) {
    const { page, tabId } = await freshPage(h);
    page.setDefaultTimeout(5000);
    return {
      async run(_name, input) {
        const logs: string[] = [];
        const log = (...args: unknown[]) =>
          logs.push(
            args
              .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
              .join(" "),
          );
        const AsyncFunction = Object.getPrototypeOf(async () => {})
          .constructor as new (
          ...args: string[]
        ) => (...args: unknown[]) => Promise<unknown>;
        const fn = new AsyncFunction(
          "page",
          "context",
          "console",
          String(input.code),
        );
        const result = await fn(page, page.context(), {
          log,
          error: log,
          info: log,
        });
        const out =
          result === undefined
            ? ""
            : typeof result === "string"
              ? result
              : JSON.stringify(result);
        const text = [...logs, out].filter(Boolean).join("\n") || "(no output)";
        return text.length > 20_000
          ? `${text.slice(0, 20_000)}\n… cut at 20000 characters`
          : text;
      },
      stop: () => h.backend.closeTab(tabId),
    };
  },
};

export const CONFIGS: Config[] = [
  cli("string"),
  cli("array"),
  typed,
  playwright,
];
