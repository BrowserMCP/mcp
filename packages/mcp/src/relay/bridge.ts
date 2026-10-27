import type { RawData, WebSocket } from "ws";

import type {
  BrowserInfo,
  ExtensionEvent,
  ExtensionRequestMap,
} from "@browsermcp/protocol";

import type { ExtensionConnection } from "@/relay/extension-connection";
import type { Logger } from "@/utils/log";
import { errorMessage } from "@/utils/rpc";

type TargetInfo = ExtensionRequestMap["attach"]["result"]["targetInfo"];

/** A CDP frame between the bridge and its client (the daemon's Playwright) */
export type CdpMessage = {
  id?: number;
  sessionId?: string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { message: string; code?: number };
};

/** A session the client has on a tab: Playwright's (announced with the tab) or a raw one from `Target.attachToTarget` (`cdpSession()`) */
type ClientSession = {
  id: string;
  target: Target;
  /** Domains this session enabled, so one session disabling a domain doesn't turn it off under another */
  domains: Set<string>;
  /** The browser session (`Target.attachToBrowserTarget`) it was attached from, which gets its `Target.detachedFromTarget` */
  parentSessionId?: string;
};

/** A claimed tab: the debugger is attached and Playwright sees it as a target */
type Target = {
  tabId: number;
  targetInfo: TargetInfo;
  /** Playwright's session, announced with `Target.attachedToTarget` */
  primary: ClientSession;
  sessions: Map<string, ClientSession>;
  /** Chrome's own child sessions (out-of-process iframes, workers), which pass through */
  childSessions: Set<string>;
  /** Resolves when the target goes away, for commands that failed with "Detached while handling command" */
  gone: Promise<void>;
  markGone: () => void;
};

export type BridgeOptions = {
  log: Logger;
  /** The connected extension, if any */
  extension(): ExtensionConnection | null;
  /** A claimed tab went away by something other than `release()` */
  onReleased(tabId: number, reason: string): void;
  /** Delay before re-attaching after a detach other than `canceled_by_user` (Playwright's relay uses 150 ms) */
  reattachDelayMs?: number;
};

const REATTACH_COOLDOWN_MS = 3000;

/** Detaches that mean the agent may not use the tab now: Cancel on the debugging bar, Stop (per tab), and a browser page or discarded tab (`not_allowed`). Other detaches re-attach */
const NO_REATTACH_REASONS = new Set([
  "canceled_by_user",
  "paused",
  "not_allowed",
]);
const DETACH_GRACE_MS = 1000;
const DEFAULT_BROWSER_CONTEXT_ID = "browsermcp-default";

/**
 * The CDP bridge: a CDP endpoint for Playwright's `connectOverCDP` over the extension's `chrome.debugger`. It emulates `Browser.*` and `Target.*` (which `chrome.debugger` lacks), and only tabs claimed with `claim()` become targets. Target IDs are the real ones from the extension's `attach`
 */
export class CdpBridge {
  private client: WebSocket | null = null;
  private autoAttach = false;
  private targets = new Map<number, Target>();
  private claiming = new Map<number, Promise<Target>>();
  /** Tabs waiting to re-attach after a detach, which still count as claimed */
  private reattaching = new Map<number, Promise<Target | null>>();
  private lastReattach = new Map<number, number>();
  private sessions = new Map<string, ClientSession>();
  /** Sessions from `Target.attachToBrowserTarget` */
  private browserSessions = new Set<string>();
  private childSessionTargets = new Map<string, Target>();
  /** Per session (client or child): the pending `Page.getFrameTree` reply, which `Runtime.enable` waits for */
  private frameTrees = new Map<string, Promise<void>>();
  private nextSessionId = 1;

  constructor(private readonly options: BridgeOptions) {}

  isClaimed(tabId: number): boolean {
    return this.targets.has(tabId) || this.reattaching.has(tabId);
  }

  claimedTabs(): number[] {
    return [...new Set([...this.targets.keys(), ...this.reattaching.keys()])];
  }

  targetId(tabId: number): string | undefined {
    return this.targets.get(tabId)?.targetInfo.targetId;
  }

  /** Attaches the debugger (if needed) and announces the tab to the client. Idempotent */
  async claim(tabId: number): Promise<TargetInfo> {
    const reattaching = this.reattaching.get(tabId);
    if (reattaching) {
      await reattaching;
    }
    const existing = this.targets.get(tabId);
    if (existing) {
      return existing.targetInfo;
    }
    let claiming = this.claiming.get(tabId);
    if (!claiming) {
      claiming = this.attach(tabId).finally(() => this.claiming.delete(tabId));
      this.claiming.set(tabId, claiming);
    }
    return (await claiming).targetInfo;
  }

  /** Releases a claimed tab: the client sees it detach, and the debugger detaches. The tab stays open */
  async release(tabId: number): Promise<void> {
    const pending = this.claiming.get(tabId) ?? this.reattaching.get(tabId);
    this.reattaching.delete(tabId);
    await pending?.catch(() => {});
    if (!this.targets.has(tabId)) {
      return;
    }
    this.dropTarget(tabId);
    await this.options
      .extension()
      ?.request("detach", { tabId })
      .catch((error) => this.options.log(`Detaching tab ${tabId}:`, error));
  }

  /** Forgets every claimed tab, e.g. when the extension disconnected (its attachments went with it) */
  releaseAll(reason: string) {
    for (const tabId of this.claimedTabs()) {
      this.reattaching.delete(tabId);
      if (this.targets.has(tabId)) {
        this.dropTarget(tabId);
      }
      this.options.onReleased(tabId, reason);
    }
  }

  /** Accepts the client on `/cdp`. One at a time: a second one is refused */
  attachClient(ws: WebSocket) {
    if (this.client) {
      ws.close(1008, "Another CDP client is connected");
      return;
    }
    this.client = ws;
    ws.on("message", (data) => this.onClientMessage(data));
    ws.on("close", () => {
      if (this.client !== ws) {
        return;
      }
      this.client = null;
      this.autoAttach = false;
      this.browserSessions.clear();
      // A new client would enable domains Chrome already has on, and never get their initial events (e.g. execution contexts), so start over
      for (const tabId of this.claimedTabs()) {
        void this.release(tabId);
        this.options.onReleased(tabId, "disconnected");
      }
    });
  }

  /** Handles the extension's CDP events, detaches and state */
  onExtensionEvent(event: ExtensionEvent) {
    switch (event.type) {
      case "cdpEvent":
        this.onCdpEvent(event.data);
        return;
      case "detached":
        this.onDetached(event.data.tabId, event.data.reason);
        return;
      case "state": {
        const { tabs, paused } = event.data;
        const open = new Set(tabs.map((tab) => tab.tabId));
        for (const tabId of this.claimedTabs()) {
          if (paused || !open.has(tabId)) {
            this.reattaching.delete(tabId);
            if (this.targets.has(tabId)) {
              this.dropTarget(tabId);
            }
            this.options.onReleased(tabId, paused ? "paused" : "closed");
          }
        }
        return;
      }
      default:
        return;
    }
  }

  // --- Claiming ---

  private async attach(tabId: number): Promise<Target> {
    const extension = this.options.extension();
    if (!extension) {
      throw new Error("No browser is connected");
    }
    const { targetInfo } = await extension.request("attach", { tabId });
    // Another browser replaced this one meanwhile: its tab with this ID is another tab
    if (this.options.extension() !== extension) {
      throw new Error(
        "The browser disconnected from Browser MCP while handling the command",
      );
    }
    const existing = this.targets.get(tabId);
    if (existing) {
      return existing;
    }
    let markGone = () => {};
    const gone = new Promise<void>((resolve) => (markGone = resolve));
    const target = {
      tabId,
      targetInfo: {
        ...targetInfo,
        type: "page",
        browserContextId:
          targetInfo.browserContextId ?? DEFAULT_BROWSER_CONTEXT_ID,
      },
      sessions: new Map(),
      childSessions: new Set(),
      gone,
      markGone,
    } as unknown as Target;
    target.primary = this.addSession(target);
    this.targets.set(tabId, target);
    if (this.autoAttach) {
      this.announce(target);
    }
    return target;
  }

  private addSession(target: Target, parentSessionId?: string): ClientSession {
    const session: ClientSession = {
      id: `browsermcp-${target.tabId}-${this.nextSessionId++}`,
      target,
      domains: new Set(),
      parentSessionId,
    };
    target.sessions.set(session.id, session);
    this.sessions.set(session.id, session);
    return session;
  }

  private announce(target: Target) {
    this.sendToClient({
      method: "Target.attachedToTarget",
      params: {
        sessionId: target.primary.id,
        targetInfo: { ...target.targetInfo, attached: true },
        waitingForDebugger: false,
      },
    });
  }

  /** Forgets a target and tells the client each of its sessions detached */
  private dropTarget(tabId: number) {
    const target = this.targets.get(tabId);
    if (!target) {
      return;
    }
    this.targets.delete(tabId);
    for (const child of target.childSessions) {
      this.childSessionTargets.delete(child);
      this.frameTrees.delete(child);
    }
    const sessions = [...target.sessions.values()].reverse();
    for (const session of sessions) {
      this.sessions.delete(session.id);
      this.frameTrees.delete(session.id);
      if (this.autoAttach || session !== target.primary) {
        this.sendToClient({
          sessionId: session.parentSessionId,
          method: "Target.detachedFromTarget",
          params: {
            sessionId: session.id,
            targetId: target.targetInfo.targetId,
          },
        });
      }
    }
    target.markGone();
  }

  private onDetached(tabId: number, reason: string) {
    if (!this.targets.has(tabId)) {
      return;
    }
    this.dropTarget(tabId);
    const last = this.lastReattach.get(tabId) ?? 0;
    if (
      NO_REATTACH_REASONS.has(reason) ||
      Date.now() - last < REATTACH_COOLDOWN_MS
    ) {
      this.options.onReleased(tabId, reason);
      return;
    }
    // Other detaches (e.g. `target_closed` when a navigation swaps the renderer) re-attach, as a new target
    const now = Date.now();
    for (const [other, at] of this.lastReattach) {
      if (now - at >= REATTACH_COOLDOWN_MS) {
        this.lastReattach.delete(other);
      }
    }
    this.lastReattach.set(tabId, now);
    const entry = {} as { promise: Promise<Target | null> };
    entry.promise = (async () => {
      await new Promise((resolve) =>
        setTimeout(resolve, this.options.reattachDelayMs ?? 150),
      );
      // Released (or the extension went away) in the meantime
      if (this.reattaching.get(tabId) !== entry.promise) {
        return null;
      }
      try {
        return await this.attach(tabId);
      } catch (error) {
        this.options.log(`Re-attaching tab ${tabId} failed:`, error);
        this.options.onReleased(tabId, reason);
        return null;
      } finally {
        if (this.reattaching.get(tabId) === entry.promise) {
          this.reattaching.delete(tabId);
        }
      }
    })();
    this.reattaching.set(tabId, entry.promise);
  }

  // --- Events from the tab ---

  private onCdpEvent({
    tabId,
    sessionId,
    method,
    params,
  }: {
    tabId: number;
    sessionId?: string;
    method: string;
    params?: unknown;
  }) {
    const target = this.targets.get(tabId);
    if (!target) {
      return;
    }
    const eventParams = (params ?? {}) as Record<string, unknown>;
    const childSessionId =
      typeof eventParams.sessionId === "string"
        ? eventParams.sessionId
        : undefined;
    if (method === "Target.attachedToTarget" && childSessionId) {
      target.childSessions.add(childSessionId);
      this.childSessionTargets.set(childSessionId, target);
    } else if (method === "Target.detachedFromTarget" && childSessionId) {
      target.childSessions.delete(childSessionId);
      this.childSessionTargets.delete(childSessionId);
      this.frameTrees.delete(childSessionId);
    }
    if (!this.autoAttach) {
      return;
    }
    if (sessionId) {
      this.sendToClient({ sessionId, method, params: eventParams });
      return;
    }
    for (const session of this.recipients(target, method)) {
      this.sendToClient({ sessionId: session.id, method, params: eventParams });
    }
  }

  /** A tab's events go to the sessions that enabled their domain, or to Playwright's when none did (domains without `enable`, `Target.*`, `Inspector.*`) */
  private recipients(target: Target, method: string): ClientSession[] {
    const domain = method.slice(0, method.indexOf("."));
    if (domain === "Target" || domain === "Inspector") {
      return [target.primary];
    }
    const sessions = [...target.sessions.values()].filter((session) =>
      session.domains.has(domain),
    );
    return sessions.length > 0 ? sessions : [target.primary];
  }

  // --- Commands from the client ---

  private onClientMessage(data: RawData) {
    let message: CdpMessage;
    try {
      message = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (typeof message.id !== "number" || typeof message.method !== "string") {
      return;
    }
    const reply = (result: unknown) =>
      this.sendToClient({
        id: message.id,
        sessionId: message.sessionId,
        result: result ?? {},
      });
    const fail = (error: unknown) =>
      this.sendToClient({
        id: message.id,
        sessionId: message.sessionId,
        error: { message: errorMessage(error), code: -32000 },
      });
    try {
      if (message.sessionId && !this.browserSessions.has(message.sessionId)) {
        this.onSessionCommand(message, reply, fail);
      } else {
        this.onRootCommand(message, reply, fail);
      }
    } catch (error) {
      fail(error);
    }
  }

  private onRootCommand(
    message: CdpMessage,
    reply: (result: unknown) => void,
    fail: (error: unknown) => void,
  ) {
    const params = message.params ?? {};
    switch (message.method) {
      case "Browser.getVersion": {
        const browser: BrowserInfo | undefined =
          this.options.extension()?.hello.browser;
        reply({
          protocolVersion: "1.3",
          product: `Chrome/${browser?.version ?? "0.0.0.0"}`,
          revision: "",
          userAgent: browser?.userAgent ?? "Mozilla/5.0 Chrome",
          jsVersion: "",
        });
        return;
      }
      case "Browser.setDownloadBehavior":
      case "Target.setDiscoverTargets":
        reply({});
        return;
      case "Target.setAutoAttach": {
        // Announce the claimed tabs before replying, as Chrome does, so Playwright knows them once connected
        if (!this.autoAttach) {
          this.autoAttach = true;
          for (const target of this.targets.values()) {
            this.announce(target);
          }
        }
        reply({});
        return;
      }
      case "Target.getTargetInfo": {
        const targetId = params.targetId as string | undefined;
        if (!targetId) {
          reply({
            targetInfo: {
              targetId: "browser",
              type: "browser",
              title: "",
              url: "",
              attached: true,
              canAccessOpener: false,
            },
          });
          return;
        }
        const target = this.findTarget(targetId);
        if (!target) {
          fail(new Error(`No target with ID ${targetId}`));
          return;
        }
        reply({ targetInfo: { ...target.targetInfo, attached: true } });
        return;
      }
      case "Target.getTargets":
        reply({
          targetInfos: [...this.targets.values()].map((target) => ({
            ...target.targetInfo,
            attached: true,
          })),
        });
        return;
      case "Target.attachToTarget": {
        const target = this.findTarget(params.targetId as string);
        if (!target) {
          fail(new Error(`No target with ID ${String(params.targetId)}`));
          return;
        }
        reply({ sessionId: this.addSession(target, message.sessionId).id });
        return;
      }
      case "Target.attachToBrowserTarget": {
        // Playwright's `newCDPSession()` attaches to pages from a browser session of its own; commands on it are root commands
        const sessionId = `browsermcp-browser-${this.nextSessionId++}`;
        this.browserSessions.add(sessionId);
        reply({ sessionId });
        return;
      }
      case "Target.detachFromTarget": {
        const sessionId = params.sessionId as string;
        const session = this.sessions.get(sessionId);
        if (session && session !== session.target.primary) {
          this.removeSession(session);
        } else if (this.browserSessions.delete(sessionId)) {
          this.sendToClient({
            sessionId: message.sessionId,
            method: "Target.detachedFromTarget",
            params: { sessionId },
          });
        }
        reply({});
        return;
      }
      case "Target.activateTarget": {
        const target = this.findTarget(params.targetId as string);
        const extension = this.options.extension();
        if (!target || !extension) {
          fail(new Error(`No target with ID ${String(params.targetId)}`));
          return;
        }
        extension
          .request("activateTab", { tabId: target.tabId })
          .then(() => reply({}), fail);
        return;
      }
      case "Target.closeTarget": {
        const target = this.findTarget(params.targetId as string);
        const extension = this.options.extension();
        if (!target || !extension) {
          reply({ success: false });
          return;
        }
        extension
          .request("closeTab", { tabId: target.tabId })
          .then(() => reply({ success: true }), fail);
        return;
      }
      case "Target.createTarget":
      case "Target.createBrowserContext":
        fail(
          new Error(
            `${message.method} isn't supported: the daemon opens tabs through the extension`,
          ),
        );
        return;
    }
    // Other browser-level commands (e.g. `Storage.getCookies`) go through any claimed tab, since `chrome.debugger` has no browser target
    const target = this.targets.values().next().value;
    if (!target) {
      fail(new Error(`${message.method} needs a claimed tab`));
      return;
    }
    this.forward(target, undefined, message, reply, fail);
  }

  private onSessionCommand(
    message: CdpMessage,
    reply: (result: unknown) => void,
    fail: (error: unknown) => void,
  ) {
    const sessionId = message.sessionId!;
    const method = message.method!;
    const session = this.sessions.get(sessionId);
    if (!session) {
      const target = this.childSessionTargets.get(sessionId);
      if (!target) {
        fail(new Error(`Session with given id not found: ${sessionId}`));
        return;
      }
      this.forward(target, sessionId, message, reply, fail);
      return;
    }

    const target = session.target;
    const [domain, command] = method.split(".") as [string, string];
    if (command === "enable") {
      session.domains.add(domain);
    } else if (command === "disable") {
      session.domains.delete(domain);
      const stillUsed = [...target.sessions.values()].some((other) =>
        other.domains.has(domain),
      );
      if (stillUsed) {
        reply({});
        return;
      }
    }
    if (method === "Target.getTargetInfo" && !message.params?.targetId) {
      reply({ targetInfo: { ...target.targetInfo, attached: true } });
      return;
    }
    this.forward(target, undefined, message, reply, fail);
  }

  /** Sends a command to the tab (or one of its child sessions) through the extension */
  private forward(
    target: Target,
    childSessionId: string | undefined,
    message: CdpMessage,
    reply: (result: unknown) => void,
    fail: (error: unknown) => void,
  ) {
    const extension = this.options.extension();
    if (!extension) {
      fail(new Error("No browser is connected"));
      return;
    }
    const key = message.sessionId ?? "";
    const send = () =>
      extension.send(
        "cdp",
        {
          tabId: target.tabId,
          sessionId: childSessionId,
          method: message.method!,
          params: message.params,
        },
        (error, result) => {
          if (!error) {
            reply(result);
            return;
          }
          if (/Detached while handling command/i.test(error.message)) {
            // Let the detach arrive first, so Playwright sees the page go away rather than a failed command
            void Promise.race([
              target.gone,
              new Promise((resolve) => setTimeout(resolve, DETACH_GRACE_MS)),
            ]).then(() => fail(error));
            return;
          }
          fail(error);
        },
      );

    if (message.method === "Page.getFrameTree") {
      let delivered = () => {};
      const pending = new Promise<void>((resolve) => (delivered = resolve));
      this.frameTrees.set(key, pending);
      const done = () => {
        if (this.frameTrees.get(key) === pending) {
          this.frameTrees.delete(key);
        }
        delivered();
      };
      const originalReply = reply;
      const originalFail = fail;
      reply = (result) => {
        originalReply(result);
        done();
      };
      fail = (error) => {
        originalFail(error);
        done();
      };
    }
    // Chrome reports existing execution contexts on `Runtime.enable`. Through the extension they could overtake the frame tree, and Playwright drops contexts of frames it doesn't know yet
    const frameTree =
      message.method === "Runtime.enable"
        ? this.frameTrees.get(key)
        : undefined;
    if (frameTree) {
      void frameTree.then(send);
    } else {
      send();
    }
  }

  private removeSession(session: ClientSession) {
    const target = session.target;
    target.sessions.delete(session.id);
    this.sessions.delete(session.id);
    this.frameTrees.delete(session.id);
    const extension = this.options.extension();
    for (const domain of session.domains) {
      const stillUsed = [...target.sessions.values()].some((other) =>
        other.domains.has(domain),
      );
      if (!stillUsed && extension) {
        extension.send(
          "cdp",
          { tabId: target.tabId, method: `${domain}.disable` },
          () => {},
        );
      }
    }
    this.sendToClient({
      sessionId: session.parentSessionId,
      method: "Target.detachedFromTarget",
      params: { sessionId: session.id, targetId: target.targetInfo.targetId },
    });
  }

  private findTarget(targetId: string): Target | undefined {
    for (const target of this.targets.values()) {
      if (target.targetInfo.targetId === targetId) {
        return target;
      }
    }
    return undefined;
  }

  private sendToClient(message: CdpMessage) {
    if (this.client?.readyState === this.client?.OPEN) {
      this.client?.send(JSON.stringify(message));
    }
  }
}
