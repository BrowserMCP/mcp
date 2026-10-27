# Browser MCP server (`@browsermcp/mcp`)

The MCP server AI apps run (`npx @browsermcp/mcp@latest`). It drives the user's Chrome through the Browser MCP extension, with one `browser` tool.

## Quick start

Browser MCP lets AI apps such as Claude Code, Cursor and VS Code use your browser, logged in where you are, in tabs of their own. You need Chrome (or Edge or Brave) and Node.js 20 or later.

1. Install the [Browser MCP extension](https://browsermcp.io/install) and pin it to the toolbar.
2. Add the server to your AI app, and restart the app. In Claude Code: `claude mcp add --scope user browsermcp -- npx @browsermcp/mcp@latest`. Most other apps, such as Cursor and Claude Desktop, take this (VS Code's format differs; see the docs below):

   ```json
   {
     "mcpServers": {
       "browsermcp": {
         "command": "npx",
         "args": ["@browsermcp/mcp@latest"]
       }
     }
   }
   ```

3. Ask the agent to open a page. The first time, it tells you to click **Allow** in the extension's popup: check that the popup's six-digit code matches the agent's, click **Allow**, and ask the agent to try again.

Steps for each AI app, and troubleshooting: [browsermcp.io/docs](https://browsermcp.io/docs). The rest of this README is for developing the server.

## Architecture

```
AI app ──stdio──▶ thin process (dist/index.js, one per AI app)          src/thin/
                    │ starts the daemon if needed; forwards tools/list and tools/call
                    ▼ ws://127.0.0.1:<port>/client?token=…   (token from ~/.browsermcp/daemon.json)
                 daemon (dist/daemon.js, one per user)                  src/daemon/
                    ├─ command engine: the browser tool                 src/commands/, src/tools/
                    │    └─ BrowserBackend (src/contracts.ts) ─▶ Playwright connectOverCDP
                    │                                             ▼ ws://127.0.0.1:<port>/cdp?token=…
                    ├─ CDP bridge: fakes Browser.* / Target.*           src/relay/bridge.ts
                    │                                             ▼ ws://127.0.0.1:<port>/extension
                    └─ extension connection (one browser at a time)     src/relay/extension-connection.ts
                                                     MV3 service worker ── chrome.debugger
```

- **Ports:** the daemon binds the first free port of 9010, 9011 and 9012 (`RELAY_PORTS`), skipping ports other programs hold. A port counts as our daemon's (so a new daemon exits and the thin processes use it) only when `daemon.json` names its port and the pid its `/browsermcp/status` reports, and its token opens `/client`; another program answering `/status` as `browsermcp` is skipped like any other. Nothing of ours uses 9009, where 0.1.x servers kill whatever listens. `--port <n>` (on the thin process, passed to the daemon) uses one port, with `daemon-<n>.json` and `daemon-<n>.log`.
- **`~/.browsermcp/`** (0700; `BROWSER_MCP_HOME` overrides it): `daemon.json` (port, pid, version, token; 0600), `identity.json` (the pairing key; 0600, kept across restarts; written to a temp file and hard-linked into place, so daemons starting at once agree on one key), `daemon.starting.json` (written by a thin process starting or replacing the daemon, with its version) and `daemon.log` (1 MB, one rotation).
- **Relay** (`src/relay/server.ts`): loopback only, with a Host check against DNS rebinding. `GET /browsermcp/status` (CORS for `chrome-extension://`), `WS /extension` (Origin: the Chrome Web Store ID, the self-built extension's ID or `BROWSER_MCP_EXTENSION_IDS`, comma-separated, plus the IDs each thin process sends in `hello`, which the daemon allows while it runs, and the IDs in `~/.browsermcp/dev-extension-ids`, read when an unknown extension connects; `src/relay/extension-ids.ts`), `WS /cdp` and `WS /client` (token, no browser Origin) and `POST /shutdown` (token).
- **Pairing:** the extension's `hello` carries a challenge; `welcome` carries the daemon's public key, a commitment to a fresh nonce for this connection, and its signature of the challenge, the commitment and the port the extension dialed (`pairingPayload()`, `src/daemon/identity.ts`), so a program on another port can't relay the challenge to the daemon. For a key it hasn't paired with, the extension sends a nonce of its own (`pairingNonce`), the daemon reveals its nonce (`pairingReveal`, `src/relay/extension-connection.ts`), and both compute the same six-digit code (`pairingCode()`; see "Pairing" in `@browsermcp/protocol` for why the order makes it safe). Until the user clicks **Allow**, tool calls answer "Click Allow in the Browser MCP extension's popup. The code is 482 913" (without the code for the moment before the extension's nonce arrives).
- **The bridge** announces only claimed tabs as targets (`BrowserBackend.page()` claims; `release()` detaches). It holds `Runtime.enable` until the `Page.getFrameTree` reply is delivered, passes child sessions through, re-attaches after detaches other than `canceled_by_user`, `paused` and `not_allowed`, and counts domain enables per session so a raw `cdp` session can't disable Playwright's. The backend finds each tab's Page by target ID.
- **Hidden tabs** (`src/commands/hidden-tabs.ts`, from `spikes/hidden-tabs/RESULTS.md`): agents' tabs are background tabs, which Chrome doesn't render. Playwright connects with `noDefaults: true`, so its overrides stay off the user's tabs, and the engine turns on `Emulation.setFocusEmulationEnabled` for each tab it claims. Before mouse and keyboard input and screenshots it checks `document.visibilityState`, turns emulation on again if needed, and otherwise fails: input sent to a hidden tab hangs and lands later, and its screenshots are blank.
- **Reconnecting:** right after the daemon starts or the extension disconnects (a service worker restart), a call waits up to 10 s for the extension to come back, and sessions keep their tabs meanwhile.
- **Several browsers** (`src/relay/backend.ts`): one connection at a time. A newcomer replaces the current browser unless that one answers a ping and is in use (a claimed tab, or, while a session is open, an open tab agents opened, selected or claimed there) or is the browser that replaced the newcomer, which keeps retrying: so two browsers don't take turns, a replaced browser gets the connection back only once the other one goes away. Browsers are told apart by user agent and window IDs. Tab IDs belong to the connected browser: `page()` refuses tabs it doesn't report, and tab IDs agents used in a browser another one replaced, until an agent selects them again (`groupTab`).
- **Timeouts:** requests to the extension 30 s (`cdp` 5 min, since Playwright times those itself), RPC between the thin process and the daemon 30 s, and `tools/call` 5 min in the daemon (the thin process waits 30 s more); the thin process waits 10 s for `welcome`.
- **Versions:** a thin process newer than the daemon asks it to exit (`POST /shutdown`, answered once no call is in flight) and starts its own; an older one uses the newer daemon, and while `daemon.starting.json` says a newer one is starting (for 15 s), waits for it rather than start its own. The daemon exits 10 minutes after its last session leaves; thin processes start a new one on their next call.
- **Files:** the daemon asks the thin process to read uploads and write screenshots, only under the AI app's MCP roots (its working directory when the client has none). Roots that would allow everything (`/`, the home directory or a parent of it) are ignored; with none left, file access is refused with a message to run the AI app in a project directory or use one with MCP roots. Symlinks are followed only to where they lead within the roots; dangling ones are refused, and I/O uses the checked real path (`O_NOFOLLOW`).

## Development

- `pnpm build` builds `dist/index.js` (the `bin`) and `dist/daemon.js`; `pnpm watch` rebuilds on changes.
- Run by hand: `node dist/index.js --port 9333` in an MCP client (or the inspector below), with the extension's port set to 9333. `node dist/daemon.js --port 9333 --stderr` runs a daemon in the foreground. Use `BROWSER_MCP_HOME=$(mktemp -d)` to keep it apart from your real daemon.
- A dev build of the extension has its own ID per checkout: put the ID on a line of `~/.browsermcp/dev-extension-ids` (`#` starts a comment; the daemon reads the file when an unknown extension connects, so nothing needs restarting), or set `BROWSER_MCP_EXTENSION_IDS=<id>` in the AI app's MCP config and reconnect the MCP server (the thin process sends it to a running daemon). When the daemon refuses an extension, tool calls name its ID and this variable. For a daemon you start by hand, set the variable on it.

### Inspector

- The client UI runs on port 9001 (the default of 5173 conflicts with the extension's Vite server)
- The MCP proxy server runs on port 9002 (the default of 3000 conflicts with the `marketing` app)

1. Run `pnpm build` or `pnpm watch` to build `dist/`
2. Run `pnpm inspector` to start the inspector
3. Navigate to `http://localhost:9001?proxyPort=9002` to open the inspector UI
4. Click the `Connect` button to run `dist/index.js` and start the MCP server

## Testing

`pnpm test` (Vitest). Tests never use ports 9009–9012 or `~/.browsermcp`: they take random ports and a temp `BROWSER_MCP_HOME`, and stop only the daemons they started.

- `src/relay/server.test.ts`, `bridge.test.ts`: the endpoints and checks, and the bridge with an in-memory extension and CDP client.
- `src/relay/backend.test.ts`, `integration.test.ts`: real Playwright through the bridge, with real headless Chromium standing in for the extension (pairing, one browser at a time, iframes, release and re-claim, a raw CDP session, Stop and Cancel, disconnects).
- `src/daemon/daemon.test.ts`, `src/thin/*.test.ts`: the daemon in-process and as real processes (started on demand, two thin processes at once, version replacement, idle exit, a killed daemon, ports held by other programs, MCP roots).
- End to end, with the real extension: `pnpm --filter @browsermcp/extension smoke` (`@browsermcp/extension`'s `scripts/smoke-browser-control.ts`), which builds this package and runs `dist/index.js` over stdio.

Helpers in `src/testing/` for other tests:

- `FakeChromium.launch()` and `FakeExtension.connect({ port, chromium, pairing? })` (`fake-extension.ts`): headless Chromium driven over a raw CDP socket, speaking the extension's protocol (`attach`, `cdp` with child sessions, `createTab`, `groupTab`…; events, state, `tabOpened`), plus the user's actions: `openTab()`, `allow()`, `pause()`, `cancel()`, `assign()`, `disconnect()`. `verifyWelcome()` checks the daemon's signature with WebCrypto, against the port it dialed (`port`). With `pairing: "pending"` it exchanges nonces with the daemon and sets `code`, the code the popup would show (`pairingNonce: false` stays without one; `exchangePairingNonces()` does it later). `userAgent` tells fake browsers apart, and `answering = false` makes it ignore pings and requests, like a stuck service worker.
- `startTestBackend()` (`test-backend.ts`): a relay and `RelayBackend` on a random port, a `BrowserBackend` for engine tests.
- `startFixtureServer(pages)` (`fixture-server.ts`): test pages on `127.0.0.1` and, for cross-site iframes, `localhost`.
- `createStubEngine` and the stub daemon (`stub-engine.ts`, `stub-daemon.ts`, built by `global-setup.ts` and passed to tests as `inject("stubDaemon")`).

## Releases

Browser MCP's maintainers release `@browsermcp/mcp` to npm. To run a build of your own instead, see "Build it yourself" in the repository's README.
