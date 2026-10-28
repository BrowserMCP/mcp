/**
 * The protocol between the extension (a thin `chrome.debugger` relay) and the Browser MCP daemon (`@browsermcp/mcp`), shared by both.
 *
 * The extension probes `GET http://127.0.0.1:<port>/browsermcp/status` on each of `RELAY_PORTS` in turn, then opens `ws://127.0.0.1:<port>/extension` and sends `hello` with a random challenge. The daemon answers `welcome` with its public key and its signature of the challenge (`pairingPayload()`), or closes with `RelayCloseCode.unsupportedProtocol` and a reason naming the side to update. Every frame is one JSON object (`ExtensionMessage` or `DaemonMessage`).
 *
 * Pairing: a daemon key the extension hasn't paired with gets no tabs (`state.pairing: "pending"`) and every request fails with `pairingRequiredMessage()` until the user clicks **Allow** in the popup, which shows the same six-digit `pairingCode()`. The extension enforces every rule about tabs (pairing, incognito tabs unless the user allowed the extension in incognito, browser pages, Stop), so a program that takes over the port gets nothing.
 *
 * The code is a short authentication string built with a commitment, like Bluetooth's numeric comparison or ZRTP:
 * 1. `hello` (extension → daemon) carries a random `challenge`.
 * 2. `welcome` (daemon → extension) carries `pairingCommitment`, the SHA-256 of a random nonce the daemon makes for this connection, and the signature of `pairingPayload(challenge, port, pairingCommitment)`.
 * 3. Only for a key it hasn't paired with, the extension then sends `pairingNonce` with a random nonce of its own.
 * 4. The daemon answers `pairingReveal` with its nonce. The extension checks it against the commitment, and treats a daemon whose reveal doesn't match as untrusted, as it does a bad signature.
 * 5. Both sides compute `pairingCode(publicKey, extensionNonce, daemonNonce)`.
 *
 * The order is what makes six digits enough: the daemon commits to its nonce before it sees the extension's, and the extension sends its nonce before the daemon reveals, so a program in the middle (one that takes over a port and connects to the real daemon as an extension) can't steer either side's code towards the other's. Its chance of showing the user matching codes is one in a million per attempt, and each attempt shows a new code.
 */
import type { Protocol } from "devtools-protocol/types/protocol";

/** Bumped on breaking changes. Each side states the versions it supports, so later releases can stay compatible */
export const RELAY_PROTOCOL_VERSION = 1;

/** The ports the daemon binds (the first free one) and the extension tries, in order. `--port` sets one port for both (the extension's settings, `isValidRelayPort()`) */
export const RELAY_PORTS = [9010, 9011, 9012] as const;

/** 0.1.x servers' port. Nothing of ours listens there, since 0.1.x servers kill whatever holds it when they start; the extension only probes it (`no-cors`) to find an old server, and answers its commands with `LEGACY_SERVER_MESSAGE` */
export const LEGACY_PORT = 9009;

/** A port the user can give `--port` and the extension: 1024–65535 (not the privileged ones), and not `LEGACY_PORT` */
export function isValidRelayPort(port: number): boolean {
  return (
    Number.isInteger(port) &&
    port >= 1024 &&
    port <= 65535 &&
    port !== LEGACY_PORT
  );
}

/** What the extension answers every 0.1.x server command with, so the agent tells the user why the browser stopped working */
export const LEGACY_SERVER_MESSAGE =
  "Browser MCP's extension is now 2.0. Update the MCP server: use @browsermcp/mcp@latest in your AI app's MCP config and restart the app";

// --- Pairing ---

/**
 * The daemon's key pair is ECDSA P-256 (supported by WebCrypto in every Chromium the extension runs in, and by Node). The public key is sent as base64 SPKI (DER); signatures are base64 IEEE P1363 (`r || s`, what WebCrypto produces and verifies; Node's `crypto.sign` needs `dsaEncoding: "ieee-p1363"`) over SHA-256
 */
export const PAIRING_KEY_ALGORITHM = {
  name: "ECDSA",
  namedCurve: "P-256",
  hash: "SHA-256",
} as const;

/**
 * The bytes the daemon signs: the UTF-8 encoding of this string. The challenge is base64 of 32 random bytes. It names the port, which the daemon signs with the port it listens on and the extension checks against the port it dialed, so a program holding another of `RELAY_PORTS` can't relay the extension's challenge to the real daemon and pass its signature back. It also covers `welcome`'s `pairingCommitment`, so only the key's holder commits to the nonce behind the pairing code
 */
export function pairingPayload(
  challenge: string,
  port: number,
  pairingCommitment: string,
): string {
  return `${RELAY_PRODUCT}-pair-v1:${port}:${challenge}:${pairingCommitment}`;
}

/** A pairing nonce: base64 of 32 random bytes, fresh for each connection */
export function createPairingNonce(): string {
  return toBase64(globalThis.crypto.getRandomValues(new Uint8Array(32)));
}

/** `welcome`'s `pairingCommitment`: base64 of the SHA-256 of the daemon's nonce (its 32 bytes, decoded from base64) */
export async function pairingCommitment(daemonNonce: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    fromBase64(daemonNonce),
  );
  return toBase64(new Uint8Array(digest));
}

/**
 * The six-digit code shown in the popup next to **Allow** and in tool results (`pairingRequiredMessage()`), so the user can match the two, e.g. `482 913`. Both sides compute it from the daemon's public key (base64 SPKI) and the connection's two nonces (`pairingNonce`, `pairingReveal`): the SHA-256 of the UTF-8 of `browsermcp-pair-code-v1:<publicKey>:<extensionNonce>:<daemonNonce>`, whose first 4 bytes as an unsigned big-endian integer, mod 1,000,000 and zero-padded, are the code. A fresh connection gives a fresh code
 */
export async function pairingCode(
  publicKey: string,
  extensionNonce: string,
  daemonNonce: string,
): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      `${RELAY_PRODUCT}-pair-code-v1:${publicKey}:${extensionNonce}:${daemonNonce}`,
    ),
  );
  const digits = String(
    new DataView(digest).getUint32(0, false) % 1_000_000,
  ).padStart(6, "0");
  return `${digits.slice(0, 3)} ${digits.slice(3)}`;
}

/** What requests answer while the extension waits for **Allow**: without a code until the extension's nonce arrived (a moment after it connects) */
export function pairingRequiredMessage(code?: string): string {
  const message = "Click Allow in the Browser MCP extension's popup";
  return code ? `${message}. The code is ${code}` : message;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function fromBase64(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** What tool calls answer while no 2.0 extension is connected (none, or a 1.x one, which only dials 9009) */
export const NO_EXTENSION_MESSAGE =
  "No browser is connected. Install the Browser MCP extension, or update it to 2.0: open chrome://extensions, turn on Developer mode and click Update";

/** Names the product in `/browsermcp/status`, so the extension doesn't mistake another program on the port for the daemon */
export const RELAY_PRODUCT = "browsermcp";

/** The extension's ID in the Chrome Web Store, which the daemon accepts on `/extension` (its `Origin`) */
export const CHROME_WEB_STORE_EXTENSION_ID = "bjfgambnhccakkhmkepdoekmckoijdlc";

/** The ID of the extension built from source (`@browsermcp/extension`), whose manifest has a fixed `key` so every build gets it. The daemon accepts it too: the user still pairs it with **Allow** */
export const SELF_BUILT_EXTENSION_ID = "imlplcjlhgpajopdbpbngiadkcmdbgob";

export const RelayPaths = {
  status: "/browsermcp/status",
  extension: "/extension",
  /** The daemon's own Playwright connection, with `?token=` */
  cdp: "/cdp",
  /** The thin processes (`@browsermcp/mcp` in each AI app), with `?token=` */
  client: "/client",
  /** `POST`, with `?token=`: a newer thin process asks an older daemon to exit */
  shutdown: "/shutdown",
} as const;

/** `GET /browsermcp/status`, served with CORS for `chrome-extension://` origins */
export type RelayStatus = {
  product: typeof RELAY_PRODUCT;
  /** The daemon's version (`@browsermcp/mcp`'s package version) */
  version: string;
  /** The newest protocol version the daemon speaks */
  protocol: number;
  /** The oldest protocol version the daemon still accepts */
  minProtocol: number;
  pid: number;
};

export const RelayCloseCode = {
  /** The other side's protocol version isn't supported. The reason says which side to update: `RelayUpdateReason` */
  unsupportedProtocol: 4001,
  /** Another browser or profile is connected and an agent is using one of its tabs, or this browser was replaced by another. The extension keeps retrying */
  anotherBrowser: 4002,
  /** The daemon is exiting (idle, or replaced by a newer one). The extension reconnects */
  shuttingDown: 4003,
} as const;

/** The reasons sent with `RelayCloseCode.unsupportedProtocol` */
export const RelayUpdateReason = {
  updateExtension: "update-extension",
  updateServer: "update-server",
} as const;
export type RelayUpdateReason =
  (typeof RelayUpdateReason)[keyof typeof RelayUpdateReason];

/** Capabilities either side may announce in `hello` / `welcome`. Unknown ones are ignored */
export type RelayCapability =
  /** The extension moves popup windows that pages open into a normal window, so the debugger can attach */
  | "popupWindows"
  /** The extension reports tabs that pages open (`tabOpened`) */
  | "tabOpened"
  /** The extension manages tab groups per AI app */
  | "tabGroups"
  | (string & {});

// --- State the extension reports ---

/**
 * A tab agents may use: every tab except incognito ones (unless the user allowed the extension in incognito), discarded, `chrome://` and other browser pages, extension pages, and the Web Store. The list stays on the user's machine; the model only sees titles and URLs when it runs `tab list`
 */
export type ExposedTab = {
  tabId: number;
  windowId: number;
  url: string;
  title: string;
  /** The active tab of its window */
  active: boolean;
  pinned: boolean;
  /** The AI app whose group the tab is in (`AppInfo.id`), or that it's assigned to while pinned (pinned tabs can't be grouped) */
  appId?: string;
  /** Whether the debugger is attached to it */
  attached: boolean;
};

/** An AI app, from the MCP client's name. Sessions of the same app share its tab group */
export type AppInfo = {
  /** Stable key, e.g. `claude-code` */
  id: string;
  /** The group's title, e.g. `Claude Code` */
  name: string;
};

export type ExtensionState = {
  tabs: ExposedTab[];
  /** The user pressed **Stop** (or Cancel on Chrome's debugging bar) and hasn't pressed **Resume** */
  paused: boolean;
  /** `pending` until the user clicks **Allow** for this daemon's key; `tabs` is empty and every request fails meanwhile */
  pairing: "paired" | "pending";
};

// --- Daemon → extension requests ---

export type ExtensionRequestMap = {
  /** Attaches the debugger to the tab, if it isn't already. Returns its target info (from `Target.getTargetInfo`), whose `targetId` is the tab's CDP target ID */
  attach: {
    params: { tabId: number };
    result: { targetInfo: Protocol.Target.TargetInfo };
  };
  /** Detaches the debugger from the tab, if it's attached. Not reported back as a `detached` event */
  detach: { params: { tabId: number }; result: void };
  /** Sends a CDP command to the tab (or to one of its child sessions, e.g. an out-of-process iframe). `Input.*` commands are run one at a time per tab */
  cdp: {
    params: {
      tabId: number;
      sessionId?: string;
      method: string;
      params?: Record<string, unknown>;
    };
    result: unknown;
  };
  /** Opens a background tab in the app's group (creating the group if needed) */
  createTab: {
    params: { url?: string; app: AppInfo };
    result: { tabId: number };
  };
  /** Closes a tab */
  closeTab: { params: { tabId: number }; result: void };
  /** Makes the tab active in its window and focuses the window */
  activateTab: { params: { tabId: number }; result: void };
  /** Puts the tab in the app's group (pinned tabs are only assigned, not grouped), or takes it out of any app's group with `app: null` */
  groupTab: {
    params: { tabId: number; app: AppInfo | null };
    result: void;
  };
  /** Reports which app acted last, for the toolbar badge's color */
  activity: { params: { appId: string }; result: void };
};

export type ExtensionRequestMethod = keyof ExtensionRequestMap;

export type ExtensionRequest = {
  [M in ExtensionRequestMethod]: {
    method: M;
    params: ExtensionRequestMap[M]["params"];
  };
}[ExtensionRequestMethod];

// --- Extension → daemon events ---

export type ExtensionEventMap = {
  /** A CDP event from an attached tab, or one of its child sessions */
  cdpEvent: {
    tabId: number;
    sessionId?: string;
    method: string;
    params?: unknown;
  };
  /**
   * The debugger detached from a tab without the daemon asking (`chrome.debugger.onDetach`), or the extension detached it itself. `canceled_by_user` (Cancel on Chrome's debugging bar) also pauses every agent, and the extension sends `state` with `paused: true`. On other reasons the daemon re-attaches when the tab is used again
   */
  detached: { tabId: number; reason: string };
  /** The tab list, `paused`, or a tab's group changed. Sent in full (it's small), debounced */
  state: ExtensionState;
  /** The user dragged a tab into an app's group (`appId`) or out of it (`appId: null`) */
  tabAssigned: { tabId: number; appId: string | null };
  /** A page opened a tab (`target=_blank`, `window.open`), found with `webNavigation.onCreatedNavigationTarget`, after moving a popup window into a normal window */
  tabOpened: { tabId: number; openerTabId: number; url: string };
};

export type ExtensionEventType = keyof ExtensionEventMap;

export type ExtensionEvent = {
  [T in ExtensionEventType]: { type: T; data: ExtensionEventMap[T] };
}[ExtensionEventType];

// --- Frames ---

export type BrowserInfo = {
  /** e.g. `Chrome`, `Edge`, `Brave` (from `navigator.userAgentData` where available) */
  name: string;
  version: string;
  userAgent: string;
};

/** Frames the extension sends */
export type ExtensionMessage =
  | {
      type: "hello";
      protocol: number;
      extensionVersion: string;
      browser: BrowserInfo;
      capabilities: RelayCapability[];
      /** Base64 of 32 random bytes, signed by the daemon in `welcome` */
      challenge: string;
      state: ExtensionState;
    }
  /** After `welcome`, only for a key the extension hasn't paired with: its nonce for `pairingCode()` (`createPairingNonce()`), sent before the daemon reveals its own. Once per connection */
  | { type: "pairingNonce"; nonce: string }
  | {
      type: "response";
      id: number;
      result?: unknown;
      /** A message for the model, e.g. naming another extension whose iframe blocks attaching */
      error?: string;
    }
  | { type: "event"; event: ExtensionEvent }
  | { type: "pong"; id: number };

/** Frames the daemon sends */
export type DaemonMessage =
  | {
      type: "welcome";
      protocol: number;
      daemonVersion: string;
      capabilities: RelayCapability[];
      /** The daemon's public key (base64 SPKI), from `~/.browsermcp/identity.json` */
      publicKey: string;
      /** Base64 SHA-256 of the daemon's nonce for this connection (`pairingCommitment()`), revealed in `pairingReveal` */
      pairingCommitment: string;
      /** Its signature of `pairingPayload(challenge, port, pairingCommitment)` (base64 IEEE P1363), with the port it listens on */
      signature: string;
    }
  /** The answer to `pairingNonce`: the nonce behind `welcome`'s `pairingCommitment` */
  | { type: "pairingReveal"; nonce: string }
  | ({ type: "request"; id: number } & ExtensionRequest)
  /** Sent every 20 s; the extension answers `pong` with the same `id` */
  | { type: "ping"; id: number };

/** How often the daemon pings the extension, and how long it waits for the pong before closing the connection */
export const RELAY_PING_INTERVAL_MS = 20_000;
export const RELAY_PING_TIMEOUT_MS = 10_000;

/** The extension's reconnect delays, the last repeated */
export const RELAY_RECONNECT_DELAYS_MS = [1000, 2000, 3000, 5000] as const;
