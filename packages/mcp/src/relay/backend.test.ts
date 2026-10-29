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
  RelayUpdateReason,
  pairingRequiredMessage,
} from "@browsermcp/protocol";

import type { BackendEvents } from "@/contracts";
import type { CdpBridge } from "@/relay/bridge";
import {
  ANOTHER_BROWSER_MESSAGE,
  noSuchTabMessage,
  rejectedExtensionMessage,
  UPDATE_EXTENSION_MESSAGE,
} from "@/relay/messages";
import { FakeChromium, FakeExtension } from "@/testing/fake-extension";
import { startTestBackend } from "@/testing/test-backend";

let chromium: FakeChromium;
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

beforeAll(async () => {
  chromium = await FakeChromium.launch();
}, 60_000);

afterAll(async () => {
  await chromium?.close();
});

beforeEach(async () => {
  relay = await startTestBackend({ replacePingTimeoutMs: 500 });
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

  it("lets a second browser replace an idle one", async () => {
    const first = await connect();
    const second = await connect();
    expect(await first.closed).toMatchObject({
      code: RelayCloseCode.anotherBrowser,
    });
    expect(relay.backend.connected).toBe(true);
    // The second one is the browser now
    const tabId = [...second.tabs.keys()][0]!;
    await (relay.backend as unknown as { bridge: CdpBridge }).bridge.claim(
      tabId,
    );
    expect(second.requests.some((request) => request.method === "attach")).toBe(
      true,
    );
  });

  it("refuses a second browser while an agent uses a tab in the first", async () => {
    const first = await connect();
    const tabId = [...first.tabs.keys()][0]!;
    await (relay.backend as unknown as { bridge: CdpBridge }).bridge.claim(
      tabId,
    );
    const second = await connect();
    expect(await second.closed).toMatchObject({
      code: RelayCloseCode.anotherBrowser,
    });
    expect(relay.backend.isClaimed(tabId)).toBe(true);
    expect(first.requests.at(-1)?.method).toBe("attach");
  });

  it("doesn't let a replaced browser take the connection back when it retries", async () => {
    const first = await connect();
    const second = await connect();
    expect(await first.closed).toMatchObject({
      code: RelayCloseCode.anotherBrowser,
    });
    // The first browser retries (same browser: same user agent and windows)
    const retry = await connect();
    expect(await retry.closed).toMatchObject({
      code: RelayCloseCode.anotherBrowser,
    });
    // A third browser still replaces an idle one
    await connect({ userAgent: "Another browser" });
    expect(await second.closed).toMatchObject({
      code: RelayCloseCode.anotherBrowser,
    });
  });

  it("lets a replaced browser back once the browser that replaced it goes away", async () => {
    await connect();
    const second = await connect();
    await second.disconnect();
    await vi.waitUntil(() => !relay.backend.connected);
    await connect();
    expect(relay.backend.connected).toBe(true);
  });

  it("counts a browser as in use while a tab an agent selected there is open, even unclaimed", async () => {
    const first = await connect();
    const tabId = [...first.tabs.keys()][0]!;
    await relay.backend.groupTab(tabId, {
      id: "claude-code",
      name: "Claude Code",
    });
    expect(relay.backend.isClaimed(tabId)).toBe(false);
    const second = await connect({ userAgent: "Another browser" });
    expect(await second.closed).toMatchObject({
      code: RelayCloseCode.anotherBrowser,
    });
  });

  it("doesn't count tabs agents used once no session is open", async () => {
    await relay.close();
    relay = await startTestBackend({
      replacePingTimeoutMs: 500,
      hasSessions: () => false,
    });
    const first = await connect();
    const tabId = [...first.tabs.keys()][0]!;
    await relay.backend.groupTab(tabId, {
      id: "claude-code",
      name: "Claude Code",
    });
    await connect({ userAgent: "Another browser" });
    expect(await first.closed).toMatchObject({
      code: RelayCloseCode.anotherBrowser,
    });
  });

  it("refuses tab IDs agents used in another browser until one is selected again", async () => {
    const app = { id: "claude-code", name: "Claude Code" };
    const first = await connect();
    const tabId = [...first.tabs.keys()][0]!;
    await relay.backend.groupTab(tabId, app);
    await first.disconnect();
    // The same browser back (its service worker restarted) keeps its tabs
    await connect();
    await expect(relay.backend.activateTab(tabId)).resolves.toBeUndefined();
    await extensions.pop()!.disconnect();

    // Another browser, whose tab with the same ID is another tab
    await connect({ userAgent: "Another browser" });
    await expect(relay.backend.activateTab(tabId)).rejects.toThrow(
      ANOTHER_BROWSER_MESSAGE,
    );
    await expect(relay.backend.page(tabId)).rejects.toThrow(
      ANOTHER_BROWSER_MESSAGE,
    );
    await expect(relay.backend.closeTab(tabId)).rejects.toThrow(
      ANOTHER_BROWSER_MESSAGE,
    );
    // `tab select` groups it in this browser
    await relay.backend.groupTab(tabId, app);
    await expect(relay.backend.activateTab(tabId)).resolves.toBeUndefined();
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
      replacePingTimeoutMs: 500,
      unknownTabWaitMs: 100,
    });
    await connect();
    await expect(relay.backend.findTab(987_654)).resolves.toBeUndefined();
  });

  it("doesn't adopt a contender that left while the current browser was pinged", async () => {
    const first = await connect();
    const tabId = [...first.tabs.keys()][0]!;
    await (relay.backend as unknown as { bridge: CdpBridge }).bridge.claim(
      tabId,
    );
    first.answering = false;
    const connections: boolean[] = [];
    relay.backend.on("connection", ({ connected }) =>
      connections.push(connected),
    );
    const second = await connect();
    await second.disconnect();
    // The ping times out after 500 ms; the contender is gone by then
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(connections).toEqual([]);
    expect(relay.backend.isClaimed(tabId)).toBe(true);
    first.answering = true;
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
    const connection = (
      relay.backend as unknown as { extension: { pendingCount: number } }
    ).extension;
    expect(connection.pendingCount).toBe(0);
    extension.answering = true;
  });

  it("forgets page waiters that timed out", async () => {
    await relay.close();
    relay = await startTestBackend({ pageTimeoutMs: 100 });
    const backend = relay.backend as unknown as {
      waitForPage(targetId: string): Promise<unknown>;
      pageWaiters: Map<string, unknown>;
    };
    await expect(backend.waitForPage("missing")).rejects.toThrow(
      "didn't become ready",
    );
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
