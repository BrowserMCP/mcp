import {
  type Browser,
  type BrowserContext,
  type CDPSession,
  chromium,
  type Page,
} from "playwright-core";
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
import { CdpBridge } from "@/relay/bridge";
import {
  ExtensionConnection,
  type ExtensionConnectionOptions,
  ExtensionProtocolError,
} from "@/relay/extension-connection";
import {
  ANOTHER_BROWSER_MESSAGE,
  noSuchTabMessage,
  PAUSED_MESSAGE,
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
  /** How long `page()` waits for the extension to report a tab it doesn't list yet (1 s) */
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
 * `BrowserBackend` over the relay: the extension connection (one browser at a time), the CDP bridge, and Playwright's `connectOverCDP` to the bridge's `/cdp`. Pages are found by target ID: each new Page's target ID is read once through a short-lived CDP session
 */
export class RelayBackend implements BrowserBackend {
  private extension: ExtensionConnection | null = null;
  /** Why the last extension couldn't connect, for `unavailableReason()` */
  private lastProblem: "update-extension" | "update-server" | null = null;
  /** The last extension `/extension` refused by Origin, until one connects: `unavailableReason()` names it, since the extension only retries */
  private rejectedExtension: { id: string | undefined; at: number } | null =
    null;
  private readonly bridge: CdpBridge;
  private cdpUrl: string | null = null;
  private browserPromise: Promise<Browser> | null = null;
  private pages = new Map<string, Page>();
  private pageWaiters = new Map<string, Set<(page: Page) => void>>();
  /** When the daemon started or the extension last disconnected: the extension is expected back soon after */
  private expectedSince = Date.now();
  /** The connected extension has sent `state` since `hello` (whose state is always `pending`, before the daemon proves its key) */
  private stateReceived = false;
  private closing = false;
  /** Tabs agents used in the connected browser (opened, selected, claimed, or dragged into an app's group) and that are still open: the browser is in use while a session is open and one of them is */
  private agentTabs = new Set<number>();
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
    this.bridge = new CdpBridge({
      log: options.log,
      extension: () => this.extension,
      onReleased: (tabId, reason) => this.emit("released", { tabId, reason }),
      reattachDelayMs: options.reattachDelayMs,
    });
  }

  /** Where Playwright connects: the relay's `/cdp?token=…`, known once the relay listens */
  setCdpUrl(url: string) {
    this.cdpUrl = url;
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

  acceptCdp(ws: WebSocket) {
    this.bridge.attachClient(ws);
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
      this.agentTabs = previous.agentTabs;
      this.foreignTabs = previous.foreignTabs;
    } else {
      this.agentTabs = new Set();
      this.foreignTabs = previous
        ? new Set([...previous.agentTabs, ...previous.foreignTabs])
        : new Set();
    }
    this.extension = connection;
    this.lastProblem = null;
    this.stateReceived = false;
    connection.onEvent((event) => {
      if (this.extension !== connection) {
        return;
      }
      this.bridge.onExtensionEvent(event);
      switch (event.type) {
        case "state":
          this.stateReceived = true;
          if (event.data.pairing === "paired") {
            const open = new Set(event.data.tabs.map((tab) => tab.tabId));
            for (const tabs of [this.agentTabs, this.foreignTabs]) {
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
            this.agentTabs.add(event.data.tabId);
            this.foreignTabs.delete(event.data.tabId);
          } else {
            this.agentTabs.delete(event.data.tabId);
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
        agentTabs: this.agentTabs,
        foreignTabs: this.foreignTabs,
        replaced,
      };
      // It went away on its own: a browser it replaced may connect again
      if (!replaced) {
        this.displaced = [];
      }
      this.extension = null;
      this.expectedSince = Date.now();
      this.bridge.releaseAll("disconnected");
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
        if (this.stateReceived || Date.now() >= stateBy) {
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
    return this.extension?.state.tabs ?? [];
  }

  async createTab(options: { url?: string; app: AppInfo }): Promise<number> {
    const extension = this.usableExtension();
    const { tabId } = await extension.request("createTab", options);
    if (this.extension === extension) {
      this.agentTabs.add(tabId);
      this.foreignTabs.delete(tabId);
    }
    // The extension reports the new tab in its next `state` (debounced), after answering. Until then the engine would take it for a closed tab
    await this.waitForTab(tabId);
    return tabId;
  }

  async closeTab(tabId: number): Promise<void> {
    const extension = this.usableExtension();
    this.refuseForeign(tabId);
    await this.bridge.release(tabId);
    this.agentTabs.delete(tabId);
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
      this.agentTabs.add(tabId);
      this.foreignTabs.delete(tabId);
    } else {
      this.agentTabs.delete(tabId);
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
    this.agentTabs.add(tabId);
    const targetInfo = await this.bridge.claim(tabId);
    if (this.extension !== extension) {
      throw new Error(ANOTHER_BROWSER_MESSAGE);
    }
    await this.browser();
    return await this.waitForPage(targetInfo.targetId);
  }

  async cdpSession(tabId: number): Promise<CDPSession> {
    const page = await this.page(tabId);
    return await page.context().newCDPSession(page);
  }

  async release(tabId: number): Promise<void> {
    await this.bridge.release(tabId);
  }

  isClaimed(tabId: number): boolean {
    return this.bridge.isClaimed(tabId);
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
    const browser = await this.browserPromise?.catch(() => null);
    this.browserPromise = null;
    await browser?.close().catch(() => {});
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
    if (this.bridge.claimedTabs().length > 0) {
      return true;
    }
    if (this.options.hasSessions && !this.options.hasSessions()) {
      return false;
    }
    const open = new Set(this.tabs().map((tab) => tab.tabId));
    return [...this.agentTabs].some((tabId) => open.has(tabId));
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

  private browser(): Promise<Browser> {
    if (!this.browserPromise) {
      if (!this.cdpUrl) {
        return Promise.reject(new Error("The relay isn't listening yet"));
      }
      // `noDefaults`: Playwright's default overrides (focus emulation, media emulation, downloads) stay off the user's tabs; the engine turns focus emulation on itself for the tabs it claims (`hiddenTabs`)
      const promise = chromium
        .connectOverCDP(this.cdpUrl, { noDefaults: true })
        .then((browser) => {
          browser.on("disconnected", () => {
            if (this.browserPromise === promise) {
              this.browserPromise = null;
            }
            this.pages.clear();
          });
          for (const context of browser.contexts()) {
            this.watchContext(context);
          }
          return browser;
        });
      promise.catch(() => {
        if (this.browserPromise === promise) {
          this.browserPromise = null;
        }
      });
      this.browserPromise = promise;
    }
    return this.browserPromise;
  }

  private watchContext(context: BrowserContext) {
    context.on("page", (page) => void this.identify(page));
    for (const page of context.pages()) {
      void this.identify(page);
    }
  }

  /** Reads a new Page's target ID (the bridge answers `Target.getTargetInfo` itself) */
  private async identify(page: Page) {
    let targetId: string;
    try {
      const session = await page.context().newCDPSession(page);
      const { targetInfo } = await session.send("Target.getTargetInfo");
      targetId = targetInfo.targetId;
      await session.detach().catch(() => {});
    } catch (error) {
      if (!page.isClosed()) {
        this.options.log("Couldn't identify a page:", error);
      }
      return;
    }
    if (page.isClosed()) {
      return;
    }
    this.pages.set(targetId, page);
    page.on("close", () => {
      if (this.pages.get(targetId) === page) {
        this.pages.delete(targetId);
      }
    });
    for (const resolve of this.pageWaiters.get(targetId) ?? []) {
      resolve(page);
    }
    this.pageWaiters.delete(targetId);
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

  private waitForPage(targetId: string): Promise<Page> {
    const page = this.pages.get(targetId);
    if (page && !page.isClosed()) {
      return Promise.resolve(page);
    }
    return new Promise((resolve, reject) => {
      const waiters = this.pageWaiters.get(targetId) ?? new Set();
      this.pageWaiters.set(targetId, waiters);
      const waiter = (page: Page) => {
        clearTimeout(timeout);
        resolve(page);
      };
      const timeout = setTimeout(() => {
        waiters.delete(waiter);
        if (waiters.size === 0 && this.pageWaiters.get(targetId) === waiters) {
          this.pageWaiters.delete(targetId);
        }
        reject(new Error("The tab didn't become ready in time"));
      }, this.options.pageTimeoutMs ?? 15_000);
      waiters.add(waiter);
    });
  }
}
