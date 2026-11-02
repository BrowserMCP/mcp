import net from "node:net";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  NO_EXTENSION_MESSAGE,
  RelayCloseCode,
  createBrowserId,
  RelayUpdateReason,
  pairingRequiredMessage,
} from "@browsermcp/protocol";

import type { BackendEvents } from "@/contracts";
import type { BrowserSlot } from "@/relay/browser-slot";
import {
  browserDisconnectedMessage,
  noSuchTabMessage,
  PAUSED_MESSAGE,
  rejectedExtensionMessage,
  TAB_DETACHED_MESSAGE,
  tooManyBrowsersReason,
  UPDATE_EXTENSION_MESSAGE,
} from "@/relay/messages";
import { FakeChromium, FakeExtension } from "@/testing/fake-extension";
import { startTestBackend } from "@/testing/test-backend";

let chromium: FakeChromium;
/** A second browser process, whose tab IDs start at 1 too */
let chromium2: FakeChromium;
let relay: Awaited<ReturnType<typeof startTestBackend>>;
const extensions: FakeExtension[] = [];

async function connect(
  options: Partial<Parameters<typeof FakeExtension.connect>[0]> = {},
) {
  const extension = await FakeExtension.connect({
    port: relay.port,
    chromium,
    ...options,
  });
  extensions.push(extension);
  return extension;
}

/** The backend's first browser slot, whose internals some tests reach into */
function slot() {
  return (relay.backend as unknown as { slots: BrowserSlot[] }).slots[0]!;
}

beforeAll(async () => {
  [chromium, chromium2] = await Promise.all([
    FakeChromium.launch(),
    FakeChromium.launch(),
  ]);
}, 60_000);

afterAll(async () => {
  await chromium?.close();
  await chromium2?.close();
});

beforeEach(async () => {
  relay = await startTestBackend();
});

afterEach(async () => {
  for (const extension of extensions.splice(0)) {
    await extension.close();
  }
  await relay.close();
});

describe("RelayBackend", () => {
  it("names a refused extension until one connects", async () => {
    const id = "a".repeat(32);
    relay.backend.noteRejectedExtension(undefined);
    expect(relay.backend.unavailableReason()).toBe(NO_EXTENSION_MESSAGE);
    relay.backend.noteRejectedExtension(id);
    expect(relay.backend.unavailableReason()).toBe(
      rejectedExtensionMessage(id),
    );
    await expect(relay.backend.page(1)).rejects.toThrow(id);

    await connect();
    expect(relay.backend.unavailableReason()).toBeNull();
  });

  it("says no browser is connected until an extension connects", async () => {
    expect(relay.backend.connected).toBe(false);
    expect(relay.backend.unavailableReason()).toBe(NO_EXTENSION_MESSAGE);
    await expect(relay.backend.page(1)).rejects.toThrow(NO_EXTENSION_MESSAGE);

    const connections: boolean[] = [];
    relay.backend.on("connection", ({ connected }) =>
      connections.push(connected),
    );
    await connect();
    expect(relay.backend.connected).toBe(true);
    expect(relay.backend.unavailableReason()).toBeNull();
    expect(connections).toEqual([true]);
  });

  it("signs the extension's challenge with its key (verified with WebCrypto)", async () => {
    const extension = await connect();
    expect(await extension.verifyWelcome()).toBe(true);
    expect(extension.welcome.protocol).toBe(1);
  });

  it("signs the port it listens on, so a challenge relayed from another port fails verification", async () => {
    // A program on another port that relays the extension's connection to the real daemon
    const relayer = net.createServer((socket) => {
      const upstream = net.connect(relay.port, "127.0.0.1");
      socket.pipe(upstream).pipe(socket);
      socket.on("error", () => upstream.destroy());
      upstream.on("error", () => socket.destroy());
    });
    await new Promise<void>((resolve) =>
      relayer.listen(0, "127.0.0.1", resolve),
    );
    try {
      const relayed = await connect({
        port: (relayer.address() as net.AddressInfo).port,
      });
      expect(await relayed.verifyWelcome()).toBe(false);
      // The signature itself is the daemon's, over its own port
      relayed.port = relay.port;
      expect(await relayed.verifyWelcome()).toBe(true);
    } finally {
      for (const extension of extensions.splice(0)) {
        await extension.close();
      }
      relayer.close();
    }
  });

  it("asks for Allow, with the popup's code, while pairing is pending", async () => {
    const extension = await connect({ pairing: "pending" });
    const code = extension.code!;
    expect(code).toMatch(/^\d{3} \d{3}$/);
    // The popup's code, computed from the nonces the extension sent and checked against the commitment, is the one in the tool message
    await vi.waitUntil(() => relay.backend.unavailableReason()?.includes(code));
    expect(relay.backend.unavailableReason()).toBe(
      pairingRequiredMessage(code),
    );
    expect(relay.backend.unavailableReason()).toBe(
      `Click Allow in the Browser MCP extension's popup. The code is ${code}`,
    );
    expect(relay.backend.tabs()).toEqual([]);
    await expect(relay.backend.page(1)).rejects.toThrow(`The code is ${code}`);

    const states: BackendEvents["state"][] = [];
    relay.backend.on("state", (state) => states.push(state));
    extension.allow();
    await vi.waitUntil(() => states.at(-1)?.pairing === "paired");
    expect(relay.backend.unavailableReason()).toBeNull();
    expect(relay.backend.tabs().length).toBeGreaterThan(0);
  });

  it("commits to its nonce in the signed welcome, and reveals it only after the extension's nonce", async () => {
    const extension = await connect({
      pairing: "pending",
      pairingNonce: false,
    });
    expect(await extension.verifyWelcome()).toBe(true);
    expect(atob(extension.welcome.pairingCommitment)).toHaveLength(32);
    // Before the extension's nonce, still Allow, without a code
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(extension.daemonNonce).toBeNull();
    expect(relay.backend.unavailableReason()).toBe(pairingRequiredMessage());
    expect(relay.backend.unavailableReason()).not.toContain("code");

    await extension.exchangePairingNonces();
    await vi.waitUntil(() =>
      relay.backend.unavailableReason()?.includes(extension.code!),
    );
  });

  it("gives a fresh code on each connection", async () => {
    const first = await connect({ pairing: "pending" });
    await first.disconnect();
    const second = await connect({ pairing: "pending" });
    expect(second.welcome.publicKey).toBe(first.welcome.publicKey);
    expect(second.welcome.pairingCommitment).not.toBe(
      first.welcome.pairingCommitment,
    );
    expect(second.daemonNonce).not.toBe(first.daemonNonce);
    // Different nonces give another code (equal by chance one time in a million)
    expect(second.code).not.toBe(first.code);
    await vi.waitUntil(() =>
      relay.backend.unavailableReason()?.includes(second.code!),
    );
  });

  it("reveals its nonce once per connection, and closes a connection that sends another", async () => {
    const extension = await connect({ pairing: "pending" });
    extension.postRaw({ type: "pairingNonce", nonce: "another" });
    expect(await extension.closed).toEqual({
      code: 1008,
      reason: "Unexpected pairingNonce",
    });
  });

  it("closes an extension with an unsupported protocol and says to update it", async () => {
    await expect(connect({ protocol: 0 })).rejects.toThrow(
      `Closed ${RelayCloseCode.unsupportedProtocol} ${RelayUpdateReason.updateExtension}`,
    );
    expect(relay.backend.unavailableReason()).toBe(UPDATE_EXTENSION_MESSAGE);
  });

  it("refuses tabs the connected browser doesn't report", async () => {
    await connect();
    await expect(relay.backend.page(987_654)).rejects.toThrow(
      noSuchTabMessage(987_654),
    );
  });

  it("finds a tab the extension reports a moment after it appears", async () => {
    // The real extension sends `state` 100 ms after a change
    const extension = await connect({ stateDelayMs: 150 });
    const tabId = await extension.openTab("about:blank");
    expect(relay.backend.tabs().map((tab) => tab.tabId)).not.toContain(tabId);
    expect((await relay.backend.findTab(tabId))?.tabId).toBe(tabId);
  });

  it("doesn't find a tab the extension never reports", async () => {
    await relay.close();
    relay = await startTestBackend({
      unknownTabWaitMs: 100,
    });
    await connect();
    await expect(relay.backend.findTab(987_654)).resolves.toBeUndefined();
  });

  it("times out requests the extension doesn't answer, forgetting them", async () => {
    await relay.close();
    relay = await startTestBackend({ requestTimeoutMs: 200 });
    const extension = await connect();
    extension.answering = false;
    const tabId = [...extension.tabs.keys()][0]!;
    await expect(relay.backend.activateTab(tabId)).rejects.toThrow(
      "The browser didn't answer activateTab in time",
    );
    expect(slot().connection?.pendingCount).toBe(0);
    extension.answering = true;
  });

  it("forgets page waiters that timed out", async () => {
    await relay.close();
    relay = await startTestBackend({ pageTimeoutMs: 100 });
    await connect();
    const backend = slot() as unknown as {
      waitForPage(targetId: string): Promise<unknown>;
      pageWaiters: Map<string, unknown>;
    };
    await expect(backend.waitForPage("missing")).rejects.toThrow(
      "didn't become ready",
    );
    expect(backend.pageWaiters.size).toBe(0);
  });

  it("keeps waiting for a tab that re-attaches, and stops at once when one detaches again before it's ready", async () => {
    await relay.close();
    // Long enough that only the detach can end the wait
    relay = await startTestBackend({
      pageTimeoutMs: 30_000,
      reattachDelayMs: 10,
    });
    const extension = await connect();
    const tabId = await extension.openTab("about:blank");
    // Playwright never gets the Page, as when the target detaches while it's being identified (another extension putting its frame back)
    const backend = slot() as unknown as {
      identify(page: unknown): Promise<void>;
      pageWaiters: Map<string, unknown>;
    };
    backend.identify = async () => {};
    const started = Date.now();
    const page = relay.backend.page(tabId);
    const attaches = () =>
      extension.requests.filter((request) => request.method === "attach")
        .length;
    const detachAfterAttach = async (count: number) => {
      await expect.poll(attaches).toBe(count);
      await expect.poll(() => backend.pageWaiters.size).toBe(1);
      extension.event({
        type: "detached",
        data: { tabId, reason: "target_closed" },
      });
    };
    // The first detach re-attaches: the command waits for the new target
    await detachAfterAttach(1);
    // The second, within the cooldown, lets the tab go
    await detachAfterAttach(2);
    await expect(page).rejects.toThrow(TAB_DETACHED_MESSAGE);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(backend.pageWaiters.size).toBe(0);
  });

  it("waits for an extension that's expected back, then answers at once", async () => {
    await relay.close();
    relay = await startTestBackend({ reconnectGraceMs: 3000 });
    setTimeout(() => void connect(), 300);
    await relay.backend.whenReady();
    expect(relay.backend.unavailableReason()).toBeNull();

    await extensions.pop()!.close();
    await vi.waitUntil(() => !relay.backend.connected);
    const start = Date.now();
    await relay.backend.whenReady();
    expect(Date.now() - start).toBeGreaterThan(2000);
    expect(relay.backend.unavailableReason()).toBe(NO_EXTENSION_MESSAGE);
    const again = Date.now();
    await relay.backend.whenReady();
    expect(Date.now() - again).toBeLessThan(100);
  });

  it("returns a new tab once the extension reports it", async () => {
    // The real extension sends `state` 100 ms after a change, after answering `createTab`
    await connect({ stateDelayMs: 150 });
    const tabId = await relay.backend.createTab({
      app: { id: "claude-code", name: "Claude Code" },
    });
    expect(relay.backend.tabs().map((tab) => tab.tabId)).toContain(tabId);
  });

  it("returns from closing a tab once the extension no longer reports it", async () => {
    await connect({ stateDelayMs: 150 });
    const tabId = await relay.backend.createTab({
      app: { id: "claude-code", name: "Claude Code" },
    });
    await relay.backend.closeTab(tabId);
    expect(relay.backend.tabs().map((tab) => tab.tabId)).not.toContain(tabId);
  });

  it("forwards tab events and requests", async () => {
    const extension = await connect();
    const assigned: BackendEvents["tabAssigned"][] = [];
    relay.backend.on("tabAssigned", (event) => assigned.push(event));
    const tabId = [...extension.tabs.keys()][0]!;
    extension.assign(tabId, "cursor");
    await vi.waitUntil(() => assigned.length === 1);
    expect(assigned[0]).toEqual({ tabId, appId: "cursor" });

    await relay.backend.groupTab(tabId, {
      id: "claude-code",
      name: "Claude Code",
    });
    expect(extension.tabs.get(tabId)?.appId).toBe("claude-code");
    relay.backend.noteActivity("claude-code");
    await vi.waitUntil(() =>
      extension.requests.some((request) => request.method === "activity"),
    );
  });
});

describe("RelayBackend with several browsers", () => {
  /** Reconnecting and reporting state can take a while when every test file runs at once */
  const waitUntil = <T>(check: () => T) =>
    vi.waitUntil(check, { timeout: 5000 });
  const app = { id: "claude-code", name: "Claude Code" };

  /** Two browsers (separate processes, so their Chrome tab IDs collide), each with a tab of its own */
  async function connectTwo(
    options: {
      first?: Partial<Parameters<typeof FakeExtension.connect>[0]>;
      second?: Partial<Parameters<typeof FakeExtension.connect>[0]>;
    } = {},
  ) {
    const first = await connect({ windowId: 1, ...options.first });
    const second = await connect({
      chromium: chromium2,
      windowId: 2,
      ...options.second,
    });
    // Tabs of earlier tests stay open in the browsers, so each test's are told by a token. Encoded, as Chrome reports data: URLs once they load
    const token = Math.random().toString(36).slice(2);
    const urls = {
      b1: `data:text/html,%3Ctitle%3EOne%3C%2Ftitle%3E${token}`,
      b2: `data:text/html,%3Ctitle%3ETwo%3C%2Ftitle%3E${token}`,
    };
    const firstTab = await first.openTab(urls.b1);
    const secondTab = await second.openTab(urls.b2);
    const find = (browser: "b1" | "b2") =>
      relay.backend
        .tabs()
        .find((tab) => tab.browser === browser && tab.url === urls[browser]);
    await waitUntil(() => find("b1") && find("b2"));
    const publicId = (browser: "b1" | "b2") => find(browser)!.tabId;
    return {
      first,
      second,
      firstTab,
      secondTab,
      firstId: publicId("b1"),
      secondId: publicId("b2"),
    };
  }

  it("connects both, with tab IDs unique across them and labels from their names", async () => {
    const { first, second, firstId, secondId } = await connectTwo();
    expect(relay.backend.connected).toBe(true);
    expect(first.tabs.size + second.tabs.size).toBe(
      relay.backend.tabs().length,
    );
    expect(
      relay.backend.browsers().map(({ id, label, connected }) => ({
        id,
        label,
        connected,
      })),
    ).toEqual([
      { id: "b1", label: "Chrome", connected: true },
      { id: "b2", label: "Chrome 2", connected: true },
    ]);
    const ids = relay.backend.tabs().map((tab) => tab.tabId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(firstId).not.toBe(secondId);
    // Each ID drives its own browser's tab
    const [one, two] = await Promise.all([
      relay.backend.page(firstId),
      relay.backend.page(secondId),
    ]);
    expect(await one.title()).toBe("One");
    expect(await two.title()).toBe("Two");
    expect(first.requests.filter((r) => r.method === "attach")).toHaveLength(1);
    expect(second.requests.filter((r) => r.method === "attach")).toHaveLength(
      1,
    );
  });

  it("keeps Chrome's tab IDs, giving others only to tabs whose ID another browser's tab has", async () => {
    const first = await connect({ windowId: 1 });
    const second = await connect({ chromium: chromium2, windowId: 2 });
    await waitUntil(
      () => relay.backend.browsers().filter((b) => b.tabs > 0).length === 2,
    );
    const ids = (browser: string) =>
      relay.backend
        .tabs()
        .filter((tab) => tab.browser === browser)
        .map((tab) => tab.tabId);
    // The first browser's tabs keep Chrome's IDs
    expect(ids("b1").sort()).toEqual([...first.tabs.keys()].sort());
    // The second's are other numbers where they collide, and Chrome's elsewhere
    for (const [chromeId, publicId] of [...second.tabs.keys()].map(
      (chromeId, i) => [chromeId, ids("b2")[i]!],
    )) {
      if (first.tabs.has(chromeId)) {
        expect(publicId).not.toBe(chromeId);
        expect(first.tabs.has(publicId)).toBe(false);
      } else {
        expect(publicId).toBe(chromeId);
      }
    }
  });

  it("takes the user's label from the popup, from states after hello", async () => {
    const { first } = await connectTwo({ second: { label: "Work" } });
    const labels = () => relay.backend.browsers().map((b) => b.label);
    await waitUntil(() => labels()[1] === "Work");
    expect(labels()).toEqual(["Chrome", "Work"]);
    // Named later, renamed, and cleared
    first.setLabel("Personal");
    await waitUntil(() => labels()[0] === "Personal");
    first.setLabel("Home");
    await waitUntil(() => labels()[0] === "Home");
    first.setLabel(undefined);
    await waitUntil(() => labels()[0] === "Chrome");
  });

  it("refuses one browser more than the most it connects", async () => {
    await relay.close();
    relay = await startTestBackend({ maxBrowsers: 2 });
    await connectTwo();
    const third = await connect({ windowId: 3, userAgent: "Third" });
    expect(await third.closed).toEqual({
      code: RelayCloseCode.anotherBrowser,
      reason: tooManyBrowsersReason(2),
    });
    expect(relay.backend.browsers()).toHaveLength(2);
  });

  it("puts a browser that reconnects with its browserId back in its slot, with its tab IDs", async () => {
    const browserId = createBrowserId();
    const { second, firstId, secondId } = await connectTwo({
      first: { browserId: createBrowserId() },
      second: { browserId },
    });
    await second.disconnect();
    await waitUntil(() => !relay.backend.browsers()[1]!.connected);
    // Its IDs fail, naming it, and never name the other browser's tab
    await expect(relay.backend.activateTab(secondId)).rejects.toThrow(
      browserDisconnectedMessage("Chrome 2"),
    );
    await expect(relay.backend.page(secondId)).rejects.toThrow(
      browserDisconnectedMessage("Chrome 2"),
    );
    await expect(relay.backend.findTab(secondId)).rejects.toThrow(
      browserDisconnectedMessage("Chrome 2"),
    );
    expect(relay.backend.tabClosed(secondId)).toBe(false);
    await expect(relay.backend.activateTab(firstId)).resolves.toBeUndefined();

    // Back, as another window (its windows can't tell it): the browserId does
    await connect({ chromium: chromium2, windowId: 7, browserId });
    await waitUntil(() => relay.backend.browsers()[1]!.connected);
    expect(relay.backend.browsers()).toHaveLength(2);
    await waitUntil(() =>
      relay.backend.tabs().some((tab) => tab.tabId === secondId),
    );
    expect(await (await relay.backend.page(secondId)).title()).toBe("Two");
  });

  it("without a browserId, tells a reconnecting browser by its windows", async () => {
    const { first, second, firstId, secondId } = await connectTwo();
    await second.disconnect();
    await first.disconnect();
    await waitUntil(() => !relay.backend.connected);
    // The second comes back first: the slot of the browser that left last (the first) is a guess its windows correct
    await connect({ chromium: chromium2, windowId: 2 });
    await waitUntil(() =>
      relay.backend.tabs().some((tab) => tab.tabId === secondId),
    );
    expect(
      relay.backend.browsers().map(({ id, connected }) => ({ id, connected })),
    ).toEqual([
      { id: "b1", connected: false },
      { id: "b2", connected: true },
    ]);
    expect(await (await relay.backend.page(secondId)).title()).toBe("Two");
    await connect({ windowId: 1 });
    await waitUntil(() =>
      relay.backend.tabs().some((tab) => tab.tabId === firstId),
    );
    expect(relay.backend.browsers()).toHaveLength(2);
  });

  it("asks for Allow per browser, without blocking the other", async () => {
    const browserId = createBrowserId();
    const { second, firstId, secondId } = await connectTwo({
      second: { browserId },
    });
    await second.disconnect();
    const pending = await connect({
      chromium: chromium2,
      windowId: 2,
      browserId,
      pairing: "pending",
    });
    await waitUntil(() => relay.backend.browsers()[1]!.connected);
    expect(relay.backend.unavailableReason()).toBeNull();
    await waitUntil(() => !!pending.code);
    await expect(relay.backend.page(secondId)).rejects.toThrow(
      `Chrome 2: ${pairingRequiredMessage(pending.code!)}`,
    );
    expect(relay.backend.tabClosed(secondId)).toBe(false);
    expect(await (await relay.backend.page(firstId)).title()).toBe("One");
    pending.allow();
    await waitUntil(() =>
      relay.backend.tabs().some((tab) => tab.tabId === secondId),
    );
    expect(await (await relay.backend.page(secondId)).title()).toBe("Two");
  });

  it("names every browser's code while all wait for Allow", async () => {
    const first = await connect({ pairing: "pending" });
    const second = await connect({
      chromium: chromium2,
      windowId: 2,
      pairing: "pending",
    });
    await waitUntil(
      () =>
        relay.backend.unavailableReason()?.includes(first.code!) &&
        relay.backend.unavailableReason()?.includes(second.code!),
    );
    expect(relay.backend.unavailableReason()).toBe(
      `Chrome: ${pairingRequiredMessage(first.code!)}\nChrome 2: ${pairingRequiredMessage(second.code!)}`,
    );
  });

  it("pauses per browser", async () => {
    const { second, firstId, secondId } = await connectTwo();
    await second.pause();
    await waitUntil(() => relay.backend.browsers()[1]!.paused);
    expect(relay.backend.paused).toBe(false);
    await expect(relay.backend.page(secondId)).rejects.toThrow(
      `Chrome 2: ${PAUSED_MESSAGE}`,
    );
    await expect(relay.backend.page(firstId)).resolves.toBeDefined();
    // New tabs open in the browser that isn't paused
    const tabId = await relay.backend.createTab({ app });
    expect(
      relay.backend.tabs().find((tab) => tab.tabId === tabId)?.browser,
    ).toBe("b1");
  });

  it("opens new tabs in the browser named, else the one focused last, else the one connected last", async () => {
    const { first, second } = await connectTwo();
    const browserOf = (tabId: number) =>
      relay.backend.tabs().find((tab) => tab.tabId === tabId)?.browser;
    expect(browserOf(await relay.backend.createTab({ app }))).toBe("b2");
    first.focus();
    await waitUntil(() => !!relay.backend.browsers()[0]!.lastFocusedAt);
    expect(browserOf(await relay.backend.createTab({ app }))).toBe("b1");
    expect(
      browserOf(await relay.backend.createTab({ app, browser: "b2" })),
    ).toBe("b2");
    second.focus();
    await waitUntil(
      () =>
        relay.backend.browsers()[1]!.lastFocusedAt! >
        relay.backend.browsers()[0]!.lastFocusedAt!,
    );
    expect(browserOf(await relay.backend.createTab({ app }))).toBe("b2");
  });

  it("releases only the disconnecting browser's tabs, and waits for a browser expected back", async () => {
    await relay.close();
    relay = await startTestBackend({ reconnectGraceMs: 3000 });
    const { second, firstId, secondId } = await connectTwo();
    await relay.backend.page(firstId);
    await relay.backend.page(secondId);
    const released: BackendEvents["released"][] = [];
    relay.backend.on("released", (event) => released.push(event));
    await second.disconnect();
    await waitUntil(() => released.length > 0);
    expect(released).toEqual([{ tabId: secondId, reason: "disconnected" }]);
    expect(relay.backend.isClaimed(firstId)).toBe(true);

    // A call on the first browser's tab doesn't wait for the second
    let start = Date.now();
    await relay.backend.whenReady(firstId);
    expect(Date.now() - start).toBeLessThan(500);
    // One on the second's waits until it's back
    setTimeout(() => void connect({ chromium: chromium2, windowId: 2 }), 300);
    start = Date.now();
    await relay.backend.whenReady(secondId);
    expect(Date.now() - start).toBeGreaterThan(250);
    expect(Date.now() - start).toBeLessThan(2500);
    expect(relay.backend.browsers()[1]!.connected).toBe(true);
  });

  it("sends activity to the browser named, else the default one", async () => {
    const { first, second } = await connectTwo();
    const activity = (extension: FakeExtension) =>
      extension.requests.filter((r) => r.method === "activity").length;
    relay.backend.noteActivity("claude-code", "b1");
    await waitUntil(() => activity(first) === 1);
    relay.backend.noteActivity("claude-code");
    await waitUntil(() => activity(second) === 1);
    expect(activity(first)).toBe(1);
  });

  it("retires tab IDs that name other tabs when a browser comes back (Chrome restarted)", async () => {
    const browserId = createBrowserId();
    const { second, secondTab, secondId } = await connectTwo({
      second: { browserId },
    });
    await second.disconnect();
    // While it's away, its tab with that Chrome ID shows another page, as a tab of a restarted Chrome would
    const { sessionId } = await chromium2.send<{ sessionId: string }>(
      "Target.attachToTarget",
      { targetId: second.tabs.get(secondTab)!.targetId, flatten: true },
    );
    const other = "data:text/html,%3Ctitle%3EOther%3C%2Ftitle%3E";
    await chromium2.send("Page.navigate", { url: other }, sessionId);
    await chromium2.send("Target.detachFromTarget", { sessionId });
    await connect({ chromium: chromium2, windowId: 2, browserId });
    await waitUntil(() =>
      relay.backend.tabs().some((tab) => tab.url === other),
    );
    // The old ID is a closed tab's; the tab gets a new one
    expect(relay.backend.tabClosed(secondId)).toBe(true);
    await expect(relay.backend.page(secondId)).rejects.toThrow(
      noSuchTabMessage(secondId, "Chrome 2"),
    );
    expect(
      relay.backend.tabs().find((tab) => tab.url === other)?.tabId,
    ).not.toBe(secondId);
  });

  it("puts a browser whose old connection stopped answering back in its slot, without a browserId", async () => {
    await relay.close();
    relay = await startTestBackend({ pingTimeoutMs: 300 });
    const first = await connect({ windowId: 1 });
    const tabId = [...first.tabs.keys()][0]!;
    // Its service worker stopped without closing the connection
    first.answering = false;
    await connect({ windowId: 1 });
    expect(await first.closed).toMatchObject({
      code: RelayCloseCode.anotherBrowser,
    });
    expect(relay.backend.browsers()).toHaveLength(1);
    await expect(relay.backend.activateTab(tabId)).resolves.toBeUndefined();
  });

  it("refuses another live connection with a connected browser's browserId", async () => {
    await relay.close();
    relay = await startTestBackend({ pingTimeoutMs: 300 });
    const browserId = createBrowserId();
    const first = await connect({ browserId });
    const copy = await connect({ chromium: chromium2, windowId: 2, browserId });
    expect(await copy.closed).toMatchObject({
      code: RelayCloseCode.anotherBrowser,
    });
    expect(relay.backend.browsers()).toHaveLength(1);
    await expect(
      relay.backend.activateTab([...first.tabs.keys()][0]!),
    ).resolves.toBeUndefined();
  });
});
