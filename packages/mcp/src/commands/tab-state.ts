/**
 * What the engine keeps per tab while it's claimed: console messages with page errors, requests (500 each), the open dialog and raw CDP state. A tab's Page object changes when it's released and claimed again, so the buffers follow the Page.
 */
import type {
  CDPSession,
  ConsoleMessage,
  Dialog,
  Page,
  Request,
  Response,
} from "playwright-core";

export const BUFFER_SIZE = 500;
/** How long a step a dialog interrupted may take to finish once the dialog is answered (it's usually waiting for a navigation) */
const ABANDONED_WAIT_MS = 10_000;

export type ConsoleEntry = {
  type: string;
  text: string;
  location?: string;
  /** Order across `console` and `uncaught` */
  seq: number;
};
export type RequestEntry = {
  id: number;
  request: Request;
  response?: Response;
  failure?: string;
};

export type CdpState = {
  session: CDPSession;
  /** Domains `cdp` enabled (`Network.enable` → `Network`), disabled on release */
  enabled: Set<string>;
  /** Events subscribed with `cdp on` */
  subscribed: Set<string>;
  events: { method: string; params: unknown }[];
  /** Methods that set overrides, so release knows what to clear */
  used: Set<string>;
  paused: boolean;
  listeners: Map<string, (params: unknown) => void>;
};

export class TabState {
  console: ConsoleEntry[] = [];
  /** Uncaught errors (type `uncaught`, with their stacks), apart from `console` so a chatty page doesn't push them out */
  uncaught: ConsoleEntry[] = [];
  private consoleSeq = 0;
  /** Console errors and page errors seen, for "new console errors" notes */
  errorCount = 0;
  /** The newest of them, first line */
  lastError = "";
  requests: RequestEntry[] = [];
  private requestSeq = 0;
  private requestIds = new WeakMap<Request, RequestEntry>();
  dialog: Dialog | null = null;
  /** A step a dialog interrupted, which goes on once the dialog is answered */
  abandoned: Promise<unknown> | null = null;
  cdp: CdpState | null = null;
  /** The internal CDP session (screenshots, focus emulation), not the agent's */
  internalCdp: CDPSession | null = null;
  lastUsed = Date.now();
  private disposers: (() => void)[] = [];

  constructor(
    readonly tabId: number,
    readonly page: Page,
  ) {
    const on = <T>(event: string, listener: (value: T) => void) => {
      page.on(event as "console", listener as never);
      this.disposers.push(() =>
        page.off(event as "console", listener as never),
      );
    };
    on<ConsoleMessage>("console", (message) => {
      const location = message.location();
      // Chrome logs the favicon's 404 as an error on many sites; it's never what the agent is after
      if (/\/favicon\.ico(\?|$)/.test(location.url)) return;
      push(this.console, {
        type: message.type(),
        text: message.text(),
        location: location.url
          ? `${location.url}:${location.lineNumber + 1}`
          : undefined,
        seq: ++this.consoleSeq,
      });
      if (message.type() === "error") {
        this.errorCount++;
        this.lastError = message.text().split("\n")[0];
      }
    });
    on<Error>("pageerror", (error) => {
      push(this.uncaught, {
        type: "uncaught",
        text: error.stack || `${error.name}: ${error.message}`,
        seq: ++this.consoleSeq,
      });
      this.errorCount++;
      this.lastError = `${error.name}: ${error.message}`.split("\n")[0];
    });
    on<Request>("request", (request) => {
      const entry = { id: ++this.requestSeq, request };
      this.requestIds.set(request, entry);
      push(this.requests, entry);
    });
    on<Response>("response", (response) => {
      const entry = this.requestIds.get(response.request());
      if (entry) entry.response = response;
    });
    on<Request>("requestfailed", (request) => {
      const entry = this.requestIds.get(request);
      if (entry) entry.failure = request.failure()?.errorText ?? "failed";
    });
    on<Dialog>("dialog", (dialog) => {
      this.dialog = dialog;
    });
  }

  /** Clears the dialog when it closes without `dialog accept` or `dismiss` (the user answered it in Chrome). Playwright doesn't say, so this listens on the engine's CDP session */
  async watchDialogClose(cdp: CDPSession) {
    const listener = () => {
      this.dialog = null;
    };
    cdp.on("Page.javascriptDialogClosed", listener);
    this.disposers.push(() => cdp.off("Page.javascriptDialogClosed", listener));
    await cdp.send("Page.enable").catch(() => {});
  }

  /** Waits (a while at most) for the step a dialog interrupted to finish, so it doesn't act on the page during a later call */
  async finishAbandoned(timeoutMs = ABANDONED_WAIT_MS) {
    const step = this.abandoned;
    this.abandoned = null;
    if (!step) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      step.catch(() => {}),
      new Promise((resolve) => (timer = setTimeout(resolve, timeoutMs))),
    ]);
    clearTimeout(timer);
  }

  dispose() {
    for (const dispose of this.disposers) dispose();
    this.disposers = [];
  }
}

function push<T>(buffer: T[], item: T) {
  buffer.push(item);
  if (buffer.length > BUFFER_SIZE)
    buffer.splice(0, buffer.length - BUFFER_SIZE);
}
