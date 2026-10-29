/**
 * The command engine behind the `browser` tool: sessions (one per AI app's thin process), which tab each uses, and running a call's command lines in order with the `browser` tool's output policy (one `✓` line per action, read output inline, `✗ step N` on the first error, a `Page:` trailer). Every line is parsed before the first one runs, so a call with a bad line runs none of its steps.
 */
import type {
  CallToolResult,
  ImageContent,
  TextContent,
} from "@modelcontextprotocol/sdk/types.js";
import type { Dialog } from "playwright-core";

import { waitForLoad } from "@/commands/actions";
import { cleanupCdp, newCdpState } from "@/commands/cdp";
import {
  availableCommands,
  type CommandDef,
  COMMANDS_BY_NAME,
  type StepContext,
  TIMEOUT_MAX_MS,
} from "@/commands/commands";
import { hiddenTabs } from "@/commands/hidden-tabs";
import { INSTRUCTIONS } from "@/commands/instructions";
import {
  errorMessage,
  MAX_IMAGES,
  RESPONSE_CAP,
  sleep,
  StepError,
} from "@/commands/output";
import {
  type CommandLine,
  commandName,
  parseArgs,
  type ParsedArgs,
  parseCommands,
  ParseError,
  type Token,
  tokenize,
} from "@/commands/parser";
import { TabState } from "@/commands/tab-state";
import type {
  BrowserBackend,
  CommandEngine,
  CreateCommandEngine,
  SessionInfo,
} from "@/contracts";
import { browserTool } from "@/tools/browser";

const DEFAULT_IDLE_RELEASE_MS = 10 * 60_000;

export const PAUSED_MESSAGE =
  "The user paused Browser MCP. Ask them to click Resume in its popup";
const NO_TAB_MESSAGE =
  "There's no tab yet: use `goto <url>`, or `tab list` and `tab select <id>` to use one of the user's tabs";

/** How long a step may run before it's abandoned and its tab freed: `--timeout` (or the command's own time) plus headroom, and at least `defaultMs`. Tests lower them */
export const stepLimits = { defaultMs: 30_000, headroomMs: 5_000 };
/** Room kept in the response for status lines, the trailer and notices */
const STATUS_RESERVE = 2_000;
/** Echoed command lines are cut to this */
const ECHO_MAX = 300;

type Session = SessionInfo & {
  /** The tab commands act on */
  current: number | null;
  /** A tab the user dragged into the app's group, taken at the start of the session's next call */
  pending: number | null;
  /** Tabs the session uses */
  tabs: Set<number>;
  /** Tabs the session (or its pages) opened, which `tab close` may close */
  opened: Set<number>;
  lastCall: number;
  /** Tabs pages opened during the running step, noted on its line */
  openedTabs: { tabId: number; url: string }[];
};

export const createCommandEngine: CreateCommandEngine = ({
  backend,
  idleReleaseMs = DEFAULT_IDLE_RELEASE_MS,
  log = () => {},
}) => new Engine(backend, idleReleaseMs, log);

class Engine implements CommandEngine {
  private sessions = new Map<string, Session>();
  private states = new Map<number, TabState>();
  /** Calls in flight per session (`session:<id>`, held for the whole call) and per tab (`tab:<id>`, held while a call's steps act on that tab) */
  private locks = new Map<string, Promise<unknown>>();
  private inFlight = 0;
  private idleTimer: NodeJS.Timeout;

  constructor(
    private backend: BrowserBackend,
    private idleReleaseMs: number,
    private log: (...args: unknown[]) => void,
  ) {
    backend.on("released", ({ tabId }) => {
      this.dropState(tabId);
      this.pruneClosedTabs();
    });
    backend.on("state", () => this.pruneClosedTabs());
    backend.on("tabOpened", ({ tabId, openerTabId, url }) => {
      const owner =
        [...this.sessions.values()].find((s) => s.current === openerTabId) ??
        [...this.sessions.values()].find((s) => s.tabs.has(openerTabId));
      if (!owner) return;
      owner.tabs.add(tabId);
      owner.opened.add(tabId);
      void this.backend.groupTab(tabId, owner.app).catch(() => {});
      owner.openedTabs.push({ tabId, url });
    });
    backend.on("tabAssigned", ({ tabId, appId }) => {
      if (appId) {
        // Taken at the start of the session's next call, never mid-batch
        const session = this.mostRecent((s) => s.app.id === appId);
        if (session) session.pending = tabId;
        return;
      }
      for (const session of this.sessions.values()) {
        if (session.pending === tabId) session.pending = null;
        this.forget(session, tabId);
      }
      if (!this.inUse(tabId)) void this.releaseTab(tabId);
    });
    this.idleTimer = setInterval(
      () => void this.releaseIdle(),
      Math.max(50, Math.min(60_000, idleReleaseMs / 4)),
    );
    this.idleTimer.unref();
  }

  tools(sessionId: string) {
    return [browserTool(this.sessions.get(sessionId)?.capabilities ?? [])];
  }

  instructions() {
    return INSTRUCTIONS;
  }

  openSession(info: SessionInfo) {
    this.sessions.set(info.id, {
      ...info,
      current: null,
      pending: null,
      tabs: new Set(),
      opened: new Set(),
      lastCall: Date.now(),
      openedTabs: [],
    });
  }

  async closeSession(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    for (const tabId of session.tabs) {
      if (!this.inUse(tabId)) await this.releaseTab(tabId);
    }
  }

  busy() {
    return this.inFlight > 0;
  }

  /** Stops the idle timer (tests) */
  dispose() {
    clearInterval(this.idleTimer);
  }

  async callTool(
    sessionId: string,
    name: string,
    args: Record<string, unknown> | undefined,
  ): Promise<CallToolResult> {
    const session = this.sessions.get(sessionId);
    if (!session) return errorResult(`Unknown session ${sessionId}`);
    if (name !== "browser") return errorResult(`Unknown tool ${name}`);
    const input = args?.commands;
    if (
      typeof input !== "string" &&
      !(Array.isArray(input) && input.every((line) => typeof line === "string"))
    ) {
      return errorResult(
        'commands is a string of command lines, e.g. "goto https://example.com\\nsnapshot -i"',
      );
    }
    const parsed = parseCommands(input);
    if (!parsed.length) return errorResult("No commands. Run `help`");
    // A typo on a later line would otherwise surface only after the earlier steps clicked and typed, leaving the page half-changed
    const checked = parsed.map((line) => checkLine(line, session.capabilities));
    const invalid = checked.filter((line) => typeof line === "string");
    if (invalid.length) {
      return errorResult(
        [
          ...invalid,
          `Nothing ran: fix ${invalid.length > 1 ? "these lines" : "this line"} and send the call again`,
        ].join("\n"),
      );
    }
    const lines = checked as CheckedLine[];
    this.inFlight++;
    session.lastCall = Date.now();
    // A session's calls run one at a time; each step holds its tab's lock (`lockTab`), so calls on a tab from any session don't interleave
    const releaseSession = await this.acquire(`session:${session.id}`);
    const tabLock: TabLock = { tabId: null, release: null };
    try {
      return await this.run(session, lines, tabLock);
    } finally {
      tabLock.release?.();
      releaseSession();
      this.inFlight--;
    }
  }

  /** Waits for the lock and returns its release */
  private async acquire(key: string): Promise<() => void> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((resolve) => (release = resolve));
    const chained = previous.then(() => mine);
    this.locks.set(key, chained);
    await previous;
    return () => {
      release();
      if (this.locks.get(key) === chained) this.locks.delete(key);
    };
  }

  /** Holds the lock of the session's current tab (and only it), moving it when a step changed tabs */
  private async lockTab(session: Session, lock: TabLock) {
    for (;;) {
      const tabId = this.currentTab(session);
      if (tabId === lock.tabId) return;
      lock.release?.();
      lock.release = null;
      lock.tabId = tabId;
      if (tabId === null) return;
      lock.release = await this.acquire(`tab:${tabId}`);
      // The tab may have closed while this call waited
      if (this.currentTab(session) === tabId) return;
    }
  }

  private async run(
    session: Session,
    lines: CheckedLine[],
    tabLock: TabLock,
  ): Promise<CallToolResult> {
    // A tab the user dragged in since the last call
    this.takePending(session);
    const onlyHelp = lines.every((line) => line.def.name === "help");
    if (!onlyHelp) {
      await this.backend.whenReady?.();
      const unavailable = this.backend.unavailableReason();
      if (unavailable) return errorResult(unavailable);
      if (this.backend.paused) return errorResult(PAUSED_MESSAGE);
      this.backend.noteActivity(session.app.id);
    }
    session.openedTabs = [];
    const out: string[] = [];
    const images: ImageContent[] = [];
    await this.lockTab(session, tabLock);
    const start = await this.pageInfo(session);
    let failed = false;
    let stoppedBy: string | null = null;
    /** The last step's `→ <url>` note, dropped when the trailer says the same */
    let urlNote: { line: number; note: string; url: string } | null = null;
    /** What's left of the response cap for read output; status lines and the trailer always fit in what's reserved */
    let budget = RESPONSE_CAP - STATUS_RESERVE;
    const pushPrinted = (printed: string[]) => {
      if (!printed.length) return;
      const text = printed.join("\n");
      if (text.length <= budget) {
        out.push(text);
        budget -= text.length + 1;
        return;
      }
      const hint = `the response is capped at ${RESPONSE_CAP} characters; read less per call`;
      const room = budget - hint.length - 40;
      out.push(
        room > 200
          ? `${text.slice(0, room)}\n… cut at ${room} of ${text.length} characters: ${hint}`
          : `… ${text.length} characters left out: ${hint}`,
      );
      budget = 0;
    };

    for (const line of lines) {
      const notes: string[] = [];
      const printed: string[] = [];
      const { def, args, echo } = line;
      const name = def.name;
      try {
        await this.lockTab(session, tabLock);
        let tabId = this.currentTab(session);
        let state = tabId === null ? undefined : this.states.get(tabId);
        // The step a dialog interrupted, once the user answered the dialog in Chrome
        if (state?.abandoned && !state.dialog) await state.finishAbandoned();
        const whileDialog =
          typeof def.whileDialog === "function"
            ? def.whileDialog(args)
            : !!def.whileDialog;
        if (state?.dialog && !whileDialog) {
          throw new StepError(
            `${dialogLabel(state.dialog)} is open. Answer it with \`dialog accept\` or \`dialog dismiss\` first`,
          );
        }
        const before = tabId === null ? null : await this.quickInfo(tabId);
        const errorsBefore = state?.errorCount ?? 0;
        const ctx = this.stepContext(session, args, printed, notes, images);
        const dialog = await this.runStep(
          session,
          tabId,
          ctx,
          def.run,
          stepTimeout(def, args),
        );
        tabId = this.currentTab(session);
        const after = tabId === null ? null : await this.quickInfo(tabId);
        if (
          !def.navigates &&
          before &&
          after &&
          before.tabId === after.tabId &&
          before.url !== after.url
        ) {
          notes.push(`→ ${shortUrl(after.url, before.url)}`);
          urlNote = {
            line: out.length,
            note: notes.at(-1) ?? "",
            url: after.url,
          };
        }
        for (const opened of session.openedTabs.splice(0)) {
          notes.push(await this.openedNote(opened.tabId, opened.url));
        }
        const afterState = tabId === null ? undefined : this.states.get(tabId);
        state ??= afterState;
        if (afterState && afterState.page === state?.page) {
          const fresh = afterState.errorCount - errorsBefore;
          if (fresh > 0) {
            notes.push(
              `${fresh} new console error${fresh > 1 ? "s" : ""}: ${truncate(afterState.lastError, 120)}`,
            );
          }
        }
        if (dialog) {
          notes.push(
            `${dialogLabel(dialog)} opened. Answer it with \`dialog accept\` or \`dialog dismiss\``,
          );
          stoppedBy = "a dialog is open";
        }
        out.push(`✓ ${echo}${notes.length ? ` — ${notes.join("; ")}` : ""}`);
        pushPrinted(printed);
        if (stoppedBy) {
          out.push(...notRun(line.step, lines.length, stoppedBy));
          break;
        }
      } catch (error) {
        failed = true;
        const message = errorMessage(error);
        if (!(error instanceof StepError || error instanceof ParseError)) {
          this.log("step failed", name, error);
        }
        pushPrinted(printed);
        out.push(`✗ step ${line.step}: ${echo} — ${message}`);
        out.push(...notRun(line.step, lines.length));
        break;
      }
    }

    const end = await this.pageInfo(session);
    if (
      end &&
      (failed ||
        !start ||
        start.tabId !== end.tabId ||
        start.url !== end.url ||
        start.title !== end.title)
    ) {
      out.push(
        `Page: ${end.url} — ${JSON.stringify(truncate(end.title, 200))}`,
      );
      if (urlNote?.url === end.url) {
        out[urlNote.line] = out[urlNote.line]
          .replace(`; ${urlNote.note}`, "")
          .replace(` — ${urlNote.note}`, "");
      }
    }
    const paused = this.pausedDebuggers(session);
    if (paused) out.push(paused);
    const content: (TextContent | ImageContent)[] = [
      { type: "text", text: out.join("\n") },
      ...images,
    ];
    return { content, ...(failed ? { isError: true } : {}) };
  }

  /**
   * Runs a step, abandoning it after `timeoutMs` so a step that never finishes (a promise in the page that never settles, a hung CDP call) doesn't hold the tab. Playwright can't cancel it, so it may still finish later; that's usually a page-side wait that does nothing more.
   *
   * Returns the dialog if one opened while it ran: the step can't finish while the dialog blocks the page, so it's kept on the tab (`TabState.abandoned`) and finishes within the call that answers the dialog, which holds the tab, rather than during a later call.
   */
  private async runStep(
    session: Session,
    tabId: number | null,
    ctx: StepContext,
    run: (ctx: StepContext) => Promise<void>,
    timeoutMs: number,
  ): Promise<Dialog | null> {
    let stop = false;
    let timer: NodeJS.Timeout | undefined;
    try {
      // Polls rather than listening, since the step may claim the tab (and create its state) itself
      const openDialog = () => {
        const current = this.currentTab(session);
        return current === null ? null : this.states.get(current)?.dialog;
      };
      const existing = openDialog();
      const dialogOpened = (async () => {
        while (!stop) {
          const dialog = openDialog();
          if (dialog && dialog !== existing) return dialog;
          await sleep(50);
        }
        return null;
      })();
      const step = run(ctx).then(() => null);
      // The race below reports its rejection; this keeps an abandoned step's later one from going unhandled
      step.catch(() => {});
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new StepError(
                `Timed out after ${formatSeconds(timeoutMs)}; the step was abandoned`,
              ),
            ),
          timeoutMs,
        );
      });
      const winner = await Promise.race([
        step,
        dialogOpened.then((d) => d ?? step),
        deadline,
      ]);
      if (winner) {
        const current = this.currentTab(session);
        const state = current === null ? undefined : this.states.get(current);
        if (state) state.abandoned = step;
      }
      return winner;
    } finally {
      stop = true;
      clearTimeout(timer);
      if (tabId !== null) {
        const state = this.states.get(tabId);
        if (state) state.lastUsed = Date.now();
      }
    }
  }

  private stepContext(
    session: Session,
    args: StepContext["args"],
    printed: string[],
    notes: string[],
    images: ImageContent[],
  ): StepContext {
    return {
      args,
      io: session.io,
      capabilities: session.capabilities,
      print: (text) => printed.push(text),
      note: (text) => notes.push(text),
      image: (data, mimeType) => {
        if (images.length >= MAX_IMAGES) {
          notes.push(
            `image left out: at most ${MAX_IMAGES} per response, so take more in another call`,
          );
          return;
        }
        images.push({ type: "image", data: data.toString("base64"), mimeType });
      },
      page: async () => (await this.tabState(session)).page,
      tab: () => this.tabState(session),
      currentTabId: () => this.currentTab(session),
      pageForGoto: async () => {
        if (this.currentTab(session) === null) {
          const tabId = await this.backend.createTab({ app: session.app });
          this.adopt(session, tabId, true);
        }
        return (await this.tabState(session)).page;
      },
      internalCdp: async () => {
        const state = await this.tabState(session);
        state.internalCdp ??= await this.backend.cdpSession(state.tabId);
        return state.internalCdp;
      },
      agentCdp: async () => {
        const state = await this.tabState(session);
        state.cdp ??= newCdpState(await this.backend.cdpSession(state.tabId));
        return state.cdp;
      },
      tabs: {
        list: () => this.listTabs(session),
        create: async (url) => {
          const tabId = await this.backend.createTab({ app: session.app });
          this.adopt(session, tabId, true);
          if (url) {
            const page = (await this.tabState(session)).page;
            await page.goto(url, { waitUntil: "commit", timeout: 30_000 });
            await waitForLoad(page);
          }
          return tabId;
        },
        select: async (tabId) => {
          const tab = await this.backend.findTab(tabId);
          if (!tab) {
            throw new StepError(`There's no tab ${tabId}. Run \`tab list\``);
          }
          if (tab.appId !== session.app.id && !tab.pinned) {
            await this.backend.groupTab(tabId, session.app);
          }
          this.adopt(session, tabId, false);
        },
        close: async (tabId) => {
          const id = tabId ?? this.currentTab(session);
          if (id === null) throw new StepError("There's no current tab");
          if (!session.opened.has(id)) {
            throw new StepError(
              `Tab ${id} isn't one you opened, so it stays open. Switch away with \`tab select <id>\``,
            );
          }
          await this.releaseTab(id);
          await this.backend.closeTab(id);
          for (const other of this.sessions.values()) this.forget(other, id);
        },
      },
    };
  }

  // --- Tabs ---

  /** The session's tab, unless it closed. Shared and dragged-in tabs become current only at a call's start (`takePending`), so a batch never switches tabs midway */
  private currentTab(session: Session): number | null {
    if (
      session.current !== null &&
      this.tabsKnown() &&
      !this.backend.tabs().some((tab) => tab.tabId === session.current)
    ) {
      this.forget(session, session.current);
    }
    return session.current;
  }

  /** The most recently active session, of those matching */
  private mostRecent(filter: (session: Session) => boolean = () => true) {
    return [...this.sessions.values()]
      .filter(filter)
      .sort((a, b) => b.lastCall - a.lastCall)[0];
  }

  /** At a call's start: switches to the tab dragged in for the session since its last call */
  private takePending(session: Session) {
    const tabId = session.pending;
    session.pending = null;
    if (tabId === null) return;
    if (this.tabsKnown() && !this.backend.tabs().some((t) => t.tabId === tabId))
      return;
    session.tabs.add(tabId);
    session.current = tabId;
  }

  /** Whether `backend.tabs()` lists the user's tabs. It's empty while the extension is away (e.g. its service worker restarting) or waits for **Allow**, which doesn't mean the tabs closed */
  private tabsKnown() {
    return this.backend.unavailableReason() === null;
  }

  private adopt(session: Session, tabId: number, opened: boolean) {
    session.tabs.add(tabId);
    if (opened) session.opened.add(tabId);
    session.current = tabId;
  }

  private forget(session: Session, tabId: number) {
    session.tabs.delete(tabId);
    session.opened.delete(tabId);
    if (session.current === tabId) session.current = null;
  }

  private inUse(tabId: number) {
    return [...this.sessions.values()].some((s) => s.tabs.has(tabId));
  }

  /** Claims the session's current tab and returns its state, set up on first use after each claim */
  private async tabState(session: Session): Promise<TabState> {
    const tabId = this.currentTab(session);
    if (tabId === null) throw new StepError(NO_TAB_MESSAGE);
    const page = await this.backend.page(tabId);
    let state = this.states.get(tabId);
    if (!state || state.page !== page) {
      state?.dispose();
      state = new TabState(tabId, page);
      this.states.set(tabId, state);
      try {
        state.internalCdp = await this.backend.cdpSession(tabId);
        await state.watchDialogClose(state.internalCdp);
      } catch (error) {
        this.log("no internal CDP session", tabId, error);
      }
      await hiddenTabs.onClaim(page, state.internalCdp);
    }
    state.lastUsed = Date.now();
    return state;
  }

  private async listTabs(session: Session): Promise<string> {
    const tabs = this.backend.tabs();
    if (!tabs.length) return "(no tabs)";
    const current = this.currentTab(session);
    // The extension reports titles and URLs a moment after they change, so tabs agents use show their page's own
    const live = await Promise.all(
      tabs.map((tab) => this.quickInfo(tab.tabId)),
    );
    return tabs
      .map((reported, i) => {
        const tab = {
          ...reported,
          ...live[i],
          title: live[i]?.title || reported.title,
        };
        const marks = [
          session.tabs.has(tab.tabId) ? "yours" : undefined,
          tab.active ? "active" : undefined,
        ].filter(Boolean);
        return `${tab.tabId === current ? "*" : " "} ${tab.tabId} ${JSON.stringify(truncate(tab.title, 80))} — ${truncate(tab.url, 120)}${marks.length ? ` (${marks.join(", ")})` : ""}`;
      })
      .join("\n");
  }

  private pruneClosedTabs() {
    if (!this.tabsKnown()) return;
    const open = new Set(this.backend.tabs().map((tab) => tab.tabId));
    for (const session of this.sessions.values()) {
      for (const tabId of session.tabs) {
        if (!open.has(tabId)) this.forget(session, tabId);
      }
    }
    for (const tabId of this.states.keys()) {
      if (!open.has(tabId)) this.dropState(tabId);
    }
  }

  private dropState(tabId: number) {
    this.states.get(tabId)?.dispose();
    this.states.delete(tabId);
  }

  /** Undoes what agents changed on the tab, then releases it */
  private async releaseTab(tabId: number) {
    const state = this.states.get(tabId);
    this.dropState(tabId);
    if (state?.cdp) await cleanupCdp(state.cdp);
    if (state) await hiddenTabs.onRelease(state.internalCdp);
    await state?.internalCdp?.detach().catch(() => {});
    if (this.backend.isClaimed(tabId)) {
      await this.backend.release(tabId).catch((error) => {
        this.log("release failed", tabId, error);
      });
    }
  }

  private async releaseIdle() {
    const now = Date.now();
    for (const [tabId, state] of this.states) {
      if (
        now - state.lastUsed < this.idleReleaseMs ||
        this.locks.has(`tab:${tabId}`)
      ) {
        continue;
      }
      this.log("releasing idle tab", tabId);
      await this.releaseTab(tabId);
    }
  }

  // --- Output ---

  /** The current tab's URL and title, without claiming it */
  private async pageInfo(session: Session) {
    const tabId = this.currentTab(session);
    return tabId === null ? null : this.quickInfo(tabId);
  }

  private async quickInfo(tabId: number) {
    const state = this.states.get(tabId);
    if (state && !state.page.isClosed()) {
      const title = await Promise.race([
        state.page.title().catch(() => ""),
        new Promise<string>((resolve) => setTimeout(() => resolve(""), 1000)),
      ]);
      return { tabId, url: state.page.url(), title };
    }
    const tab = this.backend.tabs().find((t) => t.tabId === tabId);
    return tab ? { tabId, url: tab.url, title: tab.title } : null;
  }

  /** `opened tab 4 "Checkout"`, waiting briefly for the new tab's title */
  private async openedNote(tabId: number, url: string) {
    for (let i = 0; i < 10; i++) {
      const tab = this.backend.tabs().find((t) => t.tabId === tabId);
      if (tab?.title)
        return `opened tab ${tabId} ${JSON.stringify(truncate(tab.title, 80))}`;
      if (tab && tab.url !== "about:blank") url = tab.url;
      await sleep(100);
    }
    return `opened tab ${tabId} (${url || "about:blank"})`;
  }

  private pausedDebuggers(session: Session): string | null {
    const paused = [...session.tabs].filter(
      (tabId) => this.states.get(tabId)?.cdp?.paused,
    );
    if (!paused.length) return null;
    return `⏸ The debugger is paused in tab ${paused.join(", ")}; the page is frozen until \`cdp Debugger.resume\``;
  }
}

/** The URL without its origin when the origin didn't change */
function shortUrl(url: string, previous: string) {
  try {
    const next = new URL(url);
    if (next.origin === new URL(previous).origin && next.origin !== "null") {
      return next.pathname + next.search + next.hash;
    }
  } catch {}
  return url;
}

type TabLock = { tabId: number | null; release: (() => void) | null };

/** How long a step may run: `--timeout` or the command's own time plus headroom, at least the default */
function stepTimeout(def: CommandDef, args: ParsedArgs): number {
  const flag = args.flags.timeout;
  const fromFlag = typeof flag === "string" ? Number(flag) : NaN;
  const own =
    def.timeoutMs?.(args) ??
    (Number.isFinite(fromFlag) && fromFlag >= 0
      ? Math.min(fromFlag, TIMEOUT_MAX_MS)
      : undefined);
  return Math.max(
    stepLimits.defaultMs,
    own === undefined ? 0 : own + stepLimits.headroomMs,
  );
}

function formatSeconds(ms: number) {
  return `${Math.round(ms / 100) / 10} s`;
}

/** A command line that parsed: its command, arguments and what its `✓` or `✗` line echoes */
type CheckedLine = CommandLine & {
  def: CommandDef;
  args: ParsedArgs;
  echo: string;
};

/** Checks what a line can get wrong without a page (the command, its capability, quoting, flags, the number of arguments). Returns the line's `✗` line when it fails */
function checkLine(
  line: CommandLine,
  capabilities: readonly string[],
): CheckedLine | string {
  const name = commandName(line.source);
  const def = COMMANDS_BY_NAME.get(name);
  // Until the line parses, commands that take typed text echo only their name
  let echo = !def || def.echo ? name : truncate(line.source, ECHO_MAX);
  try {
    if (!def) {
      throw new StepError(
        `Unknown command ${name}. Commands: ${availableCommands(capabilities)
          .map((c) => c.name)
          .join(", ")}`,
      );
    }
    if (def.capability && !capabilities.includes(def.capability)) {
      throw new StepError(
        `\`${def.name}\` is off. Start @browsermcp/mcp with \`--caps ${def.capability}\` to turn it on`,
      );
    }
    const tokens = tokenize(line.source).slice(1);
    if (def.echo) echo = truncate(def.echo(lenientArgs(tokens)), ECHO_MAX);
    const args = parseArgs(name, tokens, def.flags ?? {});
    if (def.echo) echo = truncate(def.echo(args), ECHO_MAX);
    checkArgCount(def, args);
    return { ...line, def, args, echo };
  } catch (error) {
    return `✗ step ${line.step}: ${echo} — ${errorMessage(error)}`;
  }
}

/** Flags and positional arguments without checking them, for echoing an invalid line */
function lenientArgs(tokens: Token[]): ParsedArgs {
  const isFlag = (token: Token) => !token.quoted && token.text.startsWith("-");
  return {
    positional: tokens.filter((token) => !isFlag(token)),
    flags: Object.fromEntries(
      tokens
        .filter(isFlag)
        .map((token) => [token.text.replace(/^-+/, ""), true as const]),
    ),
  };
}

function checkArgCount(def: CommandDef, args: ParsedArgs) {
  const max = def.maxArgs ?? 0;
  const count = args.positional.length;
  if (count <= max) return;
  throw new StepError(
    `${def.name} takes ${max === 0 ? "no arguments" : `at most ${max} argument${max > 1 ? "s" : ""}`}, got ${count}. Quote text with spaces in double quotes; run \`help ${def.name}\``,
  );
}

function notRun(step: number, total: number, reason?: string): string[] {
  if (step >= total) return [];
  const range =
    step + 1 === total ? `Step ${total}` : `Steps ${step + 1}–${total}`;
  return [`${range} not run${reason ? ` (${reason})` : ""}`];
}

function dialogLabel(dialog: Dialog) {
  return `${dialog.type()} dialog ${JSON.stringify(truncate(dialog.message(), 200))}`;
}

function truncate(text: string, max: number) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function errorResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}
