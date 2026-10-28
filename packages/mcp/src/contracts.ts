/**
 * The interfaces between the daemon's layers:
 *
 * ```
 * AI app ──stdio──▶ thin process (src/thin/) ──ws /client──▶ daemon (src/daemon/)
 *                                                              ├─ command engine (src/commands/, src/tools/) ── uses a BrowserBackend
 *                                                              └─ relay (src/relay/): HTTP + WS server, the extension connection and the CDP bridge,
 *                                                                 which together implement BrowserBackend for the engine
 * ```
 *
 * The extension's side of the relay protocol is `@browsermcp/protocol`.
 */
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { CDPSession, Page } from "playwright-core";

import type { AppInfo, ExposedTab } from "@browsermcp/protocol";

export type { AppInfo, ExposedTab };

// --- Daemon ↔ thin process (`WS /client?token=`) ---

/** Bumped on breaking changes between the thin process and the daemon. A thin process newer than the daemon replaces it (`POST /shutdown`) */
export const CLIENT_PROTOCOL_VERSION = 1;

/** `~/.browsermcp/identity.json` (0600): the daemon's ECDSA P-256 key pair (`PAIRING_KEY_ALGORITHM` in `@browsermcp/protocol`), made on first start and kept across restarts and updates, so the extension's pairing survives them. Separate from `daemon.json`, which is rewritten on each start */
export type DaemonIdentity = {
  /** Base64 SPKI (DER) */
  publicKey: string;
  /** PKCS #8 PEM */
  privateKey: string;
};

/** `~/.browsermcp/daemon.json` (directory 0700, file 0600), written by the daemon once it listens */
export type DaemonInfo = {
  port: number;
  pid: number;
  /** The daemon's package version */
  version: string;
  /** Required on `/client`, `/cdp` and `/shutdown` */
  token: string;
};

/** Optional capabilities an AI app turns on with `--caps <list>`, per session */
export type Capability = "cdp";

/** Sent by the thin process right after connecting */
export type ClientHello = {
  type: "hello";
  protocol: number;
  /** The thin process's package version */
  version: string;
  /** The MCP client (`initialize`'s `clientInfo`), which names the session's app and tab group */
  client: { name: string; title?: string; version?: string };
  capabilities: Capability[];
  pid: number;
  /** The thin process's `BROWSER_MCP_EXTENSION_IDS`: the daemon allows these extensions on `/extension` too, so a changed MCP config doesn't need the daemon restarted. Whoever holds the token already controls the browser */
  extensionIds?: string[];
};

export type DaemonWelcome = {
  type: "welcome";
  protocol: number;
  version: string;
  sessionId: string;
};

/**
 * After hello/welcome, both sides send JSON-RPC-style frames: `{ id, method, params }` requests and `{ id, result }` / `{ id, error: { message } }` responses. Either side may send requests.
 */
export type ClientToDaemonMethods = {
  /** The tool definitions, from the daemon, so every thin process sees the newest tools */
  "tools/list": { params: Record<string, never>; result: { tools: Tool[] } };
  "tools/call": {
    params: { name: string; arguments?: Record<string, unknown> };
    result: CallToolResult;
  };
};

/** The daemon asks the thin process to touch files, since the thin process runs where the AI app does (and its paths are the AI app's) */
export type DaemonToClientMethods = {
  /** For `upload`: reads a file anywhere on the machine. `~` is the home directory, and relative paths resolve against the first of the AI app's MCP roots (`roots/list`, or the working directory when the client has none) */
  readFile: {
    params: { path: string };
    result: { name: string; mimeType: string; base64: string };
  };
  /** For `screenshot --path`: writes a file (paths as for `readFile`) and returns its absolute path */
  writeFile: {
    params: { path: string; base64: string };
    result: { path: string };
  };
};

export type RpcRequest = { id: number; method: string; params?: unknown };
export type RpcResponse =
  | { id: number; result: unknown }
  | { id: number; error: { message: string } };

// --- Command engine ↔ relay (in the daemon) ---

/** What the command engine needs from the browser, implemented by the relay (extension connection + CDP bridge + Playwright `connectOverCDP`), and in tests by a launched Chromium */
export interface BrowserBackend {
  /** Whether an extension is connected (and speaks our protocol) */
  readonly connected: boolean;
  /** A message for the model when no usable extension is connected, else null: `NO_EXTENSION_MESSAGE`, `pairingRequiredMessage(code)` while the extension waits for **Allow**, another browser… */
  unavailableReason(): string | null;
  /** Waits briefly for the extension when it's expected any moment: right after the daemon started or the extension disconnected (it reconnects within seconds), or right after it connected, until it reports its state. Resolves at once otherwise. Call it before `unavailableReason()` */
  whenReady?(): Promise<void>;
  /** The user pressed Stop (or Cancel on the debugging bar) */
  readonly paused: boolean;
  /** The tabs the extension reports */
  tabs(): ExposedTab[];

  /** Opens a background tab in the app's group. Doesn't attach the debugger */
  createTab(options: { url?: string; app: AppInfo }): Promise<number>;
  closeTab(tabId: number): Promise<void>;
  activateTab(tabId: number): Promise<void>;
  /** Puts a tab in the app's group, or out of any with `null` */
  groupTab(tabId: number, app: AppInfo | null): Promise<void>;
  /** Reports which app acted last (the badge's color) */
  noteActivity(appId: string): void;

  /**
   * Claims the tab: attaches the debugger (if needed), announces it to Playwright as a target, and returns its Page. Idempotent. Only claimed tabs are CDP targets (decision 6)
   */
  page(tabId: number): Promise<Page>;
  /** A raw CDP session of its own on a claimed tab, for `cdp` (`--caps cdp`). Domain enables are counted per session, so disabling one here doesn't break Playwright's session */
  cdpSession(tabId: number): Promise<CDPSession>;
  /** Releases a claimed tab: Playwright sees it detach, and the debugger detaches. The tab stays open */
  release(tabId: number): Promise<void>;
  isClaimed(tabId: number): boolean;

  on<E extends keyof BackendEvents>(
    event: E,
    listener: (data: BackendEvents[E]) => void,
  ): () => void;
}

export type BackendEvents = {
  /** The tab list or `paused` changed */
  state: { tabs: ExposedTab[]; paused: boolean; pairing: "paired" | "pending" };
  /** The user dragged a tab into an app's group, or out of it */
  tabAssigned: { tabId: number; appId: string | null };
  /** A page opened a tab */
  tabOpened: { tabId: number; openerTabId: number; url: string };
  /** A claimed tab was released by something other than `release()` (the tab closed, the debugger detached, the extension disconnected, Stop) */
  released: { tabId: number; reason: string };
  /** The extension connected or disconnected */
  connection: { connected: boolean };
};

/** A session: one thin process (one AI app's MCP server) */
export type SessionInfo = {
  id: string;
  app: AppInfo;
  capabilities: Capability[];
  /** Reverse calls to the session's thin process */
  io: SessionIO;
};

export interface SessionIO {
  readFile(
    path: string,
  ): Promise<{ name: string; mimeType: string; buffer: Buffer }>;
  writeFile(path: string, data: Buffer): Promise<string>;
}

/** The `browser` tool and its sessions. Created once per daemon */
export interface CommandEngine {
  /** The MCP tool definitions (just `browser`), for the session's capabilities */
  tools(sessionId: string): Tool[];
  /** The MCP server's `instructions` */
  instructions(): string;
  openSession(session: SessionInfo): void;
  /** Ends a session: releases its tabs (they stay open) */
  closeSession(sessionId: string): Promise<void>;
  callTool(
    sessionId: string,
    name: string,
    args: Record<string, unknown> | undefined,
  ): Promise<CallToolResult>;
  /** Whether any call is in flight (a newer thin process waits for none before replacing the daemon) */
  busy(): boolean;
}

export type CreateCommandEngine = (options: {
  backend: BrowserBackend;
  /** Releases claimed tabs idle this long (10 minutes by default) */
  idleReleaseMs?: number;
  log?: (...args: unknown[]) => void;
}) => CommandEngine;
