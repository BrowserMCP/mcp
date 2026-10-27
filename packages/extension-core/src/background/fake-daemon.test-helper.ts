import {
  type DaemonMessage,
  type ExtensionMessage,
  PAIRING_KEY_ALGORITHM,
  RELAY_PRODUCT,
  RELAY_PROTOCOL_VERSION,
  type RelayStatus,
  createPairingNonce,
  pairingCode,
  pairingCommitment,
  pairingPayload,
} from "@browsermcp/protocol";

import { toBase64 } from "./pairing";

/** A WebSocket the test plays the server of */
export class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readonly url: string;
  readyState = FakeWebSocket.CONNECTING;
  readonly sent: unknown[] = [];
  closedWith: { code?: number; reason?: string } | null = null;
  /** The server's answers to what the extension sends (e.g. `pairingReveal` to `pairingNonce`) */
  onSent: ((message: ExtensionMessage) => void) | null = null;

  constructor(url: string) {
    super();
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(data: string) {
    const message = JSON.parse(data) as ExtensionMessage;
    this.sent.push(message);
    const onSent = this.onSent;
    if (onSent) {
      queueMicrotask(() => {
        if (this.readyState === FakeWebSocket.OPEN) {
          onSent(message);
        }
      });
    }
  }

  close(code?: number, reason?: string) {
    if (this.readyState === FakeWebSocket.CLOSED) {
      return;
    }
    this.closedWith = { code, reason };
    this.serverClose(code ?? 1005, reason ?? "");
  }

  // --- The server's side ---

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.dispatchEvent(new Event("open"));
  }

  receive(message: unknown) {
    this.dispatchEvent(
      new MessageEvent("message", { data: JSON.stringify(message) }),
    );
  }

  serverClose(code: number, reason = "") {
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatchEvent(new CloseEvent("close", { code, reason }));
  }

  /** Fails to connect (nothing speaks WebSocket there) */
  fail() {
    this.serverClose(1006);
  }

  messages<T extends ExtensionMessage["type"]>(type: T) {
    return this.sent.filter(
      (message): message is Extract<ExtensionMessage, { type: T }> =>
        (message as { type: string }).type === type,
    );
  }

  static reset() {
    FakeWebSocket.instances = [];
  }

  static latest(urlPart: string): FakeWebSocket | undefined {
    return FakeWebSocket.instances.findLast((ws) => ws.url.includes(urlPart));
  }
}

export type FakePort = "daemon" | "legacy" | "other" | "none";

/**
 * A `fetch` for the probes: each port answers as a 2.0 daemon (CORS, `/browsermcp/status`), a 0.1.x server (only `no-cors`), another program, or nothing
 */
export function createFakeFetch(
  ports: Record<number, FakePort>,
  status: Partial<RelayStatus> = {},
) {
  const calls: { url: string; mode?: RequestMode }[] = [];
  const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, mode: init?.mode });
    const port = Number(new URL(url).port);
    const kind = ports[port] ?? "none";
    if (kind === "none") {
      throw new TypeError("Failed to fetch");
    }
    if (init?.mode === "no-cors") {
      return new Response(null, { status: 200 });
    }
    if (kind === "daemon") {
      return Response.json({
        product: RELAY_PRODUCT,
        version: "2.0.0",
        protocol: RELAY_PROTOCOL_VERSION,
        minProtocol: RELAY_PROTOCOL_VERSION,
        pid: 1,
        ...status,
      } satisfies RelayStatus);
    }
    // No CORS headers: a CORS request fails
    throw new TypeError("Failed to fetch");
  };
  return Object.assign(fakeFetch as typeof fetch, { calls, ports });
}

/** A daemon's key pair, which signs challenges as the daemon does */
export async function createDaemonKey() {
  const keyPair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: PAIRING_KEY_ALGORITHM.namedCurve },
    true,
    ["sign", "verify"],
  );
  const publicKey = toBase64(
    new Uint8Array(await crypto.subtle.exportKey("spki", keyPair.publicKey)),
  );
  return {
    publicKey,
    /** Signs the challenge and the commitment for the port the daemon listens on */
    async sign(challenge: string, port: number, commitment: string) {
      return toBase64(
        new Uint8Array(
          await crypto.subtle.sign(
            { name: "ECDSA", hash: PAIRING_KEY_ALGORITHM.hash },
            keyPair.privateKey,
            new TextEncoder().encode(
              pairingPayload(challenge, port, commitment),
            ),
          ),
        ),
      );
    },
  };
}

export type DaemonKey = Awaited<ReturnType<typeof createDaemonKey>>;

/**
 * The daemon's `welcome` to the extension's `hello` on this socket, signed for the socket's port unless `port` names another (a program on one port relaying the challenge to a daemon on another), with a commitment to a fresh nonce. It answers the extension's `pairingNonce` with that nonce (`pairingReveal`), or with another one (`badReveal`, a daemon that didn't commit to its nonce), or not at all (`reveal: false`). `code()` is the pairing code the daemon computes once the extension sent its nonce
 */
export async function welcome(
  ws: FakeWebSocket,
  key: DaemonKey,
  {
    badSignature = false,
    badReveal = false,
    reveal = true,
    port = Number(new URL(ws.url).port),
  }: {
    badSignature?: boolean;
    badReveal?: boolean;
    reveal?: boolean;
    port?: number;
  } = {},
) {
  const [hello] = ws.messages("hello");
  if (!hello) {
    throw new Error("No hello yet");
  }
  const daemonNonce = createPairingNonce();
  const commitment = await pairingCommitment(daemonNonce);
  const message: DaemonMessage = {
    type: "welcome",
    protocol: RELAY_PROTOCOL_VERSION,
    daemonVersion: "2.0.0",
    capabilities: [],
    publicKey: key.publicKey,
    pairingCommitment: commitment,
    signature: await key.sign(
      badSignature ? "another challenge" : hello.challenge,
      port,
      commitment,
    ),
  };
  ws.onSent = (sent) => {
    if (sent.type === "pairingNonce" && reveal) {
      ws.receive({
        type: "pairingReveal",
        nonce: badReveal ? createPairingNonce() : daemonNonce,
      } satisfies DaemonMessage);
    }
  };
  ws.receive(message);
  return {
    message,
    daemonNonce,
    /** The daemon's side of the pairing code, from the nonce the extension sent */
    async code(): Promise<string> {
      const [sent] = ws.messages("pairingNonce");
      if (!sent) {
        throw new Error("No pairingNonce yet");
      }
      return pairingCode(key.publicKey, sent.nonce, daemonNonce);
    },
  };
}
