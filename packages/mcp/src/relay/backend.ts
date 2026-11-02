import type { CDPSession, Page } from "playwright-core";
import type { WebSocket } from "ws";

import {
  NO_EXTENSION_MESSAGE,
  RelayCloseCode,
  RelayUpdateReason,
  pairingRequiredMessage,
} from "@browsermcp/protocol";

import type {
  AppInfo,
  BackendEvents,
  BrowserBackend,
  ExposedTab,
} from "@/contracts";
import { BrowserSlot } from "@/relay/browser-slot";
import {
  ExtensionConnection,
  type ExtensionConnectionOptions,
  ExtensionProtocolError,
} from "@/relay/extension-connection";
import {
  ANOTHER_BROWSER_MESSAGE,
  noSuchTabMessage,
  PAUSED_MESSAGE,
  TAB_DETACHED_MESSAGE,
  UPDATE_EXTENSION_MESSAGE,
  UPDATE_SERVER_MESSAGE,
  rejectedExtensionMessage,
} from "@/relay/messages";
import type { Logger } from "@/utils/log";

export type RelayBackendOptions = Omit<
  ExtensionConnectionOptions,
  "log" | "daemonVersion" | "port"
> & {
  daemonVersion: string;
  log: Logger;
  /** Whether any session (thin process) is open: tabs agents used count as in use only while one is. Default: always */
  hasSessions?: () => boolean;
  /** How long `page()` waits for Playwright to see a claimed tab */
  pageTimeoutMs?: number;
  /** How long a contender waits for the current browser's pong before replacing it */
  replacePingTimeoutMs?: number;
  /** How long after the daemon starts, or the extension disconnects, `whenReady()` waits for the extension to (re)connect. The extension retries every 1–5 s */
  reconnectGraceMs?: number;
  reattachDelayMs?: number;
  /** How long `findTab()` and `page()` wait for the extension to report a tab it doesn't list yet (1 s) */
  unknownTabWaitMs?: number;
};

type Listeners = {
  [E in keyof BackendEvents]: Set<(data: BackendEvents[E]) => void>;
};

/** What tells browsers apart: the user agent, and the windows they report (window IDs are unique within a browser process, across its profiles) */
type BrowserIdentity = {
  name: string;
  userAgent: string;
  windowIds: Set<number>;
};

function browserOf(connection: ExtensionConnection): BrowserIdentity {
  return {
    name: connection.hello.browser.name,
    userAgent: connection.hello.browser.userAgent,
    windowIds: new Set(connection.state.tabs.map((tab) => tab.windowId)),
  };
}

/** Whether two connections come from the same browser, or `undefined` when that can't be told (one reports no tabs, e.g. while it waits for **Allow**) */
function sameBrowser(
  a: BrowserIdentity,
  b: BrowserIdentity,
): boolean | undefined {
  if (a.name !== b.name || a.userAgent !== b.userAgent) {
    return false;
  }
  if (a.windowIds.size === 0 || b.windowIds.size === 0) {
    return undefined;
  }
  return [...a.windowIds].some((id) => b.windowIds.has(id));
}

/** How long a refused extension is named in `unavailableReason()`: it retries every 1–5 s */
const REJECTED_EXTENSION_MS = 30_000;

/**
 * `BrowserBackend` over the relay: one browser at a time, in a `BrowserSlot` (its extension connection, its CDP bridge, and Playwright's `connectOverCDP` to the bridge's `/cdp?browser=<id>`). Pages are found by target ID: each new Page's target ID is read once through a short-lived CDP session
 */
export class RelayBackend implements BrowserBackend {
  private readonly slot: BrowserSlot;
  /** Why the last extension couldn't connect, for `unavailableReason()` */
  private lastProblem: "update-extension" | "update-server" | null = null;
  /** The last extension `/extension` refused by Origin, until one connects: `unavailableReason()` names it, since the extension only retries */
  private rejectedExtension: { id: string | undefined; at: number } | null =
    null;
  private cdpUrl: string | null = null;
  /** When the daemon started or the extension last disconnected: the extension is expected back soon after */
  private expectedSince = Date.now();
  private closing = false;
  /** Tab IDs agents used in a browser that another one replaced: here, the same IDs are other tabs, so they're refused until an agent selects them again in this browser */
  private foreignTabs = new Set<number>();
  /** The last browser, once it disconnected, to tell whether the next one is the same (its service worker restarted) or another */
  private previous: {
    browser: BrowserIdentity;
    agentTabs: Set<number>;
    foreignTabs: Set<number>;
    replaced: boolean;
  } | null = null;
  /** Browsers that another one replaced. They keep retrying, and must not take the connection back while the current one is alive, or two browsers would take turns */
  private displaced: BrowserIdentity[] = [];
  private readonly listeners = {
    state: new Set(),
    tabAssigned: new Set(),
    tabOpened: new Set(),
    released: new Set(),
    connection: new Set(),
  } as Listeners;

  constructor(private readonly options: RelayBackendOptions) {
    const id = "b1";
    this.slot = new BrowserSlot(id, {
      log: options.log,
      cdpUrl: () => (this.cdpUrl ? `${this.cdpUrl}&browser=${id}` : null),
      onReleased: (tabId, reason) => this.emit("released", { tabId, reason }),
      reattachDelayMs: options.reattachDelayMs,
      pageTimeoutMs: options.pageTimeoutMs,
    });
  }

  /** Where Playwright connects: the relay's `/cdp?token=…`, known once the relay listens. Each browser's Playwright adds `&browser=<id>` */
  setCdpUrl(url: string) {
    this.cdpUrl = url;
  }

  /** The connected browser's extension connection */
  private get extension(): ExtensionConnection | null {
    return this.slot.connection;
  }

  // --- Connections from the relay server ---

  /**
   * An extension on `/extension` (`port`: the port it dialed): hello/welcome, then it becomes the browser, replacing the current one unless that one is alive and either in use or the browser that replaced this one (which keeps retrying)
   */
  async acceptExtension(ws: WebSocket, port: number): Promise<void> {
    const { log } = this.options;
    this.rejectedExtension = null;
    let connection: ExtensionConnection;
    try {
      connection = await ExtensionConnection.accept(ws, {
        ...this.options,
        log,
        port,
      });
    } catch (error) {
      if (error instanceof ExtensionProtocolError) {
        this.lastProblem = "update-extension";
      }
      log("Extension handshake failed:", error);
      return;
    }

    for (;;) {
      if (this.closing) {
        connection.close(RelayCloseCode.shuttingDown, "The daemon is exiting");
        return;
      }
      if (!connection.open) {
        return;
      }
      const current = this.extension;
      if (!current?.open) {
        break;
      }
      const browser = browserOf(connection);
      const reason = this.inUse()
        ? "an agent is using a tab in this one"
        : this.displaced.some((other) => sameBrowser(other, browser) ?? true)
          ? "this one replaced it"
          : null;
      if (!reason) {
        log("Another browser connected and replaces the current one");
        this.displace(current);
        break;
      }
      const alive = await current.ping(
        this.options.replacePingTimeoutMs ?? 3000,
      );
      // Things changed while waiting for the pong (the contender left, the current one closed, or another took over): decide again
      if (this.extension !== current || !connection.open || this.closing) {
        continue;
      }
      if (alive) {
        log(`Refused another browser: ${reason}`);
        connection.close(
          RelayCloseCode.anotherBrowser,
          "Another browser is connected to Browser MCP",
        );
        return;
      }
      log("The current browser stopped answering; another one replaces it");
      current.close(
        RelayCloseCode.anotherBrowser,
        "Another browser is connected to Browser MCP",
      );
      break;
    }
    this.adopt(connection);
  }

  /** Closes the current browser for another one, remembering it so its retries don't take the connection back */
  private displace(current: ExtensionConnection) {
    this.displaced = [...this.displaced.slice(-9), browserOf(current)];
    current.close(
      RelayCloseCode.anotherBrowser,
      "Another browser is connected to Browser MCP",
    );
  }

  /** Playwright on `/cdp`, for the browser named by `browser=<id>` (the only one when unnamed) */
  acceptCdp(ws: WebSocket, browserId?: string) {
    if (browserId && browserId !== this.slot.id) {
      ws.close(1008, "No such browser");
      return;
    }
    this.slot.bridge.attachClient(ws);
  }

  private adopt(connection: ExtensionConnection) {
    const { hello } = connection;
    this.options.log(
      `Extension ${hello.extensionVersion} connected from ${hello.browser.name} ${hello.browser.version} (protocol ${hello.protocol}, pairing ${hello.state.pairing})`,
    );
    const browser = browserOf(connection);
    const previous = this.previous;
    this.previous = null;
    // The same browser back (its service worker restarted) keeps its tabs; tab IDs from another browser name other tabs here
    if (
      previous &&
      (sameBrowser(previous.browser, browser) ?? !previous.replaced)
    ) {
      this.slot.agentTabs = previous.agentTabs;
      this.foreignTabs = previous.foreignTabs;
    } else {
      this.slot.agentTabs = new Set();
      this.foreignTabs = previous
        ? new Set([...previous.agentTabs, ...previous.foreignTabs])
        : new Set();
    }
    this.slot.connection = connection;
    this.lastProblem = null;
    this.slot.stateReceived = false;
    connection.onEvent((event) => {
      if (this.extension !== connection) {
        return;
      }
      this.slot.bridge.onExtensionEvent(event);
      switch (event.type) {
        case "state":
          this.slot.stateReceived = true;
          if (event.data.pairing === "paired") {
            const open = new Set(event.data.tabs.map((tab) => tab.tabId));
            for (const tabs of [this.slot.agentTabs, this.foreignTabs]) {
              for (const tabId of tabs) {
                if (!open.has(tabId)) {
                  tabs.delete(tabId);
                }
              }
            }
          }
          this.emit("state", event.data);
          return;
        case "tabAssigned":
          if (event.data.appId) {
            this.slot.agentTabs.add(event.data.tabId);
            this.foreignTabs.delete(event.data.tabId);
          } else {
            this.slot.agentTabs.delete(event.data.tabId);
          }
          this.emit("tabAssigned", event.data);
          return;
        case "tabOpened":
          this.emit("tabOpened", event.data);
          return;
      }
    });
    connection.onClose((code, reason) => {
      this.options.log(`Extension disconnected (${code} ${reason})`);
      if (
        code === RelayCloseCode.unsupportedProtocol &&
        reason === RelayUpdateReason.updateServer
      ) {
        this.lastProblem = "update-server";
      }
      if (this.extension !== connection) {
        return;
      }
      const replaced = code === RelayCloseCode.anotherBrowser;
      this.previous = {
        browser: browserOf(connection),
        agentTabs: this.slot.agentTabs,
        foreignTabs: this.foreignTabs,
        replaced,
      };
      // It went away on its own: a browser it replaced may connect again
      if (!replaced) {
        this.displaced = [];
      }
      this.slot.connection = null;
      this.expectedSince = Date.now();
      this.slot.bridge.releaseAll("disconnected");
      this.emit("connection", { connected: false });
    });
    this.emit("connection", { connected: true });
    this.emit("state", connection.state);
  }

  // --- BrowserBackend ---

  get connected(): boolean {
    return !!this.extension;
  }

  get paused(): boolean {
    return this.extension?.state.paused ?? false;
  }

  /** `/extension` refused a connection by its Origin (`id` is undefined unless it was a `chrome-extension://` ID) */
  noteRejectedExtension(id: string | undefined) {
    this.rejectedExtension = { id, at: Date.now() };
  }

  unavailableReason(): string | null {
    if (!this.extension) {
      if (
        this.rejectedExtension?.id &&
        Date.now() - this.rejectedExtension.at < REJECTED_EXTENSION_MS
      ) {
        return rejectedExtensionMessage(this.rejectedExtension.id);
      }
      if (this.lastProblem === "update-extension") {
        return UPDATE_EXTENSION_MESSAGE;
      }
      if (this.lastProblem === "update-server") {
        return UPDATE_SERVER_MESSAGE;
      }
      return NO_EXTENSION_MESSAGE;
    }
    if (this.extension.state.pairing === "pending") {
      return pairingRequiredMessage(this.extension.pairingCode ?? undefined);
    }
    return null;
  }

  async whenReady(): Promise<void> {
    const connectBy =
      this.expectedSince + (this.options.reconnectGraceMs ?? 10_000);
    // After connecting, the extension sends its state as soon as it checked the daemon's key
    const stateBy = Date.now() + 2000;
    for (;;) {
      if (this.extension) {
        if (this.slot.stateReceived || Date.now() >= stateBy) {
          return;
        }
      } else if (Date.now() >= connectBy) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  /** The connected browser's tabs: their IDs mean nothing in another browser */
  tabs(): ExposedTab[] {
    return this.slot.tabs();
  }

  /** The connected browser's tab with this ID, waiting (briefly) for the extension to report one it doesn't list yet: it reports a new tab a moment after it appears */
  async findTab(tabId: number): Promise<ExposedTab | undefined> {
    const find = () => this.tabs().find((tab) => tab.tabId === tabId);
    if (!find()) {
      await this.waitForTab(tabId, this.options.unknownTabWaitMs ?? 1000);
    }
    return find();
  }

  async createTab(options: { url?: string; app: AppInfo }): Promise<number> {
    const extension = this.usableExtension();
    const { tabId } = await extension.request("createTab", options);
    if (this.extension === extension) {
      this.slot.agentTabs.add(tabId);
      this.foreignTabs.delete(tabId);
    }
    // The extension reports the new tab in its next `state` (debounced), after answering. Until then the engine would take it for a closed tab
    await this.waitForTab(tabId);
    return tabId;
  }

  async closeTab(tabId: number): Promise<void> {
    const extension = this.usableExtension();
    this.refuseForeign(tabId);
    await this.slot.bridge.release(tabId);
    this.slot.agentTabs.delete(tabId);
    await extension.request("closeTab", { tabId });
    // As with `createTab`: until the next `state`, the tab would still be listed
    await this.waitForTab(tabId, 3000, false);
  }

  async activateTab(tabId: number): Promise<void> {
    const extension = this.usableExtension();
    this.refuseForeign(tabId);
    await extension.request("activateTab", { tabId });
  }

  /** Grouping a tab with an app selects it in this browser, so it's no longer taken for another browser's tab */
  async groupTab(tabId: number, app: AppInfo | null): Promise<void> {
    const extension = this.usableExtension();
    await extension.request("groupTab", { tabId, app });
    if (this.extension !== extension) {
      return;
    }
    if (app) {
      this.slot.agentTabs.add(tabId);
      this.foreignTabs.delete(tabId);
    } else {
      this.slot.agentTabs.delete(tabId);
    }
  }

  noteActivity(appId: string): void {
    this.extension?.send("activity", { appId }, () => {});
  }

  /** Claims a tab of the connected browser: one it reports (waiting briefly for a tab it hasn't reported yet), and not a tab ID agents used in a browser it replaced */
  async page(tabId: number): Promise<Page> {
    const extension = this.usableExtension();
    this.refuseForeign(tabId);
    if (!this.tabs().some((tab) => tab.tabId === tabId)) {
      await this.waitForTab(tabId, this.options.unknownTabWaitMs ?? 1000);
      if (this.extension !== extension) {
        throw new Error(ANOTHER_BROWSER_MESSAGE);
      }
      if (!this.tabs().some((tab) => tab.tabId === tabId)) {
        throw new Error(noSuchTabMessage(tabId));
      }
    }
    this.slot.agentTabs.add(tabId);
    // The target can go before Playwright has its Page. Then the bridge either re-attaches it (a navigation that swapped the renderer), so claim it again, or lets it go (it detached again within the cooldown, e.g. another extension putting its frame back), so fail now rather than wait out the timeout
    for (;;) {
      const targetInfo = await this.slot.bridge.claim(tabId);
      const gone = this.slot.bridge.whenGone(tabId);
      if (this.extension !== extension) {
        throw new Error(ANOTHER_BROWSER_MESSAGE);
      }
      await this.slot.browser();
      const page = await this.slot.waitForPage(targetInfo.targetId, gone);
      if (page) {
        return page;
      }
      if (this.extension !== extension) {
        throw new Error(ANOTHER_BROWSER_MESSAGE);
      }
      if (!this.slot.bridge.isClaimed(tabId)) {
        throw new Error(TAB_DETACHED_MESSAGE);
      }
    }
  }

  async cdpSession(tabId: number): Promise<CDPSession> {
    const page = await this.page(tabId);
    return await page.context().newCDPSession(page);
  }

  async release(tabId: number): Promise<void> {
    await this.slot.bridge.release(tabId);
  }

  isClaimed(tabId: number): boolean {
    return this.slot.bridge.isClaimed(tabId);
  }

  on<E extends keyof BackendEvents>(
    event: E,
    listener: (data: BackendEvents[E]) => void,
  ): () => void {
    const listeners = this.listeners[event] as Set<
      (data: BackendEvents[E]) => void
    >;
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  /** Disconnects Playwright and the extension (which reconnects to the next daemon) */
  async close(): Promise<void> {
    this.closing = true;
    await this.slot.close();
    this.extension?.close(RelayCloseCode.shuttingDown, "The daemon is exiting");
  }

  // --- Internals ---

  private emit<E extends keyof BackendEvents>(
    event: E,
    data: BackendEvents[E],
  ) {
    for (const listener of this.listeners[event] as Set<
      (data: BackendEvents[E]) => void
    >) {
      try {
        listener(data);
      } catch (error) {
        this.options.log(`Error in a ${event} listener:`, error);
      }
    }
  }

  /** Whether an agent uses the connected browser: a tab is claimed, or, while a session is open, a tab agents used is still open */
  private inUse(): boolean {
    return this.slot.inUse(
      !this.options.hasSessions || this.options.hasSessions(),
    );
  }

  private refuseForeign(tabId: number) {
    if (this.foreignTabs.has(tabId)) {
      throw new Error(ANOTHER_BROWSER_MESSAGE);
    }
  }

  /** The connected extension, or throws the message the model should see */
  private usableExtension(): ExtensionConnection {
    const reason = this.unavailableReason();
    if (reason || !this.extension) {
      throw new Error(reason ?? NO_EXTENSION_MESSAGE);
    }
    if (this.extension.state.paused) {
      throw new Error(PAUSED_MESSAGE);
    }
    return this.extension;
  }

  /** Waits (briefly) until the extension reports the tab, or with `reported: false`, until it no longer does */
  private waitForTab(
    tabId: number,
    timeoutMs = 3000,
    reported = true,
  ): Promise<void> {
    const settled = (tabs: ExposedTab[]) =>
      tabs.some((tab) => tab.tabId === tabId) === reported;
    if (settled(this.tabs())) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timeout);
        off();
        resolve();
      };
      const timeout = setTimeout(done, timeoutMs);
      const off = this.on("state", ({ tabs }) => {
        if (settled(tabs)) {
          done();
        }
      });
    });
  }
}
