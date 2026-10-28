import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Browser } from "wxt/browser";
import { fakeBrowser } from "wxt/testing/fake-browser";

import {
  type ExtensionEvent,
  type ExtensionRequest,
  type ExtensionState,
  pairingRequiredMessage,
} from "@browsermcp/protocol";

import { connectionStatusItem, pausedItem } from "../storage";
import { TAB_GROUP_HEX } from "../types";
import {
  BrowserControl,
  type BrowserControlOptions,
  PAUSED_MESSAGE,
} from "./browser-control";
import { type FakeChrome, installFakeChrome } from "./fake-chrome.test-helper";
import {
  type DaemonKey,
  FakeWebSocket,
  type FakePort,
  createDaemonKey,
  createFakeFetch,
  welcome,
} from "./fake-daemon.test-helper";

let chrome: FakeChrome;
let stopListeners: (() => void)[] = [];

/** Starts browser control (as the service worker does) and opens its connection to a daemon on 9010 */
async function start(
  ports: Record<number, FakePort> = { 9010: "daemon" },
  options: BrowserControlOptions = {},
) {
  const control = new BrowserControl({
    fetch: createFakeFetch(ports),
    WebSocket: FakeWebSocket as unknown as typeof WebSocket,
    inputTimeoutMs: 300,
    ...options,
  });
  stopListeners.push(control.start());
  if (ports[9010] !== "daemon") {
    return { control, ws: null as unknown as FakeWebSocket };
  }
  const ws = await vi.waitFor(() => {
    const ws = FakeWebSocket.latest("9010/extension");
    if (!ws || ws.readyState === FakeWebSocket.CLOSED) {
      throw new Error("Not connecting yet");
    }
    return ws;
  });
  ws.open();
  await vi.waitFor(() => expect(ws.messages("hello")).toHaveLength(1));
  return { control, ws };
}

/** Starts browser control with a daemon whose key the user allowed */
async function startPaired(key: DaemonKey, options?: BrowserControlOptions) {
  const started = await start(undefined, options);
  await welcome(started.ws, key);
  await vi.waitFor(async () =>
    expect(await connectionStatusItem.getValue()).toMatchObject({
      state: "connected",
      pairing: "pending",
    }),
  );
  await started.control.allow(key.publicKey);
  return started;
}

let nextRequestId = 1;

/** Sends the extension a request, and returns its response */
async function request(
  ws: FakeWebSocket,
  req: ExtensionRequest,
  timeout?: number,
) {
  const id = nextRequestId++;
  ws.receive({ type: "request", id, ...req });
  return vi.waitFor(
    () => {
      const response = ws.messages("response").find((r) => r.id === id);
      if (!response) {
        throw new Error("No response yet");
      }
      return response;
    },
    { timeout },
  );
}

function events<T extends ExtensionEvent["type"]>(ws: FakeWebSocket, type: T) {
  return ws
    .messages("event")
    .map((message) => message.event)
    .filter(
      (event): event is Extract<ExtensionEvent, { type: T }> =>
        event.type === type,
    )
    .map((event) => event.data);
}

async function latestState(ws: FakeWebSocket): Promise<ExtensionState> {
  return vi.waitFor(() => {
    const state = events(ws, "state").at(-1);
    if (!state) {
      throw new Error("No state yet");
    }
    return state as ExtensionState;
  });
}

const badgeText = () => fakeBrowser.action.getBadgeText({});

beforeEach(() => {
  fakeBrowser.reset();
  FakeWebSocket.reset();
  chrome = installFakeChrome();
});

afterEach(() => {
  stopListeners.forEach((stop) => stop());
  stopListeners = [];
});

describe("pairing", () => {
  it("reports no tabs and refuses every request until the user allows the daemon's key, with the code the popup shows", async () => {
    chrome.addTab({ id: 1, url: "https://example.com/" });
    const key = await createDaemonKey();
    const { control, ws } = await start();

    const [hello] = ws.messages("hello");
    expect(hello.state).toEqual({
      tabs: [],
      paused: false,
      pairing: "pending",
    });

    const daemon = await welcome(ws, key);
    const status = await vi.waitFor(async () => {
      const status = await connectionStatusItem.getValue();
      if (status.state !== "connected") {
        throw new Error("Not connected yet");
      }
      return status;
    });
    expect(status.pairing).toBe("pending");
    expect(status.code).toMatch(/^\d{3} \d{3}$/);
    // The daemon computes the same code for its tool messages
    expect(status.code).toBe(await daemon.code());
    expect(await latestState(ws)).toEqual({
      tabs: [],
      paused: false,
      pairing: "pending",
    });
    await vi.waitFor(async () => expect(await badgeText()).toBe("?"));

    for (const req of [
      { method: "attach", params: { tabId: 1 } },
      { method: "cdp", params: { tabId: 1, method: "Page.reload" } },
      { method: "closeTab", params: { tabId: 1 } },
      { method: "activity", params: { appId: "claude-code" } },
    ] as ExtensionRequest[]) {
      expect(await request(ws, req)).toMatchObject({
        error: pairingRequiredMessage(status.code),
      });
    }
    expect(chrome.debugger.attach).not.toHaveBeenCalled();
    expect(chrome.tabs.has(1)).toBe(true);

    const view = await control.getView();
    expect(view.connection).toMatchObject({
      pairing: "pending",
      code: status.code,
    });

    await control.allow(key.publicKey);
    await vi.waitFor(async () =>
      expect((await latestState(ws)).tabs.map((tab) => tab.tabId)).toEqual([1]),
    );
    expect(await badgeText()).toBe("");
    expect(
      await request(ws, { method: "attach", params: { tabId: 1 } }),
    ).toMatchObject({ result: { targetInfo: { targetId: "target-1" } } });
  });

  it("doesn't ask again for an allowed key, across restarts, but asks for a different key", async () => {
    const key = await createDaemonKey();
    const first = await startPaired(key);
    stopListeners.forEach((stop) => stop());
    stopListeners = [];
    void first;

    // The service worker restarts and the same daemon connects again
    const again = await start();
    await welcome(again.ws, key);
    await vi.waitFor(async () =>
      expect(await connectionStatusItem.getValue()).toMatchObject({
        pairing: "paired",
      }),
    );
    // No pairing code to exchange for an allowed key
    expect(again.ws.messages("pairingNonce")).toEqual([]);
    expect(await connectionStatusItem.getValue()).not.toHaveProperty("code");
    stopListeners.forEach((stop) => stop());
    stopListeners = [];

    // Another key on the port (a deleted ~/.browsermcp, or another program)
    const other = await start();
    await welcome(other.ws, await createDaemonKey());
    await vi.waitFor(async () =>
      expect(await connectionStatusItem.getValue()).toMatchObject({
        pairing: "pending",
        code: expect.stringMatching(/^\d{3} \d{3}$/),
      }),
    );
    expect(other.ws.messages("pairingNonce")).toHaveLength(1);
  });

  it("gives a daemon whose reveal doesn't match its commitment nothing, and doesn't offer Allow", async () => {
    chrome.addTab({ id: 1 });
    const key = await createDaemonKey();
    const { ws, control } = await start();
    await welcome(ws, key, { badReveal: true });

    await vi.waitFor(() => expect(ws.readyState).toBe(FakeWebSocket.CLOSED));
    expect(await connectionStatusItem.getValue()).toEqual({
      state: "untrusted",
    });
    expect(events(ws, "state")).toEqual([]);
    await expect(control.allow(key.publicKey)).rejects.toThrow();
  });

  it("gives a program that can't sign with the key it sends nothing, and doesn't offer Allow", async () => {
    chrome.addTab({ id: 1 });
    const { ws, control } = await start();
    await welcome(ws, await createDaemonKey(), { badSignature: true });

    await vi.waitFor(() => expect(ws.readyState).toBe(FakeWebSocket.CLOSED));
    expect(await connectionStatusItem.getValue()).toEqual({
      state: "untrusted",
    });
    expect(events(ws, "state")).toEqual([]);
    await expect(control.allow("anything")).rejects.toThrow();
  });

  it("gives a program that sends no key nothing", async () => {
    const { ws } = await start();
    ws.receive({
      type: "welcome",
      protocol: 1,
      daemonVersion: "2.0.0",
      capabilities: [],
    });
    await vi.waitFor(() => expect(ws.readyState).toBe(FakeWebSocket.CLOSED));
    expect(await connectionStatusItem.getValue()).toEqual({
      state: "untrusted",
    });
  });
});

describe("the tabs the extension reports", () => {
  it("reports web pages, not incognito, discarded, browser pages or the Web Store", async () => {
    chrome.addTab({ id: 1, url: "https://example.com/", title: "Example" });
    chrome.addTab({ id: 2, url: "https://example.com/", incognito: true });
    chrome.addTab({ id: 3, url: "https://example.com/", discarded: true });
    chrome.addTab({ id: 4, url: "chrome://settings/" });
    chrome.addTab({ id: 5, url: "https://chromewebstore.google.com/" });
    chrome.addTab({ id: 6, url: "about:blank", pinned: true, active: true });
    const { ws } = await startPaired(await createDaemonKey());

    const state = await latestState(ws);
    expect(state.tabs).toEqual([
      {
        tabId: 1,
        windowId: 1,
        url: "https://example.com/",
        title: "Example",
        active: false,
        pinned: false,
        attached: false,
      },
      expect.objectContaining({ tabId: 6, pinned: true, active: true }),
    ]);
  });

  it("reports incognito tabs once the user allows the extension in incognito", async () => {
    chrome.addTab({ id: 1, url: "https://example.com/" });
    chrome.addTab({ id: 2, url: "https://example.com/", incognito: true });
    chrome.setIncognitoAccess(true);
    const { ws } = await startPaired(await createDaemonKey());

    const state = await latestState(ws);
    expect(state.tabs.map((tab) => tab.tabId)).toEqual([1, 2]);

    await request(ws, { method: "attach", params: { tabId: 2 } });
    expect(chrome.attached.has(2)).toBe(true);
  });
});

describe("where agents' new tabs open", () => {
  it("skips an app's group in an incognito window", async () => {
    chrome.setIncognitoAccess(true);
    const { ws } = await startPaired(await createDaemonKey());
    const app = { id: "claude-code", name: "Claude Code" };
    await request(ws, { method: "createTab", params: { app } });
    // The user dragged an incognito tab into the app's group
    const [groupId] = chrome.groups.keys();
    chrome.groups.get(groupId)!.windowId = chrome.addIncognitoWindow();

    const { tabId } = (
      await request(ws, { method: "createTab", params: { app } })
    ).result as { tabId: number };
    expect(chrome.tabs.get(tabId)!.windowId).toBe(1);
  });
});

describe("attaching", () => {
  it("doesn't attach when tabs are listed or dragged into a group", async () => {
    chrome.addTab({ id: 1, active: true });
    chrome.addTab({ id: 2 });
    const { ws } = await startPaired(await createDaemonKey());
    await request(ws, {
      method: "createTab",
      params: { app: { id: "claude-code", name: "Claude Code" } },
    });
    const [groupId] = chrome.groups.keys();

    await chrome.dragTab(2, groupId);
    await vi.waitFor(() => expect(events(ws, "tabAssigned")).toHaveLength(1));
    expect(chrome.debugger.attach).not.toHaveBeenCalled();
    expect(chrome.attached.size).toBe(0);
  });

  it("refuses tabs agents may not use, whatever the daemon asks", async () => {
    chrome.addTab({ id: 1, url: "https://example.com/" });
    chrome.addTab({ id: 2, url: "chrome://settings/" });
    chrome.addTab({ id: 3, incognito: true });
    const { ws } = await startPaired(await createDaemonKey());

    for (const tabId of [2, 3]) {
      expect(
        (await request(ws, { method: "attach", params: { tabId } })).error,
      ).toMatch(/can't use/);
    }
    expect(
      (
        await request(ws, {
          method: "createTab",
          params: {
            url: "chrome://settings/x",
            app: { id: "a", name: "A" },
          },
        })
      ).error,
    ).toMatch(/browser page/);
    expect(
      (
        await request(ws, {
          method: "cdp",
          params: { tabId: 1, method: "Runtime.evaluate" },
        })
      ).error,
    ).toMatch(/isn't attached/);
    expect(chrome.debugger.attach).not.toHaveBeenCalled();
  });

  it("detaches a tab that navigates to a browser page", async () => {
    chrome.addTab({ id: 1, url: "https://example.com/" });
    chrome.addTab({ id: 2, url: "https://shop.example/" });
    const { ws } = await startPaired(await createDaemonKey());
    await request(ws, { method: "attach", params: { tabId: 1 } });
    await request(ws, { method: "attach", params: { tabId: 2 } });

    await chrome.updateTab(1, { url: "chrome://settings/" });
    await vi.waitFor(() =>
      expect(events(ws, "detached")).toEqual([
        { tabId: 1, reason: "not_allowed" },
      ]),
    );
    expect(chrome.attached.has(1)).toBe(false);
    expect(chrome.attached.has(2)).toBe(true);
    await vi.waitFor(async () =>
      expect((await latestState(ws)).tabs.map((tab) => tab.tabId)).toEqual([2]),
    );
  });

  it("fails an Input command the tab doesn't answer, saying whether it's hidden, and runs the next one", async () => {
    chrome.addTab({ id: 1 });
    const { ws } = await startPaired(await createDaemonKey());
    await request(ws, { method: "attach", params: { tabId: 1 } });
    chrome.debugger.sendCommand.mockImplementation(async (_target, method) => {
      if (method === "Input.dispatchMouseEvent") {
        return await new Promise<never>(() => {});
      }
      if (method === "Runtime.evaluate") {
        return { result: { type: "string", value: "hidden" } };
      }
      return {};
    });
    const hung = request(ws, {
      method: "cdp",
      params: { tabId: 1, method: "Input.dispatchMouseEvent" },
    });
    const next = request(ws, {
      method: "cdp",
      params: { tabId: 1, method: "Input.dispatchKeyEvent" },
    });
    expect((await hung).error).toMatch(
      /Input.dispatchMouseEvent didn't finish in 0.3 s \(the tab is hidden\)/,
    );
    expect((await next).error).toBeUndefined();
  });

  it("forwards CDP commands and events, runs Input commands one at a time, and names an extension whose frame blocks attaching", async () => {
    chrome.addTab({ id: 1 });
    chrome.addTab({ id: 2 });
    const { ws } = await startPaired(await createDaemonKey());
    await request(ws, { method: "attach", params: { tabId: 1 } });

    let release: () => void = () => {};
    const order: string[] = [];
    chrome.debugger.sendCommand.mockImplementation(async (_target, method) => {
      order.push(`start ${method}`);
      if (method === "Input.dispatchMouseEvent") {
        await new Promise<void>((resolve) => (release = resolve));
      }
      order.push(`end ${method}`);
      return {};
    });
    const first = request(ws, {
      method: "cdp",
      params: { tabId: 1, method: "Input.dispatchMouseEvent" },
    });
    const second = request(ws, {
      method: "cdp",
      params: { tabId: 1, method: "Input.dispatchKeyEvent" },
    });
    const other = request(ws, {
      method: "cdp",
      params: { tabId: 1, sessionId: "child", method: "Runtime.evaluate" },
    });
    await other;
    expect(order).not.toContain("start Input.dispatchKeyEvent");
    release();
    await Promise.all([first, second]);
    expect(order.indexOf("start Input.dispatchKeyEvent")).toBeGreaterThan(
      order.indexOf("end Input.dispatchMouseEvent"),
    );
    expect(chrome.debugger.sendCommand).toHaveBeenCalledWith(
      { tabId: 1, sessionId: "child" },
      "Runtime.evaluate",
      undefined,
    );

    await chrome.debugger.onEvent.trigger(
      { tabId: 1, sessionId: "child" },
      "Page.loadEventFired",
      { timestamp: 1 },
    );
    expect(events(ws, "cdpEvent")).toEqual([
      {
        tabId: 1,
        sessionId: "child",
        method: "Page.loadEventFired",
        params: { timestamp: 1 },
      },
    ]);

    chrome.debugger.attach.mockRejectedValueOnce(
      new Error(
        "Cannot access a chrome-extension:// URL of different extension",
      ),
    );
    Object.assign(fakeBrowser.webNavigation, {
      getAllFrames: async () => [
        { url: "https://example.com/" },
        {
          url: "chrome-extension://aeblfdkhhhdcdjpifhhbdiojplfjncoa/inline/menu.html",
        },
      ],
    });
    expect(
      (await request(ws, { method: "attach", params: { tabId: 2 } })).error,
    ).toMatch(
      /1Password \(aeblfdkhhhdcdjpifhhbdiojplfjncoa\).*turn that extension off/,
    );

    // Chrome leaves other extensions' frames out of `getAllFrames`, but the debugger lists them as targets
    chrome.debugger.attach.mockRejectedValueOnce(
      new Error(
        "Cannot access a chrome-extension:// URL of different extension",
      ),
    );
    Object.assign(fakeBrowser.webNavigation, {
      getAllFrames: async () => [{ url: "https://example.com/" }],
    });
    const getTargets = fakeBrowser.debugger.getTargets;
    Object.assign(fakeBrowser.debugger, {
      getTargets: async () => [
        ...(await getTargets()),
        {
          id: "frame",
          attached: false,
          type: "other",
          title: "",
          url: "chrome-extension://kjnipcimpianpnkhccbmljdommdehepd/f.html",
        },
      ],
    });
    expect(
      (await request(ws, { method: "attach", params: { tabId: 2 } })).error,
    ).toMatch(
      /chromewebstore\.google\.com\/detail\/kjnipcimpianpnkhccbmljdommdehepd .*turn that extension off/,
    );
  });
});

describe("another extension's frame blocking attaching", () => {
  const blocked = () =>
    new Error("Cannot access a chrome-extension:// URL of different extension");

  // The tests below replace these on `fakeBrowser`: start each with no content script and no frames listed
  beforeEach(() => {
    Object.assign(fakeBrowser.tabs, {
      sendMessage: vi.fn(async () => {
        throw new Error("Could not establish connection");
      }),
    });
    Object.assign(fakeBrowser.webNavigation, { getAllFrames: async () => [] });
  });

  /** What the script in the page returns for a frame */
  const scan = (removed: number, overrides = {}) => ({
    result: {
      removed,
      iframes: removed,
      shadowRoots: 0,
      containers: 0,
      hasDom: true,
      schemes: [],
      ...overrides,
    },
  });

  it("removes the frame from the tab and attaches again", async () => {
    chrome.addTab({ id: 1 });
    const { ws } = await startPaired(await createDaemonKey());
    chrome.debugger.attach.mockRejectedValueOnce(blocked());
    const executeScript = vi.fn(async () => [scan(1), scan(2)]);
    Object.assign(fakeBrowser.scripting, { executeScript });

    expect(
      (await request(ws, { method: "attach", params: { tabId: 1 } })).error,
    ).toBeUndefined();

    expect(executeScript).toHaveBeenCalledTimes(1);
    expect(executeScript).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { tabId: 1, allFrames: true },
        args: [fakeBrowser.runtime.id],
      }),
    );
    expect(chrome.debugger.attach).toHaveBeenCalledTimes(2);
    expect(chrome.attached.has(1)).toBe(true);
  });

  it("asks the content script in each frame first, and injects a script into the frames that didn't answer", async () => {
    chrome.addTab({ id: 1 });
    const { ws } = await startPaired(await createDaemonKey());
    chrome.debugger.attach.mockRejectedValueOnce(blocked());
    Object.assign(fakeBrowser.webNavigation, {
      getAllFrames: async () => [{ frameId: 0 }, { frameId: 7 }],
    });
    const sendMessage = vi.fn(async (_tabId, _message, { frameId }) => {
      if (frameId === 0) {
        return scan(1, { hasDom: true, shadowRoots: 1 }).result;
      }
      throw new Error("Could not establish connection");
    });
    Object.assign(fakeBrowser.tabs, { sendMessage });
    const executeScript = vi.fn(async () => [scan(1)]);
    Object.assign(fakeBrowser.scripting, { executeScript });

    expect(
      (await request(ws, { method: "attach", params: { tabId: 1 } })).error,
    ).toBeUndefined();

    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenCalledWith(
      1,
      { type: "browsermcp:removeExtensionFrames" },
      { frameId: 7 },
    );
    expect(executeScript).toHaveBeenCalledTimes(1);
    expect(executeScript).toHaveBeenCalledWith(
      expect.objectContaining({ target: { tabId: 1, frameIds: [7] } }),
    );
    expect(chrome.attached.has(1)).toBe(true);
  });

  it("doesn't inject a script when every frame's content script answered", async () => {
    chrome.addTab({ id: 1 });
    const { ws } = await startPaired(await createDaemonKey());
    chrome.debugger.attach.mockRejectedValueOnce(blocked());
    Object.assign(fakeBrowser.webNavigation, {
      getAllFrames: async () => [{ frameId: 0 }, { frameId: 7 }],
    });
    Object.assign(fakeBrowser.tabs, {
      sendMessage: vi.fn(async () => scan(1).result),
    });
    const executeScript = vi.fn(async () => [scan(1)]);
    Object.assign(fakeBrowser.scripting, { executeScript });

    expect(
      (await request(ws, { method: "attach", params: { tabId: 1 } })).error,
    ).toBeUndefined();

    expect(executeScript).not.toHaveBeenCalled();
  });

  it("doesn't wait for a frame that never answers, and injects a script into it", async () => {
    chrome.addTab({ id: 1 });
    const { ws } = await startPaired(await createDaemonKey());
    chrome.debugger.attach.mockRejectedValueOnce(blocked());
    Object.assign(fakeBrowser.webNavigation, {
      getAllFrames: async () => [{ frameId: 0 }],
    });
    Object.assign(fakeBrowser.tabs, {
      sendMessage: vi.fn(() => new Promise(() => {})),
    });
    const executeScript = vi.fn(async () => [scan(1)]);
    Object.assign(fakeBrowser.scripting, { executeScript });

    // The reply timeout is 2 s, longer than `vi.waitFor()`'s default
    expect(
      (await request(ws, { method: "attach", params: { tabId: 1 } }, 5000))
        .error,
    ).toBeUndefined();

    expect(executeScript).toHaveBeenCalledWith(
      expect.objectContaining({ target: { tabId: 1, frameIds: [0] } }),
    );
  });

  it("injects a script into every frame when the frames can't be listed", async () => {
    chrome.addTab({ id: 1 });
    const { ws } = await startPaired(await createDaemonKey());
    chrome.debugger.attach.mockRejectedValueOnce(blocked());
    Object.assign(fakeBrowser.webNavigation, {
      getAllFrames: async () => {
        throw new Error("No frames during a navigation");
      },
    });
    Object.assign(fakeBrowser.tabs, {
      sendMessage: vi.fn(async () => scan(0).result),
    });
    const executeScript = vi.fn(async () => [scan(1)]);
    Object.assign(fakeBrowser.scripting, { executeScript });

    expect(
      (await request(ws, { method: "attach", params: { tabId: 1 } })).error,
    ).toBeUndefined();

    expect(executeScript).toHaveBeenCalledWith(
      expect.objectContaining({ target: { tabId: 1, allFrames: true } }),
    );
  });

  it("leaves the page alone once agents may no longer use the tab", async () => {
    chrome.addTab({ id: 1 });
    const { ws } = await startPaired(await createDaemonKey());
    const executeScript = vi.fn(async () => [scan(1)]);
    Object.assign(fakeBrowser.scripting, { executeScript });
    chrome.debugger.attach.mockImplementationOnce(async () => {
      // **Stop** comes while the attach is failing
      await pausedItem.setValue(true);
      throw blocked();
    });

    expect(
      (await request(ws, { method: "attach", params: { tabId: 1 } })).error,
    ).toBeTruthy();

    expect(executeScript).not.toHaveBeenCalled();
    expect(chrome.attached.has(1)).toBe(false);
  });

  it("gives up and names the extension when the frame keeps coming back", async () => {
    chrome.addTab({ id: 1 });
    const { ws } = await startPaired(await createDaemonKey());
    chrome.debugger.attach.mockRejectedValue(blocked());
    const executeScript = vi.fn(async () => [scan(1)]);
    Object.assign(fakeBrowser.scripting, { executeScript });
    Object.assign(fakeBrowser.webNavigation, {
      getAllFrames: async () => [
        {
          url: "chrome-extension://nngceckbapebfimnlniiiahkandclblb/menu.html",
        },
      ],
    });

    const { error } = await request(ws, {
      method: "attach",
      params: { tabId: 1 },
    });
    expect(error).toMatch(/Bitwarden .*turn that extension off/);
    expect(error).toMatch(/still there after 2 removals/);

    expect(executeScript).toHaveBeenCalledTimes(2);
    expect(chrome.debugger.attach).toHaveBeenCalledTimes(3);
    expect(chrome.attached.has(1)).toBe(false);
  });

  it("names the extension without trying again when the script can't run or finds no frame", async () => {
    chrome.addTab({ id: 1 });
    const { ws } = await startPaired(await createDaemonKey());
    chrome.debugger.attach.mockRejectedValue(blocked());
    Object.assign(fakeBrowser.webNavigation, {
      getAllFrames: async () => [
        {
          url: "chrome-extension://nngceckbapebfimnlniiiahkandclblb/menu.html",
        },
      ],
    });

    for (const [executeScript, explanation] of [
      [
        vi.fn(async () => {
          throw new Error("Cannot access contents of the page");
        }),
        /script couldn't run: Cannot access contents of the page/,
      ],
      [
        vi.fn(async () => [
          scan(0, {
            iframes: 3,
            shadowRoots: 2,
            hasDom: false,
            schemes: ["blob"],
          }),
        ]),
        /no content script answered \(asked 1 frames .*\), so an injected script ran in 1 frames \(1 answered\) and removed 0 of 3 iframes \(2 shadow roots, no chrome\.dom, other iframe URLs: blob\)/,
      ],
    ] as const) {
      chrome.debugger.attach.mockClear();
      Object.assign(fakeBrowser.scripting, { executeScript });
      const { error } = await request(ws, {
        method: "attach",
        params: { tabId: 1 },
      });
      expect(error).toMatch(/Bitwarden/);
      expect(error).toMatch(explanation);
      expect(chrome.debugger.attach).toHaveBeenCalledTimes(1);
    }
  });
});

describe("what the daemon can't reach through an attached tab", () => {
  it("refuses CDP commands that reach other sites or tabs, and navigating to browser pages", async () => {
    chrome.addTab({ id: 1 });
    const { ws } = await startPaired(await createDaemonKey());
    await request(ws, { method: "attach", params: { tabId: 1 } });

    for (const method of [
      "Network.getAllCookies",
      "Network.getCookies",
      "Network.setCookie",
      "Storage.getCookies",
      "Storage.setCookies",
      "Storage.clearDataForOrigin",
      "IndexedDB.requestData",
      "Target.createTarget",
      "Target.attachToTarget",
    ]) {
      expect(
        (await request(ws, { method: "cdp", params: { tabId: 1, method } }))
          .error,
      ).toMatch(/doesn't allow/);
    }
    expect(
      (
        await request(ws, {
          method: "cdp",
          params: {
            tabId: 1,
            method: "Page.navigate",
            params: { url: "chrome://settings/" },
          },
        })
      ).error,
    ).toMatch(/browser page/);
    expect(
      chrome.debugger.sendCommand.mock.calls.map(([, method]) => method),
    ).toEqual(["Target.getTargetInfo"]);

    expect(
      await request(ws, {
        method: "cdp",
        params: {
          tabId: 1,
          method: "Page.navigate",
          params: { url: "https://example.com/next" },
        },
      }),
    ).toMatchObject({ result: {} });
  });

  it("detaches when an attached tab starts loading a browser page, before it commits", async () => {
    chrome.addTab({ id: 1 });
    const { ws } = await startPaired(await createDaemonKey());
    await request(ws, { method: "attach", params: { tabId: 1 } });

    // A subframe doesn't detach the tab
    await fakeBrowser.webNavigation.onBeforeNavigate.trigger({
      tabId: 1,
      frameId: 3,
      parentFrameId: 0,
      url: "chrome://settings/",
      processId: 1,
      timeStamp: 0,
    } as Browser.webNavigation.WebNavigationBaseCallbackDetails);
    expect(chrome.attached.has(1)).toBe(true);

    await fakeBrowser.webNavigation.onBeforeNavigate.trigger({
      tabId: 1,
      frameId: 0,
      parentFrameId: -1,
      url: "chrome://settings/",
      processId: 1,
      timeStamp: 0,
    } as Browser.webNavigation.WebNavigationBaseCallbackDetails);
    await vi.waitFor(() =>
      expect(events(ws, "detached")).toEqual([
        { tabId: 1, reason: "not_allowed" },
      ]),
    );
    expect(chrome.attached.has(1)).toBe(false);
  });

  it("doesn't keep an attach that Stop or a navigation to a browser page overtook", async () => {
    chrome.addTab({ id: 1 });
    chrome.addTab({ id: 2 });
    const { ws, control } = await startPaired(await createDaemonKey());

    const attach = chrome.debugger.attach.getMockImplementation()!;
    chrome.debugger.attach.mockImplementationOnce(async (target) => {
      await attach(target);
      chrome.tabs.get(1)!.pendingUrl = "chrome://settings/";
    });
    expect(
      (await request(ws, { method: "attach", params: { tabId: 1 } })).error,
    ).toMatch(/can't use tab 1/);
    expect(chrome.attached.has(1)).toBe(false);

    chrome.debugger.attach.mockImplementationOnce(async (target) => {
      await attach(target);
      await control.stop();
    });
    expect(
      (await request(ws, { method: "attach", params: { tabId: 2 } })).error,
    ).toBe(PAUSED_MESSAGE);
    expect(chrome.attached.size).toBe(0);
    expect(control.debugger.attachedTabIds.size).toBe(0);
  });

  it("refuses tabs outside normal windows", async () => {
    chrome.addTab({ id: 1, url: "about:blank" });
    chrome.addTab({ id: 2, windowId: chrome.addPopupWindow() });
    const { ws } = await startPaired(await createDaemonKey());

    await vi.waitFor(async () =>
      expect((await latestState(ws)).tabs.map((tab) => tab.tabId)).toEqual([1]),
    );
    expect(
      (await request(ws, { method: "activateTab", params: { tabId: 2 } }))
        .error,
    ).toMatch(/normal window/);
    expect(chrome.debugger.attach).not.toHaveBeenCalled();
  });

  it("leaves tabs that pages open alone while paused, or when they open a browser page", async () => {
    chrome.addTab({ id: 1 });
    const { ws, control } = await startPaired(await createDaemonKey());
    await request(ws, { method: "attach", params: { tabId: 1 } });

    const popupWindowId = chrome.addPopupWindow();
    chrome.addTab({
      id: 50,
      windowId: popupWindowId,
      url: "https://a.example/",
    });
    chrome.addTab({
      id: 51,
      windowId: popupWindowId,
      url: "chrome://settings/",
    });
    const opened = (tabId: number, url: string) =>
      fakeBrowser.webNavigation.onCreatedNavigationTarget.trigger({
        sourceTabId: 1,
        sourceProcessId: 1,
        sourceFrameId: 0,
        tabId,
        url,
        timeStamp: 0,
      });

    await opened(51, "chrome://settings/");
    await control.stop();
    await opened(50, "https://a.example/");
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(events(ws, "tabOpened")).toEqual([]);
    expect(chrome.tabs.get(50)!.windowId).toBe(popupWindowId);
    expect(chrome.tabs.get(51)!.windowId).toBe(popupWindowId);
  });
});

describe("tab groups", () => {
  it("opens agents' tabs in the background in a named group per app, each app in its own color", async () => {
    chrome.addTab({ id: 1, active: true });
    const { ws } = await startPaired(await createDaemonKey());

    const a = await request(ws, {
      method: "createTab",
      params: {
        url: "https://a.example/",
        app: { id: "claude-code", name: "Claude Code" },
      },
    });
    const b = await request(ws, {
      method: "createTab",
      params: { app: { id: "cursor", name: "Cursor" } },
    });
    const a2 = await request(ws, {
      method: "createTab",
      params: { app: { id: "claude-code", name: "Claude Code" } },
    });
    const tabA = chrome.tabs.get((a.result as { tabId: number }).tabId)!;
    const tabB = chrome.tabs.get((b.result as { tabId: number }).tabId)!;
    const tabA2 = chrome.tabs.get((a2.result as { tabId: number }).tabId)!;

    expect(tabA.active).toBe(false);
    expect(tabB.url).toBe("about:blank");
    expect(tabA2.groupId).toBe(tabA.groupId);
    expect(chrome.groups.get(tabA.groupId)).toMatchObject({
      title: "Claude Code",
      color: "blue",
    });
    expect(chrome.groups.get(tabB.groupId)).toMatchObject({
      title: "Cursor",
      color: "red",
    });
    // The extension's own grouping isn't a user's drag
    expect(events(ws, "tabAssigned")).toEqual([]);
    const state = await vi.waitFor(async () => {
      const state = await latestState(ws);
      expect(state.tabs).toHaveLength(4);
      return state;
    });
    expect(state.tabs.find((tab) => tab.tabId === tabB.id)?.appId).toBe(
      "cursor",
    );
  });

  it("reports tabs the user drags into an app's group or out of it", async () => {
    chrome.addTab({ id: 1 });
    const { ws } = await startPaired(await createDaemonKey());
    await request(ws, {
      method: "createTab",
      params: { app: { id: "claude-code", name: "Claude Code" } },
    });
    const [groupId] = chrome.groups.keys();

    await chrome.dragTab(1, groupId);
    await vi.waitFor(() =>
      expect(events(ws, "tabAssigned")).toEqual([
        { tabId: 1, appId: "claude-code" },
      ]),
    );
    await chrome.dragTab(1, -1);
    await vi.waitFor(() =>
      expect(events(ws, "tabAssigned")).toEqual([
        { tabId: 1, appId: "claude-code" },
        { tabId: 1, appId: null },
      ]),
    );
    // A group that isn't an app's is the user's own
    chrome.groups.set(999, { id: 999, windowId: 1 });
    await chrome.dragTab(1, 999);
    expect(events(ws, "tabAssigned")).toHaveLength(2);
  });

  it("only assigns pinned tabs, since grouping unpins them, and keeps them assigned", async () => {
    chrome.addTab({ id: 1, pinned: true });
    const { ws } = await startPaired(await createDaemonKey());

    await request(ws, {
      method: "groupTab",
      params: { tabId: 1, app: { id: "claude-code", name: "Claude Code" } },
    });
    expect(chrome.tabs.get(1)).toMatchObject({ pinned: true, groupId: -1 });
    await vi.waitFor(async () =>
      expect((await latestState(ws)).tabs[0]).toMatchObject({
        tabId: 1,
        appId: "claude-code",
      }),
    );
    await chrome.updateTab(1, { title: "Changed" });
    expect(events(ws, "tabAssigned")).toEqual([]);

    await request(ws, { method: "groupTab", params: { tabId: 1, app: null } });
    await vi.waitFor(async () =>
      expect((await latestState(ws)).tabs[0].appId).toBeUndefined(),
    );
  });

  it("gives every app a different color while Chrome's 9 last", async () => {
    chrome.addTab({ id: 1 });
    const { ws } = await startPaired(await createDaemonKey());
    for (let i = 0; i < 9; i++) {
      await request(ws, {
        method: "createTab",
        params: { app: { id: `app-${i}`, name: `App ${i}` } },
      });
    }
    const colors = [...chrome.groups.values()].map((group) => group.color);
    expect(new Set(colors).size).toBe(9);
  });

  it("puts tabs that an agent's page opens in its group, moving popups into a normal window", async () => {
    chrome.addTab({ id: 1 });
    const { ws } = await startPaired(await createDaemonKey());
    const created = await request(ws, {
      method: "createTab",
      params: {
        url: "https://shop.example/",
        app: { id: "claude-code", name: "Claude Code" },
      },
    });
    const openerId = (created.result as { tabId: number }).tabId;
    await request(ws, { method: "attach", params: { tabId: openerId } });

    const popupWindowId = chrome.addPopupWindow();
    chrome.addTab({
      id: 50,
      windowId: popupWindowId,
      url: "https://pay.example/",
    });
    await fakeBrowser.webNavigation.onCreatedNavigationTarget.trigger({
      sourceTabId: openerId,
      sourceProcessId: 1,
      sourceFrameId: 0,
      tabId: 50,
      url: "https://pay.example/",
      timeStamp: 0,
    });

    await vi.waitFor(() =>
      expect(events(ws, "tabOpened")).toEqual([
        { tabId: 50, openerTabId: openerId, url: "https://pay.example/" },
      ]),
    );
    const popupTab = chrome.tabs.get(50)!;
    expect(chrome.windows.get(popupTab.windowId)?.type).toBe("normal");
    expect(popupTab.groupId).toBe(chrome.tabs.get(openerId)!.groupId);
    expect(chrome.debugger.attach).toHaveBeenCalledTimes(1);
  });

  it("doesn't report tabs that the user's own tabs open", async () => {
    chrome.addTab({ id: 1 });
    chrome.addTab({ id: 2 });
    const { ws } = await startPaired(await createDaemonKey());
    await fakeBrowser.webNavigation.onCreatedNavigationTarget.trigger({
      sourceTabId: 1,
      sourceProcessId: 1,
      sourceFrameId: 0,
      tabId: 2,
      url: "https://example.com/",
      timeStamp: 0,
    });
    expect(events(ws, "tabOpened")).toEqual([]);
  });
});

describe("the badge", () => {
  it("counts attached tabs in the color of the app that acted last, and is empty when none are", async () => {
    chrome.addTab({ id: 1 });
    chrome.addTab({ id: 2 });
    const { ws } = await startPaired(await createDaemonKey());
    await request(ws, {
      method: "createTab",
      params: { app: { id: "a", name: "A" } },
    });
    await request(ws, {
      method: "createTab",
      params: { app: { id: "b", name: "B" } },
    });

    await request(ws, { method: "attach", params: { tabId: 1 } });
    await request(ws, { method: "attach", params: { tabId: 2 } });
    await request(ws, { method: "activity", params: { appId: "b" } });
    await vi.waitFor(async () => expect(await badgeText()).toBe("2"));
    expect(await fakeBrowser.action.getBadgeBackgroundColor({})).toEqual(
      hexToRgba(TAB_GROUP_HEX.red),
    );

    await request(ws, { method: "detach", params: { tabId: 1 } });
    await vi.waitFor(async () => expect(await badgeText()).toBe("1"));
    await request(ws, { method: "detach", params: { tabId: 2 } });
    await vi.waitFor(async () => expect(await badgeText()).toBe(""));
    expect(chrome.attached.size).toBe(0);
    // Detaches the daemon asked for aren't reported back
    expect(events(ws, "detached")).toEqual([]);
  });

  it('shows "!" when a 0.1.x server answers on 9009', async () => {
    const { control } = await start({ 9009: "legacy" });
    const old = await vi.waitFor(() => {
      const ws = FakeWebSocket.latest("localhost:9009");
      if (!ws) {
        throw new Error("Not yet");
      }
      return ws;
    });
    old.open();
    await vi.waitFor(async () => expect(await badgeText()).toBe("!"));
    expect((await control.getView()).legacyServer).toBe(true);
  });
});

describe("hooks", () => {
  it("passes connecting and pairing to onEvent, and each activity to onActivity", async () => {
    const onEvent = vi.fn();
    const onActivity = vi.fn();
    const { ws } = await startPaired(await createDaemonKey(), {
      onEvent,
      onActivity,
    });

    expect(onEvent).toHaveBeenCalledWith(
      "daemon connected",
      expect.objectContaining({ paired: false }),
    );
    expect(onEvent).toHaveBeenCalledWith("daemon paired", undefined);
    await request(ws, { method: "activity", params: { appId: "a" } });
    expect(onActivity).toHaveBeenCalledOnce();
  });

  it("stays connected when onEvent throws, and answers activity when onActivity fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { control, ws } = await startPaired(await createDaemonKey(), {
      onEvent: () => {
        throw new Error("Analytics are down");
      },
      onActivity: async () => {
        throw new Error("Storage is full");
      },
    });

    expect((await control.getView()).connection).toMatchObject({
      state: "connected",
      pairing: "paired",
    });
    const response = await request(ws, {
      method: "activity",
      params: { appId: "a" },
    });
    expect(response).not.toHaveProperty("error");
  });
});

describe("the custom port", () => {
  it("reconnects on the port the user sets, and goes back to the default ports when cleared", async () => {
    const { control, ws } = await start({ 9010: "daemon", 9123: "daemon" });
    expect((await control.getView()).relayPort).toBeNull();

    await control.setRelayPort(9123);
    expect((await control.getView()).relayPort).toBe(9123);
    await vi.waitFor(() => expect(ws.readyState).toBe(FakeWebSocket.CLOSED));
    // After the first retry delay (1 s)
    await vi.waitFor(
      () => expect(FakeWebSocket.latest("9123/extension")).toBeDefined(),
      { timeout: 4000 },
    );

    await control.setRelayPort(null);
    expect((await control.getView()).relayPort).toBeNull();
  });

  it("refuses ports the daemon can't use", async () => {
    const { control } = await start({});
    for (const port of [0, 80, 1023, 9009, 65536, 1.5, Number.NaN]) {
      await expect(control.setRelayPort(port)).rejects.toThrow("Invalid port");
    }
    expect((await control.getView()).relayPort).toBeNull();
  });
});

describe("Stop and Resume", () => {
  it("detaches every tab, refuses agents and keeps tabs open until Resume, across a service worker restart", async () => {
    chrome.addTab({ id: 1 });
    chrome.addTab({ id: 2 });
    const key = await createDaemonKey();
    const { ws, control } = await startPaired(key);
    await request(ws, { method: "attach", params: { tabId: 1 } });
    await request(ws, { method: "attach", params: { tabId: 2 } });

    await control.stop();
    expect(chrome.attached.size).toBe(0);
    expect(chrome.tabs.size).toBe(2);
    expect(await badgeText()).toBe("");
    expect((await latestState(ws)).paused).toBe(true);
    expect(events(ws, "detached")).toEqual([
      { tabId: 1, reason: "paused" },
      { tabId: 2, reason: "paused" },
    ]);
    for (const req of [
      { method: "attach", params: { tabId: 1 } },
      { method: "createTab", params: { app: { id: "a", name: "A" } } },
      { method: "activateTab", params: { tabId: 1 } },
    ] as ExtensionRequest[]) {
      expect((await request(ws, req)).error).toBe(PAUSED_MESSAGE);
    }

    // The service worker restarts: paused comes back from storage.session
    stopListeners.forEach((stop) => stop());
    stopListeners = [];
    const restarted = await start();
    expect(restarted.ws.messages("hello")[0].state.paused).toBe(true);
    await welcome(restarted.ws, key);
    expect(
      (await request(restarted.ws, { method: "attach", params: { tabId: 1 } }))
        .error,
    ).toBe(PAUSED_MESSAGE);

    await restarted.control.resume();
    expect(await pausedItem.getValue()).toBe(false);
    expect((await latestState(restarted.ws)).paused).toBe(false);
    expect(
      await request(restarted.ws, { method: "attach", params: { tabId: 1 } }),
    ).toMatchObject({ result: { targetInfo: { targetId: "target-1" } } });
  });

  it("pauses when the user clicks Cancel on Chrome's debugging bar", async () => {
    chrome.addTab({ id: 1 });
    const { ws } = await startPaired(await createDaemonKey());
    await request(ws, { method: "attach", params: { tabId: 1 } });

    chrome.attached.delete(1);
    await chrome.debugger.onDetach.trigger({ tabId: 1 }, "canceled_by_user");
    await vi.waitFor(async () =>
      expect(await pausedItem.getValue()).toBe(true),
    );
    expect(events(ws, "detached")).toContainEqual({
      tabId: 1,
      reason: "canceled_by_user",
    });
    await vi.waitFor(async () =>
      expect((await latestState(ws)).paused).toBe(true),
    );
  });
});

describe("the connection status", () => {
  it("doesn't show a connection from before the service worker restarted", async () => {
    await connectionStatusItem.setValue({
      state: "connected",
      port: 9010,
      daemonVersion: "2.0.0",
      publicKey: "key",
      code: "482 913",
      pairing: "paired",
    });
    await start({});
    await vi.waitFor(async () =>
      expect(await connectionStatusItem.getValue()).toEqual({
        state: "searching",
      }),
    );
  });
});

function hexToRgba(hex: string) {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255, 255];
}
