/**
 * A stand-in for the Browser MCP extension in tests: real headless Chromium, driven over a raw browser-level CDP WebSocket (as `chrome.debugger` would), connected to the daemon's `/extension` like the real extension. See the README's "Testing".
 *
 * ```ts
 * const chromium = await FakeChromium.launch();
 * const extension = await FakeExtension.connect({ port, chromium });
 * const tabId = await extension.openTab("https://example.com");
 * // ...drive the daemon (backend.page(tabId), tool calls)...
 * await extension.close();
 * await chromium.close();
 * ```
 */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium as playwrightChromium } from "playwright-core";
import WebSocket from "ws";

import {
  type AppInfo,
  CHROME_WEB_STORE_EXTENSION_ID,
  type DaemonMessage,
  type ExposedTab,
  type ExtensionEvent,
  type ExtensionMessage,
  type ExtensionRequest,
  type ExtensionState,
  PAIRING_KEY_ALGORITHM,
  RELAY_PROTOCOL_VERSION,
  RelayPaths,
  createPairingNonce,
  pairingCode,
  pairingCommitment,
  pairingPayload,
  pairingRequiredMessage,
} from "@browsermcp/protocol";

type CdpFrame = {
  id?: number;
  sessionId?: string;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { message: string };
};

/** Headless Chromium launched with a debugging port, and one raw CDP connection to its browser target */
export class FakeChromium {
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (result: never) => void; reject: (error: Error) => void }
  >();
  private listeners = new Set<(frame: CdpFrame) => void>();
  private tabIds = new Map<string, number>();

  private constructor(
    private readonly process: ChildProcess,
    private readonly ws: WebSocket,
    private readonly userDataDir: string,
  ) {
    ws.on("message", (data) => {
      const frame: CdpFrame = JSON.parse(data.toString());
      if (frame.id !== undefined) {
        const pending = this.pending.get(frame.id);
        this.pending.delete(frame.id);
        if (frame.error) {
          pending?.reject(new Error(frame.error.message));
        } else {
          pending?.resolve(frame.result as never);
        }
        return;
      }
      for (const listener of this.listeners) {
        listener(frame);
      }
    });
  }

  static async launch(): Promise<FakeChromium> {
    const userDataDir = mkdtempSync(
      path.join(tmpdir(), "browsermcp-chromium-"),
    );
    const child = spawn(
      playwrightChromium.executablePath(),
      [
        "--headless=new",
        "--remote-debugging-port=0",
        `--user-data-dir=${userDataDir}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-gpu",
        "about:blank",
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    const endpoint = await new Promise<string>((resolve, reject) => {
      let output = "";
      const timeout = setTimeout(
        () => reject(new Error(`Chromium didn't start:\n${output}`)),
        20_000,
      );
      child.stderr!.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        const match = output.match(/DevTools listening on (ws:\/\/\S+)/);
        if (match) {
          clearTimeout(timeout);
          resolve(match[1]!);
        }
      });
      child.once("exit", () =>
        reject(new Error(`Chromium exited:\n${output}`)),
      );
    });
    const ws = new WebSocket(endpoint, { perMessageDeflate: false });
    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    return new FakeChromium(child, ws, userDataDir);
  }

  send<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<T> {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((resolve, reject) =>
      this.pending.set(id, {
        resolve: resolve as (result: never) => void,
        reject,
      }),
    );
  }

  /** A stable tab ID for a page target, like Chrome's tab IDs, so extensions that reconnect agree on them */
  tabId(targetId: string): number {
    let tabId = this.tabIds.get(targetId);
    if (tabId === undefined) {
      tabId = this.tabIds.size + 1;
      this.tabIds.set(targetId, tabId);
    }
    return tabId;
  }

  onEvent(listener: (frame: CdpFrame) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async close() {
    this.ws.close();
    if (this.process.exitCode === null) {
      const exited = new Promise((resolve) =>
        this.process.once("exit", resolve),
      );
      this.process.kill();
      await exited;
    }
    rmSync(this.userDataDir, { recursive: true, force: true });
  }
}

type FakeTab = {
  tabId: number;
  targetId: string;
  windowId: number;
  url: string;
  title: string;
  pinned: boolean;
  appId?: string;
  /** The debugger session (`Target.attachToTarget` with `flatten`) while attached */
  sessionId?: string;
};

export type FakeExtensionOptions = {
  /** The daemon's relay port */
  port: number;
  chromium: FakeChromium;
  /** Sent as `chrome-extension://<id>`. Default: `CHROME_WEB_STORE_EXTENSION_ID` */
  extensionId?: string;
  protocol?: number;
  /** `pending` waits for `allow()`, as the real extension does for a daemon key it doesn't know, after exchanging nonces for the pairing code (`pairingNonce`, `pairingReveal`). Default: `paired` */
  pairing?: ExtensionState["pairing"];
  /** With `pairing: "pending"`, whether `connect()` sends `pairingNonce` and waits for the daemon's reveal. `false` stays pending without a code, as in the moment before the real extension sends its nonce. Default: true */
  pairingNonce?: boolean;
  /** How long tab changes are gathered before `state` is sent (the real extension's is 100 ms). Default: 10 ms */
  stateDelayMs?: number;
  /** Sent in `hello`, to tell browsers apart. Default: the Chromium's */
  userAgent?: string;
};

/**
 * Speaks the extension's side of `@browsermcp/protocol`: answers `attach`, `detach`, `cdp` (with child sessions), `createTab`, `closeTab`, `activateTab`, `groupTab` and `activity` on the real Chromium, and sends `cdpEvent`, `detached`, `state` and `tabOpened`. Test helpers simulate the user: `allow()`, `pause()`, `cancel()`, `assign()`
 */
export class FakeExtension {
  /** Every request the daemon sent, in order */
  readonly requests: ExtensionRequest[] = [];
  readonly tabs = new Map<number, FakeTab>();
  paused = false;
  pairing: ExtensionState["pairing"];
  welcome!: Extract<DaemonMessage, { type: "welcome" }>;
  readonly challenge = Buffer.from(
    crypto.getRandomValues(new Uint8Array(32)),
  ).toString("base64");
  /** Resolves with the close code and reason when the daemon closes the connection */
  readonly closed: Promise<{ code: number; reason: string }>;
  /** The port it dialed, which the daemon's signature must name */
  port = 0;
  /** Whether it answers the daemon's pings and requests (false: like a stuck service worker) */
  answering = true;
  /** The nonce it sent in `pairingNonce`, if it did */
  pairingNonce: string | null = null;
  /** The daemon's nonce from `pairingReveal`, if it was revealed */
  daemonNonce: string | null = null;
  /** The code the popup would show next to **Allow** (`pairingCode()`), once the nonces were exchanged and the reveal matched the commitment */
  code: string | null = null;
  private revealWaiter: ((nonce: string) => void) | null = null;

  private sessionTabs = new Map<string, number>();
  private expectedDetaches = new Set<string>();
  private inputQueues = new Map<number, Promise<unknown>>();
  private stateTimer: NodeJS.Timeout | undefined;
  private stateDelayMs = 10;
  private tabWaiters = new Map<string, (tab: FakeTab) => void>();
  private offChromium: () => void;
  private ws!: WebSocket;

  private constructor(
    readonly chromium: FakeChromium,
    pairing: ExtensionState["pairing"],
    closed: Promise<{ code: number; reason: string }>,
  ) {
    this.pairing = pairing;
    this.closed = closed;
    this.offChromium = chromium.onEvent((frame) => this.onChromiumEvent(frame));
  }

  /** Connects to the daemon and waits for `welcome`. Rejects with the close code if the daemon closes the connection instead */
  static async connect(options: FakeExtensionOptions): Promise<FakeExtension> {
    const ws = new WebSocket(
      `ws://127.0.0.1:${options.port}${RelayPaths.extension}`,
      {
        origin: `chrome-extension://${options.extensionId ?? CHROME_WEB_STORE_EXTENSION_ID}`,
      },
    );
    const closed = new Promise<{ code: number; reason: string }>((resolve) =>
      ws.once("close", (code, reason) =>
        resolve({ code, reason: reason.toString() }),
      ),
    );
    const extension = new FakeExtension(
      options.chromium,
      options.pairing ?? "paired",
      closed,
    );
    extension.ws = ws;
    extension.port = options.port;
    extension.stateDelayMs = options.stateDelayMs ?? 10;
    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    await options.chromium.send("Target.setDiscoverTargets", {
      discover: true,
    });
    const { targetInfos } = await options.chromium.send<{
      targetInfos: {
        targetId: string;
        type: string;
        url: string;
        title: string;
      }[];
    }>("Target.getTargets");
    for (const info of targetInfos) {
      extension.addTarget(info);
    }
    const version = await options.chromium.send<{
      product: string;
      userAgent: string;
    }>("Browser.getVersion");

    const welcome = new Promise<FakeExtension["welcome"]>((resolve, reject) => {
      ws.once("message", (data) => resolve(JSON.parse(data.toString())));
      void closed.then(({ code, reason }) =>
        reject(new Error(`Closed ${code} ${reason}`)),
      );
    });
    extension.post({
      type: "hello",
      protocol: options.protocol ?? RELAY_PROTOCOL_VERSION,
      extensionVersion: "2.0.0-test",
      browser: {
        name: "Chrome",
        version: version.product.split("/")[1] ?? "",
        userAgent: options.userAgent ?? version.userAgent,
      },
      capabilities: ["tabOpened"],
      challenge: extension.challenge,
      state: extension.state(),
    });
    extension.welcome = await welcome;
    ws.on("message", (data) => void extension.onDaemonMessage(data.toString()));
    if (extension.pairing === "pending" && options.pairingNonce !== false) {
      await extension.exchangePairingNonces();
    }
    return extension;
  }

  /** Sends `pairingNonce` and waits for the daemon's `pairingReveal`, as the real extension does for a key it doesn't know. Sets `code` if the reveal matches `welcome`'s commitment; throws if it doesn't */
  async exchangePairingNonces(): Promise<void> {
    const nonce = createPairingNonce();
    const revealed = new Promise<string>((resolve, reject) => {
      this.revealWaiter = resolve;
      void this.closed.then(({ code, reason }) =>
        reject(new Error(`Closed ${code} ${reason}`)),
      );
    });
    this.pairingNonce = nonce;
    this.post({ type: "pairingNonce", nonce });
    const daemonNonce = await revealed;
    this.daemonNonce = daemonNonce;
    if (
      (await pairingCommitment(daemonNonce)) !== this.welcome.pairingCommitment
    ) {
      throw new Error("The daemon's reveal doesn't match its commitment");
    }
    this.code = await pairingCode(this.welcome.publicKey, nonce, daemonNonce);
  }

  /** Sends a raw frame, e.g. a second `pairingNonce` */
  postRaw(message: ExtensionMessage) {
    this.post(message);
  }

  /** Verifies the daemon's signature of the challenge and the port it dialed with WebCrypto, as the real extension does */
  async verifyWelcome(): Promise<boolean> {
    const key = await crypto.subtle.importKey(
      "spki",
      Buffer.from(this.welcome.publicKey, "base64"),
      {
        name: PAIRING_KEY_ALGORITHM.name,
        namedCurve: PAIRING_KEY_ALGORITHM.namedCurve,
      },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      { name: PAIRING_KEY_ALGORITHM.name, hash: PAIRING_KEY_ALGORITHM.hash },
      key,
      Buffer.from(this.welcome.signature, "base64"),
      new TextEncoder().encode(
        pairingPayload(
          this.challenge,
          this.port,
          this.welcome.pairingCommitment,
        ),
      ),
    );
  }

  // --- The user ---

  /** Opens a tab as the user would (in the foreground), resolving its tab ID */
  async openTab(url: string): Promise<number> {
    const { targetId } = await this.chromium.send<{ targetId: string }>(
      "Target.createTarget",
      { url },
    );
    return (await this.tabForTarget(targetId)).tabId;
  }

  /** Clicks **Allow** in the popup */
  allow() {
    this.pairing = "paired";
    this.sendState();
  }

  /** **Stop** (true) or **Resume** (false): Stop releases every tab */
  async pause(paused = true) {
    this.paused = paused;
    if (paused) {
      await this.detachAll();
    }
    this.sendState();
  }

  /** Cancel on Chrome's debugging bar: every tab detaches with `canceled_by_user`, and agents pause */
  async cancel() {
    const attached = [...this.tabs.values()].filter((tab) => tab.sessionId);
    await this.detachAll();
    for (const tab of attached) {
      this.event({
        type: "detached",
        data: { tabId: tab.tabId, reason: "canceled_by_user" },
      });
    }
    this.paused = true;
    this.sendState();
  }

  /** Drags a tab into an app's group, or out with `null` */
  assign(tabId: number, appId: string | null) {
    this.tabs.get(tabId)!.appId = appId ?? undefined;
    this.event({ type: "tabAssigned", data: { tabId, appId } });
    this.sendState();
  }

  /** Sends a raw event, e.g. a `detached` with another reason */
  event(event: ExtensionEvent) {
    // Like the real extension, nothing before `welcome`: the daemon closes a connection whose first message isn't `hello`. Reconnecting, `connect()` adds the browser's targets before `hello`, and an opener listed before its child would send `tabOpened`
    if (!this.welcome) return;
    this.post({ type: "event", event });
  }

  /** The state the extension would report now */
  state(): ExtensionState {
    const tabs: ExposedTab[] =
      this.pairing === "pending"
        ? []
        : [...this.tabs.values()]
            .filter(
              (tab) => !/^(chrome|devtools|chrome-extension):/.test(tab.url),
            )
            .map((tab) => ({
              tabId: tab.tabId,
              windowId: tab.windowId,
              url: tab.url,
              title: tab.title,
              active: false,
              pinned: tab.pinned,
              appId: tab.appId,
              attached: !!tab.sessionId,
            }));
    return { tabs, paused: this.paused, pairing: this.pairing };
  }

  /** Closes the connection (like the service worker stopping); the daemon releases the tabs */
  async disconnect() {
    clearTimeout(this.stateTimer);
    this.ws.close();
    await this.closed;
    // The real extension keeps no debugger attachments across reconnects
    this.offChromium();
    await this.detachAll();
  }

  async close() {
    this.offChromium();
    if (this.ws.readyState === WebSocket.OPEN) {
      await this.disconnect();
    }
    await this.detachAll().catch(() => {});
  }

  // --- The daemon's requests ---

  private async onDaemonMessage(raw: string) {
    const message: DaemonMessage = JSON.parse(raw);
    if (message.type === "pairingReveal") {
      this.revealWaiter?.(message.nonce);
      this.revealWaiter = null;
      return;
    }
    if (!this.answering) {
      if (message.type === "request") {
        const { id: _id, type: _type, ...request } = message;
        this.requests.push(request as ExtensionRequest);
      }
      return;
    }
    if (message.type === "ping") {
      this.post({ type: "pong", id: message.id });
      return;
    }
    if (message.type !== "request") {
      return;
    }
    const { id, type: _type, ...request } = message;
    this.requests.push(request as ExtensionRequest);
    try {
      const result = await this.handle(request as ExtensionRequest);
      this.post({ type: "response", id, result });
    } catch (error) {
      this.post({
        type: "response",
        id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async handle(request: ExtensionRequest): Promise<unknown> {
    if (this.pairing === "pending") {
      throw new Error(pairingRequiredMessage(this.code ?? undefined));
    }
    switch (request.method) {
      case "attach": {
        if (this.paused) {
          throw new Error("The user paused Browser MCP");
        }
        const tab = this.tab(request.params.tabId);
        if (!tab.sessionId) {
          const { sessionId } = await this.chromium.send<{ sessionId: string }>(
            "Target.attachToTarget",
            { targetId: tab.targetId, flatten: true },
          );
          tab.sessionId = sessionId;
          this.sessionTabs.set(sessionId, tab.tabId);
          this.sendState();
        }
        const { targetInfo } = await this.chromium.send<{
          targetInfo: Record<string, unknown>;
        }>("Target.getTargetInfo", { targetId: tab.targetId });
        return { targetInfo };
      }
      case "detach": {
        const tab = this.tabs.get(request.params.tabId);
        if (tab?.sessionId) {
          await this.detachTab(tab);
          this.sendState();
        }
        return undefined;
      }
      case "cdp": {
        const { tabId, sessionId, method, params } = request.params;
        const tab = this.tab(tabId);
        if (!tab.sessionId) {
          throw new Error(`The debugger isn't attached to tab ${tabId}`);
        }
        const send = () =>
          this.chromium.send(method, params ?? {}, sessionId ?? tab.sessionId);
        if (!method.startsWith("Input.")) {
          return await send();
        }
        // The real extension runs `Input.*` one at a time per tab
        const previous = this.inputQueues.get(tabId) ?? Promise.resolve();
        const next = previous.catch(() => {}).then(send);
        this.inputQueues.set(tabId, next);
        return await next;
      }
      case "createTab": {
        const { targetId } = await this.chromium.send<{ targetId: string }>(
          "Target.createTarget",
          { url: request.params.url ?? "about:blank", background: true },
        );
        const tab = await this.tabForTarget(targetId);
        tab.appId = request.params.app.id;
        this.sendState();
        return { tabId: tab.tabId };
      }
      case "closeTab":
        await this.chromium.send("Target.closeTarget", {
          targetId: this.tab(request.params.tabId).targetId,
        });
        return undefined;
      case "activateTab":
        await this.chromium.send("Target.activateTarget", {
          targetId: this.tab(request.params.tabId).targetId,
        });
        return undefined;
      case "groupTab":
        this.tab(request.params.tabId).appId =
          (request.params.app as AppInfo | null)?.id ?? undefined;
        this.sendState();
        return undefined;
      case "activity":
        return undefined;
    }
  }

  // --- Chromium ---

  private onChromiumEvent(frame: CdpFrame) {
    const params = frame.params ?? {};
    if (frame.sessionId) {
      const tabId = this.sessionTabs.get(frame.sessionId);
      if (tabId === undefined) {
        return;
      }
      const tab = this.tabs.get(tabId);
      const childSessionId = params.sessionId as string | undefined;
      if (frame.method === "Target.attachedToTarget" && childSessionId) {
        this.sessionTabs.set(childSessionId, tabId);
      } else if (
        frame.method === "Target.detachedFromTarget" &&
        childSessionId
      ) {
        this.sessionTabs.delete(childSessionId);
      }
      this.event({
        type: "cdpEvent",
        data: {
          tabId,
          sessionId:
            frame.sessionId === tab?.sessionId ? undefined : frame.sessionId,
          method: frame.method!,
          params,
        },
      });
      return;
    }
    switch (frame.method) {
      case "Target.targetCreated":
        this.addTarget(params.targetInfo as never);
        return;
      case "Target.targetInfoChanged": {
        const info = params.targetInfo as {
          targetId: string;
          url: string;
          title: string;
        };
        const tab = this.findTab(info.targetId);
        if (tab) {
          tab.url = info.url;
          tab.title = info.title;
          this.sendState();
        }
        return;
      }
      case "Target.targetDestroyed": {
        const tab = this.findTab(params.targetId as string);
        if (tab) {
          this.tabs.delete(tab.tabId);
          this.sendState();
        }
        return;
      }
      case "Target.detachedFromTarget": {
        const sessionId = params.sessionId as string;
        const tabId = this.sessionTabs.get(sessionId);
        this.sessionTabs.delete(sessionId);
        if (this.expectedDetaches.delete(sessionId) || tabId === undefined) {
          return;
        }
        const tab = this.tabs.get(tabId);
        if (tab?.sessionId === sessionId) {
          tab.sessionId = undefined;
          this.event({
            type: "detached",
            data: { tabId, reason: "target_closed" },
          });
          this.sendState();
        }
        return;
      }
    }
  }

  private addTarget(info: {
    targetId: string;
    type: string;
    url: string;
    title: string;
    openerId?: string;
  }) {
    if (info.type !== "page" || this.findTab(info.targetId)) {
      return;
    }
    const tab: FakeTab = {
      tabId: this.chromium.tabId(info.targetId),
      targetId: info.targetId,
      windowId: 1,
      url: info.url,
      title: info.title,
      pinned: false,
    };
    this.tabs.set(tab.tabId, tab);
    this.tabWaiters.get(info.targetId)?.(tab);
    this.tabWaiters.delete(info.targetId);
    const opener = info.openerId ? this.findTab(info.openerId) : undefined;
    if (opener && this.ws?.readyState === WebSocket.OPEN) {
      tab.appId = opener.appId;
      this.event({
        type: "tabOpened",
        data: { tabId: tab.tabId, openerTabId: opener.tabId, url: info.url },
      });
    }
    this.sendState();
  }

  private tabForTarget(targetId: string): Promise<FakeTab> {
    const tab = this.findTab(targetId);
    if (tab) {
      return Promise.resolve(tab);
    }
    return new Promise((resolve) => this.tabWaiters.set(targetId, resolve));
  }

  private findTab(targetId: string): FakeTab | undefined {
    return [...this.tabs.values()].find((tab) => tab.targetId === targetId);
  }

  private tab(tabId: number): FakeTab {
    const tab = this.tabs.get(tabId);
    if (!tab) {
      throw new Error(`No tab with id: ${tabId}.`);
    }
    return tab;
  }

  private async detachTab(tab: FakeTab) {
    const sessionId = tab.sessionId!;
    tab.sessionId = undefined;
    this.expectedDetaches.add(sessionId);
    this.sessionTabs.delete(sessionId);
    await this.chromium
      .send("Target.detachFromTarget", { sessionId })
      .catch(() => {});
  }

  private async detachAll() {
    for (const tab of this.tabs.values()) {
      if (tab.sessionId) {
        await this.detachTab(tab);
      }
    }
  }

  private sendState() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.welcome) {
      return;
    }
    clearTimeout(this.stateTimer);
    this.stateTimer = setTimeout(
      () => this.event({ type: "state", data: this.state() }),
      this.stateDelayMs,
    );
  }

  private post(message: ExtensionMessage) {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }
}
