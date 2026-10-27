/**
 * Token budgets: flows on the fixture pages must not grow past their output sizes. Characters ÷ 4 ≈ tokens
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { COMMANDS } from "@/commands/commands";
import { READ_CAP } from "@/commands/output";
import { type Harness, startHarness } from "@/commands/testing/harness";
import { browserTool, MORE_COMMANDS } from "@/tools/browser";

let h: Harness;
const u = (p: string) => h.fixtures.url(p);

beforeAll(async () => {
  h = await startHarness();
});
afterAll(() => h?.close());

describe("token budgets", () => {
  it("fills the form in one call under 600 characters", async () => {
    const s = h.openSession();
    const text = await h.run(
      s,
      `goto ${u("/form")}
fill getByLabel('Customer name') "Jane Doe"
fill getByLabel('Telephone') "555-0100"
fill getByLabel('E-mail address') "jane@example.com"
check getByLabel('Medium')
check getByLabel('Bacon')
check getByLabel('Mushroom')
fill getByLabel('Delivery instructions') "Ring twice"
click getByRole('button', { name: 'Submit order' })
get text body --max 1500`,
    );
    expect(text).toContain("Thanks, order received");
    expect(text.length).toBeLessThan(600);
  });

  it("keeps each action's line under 200 characters", async () => {
    const s = h.openSession();
    const text = await h.run(
      s,
      `goto ${u("/list")}
click getByRole('link', { name: 'new', exact: true })
back
goto ${u("/search")}
fill getByLabel('Search products') "lamp" --submit
click getByRole('link', { name: 'Next' })
goto ${u("/modal")}
click getByRole('button', { name: 'Close' })
hover getByRole('button', { name: 'Read article' })
press Tab`,
    );
    const lines = text.split("\n").filter((line) => line.startsWith("✓"));
    expect(lines).toHaveLength(10);
    for (const line of lines) expect(line.length, line).toBeLessThan(200);
  });

  it("keeps snapshot -i and find within their caps", async () => {
    const s = h.openSession();
    const list = await h.run(s, `goto ${u("/list")}\nsnapshot -i`);
    const repo = await h.run(s, `goto ${u("/repo")}\nsnapshot -i`);
    const header = await h.run(s, "snapshot getByRole('banner') -i");
    const find = await h.run(s, 'find "v2.0.0"');
    // Measured: list ≈ 3.3K, repo ≈ 3.1K, header ≈ 0.4K, find ≈ 0.2K characters
    expect(list.length).toBeLessThan(4500);
    expect(repo.length).toBeLessThan(4000);
    expect(header.length).toBeLessThan(600);
    expect(find.length).toBeLessThan(400);
    const big = await h.run(s, `goto ${u("/big")}\nsnapshot -i\nfind "Link"`);
    expect(big.length).toBeLessThan(2 * READ_CAP + 1000);
  });

  it("keeps the tool definition small", () => {
    // Every turn pays for it again. 1,154 characters when trimmed (the API counted the 2,545-character one at about 800 tokens more than a one-line tool)
    expect(JSON.stringify(browserTool()).length).toBeLessThan(1300);
  });

  it("lists every command in the definition, or names it for help", () => {
    const description = browserTool(["cdp"]).description ?? "";
    for (const command of COMMANDS) {
      if (command.listed === false || command.name === "help") continue;
      expect(description, command.name).toMatch(
        new RegExp(`(^|[\\s|,])${command.name}\\b`, "m"),
      );
    }
    expect(MORE_COMMANDS.length).toBeGreaterThan(0);
  });
});
