import type { AppInfo, ClientHello } from "@/contracts";

/** Names of well-known MCP clients (`initialize`'s `clientInfo.name`), for their tab groups */
const KNOWN_APPS: Record<string, string> = {
  "claude-code": "Claude Code",
  "claude-ai": "Claude",
  "cursor-vscode": "Cursor",
  "codex-mcp-client": "Codex",
  "Visual Studio Code": "VS Code",
  "windsurf-client": "Windsurf",
  "gemini-cli-mcp-client": "Gemini CLI",
  zed: "Zed",
};

/** The AI app a session belongs to: sessions of the same app share its tab group */
export function appFromClient(client: ClientHello["client"]): AppInfo {
  const rawName = client.name?.trim() || "AI app";
  const name =
    KNOWN_APPS[rawName] ??
    client.title?.trim() ??
    rawName.charAt(0).toUpperCase() + rawName.slice(1);
  const id =
    rawName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "app";
  return { id, name };
}
