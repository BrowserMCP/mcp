import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";

import type {
  ExtensionEvent,
  ExtensionRequestMap,
  ExtensionRequestMethod,
} from "@browsermcp/protocol";

import { CdpBridge, type CdpMessage } from "@/relay/bridge";
import type { ExtensionConnection } from "@/relay/extension-connection";

type Sent = {
  method: ExtensionRequestMethod;
  params: Record<string, unknown>;
  answer(result: unknown): void;
  fail(message: string): void;
};

/** The extension side, in memory: requests wait in `sent` until the test answers them (or `auto` does) */
class FakeExtensionConnection {
  sent: Sent[] = [];
  hello = {
    browser: {
      name: "Chrome",
      version: "146.0.1.2",
      userAgent: "Mozilla/5.0 Chrome/146",
    },
  };
  auto: ((method: string, params: Record<string, unknown>) => unknown) | null =
    (method, params) => {
      if (method === "attach") {
        return {
          targetInfo: {
            targetId: `TARGET-${params.tabId}`,
            type: "page",
            title: "",
            url: "https://example.com/",
            attached: true,
            canAccessOpener: false,
            browserContextId: "CONTEXT",
          },
        };
      }
      return method === "cdp" ? {} : undefined;
    };

  send<M extends ExtensionRequestMethod>(
    method: M,
    params: ExtensionRequestMap[M]["params"],
    callback: (error: Error | null, result?: unknown) => void,
  ) {
    const sent: Sent = {
      method,
      params: params as Record<string, unknown>,
      answer: (result) => callback(null, result),
      fail: (message) => callback(new Error(message)),
    };
    this.sent.push(sent);
    if (this.auto) {
      const result = this.auto(method, sent.params);
      if (result !== "manual") {
        queueMicrotask(() => sent.answer(result));
      }
    }
  }

  request(method: ExtensionRequestMethod, params: unknown) {
    return new Promise((resolve, reject) =>
      this.send(method, params as never, (error, result) =>
        error ? reject(error) : resolve(result),
      ),
    );
  }

  cdpSent(method?: string) {
    return this.sent
      .filter((sent) => sent.method === "cdp")
      .filter((sent) => !method || sent.params.method === method);
  }
}

/** Playwright's side: a socket whose outgoing frames the test reads */
class FakeCdpClient extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  received: CdpMessage[] = [];
  private nextId = 1;

  send(data: string) {
    this.received.push(JSON.parse(data));
  }

  close() {
    this.readyState = 3;
    this.emit("close");
  }

  command(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ) {
    const id = this.nextId++;
    this.emit(
      "message",
      Buffer.from(JSON.stringify({ id, method, params, sessionId })),
    );
    return vi.waitUntil(
      () => this.received.find((message) => message.id === id),
      {
        timeout: 3000,
      },
    );
  }

  events(method: string) {
    return this.received.filter((message) => message.method === method);
  }
}

let extension: FakeExtensionConnection;
let client: FakeCdpClient;
let bridge: CdpBridge;
let released: { tabId: number; reason: string }[];

beforeEach(() => {
  extension = new FakeExtensionConnection();
  client = new FakeCdpClient();
  released = [];
  bridge = new CdpBridge({
    log: () => {},
    extension: () => extension as unknown as ExtensionConnection,
    onReleased: (tabId, reason) => released.push({ tabId, reason }),
    reattachDelayMs: 10,
  });
  bridge.attachClient(client as unknown as WebSocket);
});

function event(event: ExtensionEvent) {
  bridge.onExtensionEvent(event);
}

function cdpEvent(
  tabId: number,
  method: string,
  params: unknown = {},
  sessionId?: string,
) {
  event({ type: "cdpEvent", data: { tabId, method, params, sessionId } });
}

async function claimAndConnect(tabId = 1) {
  await bridge.claim(tabId);
  await client.command("Target.setAutoAttach", {
    autoAttach: true,
    waitForDebuggerOnStart: true,
    flatten: true,
  });
  return client.events("Target.attachedToTarget").at(-1)!.params!
    .sessionId as string;
}

describe("CdpBridge", () => {
  it("answers Browser.getVersion with the extension's browser", async () => {
    const response = await client.command("Browser.getVersion");
    expect(response.result).toMatchObject({
      product: "Chrome/146.0.1.2",
      userAgent: "Mozilla/5.0 Chrome/146",
    });
  });

  it("announces claimed tabs before replying to setAutoAttach, and only them", async () => {
    await bridge.claim(1);
    const response = await client.command("Target.setAutoAttach", {
      autoAttach: true,
    });
    const announceIndex = client.received.findIndex(
      (message) => message.method === "Target.attachedToTarget",
    );
    expect(announceIndex).toBeGreaterThanOrEqual(0);
    expect(announceIndex).toBeLessThan(client.received.indexOf(response));
    expect(client.events("Target.attachedToTarget")[0]!.params).toMatchObject({
      targetInfo: {
        targetId: "TARGET-1",
        type: "page",
        browserContextId: "CONTEXT",
      },
      waitingForDebugger: false,
    });

    // Tabs claimed later are announced right away
    await bridge.claim(2);
    expect(client.events("Target.attachedToTarget")).toHaveLength(2);
    const { result } = await client.command("Target.getTargets");
    expect(
      (result as { targetInfos: { targetId: string }[] }).targetInfos.map(
        (info) => info.targetId,
      ),
    ).toEqual(["TARGET-1", "TARGET-2"]);
    expect(
      extension.sent.filter((sent) => sent.method === "attach"),
    ).toHaveLength(2);
  });

  it("claims once when asked twice at the same time", async () => {
    await Promise.all([bridge.claim(1), bridge.claim(1)]);
    expect(
      extension.sent.filter((sent) => sent.method === "attach"),
    ).toHaveLength(1);
    expect(bridge.isClaimed(1)).toBe(true);
    expect(bridge.targetId(1)).toBe("TARGET-1");
  });

  it("holds Runtime.enable until the Page.getFrameTree reply is delivered", async () => {
    const sessionId = await claimAndConnect();
    extension.auto = () => "manual";
    void client.command("Page.getFrameTree", {}, sessionId);
    const runtime = client.command("Runtime.enable", {}, sessionId);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(extension.cdpSent().map((sent) => sent.params.method)).toEqual([
      "Page.getFrameTree",
    ]);

    extension.cdpSent("Page.getFrameTree")[0]!.answer({ frameTree: {} });
    await vi.waitUntil(() => extension.cdpSent("Runtime.enable").length === 1);
    extension.cdpSent("Runtime.enable")[0]!.answer({});
    await runtime;
    const order = client.received
      .filter((message) => message.id !== undefined)
      .map((message) => message.id);
    expect(order.slice(-2)).toEqual([2, 3]);
  });

  it("relays responses before events the extension sent after them", async () => {
    const sessionId = await claimAndConnect();
    extension.auto = () => "manual";
    const navigate = client.command(
      "Page.navigate",
      { url: "https://a.example" },
      sessionId,
    );
    extension.cdpSent("Page.navigate")[0]!.answer({ frameId: "F" });
    cdpEvent(1, "Page.frameNavigated", { frame: { id: "F" } });
    await navigate;
    const navigateIndex = client.received.findIndex(
      (message) => (message.result as { frameId?: string })?.frameId === "F",
    );
    expect(navigateIndex).toBeLessThan(
      client.received.findIndex(
        (message) => message.method === "Page.frameNavigated",
      ),
    );
  });

  it("counts domain enables per session, so a raw session can't disable Playwright's", async () => {
    const primary = await claimAndConnect();
    await client.command("Network.enable", {}, primary);
    const { result } = await client.command("Target.attachToTarget", {
      targetId: "TARGET-1",
      flatten: true,
    });
    const raw = (result as { sessionId: string }).sessionId;
    expect(raw).not.toBe(primary);
    // No attachedToTarget for it: Playwright would see a duplicate page
    expect(client.events("Target.attachedToTarget")).toHaveLength(1);

    await client.command("Network.enable", {}, raw);
    await client.command("Fetch.enable", {}, raw);
    cdpEvent(1, "Network.requestWillBeSent", { requestId: "1" });
    cdpEvent(1, "Fetch.requestPaused", { requestId: "2" });
    cdpEvent(1, "Page.loadEventFired", {});
    const sessionsOf = (method: string) =>
      client.events(method).map((message) => message.sessionId);
    expect(sessionsOf("Network.requestWillBeSent").sort()).toEqual(
      [primary, raw].sort(),
    );
    expect(sessionsOf("Fetch.requestPaused")).toEqual([raw]);
    expect(sessionsOf("Page.loadEventFired")).toEqual([primary]);

    const disable = await client.command("Network.disable", {}, raw);
    expect(disable.error).toBeUndefined();
    expect(extension.cdpSent("Network.disable")).toHaveLength(0);

    // Detaching the raw session turns off what only it enabled
    await client.command("Target.detachFromTarget", { sessionId: raw });
    expect(client.events("Target.detachedFromTarget")[0]!.params).toEqual({
      sessionId: raw,
      targetId: "TARGET-1",
    });
    expect(extension.cdpSent("Fetch.disable")).toHaveLength(1);
    expect(extension.cdpSent("Network.disable")).toHaveLength(0);

    // Playwright's session still gets Network events, and its disable goes through
    cdpEvent(1, "Network.requestWillBeSent", { requestId: "3" });
    expect(sessionsOf("Network.requestWillBeSent").at(-1)).toBe(primary);
    await client.command("Network.disable", {}, primary);
    expect(extension.cdpSent("Network.disable")).toHaveLength(1);
  });

  it("passes child sessions through", async () => {
    const primary = await claimAndConnect();
    cdpEvent(1, "Target.attachedToTarget", {
      sessionId: "CHILD",
      targetInfo: { targetId: "IFRAME", type: "iframe" },
    });
    expect(client.events("Target.attachedToTarget").at(-1)!.sessionId).toBe(
      primary,
    );

    await client.command("Runtime.evaluate", { expression: "1" }, "CHILD");
    expect(extension.cdpSent("Runtime.evaluate")[0]!.params).toMatchObject({
      tabId: 1,
      sessionId: "CHILD",
    });
    cdpEvent(1, "Runtime.consoleAPICalled", {}, "CHILD");
    expect(client.events("Runtime.consoleAPICalled")[0]!.sessionId).toBe(
      "CHILD",
    );
  });

  it("lets the detach arrive before a command that failed with 'Detached while handling command'", async () => {
    const sessionId = await claimAndConnect();
    extension.auto = () => "manual";
    const evaluate = client.command("Runtime.evaluate", {}, sessionId);
    extension
      .cdpSent("Runtime.evaluate")[0]!
      .fail("Detached while handling command.");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(client.received.some((message) => message.error)).toBe(false);
    extension.auto = null;
    event({ type: "detached", data: { tabId: 1, reason: "canceled_by_user" } });
    const response = await evaluate;
    expect(response.error?.message).toMatch(/Detached/);
    expect(
      client.received.findIndex(
        (message) => message.method === "Target.detachedFromTarget",
      ),
    ).toBeLessThan(client.received.indexOf(response));
  });

  it("re-attaches after a detach other than canceled_by_user, as a new target", async () => {
    const first = await claimAndConnect();
    event({ type: "detached", data: { tabId: 1, reason: "target_closed" } });
    expect(
      client.events("Target.detachedFromTarget")[0]!.params!.sessionId,
    ).toBe(first);
    expect(bridge.isClaimed(1)).toBe(true);
    await vi.waitUntil(
      () => client.events("Target.attachedToTarget").length === 2,
    );
    const second = client.events("Target.attachedToTarget")[1]!.params!
      .sessionId;
    expect(second).not.toBe(first);
    expect(released).toEqual([]);

    // A second detach within the cooldown releases the tab
    event({ type: "detached", data: { tabId: 1, reason: "target_closed" } });
    expect(released).toEqual([{ tabId: 1, reason: "target_closed" }]);
    expect(bridge.isClaimed(1)).toBe(false);
  });

  it("releases on canceled_by_user and not_allowed without re-attaching", async () => {
    await claimAndConnect(1);
    await bridge.claim(2);
    event({ type: "detached", data: { tabId: 1, reason: "canceled_by_user" } });
    event({
      type: "detached",
      data: { tabId: 2, reason: "not_allowed" },
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(released).toEqual([
      { tabId: 1, reason: "canceled_by_user" },
      { tabId: 2, reason: "not_allowed" },
    ]);
    expect(
      extension.sent.filter((sent) => sent.method === "attach"),
    ).toHaveLength(2);
  });

  it("releases tabs on pause and when they close", async () => {
    await claimAndConnect(1);
    await bridge.claim(2);
    const tab = (tabId: number) => ({
      tabId,
      windowId: 1,
      url: "",
      title: "",
      active: false,
      pinned: false,
      attached: true,
    });
    event({
      type: "state",
      data: { tabs: [tab(1)], paused: false, pairing: "paired" },
    });
    expect(released).toEqual([{ tabId: 2, reason: "closed" }]);
    event({
      type: "state",
      data: { tabs: [tab(1)], paused: true, pairing: "paired" },
    });
    expect(released.at(-1)).toEqual({ tabId: 1, reason: "paused" });
    expect(bridge.claimedTabs()).toEqual([]);
  });

  it("detaches the debugger on release", async () => {
    const sessionId = await claimAndConnect();
    await bridge.release(1);
    expect(
      client.events("Target.detachedFromTarget")[0]!.params!.sessionId,
    ).toBe(sessionId);
    expect(extension.sent.at(-1)).toMatchObject({
      method: "detach",
      params: { tabId: 1 },
    });
    expect(released).toEqual([]);
  });

  it("refuses to create targets itself", async () => {
    const response = await client.command("Target.createTarget", {
      url: "about:blank",
    });
    expect(response.error?.message).toMatch(/isn't supported/);
  });
});
