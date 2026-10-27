/**
 * CDP commands the extension never relays, whatever the daemon asks, because they reach beyond the attached page: other sites' cookies and storage (which would leak without any navigation), other tabs and targets, and requests to any URL with the user's cookies. Playwright's page handling and the daemon's commands don't need them: Playwright sends `Storage.*Cookies` only for `context.cookies()`, `addCookies()` and `clearCookies()`, `Network.loadNetworkResource` only for the bodies of prefetch and service worker responses, and `Network.clearBrowserCache` when routing stops, none of which the engine uses. Raw `cdp` (`--caps cdp`) gets the same refusal
 */
const DENIED_METHODS = new Set([
  // Cookies of every site, or of the URLs asked for
  "Network.getAllCookies",
  "Network.getCookies",
  "Network.setCookie",
  "Network.setCookies",
  "Network.deleteCookies",
  "Network.clearBrowserCookies",
  "Network.clearBrowserCache",
  // Fetches any URL with the user's cookies, without CORS
  "Network.loadNetworkResource",
  // Other tabs and targets, and the browser itself (`chrome.debugger` refuses some of these, but not all, and not in every Chromium)
  "Target.attachToTarget",
  "Target.attachToBrowserTarget",
  "Target.activateTarget",
  "Target.closeTarget",
  "Target.createTarget",
  "Target.createBrowserContext",
  "Target.disposeBrowserContext",
  "Target.exposeDevToolsProtocol",
  "Target.getTargets",
  "Target.sendMessageToTarget",
  "Target.setDiscoverTargets",
  "Target.setRemoteLocations",
]);

/** Domains that take any origin or storage key as a parameter: cookies, storage, IndexedDB, Cache Storage and local storage of other sites */
const DENIED_DOMAINS = new Set([
  "Storage",
  "IndexedDB",
  "CacheStorage",
  "DOMStorage",
]);

/** Why the extension refuses this CDP command, or `null` when it relays it */
export function getDeniedCdpMessage(method: string): string | null {
  const domain = method.split(".")[0];
  if (DENIED_METHODS.has(method) || DENIED_DOMAINS.has(domain)) {
    return `Browser MCP doesn't allow ${method}: it reaches other sites or tabs`;
  }
  return null;
}

/** The URL a command navigates to, for the commands that take one */
export function getNavigationUrl(
  method: string,
  params: unknown,
): string | null {
  if (method !== "Page.navigate") {
    return null;
  }
  const url = (params as { url?: unknown } | undefined)?.url;
  return typeof url === "string" ? url : "";
}
