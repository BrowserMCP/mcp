import { describe, expect, it } from "vitest";

import {
  parseArgs,
  parseCommands,
  ParseError,
  tokenize,
} from "@/commands/parser";

const texts = (line: string) => tokenize(line).map((token) => token.text);

describe("parseCommands", () => {
  it("skips blank lines and comments, and numbers the steps", () => {
    const lines = parseCommands(
      "# setup\n\ngoto example.com\n  # again\nsnapshot -i\n",
    );
    expect(lines.map((line) => [line.step, line.source])).toEqual([
      [1, "goto example.com"],
      [2, "snapshot -i"],
    ]);
  });

  it("doesn't tokenize, so a bad line is reported against its own line", () => {
    expect(parseCommands('get title\nfill e1 "hunt\\er2"')).toHaveLength(2);
  });

  it("accepts an array of lines, each possibly with several", () => {
    expect(
      parseCommands(["goto a", "click e1\npress Enter"]).map((l) => l.source),
    ).toEqual(["goto a", "click e1", "press Enter"]);
  });
});

describe("tokenize", () => {
  it("decodes double-quoted arguments as JSON strings", () => {
    expect(tokenize('fill e3 "He said \\"hi\\"\\n" --submit')).toEqual([
      { text: "fill", quoted: false },
      { text: "e3", quoted: false },
      { text: 'He said "hi"\n', quoted: true },
      { text: "--submit", quoted: false },
    ]);
  });

  it("keeps locators, attribute selectors and JSON whole", () => {
    expect(
      texts(`click getByRole('button', { name: 'Submit order' }).first()`),
    ).toEqual([
      "click",
      "getByRole('button', { name: 'Submit order' }).first()",
    ]);
    expect(texts(`click a[title="x y"]`)).toEqual(["click", 'a[title="x y"]']);
    expect(
      texts(
        `cdp Network.emulateNetworkConditions {"offline": true, "latency": 0}`,
      ),
    ).toEqual([
      "cdp",
      "Network.emulateNetworkConditions",
      '{"offline": true, "latency": 0}',
    ]);
    expect(texts(`click getByText(/sign (in|up)/i)`)).toEqual([
      "click",
      "getByText(/sign (in|up)/i)",
    ]);
    expect(texts(`click getByText('a ) b')`)).toEqual([
      "click",
      "getByText('a ) b')",
    ]);
  });

  it("fails on unbalanced brackets and quotes", () => {
    expect(() => tokenize(`click getByRole('button'`)).toThrow(ParseError);
    expect(() => tokenize(`fill e1 "abc`)).toThrow(/Missing closing/);
  });

  it("gives a column, never the text, in errors", () => {
    expect(() => tokenize(`fill e1 "hunt\\er2"`)).toThrow(
      "Bad escaping in the quoted argument at column 9",
    );
    expect(() => tokenize(`fill e1 "hunter2`)).toThrow(
      'Missing closing " for the quote at column 9',
    );
    for (const line of [`fill e1 "hunt\\er2"`, `fill e1 "hunter2`]) {
      expect(() => tokenize(line)).not.toThrow(/hunt/);
    }
  });

  it("passes eval's code to JavaScript with its backslashes, decoding only the quote's escape", () => {
    expect(texts(`eval "() => [1].join('\\n') + /\\d/.source"`)).toEqual([
      "eval",
      "() => [1].join('\\n') + /\\d/.source",
    ]);
    expect(texts(`eval "() => \\"a\\\\nb\\u00a0\\""`)).toEqual([
      "eval",
      '() => "a\\\\nb\\u00a0"',
    ]);
    expect(texts(`eval '() => "x\\'y"' e1`)).toEqual([
      "eval",
      `() => "x'y"`,
      "e1",
    ]);
  });

  it("takes single-quoted arguments", () => {
    expect(tokenize(`fill getByLabel('Phone') 'hello world'`)).toEqual([
      { text: "fill", quoted: false },
      { text: "getByLabel('Phone')", quoted: false },
      { text: "hello world", quoted: true },
    ]);
    expect(texts(`type 'it\\'s "fine"\\n'`)).toEqual(["type", `it's "fine"\n`]);
  });
});

describe("parseArgs", () => {
  it("splits flags from positional arguments", () => {
    const args = parseArgs("snapshot", tokenize("e5 -i --depth 3"), {
      i: false,
      depth: true,
    });
    expect(args.positional.map((t) => t.text)).toEqual(["e5"]);
    expect(args.flags).toEqual({ i: true, depth: "3" });
  });

  it("treats quoted text that looks like a flag as an argument", () => {
    const args = parseArgs("fill", tokenize('e1 "--submit"'), {
      submit: false,
    });
    expect(args.positional.map((t) => t.text)).toEqual(["e1", "--submit"]);
    expect(args.flags).toEqual({});
  });

  it("names the command's help for unknown flags", () => {
    expect(() => parseArgs("click", tokenize("e1 --force"), {})).toThrow(
      "click has no --force flag. Run `help click`",
    );
  });
});
