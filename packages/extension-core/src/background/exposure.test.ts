import { describe, expect, it } from "vitest";
import type { Browser } from "wxt/browser";

import { isExposedTab, isExposedUrl } from "./exposure";

const rules = { fileAccess: false };

function tab(overrides: Partial<Browser.tabs.Tab> = {}): Browser.tabs.Tab {
  return {
    id: 1,
    windowId: 1,
    index: 0,
    url: "https://example.com/",
    incognito: false,
    discarded: false,
    pinned: false,
    active: false,
    highlighted: false,
    autoDiscardable: true,
    groupId: -1,
    frozen: false,
    selected: false,
    ...overrides,
  } as Browser.tabs.Tab;
}

describe("which tabs agents may use", () => {
  it.each([
    ["https://example.com/page", true],
    ["http://localhost:3000/", true],
    ["about:blank", true],
    ["data:text/html,hi", true],
    ["chrome://settings/", false],
    ["chrome://newtab/", false],
    ["about:newtab", false],
    ["edge://extensions/", false],
    ["brave://rewards/", false],
    ["devtools://devtools/bundled/inspector.html", false],
    ["view-source:https://example.com/", false],
    ["chrome-extension://abcdefghijklmnopabcdefghijklmnop/popup.html", false],
    ["chrome-untrusted://print/", false],
    ["https://chromewebstore.google.com/detail/foo/bar", false],
    ["https://chrome.google.com/webstore/detail/foo", false],
    ["https://microsoftedge.microsoft.com/addons/detail/foo", false],
    ["file:///Users/me/page.html", false],
    ["", false],
  ])("%s → %s", (url, exposed) => {
    expect(isExposedUrl(url)).toBe(exposed);
  });

  it("lets agents use local files only with file access", () => {
    expect(isExposedUrl("file:///tmp/a.html", true)).toBe(true);
  });

  it("leaves out incognito and discarded tabs, and tabs without an ID", () => {
    expect(isExposedTab(tab(), rules)).toBe(true);
    expect(isExposedTab(tab({ incognito: true }), rules)).toBe(false);
    expect(isExposedTab(tab({ discarded: true }), rules)).toBe(false);
    expect(isExposedTab(tab({ id: -1 }), rules)).toBe(false);
    expect(isExposedTab(tab({ id: undefined }), rules)).toBe(false);
  });

  it("uses the URL a tab is loading when it has none yet", () => {
    expect(
      isExposedTab(tab({ url: "", pendingUrl: "https://example.com/" }), rules),
    ).toBe(true);
    expect(
      isExposedTab(tab({ url: "", pendingUrl: "chrome://newtab/" }), rules),
    ).toBe(false);
  });
});
