import {
  type Browser,
  type BrowserContext,
  chromium,
  type Page,
} from "playwright-core";

import type { ExposedTab } from "@browsermcp/protocol";

import { CdpBridge } from "@/relay/bridge";
import type { ExtensionConnection } from "@/relay/extension-connection";
import type { Logger } from "@/utils/log";

export type BrowserSlotOptions = {
  log: Logger;
  /** Where Playwright connects for this browser: the relay's `/cdp?token=…&browser=<id>`, known once the relay listens */
  cdpUrl: () => string | null;
  /** A claimed tab of this browser went away by something other than `release()` (its Chrome tab ID) */
  onReleased(tabId: number, reason: string): void;
  reattachDelayMs?: number;
  /** How long `waitForPage()` waits for Playwright to see a claimed tab */
  pageTimeoutMs?: number;
};

/**
 * One browser (profile) and everything the daemon keeps for it: its extension connection while it's connected, its own CDP bridge, its own Playwright `connectOverCDP` (to `/cdp?browser=<id>`) and the Pages found there, and the tabs agents used in it. Tab IDs here are Chrome's, which mean something only within this browser.
 *
 * A bridge serves exactly one browser: its state is keyed by `chrome.debugger` tab IDs, `Browser.getVersion` answers for one browser, and browser-level CDP commands go through one of its claimed tabs, with nothing at the CDP root to say which browser was meant. So each browser gets a bridge, a Playwright `Browser` and a page map of its own.
 *
 * The slot outlives its connection: a browser that reconnects (its service worker restarted) gets its connection back here, keeping its tabs.
 */
export class BrowserSlot {
  readonly bridge: CdpBridge;
  /** The browser's extension connection, or null while it's away */
  connection: ExtensionConnection | null = null;
  /** The connection has sent `state` since `hello` (whose state is always `pending`, before the daemon proves its key) */
  stateReceived = false;

  // --- Identity: what tells this browser apart from others when it reconnects ---

  /** `hello.browserId`, from extensions that send one (2.3 on) */
  browserId: string | undefined;
  /** Without a `browserId`: the windows it reported last (window IDs are unique within a browser process, across its profiles), with its `BrowserInfo` name and user agent */
  windowIds = new Set<number>();
  /** A connection without a `browserId` was taken for this browser before it reported any windows: its first paired `state` confirms it, or moves it to another slot */
  unconfirmed = false;
  /** The label the user gave it (`state.label`), kept while it's away */
  userLabel: string | undefined;
  lastFocusedAt: number | undefined;
  connectedAt = 0;
  /** When it last disconnected, so calls wait briefly for it to come back */
  disconnectedAt = 0;
  /** Its tabs' public IDs (the backend's), by Chrome tab ID */
  readonly publicIds = new Map<number, number>();
  /** Its tabs' URLs when it last disconnected, by Chrome tab ID: on its return, a tab with another URL is taken for another tab (Chrome restarted and numbers its tabs anew) */
  urlsWhenLeft = new Map<number, string>();
  /** Chrome tab IDs it had public IDs for when it reconnected, until a paired state shows whether they still name the same tabs (`urlsWhenLeft`) */
  unverified = new Set<number>();

  private browserPromise: Promise<Browser> | null = null;
  private pages = new Map<string, Page>();
  private pageWaiters = new Map<string, Set<(page: Page) => void>>();

  constructor(
    readonly id: string,
    /** `BrowserInfo.name`, e.g. `Chrome` */
    readonly name: string,
    readonly userAgent: string,
    /** The daemon's name for it when the user gave none: `Chrome`, `Chrome 2`… */
    readonly defaultLabel: string,
    private readonly options: BrowserSlotOptions,
  ) {
    this.bridge = new CdpBridge({
      log: options.log,
      extension: () => this.connection,
      onReleased: options.onReleased,
      reattachDelayMs: options.reattachDelayMs,
    });
  }

  /** The tabs the extension reports (none while it's away) */
  tabs(): ExposedTab[] {
    return this.connection?.state.tabs ?? [];
  }

  /** What agents call it: the user's label, else the daemon's. While its connection is a guess (`unconfirmed`), just its browser's name, since it may be another browser */
  get label(): string {
    return this.unconfirmed ? this.name : (this.userLabel ?? this.defaultLabel);
  }

  /** Connected, paired and not paused: agents can use it */
  get usable(): boolean {
    const state = this.connection?.state;
    return !!state && state.pairing === "paired" && !state.paused;
  }

  /** Whether a connection's `hello` and windows could be this browser's: `undefined` when the windows can't tell (either side knows none) */
  matches(name: string, userAgent: string, windowIds: Set<number>) {
    if (name !== this.name || userAgent !== this.userAgent) {
      return false;
    }
    if (windowIds.size === 0 || this.windowIds.size === 0) {
      return undefined;
    }
    return [...windowIds].some((id) => this.windowIds.has(id));
  }

  /** Playwright connected to this browser's bridge, connecting on first use */
  browser(): Promise<Browser> {
    if (!this.browserPromise) {
      const url = this.options.cdpUrl();
      if (!url) {
        return Promise.reject(new Error("The relay isn't listening yet"));
      }
      // `noDefaults`: Playwright's default overrides (focus emulation, media emulation, downloads) stay off the user's tabs; the engine turns focus emulation on itself for the tabs it claims (`hiddenTabs`)
      const promise = chromium
        .connectOverCDP(url, { noDefaults: true })
        .then((browser) => {
          browser.on("disconnected", () => {
            if (this.browserPromise === promise) {
              this.browserPromise = null;
            }
            this.pages.clear();
          });
          for (const context of browser.contexts()) {
            this.watchContext(context);
          }
          return browser;
        });
      promise.catch(() => {
        if (this.browserPromise === promise) {
          this.browserPromise = null;
        }
      });
      this.browserPromise = promise;
    }
    return this.browserPromise;
  }

  /** The Page of a target once Playwright has it, or `null` if the target goes away first (`gone`) */
  waitForPage(
    targetId: string,
    gone: Promise<void> = new Promise(() => {}),
  ): Promise<Page | null> {
    const page = this.pages.get(targetId);
    if (page && !page.isClosed()) {
      return Promise.resolve(page);
    }
    return new Promise((resolve, reject) => {
      const waiters = this.pageWaiters.get(targetId) ?? new Set();
      this.pageWaiters.set(targetId, waiters);
      let settled = false;
      const settle = () => {
        settled = true;
        clearTimeout(timeout);
        waiters.delete(waiter);
        if (waiters.size === 0 && this.pageWaiters.get(targetId) === waiters) {
          this.pageWaiters.delete(targetId);
        }
      };
      const waiter = (page: Page) => {
        settle();
        resolve(page);
      };
      const timeout = setTimeout(() => {
        settle();
        reject(new Error("The tab didn't become ready in time"));
      }, this.options.pageTimeoutMs ?? 15_000);
      void gone.then(() => {
        if (!settled) {
          settle();
          resolve(null);
        }
      });
      waiters.add(waiter);
    });
  }

  /** Disconnects Playwright from this browser. The backend closes the extension connection */
  async close(): Promise<void> {
    const browser = await this.browserPromise?.catch(() => null);
    this.browserPromise = null;
    await browser?.close().catch(() => {});
    this.pages.clear();
  }

  private watchContext(context: BrowserContext) {
    context.on("page", (page) => void this.identify(page));
    for (const page of context.pages()) {
      void this.identify(page);
    }
  }

  /** Reads a new Page's target ID (the bridge answers `Target.getTargetInfo` itself) */
  private async identify(page: Page) {
    let targetId: string;
    try {
      const session = await page.context().newCDPSession(page);
      const { targetInfo } = await session.send("Target.getTargetInfo");
      targetId = targetInfo.targetId;
      await session.detach().catch(() => {});
    } catch (error) {
      if (!page.isClosed()) {
        this.options.log("Couldn't identify a page:", error);
      }
      return;
    }
    if (page.isClosed()) {
      return;
    }
    this.pages.set(targetId, page);
    page.on("close", () => {
      if (this.pages.get(targetId) === page) {
        this.pages.delete(targetId);
      }
    });
    for (const resolve of this.pageWaiters.get(targetId) ?? []) {
      resolve(page);
    }
    this.pageWaiters.delete(targetId);
  }
}
