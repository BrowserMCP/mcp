import type { CDPSession, Page } from "playwright-core";
import type { WebSocket } from "ws";

import {
  type ExposedTab,
  type ExtensionState,
  MAX_BROWSERS,
  NO_EXTENSION_MESSAGE,
  RelayCloseCode,
  RelayUpdateReason,
  isValidBrowserId,
  pairingRequiredMessage,
} from "@browsermcp/protocol";

import type {
  AppInfo,
  BackendEvents,
  BackendTab,
  BrowserBackend,
  BrowserSummary,
} from "@/contracts";
import { BrowserSlot } from "@/relay/browser-slot";
import {
  ExtensionConnection,
  type ExtensionConnectionOptions,
  ExtensionProtocolError,
} from "@/relay/extension-connection";
import {
  browserDisconnectedMessage,
  noSuchBrowserMessage,
  noSuchTabMessage,
  PAUSED_MESSAGE,
  TAB_DETACHED_MESSAGE,
  tooManyBrowsersReason,
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
  /** How long `page()` waits for Playwright to see a claimed tab */
  pageTimeoutMs?: number;
  /** How long after the daemon starts, or a browser disconnects, `whenReady()` waits for it to (re)connect. The extension retries every 1–5 s */
  reconnectGraceMs?: number;
  reattachDelayMs?: number;
  /** How long `findTab()` and `page()` wait for a browser to report a tab it doesn't list yet (1 s) */
  unknownTabWaitMs?: number;
  /** How many browsers are connected at once; one more is refused with `anotherBrowser`. Default: `MAX_BROWSERS` */
  maxBrowsers?: number;
};

type Listeners = {
  [E in keyof BackendEvents]: Set<(data: BackendEvents[E]) => void>;
};

/** A public tab ID's browser and Chrome tab ID */
type TabRef = { slot: BrowserSlot; tabId: number };

/** How long a refused extension is named in `unavailableReason()`: it retries every 1–5 s */
const REJECTED_EXTENSION_MS = 30_000;

/** How many browsers the daemon remembers, connected or away: beyond that, it forgets the one away longest */
const REMEMBERED_BROWSERS = 2 * MAX_BROWSERS;

/** The Chrome tab ID of a retired public ID (`retireReused()`), which no tab has: the ID fails as a closed tab's */
const RETIRED_TAB = -1;

/**
 * `BrowserBackend` over the relay, for up to `MAX_BROWSERS` browsers (Chrome profiles) at once. Each gets a `BrowserSlot`: its extension connection, its CDP bridge, and Playwright's `connectOverCDP` to the bridge's `/cdp?browser=<id>`. A browser that reconnects (its service worker restarted) lands in its old slot, told apart by `hello.browserId` or, from extensions that send none, by user agent and window IDs.
 *
 * Chrome's tab IDs mean something only within one browser, so the backend issues the tab IDs the engine sees: a tab keeps its Chrome ID unless another browser's tab already has that number, and keeps its public ID across its browser's reconnects. An ID of a browser that's away fails with "<label> disconnected", never naming another browser's tab
 */
export class RelayBackend implements BrowserBackend {
  /** Every browser that connected while the daemon runs, in that order */
  private slots: BrowserSlot[] = [];
  private nextSlotId = 1;
  /** Public tab IDs → their browser's tab. Kept after tabs close, so an old ID never names another tab */
  private refs = new Map<number, TabRef>();
  /** Public IDs for tabs whose Chrome ID another browser's tab has: far above the IDs Chrome gives, so they don't take the numbers of other browsers' next tabs */
  private nextSpareId = 100_001;
  /** Why the last extension couldn't connect, for `unavailableReason()` */
  private lastProblem: "update-extension" | "update-server" | null = null;
  /** The last extension `/extension` refused by Origin, until one connects: `unavailableReason()` names it, since the extension only retries */
  private rejectedExtension: { id: string | undefined; at: number } | null =
    null;
  private cdpUrl: string | null = null;
  /** When the daemon started: a browser is expected soon after */
  private readonly startedAt = Date.now();
  private closing = false;
  private readonly listeners = {
    state: new Set(),
    tabAssigned: new Set(),
    tabOpened: new Set(),
    released: new Set(),
    connection: new Set(),
  } as Listeners;

  constructor(private readonly options: RelayBackendOptions) {}

  /** Where Playwright connects: the relay's `/cdp?token=…`, known once the relay listens. Each browser's Playwright adds `&browser=<id>` */
  setCdpUrl(url: string) {
    this.cdpUrl = url;
  }

  // --- Connections from the relay server ---

  /** An extension on `/extension` (`port`: the port it dialed): hello/welcome, then it joins the connected browsers, unless `MAX_BROWSERS` are */
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
    if (this.closing) {
      connection.close(RelayCloseCode.shuttingDown, "The daemon is exiting");
      return;
    }
    if (!connection.open) {
      return;
    }
    await this.adopt(connection);
  }

  /** Playwright on `/cdp`, for the browser named by `browser=<id>` (the first one when unnamed) */
  acceptCdp(ws: WebSocket, browserId?: string) {
    const slot = browserId
      ? this.slots.find((other) => other.id === browserId)
      : this.slots[0];
    if (!slot) {
      ws.close(1008, "No such browser");
      return;
    }
    slot.bridge.attachClient(ws);
  }

  private async adopt(connection: ExtensionConnection) {
    const { hello } = connection;
    const { name, userAgent } = hello.browser;
    const browserId = isValidBrowserId(hello.browserId)
      ? hello.browserId
      : undefined;
    const known = browserId
      ? this.slots.find((other) => other.browserId === browserId)
      : undefined;
    // The browser's old connection may still be open (a service worker that stopped without closing it): one that doesn't answer makes way. One that does is another browser with this `browserId` (a copied profile), which keeps it
    if (known?.connection) {
      const old = known.connection;
      if (await old.ping(this.pingTimeoutMs())) {
        if (known.connection === old && connection.open) {
          this.options.log(
            `Refused ${name}: ${known.id} with its browserId is connected`,
          );
          connection.close(
            RelayCloseCode.anotherBrowser,
            "This browser is connected to Browser MCP already",
          );
          return;
        }
      } else {
        this.dropStale(known, old);
      }
    }
    if (!browserId && !this.guessSlot(name, userAgent)) {
      // Without a `browserId`, the same: a connected browser like this one whose connection doesn't answer
      const alike = this.connectedSlots().filter(
        (other) =>
          !other.browserId &&
          other.matches(name, userAgent, new Set()) !== false,
      );
      await Promise.all(
        alike.map(async (other) => {
          const old = other.connection!;
          if (!(await old.ping(this.pingTimeoutMs()))) {
            this.dropStale(other, old);
          }
        }),
      );
    }
    if (this.closing) {
      connection.close(RelayCloseCode.shuttingDown, "The daemon is exiting");
      return;
    }
    if (!connection.open) {
      return;
    }
    let slot =
      (known && !known.connection ? known : undefined) ??
      this.guessSlot(name, userAgent);
    const max = this.options.maxBrowsers ?? MAX_BROWSERS;
    const others = this.connectedSlots().filter((other) => other !== slot);
    if (others.length >= max) {
      this.options.log(
        `Refused ${hello.browser.name} ${hello.browser.version}: ${max} browsers are connected`,
      );
      connection.close(
        RelayCloseCode.anotherBrowser,
        tooManyBrowsersReason(max),
      );
      return;
    }
    const guessed = !!slot && !slot.browserId;
    slot ??= this.newSlot(name, userAgent);
    slot.browserId ??= browserId;
    // Its paired states check that the tab IDs it had still name the same tabs (`retireReused()`)
    slot.unverified = new Set(slot.publicIds.keys());
    // Without a `browserId`, the slot was a guess until the browser reports its windows
    slot.unconfirmed = !browserId && guessed;
    slot.connection = connection;
    slot.connectedAt = Date.now();
    slot.stateReceived = false;
    this.lastProblem = null;
    this.options.log(
      `Extension ${hello.extensionVersion} connected from ${hello.browser.name} ${hello.browser.version} as ${slot.id} (protocol ${hello.protocol}, pairing ${hello.state.pairing}${browserId ? "" : ", no browserId"})`,
    );
    // `hello`'s state (the real extension's is `pending` and lists no tabs until it checked the daemon's key)
    this.noteState(slot, connection, connection.state);
    connection.onEvent((event) => {
      let slot = this.slotOf(connection);
      if (!slot) {
        return;
      }
      if (event.type === "state") {
        slot = this.noteState(slot, connection, event.data);
        slot.stateReceived = true;
      }
      slot.bridge.onExtensionEvent(event);
      switch (event.type) {
        case "state":
          this.emitState();
          return;
        case "tabAssigned":
          this.emit("tabAssigned", {
            tabId: this.publicId(slot, event.data.tabId),
            appId: event.data.appId,
          });
          return;
        case "tabOpened":
          this.emit("tabOpened", {
            tabId: this.publicId(slot, event.data.tabId),
            openerTabId: this.publicId(slot, event.data.openerTabId),
            url: event.data.url,
          });
          return;
      }
    });
    connection.onClose((code, reason) => {
      const slot = this.slotOf(connection);
      this.options.log(
        `Extension disconnected${slot ? ` from ${slot.id}` : ""} (${code} ${reason})`,
      );
      if (
        code === RelayCloseCode.unsupportedProtocol &&
        reason === RelayUpdateReason.updateServer
      ) {
        this.lastProblem = "update-server";
      }
      if (slot) {
        this.disconnected(slot, connection);
      }
    });
    this.emit("connection", { connected: true });
    this.emitState();
  }

  /** Takes in a browser's state: confirms a guessed slot (`confirm()`), and notes its label, focus, windows and tabs' public IDs. Returns the connection's slot */
  private noteState(
    slot: BrowserSlot,
    connection: ExtensionConnection,
    state: ExtensionState,
  ): BrowserSlot {
    if (state.pairing !== "paired") {
      return slot;
    }
    slot = this.confirm(slot, connection, state.tabs);
    if (slot.unverified.size > 0) {
      this.retireReused(slot, state.tabs);
    }
    // Only a paired state carries them (never `hello`'s), so one without a label means the user cleared it
    slot.userLabel = state.label?.trim() || undefined;
    slot.lastFocusedAt = state.lastFocusedAt ?? slot.lastFocusedAt;
    if (state.tabs.length > 0) {
      slot.windowIds = new Set(state.tabs.map((tab) => tab.windowId));
    }
    for (const tab of state.tabs) {
      this.publicId(slot, tab.tabId);
    }
    return slot;
  }

  /** After a browser reconnects: retires the public IDs of its tabs whose Chrome IDs now name other tabs, as after Chrome restarted (it numbers tabs anew). A tab that was open when the browser left, with the URL it had then, is taken for the same tab (its service worker restarted); a tab that wasn't open then, or shows another URL, gets a new public ID, and the old one fails as a closed tab's. An empty URL (a tab still loading) proves nothing either way, so such a tab is checked again with the next state */
  private retireReused(slot: BrowserSlot, tabs: ExposedTab[]) {
    for (const tab of tabs) {
      if (!slot.unverified.has(tab.tabId)) {
        continue;
      }
      const before = slot.urlsWhenLeft.get(tab.tabId);
      if (before === "" || tab.url === "") {
        continue;
      }
      slot.unverified.delete(tab.tabId);
      const publicId = slot.publicIds.get(tab.tabId);
      if (publicId !== undefined && before !== tab.url) {
        this.options.log(
          `${slot.id}: its tab ${tab.tabId} is another tab now (${tab.url}), so its ID ${publicId} is retired`,
        );
        slot.publicIds.delete(tab.tabId);
        this.refs.set(publicId, { slot, tabId: RETIRED_TAB });
      }
    }
  }

  /** Closes a browser's connection that stopped answering, so its next one takes its slot */
  private dropStale(slot: BrowserSlot, connection: ExtensionConnection) {
    if (slot.connection !== connection) {
      return;
    }
    this.options.log(
      `${slot.id} stopped answering; its new connection replaces it`,
    );
    this.disconnected(slot, connection);
    connection.close(
      RelayCloseCode.anotherBrowser,
      "This browser connected to Browser MCP again",
    );
  }

  private pingTimeoutMs() {
    return this.options.pingTimeoutMs ?? 3000;
  }

  /** For a connection without a `browserId`: the browser that disconnected last of those with the same name and user agent and no `browserId`. Its windows confirm it later (`confirm()`) */
  private guessSlot(name: string, userAgent: string): BrowserSlot | undefined {
    return this.slots
      .filter(
        (slot) =>
          !slot.connection &&
          !slot.browserId &&
          slot.matches(name, userAgent, new Set()) !== false,
      )
      .sort((a, b) => b.disconnectedAt - a.disconnectedAt)[0];
  }

  /** On a connection's first paired `state` with tabs, when its slot was a guess (`unconfirmed`): keeps it if the windows match, else moves the connection to the slot whose windows do, or to a new one. Returns the connection's slot */
  private confirm(
    slot: BrowserSlot,
    connection: ExtensionConnection,
    tabs: { windowId: number }[],
  ): BrowserSlot {
    if (!slot.unconfirmed || tabs.length === 0) {
      return slot;
    }
    slot.unconfirmed = false;
    const windows = new Set(tabs.map((tab) => tab.windowId));
    const { name, userAgent } = slot;
    if (slot.matches(name, userAgent, windows) !== false) {
      return slot;
    }
    const target =
      this.slots.find(
        (other) =>
          other !== slot &&
          !other.connection &&
          !other.browserId &&
          other.matches(name, userAgent, windows) === true,
      ) ?? this.newSlot(name, userAgent);
    this.options.log(
      `${slot.id} was another browser: it's ${target.id}, whose windows it reports`,
    );
    slot.connection = null;
    target.connection = connection;
    target.connectedAt = slot.connectedAt;
    return target;
  }

  private newSlot(name: string, userAgent: string): BrowserSlot {
    // Forget the browsers away longest beyond `REMEMBERED_BROWSERS` (their tab IDs still fail as theirs)
    const away = this.slots
      .filter((slot) => !slot.connection)
      .sort((a, b) => a.disconnectedAt - b.disconnectedAt);
    for (const slot of away.slice(
      0,
      Math.max(0, this.slots.length + 1 - REMEMBERED_BROWSERS),
    )) {
      this.slots = this.slots.filter((other) => other !== slot);
      void slot.close();
    }
    const id = `b${this.nextSlotId++}`;
    const taken = new Set(this.slots.map((slot) => slot.defaultLabel));
    let n = 1;
    while (taken.has(n === 1 ? name : `${name} ${n}`)) {
      n++;
    }
    const slot: BrowserSlot = new BrowserSlot(
      id,
      name,
      userAgent,
      n === 1 ? name : `${name} ${n}`,
      {
        log: this.options.log,
        cdpUrl: () => (this.cdpUrl ? `${this.cdpUrl}&browser=${id}` : null),
        onReleased: (tabId, reason) =>
          this.emit("released", { tabId: this.publicId(slot, tabId), reason }),
        reattachDelayMs: this.options.reattachDelayMs,
        pageTimeoutMs: this.options.pageTimeoutMs,
      },
    );
    this.slots.push(slot);
    return slot;
  }

  /** A connection went away (or was replaced by its browser's next one): its slot keeps the browser's tabs for when it's back, and releases its claimed tabs */
  private disconnected(slot: BrowserSlot, connection: ExtensionConnection) {
    if (slot.connection !== connection) {
      return;
    }
    slot.urlsWhenLeft = new Map(slot.tabs().map((tab) => [tab.tabId, tab.url]));
    slot.connection = null;
    slot.unconfirmed = false;
    slot.disconnectedAt = Date.now();
    slot.bridge.releaseAll("disconnected");
    this.emit("connection", { connected: this.connected });
  }

  // --- BrowserBackend ---

  get connected(): boolean {
    return this.connectedSlots().length > 0;
  }

  /** Every connected browser that waits for no **Allow** is paused */
  get paused(): boolean {
    const paired = this.connectedSlots().filter(
      (slot) => slot.connection!.state.pairing === "paired",
    );
    const slots = paired.length > 0 ? paired : this.connectedSlots();
    return (
      slots.length > 0 && slots.every((slot) => slot.connection!.state.paused)
    );
  }

  browsers(): BrowserSummary[] {
    const fallback = this.defaultSlot();
    return this.slots.map((slot) => ({
      id: slot.id,
      label: slot.label,
      connected: !!slot.connection,
      pairing: slot.connection?.state.pairing ?? "pending",
      paused: slot.connection?.state.paused ?? false,
      tabs: slot.tabs().length,
      lastFocusedAt: slot.lastFocusedAt,
      connectedAt: slot.connectedAt,
      usable: slot.usable,
      default: slot === fallback,
    }));
  }

  /** `/extension` refused a connection by its Origin (`id` is undefined unless it was a `chrome-extension://` ID) */
  noteRejectedExtension(id: string | undefined) {
    this.rejectedExtension = { id, at: Date.now() };
  }

  /** Why no browser is usable, or null when one is. A browser waiting for **Allow** doesn't stop agents using another */
  unavailableReason(): string | null {
    const connected = this.connectedSlots();
    if (connected.length === 0) {
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
    if (
      connected.every((slot) => slot.connection!.state.pairing === "pending")
    ) {
      return connected
        .map((slot) => this.named(slot, this.pairingMessage(slot)))
        .join("\n");
    }
    return null;
  }

  async whenReady(tabId?: number | null): Promise<void> {
    const grace = this.options.reconnectGraceMs ?? 10_000;
    // After connecting, the extension sends its state as soon as it checked the daemon's key
    const stateBy = Date.now() + 2000;
    const ready = () => {
      const now = Date.now();
      const slot = tabId == null ? undefined : this.refs.get(tabId)?.slot;
      if (slot) {
        if (slot.connection) {
          return slot.stateReceived || now >= stateBy;
        }
        // The tab's browser went away a moment ago: it's expected back
        if (now < slot.disconnectedAt + grace) {
          return false;
        }
      }
      const connected = this.connectedSlots();
      if (connected.length > 0) {
        return connected.some((other) => other.stateReceived) || now >= stateBy;
      }
      const expectedSince = Math.max(
        this.startedAt,
        ...this.slots.map((other) => other.disconnectedAt),
      );
      return now >= expectedSince + grace;
    };
    while (!ready()) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  /** The connected browsers' tabs, with their public IDs */
  tabs(): BackendTab[] {
    return this.connectedSlots().flatMap((slot) =>
      slot.tabs().map((tab) => ({
        ...tab,
        tabId: this.publicId(slot, tab.tabId),
        browser: slot.id,
      })),
    );
  }

  /** The tab with this ID, waiting (briefly) for its browser to report one it doesn't list yet: it reports a new tab a moment after it appears. Throws for a tab of a browser that's away */
  async findTab(tabId: number): Promise<BackendTab | undefined> {
    const find = () => this.tabs().find((tab) => tab.tabId === tabId);
    if (!find()) {
      const ref = await this.waitForRef(tabId);
      if (ref && !ref.slot.connection && ref.tabId !== RETIRED_TAB) {
        throw new Error(browserDisconnectedMessage(ref.slot.label));
      }
      if (ref?.slot.connection) {
        await this.waitForTab(
          ref.slot,
          ref.tabId,
          this.options.unknownTabWaitMs ?? 1000,
        );
      }
    }
    return find();
  }

  tabClosed(tabId: number): boolean {
    const ref = this.refs.get(tabId);
    if (!ref) {
      return this.unavailableReason() === null;
    }
    const state = ref.slot.connection?.state;
    return (
      state?.pairing === "paired" &&
      !state.tabs.some((tab) => tab.tabId === ref.tabId)
    );
  }

  async createTab(options: {
    url?: string;
    app: AppInfo;
    browser?: string;
  }): Promise<number> {
    const slot = this.usableSlot(options.browser);
    const connection = slot.connection!;
    const { tabId } = await connection.request("createTab", {
      url: options.url,
      app: options.app,
    });
    const id = this.publicId(slot, tabId);
    // The extension reports the new tab in its next `state` (debounced), after answering. Until then the engine would take it for a closed tab
    await this.waitForTab(slot, tabId);
    return id;
  }

  async closeTab(tabId: number): Promise<void> {
    const { slot, tabId: tab, connection } = await this.usableTab(tabId);
    await slot.bridge.release(tab);
    await connection.request("closeTab", { tabId: tab });
    // As with `createTab`: until the next `state`, the tab would still be listed
    await this.waitForTab(slot, tab, 3000, false);
  }

  async activateTab(tabId: number): Promise<void> {
    const { tabId: tab, connection } = await this.usableTab(tabId);
    await connection.request("activateTab", { tabId: tab });
  }

  async groupTab(tabId: number, app: AppInfo | null): Promise<void> {
    const { tabId: tab, connection } = await this.usableTab(tabId);
    await connection.request("groupTab", { tabId: tab, app });
  }

  noteActivity(appId: string, browser?: string): void {
    const slot = browser
      ? this.slots.find((other) => other.id === browser)
      : this.defaultSlot();
    slot?.connection?.send("activity", { appId }, () => {});
  }

  /** Claims a tab: one its browser reports (waiting briefly for a tab it hasn't reported yet) */
  async page(tabId: number): Promise<Page> {
    const { slot, tabId: tab, connection } = await this.usableTab(tabId);
    if (!slot.tabs().some((other) => other.tabId === tab)) {
      await this.waitForTab(slot, tab, this.options.unknownTabWaitMs ?? 1000);
      if (slot.connection !== connection) {
        throw new Error(browserDisconnectedMessage(slot.label));
      }
      if (!slot.tabs().some((other) => other.tabId === tab)) {
        throw new Error(noSuchTabMessage(tabId, this.labelIfSeveral(slot)));
      }
    }
    // The target can go before Playwright has its Page. Then the bridge either re-attaches it (a navigation that swapped the renderer), so claim it again, or lets it go (it detached again within the cooldown, e.g. another extension putting its frame back), so fail now rather than wait out the timeout
    for (;;) {
      const targetInfo = await slot.bridge.claim(tab);
      const gone = slot.bridge.whenGone(tab);
      if (slot.connection !== connection) {
        throw new Error(browserDisconnectedMessage(slot.label));
      }
      await slot.browser();
      const page = await slot.waitForPage(targetInfo.targetId, gone);
      if (page) {
        return page;
      }
      if (slot.connection !== connection) {
        throw new Error(browserDisconnectedMessage(slot.label));
      }
      if (!slot.bridge.isClaimed(tab)) {
        throw new Error(TAB_DETACHED_MESSAGE);
      }
    }
  }

  async cdpSession(tabId: number): Promise<CDPSession> {
    const page = await this.page(tabId);
    return await page.context().newCDPSession(page);
  }

  async release(tabId: number): Promise<void> {
    const ref = this.refs.get(tabId);
    await ref?.slot.bridge.release(ref.tabId);
  }

  isClaimed(tabId: number): boolean {
    const ref = this.refs.get(tabId);
    return ref?.slot.bridge.isClaimed(ref.tabId) ?? false;
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

  /** Disconnects Playwright and the extensions (which reconnect to the next daemon) */
  async close(): Promise<void> {
    this.closing = true;
    await Promise.all(
      this.slots.map(async (slot) => {
        await slot.close();
        slot.connection?.close(
          RelayCloseCode.shuttingDown,
          "The daemon is exiting",
        );
      }),
    );
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

  private emitState() {
    this.emit("state", {
      tabs: this.tabs(),
      paused: this.paused,
      pairing: this.connectedSlots().some(
        (slot) => slot.connection!.state.pairing === "paired",
      )
        ? "paired"
        : "pending",
    });
  }

  private connectedSlots(): BrowserSlot[] {
    return this.slots.filter((slot) => slot.connection);
  }

  private slotOf(connection: ExtensionConnection): BrowserSlot | undefined {
    return this.slots.find((slot) => slot.connection === connection);
  }

  /** The browser's label while several are connected, for messages that name it */
  private labelIfSeveral(slot: BrowserSlot): string | undefined {
    return this.connectedSlots().length > 1 ? slot.label : undefined;
  }

  /** A message about one browser, prefixed with its label while several are connected */
  private named(slot: BrowserSlot, message: string): string {
    const label = this.labelIfSeveral(slot);
    return label ? `${label}: ${message}` : message;
  }

  private pairingMessage(slot: BrowserSlot): string {
    return pairingRequiredMessage(slot.connection?.pairingCode ?? undefined);
  }

  /** The public ID of a browser's tab: its Chrome ID unless another browser's tab has that number already, then a spare one (`nextSpareId`). Issued once and kept */
  private publicId(slot: BrowserSlot, tabId: number): number {
    const known = slot.publicIds.get(tabId);
    if (known !== undefined) {
      return known;
    }
    let id = tabId;
    if (this.refs.has(id)) {
      while (this.refs.has(this.nextSpareId)) {
        this.nextSpareId++;
      }
      id = this.nextSpareId++;
    }
    slot.publicIds.set(tabId, id);
    this.refs.set(id, { slot, tabId });
    return id;
  }

  /** A public ID's tab, waiting (briefly) for an ID no browser reported yet */
  private async waitForRef(tabId: number): Promise<TabRef | undefined> {
    if (!this.refs.has(tabId) && this.connected) {
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timeout);
          off();
          resolve();
        };
        const timeout = setTimeout(done, this.options.unknownTabWaitMs ?? 1000);
        const off = this.on("state", () => {
          if (this.refs.has(tabId)) {
            done();
          }
        });
      });
    }
    return this.refs.get(tabId);
  }

  /** A tab's browser, connected and usable, or throws the message the model should see */
  private async usableTab(
    tabId: number,
  ): Promise<TabRef & { connection: ExtensionConnection }> {
    const reason = this.unavailableReason();
    if (reason && !this.connected) {
      throw new Error(reason);
    }
    const ref = await this.waitForRef(tabId);
    if (!ref) {
      throw new Error(reason ?? noSuchTabMessage(tabId));
    }
    const { slot } = ref;
    const connection = slot.connection;
    if (!connection) {
      throw new Error(browserDisconnectedMessage(slot.label));
    }
    if (connection.state.pairing === "pending") {
      throw new Error(this.named(slot, this.pairingMessage(slot)));
    }
    if (connection.state.paused) {
      throw new Error(this.named(slot, PAUSED_MESSAGE));
    }
    return { ...ref, connection };
  }

  /** The usable browser focused last, else the one connected last */
  private defaultSlot(): BrowserSlot | undefined {
    return this.connectedSlots()
      .filter((slot) => slot.usable)
      .sort(
        (a, b) =>
          (b.lastFocusedAt ?? 0) - (a.lastFocusedAt ?? 0) ||
          b.connectedAt - a.connectedAt,
      )[0];
  }

  /** The browser `createTab()` opens in: `browser` (an ID), or by default `defaultSlot()`. Throws the message the model should see when it can't be used */
  private usableSlot(browser?: string): BrowserSlot {
    if (!browser) {
      const reason = this.unavailableReason();
      if (reason) {
        throw new Error(reason);
      }
      const slot = this.defaultSlot();
      if (!slot) {
        throw new Error(PAUSED_MESSAGE);
      }
      return slot;
    }
    const slot = this.slots.find((other) => other.id === browser);
    if (!slot) {
      throw new Error(noSuchBrowserMessage(browser));
    }
    const state = slot.connection?.state;
    if (!state) {
      const reason = this.unavailableReason();
      throw new Error(
        reason && !this.connected
          ? reason
          : browserDisconnectedMessage(slot.label),
      );
    }
    if (state.pairing === "pending") {
      throw new Error(this.named(slot, this.pairingMessage(slot)));
    }
    if (state.paused) {
      throw new Error(this.named(slot, PAUSED_MESSAGE));
    }
    return slot;
  }

  /** Waits (briefly) until the browser reports the tab, or with `reported: false`, until it no longer does */
  private waitForTab(
    slot: BrowserSlot,
    tabId: number,
    timeoutMs = 3000,
    reported = true,
  ): Promise<void> {
    const settled = () =>
      slot.tabs().some((tab) => tab.tabId === tabId) === reported;
    if (settled()) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timeout);
        off();
        resolve();
      };
      const timeout = setTimeout(done, timeoutMs);
      const off = this.on("state", () => {
        if (settled()) {
          done();
        }
      });
    });
  }
}
