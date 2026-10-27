/**
 * A `BrowserBackend` over a plainly launched headless Chromium, for the engine's tests and the eval: no extension and no relay. Playwright connects over CDP (as the daemon does through the relay), tabs get synthetic IDs, and groups, sharing and pausing are recorded in memory and set by the test.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type Browser,
  type BrowserContext,
  type CDPSession,
  chromium,
  type Page,
} from "playwright-core";

import type {
  AppInfo,
  BackendEvents,
  BrowserBackend,
  ExposedTab,
} from "@/contracts";

type Tab = {
  page: Page;
  title: string;
  appId?: string;
  pinned: boolean;
};

export type LaunchOptions = {
  /** Browser zoom for every page, e.g. 1.25 (Chrome's default zoom preference) */
  zoom?: number;
};

export class LaunchedBackend implements BrowserBackend {
  connected = true;
  paused = false;
  /** What `unavailableReason()` returns; tests set it */
  unavailable: string | null = null;
  readonly claimed = new Set<number>();
  readonly activity: string[] = [];
  private tabsById = new Map<number, Tab>();
  private nextTabId = 1;
  private listeners = new Map<string, Set<(data: unknown) => void>>();
  /** Pages the backend opened itself, so `context.on("page")` only reports pages that pages opened */
  private expecting = 0;

  private constructor(
    private process: ChildProcess,
    private browser: Browser,
    private context: BrowserContext,
    private userDataDir: string,
  ) {
    context.on("page", async (page) => {
      if (this.expecting > 0) return;
      const tabId = this.add(page);
      const openerPage = await page.opener();
      const opener = [...this.tabsById].find(
        ([, tab]) => tab.page === openerPage,
      )?.[0];
      this.emit("tabOpened", {
        tabId,
        openerTabId: opener ?? -1,
        url: page.url(),
      });
    });
  }

  static async launch(options: LaunchOptions = {}): Promise<LaunchedBackend> {
    const userDataDir = mkdtempSync(path.join(tmpdir(), "browsermcp-test-"));
    if (options.zoom) {
      mkdirSync(path.join(userDataDir, "Default"));
      writeFileSync(
        path.join(userDataDir, "Default", "Preferences"),
        JSON.stringify({
          partition: {
            default_zoom_level: { x: Math.log(options.zoom) / Math.log(1.2) },
          },
        }),
      );
    }
    const child = spawn(chromium.executablePath(), [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${userDataDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--no-proxy-server",
      "--window-size=1280,800",
      "about:blank",
    ]);
    const wsEndpoint = await new Promise<string>((resolve, reject) => {
      let output = "";
      const timer = setTimeout(
        () => reject(new Error(`Chromium didn't start: ${output}`)),
        20_000,
      );
      child.stderr?.on("data", (data: Buffer) => {
        output += data.toString();
        const match = /DevTools listening on (ws:\S+)/.exec(output);
        if (match) {
          clearTimeout(timer);
          resolve(match[1]);
        }
      });
      child.on("exit", () => reject(new Error(`Chromium exited: ${output}`)));
    });
    const browser = await chromium.connectOverCDP(wsEndpoint);
    const context = browser.contexts()[0];
    const backend = new LaunchedBackend(child, browser, context, userDataDir);
    for (const page of context.pages()) backend.add(page);
    return backend;
  }

  private add(page: Page): number {
    const tabId = this.nextTabId++;
    const tab: Tab = { page, title: "", pinned: false };
    this.tabsById.set(tabId, tab);
    const refreshTitle = () => {
      page.title().then(
        (title) => (tab.title = title),
        () => {},
      );
    };
    page.on("domcontentloaded", refreshTitle);
    page.on("load", refreshTitle);
    page.on("close", () => {
      this.tabsById.delete(tabId);
      if (this.claimed.delete(tabId)) {
        this.emit("released", { tabId, reason: "closed" });
      }
      this.emitState();
    });
    return tabId;
  }

  // --- Test controls ---

  /** Opens a tab as the user would (not in any group) */
  async openUserTab(url: string): Promise<number> {
    this.expecting++;
    try {
      const page = await this.context.newPage();
      const tabId = this.add(page);
      await page.goto(url);
      this.tab(tabId).title = await page.title();
      return tabId;
    } finally {
      this.expecting--;
    }
  }

  /** The user drags a tab into an app's group (or out with `null`) */
  assign(tabId: number, appId: string | null) {
    this.tab(tabId).appId = appId ?? undefined;
    this.emit("tabAssigned", { tabId, appId });
  }

  setPaused(paused: boolean) {
    this.paused = paused;
    if (paused) {
      for (const tabId of this.claimed) {
        this.claimed.delete(tabId);
        this.emit("released", { tabId, reason: "paused" });
      }
    }
    this.emitState();
  }

  pageOf(tabId: number): Page {
    return this.tab(tabId).page;
  }

  appOf(tabId: number): string | undefined {
    return this.tabsById.get(tabId)?.appId;
  }

  async close() {
    await this.browser.close().catch(() => {});
    if (this.process.exitCode === null) {
      const exited = new Promise((resolve) =>
        this.process.once("exit", resolve),
      );
      this.process.kill();
      await exited;
    }
    rmSync(this.userDataDir, { recursive: true, force: true, maxRetries: 5 });
  }

  // --- BrowserBackend ---

  unavailableReason() {
    return this.unavailable;
  }

  tabs(): ExposedTab[] {
    return [...this.tabsById].map(([tabId, tab]) => ({
      tabId,
      windowId: 1,
      url: tab.page.url(),
      title: tab.title,
      active: false,
      pinned: tab.pinned,
      appId: tab.appId,
      attached: this.claimed.has(tabId),
    }));
  }

  async createTab({ url, app }: { url?: string; app: AppInfo }) {
    this.expecting++;
    try {
      const page = await this.context.newPage();
      const tabId = this.add(page);
      this.tab(tabId).appId = app.id;
      if (url) await page.goto(url, { waitUntil: "commit" });
      this.emitState();
      return tabId;
    } finally {
      this.expecting--;
    }
  }

  async closeTab(tabId: number) {
    await this.tabsById.get(tabId)?.page.close();
  }

  async activateTab(tabId: number) {
    await this.tab(tabId).page.bringToFront();
  }

  async groupTab(tabId: number, app: AppInfo | null) {
    this.tab(tabId).appId = app?.id;
  }

  noteActivity(appId: string) {
    this.activity.push(appId);
  }

  async page(tabId: number): Promise<Page> {
    const tab = this.tab(tabId);
    this.claimed.add(tabId);
    return tab.page;
  }

  async cdpSession(tabId: number): Promise<CDPSession> {
    return this.context.newCDPSession(this.tab(tabId).page);
  }

  async release(tabId: number) {
    this.claimed.delete(tabId);
  }

  isClaimed(tabId: number) {
    return this.claimed.has(tabId);
  }

  on<E extends keyof BackendEvents>(
    event: E,
    listener: (data: BackendEvents[E]) => void,
  ) {
    const set = this.listeners.get(event) ?? new Set();
    set.add(listener as (data: unknown) => void);
    this.listeners.set(event, set);
    return () => set.delete(listener as (data: unknown) => void);
  }

  private emit<E extends keyof BackendEvents>(
    event: E,
    data: BackendEvents[E],
  ) {
    for (const listener of this.listeners.get(event) ?? []) listener(data);
  }

  private emitState() {
    this.emit("state", {
      tabs: this.tabs(),
      paused: this.paused,
      pairing: "paired",
    });
  }

  private tab(tabId: number): Tab {
    const tab = this.tabsById.get(tabId);
    if (!tab) throw new Error(`No tab ${tabId}`);
    return tab;
  }
}
