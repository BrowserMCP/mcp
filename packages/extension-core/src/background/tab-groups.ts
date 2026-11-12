import { type Browser, browser } from "wxt/browser";

import type { AppInfo } from "@browsermcp/protocol";

import { type AppGroup, type AppGroups, appGroupsItem } from "../storage";
import { TAB_GROUP_COLORS, type TabGroupColor } from "../types";

/** `tabGroups.TAB_GROUP_ID_NONE` */
const NO_GROUP = -1;

let queue: Promise<unknown> = Promise.resolve();

/** The group, or `null` when it's gone or the browser has no tab groups (Android Chromium browsers) */
function getGroup(groupId: number): Promise<Browser.tabGroups.TabGroup | null> {
  if (!browser.tabGroups) {
    return Promise.resolve(null);
  }
  return browser.tabGroups.get(groupId).catch(() => null);
}

/**
 * Runs `update` on the app groups and saves them, one update at a time. Group changes the extension makes itself run inside it, so the `tabs.onUpdated` they cause (handled with this too) find the groups already saved and aren't mistaken for the user dragging a tab
 */
export function withAppGroups<T>(
  update: (groups: AppGroups) => Promise<T> | T,
): Promise<T> {
  const run = async () => {
    const groups = structuredClone(await appGroupsItem.getValue());
    const result = await update(groups);
    await appGroupsItem.setValue(groups);
    return result;
  };
  const result = queue.then(run, run);
  queue = result.catch(() => {});
  return result;
}

/** A color for a new app's group: the first of Chrome's colors no other app has, or one picked from its ID once all 9 are taken */
export function pickColor(
  apps: Record<string, AppGroup>,
  appId: string,
): TabGroupColor {
  const used = new Set(
    Object.entries(apps)
      .filter(([id]) => id !== appId)
      .map(([, app]) => app.color),
  );
  const free = TAB_GROUP_COLORS.find((color) => !used.has(color));
  if (free) {
    return free;
  }
  let hash = 0;
  for (const char of appId) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return TAB_GROUP_COLORS[hash % TAB_GROUP_COLORS.length];
}

/** The app whose group this is, if any */
export function getAppIdForGroup(
  groups: AppGroups,
  groupId: number | undefined,
): string | null {
  if (groupId === undefined || groupId === NO_GROUP) {
    return null;
  }
  const entry = Object.entries(groups.apps).find(([, app]) =>
    app.groupIds.includes(groupId),
  );
  return entry?.[0] ?? null;
}

function ensureApp(groups: AppGroups, app: AppInfo): AppGroup {
  const existing = groups.apps[app.id];
  if (existing) {
    existing.name = app.name;
    return existing;
  }
  const created: AppGroup = {
    name: app.name,
    color: pickColor(groups.apps, app.id),
    groupIds: [],
  };
  groups.apps[app.id] = created;
  return created;
}

/** The app's group in this window, dropping groups that no longer exist */
async function findGroupInWindow(
  app: AppGroup,
  windowId: number,
): Promise<number | undefined> {
  let found: number | undefined;
  for (const groupId of app.groupIds) {
    const group = await getGroup(groupId);
    if (!group) {
      app.groupIds = app.groupIds.filter((id) => id !== groupId);
    } else if (group.windowId === windowId) {
      found = groupId;
    }
  }
  return found;
}

/**
 * Assigns the tab to the app and puts it in the app's group in its window (creating the group, named after the app in the app's color), or takes it out of any app's group with `app: null`. Pinned tabs are only assigned: grouping a tab unpins it. The group is only how the user sees it: where the browser can't group tabs (Android Chromium browsers say "Tabs cannot be edited right now"), the tab is still assigned. Never attaches the debugger
 */
export function groupTab(tabId: number, app: AppInfo | null): Promise<void> {
  return withAppGroups(async (groups) => {
    const tab = await browser.tabs.get(tabId);
    if (app) {
      groups.tabApps[tabId] = app.id;
    } else {
      delete groups.tabApps[tabId];
    }
    await updateGroup(groups, tab, app).catch((error: unknown) => {
      console.warn("Couldn't group a tab", error);
    });
  });
}

async function updateGroup(
  groups: AppGroups,
  tab: Browser.tabs.Tab,
  app: AppInfo | null,
): Promise<void> {
  const tabId = tab.id!;
  if (!app) {
    if (getAppIdForGroup(groups, tab.groupId)) {
      await browser.tabs.ungroup(tabId);
    }
    return;
  }
  const entry = ensureApp(groups, app);
  if (tab.pinned || !browser.tabGroups) {
    return;
  }
  const groupId = await findGroupInWindow(entry, tab.windowId);
  if (groupId !== undefined) {
    if (tab.groupId !== groupId) {
      await browser.tabs.group({ tabIds: [tabId], groupId });
    }
    return;
  }
  const newGroupId = await browser.tabs.group({
    tabIds: [tabId],
    createProperties: { windowId: tab.windowId },
  });
  entry.groupIds.push(newGroupId);
  await browser.tabGroups.update(newGroupId, {
    title: entry.name,
    color: entry.color,
  });
}

/**
 * After a tab's group or pinned state changed: the app it's now assigned to, when that changed because the user dragged it into or out of an app's group (`tabAssigned`), else `undefined`. Pinning keeps a tab's app, though it leaves the group
 */
export function updateTabAssignment(
  tabId: number,
): Promise<{ tabId: number; appId: string | null } | undefined> {
  return withAppGroups(async (groups) => {
    const tab = await browser.tabs.get(tabId).catch(() => null);
    if (!tab) {
      return undefined;
    }
    const current = groups.tabApps[tabId] ?? null;
    let next = getAppIdForGroup(groups, tab.groupId);
    if (!next && tab.pinned && tab.groupId === NO_GROUP) {
      next = current;
    }
    if (next === current) {
      return undefined;
    }
    if (next) {
      groups.tabApps[tabId] = next;
    } else {
      delete groups.tabApps[tabId];
    }
    return { tabId, appId: next };
  });
}

export function forgetTab(tabId: number): Promise<void> {
  return withAppGroups((groups) => {
    delete groups.tabApps[tabId];
  });
}

export function forgetGroup(groupId: number): Promise<void> {
  return withAppGroups((groups) => {
    for (const app of Object.values(groups.apps)) {
      app.groupIds = app.groupIds.filter((id) => id !== groupId);
    }
  });
}

/**
 * When the background starts: drops groups and tabs that are gone and assigns tabs found in an app's group, in case the user changed them while the service worker was stopped
 */
export function reconcileAppGroups(): Promise<void> {
  return withAppGroups(async (groups) => {
    const tabs = await browser.tabs.query({});
    const tabIds = new Set(tabs.map((tab) => tab.id));
    for (const app of Object.values(groups.apps)) {
      const existing = await Promise.all(
        app.groupIds.map(async (id) => ((await getGroup(id)) ? id : null)),
      );
      app.groupIds = existing.filter((id) => id !== null);
    }
    for (const tabId of Object.keys(groups.tabApps)) {
      if (!tabIds.has(Number(tabId))) {
        delete groups.tabApps[tabId];
      }
    }
    for (const tab of tabs) {
      const appId = getAppIdForGroup(groups, tab.groupId);
      if (tab.id === undefined) {
        continue;
      }
      if (appId) {
        groups.tabApps[tab.id] = appId;
      } else if (!tab.pinned) {
        delete groups.tabApps[tab.id];
      }
    }
  });
}

/**
 * Opens an agent's new tab, decided only here. As the hidden-tab spike found (`@browsermcp/mcp`'s `spikes/hidden-tabs/RESULTS.md`), it's a background tab (never active, and no window is focused) in the window that has the app's group (never an incognito one), else the user's last focused normal window; the daemon's focus emulation makes it render. Only when there's no normal window (none listed, and no tab in one) does it open one, minimized and unfocused, so nothing comes up over the user's windows
 */
export async function openAgentTab(
  url: string,
  appId: string,
): Promise<number> {
  const groups = await appGroupsItem.getValue();
  let windowId: number | undefined;
  for (const groupId of groups.apps[appId]?.groupIds ?? []) {
    const group = await getGroup(groupId);
    if (!group) {
      continue;
    }
    // A group in an incognito window (the user dragged one of its tabs in) isn't where new tabs go: they'd open logged out
    const window = await browser.windows.get(group.windowId).catch(() => null);
    if (window && !window.incognito) {
      windowId = group.windowId;
      break;
    }
  }
  if (windowId === undefined) {
    const [windows, lastFocused] = await Promise.all([
      browser.windows.getAll({ windowTypes: ["normal"] }).catch(() => []),
      browser.windows
        .getLastFocused({ windowTypes: ["normal"] })
        .catch(() => null),
    ]);
    windowId =
      lastFocused && !lastFocused.incognito
        ? lastFocused.id
        : windows.find((window) => !window.incognito)?.id;
  }
  if (windowId === undefined) {
    // Android Chromium browsers may not list their window, but their tabs say which it is
    const tabs = await browser.tabs.query({ windowType: "normal" });
    windowId = tabs.find((tab) => !tab.incognito)?.windowId;
  }
  if (windowId === undefined) {
    const window = await browser.windows.create({
      url,
      focused: false,
      state: "minimized",
      type: "normal",
    });
    const tabId = window?.tabs?.[0]?.id;
    if (tabId === undefined) {
      throw new Error("Couldn't open a tab");
    }
    return tabId;
  }
  const tab = await browser.tabs.create({ url, windowId, active: false });
  if (tab.id === undefined) {
    throw new Error("Couldn't open a tab");
  }
  return tab.id;
}
