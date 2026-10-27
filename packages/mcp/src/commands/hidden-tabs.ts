/**
 * How the engine copes with hidden tabs, following the hidden-tab spike (`spikes/hidden-tabs/RESULTS.md`).
 *
 * Agents' tabs are background tabs, which Chrome treats as hidden: rendering stops (no `requestAnimationFrame`, IntersectionObserver or lazy loading), timers are throttled, mouse input sent over CDP hangs and lands later as a phantom click, and screenshots come back blank or stale. `Emulation.setFocusEmulationEnabled` makes the tab render as if it were in front, without taking the user's focus, so the engine turns it on when it claims a tab, on the engine's own CDP session (through the bridge it reaches the tab's `chrome.debugger` attachment, so it lasts until the debugger detaches). Before input and screenshots it checks that the tab is visible, turns emulation on again if it isn't, and fails rather than send input to a hidden tab. Tests force the hidden path with `hiddenTabs.forceHidden`.
 */
import type { CDPSession, Page } from "playwright-core";

import { sleep, StepError } from "@/commands/output";

/** The engine's CDP session on each claimed page, which turns focus emulation on */
const sessions = new WeakMap<Page, CDPSession>();

export const HIDDEN_TAB_MESSAGE =
  "Chrome isn't rendering this background tab, so it can't take clicks, keys or screenshots. Read it with `snapshot` or `get text`, or ask the user to switch to the tab";

export const hiddenTabs = {
  /** Tests set this to make tabs look hidden whatever emulation does */
  forceHidden: false,

  /** Run when the engine first uses a claimed tab (each time it's claimed) */
  async onClaim(page: Page, cdp: CDPSession | null): Promise<void> {
    if (cdp) sessions.set(page, cdp);
    await this.emulateFocus(page);
  },

  /** Before the tab is released. Detaching the debugger ends emulation anyway; this covers a tab that stays attached */
  async onRelease(cdp: CDPSession | null): Promise<void> {
    await cdp
      ?.send("Emulation.setFocusEmulationEnabled", { enabled: false })
      .catch(() => {});
  },

  async emulateFocus(page: Page): Promise<void> {
    await sessions
      .get(page)
      ?.send("Emulation.setFocusEmulationEnabled", { enabled: true })
      .catch(() => {});
  },

  /** `document.visibilityState`, which a hidden tab still answers */
  async isVisible(page: Page): Promise<boolean> {
    if (this.forceHidden) return false;
    return await page
      .evaluate(() => document.visibilityState === "visible")
      .catch(() => true);
  },

  /** Before mouse or keyboard input and screenshots: turns emulation on again if the tab is hidden (e.g. another debugger turned it off), and fails if it stays hidden */
  async ensureVisible(page: Page): Promise<void> {
    if (await this.isVisible(page)) return;
    await this.emulateFocus(page);
    for (let i = 0; i < 10; i++) {
      if (await this.isVisible(page)) return;
      await sleep(50);
    }
    throw new StepError(HIDDEN_TAB_MESSAGE);
  },

  /** How long a screenshot may take */
  screenshotTimeoutMs: 5000,
};
