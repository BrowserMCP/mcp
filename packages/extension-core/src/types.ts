import type { Browser } from "wxt/browser";

/** Chrome's tab group colors, in the order apps get them */
export const TAB_GROUP_COLORS = [
  "blue",
  "red",
  "yellow",
  "green",
  "pink",
  "purple",
  "cyan",
  "orange",
  "grey",
] as const satisfies readonly `${Browser.tabGroups.Color}`[];
export type TabGroupColor = (typeof TAB_GROUP_COLORS)[number];

/** Roughly how Chrome draws each group color, for the toolbar badge and the popup */
export const TAB_GROUP_HEX: Record<TabGroupColor, string> = {
  blue: "#1a73e8",
  red: "#d93025",
  yellow: "#f9ab00",
  green: "#188038",
  pink: "#d01884",
  purple: "#a142f4",
  cyan: "#007b83",
  orange: "#fa903e",
  grey: "#5f6368",
};

/** Chrome's text color on each group color: dark on the light ones */
export const TAB_GROUP_TEXT: Record<TabGroupColor, string> = {
  blue: "#fff",
  red: "#fff",
  yellow: "#202124",
  green: "#fff",
  pink: "#fff",
  purple: "#fff",
  cyan: "#fff",
  orange: "#202124",
  grey: "#fff",
};

/**
 * The connection to the Browser MCP daemon, as the popup shows it. Failures stay until another outcome replaces them, so the popup doesn't flicker while the extension retries
 */
export type ConnectionStatus =
  /** Looking for the daemon on its ports (none found yet, or it went away) */
  | { state: "searching" }
  | {
      state: "connected";
      port: number;
      daemonVersion: string;
      /** The daemon's public key (base64 SPKI) */
      publicKey: string;
      /** The six-digit pairing code for this connection (`pairingCode()`), when the key wasn't allowed yet as it connected */
      code?: string;
      /** `pending` until the user clicks **Allow** for this key */
      pairing: "paired" | "pending";
    }
  /** The program on the port couldn't sign the challenge with the key it sent, so it isn't offered **Allow** */
  | { state: "untrusted" }
  /** The daemon's protocol is older than the extension's */
  | { state: "updateServer"; daemonVersion?: string }
  /** The daemon's protocol is newer than the extension's */
  | { state: "updateExtension"; daemonVersion?: string }
  /** Another browser or profile holds the daemon's connection (close code 4002) */
  | { state: "anotherBrowser" };

/** An AI app using the browser, with its tabs, for the popup */
export type BrowserControlApp = {
  id: string;
  name: string;
  color: TabGroupColor;
  tabs: { tabId: number; title: string; url: string; attached: boolean }[];
};

/** What the popup shows (`getBrowserControl`) */
export type BrowserControlView = {
  connection: ConnectionStatus;
  /** A 0.1.x server answers on port 9009 (shown even while a 2.0 daemon is connected) */
  legacyServer: boolean;
  paused: boolean;
  /** The custom port to look for the daemon on, or `null` for the default ports */
  relayPort: number | null;
  apps: BrowserControlApp[];
};
