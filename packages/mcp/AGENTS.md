# AGENTS.md (`@browsermcp/mcp`)

`@browsermcp/mcp`, published to npm and bundled with tsup. See the README for the architecture.

## Layers

- `src/thin/`: the thin process (`dist/index.js`), one per AI app: an MCP stdio server that forwards `tools/list` and `tools/call` to the daemon, starting or replacing it as needed, and answers the daemon's file requests within the MCP roots. Keep it light: it must not import the relay, Playwright or the engine (only `src/commands/instructions.ts`).
- `src/daemon/`: the daemon process (`dist/daemon.js`): ports, `daemon.json`, `identity.json`, sessions over `/client`, idle exit, `/shutdown`, the log. `src/daemon/main.ts` is the only importer of the command engine, so everything else is tested with `src/testing/stub-engine.ts`.
- `src/relay/`: the HTTP/WS server, the extension connection, the CDP bridge and `RelayBackend` (the `BrowserBackend` the engine uses). User-facing messages live in `src/relay/messages.ts` and `@browsermcp/protocol`.
- `src/commands/`, `src/tools/`: the command engine and the `browser` tool.
- The interfaces between the layers are in `src/contracts.ts`; the extension protocol is `@browsermcp/protocol`, shared with the extension's browser control (`@browsermcp/extension-core`). Change them only together with both sides.

## Conventions

- The thin process logs to stderr (stdout is MCP); the daemon to its log file.
- Call `backend.page(tabId)` for each use rather than caching Pages: a re-attach replaces a tab's Page.
- Tests: Vitest, next to the code. Never bind or connect to ports 9009–9012 or touch `~/.browsermcp`: use random ports, `--port` and a temp `BROWSER_MCP_HOME`, and stop only processes the test started. Use the helpers in `src/testing/` (README, "Testing").
