import { vi } from "vitest";
import type { Browser } from "wxt/browser";
import { fakeBrowser } from "wxt/testing/fake-browser";

/** A minimal event with `trigger()`, for the APIs WXT's `fakeBrowser` doesn't implement */
export function fakeEvent<Listener extends (...args: never[]) => unknown>() {
  const listeners: Listener[] = [];
  return {
    addListener: (listener: Listener) => void listeners.push(listener),
    removeListener: (listener: Listener) => {
      const index = listeners.indexOf(listener);
      if (index >= 0) {
        listeners.splice(index, 1);
      }
    },
    hasListener: (listener: Listener) => listeners.includes(listener),
    trigger: async (...args: Parameters<Listener>) =>
      Promise.all(listeners.map((listener) => listener(...args))),
  };
}

type FakeTab = {
  id: number;
  windowId: number;
  url: string;
  title: string;
  active: boolean;
  pinned: boolean;
  incognito: boolean;
  discarded: boolean;
  groupId: number;
  pendingUrl?: string;
  openerTabId?: number;
};

type FakeGroup = {
  id: number;
  windowId: number;
  title?: string;
  color?: string;
};

/**
 * An in-memory Chrome for browser control's tests, on top of `fakeBrowser`: tabs with groups, windows, tab groups and `debugger` (which `fakeBrowser` lacks). Group changes fire `tabs.onUpdated` with `groupId`, as Chrome does
 */
export function installFakeChrome() {
  const tabs = new Map<number, FakeTab>();
  const windows = new Map<
    number,
    { id: number; type: "normal" | "popup"; incognito: boolean }
  >([[1, { id: 1, type: "normal", incognito: false }]]);
  const groups = new Map<number, FakeGroup>();
  let nextTabId = 100;
  let nextGroupId = 500;
  let nextWindowId = 2;
  /** Tabs the debugger is attached to, as Chrome sees it */
  const attached = new Set<number>();

  const onTabUpdated = fakeBrowser.tabs.onUpdated;
  const toTab = (tab: FakeTab) => ({ ...tab }) as unknown as Browser.tabs.Tab;

  const debuggerEvents = {
    onEvent:
      fakeEvent<
        (
          source: Browser.debugger.DebuggerSession,
          method: string,
          params?: object,
        ) => void
      >(),
    onDetach:
      fakeEvent<(source: Browser.debugger.Debuggee, reason: string) => void>(),
  };
  const tabGroupsOnRemoved =
    fakeEvent<(group: Browser.tabGroups.TabGroup) => void>();

  async function setGroup(tabId: number, groupId: number) {
    const tab = tabs.get(tabId)!;
    const previous = tab.groupId;
    tab.groupId = groupId;
    if (groupId !== -1) {
      tab.pinned = false;
      tab.windowId = groups.get(groupId)!.windowId;
    }
    await onTabUpdated.trigger(tabId, { groupId }, toTab(tab));
    if (
      previous !== -1 &&
      ![...tabs.values()].some((other) => other.groupId === previous)
    ) {
      const group = groups.get(previous);
      groups.delete(previous);
      await tabGroupsOnRemoved.trigger(
        group as unknown as Browser.tabGroups.TabGroup,
      );
    }
  }

  const sendCommand = vi.fn(
    async (
      target: Browser.debugger.DebuggerSession,
      method: string,
      _params?: Record<string, unknown>,
    ): Promise<object | undefined> => {
      if (!attached.has(target.tabId!)) {
        throw new Error("Debugger is not attached to the tab");
      }
      if (method === "Target.getTargetInfo") {
        return {
          targetInfo: { targetId: `target-${target.tabId}`, type: "page" },
        };
      }
      return {};
    },
  );
  const attach = vi.fn(async ({ tabId }: Browser.debugger.Debuggee) => {
    if (attached.has(tabId!)) {
      throw new Error("Another debugger is already attached");
    }
    attached.add(tabId!);
  });
  const detach = vi.fn(async ({ tabId }: Browser.debugger.Debuggee) => {
    if (!attached.delete(tabId!)) {
      throw new Error("Debugger is not attached");
    }
  });

  Object.assign(fakeBrowser.runtime, {
    getManifest: () => ({ version: "2.0.0", manifest_version: 3 }),
  });
  Object.assign(fakeBrowser.extension, {
    isAllowedFileSchemeAccess: async () => false,
  });
  Object.assign(fakeBrowser.debugger, {
    attach,
    detach,
    sendCommand,
    getTargets: async () =>
      [...tabs.values()].map((tab) => ({
        id: `target-${tab.id}`,
        tabId: tab.id,
        attached: attached.has(tab.id),
        type: "page",
        title: tab.title,
        url: tab.url,
      })),
    ...debuggerEvents,
  });
  Object.assign(fakeBrowser.webNavigation, {
    getAllFrames: async () => [],
  });
  Object.assign(fakeBrowser.tabGroups, {
    get: async (groupId: number) => {
      const group = groups.get(groupId);
      if (!group) {
        throw new Error(`No group with id: ${groupId}.`);
      }
      return { ...group };
    },
    update: async (groupId: number, update: Partial<FakeGroup>) => {
      Object.assign(groups.get(groupId)!, update);
      return groups.get(groupId);
    },
    onRemoved: tabGroupsOnRemoved,
  });
  Object.assign(fakeBrowser.tabs, {
    onReplaced: fakeEvent(),
    onAttached: fakeEvent(),
    onDetached: fakeEvent(),
    query: async (query: Browser.tabs.QueryInfo) =>
      [...tabs.values()]
        .filter(
          (tab) =>
            (query.active === undefined || tab.active === query.active) &&
            (query.windowType === undefined ||
              windows.get(tab.windowId)?.type === query.windowType),
        )
        .map(toTab),
    get: async (tabId: number) => {
      const tab = tabs.get(tabId);
      if (!tab) {
        throw new Error(`No tab with id: ${tabId}.`);
      }
      return toTab(tab);
    },
    create: async ({
      url,
      windowId,
      active,
    }: Browser.tabs.CreateProperties) => {
      const tab = addTab({ url, windowId, active: active ?? true });
      await fakeBrowser.tabs.onCreated.trigger(toTab(tab));
      return toTab(tab);
    },
    update: async (tabId: number, update: Partial<FakeTab>) => {
      const tab = tabs.get(tabId)!;
      Object.assign(tab, update);
      await onTabUpdated.trigger(tabId, update, toTab(tab));
      return toTab(tab);
    },
    remove: async (tabId: number) => {
      tabs.delete(tabId);
      await fakeBrowser.tabs.onRemoved.trigger(tabId, {
        windowId: 1,
        isWindowClosing: false,
      });
    },
    move: async (tabId: number, { windowId }: { windowId: number }) => {
      if (windows.get(tabs.get(tabId)!.windowId)?.type !== "normal") {
        throw new Error("Tabs can only be moved to and from normal windows.");
      }
      tabs.get(tabId)!.windowId = windowId;
      return toTab(tabs.get(tabId)!);
    },
    group: async ({
      tabIds,
      groupId,
      createProperties,
    }: {
      tabIds: number[];
      groupId?: number;
      createProperties?: { windowId?: number };
    }) => {
      let id = groupId;
      if (id === undefined) {
        id = nextGroupId++;
        groups.set(id, {
          id,
          windowId: createProperties?.windowId ?? tabs.get(tabIds[0])!.windowId,
        });
      }
      for (const tabId of tabIds) {
        await setGroup(tabId, id);
      }
      return id;
    },
    ungroup: async (tabIds: number | number[]) => {
      for (const tabId of [tabIds].flat()) {
        await setGroup(tabId, -1);
      }
    },
  });
  Object.assign(fakeBrowser.windows, {
    get: async (windowId: number) => windows.get(windowId),
    getAll: async () => [...windows.values()],
    getLastFocused: async () => windows.get(1),
    update: async (windowId: number) => windows.get(windowId),
    create: async ({ tabId }: { tabId?: number }) => {
      const window = {
        id: nextWindowId++,
        type: "normal" as const,
        incognito: false,
      };
      windows.set(window.id, window);
      if (tabId !== undefined) {
        tabs.get(tabId)!.windowId = window.id;
      }
      return window;
    },
  });

  function addTab(tab: Partial<FakeTab> = {}): FakeTab {
    const created: FakeTab = {
      id: tab.id ?? nextTabId++,
      windowId: tab.windowId ?? 1,
      url: tab.url ?? "https://example.com/",
      title: tab.title ?? "Example",
      active: tab.active ?? false,
      pinned: tab.pinned ?? false,
      incognito: tab.incognito ?? false,
      discarded: tab.discarded ?? false,
      groupId: tab.groupId ?? -1,
      ...(tab.pendingUrl !== undefined && { pendingUrl: tab.pendingUrl }),
      ...(tab.openerTabId !== undefined && { openerTabId: tab.openerTabId }),
    };
    tabs.set(created.id, created);
    return created;
  }

  return {
    tabs,
    groups,
    windows,
    attached,
    debugger: { attach, detach, sendCommand, ...debuggerEvents },
    addTab,
    addPopupWindow() {
      const window = {
        id: nextWindowId++,
        type: "popup" as const,
        incognito: false,
      };
      windows.set(window.id, window);
      return window.id;
    },
    /** The user drags a tab into a group, or out of any group with `-1` */
    dragTab: (tabId: number, groupId: number) => setGroup(tabId, groupId),
    /** The user (or a page) changes a tab */
    updateTab: async (tabId: number, update: Partial<FakeTab>) => {
      const tab = tabs.get(tabId)!;
      Object.assign(tab, update);
      await onTabUpdated.trigger(tabId, update, toTab(tab));
    },
  };
}

export type FakeChrome = ReturnType<typeof installFakeChrome>;
