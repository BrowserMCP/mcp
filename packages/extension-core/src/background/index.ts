import { BrowserControl, type BrowserControlOptions } from "./browser-control";

/**
 * Starts browser control: the connection to the Browser MCP daemon and the `chrome.debugger` relay (Chrome and other Chromium browsers; Firefox has no `debugger` API, so don't call it there). Call it synchronously from `defineBackground()`, then pass it to `handleBrowserControlMessages()`
 */
export function addBrowserControl(
  options: BrowserControlOptions = {},
): BrowserControl {
  const browserControl = new BrowserControl(options);
  browserControl.start();
  return browserControl;
}
