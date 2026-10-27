import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  LEGACY_SERVER_MESSAGE,
  RELAY_PORTS,
  RELAY_PROTOCOL_VERSION,
  RelayCloseCode,
  RelayUpdateReason,
} from "@browsermcp/protocol";

import type { ConnectionStatus } from "../types";
import { RelayConnection, type RelayConnectionOptions } from "./connection";
import {
  FakeWebSocket,
  type FakePort,
  createDaemonKey,
  createFakeFetch,
  welcome,
} from "./fake-daemon.test-helper";
import { verifyDaemonSignature } from "./pairing";

function setup(
  ports: Record<number, FakePort>,
  overrides: Partial<RelayConnectionOptions> = {},
) {
  const fetch = createFakeFetch(ports);
  const statuses: ConnectionStatus[] = [];
  const legacy: boolean[] = [];
  const options: RelayConnectionOptions = {
    getPorts: async () => RELAY_PORTS,
    createHello: async (challenge) => ({
      type: "hello",
      protocol: RELAY_PROTOCOL_VERSION,
      extensionVersion: "2.0.0",
      browser: { name: "Chrome", version: "142", userAgent: "test" },
      capabilities: [],
      challenge,
      state: { tabs: [], paused: false, pairing: "pending" },
    }),
    verifyWelcome: (message, challenge, port) =>
      verifyDaemonSignature({
        challenge,
        port,
        publicKey: message.publicKey,
        pairingCommitment: message.pairingCommitment,
        signature: message.signature,
      }),
    isPaired: vi.fn(async () => false),
    onWelcome: vi.fn(async () => {}),
    onRequest: vi.fn(async () => "result"),
    setStatus: async (status) => void statuses.push(status),
    setLegacyServer: async (present) => void legacy.push(present),
    onDisconnect: vi.fn(),
    fetch,
    WebSocket: FakeWebSocket as unknown as typeof WebSocket,
    ...overrides,
  };
  const connection = new RelayConnection(options);
  return { connection, fetch, statuses, legacy, options };
}

/** The ports probed with CORS, in order */
function probedPorts(fetch: ReturnType<typeof createFakeFetch>) {
  return fetch.calls
    .filter((call) => call.mode !== "no-cors")
    .map((call) => Number(new URL(call.url).port));
}

describe("the connection to the daemon", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWebSocket.reset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("probes 9010, 9011 and 9012 in turn with CORS, and only probes 9009 without it", async () => {
    const { connection, fetch, statuses } = setup({});
    connection.ensureRunning();
    await vi.advanceTimersByTimeAsync(0);

    expect(probedPorts(fetch)).toEqual([9010, 9011, 9012]);
    expect(fetch.calls.filter((call) => call.mode === "no-cors")).toEqual([
      { url: "http://localhost:9009/", mode: "no-cors" },
    ]);
    expect(statuses.at(-1)).toEqual({ state: "searching" });
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it("retries after 1, 2, 3, then every 5 seconds", async () => {
    const { connection, fetch } = setup({});
    connection.ensureRunning();
    await vi.advanceTimersByTimeAsync(0);
    const rounds = () => probedPorts(fetch).length / 3;

    expect(rounds()).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(rounds()).toBe(2);
    await vi.advanceTimersByTimeAsync(2000);
    expect(rounds()).toBe(3);
    await vi.advanceTimersByTimeAsync(3000);
    expect(rounds()).toBe(4);
    await vi.advanceTimersByTimeAsync(4999);
    expect(rounds()).toBe(4);
    await vi.advanceTimersByTimeAsync(1);
    expect(rounds()).toBe(5);
    await vi.advanceTimersByTimeAsync(5000);
    expect(rounds()).toBe(6);
  });

  it("connects to the first port with a daemon, and a port set in storage replaces the list", async () => {
    const { connection, fetch } = setup({ 9011: "daemon", 9012: "daemon" });
    connection.ensureRunning();
    await vi.advanceTimersByTimeAsync(0);
    expect(probedPorts(fetch)).toEqual([9010, 9011]);
    expect(FakeWebSocket.latest("ws://127.0.0.1")?.url).toBe(
      "ws://127.0.0.1:9011/extension",
    );

    FakeWebSocket.reset();
    const custom = setup({ 9123: "daemon" }, { getPorts: async () => [9123] });
    custom.connection.ensureRunning();
    await vi.advanceTimersByTimeAsync(0);
    expect(probedPorts(custom.fetch)).toEqual([9123]);
    expect(FakeWebSocket.latest("ws://127.0.0.1")?.url).toBe(
      "ws://127.0.0.1:9123/extension",
    );
  });

  it("says hello with a challenge, checks the welcome's signature, and answers pings and requests", async () => {
    const { connection, options } = setup({ 9010: "daemon" });
    connection.ensureRunning();
    await vi.advanceTimersByTimeAsync(0);
    const ws = FakeWebSocket.latest("9010")!;
    ws.open();
    await vi.advanceTimersByTimeAsync(0);

    const [hello] = ws.messages("hello");
    expect(atob(hello.challenge)).toHaveLength(32);

    await welcome(ws, await createDaemonKey());
    await vi.waitFor(() => expect(options.onWelcome).toHaveBeenCalled());
    expect(connection.isWelcomed).toBe(true);

    ws.receive({ type: "ping", id: 7 });
    ws.receive({
      type: "request",
      id: 1,
      method: "closeTab",
      params: { tabId: 3 },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(ws.messages("pong")).toEqual([{ type: "pong", id: 7 }]);
    expect(options.onRequest).toHaveBeenCalledWith({
      method: "closeTab",
      params: { tabId: 3 },
    });
    expect(ws.messages("response")).toEqual([
      { type: "response", id: 1, result: "result" },
    ]);
  });

  it("closes the connection when the signature doesn't verify, and says so", async () => {
    const { connection, options, statuses } = setup({ 9010: "daemon" });
    connection.ensureRunning();
    await vi.advanceTimersByTimeAsync(0);
    const ws = FakeWebSocket.latest("9010")!;
    ws.open();
    await vi.advanceTimersByTimeAsync(0);
    await welcome(ws, await createDaemonKey(), { badSignature: true });
    await vi.waitFor(() => expect(ws.readyState).toBe(FakeWebSocket.CLOSED));

    expect(options.onWelcome).not.toHaveBeenCalled();
    expect(statuses.at(-1)).toEqual({ state: "untrusted" });
    expect(connection.isWelcomed).toBe(false);
  });

  it("rejects a signature made for another port, as when a program on one port relays the challenge to the daemon on another", async () => {
    const { connection, options, statuses } = setup({ 9010: "daemon" });
    connection.ensureRunning();
    await vi.advanceTimersByTimeAsync(0);
    const ws = FakeWebSocket.latest("9010")!;
    ws.open();
    await vi.advanceTimersByTimeAsync(0);
    await welcome(ws, await createDaemonKey(), { port: 9011 });
    await vi.waitFor(() => expect(ws.readyState).toBe(FakeWebSocket.CLOSED));

    expect(options.onWelcome).not.toHaveBeenCalled();
    expect(statuses.at(-1)).toEqual({ state: "untrusted" });
    // Its nonce never reaches a daemon that didn't prove its key
    expect(ws.messages("pairingNonce")).toEqual([]);
  });

  /** Connects to a daemon on 9010 and answers `hello` with `welcome` */
  async function connectAndWelcome(
    ...args: [Parameters<typeof setup>[1]?, Parameters<typeof welcome>[2]?]
  ) {
    const [overrides, welcomeOptions] = args;
    const started = setup({ 9010: "daemon" }, overrides);
    started.connection.ensureRunning();
    await vi.advanceTimersByTimeAsync(0);
    const ws = FakeWebSocket.latest("9010")!;
    ws.open();
    await vi.advanceTimersByTimeAsync(0);
    const key = await createDaemonKey();
    const daemon = await welcome(ws, key, welcomeOptions);
    return { ...started, ws, key, daemon };
  }

  it("for a key the user didn't allow, sends its nonce after the signed commitment, and computes the code the daemon does", async () => {
    const { ws, key, daemon, options } = await connectAndWelcome();
    await vi.waitFor(() => expect(options.onWelcome).toHaveBeenCalled());

    expect(options.isPaired).toHaveBeenCalledWith(key.publicKey);
    const [sent] = ws.messages("pairingNonce");
    expect(atob(sent!.nonce)).toHaveLength(32);
    const code = await daemon.code();
    expect(code).toMatch(/^\d{3} \d{3}$/);
    expect(options.onWelcome).toHaveBeenCalledWith(daemon.message, 9010, code);
    // The extension's nonce follows `hello` and comes before anything else
    expect(
      ws.sent.map((message) => (message as { type: string }).type),
    ).toEqual(["hello", "pairingNonce"]);
  });

  it("skips the exchange for a key the user allowed", async () => {
    const { ws, daemon, options } = await connectAndWelcome({
      isPaired: vi.fn(async () => true),
    });
    await vi.waitFor(() => expect(options.onWelcome).toHaveBeenCalled());
    expect(options.onWelcome).toHaveBeenCalledWith(daemon.message, 9010, null);
    expect(ws.messages("pairingNonce")).toEqual([]);
  });

  it("treats a daemon whose reveal doesn't match its commitment as untrusted", async () => {
    const { ws, options, statuses, connection } = await connectAndWelcome(
      {},
      { badReveal: true },
    );
    await vi.waitFor(() => expect(ws.readyState).toBe(FakeWebSocket.CLOSED));

    expect(ws.messages("pairingNonce")).toHaveLength(1);
    expect(options.onWelcome).not.toHaveBeenCalled();
    expect(statuses.at(-1)).toEqual({ state: "untrusted" });
    expect(ws.closedWith?.code).toBe(4900);
    expect(connection.isWelcomed).toBe(false);
  });

  it("closes and retries when the daemon doesn't reveal its nonce in time", async () => {
    const { ws, options, statuses } = await connectAndWelcome(
      {},
      { reveal: false },
    );
    await vi.waitFor(() => expect(ws.messages("pairingNonce")).toHaveLength(1));
    expect(ws.readyState).toBe(FakeWebSocket.OPEN);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(ws.readyState).toBe(FakeWebSocket.CLOSED);
    expect(ws.closedWith?.code).toBeUndefined();
    expect(options.onWelcome).not.toHaveBeenCalled();
    expect(statuses.at(-1)).toEqual({ state: "searching" });
  });

  it("sends a fresh nonce on each connection, so each gets a fresh code", async () => {
    const { ws, daemon, options, connection } = await connectAndWelcome();
    await vi.waitFor(() => expect(options.onWelcome).toHaveBeenCalledTimes(1));
    ws.serverClose(1006);
    await vi.advanceTimersByTimeAsync(1000);
    const again = FakeWebSocket.latest("9010")!;
    expect(again).not.toBe(ws);
    again.open();
    await vi.advanceTimersByTimeAsync(0);
    const secondDaemon = await welcome(again, await createDaemonKey());
    await vi.waitFor(() => expect(options.onWelcome).toHaveBeenCalledTimes(2));

    expect(again.messages("pairingNonce")[0]!.nonce).not.toBe(
      ws.messages("pairingNonce")[0]!.nonce,
    );
    const [first, second] = vi
      .mocked(options.onWelcome)
      .mock.calls.map((call) => call[2]);
    expect(first).toBe(await daemon.code());
    expect(second).toBe(await secondDaemon.code());
    connection.stop();
  });

  it("still answers requests, with an error, when handling the welcome failed", async () => {
    const onRequest = vi.fn(async () => {
      throw new Error("Not paired");
    });
    const { connection } = setup(
      { 9010: "daemon" },
      {
        onWelcome: vi.fn(async () => {
          throw new Error("Storage failed");
        }),
        onRequest,
      },
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    connection.ensureRunning();
    await vi.advanceTimersByTimeAsync(0);
    const ws = FakeWebSocket.latest("9010")!;
    ws.open();
    await vi.advanceTimersByTimeAsync(0);
    await welcome(ws, await createDaemonKey());
    ws.receive({
      type: "request",
      id: 1,
      method: "closeTab",
      params: { tabId: 3 },
    });
    await vi.waitFor(() =>
      expect(ws.messages("response")).toEqual([
        { type: "response", id: 1, error: "Not paired" },
      ]),
    );
  });

  it.each([
    [
      RelayCloseCode.unsupportedProtocol,
      RelayUpdateReason.updateExtension,
      { state: "updateExtension" },
    ],
    [
      RelayCloseCode.unsupportedProtocol,
      RelayUpdateReason.updateServer,
      { state: "updateServer" },
    ],
    [RelayCloseCode.shuttingDown, "", { state: "searching" }],
  ])(
    "on close code %i (%s) shows %o and keeps retrying",
    async (code, reason, status) => {
      const { connection, statuses, options } = setup({ 9010: "daemon" });
      connection.ensureRunning();
      await vi.advanceTimersByTimeAsync(0);
      const ws = FakeWebSocket.latest("9010")!;
      ws.open();
      await vi.advanceTimersByTimeAsync(0);
      ws.serverClose(code, reason);
      await vi.advanceTimersByTimeAsync(0);

      expect(statuses.at(-1)).toEqual(status);
      expect(options.onDisconnect).toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(5000);
      expect(FakeWebSocket.instances.length).toBeGreaterThan(1);
    },
  );

  it("after the daemon chose another browser (4002), tries again only from the watchdog or the popup, so two browsers don't take turns", async () => {
    const { connection, statuses } = setup({ 9010: "daemon" });
    connection.ensureRunning();
    await vi.advanceTimersByTimeAsync(0);
    const ws = FakeWebSocket.latest("9010")!;
    ws.open();
    await vi.advanceTimersByTimeAsync(0);
    ws.serverClose(RelayCloseCode.anotherBrowser);
    await vi.advanceTimersByTimeAsync(0);
    expect(statuses.at(-1)).toEqual({ state: "anotherBrowser" });

    await vi.advanceTimersByTimeAsync(20_000);
    expect(FakeWebSocket.instances).toHaveLength(1);

    connection.watchdog();
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeWebSocket.instances).toHaveLength(2);

    FakeWebSocket.latest("9010")!.serverClose(RelayCloseCode.anotherBrowser);
    await vi.advanceTimersByTimeAsync(0);
    connection.connectNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeWebSocket.instances).toHaveLength(3);
  });

  it("asks to update the server or the extension when the status's protocol doesn't match, without connecting", async () => {
    const { connection, statuses } = setup(
      {},
      {
        fetch: createFakeFetch(
          { 9010: "daemon" },
          { protocol: 0, minProtocol: 0, version: "1.9.0" },
        ),
      },
    );
    connection.ensureRunning();
    await vi.advanceTimersByTimeAsync(0);
    expect(statuses.at(-1)).toEqual({
      state: "updateServer",
      daemonVersion: "1.9.0",
    });

    const newer = setup(
      {},
      {
        fetch: createFakeFetch(
          { 9010: "daemon" },
          { protocol: 9, minProtocol: 9, version: "3.0.0" },
        ),
      },
    );
    newer.connection.ensureRunning();
    await vi.advanceTimersByTimeAsync(0);
    expect(newer.statuses.at(-1)).toEqual({
      state: "updateExtension",
      daemonVersion: "3.0.0",
    });
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it("restarts the loop from the watchdog, and closes a connection that went silent", async () => {
    const { connection, fetch, options } = setup({ 9010: "daemon" });
    connection.watchdog();
    await vi.advanceTimersByTimeAsync(0);
    expect(probedPorts(fetch)).toEqual([9010]);

    const ws = FakeWebSocket.latest("9010")!;
    ws.open();
    await vi.advanceTimersByTimeAsync(0);
    await welcome(ws, await createDaemonKey());
    await vi.waitFor(() => expect(options.onWelcome).toHaveBeenCalled());

    await vi.advanceTimersByTimeAsync(30_000);
    connection.watchdog();
    expect(ws.readyState).toBe(FakeWebSocket.OPEN);
    await vi.advanceTimersByTimeAsync(31_000);
    connection.watchdog();
    expect(ws.readyState).toBe(FakeWebSocket.CLOSED);
  });

  it("answers every command of a 0.1.x server on 9009 with the update message, alongside a 2.0 daemon", async () => {
    const { connection, legacy } = setup({ 9009: "legacy", 9010: "daemon" });
    connection.ensureRunning();
    await vi.advanceTimersByTimeAsync(0);

    const old = FakeWebSocket.latest("ws://localhost:9009")!;
    expect(old.url).toBe("ws://localhost:9009");
    old.open();
    expect(legacy).toEqual([true]);
    old.receive({ id: "abc", type: "browser_snapshot", payload: {} });
    old.receive({ id: "def", type: "getUrl", payload: undefined });

    expect(old.sent).toEqual([
      {
        id: expect.any(String),
        type: "messageResponse",
        payload: { requestId: "abc", error: LEGACY_SERVER_MESSAGE },
      },
      {
        id: expect.any(String),
        type: "messageResponse",
        payload: { requestId: "def", error: LEGACY_SERVER_MESSAGE },
      },
    ]);
    // The 2.0 daemon still gets its own connection
    expect(FakeWebSocket.latest("9010/extension")).toBeDefined();
  });

  it("doesn't flag the legacy port when nothing speaks WebSocket there, and clears the flag when it's free", async () => {
    const { connection, fetch, legacy } = setup({ 9009: "other" });
    connection.ensureRunning();
    await vi.advanceTimersByTimeAsync(0);
    FakeWebSocket.latest("9009")!.fail();
    expect(legacy).toEqual([]);

    // It doesn't open another WebSocket there on every retry
    await vi.advanceTimersByTimeAsync(3000);
    expect(
      FakeWebSocket.instances.filter((ws) => ws.url.includes("9009")),
    ).toHaveLength(1);

    fetch.ports[9009] = "none";
    await vi.advanceTimersByTimeAsync(5000);
    expect(legacy.at(-1)).toBe(false);
  });
});
