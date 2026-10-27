import { browser } from "wxt/browser";

import { REMOVE_FRAMES_MESSAGE, removeExtensionFrames } from "./frames";

/**
 * For a content script declared in the extension's manifest (`matches: ["<all_urls>"]`, `allFrames: true`). It does nothing until the background asks, when another extension's frame (a password manager's inline menu) blocks `debugger.attach()`: then it removes those frames from its document, including from closed shadow roots, which only a manifest content script can look into (`chrome.dom`). Pages and other extensions can't send it messages
 */
export function handleFrameRemovalRequests(): void {
  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (
      sender.id === browser.runtime.id &&
      (message as { type?: unknown } | null)?.type === REMOVE_FRAMES_MESSAGE
    ) {
      sendResponse(removeExtensionFrames(browser.runtime.id));
    }
  });
}
