import { describe, expect, it } from "vitest";

import { ParseError } from "@/commands/parser";
import { parseLocatorExpression, parseTarget } from "@/commands/targets";

describe("parseTarget", () => {
  it("tells refs, locators and CSS apart", () => {
    expect(parseTarget("e12")).toMatchObject({ kind: "ref", ref: "e12" });
    expect(parseTarget("f1e3")).toMatchObject({ kind: "ref", ref: "f1e3" });
    expect(parseTarget("getByLabel('Email')")).toMatchObject({
      kind: "locator",
    });
    expect(parseTarget("page.getByText('Hi')")).toMatchObject({
      kind: "locator",
    });
    expect(parseTarget("#submit")).toMatchObject({
      kind: "css",
      selector: "#submit",
    });
    expect(parseTarget("div > a.nav")).toMatchObject({ kind: "css" });
    expect(parseTarget("em")).toMatchObject({ kind: "css" });
  });
});

describe("parseLocatorExpression", () => {
  it("parses calls with strings, regexes, numbers, booleans and options", () => {
    expect(
      parseLocatorExpression(
        `getByRole('button', { name: "Submit", exact: true }).filter({ hasText: /Pay/i }).nth(2)`,
      ),
    ).toEqual([
      {
        method: "getByRole",
        args: ["button", { name: "Submit", exact: true }],
      },
      { method: "filter", args: [{ hasText: /Pay/i }] },
      { method: "nth", args: [2] },
    ]);
    expect(
      parseLocatorExpression("frameLocator('#f').getByText(`It's`)"),
    ).toEqual([
      { method: "frameLocator", args: ["#f"] },
      { method: "getByText", args: ["It's"] },
    ]);
  });

  it("refuses anything but whitelisted methods and literals", () => {
    for (const bad of [
      "evaluate('() => 1')",
      "getByRole(process.exit())",
      "getByText('a').evaluate(x)",
      "getByRole('button', { name: x })",
      "getByRole('button', { onClick: 'x' })",
      "getByText(`${process.env.HOME}`)",
      "getByText('a');process.exit()",
    ]) {
      expect(() => parseLocatorExpression(bad), bad).toThrow(ParseError);
    }
  });
});
