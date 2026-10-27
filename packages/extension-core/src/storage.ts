import { storage } from "wxt/utils/storage";

import type { ConnectionStatus, TabGroupColor } from "./types";

/*
 * Browser control's state lives in `storage.session`: it survives the service worker stopping (which Chrome does whenever it's idle), but not a browser restart. Debugger attachments are never stored: they're in memory, and the daemon attaches again after a restart
 */

/** The connection to the daemon, for the popup. Reset when the service worker starts, so it never shows a connection that's gone */
export const connectionStatusItem = storage.defineItem<ConnectionStatus>(
  "session:browserControlConnection",
  { fallback: { state: "searching" } },
);

/** The user pressed **Stop** (or Cancel on Chrome's debugging bar) and hasn't pressed **Resume** */
export const pausedItem = storage.defineItem<boolean>(
  "session:browserControlPaused",
  { fallback: false },
);

export type AppGroup = {
  name: string;
  color: TabGroupColor;
  /** The app's tab groups: one per window it has tabs in */
  groupIds: number[];
};

export type AppGroups = {
  /** By app ID (`AppInfo.id`) */
  apps: Record<string, AppGroup>;
  /** The app each tab is assigned to, by tab ID: the tabs in its groups, and pinned tabs, which can't be grouped */
  tabApps: Record<string, string>;
};

export const appGroupsItem = storage.defineItem<AppGroups>(
  "session:browserControlApps",
  { fallback: { apps: {}, tabApps: {} } },
);

/** The app that acted last (`activity`), whose color the toolbar badge has */
export const lastActiveAppItem = storage.defineItem<string | null>(
  "session:browserControlLastActiveApp",
  { fallback: null },
);

/** A 0.1.x server answers on `LEGACY_PORT`, and the extension answers its commands with `LEGACY_SERVER_MESSAGE`. The popup shows the update steps and the toolbar icon "!" */
export const legacyServerItem = storage.defineItem<boolean>(
  "session:browserControlLegacyServer",
  { fallback: false },
);

/** The daemon keys (base64 SPKI) the user clicked **Allow** for. In `storage.local`, so pairing survives browser restarts and updates */
export const pairedDaemonKeysItem = storage.defineItem<string[]>(
  "local:pairedDaemonKeys",
  { fallback: [] },
);

/** The daemon's port when it runs with `--port`, set by hand (e.g. `chrome.storage.local.set({ relayPort: 9123 })` in the service worker's console) or by tests. Only that port is tried then; otherwise `RELAY_PORTS` */
export const relayPortItem = storage.defineItem<number | null>(
  "local:relayPort",
  { fallback: null },
);

/** Development and test builds only: the port to look for a 0.1.x server on instead of `LEGACY_PORT`, so the smoke test can run a fake one on a random port without touching 9009 */
export const legacyPortItem = storage.defineItem<number | null>(
  "local:legacyPort",
  { fallback: null },
);
