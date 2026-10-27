import { readFileSync } from "node:fs";

import {
  CHROME_WEB_STORE_EXTENSION_ID,
  SELF_BUILT_EXTENSION_ID,
} from "@browsermcp/protocol";

const EXTENSION_ID = /^[a-p]{32}$/;

/**
 * The extension IDs in comma-separated `BROWSER_MCP_EXTENSION_IDS` (a dev build's per-checkout ID, Edge Add-ons' or another store's); anything that isn't a Chrome extension ID is dropped
 */
export function extensionIdsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return (env.BROWSER_MCP_EXTENSION_IDS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => EXTENSION_ID.test(id));
}

/**
 * The Chrome extension IDs allowed to connect on `/extension`: the Chrome Web Store's and the one built from source, plus `BROWSER_MCP_EXTENSION_IDS`. A thin process sends its own `BROWSER_MCP_EXTENSION_IDS` in `hello`, and the daemon adds them while it runs, so a changed MCP config doesn't need the daemon restarted
 */
export function allowedExtensionIds(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return [
    CHROME_WEB_STORE_EXTENSION_ID,
    SELF_BUILT_EXTENSION_ID,
    ...extensionIdsFromEnv(env),
  ];
}

/**
 * The extension IDs listed in the `dev-extension-ids` file at `file`: one per line, blank lines and `#` comments ignored, anything that isn't a Chrome extension ID dropped. A missing or unreadable file lists none
 */
export function readDevExtensionIds(file: string): string[] {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .map((line) => line.replace(/#.*/, "").trim())
    .filter((id) => EXTENSION_ID.test(id));
}
