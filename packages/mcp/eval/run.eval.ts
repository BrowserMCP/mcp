import Anthropic from "@anthropic-ai/sdk";
/**
 * The prototype eval: Claude drives each tool set in a loop on the local fixture pages, and we compare task success, turns and tokens.
 *
 * pnpm --filter @browsermcp/mcp eval   (needs ANTHROPIC_API_KEY; EVAL_MODELS, EVAL_CONFIGS, EVAL_TASKS and EVAL_REPEAT narrow or widen it)
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, it } from "vitest";

import { startHarness, type Harness } from "@/commands/testing/harness";

import { CONFIGS, type Config } from "./configs";

const MODELS = (
  process.env.EVAL_MODELS ?? "claude-haiku-5-5,claude-sonnet-5-5"
).split(",");
const REPEAT = Number(process.env.EVAL_REPEAT ?? 1);
const MAX_TURNS = 15;
/** $ per million input / output tokens; cache reads at 10%, writes at 125% */
const PRICES: Record<string, [number, number]> = {
  "claude-haiku-5-5": [0.1, 0.5],
  "claude-sonnet-5-5": [2, 10],
  "claude-opus-5-5": [4, 20],
};

type Task = {
  name: string;
  prompt: (url: (path: string) => string, tag: string) => string;
  check: (answer: string, h: Harness, tag: string) => boolean;
};

const has = (answer: string, ...parts: string[]) =>
  parts.every((part) => answer.toLowerCase().includes(part.toLowerCase()));

const TASKS: Task[] = [
  {
    name: "form",
    prompt: (url, tag) =>
      `Go to ${url("/form")} and order a pizza: customer name "Jane Doe ${tag}", telephone 555-0100, email jane@example.com, medium size, bacon and mushroom toppings, delivery instructions "Ring twice". Submit it and tell me the confirmation page's heading.`,
    check: (answer, h, tag) =>
      h.fixtures.posts.some(
        (post) =>
          post.custname === `Jane Doe ${tag}` &&
          post.custtel === "555-0100" &&
          post.custemail === "jane@example.com" &&
          post.size === "medium" &&
          post.topping === "bacon,mushroom" &&
          post.comments === "Ring twice",
      ) && has(answer, "order received"),
  },
  {
    name: "list",
    prompt: (url) =>
      `Open ${url("/list")}, go to its "new" page and tell me the titles of the top 3 stories there.`,
    check: (answer) => has(answer, "HTTP server in Zig", "homelab", "B-trees"),
  },
  {
    name: "repo",
    prompt: (url) =>
      `On ${url("/repo")}, how many stars does the repository have, and what's its latest release?`,
    check: (answer) => has(answer, "1.2k", "v2.0.0"),
  },
  {
    name: "login",
    prompt: (url) =>
      `Sign in at ${url("/login")} with username jane and password hunter2, then tell me the account number shown.`,
    check: (answer) => has(answer, "AC-4471-Z"),
  },
  {
    name: "search",
    prompt: (url) =>
      `On ${url("/search")}, search for "lamp" and list every result with its price, across all result pages.`,
    check: (answer) =>
      has(
        answer,
        "Red lamp 6",
        "Blue lamp 7",
        "Green lamp 8",
        "Black lamp 9",
        "White lamp 10",
      ),
  },
  {
    name: "modal",
    prompt: (url) =>
      `On ${url("/modal")}, click "Read article" and tell me the text that appears.`,
    check: (answer) => has(answer, "Article opened"),
  },
  {
    name: "feed",
    prompt: (url) =>
      `On ${url("/feed")}, which post is about a lighthouse keeper? Give its number.`,
    check: (answer) => has(answer, "37"),
  },
];

type Result = {
  model: string;
  config: string;
  task: string;
  success: boolean;
  turns: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  toolResultChars: number;
  cost: number;
  answer: string;
  error?: string;
};

let h: Harness;
const client = new Anthropic();

beforeAll(async () => {
  h = await startHarness();
});
afterAll(() => h?.close());

async function runOne(
  model: string,
  config: Config,
  task: Task,
  tag: string,
): Promise<Result> {
  const { run, stop } = await config.start(h);
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: task.prompt(h.fixtures.url, tag) },
  ];
  const result: Result = {
    model,
    config: config.name,
    task: task.name,
    success: false,
    turns: 0,
    toolCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    toolResultChars: 0,
    cost: 0,
    answer: "",
  };
  const [inPrice, outPrice] = PRICES[model] ?? [4, 20];
  const system = config.name.startsWith("cli")
    ? `${config.system}\n\n${h.engine.instructions()}`
    : config.system;
  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const response = await client.messages.create({
        model,
        max_tokens: 8000,
        system,
        tools: config.tools,
        messages,
        cache_control: { type: "ephemeral" },
      });
      result.turns++;
      const usage = response.usage;
      const cacheRead = usage.cache_read_input_tokens ?? 0;
      const cacheWrite = usage.cache_creation_input_tokens ?? 0;
      result.inputTokens += usage.input_tokens + cacheRead + cacheWrite;
      result.outputTokens += usage.output_tokens;
      result.cost +=
        ((usage.input_tokens + cacheRead * 0.1 + cacheWrite * 1.25) * inPrice +
          usage.output_tokens * outPrice) /
        1e6;
      messages.push({ role: "assistant", content: response.content });
      const uses = response.content.filter(
        (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
      );
      if (response.stop_reason !== "tool_use" || !uses.length) {
        result.answer = response.content
          .filter(
            (block): block is Anthropic.TextBlock => block.type === "text",
          )
          .map((block) => block.text)
          .join("\n");
        break;
      }
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const use of uses) {
        result.toolCalls++;
        let text: string;
        let isError = false;
        try {
          text = await run(use.name, use.input as Record<string, unknown>);
        } catch (error) {
          text = String((error as Error).message).split("\n")[0];
          isError = true;
        }
        result.toolResultChars += text.length;
        results.push({
          type: "tool_result",
          tool_use_id: use.id,
          content: text,
          is_error: isError,
        });
      }
      messages.push({ role: "user", content: results });
    }
  } catch (error) {
    result.error = String((error as Error).message).slice(0, 300);
  } finally {
    await stop().catch(() => {});
  }
  result.success = !result.error && task.check(result.answer, h, tag);
  return result;
}

/** Tokens a tool set's definitions add to every request */
async function definitionTokens(config: Config, model: string) {
  const base = { model, messages: [{ role: "user" as const, content: "hi" }] };
  const [without, withTools] = await Promise.all([
    client.messages.countTokens(base),
    client.messages.countTokens({ ...base, tools: config.tools }),
  ]);
  return withTools.input_tokens - without.input_tokens;
}

/** Checks each tool set's plumbing with scripted calls, without the API */
it("runs scripted calls through every tool set", async () => {
  const form = h.fixtures.url("/form");
  const scripts: Record<string, [string, Record<string, unknown>][]> = {
    "cli-string": [
      ["browser", { commands: `goto ${form}\nfind "Customer name"` }],
    ],
    "cli-array": [
      ["browser", { commands: [`goto ${form}`, 'find "Customer name"'] }],
    ],
    typed: [["browser_navigate", { url: form }]],
    playwright: [
      [
        "execute",
        {
          code: `await page.goto(${JSON.stringify(form)}); return await page.title();`,
        },
      ],
    ],
  };
  for (const config of CONFIGS) {
    const { run, stop } = await config.start(h);
    for (const [name, input] of scripts[config.name]) {
      const text = await run(name, input);
      if (!/Customer name|Pizza order/.test(text))
        throw new Error(`${config.name}: ${text}`);
    }
    await stop();
  }
});

/**
 * Without a model: the shortest scripted solution of the form and list tasks with each tool set, counting calls and result characters (what the model reads back)
 */
it("compares scripted solutions", async () => {
  const url = h.fixtures.url;
  const refIn = (snapshot: string, line: RegExp) => {
    const match = snapshot.split("\n").find((l) => line.test(l));
    return /\[ref=(\w+)\]/.exec(match ?? "")?.[1] ?? "missing";
  };
  type Step = (last: string) => [string, Record<string, unknown>];
  const typedForm: Step[] = [
    () => ["browser_navigate", { url: url("/form") }],
    ...[
      [/textbox "Customer name/, "Jane Doe"],
      [/textbox "Telephone/, "555-0100"],
      [/textbox "E-mail address/, "jane@example.com"],
      [/textbox "Delivery instructions/, "Ring twice"],
    ].map(([line, text]): Step => (last) => [
      "browser_type",
      {
        element: "field",
        ref: refIn(last, line as RegExp),
        text,
        submit: false,
      },
    ]),
    ...[/radio "Medium"/, /checkbox "Bacon"/, /checkbox "Mushroom"/].map(
      (line): Step =>
        (last) => [
          "browser_click",
          { element: "option", ref: refIn(last, line) },
        ],
    ),
    (last) => [
      "browser_click",
      { element: "submit", ref: refIn(last, /button "Submit order"/) },
    ],
  ];
  const typedList: Step[] = [
    () => ["browser_navigate", { url: url("/list") }],
    (last) => [
      "browser_click",
      { element: "new", ref: refIn(last, /link "new"/) },
    ],
  ];
  const cliForm = `goto ${url("/form")}
fill getByLabel('Customer name') "Jane Doe"
fill getByLabel('Telephone') "555-0100"
fill getByLabel('E-mail address') "jane@example.com"
check getByLabel('Medium')
check getByLabel('Bacon')
check getByLabel('Mushroom')
fill getByLabel('Delivery instructions') "Ring twice"
click getByRole('button', { name: 'Submit order' })
get text body --max 1500`;
  const cliList = `goto ${url("/list")}\nclick getByRole('link', { name: 'new', exact: true })\nfind "Fresh"`;
  const pwForm = `await page.goto(${JSON.stringify(url("/form"))});
await page.getByLabel('Customer name').fill('Jane Doe');
await page.getByLabel('Telephone').fill('555-0100');
await page.getByLabel('E-mail address').fill('jane@example.com');
await page.getByLabel('Medium').check();
await page.getByLabel('Bacon').check();
await page.getByLabel('Mushroom').check();
await page.getByLabel('Delivery instructions').fill('Ring twice');
await page.getByRole('button', { name: 'Submit order' }).click();
await page.waitForLoadState();
return await page.locator('body').innerText();`;
  const pwList = `await page.goto(${JSON.stringify(url("/list"))});
await page.getByRole('link', { name: 'new', exact: true }).click();
await page.waitForLoadState();
return (await page.locator('td.title a').allInnerTexts()).slice(0, 3);`;
  const plans: Record<string, Record<string, Step[]>> = {
    "cli-string": {
      form: [() => ["browser", { commands: cliForm }]],
      list: [() => ["browser", { commands: cliList }]],
    },
    "cli-array": {
      form: [() => ["browser", { commands: cliForm.split("\n") }]],
      list: [() => ["browser", { commands: cliList.split("\n") }]],
    },
    typed: { form: typedForm, list: typedList },
    playwright: {
      form: [() => ["execute", { code: pwForm }]],
      list: [() => ["execute", { code: pwList }]],
    },
  };
  const rows = [
    "| Tools | Task | Calls | Input chars (sent) | Result chars (read back) |",
    "|---|---|---|---|---|",
  ];
  for (const config of CONFIGS) {
    for (const [task, steps] of Object.entries(plans[config.name])) {
      const { run, stop } = await config.start(h);
      let last = "";
      let sent = 0;
      let read = 0;
      for (const step of steps) {
        const [name, input] = step(last);
        sent += JSON.stringify(input).length;
        last = await run(name, input);
        read += last.length;
      }
      await stop();
      rows.push(
        `| ${config.name} | ${task} | ${steps.length} | ${sent} | ${read} |`,
      );
    }
  }
  console.log(rows.join("\n"));
});

it.skipIf(!process.env.ANTHROPIC_API_KEY)(
  "runs the eval",
  { timeout: 60 * 60_000 },
  async () => {
    const configs = CONFIGS.filter(
      (config) =>
        !process.env.EVAL_CONFIGS ||
        process.env.EVAL_CONFIGS.split(",").includes(config.name),
    );
    const tasks = TASKS.filter(
      (task) =>
        !process.env.EVAL_TASKS ||
        process.env.EVAL_TASKS.split(",").includes(task.name),
    );
    const definitions: Record<string, number> = {};
    for (const config of configs)
      definitions[config.name] = await definitionTokens(config, MODELS[0]);
    console.log("definition tokens", definitions);

    const jobs: (() => Promise<Result>)[] = [];
    let n = 0;
    for (let r = 0; r < REPEAT; r++) {
      for (const model of MODELS) {
        for (const config of configs) {
          for (const task of tasks) {
            const tag = String(++n);
            jobs.push(() => runOne(model, config, task, tag));
          }
        }
      }
    }
    const results: Result[] = [];
    const queue = [...jobs];
    await Promise.all(
      Array.from({ length: 6 }, async () => {
        for (let job = queue.shift(); job; job = queue.shift()) {
          const result = await job();
          results.push(result);
          console.log(
            `${result.model} ${result.config} ${result.task}: ${result.success ? "ok" : "FAIL"} turns=${result.turns} in=${result.inputTokens} out=${result.outputTokens} results=${result.toolResultChars}ch $${result.cost.toFixed(4)}${result.error ? ` error=${result.error}` : ""}`,
          );
        }
      }),
    );
    const dir = path.join(import.meta.dirname, "results");
    mkdirSync(dir, { recursive: true });
    const file = path.join(
      dir,
      `${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
    );
    writeFileSync(file, JSON.stringify({ definitions, results }, null, 1));
    console.log(summary(results, definitions));
    console.log(
      `total $${results.reduce((sum, r) => sum + r.cost, 0).toFixed(2)}; ${file}`,
    );
  },
);

function summary(results: Result[], definitions: Record<string, number>) {
  const lines = [
    "| Model | Tools | Success | Turns (avg) | Input tokens (avg) | Output tokens (avg) | Tool results, chars (avg) | Cost |",
    "|---|---|---|---|---|---|---|---|",
  ];
  const groups = new Map<string, Result[]>();
  for (const r of results) {
    const key = `${r.model}|${r.config}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  for (const [key, group] of groups) {
    const [model, config] = key.split("|");
    const avg = (pick: (r: Result) => number) =>
      Math.round(group.reduce((sum, r) => sum + pick(r), 0) / group.length);
    lines.push(
      `| ${model} | ${config} (${definitions[config]} def) | ${group.filter((r) => r.success).length}/${group.length} | ${(group.reduce((s, r) => s + r.turns, 0) / group.length).toFixed(1)} | ${avg((r) => r.inputTokens)} | ${avg((r) => r.outputTokens)} | ${avg((r) => r.toolResultChars)} | $${group.reduce((s, r) => s + r.cost, 0).toFixed(3)} |`,
    );
  }
  return lines.join("\n");
}
