import { browser } from "wxt/browser";

import { TAB_GROUP_HEX, type TabGroupColor } from "../types";

/** The badge's color for "?" and "!", which ask the user to do something */
const ATTENTION_COLOR = "#f9ab00";

export type BadgeState = {
  /** A daemon waits for **Allow** */
  pairingPending: boolean;
  /** A 0.1.x server answers on the legacy port */
  legacyServer: boolean;
  /** How many tabs the debugger is attached to */
  attachedCount: number;
  /** The color of the app that acted last */
  color: TabGroupColor | null;
};

export function getBadge(state: BadgeState): { text: string; color: string } {
  if (state.pairingPending) {
    return { text: "?", color: ATTENTION_COLOR };
  }
  if (state.legacyServer) {
    return { text: "!", color: ATTENTION_COLOR };
  }
  return {
    text: state.attachedCount > 0 ? String(state.attachedCount) : "",
    color: TAB_GROUP_HEX[state.color ?? "grey"],
  };
}

/** Shows on the toolbar icon how many tabs agents are using, in the color of the app that acted last, or "?" (Allow) or "!" (an old server) */
export async function updateBadge(state: BadgeState): Promise<void> {
  const { text, color } = getBadge(state);
  await Promise.all([
    browser.action.setBadgeText({ text }),
    browser.action.setBadgeBackgroundColor({ color }),
  ]);
}
