import { browser } from "wxt/browser";

import {
  agentTabsItem,
  defaultGrantMinutesItem,
  restrictTabsItem,
  tabGrantsItem,
} from "../storage";

/** The tabs the user enabled that still are, by tab ID, with when they stop being (ms since the epoch) */
export async function getActiveGrants(
  now = Date.now(),
): Promise<Map<number, number>> {
  const grants = await tabGrantsItem.getValue();
  return new Map(
    Object.entries(grants)
      .filter(([, expiresAt]) => expiresAt > now)
      .map(([tabId, expiresAt]) => [Number(tabId), expiresAt]),
  );
}

/**
 * The tabs agents may use, or `null` when they may use every tab. When restricted: the tabs the user enabled and the tabs agents opened
 */
export async function getAllowedTabIds(): Promise<ReadonlySet<number> | null> {
  if (!(await restrictTabsItem.getValue())) {
    return null;
  }
  const [grants, agentTabs] = await Promise.all([
    getActiveGrants(),
    agentTabsItem.getValue(),
  ]);
  return new Set([...grants.keys(), ...agentTabs]);
}

/** Enables the tab for the default time. Returns when it stops being enabled */
export async function grantTab(tabId: number): Promise<number> {
  if (!(await browser.tabs.get(tabId).catch(() => null))) {
    throw new Error(`Tab ${tabId} doesn't exist`);
  }
  const minutes = await defaultGrantMinutesItem.getValue();
  const expiresAt = Date.now() + minutes * 60_000;
  const grants = await getActiveGrants();
  grants.set(tabId, expiresAt);
  await tabGrantsItem.setValue(toRecord(grants));
  return expiresAt;
}

/** Stops the tab being enabled, and forgets the ones that already stopped */
export async function revokeTab(tabId: number): Promise<void> {
  const grants = await getActiveGrants();
  grants.delete(tabId);
  await tabGrantsItem.setValue(toRecord(grants));
}

/** Forgets a tab that closed */
export async function forgetTabAccess(tabId: number): Promise<void> {
  await revokeTab(tabId);
  const agentTabs = await agentTabsItem.getValue();
  if (agentTabs.includes(tabId)) {
    await agentTabsItem.setValue(agentTabs.filter((id) => id !== tabId));
  }
}

/** Records a tab an agent opened */
export async function markAgentTab(tabId: number): Promise<void> {
  const agentTabs = await agentTabsItem.getValue();
  if (!agentTabs.includes(tabId)) {
    await agentTabsItem.setValue([...agentTabs, tabId]);
  }
}

/** A tab that a usable tab opened is as usable as its opener: for as long as the user enabled the opener, or for good when an agent opened it */
export async function inheritAccess(
  openerTabId: number,
  tabId: number,
): Promise<void> {
  const grants = await getActiveGrants();
  const expiresAt = grants.get(openerTabId);
  if (expiresAt !== undefined) {
    grants.set(tabId, expiresAt);
    await tabGrantsItem.setValue(toRecord(grants));
  } else if ((await agentTabsItem.getValue()).includes(openerTabId)) {
    await markAgentTab(tabId);
  }
}

function toRecord(grants: Map<number, number>): Record<string, number> {
  return Object.fromEntries(
    [...grants].map(([tabId, expiresAt]) => [String(tabId), expiresAt]),
  );
}
