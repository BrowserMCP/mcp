import { defineBackground } from "wxt/utils/define-background";

import {
  addBrowserControl,
  handleBrowserControlMessages,
} from "@browsermcp/extension-core";

/**
 * The service worker: browser control, the connection to the Browser MCP daemon and the `chrome.debugger` relay (`@browsermcp/extension-core`). Chrome stops it whenever it's idle, so its listeners are added synchronously here, and its state lives in `browser.storage`
 */
export default defineBackground(() => {
  handleBrowserControlMessages(
    addBrowserControl({
      // The smoke test's fake 0.1.x server
      legacyPortOverride: import.meta.env.MODE !== "production",
    }),
  );
});
