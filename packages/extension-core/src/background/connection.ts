import {
  type DaemonMessage,
  type ExtensionEvent,
  type ExtensionMessage,
  type ExtensionRequest,
  LEGACY_PORT,
  LEGACY_SERVER_MESSAGE,
  RELAY_PRODUCT,
  RELAY_PROTOCOL_VERSION,
  RELAY_RECONNECT_DELAYS_MS,
  RelayCloseCode,
  RelayPaths,
  type RelayStatus,
  RelayUpdateReason,
  createPairingNonce,
} from "@browsermcp/protocol";

import type { ConnectionStatus } from "../types";
import { createChallenge, getPairingCode } from "./pairing";

export type Hello = Extract<ExtensionMessage, { type: "hello" }>;
export type Welcome = Extract<DaemonMessage, { type: "welcome" }>;

/** How long a probe waits for an answer */
const PROBE_TIMEOUT_MS = 2000;
/** How long the daemon has to answer `hello` */
const WELCOME_TIMEOUT_MS = 10_000;
/** The daemon pings every 20 s; with nothing for this long, the connection is dead (the watchdog closes it) */
const SILENCE_TIMEOUT_MS = 60_000;
/** After something on the legacy port answered HTTP but not WebSockets, how long until trying a WebSocket there again */
const LEGACY_WEBSOCKET_RETRY_MS = 60_000;

/** The close code the extension uses for a daemon whose signature didn't verify */
const UNTRUSTED_CLOSE_CODE = 4900;

export type RelayConnectionOptions = {
  /** The ports to probe, in order (`RELAY_PORTS`, or the one set in storage) */
  getPorts: () => Promise<readonly number[]>;
  /** Where to look for a 0.1.x server: `LEGACY_PORT`, or in development and test builds the one set in storage (the smoke test's fake 0.1.x server) */
  getLegacyPort?: () => Promise<number>;
  createHello: (challenge: string) => Promise<Hello>;
  /** Whether `welcome` signs `challenge`, the port the extension dialed and its `pairingCommitment` with the key it names */
  verifyWelcome: (
    welcome: Welcome,
    challenge: string,
    port: number,
  ) => Promise<boolean>;
  /** Whether the user allowed this daemon key (base64 SPKI). For a key they didn't, the extension exchanges nonces with the daemon for the pairing code */
  isPaired: (publicKey: string) => Promise<boolean>;
  /** The daemon proved its key. Sets the status (`connected`, paired or not). `code`: the six-digit pairing code for a key the user didn't allow yet, else null */
  onWelcome: (
    welcome: Welcome,
    port: number,
    code: string | null,
  ) => Promise<void>;
  onRequest: (request: ExtensionRequest) => Promise<unknown>;
  setStatus: (status: ConnectionStatus) => Promise<void>;
  /** A 0.1.x server answers on the legacy port, or stopped answering */
  setLegacyServer: (present: boolean) => Promise<void>;
  /** The connection closed, so the daemon's attachments are void */
  onDisconnect: () => void;
  fetch?: typeof fetch;
  WebSocket?: typeof WebSocket;
};

/**
 * The connection to the daemon: probes `/browsermcp/status` on each port in turn (CORS, so a missing daemon doesn't fill the extension's error log), opens `/extension`, exchanges `hello` and `welcome` and answers the daemon's requests and pings. Reconnects with backoff (`RELAY_RECONNECT_DELAYS_MS`); the background's alarm calls `watchdog()` every 30 s and `runtime.onStartup` calls `ensureRunning()`, since timers stop with the service worker.
 *
 * It also answers a 0.1.x server on `LEGACY_PORT`, found with a `no-cors` probe, with `LEGACY_SERVER_MESSAGE` to every command, alongside a 2.0 daemon
 */
export class RelayConnection {
  readonly #options: RelayConnectionOptions;
  readonly #fetch: typeof fetch;
  readonly #WebSocket: typeof WebSocket;

  #socket: WebSocket | null = null;
  #welcomed = false;
  /** Resolves once `welcome` was handled, so requests wait for pairing */
  #ready: Promise<void> = Promise.resolve();
  #untrusted = false;
  /** Resolves the pending pairing exchange with the daemon's revealed nonce, or null when the connection closed or the daemon took too long */
  #revealWaiter: ((nonce: unknown) => void) | null = null;
  #cycling = false;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #attempt = 0;
  #lastMessageAt = 0;
  #stopped = false;

  #legacySocket: WebSocket | null = null;
  #legacyProbing = false;
  #legacyWebSocketRetryAt = 0;

  constructor(options: RelayConnectionOptions) {
    this.#options = options;
    this.#fetch = options.fetch ?? ((...args) => fetch(...args));
    this.#WebSocket = options.WebSocket ?? WebSocket;
  }

  /** Connected, and the daemon proved its key */
  get isWelcomed(): boolean {
    return this.#welcomed;
  }

  /** Starts looking for the daemon unless connected, connecting or waiting to retry */
  ensureRunning(): void {
    if (!this.#socket && !this.#cycling && this.#timer === undefined) {
      void this.#cycle();
    }
  }

  /** Looks for the daemon now instead of waiting for the next retry (e.g. when the popup opens) */
  connectNow(): void {
    if (this.#socket || this.#cycling) {
      return;
    }
    clearTimeout(this.#timer);
    this.#timer = undefined;
    void this.#cycle();
  }

  /** Drops the connection and looks for the daemon again now (the ports to try changed) */
  reconnect(): void {
    this.#attempt = 0;
    if (this.#socket) {
      // `#handleClose()` schedules the next look
      this.#socket.close();
      return;
    }
    this.connectNow();
  }

  /** Every 30 s: restarts the loop if it stopped, closes a connection that went silent, and looks for a 0.1.x server */
  watchdog(): void {
    if (
      this.#socket &&
      this.#welcomed &&
      Date.now() - this.#lastMessageAt > SILENCE_TIMEOUT_MS
    ) {
      this.#socket.close();
    }
    if (this.#socket) {
      void this.#probeLegacy();
    }
    this.ensureRunning();
  }

  /** Stops looking and closes the connections (when the listeners are removed, e.g. in tests) */
  stop(): void {
    this.#stopped = true;
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#socket?.close();
    this.#legacySocket?.close();
  }

  /** Sends an event, if connected */
  sendEvent(event: ExtensionEvent): void {
    if (this.#welcomed) {
      this.#send(this.#socket, { type: "event", event });
    }
  }

  async #cycle(): Promise<void> {
    if (this.#socket || this.#cycling || this.#stopped) {
      return;
    }
    this.#cycling = true;
    clearTimeout(this.#timer);
    this.#timer = undefined;
    try {
      void this.#probeLegacy();
      let outcome: ConnectionStatus = { state: "searching" };
      for (const port of await this.#options.getPorts()) {
        const status = await this.#probe(port);
        if (!status) {
          continue;
        }
        if (RELAY_PROTOCOL_VERSION > status.protocol) {
          outcome = { state: "updateServer", daemonVersion: status.version };
        } else if (RELAY_PROTOCOL_VERSION < status.minProtocol) {
          outcome = { state: "updateExtension", daemonVersion: status.version };
        } else {
          this.#open(port);
          return;
        }
        break;
      }
      await this.#options.setStatus(outcome);
      this.#scheduleRetry();
    } catch (error) {
      console.error("Couldn't look for the Browser MCP server", error);
      this.#scheduleRetry();
    } finally {
      this.#cycling = false;
    }
  }

  #scheduleRetry(): void {
    if (this.#timer !== undefined || this.#stopped) {
      return;
    }
    const delays = RELAY_RECONNECT_DELAYS_MS;
    const delay = delays[Math.min(this.#attempt, delays.length - 1)];
    this.#attempt++;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.#cycle();
    }, delay);
  }

  async #probe(port: number): Promise<RelayStatus | null> {
    try {
      const response = await this.#fetchWithTimeout(
        `http://127.0.0.1:${port}${RelayPaths.status}`,
      );
      if (!response.ok) {
        return null;
      }
      const status = (await response.json()) as Partial<RelayStatus>;
      return status.product === RELAY_PRODUCT &&
        typeof status.protocol === "number" &&
        typeof status.minProtocol === "number"
        ? (status as RelayStatus)
        : null;
    } catch {
      return null;
    }
  }

  #open(port: number): void {
    const challenge = createChallenge();
    const ws = new this.#WebSocket(
      `ws://127.0.0.1:${port}${RelayPaths.extension}`,
    );
    this.#socket = ws;
    this.#welcomed = false;
    this.#untrusted = false;
    this.#ready = Promise.resolve();
    this.#lastMessageAt = Date.now();
    let welcomeTimer: ReturnType<typeof setTimeout> | undefined;

    ws.addEventListener("open", () => {
      welcomeTimer = setTimeout(() => ws.close(), WELCOME_TIMEOUT_MS);
      void this.#options
        .createHello(challenge)
        .then((hello) => this.#send(ws, hello));
    });
    ws.addEventListener("message", (event: MessageEvent) => {
      if (this.#socket !== ws) {
        return;
      }
      const message = parse<DaemonMessage>(event.data);
      if (!message) {
        return;
      }
      this.#lastMessageAt = Date.now();
      if (message.type === "ping") {
        this.#send(ws, { type: "pong", id: message.id });
      } else if (message.type === "welcome") {
        clearTimeout(welcomeTimer);
        // Never rejects, so requests still get answers (errors) when handling `welcome` failed
        this.#ready = this.#handleWelcome(ws, port, message, challenge).catch(
          (error: unknown) => {
            console.error(
              "Couldn't handle the Browser MCP server's welcome",
              error,
            );
          },
        );
      } else if (message.type === "pairingReveal") {
        this.#revealWaiter?.(message.nonce);
      } else if (message.type === "request") {
        void this.#ready.then(() => this.#handleRequest(ws, message));
      }
    });
    ws.addEventListener("close", (event: CloseEvent) => {
      clearTimeout(welcomeTimer);
      void this.#handleClose(ws, event.code, event.reason);
    });
  }

  async #handleWelcome(
    ws: WebSocket,
    port: number,
    welcome: Welcome,
    challenge: string,
  ): Promise<void> {
    if (!(await this.#options.verifyWelcome(welcome, challenge, port))) {
      await this.#distrust(ws, "The signature didn't verify");
      return;
    }
    if (this.#socket !== ws) {
      return;
    }
    let code: string | null = null;
    if (!(await this.#options.isPaired(welcome.publicKey))) {
      const outcome = await this.#exchangePairingNonces(ws, welcome);
      if (outcome === "mismatch") {
        await this.#distrust(ws, "The reveal didn't match the commitment");
        return;
      }
      if (outcome === null) {
        return;
      }
      code = outcome;
    }
    if (this.#socket !== ws) {
      return;
    }
    this.#welcomed = true;
    this.#attempt = 0;
    await this.#options.onWelcome(welcome, port, code);
  }

  /**
   * For a key the user didn't allow yet: sends `pairingNonce` and waits for the daemon's `pairingReveal`, then checks it against `welcome`'s `pairingCommitment` and computes the six-digit code (see "Pairing" in `@browsermcp/protocol`). The extension's nonce is fresh for each connection and sent only after the daemon committed to its own. `mismatch`: the reveal doesn't match; null: the connection closed, or the daemon didn't answer in time (the connection is closed and retried)
   */
  async #exchangePairingNonces(
    ws: WebSocket,
    welcome: Welcome,
  ): Promise<string | "mismatch" | null> {
    const extensionNonce = createPairingNonce();
    const daemonNonce = await new Promise<unknown>((resolve) => {
      const timer = setTimeout(() => {
        this.#revealWaiter = null;
        resolve(null);
        ws.close();
      }, WELCOME_TIMEOUT_MS);
      this.#revealWaiter = (nonce) => {
        clearTimeout(timer);
        this.#revealWaiter = null;
        resolve(nonce);
      };
      this.#send(ws, { type: "pairingNonce", nonce: extensionNonce });
    });
    if (daemonNonce === null || this.#socket !== ws) {
      return null;
    }
    return (
      (await getPairingCode({
        publicKey: welcome.publicKey,
        pairingCommitment: welcome.pairingCommitment,
        extensionNonce,
        daemonNonce,
      })) ?? "mismatch"
    );
  }

  /** The daemon couldn't prove its key, or its pairing code: it isn't offered **Allow** */
  async #distrust(ws: WebSocket, reason: string): Promise<void> {
    this.#untrusted = true;
    await this.#options.setStatus({ state: "untrusted" });
    ws.close(UNTRUSTED_CLOSE_CODE, reason);
  }

  async #handleRequest(
    ws: WebSocket,
    message: Extract<DaemonMessage, { type: "request" }>,
  ): Promise<void> {
    const { id, type: _type, ...request } = message;
    try {
      if (!this.#welcomed) {
        throw new Error("The extension hasn't accepted this connection");
      }
      const result = await this.#options.onRequest(request as ExtensionRequest);
      this.#send(ws, { type: "response", id, result });
    } catch (error) {
      this.#send(ws, {
        type: "response",
        id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async #handleClose(ws: WebSocket, code: number, reason: string) {
    if (this.#socket !== ws) {
      return;
    }
    const wasWelcomed = this.#welcomed;
    this.#socket = null;
    this.#revealWaiter?.(null);
    this.#welcomed = false;
    this.#options.onDisconnect();

    let status: ConnectionStatus | null = { state: "searching" };
    if (code === RelayCloseCode.unsupportedProtocol) {
      status =
        reason === RelayUpdateReason.updateExtension
          ? { state: "updateExtension" }
          : { state: "updateServer" };
    } else if (code === RelayCloseCode.anotherBrowser) {
      status = { state: "anotherBrowser" };
    } else if (this.#untrusted) {
      status = null;
    } else if (code === RelayCloseCode.shuttingDown || wasWelcomed) {
      this.#attempt = 0;
    }
    if (status) {
      await this.#options.setStatus(status);
    }
    // The daemon chose another browser: retrying at once would take it back, and two idle browsers would flip-flop. The watchdog (30 s) or the popup opening (`connectNow()`) tries again
    if (code !== RelayCloseCode.anotherBrowser) {
      this.#scheduleRetry();
    }
  }

  #send(ws: WebSocket | null, message: ExtensionMessage): void {
    if (ws?.readyState === this.#WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  /**
   * Looks for a 0.1.x server on `LEGACY_PORT` with a `no-cors` request, which resolves whenever anything answers HTTP there (0.1.x has no CORS), and connects to it with its WebSocket protocol, answering every command with `LEGACY_SERVER_MESSAGE`. 0.1.x passes the error on to the model as the tool's result
   */
  async #probeLegacy(): Promise<void> {
    if (this.#legacySocket || this.#legacyProbing || this.#stopped) {
      return;
    }
    this.#legacyProbing = true;
    try {
      const port = (await this.#options.getLegacyPort?.()) ?? LEGACY_PORT;
      const answers = await this.#fetchWithTimeout(
        `http://localhost:${port}/`,
        { mode: "no-cors" },
      ).then(
        () => true,
        () => false,
      );
      if (!answers) {
        await this.#options.setLegacyServer(false);
        return;
      }
      if (Date.now() < this.#legacyWebSocketRetryAt) {
        return;
      }
      this.#openLegacy(port);
    } finally {
      this.#legacyProbing = false;
    }
  }

  #openLegacy(port: number): void {
    const ws = new this.#WebSocket(`ws://localhost:${port}`);
    this.#legacySocket = ws;
    let opened = false;
    ws.addEventListener("open", () => {
      opened = true;
      void this.#options.setLegacyServer(true);
    });
    ws.addEventListener("message", (event: MessageEvent) => {
      // 0.1.x's messages: `{ id, type, payload }`, answered with `{ id, type: "messageResponse", payload: { requestId, result?, error? } }`
      const message = parse<{ id?: string; type?: string }>(event.data);
      if (!message?.id || message.type === "messageResponse") {
        return;
      }
      if (ws.readyState === this.#WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            id: crypto.randomUUID(),
            type: "messageResponse",
            payload: { requestId: message.id, error: LEGACY_SERVER_MESSAGE },
          }),
        );
      }
    });
    ws.addEventListener("close", () => {
      if (this.#legacySocket === ws) {
        this.#legacySocket = null;
      }
      if (!opened) {
        // Something else answers HTTP on the port
        this.#legacyWebSocketRetryAt = Date.now() + LEGACY_WEBSOCKET_RETRY_MS;
      }
      // Otherwise the flag stays until a probe finds the port free: a 0.1.x server that closed the connection for another browser's is still there
    });
  }

  #fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    return this.#fetch(url, { ...init, signal: controller.signal }).finally(
      () => clearTimeout(timer),
    );
  }
}

function parse<T>(data: unknown): T | null {
  if (typeof data !== "string") {
    return null;
  }
  try {
    const value: unknown = JSON.parse(data);
    return typeof value === "object" && value !== null ? (value as T) : null;
  } catch {
    return null;
  }
}
