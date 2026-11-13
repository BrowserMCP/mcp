import { describe, expect, it } from "vitest";

import {
  hiddenTabsMessage,
  moreHiddenTabsNote,
} from "@/commands/restricted-tabs";

describe("hidden tabs notes", () => {
  it("tells the model that tabs exist and what the user can do", () => {
    const message = hiddenTabsMessage(3);
    expect(message).toContain("3 tabs open");
    expect(message).toContain("Enable control for this tab");
    expect(message).toContain("tab new");
    expect(hiddenTabsMessage(1)).toContain("1 tab open");
  });

  it("notes the tabs left out of a list", () => {
    expect(moreHiddenTabsNote(2)).toContain("2 more tabs are open");
    expect(moreHiddenTabsNote(1)).toContain("1 more tab is open");
  });
});
