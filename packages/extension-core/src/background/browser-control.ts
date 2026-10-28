import { type Browser, browser } from "wxt/browser";

import {
  type AppInfo,
  type BrowserInfo,
  type ExtensionEvent,
  type ExtensionRequest,
  type ExtensionState,
  LEGACY_PORT,
  RELAY_PORTS,
  RELAY_PROTOCOL_VERSION,
  isValidRelayPort,
  pairingRequiredMessage,
} from "@browsermcp/protocol";

import {
  appGroupsItem,
  connectionStatusItem,
  lastActiveAppItem,
  legacyPortItem,
  legacyServerItem,
  pausedItem,
  relayPortItem,
} from "../storage";
import type {
  BrowserControlApp,
  BrowserControlView,
  ConnectionStatus,
} from "../types";
import { updateBadge } from "./badge";
import { getDeniedCdpMessage, getNavigationUrl } from "./cdp-policy";
import { RelayConnection, type Welcome } from "./connection";
import { DebuggerSessions } from "./debugger";
import {
  type ExposureRules,
  getTabUrl,
  isExposedTab,
  isExposedUrl,
} from "./exposure";
import { addPairedKey, isPairedKey, verifyDaemonSignature } from "./pairing";
import {
  forgetGroup,
  forgetTab,
  groupTab,
  openAgentTab,
  reconcileAppGroups,
  updateTabAssignment,
} from "./tab-groups";

/** What every command answers while the user has pressed **Stop** */
export const PAUSED_MESSAGE =
  "The user paused Browser MCP. Ask them to click Resume in its popup";

export const WATCHDOG_ALARM = "browser-control-watchdog";

/** How long tab changes are gathered before the extension sends `state` */
const STATE_DEBOUNCE_MS = 100;

/** The `onUpdated` changes that change what `state` reports */
const STATE_CHANGES = ["url", "title", "pinned", "groupId", "discarded"];

/** The daemon on the other end, once it proved its key */
/** `code`: the six-digit pairing code for this connection, for a key the user didn't allow when it connected */
type Daemon = { publicKey: string; code: string | null; paired: boolean };

/**
 * What browser control reports through `onEvent`, e.g. for usage analytics:
 * - `daemon connected`: `{ protocol, daemonVersion, paired }`, on each connection to a daemon that proved its key
 * - `daemon connection failed`: `{ reason, daemonVersion? }`, when the connection's status turns into a failure (`updateServer`, `updateExtension`, `anotherBrowser`, `untrusted`) or a 0.1.x server is found (`outdatedServer`). Once per change, not per retry
 * - `daemon paired`: the user clicked **Allow**
 */
export type BrowserControlEvent =
  | "daemon connected"
  | "daemon connection failed"
  | "daemon paired";

export type BrowserControlOptions = {
  fetch?: typeof fetch;
  WebSocket?: typeof WebSocket;
  /** Tests shorten the `Input.*` timeout */
  inputTimeoutMs?: number;
  /** Development and test builds: look for a 0.1.x server on `local:legacyPort` instead of `LEGACY_PORT` when it's set (the smoke test's fake one) */
  legacyPortOverride?: boolean;
  /** Called with each `BrowserControlEvent`. Browser control sends nothing anywhere itself */
  onEvent?: (event: BrowserControlEvent, properties?: object) => void;
  /** Called for each batch of agent actions that worked (the daemon's `activity`), e.g. to count towards asking for a review */
  onActivity?: () => void | Promise<void>;
};

/**
 * Browser control in the background: a thin `chrome.debugger` relay for the Browser MCP daemon (`@browsermcp/mcp`, protocol in `@browsermcp/protocol`). The daemon decides which tabs to attach; the extension reports the tabs agents may use, runs the daemon's requests and enforces every rule about tabs itself (pairing, incognito and browser pages, Stop), whatever the daemon asks
 */
export class BrowserControl {
  readonly debugger: DebuggerSessions;
  readonly connection: RelayConnection;
  #daemon: Daemon | null = null;
  #stateTimer: ReturnType<typeof setTimeout> | undefined;
  #onEvent: BrowserControlOptions["onEvent"];
  #onActivity: BrowserControlOptions["onActivity"];

  constructor(options: BrowserControlOptions = {}) {
    const {
      inputTimeoutMs,
      legacyPortOverride = false,
      onEvent,
      onActivity,
      ...connectionOptions
    } = options;
    this.#onEvent = onEvent;
    this.#onActivity = onActivity;
    this.debugger = new DebuggerSessions(
      {
        onEvent: (data) => this.#emit({ type: "cdpEvent", data }),
        onDetach: (tabId, reason) => void this.#onDebuggerDetach(tabId, reason),
        onChange: () => {
          void this.#updateBadge();
          this.#scheduleState();
        },
      },
      { inputTimeoutMs },
    );
    this.connection = new RelayConnection({
      ...connectionOptions,
      getPorts: async () => {
        const port = await relayPortItem.getValue();
        return port ? [port] : RELAY_PORTS;
      },
      getLegacyPort: async () =>
        (legacyPortOverride && (await legacyPortItem.getValue())) ||
        LEGACY_PORT,
      createHello: async (challenge) => ({
        type: "hello",
        protocol: RELAY_PROTOCOL_VERSION,
        extensionVersion: browser.runtime.getManifest().version,
        browser: getBrowserInfo(),
        capabilities: ["popupWindows", "tabOpened", "tabGroups"],
        challenge,
        // Nothing until the daemon proves a key the user allowed (`onWelcome`)
        state: {
          tabs: [],
          paused: await pausedItem.getValue(),
          pairing: "pending",
        },
      }),
      verifyWelcome: (welcome, challenge, port) =>
        verifyDaemonSignature({
          challenge,
          port,
          publicKey: welcome.publicKey,
          pairingCommitment: welcome.pairingCommitment,
          signature: welcome.signature,
        }),
      isPaired: (publicKey) => isPairedKey(publicKey),
      onWelcome: (welcome, port, code) => this.#onWelcome(welcome, port, code),
      onRequest: (request) => this.#handleRequest(request),
      setStatus: (status) => this.#setStatus(status),
      setLegacyServer: (present) => this.#setLegacyServer(present),
      onDisconnect: () => {
        this.#daemon = null;
        void this.debugger.detachAll();
        void this.#updateBadge();
      },
    });
  }

  /**
   * Adds the listeners (synchronously, so the events that start the service worker reach them) and starts connecting. Returns a function that removes the listeners
   */
  start(): () => void {
    const onTabUpdated = (
      tabId: number,
      changeInfo: Browser.tabs.OnUpdatedInfo,
    ) => void this.#onTabUpdated(tabId, changeInfo);
    const onTabRemoved = (tabId: number) => void this.#onTabRemoved(tabId);
    const onTabsChanged = () => this.#scheduleState();
    const onGroupRemoved = (group: Browser.tabGroups.TabGroup) =>
      void forgetGroup(group.id);
    const onCreatedNavigationTarget = (
      details: Browser.webNavigation.WebNavigationSourceCallbackDetails,
    ) => void this.#onTabOpened(details);
    const onBeforeNavigate = (
      details: Browser.webNavigation.WebNavigationBaseCallbackDetails,
    ) => void this.#onBeforeNavigate(details);
    const onAlarm = (alarm: Browser.alarms.Alarm) => {
      if (alarm.name === WATCHDOG_ALARM) {
        this.connection.watchdog();
      }
    };
    const onStartup = () => this.connection.ensureRunning();

    const removers = [
      this.debugger.addListeners(),
      addListener(browser.tabs.onUpdated, onTabUpdated),
      addListener(browser.tabs.onRemoved, onTabRemoved),
      addListener(browser.tabs.onCreated, onTabsChanged),
      addListener(browser.tabs.onActivated, onTabsChanged),
      addListener(browser.tabs.onReplaced, onTabsChanged),
      addListener(browser.tabs.onAttached, onTabsChanged),
      addListener(browser.tabs.onDetached, onTabsChanged),
      addListener(browser.tabGroups.onRemoved, onGroupRemoved),
      addListener(
        browser.webNavigation.onCreatedNavigationTarget,
        onCreatedNavigationTarget,
      ),
      addListener(browser.webNavigation.onBeforeNavigate, onBeforeNavigate),
      addListener(browser.alarms.onAlarm, onAlarm),
      addListener(browser.runtime.onStartup, onStartup),
    ];
    void browser.alarms.create(WATCHDOG_ALARM, { periodInMinutes: 0.5 });
    void this.#init();
    return () => {
      removers.forEach((remove) => remove());
      clearTimeout(this.#stateTimer);
      this.connection.stop();
    };
  }

  async #init(): Promise<void> {
    // The service worker restarted, so a connection the popup would show is gone (BrowserMCP/mcp#192)
    const status = await connectionStatusItem.getValue();
    if (status.state === "connected") {
      await connectionStatusItem.setValue({ state: "searching" });
    }
    await Promise.all([
      this.debugger.detachStale().catch((error: unknown) => {
        console.warn("Couldn't detach from tabs", error);
      }),
      reconcileAppGroups().catch((error: unknown) => {
        console.warn("Couldn't restore the agents' tab groups", error);
      }),
    ]);
    await this.#updateBadge();
    this.connection.ensureRunning();
  }

  // --- The daemon ---

  /** `code`: the pairing code the connection agreed on with the daemon, for a key the user didn't allow; null for one they did */
  async #onWelcome(
    welcome: Welcome,
    port: number,
    code: string | null,
  ): Promise<void> {
    const { publicKey, daemonVersion, protocol } = welcome;
    const paired = code === null;
    this.#daemon = { publicKey, code, paired };
    await this.#setStatus({
      state: "connected",
      port,
      daemonVersion,
      publicKey,
      ...(code !== null && { code }),
      pairing: paired ? "paired" : "pending",
    });
    this.#report("daemon connected", {
      protocol,
      daemonVersion,
      paired,
    });
    await this.#updateBadge();
    await this.#sendState();
  }

  async #handleRequest(request: ExtensionRequest): Promise<unknown> {
    const daemon = this.#daemon;
    if (!daemon?.paired) {
      throw new Error(pairingRequiredMessage(daemon?.code ?? undefined));
    }
    switch (request.method) {
      case "detach":
        return this.debugger.detach(request.params.tabId);
      case "activity":
        await lastActiveAppItem.setValue(request.params.appId);
        await this.#updateBadge();
        // Each batch of agent actions that worked counts towards asking for a review
        await this.#reportActivity();
        return;
    }
    if (await pausedItem.getValue()) {
      throw new Error(PAUSED_MESSAGE);
    }
    switch (request.method) {
      case "attach": {
        const { tabId } = request.params;
        await this.#requireExposedTab(tabId);
        // Again once attached: Stop or a navigation may have come meanwhile
        return this.debugger.attach(tabId, async () => {
          if (await pausedItem.getValue()) {
            throw new Error(PAUSED_MESSAGE);
          }
          await this.#requireExposedTab(tabId);
        });
      }
      case "cdp": {
        const { method, params } = request.params;
        const denied = getDeniedCdpMessage(method);
        if (denied) {
          throw new Error(denied);
        }
        const url = getNavigationUrl(method, params);
        if (url !== null) {
          await this.#requireAllowedUrl(url);
        }
        return this.debugger.send(request.params);
      }
      case "createTab":
        return this.#createTab(request.params.url, request.params.app);
      case "closeTab":
        await this.#requireExposedTab(request.params.tabId);
        await browser.tabs.remove(request.params.tabId);
        return;
      case "activateTab": {
        const tab = await this.#requireExposedTab(request.params.tabId);
        await focusTab(tab);
        return;
      }
      case "groupTab":
        await this.#requireExposedTab(request.params.tabId);
        await groupTab(request.params.tabId, request.params.app);
        this.#scheduleState();
        return;
    }
    throw new Error(
      `Unknown request: ${(request as { method: string }).method}`,
    );
  }

  /** Throws a message for the model unless agents may open the URL */
  async #requireAllowedUrl(url: string): Promise<void> {
    const rules = await getExposureRules();
    if (!isExposedUrl(url, rules.fileAccess)) {
      throw new Error(`Agents can't open ${url}: it's a browser page`);
    }
  }

  async #createTab(url = "about:blank", app: AppInfo) {
    await this.#requireAllowedUrl(url);
    const tabId = await openAgentTab(url, app.id);
    await groupTab(tabId, app);
    this.#scheduleState();
    return { tabId };
  }

  /** The tab, if agents may use it; throws a message for the model otherwise */
  async #requireExposedTab(tabId: number): Promise<Browser.tabs.Tab> {
    const tab = await browser.tabs.get(tabId).catch(() => null);
    if (!tab) {
      throw new Error(`Tab ${tabId} doesn't exist`);
    }
    const [rules, window] = await Promise.all([
      getExposureRules(),
      browser.windows.get(tab.windowId).catch(() => null),
    ]);
    if (isExposedTab(tab, rules)) {
      // Only normal windows' tabs are reported; the debugger can't attach in popups
      if (window?.type !== "normal") {
        throw new Error(
          `Agents can't use tab ${tabId}: it isn't in a normal window`,
        );
      }
      return tab;
    }
    throw new Error(
      `Agents can't use tab ${tabId}: ${
        tab.incognito && !rules.incognitoAccess
          ? "it's incognito, and the extension isn't allowed in incognito"
          : "it's discarded or a browser page"
      }`,
    );
  }

  async #setStatus(status: ConnectionStatus): Promise<void> {
    const previous = await connectionStatusItem.getValue();
    if (JSON.stringify(previous) === JSON.stringify(status)) {
      return;
    }
    await connectionStatusItem.setValue(status);
    if (
      status.state !== previous.state &&
      status.state !== "connected" &&
      status.state !== "searching"
    ) {
      this.#report("daemon connection failed", {
        reason: status.state,
        ...("daemonVersion" in status && {
          daemonVersion: status.daemonVersion,
        }),
      });
    }
  }

  async #setLegacyServer(present: boolean): Promise<void> {
    if ((await legacyServerItem.getValue()) === present) {
      return;
    }
    await legacyServerItem.setValue(present);
    if (present) {
      this.#report("daemon connection failed", { reason: "outdatedServer" });
    }
    await this.#updateBadge();
  }

  /** Passes an event to `onEvent`, whose errors never get in the way of the connection */
  #report(event: BrowserControlEvent, properties?: object): void {
    try {
      this.#onEvent?.(event, properties);
    } catch (error) {
      console.warn(`Couldn't report "${event}"`, error);
    }
  }

  /** Calls `onActivity`, whose errors never fail the daemon's `activity` request: the agent's actions worked */
  async #reportActivity(): Promise<void> {
    try {
      await this.#onActivity?.();
    } catch (error) {
      console.warn("Couldn't report activity", error);
    }
  }

  // --- Events ---

  /** Sends an event to the daemon, if it's connected and paired */
  #emit(event: ExtensionEvent): void {
    if (this.#daemon?.paired) {
      this.connection.sendEvent(event);
    }
  }

  async #onDebuggerDetach(tabId: number, reason: string): Promise<void> {
    this.#emit({ type: "detached", data: { tabId, reason } });
    // Cancel on Chrome's debugging bar: the user wants every agent to stop
    if (reason === "canceled_by_user") {
      await this.stop();
    }
  }

  async #onTabUpdated(
    tabId: number,
    changeInfo: Browser.tabs.OnUpdatedInfo,
  ): Promise<void> {
    if ("groupId" in changeInfo || "pinned" in changeInfo) {
      const assignment = await updateTabAssignment(tabId);
      if (assignment) {
        this.#emit({ type: "tabAssigned", data: assignment });
      }
    }
    if (changeInfo.url !== undefined || changeInfo.discarded) {
      await this.#enforceRules();
    }
    if (STATE_CHANGES.some((key) => key in changeInfo)) {
      this.#scheduleState();
    }
  }

  async #onTabRemoved(tabId: number): Promise<void> {
    await forgetTab(tabId);
    this.#scheduleState();
  }

  /** Detaches from attached tabs agents may no longer use: a tab that navigated to a browser page */
  async #enforceRules(): Promise<void> {
    const rules = await getExposureRules();
    await Promise.all(
      [...this.debugger.attachedTabIds].map(async (tabId) => {
        const tab = await browser.tabs.get(tabId).catch(() => null);
        if (!tab) {
          return;
        }
        if (!isExposedTab(tab, rules)) {
          await this.#detachForRules(tabId);
        }
      }),
    );
    this.#scheduleState();
  }

  async #detachForRules(tabId: number): Promise<void> {
    if (!this.debugger.isAttached(tabId)) {
      return;
    }
    await this.debugger.detach(tabId);
    this.#emit({
      type: "detached",
      data: { tabId, reason: "not_allowed" },
    });
  }

  /**
   * An attached tab starts loading a page: detaches before a browser page commits, rather than after (`tabs.onUpdated`), so the daemon gets none of it
   */
  async #onBeforeNavigate({
    tabId,
    frameId,
    url,
  }: Browser.webNavigation.WebNavigationBaseCallbackDetails): Promise<void> {
    if (frameId !== 0 || !this.debugger.isAttached(tabId)) {
      return;
    }
    const rules = await getExposureRules();
    if (!isExposedUrl(url, rules.fileAccess)) {
      await this.#detachForRules(tabId);
      this.#scheduleState();
    }
  }

  /**
   * A page opened a tab (`target=_blank`, `window.open`). `openerTabId` can be null, so this comes from `webNavigation.onCreatedNavigationTarget`. Reported only for openers agents use; a popup window is moved into a normal window first, since the debugger can't attach in popups, and the tab joins its opener's group
   */
  async #onTabOpened({
    sourceTabId,
    tabId,
    url,
  }: Browser.webNavigation.WebNavigationSourceCallbackDetails): Promise<void> {
    if (!this.#daemon?.paired || (await pausedItem.getValue())) {
      return;
    }
    const groups = await appGroupsItem.getValue();
    const appId = groups.tabApps[sourceTabId];
    if (!this.debugger.isAttached(sourceTabId) && !appId) {
      return;
    }
    const [opener, tab] = await Promise.all([
      browser.tabs.get(sourceTabId).catch(() => null),
      browser.tabs.get(tabId).catch(() => null),
    ]);
    if (!opener || !tab) {
      return;
    }
    // Before moving anything: tabs agents may not use stay where they are
    const rules = await getExposureRules();
    if (!isExposedUrl(url, rules.fileAccess)) {
      return;
    }
    const window = await browser.windows.get(tab.windowId).catch(() => null);
    if (window?.type === "popup") {
      await moveIntoWindow(tabId, opener.windowId).catch((error: unknown) => {
        console.warn("Couldn't move a popup into a window", error);
      });
    }
    const app = appId && groups.apps[appId];
    if (app) {
      await groupTab(tabId, { id: appId, name: app.name }).catch(
        (error: unknown) => {
          console.warn("Couldn't group an opened tab", error);
        },
      );
    }
    this.#emit({
      type: "tabOpened",
      data: { tabId, openerTabId: sourceTabId, url },
    });
  }

  #scheduleState(): void {
    if (this.#stateTimer !== undefined) {
      return;
    }
    this.#stateTimer = setTimeout(() => {
      this.#stateTimer = undefined;
      void this.#sendState();
    }, STATE_DEBOUNCE_MS);
  }

  async #sendState(): Promise<void> {
    if (!this.#daemon) {
      return;
    }
    this.connection.sendEvent({ type: "state", data: await this.getState() });
  }

  /** What the extension reports to the daemon: nothing until the user allowed its key */
  async getState(): Promise<ExtensionState> {
    const paused = await pausedItem.getValue();
    if (!this.#daemon?.paired) {
      return { tabs: [], paused, pairing: "pending" };
    }
    const [tabs, rules, groups] = await Promise.all([
      browser.tabs.query({ windowType: "normal" }),
      getExposureRules(),
      appGroupsItem.getValue(),
    ]);
    return {
      paused,
      pairing: "paired",
      tabs: tabs
        .filter((tab) => isExposedTab(tab, rules))
        .map((tab) => ({
          tabId: tab.id!,
          windowId: tab.windowId,
          url: getTabUrl(tab),
          title: tab.title ?? "",
          active: tab.active,
          pinned: tab.pinned,
          ...(groups.tabApps[tab.id!] && { appId: groups.tabApps[tab.id!] }),
          attached: this.debugger.isAttached(tab.id!),
        })),
    };
  }

  async #updateBadge(): Promise<void> {
    const [legacyServer, lastActiveApp, groups] = await Promise.all([
      legacyServerItem.getValue(),
      lastActiveAppItem.getValue(),
      appGroupsItem.getValue(),
    ]);
    await updateBadge({
      pairingPending: this.#daemon !== null && !this.#daemon.paired,
      legacyServer,
      attachedCount: this.debugger.attachedTabIds.size,
      color: (lastActiveApp && groups.apps[lastActiveApp]?.color) || null,
    });
  }

  // --- The popup ---

  /** **Stop**: detaches every tab, so Chrome's debugging bar goes away, and refuses agents' commands until **Resume**. Never closes tabs */
  async stop(): Promise<void> {
    await pausedItem.setValue(true);
    const tabIds = [...this.debugger.attachedTabIds];
    await this.debugger.detachAll();
    for (const tabId of tabIds) {
      this.#emit({ type: "detached", data: { tabId, reason: "paused" } });
    }
    await this.#sendState();
  }

  async resume(): Promise<void> {
    await pausedItem.setValue(false);
    await this.#sendState();
  }

  /** **Allow**: trusts the connected daemon's key from now on */
  async allow(publicKey: string): Promise<void> {
    const daemon = this.#daemon;
    if (!daemon || daemon.publicKey !== publicKey) {
      throw new Error("This Browser MCP server is no longer connected");
    }
    await addPairedKey(publicKey);
    daemon.paired = true;
    const status = await connectionStatusItem.getValue();
    if (status.state === "connected") {
      await this.#setStatus({ ...status, pairing: "paired" });
    }
    this.#report("daemon paired");
    await this.#updateBadge();
    await this.#sendState();
  }

  /** Sets the port to look for the daemon on (the one given to its `--port`), or `null` for `RELAY_PORTS`, and looks again */
  async setRelayPort(port: number | null): Promise<void> {
    if (port !== null && !isValidRelayPort(port)) {
      throw new Error(`Invalid port: ${port}`);
    }
    await relayPortItem.setValue(port);
    this.connection.reconnect();
  }

  async switchToTab(tabId: number): Promise<void> {
    await focusTab(await browser.tabs.get(tabId));
  }

  /** What the popup shows */
  async getView(): Promise<BrowserControlView> {
    const [connection, legacyServer, paused, groups, relayPort] =
      await Promise.all([
        connectionStatusItem.getValue(),
        legacyServerItem.getValue(),
        pausedItem.getValue(),
        appGroupsItem.getValue(),
        relayPortItem.getValue(),
      ]);
    const tabs = await browser.tabs.query({});
    const tabsById = new Map(tabs.map((tab) => [tab.id, tab]));

    const apps: BrowserControlApp[] = Object.entries(groups.apps)
      .map(([id, app]) => ({
        id,
        name: app.name,
        color: app.color,
        tabs: Object.entries(groups.tabApps)
          .filter(([, appId]) => appId === id)
          .flatMap(([tabId]) => {
            const tab = tabsById.get(Number(tabId));
            return tab
              ? [
                  {
                    tabId: Number(tabId),
                    title: tab.title || getTabUrl(tab),
                    url: getTabUrl(tab),
                    attached: this.debugger.isAttached(Number(tabId)),
                  },
                ]
              : [];
          }),
      }))
      .filter((app) => app.tabs.length > 0);

    return {
      connection,
      legacyServer,
      paused,
      relayPort,
      apps,
    };
  }
}

async function getExposureRules(): Promise<ExposureRules> {
  const fileAccess = await browser.extension
    .isAllowedFileSchemeAccess()
    .then(Boolean)
    .catch(() => false);
  const incognitoAccess = await browser.extension
    .isAllowedIncognitoAccess()
    .then(Boolean)
    .catch(() => false);
  return { fileAccess, incognitoAccess };
}

/**
 * Moves a tab out of a popup window into the opener's window. Chrome moves tabs only between normal windows, so a popup's tab first goes into a new normal window of its own (`windows.create({ tabId })`), which closes once it's moved on
 */
async function moveIntoWindow(tabId: number, windowId: number): Promise<void> {
  try {
    await browser.tabs.move(tabId, { windowId, index: -1 });
  } catch {
    await browser.windows.create({ tabId, type: "normal", focused: false });
    await browser.tabs.move(tabId, { windowId, index: -1 });
  }
}

async function focusTab(tab: Browser.tabs.Tab): Promise<void> {
  await Promise.all([
    browser.tabs.update(tab.id!, { active: true }),
    browser.windows.update(tab.windowId, { focused: true }),
  ]);
}

function addListener<Listener extends (...args: never[]) => unknown>(
  event: {
    addListener: (listener: Listener) => void;
    removeListener: (listener: Listener) => void;
  },
  listener: Listener,
): () => void {
  event.addListener(listener);
  return () => event.removeListener(listener);
}

/** The browser's name and version, e.g. `Chrome` and `142.0.0.0`, from `navigator.userAgentData` (Chromium only) */
function getBrowserInfo(): BrowserInfo {
  const userAgentData = (
    navigator as Navigator & {
      userAgentData?: { brands: { brand: string; version: string }[] };
    }
  ).userAgentData;
  const brands = userAgentData?.brands ?? [];
  const brand =
    brands.find(({ brand }) => !/not.?a.?brand|chromium/i.test(brand)) ??
    brands.find(({ brand }) => /chromium/i.test(brand));
  return {
    name: brand?.brand.replace(/^(Google|Microsoft) /, "") ?? "Chromium",
    version: brand?.version ?? "",
    userAgent: navigator.userAgent,
  };
}
