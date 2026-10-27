import { type Browser, browser } from "wxt/browser";

import type { BrowserControl } from "./background/browser-control";
import type { BrowserControlView } from "./types";

/**
 * The popup's messages to browser control in the background, each with what it takes and returns. Browser control answers them with a `runtime.onMessage` listener of its own (`handleBrowserControlMessages()`), beside any the extension has, so it needs nothing of the extension's own messaging
 */
export type BrowserControlMessages = {
  /** Starts the background if the browser stopped it, and looks for the Browser MCP server now rather than at its next retry */
  ping: { input: void; output: void };
  /** What the popup shows of browser control: the connection, the AI apps and their tabs, Stop or Resume */
  getBrowserControl: { input: void; output: BrowserControlView };
  /** **Stop**: detaches every tab and refuses agents' commands until **Resume** */
  stopAgents: { input: void; output: void };
  /** **Resume** after **Stop** */
  resumeAgents: { input: void; output: void };
  /** **Allow**: trusts the connected Browser MCP server's key (pairing) */
  allowDaemon: { input: { publicKey: string }; output: void };
  /** Sets the port to look for the Browser MCP server on (its `--port`), or `null` for the default ports */
  setRelayPort: { input: { port: number | null }; output: void };
  /** Makes a tab active and focuses its window */
  switchToTab: { input: { tabId: number }; output: void };
};

type MessageType = keyof BrowserControlMessages;
/** Tagged with `browserControl`, so the extension's own `runtime.onMessage` listeners leave it alone */
type Envelope = { browserControl: MessageType; input: unknown };
type Reply = { ok: true; output: unknown } | { ok: false; error: string };

type MessageHandlers = {
  [Type in MessageType]: (
    input: BrowserControlMessages[Type]["input"],
    sender: Browser.runtime.MessageSender,
  ) =>
    | BrowserControlMessages[Type]["output"]
    | Promise<BrowserControlMessages[Type]["output"]>;
};

/**
 * Sends a message to browser control in the background and returns its result, or throws its error
 */
export async function sendBrowserControlMessage<Type extends MessageType>(
  type: Type,
  ...[input]: BrowserControlMessages[Type]["input"] extends void
    ? []
    : [BrowserControlMessages[Type]["input"]]
): Promise<BrowserControlMessages[Type]["output"]> {
  const envelope: Envelope = { browserControl: type, input };
  const reply = (await browser.runtime.sendMessage(envelope)) as
    | Reply
    | undefined;
  if (!reply) {
    throw new Error(`Nothing handled the "${type}" message`);
  }
  if (!reply.ok) {
    throw new Error(reply.error);
  }
  return reply.output as BrowserControlMessages[Type]["output"];
}

/**
 * Answers the popup's messages to browser control. Call it synchronously from `defineBackground()`. Without browser control (`null`, e.g. in Firefox, which has no `debugger` API), they fail, and `ping` does nothing. Returns a function that removes the listener
 */
export function handleBrowserControlMessages(
  browserControl: BrowserControl | null,
): () => void {
  const control = () => {
    if (!browserControl) {
      throw new Error(
        "Browser control needs Chrome or another Chromium browser",
      );
    }
    return browserControl;
  };
  // What only the user's clicks in the popup do, which a content script must not (e.g. a page's script resuming agents)
  const fromPopup = (sender: Browser.runtime.MessageSender) => {
    requirePopupSender(sender);
    return control();
  };
  const handlers: MessageHandlers = {
    // The popup opening starts the background, and looks for the daemon now rather than at the next retry
    ping: () => browserControl?.connection.connectNow(),
    getBrowserControl: () => control().getView(),
    stopAgents: (_, sender) => fromPopup(sender).stop(),
    resumeAgents: (_, sender) => fromPopup(sender).resume(),
    allowDaemon: ({ publicKey }, sender) => fromPopup(sender).allow(publicKey),
    setRelayPort: ({ port }, sender) => fromPopup(sender).setRelayPort(port),
    switchToTab: ({ tabId }, sender) => fromPopup(sender).switchToTab(tabId),
  };

  const listener = (
    message: unknown,
    sender: Browser.runtime.MessageSender,
    sendResponse: (reply: Reply) => void,
  ) => {
    if (
      !isEnvelope(message) ||
      !Object.hasOwn(handlers, message.browserControl)
    ) {
      return false;
    }
    const handler = handlers[message.browserControl] as (
      input: unknown,
      sender: Browser.runtime.MessageSender,
    ) => unknown;
    Promise.resolve()
      .then(() => handler(message.input, sender))
      .then(
        (output) => sendResponse({ ok: true, output }),
        (error: unknown) =>
          sendResponse({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          }),
      );
    // Answers asynchronously, which works in both Chrome and Firefox
    return true;
  };
  browser.runtime.onMessage.addListener(listener);
  return () => browser.runtime.onMessage.removeListener(listener);
}

/**
 * Throws unless the message came from the popup: `popup.html` as the toolbar's popup, or in a tab of its own (as the E2E and smoke tests open it in Chromium). Not content scripts, which run in pages, nor `popup.html` framed in a page (only test builds make it web-accessible). For messages that only the user's clicks in the popup should send
 */
export function requirePopupSender(sender: Browser.runtime.MessageSender) {
  const popupUrl = browser.runtime.getURL("/popup.html");
  const fromPopup =
    sender.url?.startsWith(popupUrl) &&
    (!sender.tab || sender.tab.url?.startsWith(popupUrl));
  if (!fromPopup) {
    throw new Error("Only the extension's popup can send this message");
  }
}

function isEnvelope(message: unknown): message is Envelope {
  return (
    typeof message === "object" &&
    message !== null &&
    "browserControl" in message &&
    typeof message.browserControl === "string"
  );
}
