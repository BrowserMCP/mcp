/**
 * Browser control for the background: a thin `chrome.debugger` relay for the Browser MCP daemon (`@browsermcp/mcp`). The popup's side is `@browsermcp/extension-core/popup`
 */
export { addBrowserControl } from "./background";
export {
  BrowserControl,
  type BrowserControlEvent,
  type BrowserControlOptions,
  PAUSED_MESSAGE,
} from "./background/browser-control";
export {
  type BrowserControlMessages,
  handleBrowserControlMessages,
  requirePopupSender,
} from "./messages";
export * from "./types";
