import { type Browser, browser } from "wxt/browser";

import type { ExtensionRequestMap } from "@browsermcp/protocol";

import {
  type FrameScan,
  REMOVE_FRAMES_MESSAGE,
  removeExtensionFrames,
} from "../frames";

/** The CDP version `debugger.attach()` asks for */
const PROTOCOL_VERSION = "1.3";

/** How long an `Input.*` command may take. In a tab Chrome isn't rendering (a background tab without focus emulation) it never answers, and its input lands later, when the tab is shown */
const INPUT_TIMEOUT_MS = 5000;

/** Extensions whose frames on pages (e.g. a password manager's inline menu) commonly block `debugger.attach()`, by Chrome Web Store ID */
const KNOWN_EXTENSIONS: Record<string, string> = {
  aeblfdkhhhdcdjpifhhbdiojplfjncoa: "1Password",
  nngceckbapebfimnlniiiahkandclblb: "Bitwarden",
  hdokiejnpimakedhajhdlcegeplioahd: "LastPass",
  fdjamakpfbbddfjaooikfcpapjohcfmg: "Dashlane",
  kbfnbcaeplbcioakkpcpgfkobkghlhen: "Grammarly",
};

type Listeners = {
  /** A CDP event from an attached tab or one of its child sessions */
  onEvent: (event: {
    tabId: number;
    sessionId?: string;
    method: string;
    params?: unknown;
  }) => void;
  /** The browser detached a tab (closed, DevTools opened, Cancel on the debugging bar), not `detach()` */
  onDetach: (tabId: number, reason: string) => void;
  /** The set of attached tabs changed */
  onChange: () => void;
};

/**
 * The tabs the debugger is attached to, in memory only: when the service worker restarts, the daemon attaches again. Attaches only when the daemon asks (`attach`), never because a tab is listed or grouped
 */
export class DebuggerSessions {
  readonly #attached = new Set<number>();
  /** Bumped by `detachAll()`, so an attach that was under way then doesn't stay */
  #generation = 0;
  /** Each tab's `Input.*` commands, run one at a time */
  readonly #inputQueues = new Map<number, Promise<unknown>>();
  readonly #listeners: Listeners;
  readonly #inputTimeoutMs: number;

  constructor(listeners: Listeners, options: { inputTimeoutMs?: number } = {}) {
    this.#listeners = listeners;
    this.#inputTimeoutMs = options.inputTimeoutMs ?? INPUT_TIMEOUT_MS;
  }

  get attachedTabIds(): ReadonlySet<number> {
    return this.#attached;
  }

  isAttached(tabId: number): boolean {
    return this.#attached.has(tabId);
  }

  /** Adds the `debugger` listeners. Call it synchronously when the background starts */
  addListeners(): () => void {
    const onEvent = (
      source: Browser.debugger.DebuggerSession,
      method: string,
      params?: object,
    ) => {
      if (source.tabId === undefined || !this.#attached.has(source.tabId)) {
        return;
      }
      this.#listeners.onEvent({
        tabId: source.tabId,
        ...(source.sessionId && { sessionId: source.sessionId }),
        method,
        params,
      });
    };
    const onDetach = (source: Browser.debugger.Debuggee, reason: string) => {
      const { tabId } = source;
      if (tabId === undefined || !this.#attached.delete(tabId)) {
        return;
      }
      this.#inputQueues.delete(tabId);
      this.#listeners.onDetach(tabId, reason);
      this.#listeners.onChange();
    };
    browser.debugger.onEvent.addListener(onEvent);
    browser.debugger.onDetach.addListener(onDetach);
    return () => {
      browser.debugger.onEvent.removeListener(onEvent);
      browser.debugger.onDetach.removeListener(onDetach);
    };
  }

  /**
   * Attaches to the tab if it isn't already, and returns its target info. `verify` runs once the debugger attached and before the tab counts as attached (its events are dropped until then): it checks again that agents may use the tab, since **Stop** or a navigation may have come while attaching. When it throws, the debugger detaches
   */
  async attach(
    tabId: number,
    verify: () => Promise<void> = async () => {},
  ): Promise<ExtensionRequestMap["attach"]["result"]> {
    if (!this.#attached.has(tabId)) {
      const generation = this.#generation;
      const checkAllowed = async () => {
        await verify();
        if (generation !== this.#generation) {
          throw new Error(`Tab ${tabId} was released while attaching`);
        }
      };
      await attachRemovingExtensionFrames(tabId, checkAllowed);
      try {
        await checkAllowed();
      } catch (error) {
        await browser.debugger.detach({ tabId }).catch(() => {});
        throw error;
      }
      this.#attached.add(tabId);
      this.#listeners.onChange();
    }
    return (await browser.debugger.sendCommand(
      { tabId },
      "Target.getTargetInfo",
    )) as ExtensionRequestMap["attach"]["result"];
  }

  async detach(tabId: number): Promise<void> {
    if (!this.#attached.delete(tabId)) {
      return;
    }
    this.#inputQueues.delete(tabId);
    this.#listeners.onChange();
    // `debugger.detach()` doesn't fire `onDetach`. It fails when the tab closed meanwhile
    await browser.debugger.detach({ tabId }).catch(() => {});
  }

  /** Detaches every tab, including ones still attaching (**Stop**, or the daemon disconnected) */
  async detachAll(): Promise<void> {
    this.#generation++;
    await Promise.all([...this.#attached].map((tabId) => this.detach(tabId)));
  }

  /** Sends a CDP command to an attached tab, or one of its child sessions. `Input.*` commands wait for the tab's previous ones, and fail after `INPUT_TIMEOUT_MS` (so a hung one doesn't block the tab's next ones) */
  async send({
    tabId,
    sessionId,
    method,
    params,
  }: ExtensionRequestMap["cdp"]["params"]): Promise<unknown> {
    if (!this.#attached.has(tabId)) {
      throw new Error(`The debugger isn't attached to tab ${tabId}`);
    }
    const run = () =>
      browser.debugger.sendCommand(
        { tabId, ...(sessionId && { sessionId }) },
        method,
        params,
      );
    if (!method.startsWith("Input.")) {
      return run();
    }
    const previous = this.#inputQueues.get(tabId) ?? Promise.resolve();
    const result = previous
      .catch(() => {})
      .then(() => this.#withInputTimeout(tabId, method, run()));
    this.#inputQueues.set(tabId, result);
    try {
      return await result;
    } finally {
      if (this.#inputQueues.get(tabId) === result) {
        this.#inputQueues.delete(tabId);
      }
    }
  }

  async #withInputTimeout(
    tabId: number,
    method: string,
    command: Promise<unknown>,
  ): Promise<unknown> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = Symbol("timeout");
    const result = await Promise.race([
      command,
      new Promise<typeof timedOut>((resolve) => {
        timer = setTimeout(() => resolve(timedOut), this.#inputTimeoutMs);
      }),
    ]).finally(() => clearTimeout(timer));
    if (result !== timedOut) {
      return result;
    }
    command.catch(() => {});
    // `Runtime.evaluate` still answers in a hidden tab
    const visibility = await Promise.race([
      browser.debugger
        .sendCommand({ tabId }, "Runtime.evaluate", {
          expression: "document.visibilityState",
          returnByValue: true,
        })
        .then(
          (answer) =>
            (answer as { result?: { value?: unknown } } | undefined)?.result
              ?.value,
        ),
      new Promise((resolve) => setTimeout(resolve, 1000)),
    ]).catch(() => undefined);
    throw new Error(
      `${method} didn't finish in ${this.#inputTimeoutMs / 1000} s${typeof visibility === "string" ? ` (the tab is ${visibility})` : ""}. Chrome doesn't take input in a tab it isn't rendering`,
    );
  }

  /**
   * Detaches from the tabs this extension is still attached to from before the service worker restarted, so Chrome's debugging bar doesn't stay. The daemon attaches again when an agent uses them
   */
  async detachStale(): Promise<void> {
    const targets = await browser.debugger.getTargets();
    await Promise.all(
      targets
        .filter(
          (target) =>
            target.attached &&
            target.tabId !== undefined &&
            !this.#attached.has(target.tabId),
        )
        // Fails for tabs another extension or DevTools is debugging, which is fine
        .map((target) =>
          browser.debugger.detach({ tabId: target.tabId }).catch(() => {}),
        ),
    );
  }
}

const EXTENSION_URL = /^chrome-extension:\/\/([a-p]{32})\//;

/** How long a frame's content script gets to answer the request to remove other extensions' frames */
const FRAME_REPLY_TIMEOUT_MS = 2000;

/** How often `attach()` removes other extensions' frames and tries again: a password manager may put its frame back right away */
const MAX_FRAME_REMOVALS = 2;

/**
 * Attaches the debugger. When another extension's frame blocks it, removes the frame from the page and tries again (up to `MAX_FRAME_REMOVALS` times), then explains the failure. `checkAllowed` runs before each removal and throws when agents may no longer use the tab (**Stop**, a navigation), so a page is never changed after that
 */
async function attachRemovingExtensionFrames(
  tabId: number,
  checkAllowed: () => Promise<void>,
): Promise<void> {
  const notes: string[] = [];
  for (let removals = 0; ; removals++) {
    try {
      await browser.debugger.attach({ tabId }, PROTOCOL_VERSION);
      return;
    } catch (error) {
      const blocked =
        error instanceof Error && error.message.includes("chrome-extension://");
      if (!blocked || removals >= MAX_FRAME_REMOVALS) {
        if (blocked) {
          notes.push(`the frame was still there after ${removals} removals`);
        }
        throw await describeAttachError(tabId, error, notes);
      }
      await checkAllowed();
      const { removed, note } = await removeOtherExtensionFrames(tabId);
      notes.push(note);
      if (removed === 0) {
        throw await describeAttachError(tabId, error, notes);
      }
    }
  }
}

/**
 * Removes other extensions' frames from the tab and its frames. Asks the content script in each frame (declared in the manifest, so it has `chrome.dom` to look into closed shadow roots, and idle until asked); in tabs without one (open before the extension was loaded) it injects the same function with `scripting` instead. Returns how many it removed (0 when it found none or couldn't run: a page extensions can't script, or the user turned the site access off) and a note on what happened, for the error when attaching still fails
 */
async function removeOtherExtensionFrames(
  tabId: number,
): Promise<{ removed: number; note: string }> {
  const listed = await browser.webNavigation
    .getAllFrames({ tabId })
    .catch(() => null);
  // An empty list is as good as none: a tab always has its top frame
  const frames = listed && listed.length > 0 ? listed : null;
  const asked = frames ?? [{ frameId: 0 }];
  const errors: string[] = [];
  const answers = await Promise.all(
    asked.map(async ({ frameId }): Promise<FrameScan | undefined> => {
      try {
        return await withTimeout(
          browser.tabs.sendMessage(
            tabId,
            { type: REMOVE_FRAMES_MESSAGE },
            { frameId },
          ),
          FRAME_REPLY_TIMEOUT_MS,
        );
      } catch (error) {
        // No content script in this frame (a tab open before the extension was loaded, or a frame it doesn't run in)
        errors.push(error instanceof Error ? error.message : String(error));
        return undefined;
      }
    }),
  );
  const fromContentScripts = answers.flatMap((scan) => (scan ? [scan] : []));
  // The frames the content script didn't answer for (`about:blank`, `srcdoc` and sandboxed frames, which it doesn't run in, or every frame when `webNavigation` failed) get the injected script
  const unanswered = asked.filter((_, i) => !answers[i]).map((f) => f.frameId);
  if (frames && unanswered.length === 0) {
    return summarize("the content script", fromContentScripts);
  }
  const description = `asked ${asked.length} frames (${frames ? "from webNavigation" : "webNavigation failed"}): ${[...new Set(errors)].join(" / ") || "no reply"}`;
  const source =
    fromContentScripts.length > 0
      ? `the content script (${description}) and an injected script`
      : `no content script answered (${description}), so an injected script`;
  try {
    const results = await browser.scripting.executeScript({
      target: frames
        ? { tabId, frameIds: unanswered }
        : { tabId, allFrames: true },
      func: removeExtensionFrames,
      args: [browser.runtime.id],
    });
    return summarize(
      source,
      [
        ...fromContentScripts,
        ...results.flatMap(({ result }) => (result ? [result] : [])),
      ],
      fromContentScripts.length + results.length,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const note = `the injected script couldn't run: ${message}`;
    if (fromContentScripts.length === 0) {
      return { removed: 0, note };
    }
    const summary = summarize("the content script", fromContentScripts);
    return { removed: summary.removed, note: `${summary.note}; ${note}` };
  }
}

/** Rejects when `promise` hasn't settled after `ms`: a frozen, discarded or navigating frame never answers a message */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`no answer within ${ms} ms`)),
        ms,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

function summarize(
  source: string,
  scans: FrameScan[],
  ran = scans.length,
): { removed: number; note: string } {
  const sum = (key: "removed" | "iframes" | "shadowRoots") =>
    scans.reduce((total, scan) => total + scan[key], 0);
  const schemes = [...new Set(scans.flatMap((scan) => scan.schemes))];
  const dom = scans.some((scan) => scan.hasDom)
    ? "chrome.dom available"
    : "no chrome.dom";
  return {
    removed: sum("removed"),
    note: `${source} ran in ${ran} frames (${scans.length} answered) and removed ${sum("removed")} of ${sum("iframes")} iframes (${sum("shadowRoots")} shadow roots, ${dom}${schemes.length > 0 ? `, other iframe URLs: ${schemes.join(", ")}` : ""})`,
  };
}

/**
 * Other extensions with frames that may block attaching: the tab's frames, which `webNavigation` lists only for some (Chrome leaves out other extensions' frames), else every other extension's frame the debugger sees (type `other`, without a tab ID), since the tab's can't be told apart
 */
async function findOtherExtensionFrames(tabId: number): Promise<string[]> {
  const ownId = browser.runtime.id;
  const idsIn = (urls: string[]) => [
    ...new Set(
      urls.flatMap((url) => {
        const match = EXTENSION_URL.exec(url);
        return match && match[1] !== ownId ? [match[1]] : [];
      }),
    ),
  ];
  const frames = await browser.webNavigation
    .getAllFrames({ tabId })
    .catch(() => null);
  const inTab = idsIn((frames ?? []).map(({ url }) => url));
  if (inTab.length > 0) {
    return inTab;
  }
  const targets = await browser.debugger.getTargets().catch(() => []);
  return idsIn(
    targets
      .filter((target) => target.type === "other" && target.tabId === undefined)
      .map(({ url }) => url),
  );
}

/**
 * Explains why the debugger couldn't attach, for the model. Another extension's `chrome-extension://` frame on the page blocks attaching (remorses/playwriter#18), so it names that extension, which the user can turn off for the site. Reached when removing the frame found nothing or the frame came back
 */
async function describeAttachError(
  tabId: number,
  error: unknown,
  notes: string[] = [],
): Promise<Error> {
  const detail =
    notes.length > 0 ? ` (Removing the frame: ${notes.join("; ")})` : "";
  const message = error instanceof Error ? error.message : String(error);
  if (!message.includes("chrome-extension://")) {
    return new Error(`Couldn't attach to tab ${tabId}: ${message}`);
  }
  const extensionIds = await findOtherExtensionFrames(tabId);
  if (extensionIds.length === 0) {
    return new Error(
      `Couldn't attach to tab ${tabId}: another extension's frame on the page blocks it. Ask the user to turn off extensions that add frames to this site (e.g. password managers' inline menus) and try again${detail}`,
    );
  }
  const names = extensionIds.map((id) =>
    KNOWN_EXTENSIONS[id]
      ? `${KNOWN_EXTENSIONS[id]} (${id})`
      : `the extension https://chromewebstore.google.com/detail/${id}`,
  );
  return new Error(
    `Couldn't attach to tab ${tabId}: a frame of ${names.join(" and ")} on the page blocks it. Ask the user to turn that extension off for this site (in its settings, or "This can read and change site data" → "When you click the extension" in chrome://extensions) and try again${detail}`,
  );
}
