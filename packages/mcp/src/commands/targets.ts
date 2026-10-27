/**
 * Targets: a snapshot ref (`e12`, `f1e3` in an iframe), a Playwright locator expression or a CSS selector.
 *
 * Locator expressions are parsed, not evaluated: only a whitelist of `Page`/`Locator` methods with literal arguments (strings, numbers, booleans, regexes, flat objects) is accepted, so a target can't run code in the daemon.
 */
import type { FrameLocator, Locator, Page } from "playwright-core";

import { ParseError } from "@/commands/parser";
import { fullRef } from "@/commands/snapshot";

type Literal =
  | string
  | number
  | boolean
  | RegExp
  | { [key: string]: string | number | boolean | RegExp };

export type LocatorCall = { method: string; args: Literal[] };

export type Target =
  | { kind: "ref"; ref: string; source: string }
  | { kind: "locator"; calls: LocatorCall[]; source: string }
  | { kind: "css"; selector: string; source: string };

const REF = /^(f\d+)?e\d+$/;

/** Methods a locator expression may call, with the option keys each accepts */
const METHODS: Record<string, { options?: string[]; maxArgs: number }> = {
  getByRole: {
    maxArgs: 2,
    options: [
      "name",
      "exact",
      "checked",
      "disabled",
      "expanded",
      "includeHidden",
      "level",
      "pressed",
      "selected",
    ],
  },
  getByText: { maxArgs: 2, options: ["exact"] },
  getByLabel: { maxArgs: 2, options: ["exact"] },
  getByPlaceholder: { maxArgs: 2, options: ["exact"] },
  getByAltText: { maxArgs: 2, options: ["exact"] },
  getByTitle: { maxArgs: 2, options: ["exact"] },
  getByTestId: { maxArgs: 1 },
  locator: { maxArgs: 2, options: ["hasText", "hasNotText"] },
  frameLocator: { maxArgs: 1 },
  contentFrame: { maxArgs: 0 },
  filter: { maxArgs: 1, options: ["hasText", "hasNotText", "visible"] },
  first: { maxArgs: 0 },
  last: { maxArgs: 0 },
  nth: { maxArgs: 1 },
};

export function isLocatorExpression(text: string): boolean {
  return /^(page\.)?[a-zA-Z]+\(/.test(text);
}

export function parseTarget(source: string): Target {
  if (REF.test(source)) return { kind: "ref", ref: source, source };
  if (isLocatorExpression(source)) {
    return { kind: "locator", calls: parseLocatorExpression(source), source };
  }
  return { kind: "css", selector: source, source };
}

export function toLocator(page: Page, target: Target): Locator {
  if (target.kind === "ref") {
    return page.locator(`aria-ref=${fullRef(page, target.ref)}`);
  }
  if (target.kind === "css") return page.locator(target.selector);
  let current: Page | Locator | FrameLocator = page;
  for (const { method, args } of target.calls) {
    const fn: unknown = (current as unknown as Record<string, unknown>)[method];
    if (typeof fn !== "function") {
      throw new ParseError(
        `${method}() can't follow ${current === page ? "page" : "this locator"} in ${target.source}`,
      );
    }
    current = (fn as (...a: Literal[]) => Page | Locator | FrameLocator).apply(
      current,
      args,
    );
  }
  if (!("click" in current) || current === page) {
    throw new ParseError(`${target.source} isn't an element locator`);
  }
  return current as Locator;
}

// --- A tiny parser for `getByRole('button', { name: /Sub/i }).first()` ---

class Cursor {
  i = 0;
  constructor(readonly text: string) {}
  skipSpace() {
    while (/\s/.test(this.text[this.i] ?? "")) this.i++;
  }
  peek() {
    this.skipSpace();
    return this.text[this.i];
  }
  expect(ch: string) {
    if (this.peek() !== ch) this.fail(`expected ${ch}`);
    this.i++;
  }
  fail(message: string): never {
    throw new ParseError(
      `Can't parse the locator ${this.text} at "${this.text.slice(this.i, this.i + 15)}": ${message}. Use getByRole('button', { name: 'Submit' }), getByLabel('Email'), getByText('…'), getByPlaceholder('…'), getByTestId('…'), a ref or a CSS selector`,
    );
  }
}

export function parseLocatorExpression(text: string): LocatorCall[] {
  const c: Cursor = new Cursor(text.startsWith("page.") ? text.slice(5) : text);
  const calls: LocatorCall[] = [];
  for (;;) {
    c.skipSpace();
    const name = /^[a-zA-Z]+/.exec(c.text.slice(c.i))?.[0];
    if (!name) c.fail("expected a method name");
    const spec = METHODS[name];
    if (!spec) c.fail(`${name}() isn't supported`);
    c.i += name.length;
    c.expect("(");
    const args: Literal[] = [];
    while (c.peek() !== ")") {
      if (args.length) c.expect(",");
      if (c.peek() === ")") break;
      args.push(parseLiteral(c));
    }
    c.expect(")");
    if (args.length > spec.maxArgs) {
      c.fail(`${name}() takes at most ${spec.maxArgs} arguments`);
    }
    for (const arg of args) {
      if (typeof arg !== "object" || arg instanceof RegExp) continue;
      for (const key of Object.keys(arg)) {
        if (!spec.options?.includes(key))
          c.fail(`${name}() has no ${key} option`);
      }
    }
    calls.push({ method: name, args });
    if (c.peek() === undefined) return calls;
    c.expect(".");
  }
}

function parseLiteral(c: Cursor): Literal {
  const ch = c.peek();
  if (ch === "'" || ch === '"' || ch === "`") return parseString(c, ch);
  if (ch === "/") {
    const start = c.i;
    c.i++;
    while (c.i < c.text.length && c.text[c.i] !== "/") {
      c.i += c.text[c.i] === "\\" ? 2 : 1;
    }
    const body = c.text.slice(start + 1, c.i);
    c.i++;
    const flags = /^[dgimsuy]*/.exec(c.text.slice(c.i))?.[0] ?? "";
    c.i += flags.length;
    try {
      return new RegExp(body, flags);
    } catch {
      c.fail("bad regular expression");
    }
  }
  if (ch === "{") {
    c.i++;
    const object: Record<string, string | number | boolean | RegExp> = {};
    while (c.peek() !== "}") {
      if (Object.keys(object).length) {
        c.expect(",");
        if (c.peek() === "}") break;
      }
      const quote = c.peek();
      const key =
        quote === "'" || quote === '"'
          ? parseString(c, quote)
          : /^[a-zA-Z]+/.exec(c.text.slice(c.i))?.[0];
      if (!key) c.fail("expected an option name");
      if (quote !== "'" && quote !== '"') c.i += key.length;
      c.expect(":");
      const value = parseLiteral(c);
      if (typeof value === "object" && !(value instanceof RegExp)) {
        c.fail("nested objects aren't supported");
      }
      object[key] = value;
    }
    c.i++;
    return object;
  }
  const word = /^(-?\d+(\.\d+)?|true|false)/.exec(c.text.slice(c.i))?.[0];
  if (!word) c.fail("expected a string, number, boolean, regex or { … }");
  c.i += word.length;
  return word === "true" ? true : word === "false" ? false : Number(word);
}

function parseString(c: Cursor, quote: string): string {
  const start = c.i;
  c.i++;
  let out = "";
  while (c.i < c.text.length && c.text[c.i] !== quote) {
    if (c.text[c.i] === "\\") {
      const next = c.text[c.i + 1];
      out += next === "n" ? "\n" : next === "t" ? "\t" : next;
      c.i += 2;
    } else {
      if (quote === "`" && c.text.startsWith("${", c.i)) {
        c.fail("template expressions aren't supported");
      }
      out += c.text[c.i++];
    }
  }
  if (c.i >= c.text.length) {
    c.i = start;
    c.fail("missing closing quote");
  }
  c.i++;
  return out;
}
