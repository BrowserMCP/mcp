# Browser MCP

Browser MCP lets AI apps (Claude Code, Cursor, VS Code, Codex, Claude Desktop…) use your own Chrome: your signed-in sites, your profile, in tabs of their own. Everything runs on your computer.

- **Website and docs**: [browsermcp.io](https://browsermcp.io), [docs](https://browsermcp.io/docs)
- **Extension**: [Chrome Web Store](https://chromewebstore.google.com/detail/bjfgambnhccakkhmkepdoekmckoijdlc), or [build it yourself](#build-it-yourself)
- **MCP server**: [`@browsermcp/mcp`](https://www.npmjs.com/package/@browsermcp/mcp) on npm

## How it works

Each AI app runs the MCP server (`npx @browsermcp/mcp@latest`), a small process that starts one daemon per user and forwards the app's `browser` tool calls to it. The daemon drives the browser's tabs with Playwright, through the extension: a thin `chrome.debugger` relay that only talks to the daemon on `127.0.0.1`, and only after you click **Allow** in its popup once per computer, having checked that its six-digit code matches the one your AI app shows. The extension enforces its own rules whatever the daemon asks: no incognito tabs unless you turned on **Allow in Incognito** for the extension in Chrome, no browser or extension pages, and nothing while you've pressed **Stop**.

| Folder                    | Package                      |                                                                                                                           |
| ------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `packages/mcp`            | `@browsermcp/mcp`            | The MCP server and the daemon ([README](packages/mcp/README.md))                                                          |
| `packages/protocol`       | `@browsermcp/protocol`       | The protocol between the extension and the daemon, including pairing                                                      |
| `packages/extension-core` | `@browsermcp/extension-core` | The extension's browser control: the connection, pairing, the debugger relay, the rules about tabs, tab groups, the badge |
| `apps/extension`          | `@browsermcp/extension`      | The extension built from this repo: browser control and its popup                                                         |

## Build it yourself

You need Node.js 24 or later, pnpm (`corepack enable`) and Chrome or another Chromium browser (Edge, Brave, Arc…). Firefox has no `debugger` API, so Browser MCP doesn't work there.

The Chrome Web Store version updates itself. A build you load yourself doesn't: you update it by hand (see [Updating](#updating)).

1. Build the extension and the server:

   ```sh
   git clone https://github.com/BrowserMCP/mcp.git browsermcp
   cd browsermcp
   pnpm install
   pnpm build
   ```

2. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and pick `apps/extension/.output/chrome-mv3`. It's called "Browser MCP (self-built)". If the Chrome Web Store's Browser MCP is installed in the same profile, turn it off, since only one of them can use the server at a time.
3. In your AI app's MCP config, run the server you built instead of the one on npm:

   ```json
   {
     "mcpServers": {
       "browsermcp": {
         "command": "node",
         "args": ["/path/to/browsermcp/packages/mcp/dist/index.js"]
       }
     }
   }
   ```

   `npx @browsermcp/mcp@latest` (the docs' setup) works with this extension too: it's the same server, published from this repo.

4. Restart the AI app and ask it to do something in the browser. The first time, the extension's popup asks you to **Allow** the server on this computer: check that its code matches the one the AI app shows.

Every build of this extension has the same ID (`imlplcjlhgpajopdbpbngiadkcmdbgob`, from the `key` in `apps/extension/extension-key.ts`), which the server accepts besides the Chrome Web Store's. A build with another key needs its ID in `BROWSER_MCP_EXTENSION_IDS` (comma-separated) in the server's environment, or on a line of `~/.browsermcp/dev-extension-ids`.

## Updating

Only for a self-built extension: the Chrome Web Store version updates itself.

```sh
git pull
pnpm install
pnpm build
```

Then click the reload button on "Browser MCP (self-built)" in `chrome://extensions`, and restart your AI apps if they run the server from this folder. The extension and the server tell you when the other side is too old for them.

## Development

- `pnpm lint`, `pnpm format` (`pnpm format:fix` fixes it): Oxlint and Oxfmt.
- `pnpm typecheck`, `pnpm test`: TypeScript and the unit tests (Vitest) of every package. The server's tests run Playwright's Chromium: install it once with `pnpm --filter @browsermcp/mcp exec playwright-core install chromium`.
- `pnpm smoke`: builds the extension in development mode and the server, loads the extension in headless Chromium and drives it through the server as an AI app would, on random ports and a temporary `BROWSER_MCP_HOME`, so it never touches your own Browser MCP. Screenshots go to `apps/extension/.output/smoke/`.
- `pnpm --filter @browsermcp/extension build:dev`: a development build (`apps/extension/.output/chrome-mv3-dev`).

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to report bugs and send changes, and [SECURITY.md](SECURITY.md) to report a vulnerability privately.

## License

[Apache-2.0](LICENSE). Building it for yourself or your team is fine, and so is saying that your tool is compatible with Browser MCP or built on its code. If you publish a modified extension or server (to a browser extension store, npm or anywhere else others install it from), please give it another name and icon, and don't present it as the official Browser MCP or as endorsed by it, so people can tell the two apart. Keep the LICENSE and say what you changed.
