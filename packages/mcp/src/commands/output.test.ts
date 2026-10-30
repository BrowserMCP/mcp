import { describe, expect, it } from "vitest";

import { cap, READ_CAP, READ_CAP_MAX, readCap } from "@/commands/output";

describe("readCap", () => {
  it("takes a number, all, or nothing", () => {
    expect(readCap(undefined)).toBe(READ_CAP);
    expect(readCap("2000")).toBe(2000);
    expect(readCap("all")).toBe(READ_CAP_MAX);
    expect(readCap(String(READ_CAP_MAX * 2))).toBe(READ_CAP_MAX);
    expect(() => readCap("lots")).toThrow("--max takes a number");
  });
});

describe("cap", () => {
  const lines = (n: number) => "x".repeat(99).concat("\n").repeat(n);

  it("offers --max all when it would read everything", () => {
    expect(cap(lines(200), READ_CAP, "narrow it")).toMatch(
      /… cut at \d+ of 20000 characters: --max all reads all of it, or narrow it$/,
    );
  });

  it("says --max all reads only the first part of a bigger text", () => {
    expect(cap(lines(1000), READ_CAP, "narrow it")).toContain(
      `--max all reads the first ${READ_CAP_MAX}, or narrow it`,
    );
  });

  it("only says how to narrow it at the ceiling", () => {
    expect(cap(lines(1000), READ_CAP_MAX, "narrow it")).toMatch(
      /characters: narrow it$/,
    );
  });
});
