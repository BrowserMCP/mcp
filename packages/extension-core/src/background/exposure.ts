import type { Browser } from "wxt/browser";

/** Schemes of browser and extension pages, which agents never get */
const HIDDEN_SCHEMES = new Set([
  "about:",
  "arc:",
  "brave:",
  "chrome:",
  "chrome-error:",
  "chrome-extension:",
  "chrome-search:",
  "chrome-untrusted:",
  "devtools:",
  "edge:",
  "extension:",
  "moz-extension:",
  "opera:",
  "vivaldi:",
  "view-source:",
]);

/** Extension stores, where browsers don't let extensions script or debug pages */
const STORE_URLS = [
  "https://chromewebstore.google.com/",
  "https://chrome.google.com/webstore",
  "https://microsoftedge.microsoft.com/addons",
  "https://addons.opera.com/",
];

/**
 * Whether agents may use a page at this URL: web pages, `about:blank` (new agent tabs start there) and, when the user allowed the extension file access, local files. Never browser pages, extension pages or extension stores, which the debugger can't attach to
 */
export function isExposedUrl(url: string, fileAccess = false): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (url === "about:blank") {
    return true;
  }
  if (parsed.protocol === "file:") {
    return fileAccess;
  }
  if (HIDDEN_SCHEMES.has(parsed.protocol)) {
    return false;
  }
  return !STORE_URLS.some((store) => url.startsWith(store));
}

/** The tab's URL, or the one it's loading when it has none yet */
export function getTabUrl(tab: Browser.tabs.Tab): string {
  return tab.url || tab.pendingUrl || "";
}

/** The URLs the rules check for a tab: the one it shows and the one it's loading, which may already be a browser page */
function getTabUrls(tab: Browser.tabs.Tab): string[] {
  const urls = [tab.url, tab.pendingUrl].filter((url): url is string =>
    Boolean(url),
  );
  return urls.length > 0 ? urls : [""];
}

export type ExposureRules = {
  /** The user let the extension open local files (`extension.isAllowedFileSchemeAccess()`) */
  fileAccess: boolean;
};

/**
 * Whether agents may use the tab: every tab except incognito ones, discarded ones (commands sent to them hang) and the pages `isExposedUrl()` leaves out, in its URL or the one it's loading
 */
export function isExposedTab(
  tab: Browser.tabs.Tab,
  rules: ExposureRules,
): tab is Browser.tabs.Tab & { id: number } {
  return (
    tab.id !== undefined &&
    // `tabs.TAB_ID_NONE`: tabs that aren't browser tabs, e.g. DevTools
    tab.id !== -1 &&
    !tab.incognito &&
    !tab.discarded &&
    getTabUrls(tab).every((url) => isExposedUrl(url, rules.fileAccess))
  );
}
