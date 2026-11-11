import { describe, expect, it } from "vitest";

import {
  MAX_BROWSER_LABEL_LENGTH,
  normalizeBrowserLabel,
} from "./browser-label";

describe("normalizeBrowserLabel()", () => {
  it("trims and collapses whitespace", () => {
    expect(normalizeBrowserLabel("  Work \n  laptop\t")).toBe("Work laptop");
  });

  it("treats empty and blank names as unset", () => {
    expect(normalizeBrowserLabel("")).toBeNull();
    expect(normalizeBrowserLabel("   ")).toBeNull();
    expect(normalizeBrowserLabel(null)).toBeNull();
  });

  it(`caps names at ${MAX_BROWSER_LABEL_LENGTH} characters without splitting one`, () => {
    expect(normalizeBrowserLabel("a".repeat(50))).toBe("a".repeat(40));
    const emoji = "😀".repeat(45);
    expect(Array.from(normalizeBrowserLabel(emoji)!)).toHaveLength(40);
    // No trailing space left by the cut
    expect(normalizeBrowserLabel(`${"a".repeat(39)} b`)).toBe("a".repeat(39));
  });
});
