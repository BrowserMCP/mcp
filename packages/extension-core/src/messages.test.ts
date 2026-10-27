import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Browser } from "wxt/browser";
import { fakeBrowser } from "wxt/testing/fake-browser";

import type { BrowserControl } from "./background/browser-control";
import {
  handleBrowserControlMessages,
  requirePopupSender,
  sendBrowserControlMessage,
} from "./messages";

/** The parts of `BrowserControl` the messages call */
function fakeBrowserControl() {
  return {
    getView: vi.fn(async () => ({ paused: false })),
    stop: vi.fn(async () => {}),
    resume: vi.fn(async () => {}),
    allow: vi.fn(async () => {}),
    setRelayPort: vi.fn(async () => {}),
    switchToTab: vi.fn(async () => {}),
    connection: { connectNow: vi.fn() },
  };
}

describe("browser control's messages", () => {
  let removeListener: (() => void) | undefined;

  beforeEach(() => {
    fakeBrowser.reset();
  });

  afterEach(() => {
    removeListener?.();
  });

  it("answers the popup's messages", async () => {
    const control = fakeBrowserControl();
    removeListener = handleBrowserControlMessages(
      control as unknown as BrowserControl,
    );

    await expect(
      sendBrowserControlMessage("getBrowserControl"),
    ).resolves.toEqual({ paused: false });
    await sendBrowserControlMessage("ping");
    expect(control.connection.connectNow).toHaveBeenCalled();
  });

  it("does what only the popup may do only for the popup", async () => {
    const control = fakeBrowserControl();
    removeListener = handleBrowserControlMessages(
      control as unknown as BrowserControl,
    );

    // `fakeBrowser`'s messages come from no page, as a content script's might
    await expect(sendBrowserControlMessage("resumeAgents")).rejects.toThrow(
      /popup/,
    );
    expect(control.resume).not.toHaveBeenCalled();
  });

  it("fails without browser control (Firefox), and ping does nothing", async () => {
    removeListener = handleBrowserControlMessages(null);

    await expect(
      sendBrowserControlMessage("getBrowserControl"),
    ).rejects.toThrow(/Chromium/);
    await expect(sendBrowserControlMessage("ping")).resolves.toBeUndefined();
  });

  it("leaves other messages to the extension's own listeners", async () => {
    removeListener = handleBrowserControlMessages(
      fakeBrowserControl() as unknown as BrowserControl,
    );
    const other = vi.fn(() => false);
    fakeBrowser.runtime.onMessage.addListener(other);

    await expect(
      fakeBrowser.runtime.sendMessage({ type: "ping" }),
    ).resolves.toBeUndefined();
    await expect(
      fakeBrowser.runtime.sendMessage({ browserControl: "toString" }),
    ).resolves.toBeUndefined();
    expect(other).toHaveBeenCalledTimes(2);
  });

  it("tells the popup from content scripts and pages framing it", () => {
    const popupUrl = fakeBrowser.runtime.getURL("/popup.html");
    const tab = (url: string) => ({ url }) as Browser.tabs.Tab;
    // The toolbar's popup, and popup.html in a tab of its own (the E2E and smoke tests)
    expect(() => requirePopupSender({ url: popupUrl })).not.toThrow();
    expect(() =>
      requirePopupSender({ url: popupUrl, tab: tab(popupUrl) }),
    ).not.toThrow();
    // A content script, and popup.html framed in a page
    for (const sender of [
      { url: "https://example.com/", tab: tab("https://example.com/") },
      { url: popupUrl, tab: tab("https://example.com/") },
      {},
    ]) {
      expect(() => requirePopupSender(sender)).toThrow(/popup/);
    }
  });
});
