import { createHash } from "node:crypto";
import type { RawData, WebSocket } from "ws";

import {
  type DaemonMessage,
  type ExtensionEvent,
  type ExtensionMessage,
  type ExtensionRequestMap,
  type ExtensionRequestMethod,
  type ExtensionState,
  RELAY_PING_INTERVAL_MS,
  RELAY_PING_TIMEOUT_MS,
  RELAY_PROTOCOL_VERSION,
  type RelayCapability,
  RelayCloseCode,
  RelayUpdateReason,
  createPairingNonce,
  pairingCode,
  pairingPayload,
} from "@browsermcp/protocol";

import { RELAY_MIN_PROTOCOL_VERSION } from "@/relay/constants";
import type { Logger } from "@/utils/log";

export type ExtensionHello = Extract<ExtensionMessage, { type: "hello" }>;

/** What the daemon announces in `welcome` */
const DAEMON_CAPABILITIES: RelayCapability[] = [];

/** Rejected by `ExtensionConnection.accept()` when the extension's protocol is too old; the socket was closed with `RelayCloseCode.unsupportedProtocol` */
export class ExtensionProtocolError extends Error {
  constructor(readonly extensionProtocol: number) {
    super(`Extension protocol ${extensionProtocol} is no longer supported`);
  }
}

/** The daemon's pairing key (`~/.browsermcp/identity.json`) */
export type PairingKey = {
  /** Base64 SPKI */
  publicKey: string;
  /** Signs the UTF-8 bytes of `payload`, returning base64 IEEE P1363 */
  sign(payload: string): string;
};

export type ExtensionConnectionOptions = {
  daemonVersion: string;
  identity: PairingKey;
  /** The port the extension dialed, signed with its challenge (`pairingPayload()`) */
  port: number;
  log: Logger;
  helloTimeoutMs?: number;
  pingIntervalMs?: number;
  pingTimeoutMs?: number;
  /** How long a request waits for the extension's answer: `REQUEST_TIMEOUT_MS`, or `CDP_REQUEST_TIMEOUT_MS` for `cdp` */
  requestTimeoutMs?: number;
};

/** How long a request to the extension waits for its answer */
export const REQUEST_TIMEOUT_MS = 30_000;
/** For `cdp`, which Playwright sends with its own timeouts, e.g. a `Runtime.callFunctionOn` that awaits a promise until `waitForFunction` gives up */
export const CDP_REQUEST_TIMEOUT_MS = 5 * 60_000;

type Callback = (error: Error | null, result?: unknown) => void;

/**
 * One extension's WebSocket on `/extension`, after `hello` / `welcome`: requests to the extension, its events and state, and a ping every 20 s that closes a connection whose service worker stopped answering
 */
export class ExtensionConnection {
  state: ExtensionState;
  private nextId = 1;
  private pending = new Map<number, Callback>();
  private pongs = new Map<number, (alive: boolean) => void>();
  private eventListeners = new Set<(event: ExtensionEvent) => void>();
  private closeListeners = new Set<(code: number, reason: string) => void>();
  private pingTimer: NodeJS.Timeout | undefined;
  private closed = false;
  private pairingNonceReceived = false;
  /** The six-digit code the popup shows next to **Allow** (`pairingCode()`), once the extension sent its nonce (`pairingNonce`, only for a key it hasn't paired with) */
  pairingCode: string | null = null;

  private constructor(
    private readonly ws: WebSocket,
    readonly hello: ExtensionHello,
    private readonly options: ExtensionConnectionOptions,
    /** The nonce behind `welcome`'s `pairingCommitment`, revealed once the extension sent its own */
    private readonly daemonNonce: string,
  ) {
    this.state = hello.state;
    ws.on("message", (data) => this.onMessage(data));
    ws.on("close", (code, reason) => this.handleClose(code, reason.toString()));
    ws.on("error", (error) => options.log("Extension socket error:", error));
    this.pingTimer = setInterval(() => {
      void this.ping(options.pingTimeoutMs ?? RELAY_PING_TIMEOUT_MS).then(
        (alive) => {
          if (!alive && !this.closed) {
            options.log("The extension stopped answering pings; closing");
            this.ws.terminate();
          }
        },
      );
    }, options.pingIntervalMs ?? RELAY_PING_INTERVAL_MS);
  }

  /**
   * Waits for `hello`, checks the protocol and answers `welcome` with the daemon's key, its commitment to a fresh nonce for the pairing code and its signature of both with the challenge (see "Pairing" in `@browsermcp/protocol`). A too-old extension is closed with 4001 and `update-extension`
   */
  static accept(
    ws: WebSocket,
    options: ExtensionConnectionOptions,
  ): Promise<ExtensionConnection> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        ws.close(1008, "Expected hello");
        reject(new Error("The extension didn't send hello"));
      }, options.helloTimeoutMs ?? 10_000);
      ws.once("close", () => {
        clearTimeout(timeout);
        reject(new Error("The extension closed before hello"));
      });
      ws.once("message", (data) => {
        clearTimeout(timeout);
        let message: ExtensionMessage | undefined;
        try {
          message = JSON.parse(data.toString());
        } catch {
          message = undefined;
        }
        if (
          message?.type !== "hello" ||
          typeof message.challenge !== "string"
        ) {
          ws.close(1008, "Expected hello");
          reject(new Error("The extension didn't send hello"));
          return;
        }
        if (
          typeof message.protocol !== "number" ||
          message.protocol < RELAY_MIN_PROTOCOL_VERSION
        ) {
          ws.close(
            RelayCloseCode.unsupportedProtocol,
            RelayUpdateReason.updateExtension,
          );
          reject(new ExtensionProtocolError(message.protocol));
          return;
        }
        // Committed to before the extension sends its nonce, and revealed only after
        const daemonNonce = createPairingNonce();
        // `pairingCommitment()`, synchronously, so the connection listens before the extension's next frame
        const pairingCommitment = createHash("sha256")
          .update(Buffer.from(daemonNonce, "base64"))
          .digest("base64");
        const welcome: DaemonMessage = {
          type: "welcome",
          protocol: RELAY_PROTOCOL_VERSION,
          daemonVersion: options.daemonVersion,
          capabilities: DAEMON_CAPABILITIES,
          publicKey: options.identity.publicKey,
          pairingCommitment,
          signature: options.identity.sign(
            pairingPayload(message.challenge, options.port, pairingCommitment),
          ),
        };
        ws.send(JSON.stringify(welcome));
        resolve(new ExtensionConnection(ws, message, options, daemonNonce));
      });
    });
  }

  get open(): boolean {
    return !this.closed;
  }

  /**
   * Sends a request, calling back synchronously when the response frame arrives, so a CDP response is relayed before the events the extension sent after it (`request()` would defer it by a microtask). Calls back with an error if the extension doesn't answer within `timeoutMs`
   */
  send<M extends ExtensionRequestMethod>(
    method: M,
    params: ExtensionRequestMap[M]["params"],
    callback: (
      error: Error | null,
      result?: ExtensionRequestMap[M]["result"],
    ) => void,
    timeoutMs = this.options.requestTimeoutMs ??
      (method === "cdp" ? CDP_REQUEST_TIMEOUT_MS : REQUEST_TIMEOUT_MS),
  ) {
    if (this.closed) {
      callback(new Error("The browser disconnected"));
      return;
    }
    const id = this.nextId++;
    const timer = setTimeout(() => {
      if (this.pending.delete(id)) {
        callback(
          new Error(
            `The browser didn't answer ${method === "cdp" ? (params as { method: string }).method : method} in time`,
          ),
        );
      }
    }, timeoutMs);
    this.pending.set(id, (error, result) => {
      clearTimeout(timer);
      (callback as Callback)(error, result);
    });
    const message = { type: "request", id, method, params } as DaemonMessage;
    this.ws.send(JSON.stringify(message));
  }

  request<M extends ExtensionRequestMethod>(
    method: M,
    params: ExtensionRequestMap[M]["params"],
    timeoutMs?: number,
  ): Promise<ExtensionRequestMap[M]["result"]> {
    return new Promise((resolve, reject) => {
      this.send(
        method,
        params,
        (error, result) => {
          if (error) {
            reject(error);
          } else {
            resolve(result as ExtensionRequestMap[M]["result"]);
          }
        },
        timeoutMs,
      );
    });
  }

  /** Requests awaiting an answer */
  get pendingCount(): number {
    return this.pending.size;
  }

  /** Resolves whether the extension answered a ping within `timeoutMs` */
  ping(timeoutMs: number): Promise<boolean> {
    if (this.closed) {
      return Promise.resolve(false);
    }
    const id = this.nextId++;
    const message: DaemonMessage = { type: "ping", id };
    this.ws.send(JSON.stringify(message));
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.pongs.delete(id);
        resolve(false);
      }, timeoutMs);
      this.pongs.set(id, (alive) => {
        clearTimeout(timeout);
        resolve(alive);
      });
    });
  }

  onEvent(listener: (event: ExtensionEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onClose(listener: (code: number, reason: string) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  close(code: number, reason: string) {
    if (this.ws.readyState === this.ws.OPEN) {
      this.ws.close(code, reason);
    }
    this.handleClose(code, reason);
  }

  private handleClose(code: number, reason: string) {
    if (this.closed) {
      return;
    }
    this.closed = true;
    clearInterval(this.pingTimer);
    const error = new Error(
      "The browser disconnected from Browser MCP while handling the command",
    );
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const callback of pending) {
      callback(error);
    }
    for (const pong of this.pongs.values()) {
      pong(false);
    }
    this.pongs.clear();
    for (const listener of this.closeListeners) {
      listener(code, reason);
    }
  }

  private onMessage(data: RawData) {
    // After `close()`, while the socket is still closing
    if (this.closed) {
      return;
    }
    let message: ExtensionMessage;
    try {
      message = JSON.parse(data.toString());
    } catch {
      this.options.log("The extension sent invalid JSON");
      return;
    }
    switch (message.type) {
      case "response": {
        const callback = this.pending.get(message.id);
        if (!callback) {
          return;
        }
        this.pending.delete(message.id);
        if (message.error !== undefined) {
          callback(new Error(message.error));
        } else {
          callback(null, message.result);
        }
        return;
      }
      case "event": {
        if (message.event.type === "state") {
          this.state = message.event.data;
        }
        for (const listener of this.eventListeners) {
          try {
            listener(message.event);
          } catch (error) {
            this.options.log("Error handling an extension event:", error);
          }
        }
        return;
      }
      case "pong": {
        this.pongs.get(message.id)?.(true);
        this.pongs.delete(message.id);
        return;
      }
      case "pairingNonce": {
        this.onPairingNonce(message.nonce);
        return;
      }
    }
  }

  /** The extension's nonce for the pairing code: reveals the daemon's (once per connection) and computes the code the popup shows */
  private onPairingNonce(nonce: unknown) {
    if (this.pairingNonceReceived || typeof nonce !== "string" || !nonce) {
      this.options.log(
        "The extension sent an unexpected pairingNonce; closing",
      );
      this.close(1008, "Unexpected pairingNonce");
      return;
    }
    this.pairingNonceReceived = true;
    const reveal: DaemonMessage = {
      type: "pairingReveal",
      nonce: this.daemonNonce,
    };
    this.ws.send(JSON.stringify(reveal));
    void pairingCode(this.options.identity.publicKey, nonce, this.daemonNonce)
      .then((code) => {
        this.pairingCode = code;
      })
      .catch((error: unknown) => {
        this.options.log("Couldn't compute the pairing code:", error);
      });
  }
}
