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
                    │    └─ BrowserBackend (src/contracts.ts): public tab IDs   src/relay/backend.ts
                    └─ a slot per browser (Chrome profile), up to 8     src/relay/browser-slot.ts
                         ├─ Playwright connectOverCDP
                         │        ▼ ws://127.0.0.1:<port>/cdp?token=…&browser=<slot id>
                         ├─ CDP bridge: fakes Browser.* / Target.*      src/relay/bridge.ts
                         └─ extension connection                        src/relay/extension-connection.ts
                                  ▲ ws://127.0.0.1:<port>/extension
                         MV3 service worker ── chrome.debugger (one per profile)
```

- **Ports:** the daemon binds the first free port of 9010, 9011 and 9012 (`RELAY_PORTS`), skipping ports other programs hold. A port counts as our daemon's (so a new daemon exits and the thin processes use it) only when `daemon.json` names its port and the pid its `/browsermcp/status` reports, and its token opens `/client`; another program answering `/status` as `browsermcp` is skipped like any other. Nothing of ours uses 9009, where 0.1.x servers kill whatever listens. `--port <n>` (on the thin process, passed to the daemon) uses one port, with `daemon-<n>.json` and `daemon-<n>.log`.
- **`~/.browsermcp/`** (0700; `BROWSER_MCP_HOME` overrides it): `daemon.json` (port, pid, version, token; 0600), `identity.json` (the pairing key; 0600, kept across restarts; written to a temp file and hard-linked into place, so daemons starting at once agree on one key), `daemon.starting.json` (written by a thin process starting or replacing the daemon, with its version) and `daemon.log` (1 MB, one rotation).
- **Relay** (`src/relay/server.ts`): loopback only, with a Host check against DNS rebinding. `GET /browsermcp/status` (CORS for `chrome-extension://`), `WS /extension` (Origin: the Chrome Web Store ID, the self-built extension's ID or `BROWSER_MCP_EXTENSION_IDS`, comma-separated, plus the IDs each thin process sends in `hello`, which the daemon allows while it runs, and the IDs in `~/.browsermcp/dev-extension-ids`, read when an unknown extension connects; `src/relay/extension-ids.ts`), `WS /cdp` and `WS /client` (token, no browser Origin) and `POST /shutdown` (token).
- **Pairing:** the extension's `hello` carries a challenge; `welcome` carries the daemon's public key, a commitment to a fresh nonce for this connection, and its signature of the challenge, the commitment and the port the extension dialed (`pairingPayload()`, `src/daemon/identity.ts`), so a program on another port can't relay the challenge to the daemon. For a key it hasn't paired with, the extension sends a nonce of its own (`pairingNonce`), the daemon reveals its nonce (`pairingReveal`, `src/relay/extension-connection.ts`), and both compute the same six-digit code (`pairingCode()`; see "Pairing" in `@browsermcp/protocol` for why the order makes it safe). Until the user clicks **Allow**, tool calls answer "Click Allow in the Browser MCP extension's popup. The code is 482 913" (without the code for the moment before the extension's nonce arrives).
- **The bridge** announces only claimed tabs as targets (`BrowserBackend.page()` claims; `release()` detaches). It holds `Runtime.enable` until the `Page.getFrameTree` reply is delivered, passes child sessions through, re-attaches after detaches other than `canceled_by_user`, `paused` and `not_allowed`, and counts domain enables per session so a raw `cdp` session can't disable Playwright's. The backend finds each tab's Page by target ID.
- **Hidden tabs** (`src/commands/hidden-tabs.ts`, from `spikes/hidden-tabs/RESULTS.md`): agents' tabs are background tabs, which Chrome doesn't render. Playwright connects with `noDefaults: true`, so its overrides stay off the user's tabs, and the engine turns on `Emulation.setFocusEmulationEnabled` for each tab it claims. Before mouse and keyboard input and screenshots it checks `document.visibilityState`, turns emulation on again if needed, and otherwise fails: input sent to a hidden tab hangs and lands later, and its screenshots are blank.
- **Reconnecting:** right after the daemon starts or a browser disconnects (a service worker restart), a call waits up to 10 s for it to come back (a call on another browser's tab doesn't wait), and sessions keep their tabs meanwhile.
- **Several browsers** (`src/relay/backend.ts`, `browser-slot.ts`): the daemon connects up to `MAX_BROWSERS` (8) browsers (Chrome profiles) at once and refuses one more with `anotherBrowser`. Each gets a slot of its own: its extension connection, its CDP bridge (a bridge's state is keyed by Chrome's tab IDs, and browser-level CDP commands go through one of its tabs, so a bridge serves one browser) and its Playwright connection (`/cdp?browser=<slot id>`). A slot outlives its connection: a browser that reconnects lands in its old one, told apart by `hello.browserId` (a random ID the extension keeps per profile) or, from extensions that send none (2.2), by user agent and window IDs: such a connection takes the slot of the browser like it that left last, and its first paired `state` confirms that, or moves it to the slot whose windows it reports. A browser whose old connection is still open gets its slot back only when that one doesn't answer a ping; one that does (a copied profile with the same `browserId`) keeps it, and the newcomer is refused. The daemon remembers up to 16 browsers, forgetting the one away longest. Chrome's tab IDs mean something only within one browser (separate Chrome processes number theirs from 1), so the backend issues the IDs agents see: a tab keeps Chrome's ID unless another browser's tab has that number, when it gets a spare one above 100000, and keeps it across its browser's reconnects, unless that tab shows another URL when the browser is back than when it left: Chrome numbers tabs anew when it restarts, so the old ID is retired (it fails as a closed tab's) rather than name another tab. An ID of a browser that's away fails with "<label> disconnected" and never names another browser's tab. Each browser is named by the label the user gave it in the popup (`state.label`, sent only to a paired daemon), else `Chrome`, `Chrome 2`… by the daemon. Pairing, Stop, activity and releases are per browser: one waiting for **Allow** doesn't stop agents using another, and `unavailableReason()` speaks only when none is usable. New tabs open, per session, in the browser of the tab the session last selected or opened, or the one it chose with `browser use` since, else the usable browser whose window had focus last (`state.lastFocusedAt`), else the one that connected last; `tab new --browser <label|id>` opens one elsewhere. With one browser connected, agents see nothing of this: outputs and the tool's definition are the same, and `browser` isn't listed by `help`. With several, `tab list` names each tab's browser (and ends with a line about `browser list`), and errors about one browser start with its label.
- **Timeouts:** requests to the extension 30 s (`cdp` 5 min, since Playwright times those itself), RPC between the thin process and the daemon 30 s, and `tools/call` 5 min in the daemon (the thin process waits 30 s more); the thin process waits 10 s for `welcome`.
- **Versions:** a thin process newer than the daemon asks it to exit (`POST /shutdown`, answered once no call is in flight) and starts its own; an older one uses the newer daemon, and while `daemon.starting.json` says a newer one is starting (for 15 s), waits for it rather than start its own. The daemon exits 10 minutes after its last session leaves; thin processes start a new one on their next call.
- **Files:** the daemon asks the thin process to read uploads and write screenshots. Any path on the machine works, with the permissions of the user running the AI app: `~` is the home directory, and relative paths resolve against the first of the AI app's MCP roots (its working directory when the client has none). Nothing limits which files a page-injected agent could upload, or which files `screenshot --path` could overwrite, so treat pages you let agents browse as able to read any file the user can read and overwrite any file the user can write.

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
- `src/relay/backend.test.ts`, `integration.test.ts`: real Playwright through the bridge, with real headless Chromium standing in for the extension (pairing, several browsers at once, iframes, release and re-claim, a raw CDP session, Stop and Cancel, disconnects).
- `src/daemon/daemon.test.ts`, `src/thin/*.test.ts`: the daemon in-process and as real processes (started on demand, two thin processes at once, version replacement, idle exit, a killed daemon, ports held by other programs, relative file paths and MCP roots).
- End to end, with the real extension: `pnpm --filter @browsermcp/extension smoke` (`@browsermcp/extension`'s `scripts/smoke-browser-control.ts`), which builds this package and runs `dist/index.js` over stdio.

Helpers in `src/testing/` for other tests:

- `FakeChromium.launch()` and `FakeExtension.connect({ port, chromium, pairing? })` (`fake-extension.ts`): headless Chromium driven over a raw CDP socket, speaking the extension's protocol (`attach`, `cdp` with child sessions, `createTab`, `groupTab`…; events, state, `tabOpened`), plus the user's actions: `openTab()`, `allow()`, `pause()`, `cancel()`, `assign()`, `disconnect()`. `verifyWelcome()` checks the daemon's signature with WebCrypto, against the port it dialed (`port`). With `pairing: "pending"` it exchanges nonces with the daemon and sets `code`, the code the popup would show (`pairingNonce: false` stays without one; `exchangePairingNonces()` does it later). `userAgent`, `windowId` and `browserId` tell fake browsers apart (launch a `FakeChromium` per browser for colliding tab IDs, as separate Chrome processes have), `label` and `setLabel()`/`focus()` send the popup's label and focus, and `answering = false` makes it ignore pings and requests, like a stuck service worker.
- `startTestBackend()` (`test-backend.ts`): a relay and `RelayBackend` on a random port, a `BrowserBackend` for engine tests.
- `startFixtureServer(pages)` (`fixture-server.ts`): test pages on `127.0.0.1` and, for cross-site iframes, `localhost`.
- `createStubEngine` and the stub daemon (`stub-engine.ts`, `stub-daemon.ts`, built by `global-setup.ts` and passed to tests as `inject("stubDaemon")`).

## Releases

Browser MCP's maintainers release `@browsermcp/mcp` to npm. To run a build of your own instead, see "Build it yourself" in the repository's README.
