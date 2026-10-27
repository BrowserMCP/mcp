/** Messages for the model (and the user reading along) about the browser connection, kept together so the engine and the relay word things the same way. `NO_EXTENSION_MESSAGE` and `pairingRequiredMessage()` are in `@browsermcp/protocol`, shared with the extension */

const HOME_PAGE = "https://browsermcp.io";

export const PAUSED_MESSAGE =
  "The user paused Browser MCP. Ask them to click Resume in its popup";

export const UPDATE_EXTENSION_MESSAGE = `The Browser MCP extension is outdated. Update it: open chrome://extensions, turn on Developer mode and click Update, then accept the new permission Chrome asks for. Steps: ${HOME_PAGE}`;

export const UPDATE_SERVER_MESSAGE = `The Browser MCP extension is newer than this server. Use @browsermcp/mcp@latest in the AI app's MCP config and restart the AI app. Steps: ${HOME_PAGE}`;

export const ANOTHER_BROWSER_MESSAGE =
  "Another browser or profile was connected to Browser MCP and took over. Select a tab again (`tab list`, `tab select <id>`) or use `goto <url>`";

export function rejectedExtensionMessage(extensionId: string): string {
  return `The extension ${extensionId} tried to connect but isn't allowed. If it's a development build, add its ID to BROWSER_MCP_EXTENSION_IDS (comma-separated) in the AI app's MCP config for @browsermcp/mcp and restart the AI app or reconnect the MCP server`;
}

export function noSuchTabMessage(tabId: number): string {
  return `There's no tab ${tabId} in the connected browser. Run \`tab list\``;
}
