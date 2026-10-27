/**
 * End-to-end smoke test of browser control. Run it with `pnpm --filter @browsermcp/extension smoke`, which first builds this extension in development mode and `@browsermcp/mcp`. `--extension <dir>` runs it against another development build of an extension with browser control (`@browsermcp/extension-core`) and the same popup text, such as the Chrome Web Store build's: development builds set `legacyPortOverride`, which the section on 0.1.x servers needs.
 *
 * It loads the dev build (`.output/chrome-mv3-dev`, or `--extension`) in headless Chromium, launched without Playwright's anti-throttling flags so background tabs are hidden as in the user's Chrome, and runs the built MCP server (`@browsermcp/mcp`'s `dist/index.js --port <random>`) over stdio with the MCP SDK's client, as AI apps do. The server starts its daemon, the extension finds it on `relayPort`, and the test clicks **Allow** in the real popup. Each section asserts what a scenario of the design needs, and screenshots go to `smoke/` beside the build (`.output/smoke/`).
 *
 * It never touches the user's Browser MCP: the daemons get a temp `BROWSER_MCP_HOME` and random ports, the extension's legacy probe a random port (`legacyPort`, honored only by development and test builds), and the browser reaches loopback only through a proxy that refuses ports 9009–9012, so even the extension's first probes (before `relayPort` is set) can't reach a real server. It kills only the browser and daemons it started, by PID.
 *
 * Not covered: Cancel on Chrome's debugging bar (`canceled_by_user`). Headless Chromium shows no infobar, and nothing else (CDP or an extension API) makes `chrome.debugger.onDetach` report that reason, so it's left to the extension's unit tests and a manual check in headed Chrome.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { chromium, type Page, type Worker } from "@playwright/test";
import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import net, { type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { type WebSocket, WebSocketServer } from "ws";

import {
  LEGACY_SERVER_MESSAGE,
  NO_EXTENSION_MESSAGE,
} from "@browsermcp/protocol";

type Chrome = typeof import("wxt/browser").browser;

const { values: args } = parseArgs({
  options: { extension: { type: "string" } },
});
const extensionDir = args.extension
  ? path.resolve(args.extension)
  : path.resolve(import.meta.dirname, "../.output/chrome-mv3-dev");
const serverEntry = path.resolve(
  import.meta.dirname,
  "../../../packages/mcp/dist/index.js",
);
const outDir = path.resolve(extensionDir, "../smoke");
const PAUSED_MESSAGE =
  "The user paused Browser MCP. Ask them to click Resume in its popup";
/** Ports the browser must never reach: 0.1.x servers' and the real daemon's */
const FORBIDDEN_PORTS = new Set([9009, 9010, 9011, 9012]);

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
const tempRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "bmcp-smoke-")));
const log = (...args: unknown[]) => console.log("[smoke]", ...args);

// --- Setup ---

const cleanups: (() => unknown)[] = [];
const fixtures = await startFixtureServer();
cleanups.push(() => fixtures.close());
const proxy = await startLoopbackProxy();
cleanups.push(() => proxy.close());
const relayPort = await freePort();
const home = path.join(tempRoot, "home");
const rootsDir = path.join(tempRoot, "roots");
mkdirSync(rootsDir);
writeFileSync(path.join(rootsDir, "notes.txt"), "uploaded by the smoke test");
const otherExtension = writeOtherExtension(path.join(tempRoot, "frame-ext"));

const chromiumProcess = await launchChromium();
cleanups.push(() => killPid(chromiumProcess.pid));
const browser = await chromium.connectOverCDP(chromiumProcess.wsEndpoint, {
  noDefaults: true,
});
const context = browser.contexts()[0]!;
// The build's manifest has a key (this extension's fixed one, or a dev build's per checkout), which gives its ID
const extensionId = extensionIdFrom(
  Buffer.from(
    JSON.parse(readFileSync(path.join(extensionDir, "manifest.json"), "utf8"))
      .key,
    "base64",
  ),
);
log(`Extension ${extensionId}, daemon port ${relayPort}, temp ${tempRoot}`);

const daemonHomes = new Set<string>([home]);
cleanups.push(() => {
  for (const dir of daemonHomes) killDaemon(dir);
});
const clients: Client[] = [];
cleanups.push(() => Promise.all(clients.map((c) => c.close().catch(() => {}))));

const results: { name: string; ok: boolean; error?: string; ms: number }[] = [];

try {
  // Old versions: a 0.1.x server (a fake one speaking its WebSocket protocol, on a random port rather than 9009) gets `LEGACY_SERVER_MESSAGE` for every command
  await section("an old 0.1.x server gets the update message", async () => {
    const legacy = await startFakeLegacyServer();
    try {
      await inWorker(
        async ({ legacyPort, deadPort }) => {
          const { chrome } = globalThis as unknown as { chrome: Chrome };
          // A port nothing listens on, so the extension doesn't find the daemon yet
          await chrome.storage.local.set({ legacyPort, relayPort: deadPort });
        },
        { legacyPort: legacy.port, deadPort: await freePort() },
      );
      const ws = await legacy.connected;
      const answer = await legacy.send(ws, "browser_navigate", {
        url: "https://example.com",
      });
      expect(
        answer.error === LEGACY_SERVER_MESSAGE,
        `0.1.x answer: ${JSON.stringify(answer)}`,
      );
      await waitFor("the ! badge", async () => (await badge()) === "!");
      const popup = await openPopup();
      await popup
        .getByText(/^Update the .* server$/)
        .first()
        .waitFor();
      await shot(popup, "popup-legacy-server");
      await popup.close();
    } finally {
      await legacy.close();
    }
  });

  const alpha = await connectClient("smoke-alpha", "Smoke Alpha", { home });

  await section("no extension: NO_EXTENSION_MESSAGE", async () => {
    const result = await call(alpha, "get url");
    expect(result.isError && result.text === NO_EXTENSION_MESSAGE, result.text);
  });

  let pairingCode = "";
  await section(
    "pairing: the tool asks for Allow with the popup's code",
    async () => {
      await inWorker(async (port) => {
        const { chrome } = globalThis as unknown as { chrome: Chrome };
        await chrome.storage.local.set({ relayPort: port });
      }, relayPort);
      const popup = await openPopup();
      const codeText = await popup.getByText(/^Code: /).textContent({
        timeout: 20_000,
      });
      pairingCode = codeText!.replace("Code: ", "").trim();
      await waitFor("the ? badge", async () => (await badge()) === "?");
      const result = await call(alpha, "get url");
      expect(result.isError, "an unpaired daemon must fail");
      expect(
        result.text ===
          `Click Allow in the Browser MCP extension's popup. The code is ${pairingCode}`,
        `tool says ${JSON.stringify(result.text)}, popup ${pairingCode}`,
      );
      await shot(popup, "popup-allow");
      await popup.getByRole("button", { name: "Allow", exact: true }).click();
      await popup
        .getByText(/^Connected/)
        .first()
        .waitFor();
      await shot(popup, "popup-connected");
      await popup.close();
    },
  );

  let alphaTab = 0;
  await section("the form flow in one call, under 600 characters", async () => {
    const result = await call(
      alpha,
      `goto ${fixtures.url("/form")}
fill getByLabel('Customer name') "Jane Doe"
fill getByLabel('Telephone') "555-0100"
fill getByLabel('E-mail address') "jane@example.com"
check getByLabel('Medium')
check getByLabel('Bacon')
check getByLabel('Mushroom')
fill getByLabel('Delivery instructions') "Ring twice"
click getByRole('button', { name: 'Submit order' })
get text body --max 1500`,
    );
    log(result.text);
    expect(!result.isError, result.text);
    expect(result.text.includes("Thanks, order received"), result.text);
    expect(result.text.includes('"custname":"Jane Doe"'), result.text);
    expect(result.text.includes('"topping":["bacon","mushroom"]'), result.text);
    expect(result.text.length < 600, `${result.text.length} characters`);
    alphaTab = await currentTabId(alpha);
  });

  await section(
    "agents' tabs: a background tab in the app's named, colored group, and the badge",
    async () => {
      const info = await inWorker(async (tabId) => {
        const { chrome } = globalThis as unknown as { chrome: Chrome };
        const tab = await chrome.tabs.get(tabId);
        const groups = await chrome.tabGroups.query({});
        return { tab, groups };
      }, alphaTab);
      expect(!info.tab.active, "the agent's tab must not be the active tab");
      const group = info.groups.find((g) => g.id === info.tab.groupId);
      expect(group?.title === "Smoke Alpha", `group ${JSON.stringify(group)}`);
      expect(!!group?.color, "the group has a color");
      expect((await badge()) === "1", `badge ${await badge()}`);
      // Hidden-tab spike: focus emulation makes the background tab render, so clicks and lazy loading work there
      const result = await call(
        alpha,
        `goto ${fixtures.url("/lazy")}
eval "() => document.visibilityState"
click #more
wait --text "Item 40"
scroll bottom
get count li`,
      );
      expect(!result.isError, result.text);
      expect(result.text.includes('"visible"'), result.text);
      expect(result.text.includes("✓ scroll bottom"), result.text);
      expect(
        result.text.endsWith("\n40") || result.text.includes("\n40\n"),
        result.text,
      );
      const stillBackground = await inWorker(async (tabId) => {
        const { chrome } = globalThis as unknown as { chrome: Chrome };
        return !(await chrome.tabs.get(tabId)).active;
      }, alphaTab);
      expect(stillBackground, "the agent's tab stayed in the background");
      // Headless Chromium hides background tabs as Chrome does: without the daemon's focus emulation, a background tab of the user's doesn't render
      const control = await context.newPage();
      await control.goto(fixtures.url("/second"));
      await inWorker(async (url) => {
        const { chrome } = globalThis as unknown as { chrome: Chrome };
        await chrome.tabs.create({ url, active: true });
      }, fixtures.url("/popup"));
      expect(
        (await control.evaluate(() => document.visibilityState)) === "hidden",
        "a background tab should be hidden",
      );
      await control.close();
    },
  );

  await section(
    "reads: snapshot -i, find, get, eval, screenshot, console, requests",
    async () => {
      const result = await call(
        alpha,
        `goto ${fixtures.url("/reads")}
snapshot -i
find "Second"
get title
get text h1
get attr href getByRole('link', { name: 'Docs' })
eval "() => 6 * 7"
click #log
console
requests --filter api`,
      );
      expect(!result.isError, result.text);
      for (const expected of [
        'button "Log something"',
        "Second paragraph",
        "Reads page",
        "/docs",
        "42",
        "hello from the page",
        "Boom",
        "/api/data",
      ]) {
        expect(
          result.text.includes(expected),
          `missing ${expected}:\n${result.text}`,
        );
      }
      const image = await call(alpha, "screenshot");
      expect(!image.isError, image.text);
      expect(image.images.length === 1, "one image");
      writeFileSync(
        path.join(outDir, "agent-screenshot.jpg"),
        Buffer.from(image.images[0]!.data, "base64"),
      );
    },
  );

  await section("tabs: list, new, select, close", async () => {
    const created = await call(
      alpha,
      `tab new ${fixtures.url("/second")}\nget title`,
    );
    expect(!created.isError, created.text);
    expect(created.text.includes("Second page"), created.text);
    const newTab = await currentTabId(alpha);
    const list = await call(alpha, "tab list");
    expect(list.text.includes(`* ${newTab} "Second page"`), list.text);
    const selected = await call(alpha, `tab select ${alphaTab}\nget url`);
    expect(selected.text.includes("/reads"), selected.text);
    const closed = await call(alpha, `tab close ${newTab}\ntab list`);
    expect(
      !closed.isError && !closed.text.includes(`${newTab} "Second`),
      closed.text,
    );
  });

  await section("a click at 125% zoom", async () => {
    await call(alpha, `goto ${fixtures.url("/zoom")}`);
    await inWorker(async (tabId) => {
      const { chrome } = globalThis as unknown as { chrome: Chrome };
      await chrome.tabs.setZoom(tabId, 1.25);
    }, alphaTab);
    const result = await call(
      alpha,
      `eval "() => devicePixelRatio"
click getByRole('button', { name: 'B7', exact: true })
get text #out
click getByRole('button', { name: 'B11', exact: true })
get text #out`,
    );
    expect(result.text.includes("1.25"), result.text);
    expect(
      result.text.includes("clicked 7") && result.text.includes("clicked 11"),
      result.text,
    );
    await saveScreenshot(alpha, "zoom-125");
  });

  await section(
    "pages that open tabs: target=_blank and window.open",
    async () => {
      const blank = await call(
        alpha,
        `goto ${fixtures.url("/opener")}\nclick #blank`,
      );
      const blankTab = Number(/opened tab (\d+)/.exec(blank.text)?.[1]);
      expect(!!blankTab, blank.text);
      const popupCall = await call(alpha, "click #popup");
      const popupTab = Number(/opened tab (\d+)/.exec(popupCall.text)?.[1]);
      expect(!!popupTab, popupCall.text);
      const selected = await call(
        alpha,
        `tab select ${blankTab}\nget title\ntab select ${popupTab}\nget title`,
      );
      expect(!selected.isError, selected.text);
      expect(
        selected.text.includes("Second page") &&
          selected.text.includes("Popup page"),
        selected.text,
      );
      const windows = await inWorker(
        async (ids) => {
          const { chrome } = globalThis as unknown as { chrome: Chrome };
          const tabs = await Promise.all(ids.map((id) => chrome.tabs.get(id)));
          return Promise.all(
            tabs.map(async (tab) => ({
              type: (await chrome.windows.get(tab.windowId)).type,
              groupId: tab.groupId,
            })),
          );
        },
        [blankTab, popupTab, alphaTab],
      );
      expect(
        windows.every((w) => w.type === "normal"),
        `windows ${JSON.stringify(windows)}`,
      );
      expect(
        windows.every(
          (w) => w.groupId === windows[2]!.groupId && w.groupId !== -1,
        ),
        `groups ${JSON.stringify(windows)}`,
      );
      await call(
        alpha,
        `tab close ${blankTab}\ntab close ${popupTab}\ntab select ${alphaTab}`,
      );
    },
  );

  await section("another extension's iframe on the page", async () => {
    const page = await context.newPage();
    await page.goto(fixtures.url("/ext-frame"));
    await page.locator("iframe").waitFor({ state: "attached" });
    const tabId = await tabIdOf(page.url());
    const result = await call(alpha, `tab select ${tabId}\nget title`);
    // The extension removes the other extension's frame, which can block `debugger.attach()`, and attaches
    expect(!result.isError, result.text);
    expect(
      (await page.locator("iframe").count()) === 0,
      "the other extension's frame should be gone",
    );
    await call(alpha, `tab select ${alphaTab}`);
    await page.close();
  });

  await section(
    "another extension's iframe in a closed shadow root on the page",
    async () => {
      const page = await context.newPage();
      await page.goto(fixtures.url("/ext-frame-shadow"));
      await page.locator("#ext-host").waitFor({ state: "attached" });
      const tabId = await tabIdOf(page.url());
      // The manifest's content script answers, and can look into the closed shadow root (`chrome.dom`)
      const scan = await inWorker(async (id) => {
        const { chrome } = globalThis as unknown as { chrome: Chrome };
        const reply = await chrome.tabs.sendMessage(
          id,
          { type: "browsermcp:removeExtensionFrames" },
          { frameId: 0 },
        );
        return JSON.stringify(reply);
      }, tabId);
      expect(
        scan.includes('"hasDom":true') && scan.includes('"removed":1'),
        `content script reply ${scan}`,
      );
      const result = await call(alpha, `tab select ${tabId}\nget title`);
      expect(!result.isError, result.text);
      // The frame is in a closed shadow root, so only its host shows: it goes with the frame
      expect(
        (await page.locator("#ext-host").count()) === 0,
        "the other extension's shadow host should be gone",
      );
      await call(alpha, `tab select ${alphaTab}`);
      await page.close();
    },
  );

  await section(
    "another extension's iframe that comes back when removed",
    async () => {
      const page = await context.newPage();
      await page.goto(fixtures.url("/ext-frame-sticky"));
      await page.locator("iframe").waitFor({ state: "attached" });
      const tabId = await tabIdOf(page.url());
      const result = await call(alpha, `tab select ${tabId}\nget title`);
      expect(!result.isError, result.text);
      await call(alpha, `tab select ${alphaTab}`);
      await page.close();
    },
  );

  await section(
    "uploads and screenshot paths only within the MCP roots",
    async () => {
      const outside = await call(
        alpha,
        `goto ${fixtures.url("/upload")}\nupload #file /etc/hosts`,
      );
      expect(outside.isError && outside.text.includes(rootsDir), outside.text);
      const inside = await call(alpha, `upload #file notes.txt\nget text #out`);
      expect(
        !inside.isError && inside.text.includes("notes.txt 26"),
        inside.text,
      );
      const shotOutside = await call(
        alpha,
        `screenshot --path ${path.join(tempRoot, "x.jpg")}`,
      );
      expect(shotOutside.isError, shotOutside.text);
      const shotInside = await call(alpha, "screenshot --path shot.jpg");
      expect(
        !shotInside.isError && existsSync(path.join(rootsDir, "shot.jpg")),
        shotInside.text,
      );
    },
  );

  await section("a service worker restart", async () => {
    const session = await browser.newBrowserCDPSession();
    const workerTargets = async () =>
      (await session.send("Target.getTargets")).targetInfos.filter(
        (t) =>
          t.type === "service_worker" &&
          t.url.startsWith(`chrome-extension://${extensionId}/`),
      );
    const [target] = await workerTargets();
    expect(target, "the service worker's target");
    await session.send("Target.closeTarget", { targetId: target.targetId });
    await waitFor(
      "the service worker to stop",
      async () => (await workerTargets()).length === 0,
    );
    // An event wakes it, as one would in the user's browser (here a new tab)
    const waker = await context.newPage();
    await waker.close();
    await waitFor(
      "the service worker to start",
      async () => (await workerTargets()).length === 1,
    );
    await session.detach();
    const result = await retryCall(alpha, "get url", 20_000);
    expect(!result.isError && result.text.includes("/upload"), result.text);
    const paired = await inWorker(async () => {
      const { chrome } = globalThis as unknown as { chrome: Chrome };
      return (await chrome.storage.local.get("pairedDaemonKeys"))
        .pairedDaemonKeys;
    });
    expect(Array.isArray(paired) && paired.length === 1, "pairing survives");
  });

  const beta = await connectClient("smoke-beta", "Smoke Beta", { home });
  await section(
    "two AI apps, each with its own group in its own color",
    async () => {
      const result = await call(
        beta,
        `goto ${fixtures.url("/second")}\nget title`,
      );
      expect(!result.isError, result.text);
      const betaTab = await currentTabId(beta);
      const groups = await inWorker(
        async (ids) => {
          const { chrome } = globalThis as unknown as { chrome: Chrome };
          const tabs = await Promise.all(ids.map((id) => chrome.tabs.get(id)));
          return Promise.all(
            tabs.map((tab) => chrome.tabGroups.get(tab.groupId)),
          );
        },
        [alphaTab, betaTab],
      );
      expect(
        groups[0]!.title === "Smoke Alpha" && groups[1]!.title === "Smoke Beta",
        JSON.stringify(groups),
      );
      expect(groups[0]!.color !== groups[1]!.color, JSON.stringify(groups));
      expect((await badge()) === "2", `badge ${await badge()}`);
    },
  );

  await section("the daemon restarting mid-session", async () => {
    const pid = daemonPid(home);
    process.kill(pid, "SIGKILL");
    await waitFor("the daemon to exit", async () => !isRunning(pid));
    const result = await call(
      alpha,
      `goto ${fixtures.url("/second")}\nget title`,
    );
    expect(!result.isError && result.text.includes("Second page"), result.text);
    expect(daemonPid(home) !== pid, "a new daemon");
    // The other app's session ended with the old daemon, so it selects a tab again, as its error says
    const betaResult = await call(beta, "get title");
    expect(
      betaResult.isError && betaResult.text.includes("tab select <id>"),
      betaResult.text,
    );
  });

  await section("Stop and Resume in the popup", async () => {
    const popup = await openPopup();
    const tabsBefore = await tabCount();
    // The popup marks the tabs the debugger is attached to
    await popup.getByText("In use").first().waitFor();
    await popup.getByRole("button", { name: "Stop" }).click();
    await popup.getByRole("button", { name: "Resume" }).waitFor();
    await shot(popup, "popup-paused");
    const paused = await call(alpha, "get title");
    expect(paused.isError && paused.text === PAUSED_MESSAGE, paused.text);
    expect((await tabCount()) === tabsBefore, "Stop closes no tab");
    await waitFor(
      "Stop to detach every tab",
      async () => (await popup.getByText("In use").count()) === 0,
    );
    expect((await badge()) === "", `badge ${await badge()}`);
    await popup.getByRole("button", { name: "Resume" }).click();
    await popup.getByRole("button", { name: "Stop" }).waitFor();
    await popup.close();
    const resumed = await retryCall(alpha, "get title", 10_000);
    expect(
      !resumed.isError && resumed.text.includes("Second page"),
      resumed.text,
    );
  });

  await section("a different daemon key asks again", async () => {
    await alpha.close();
    await beta.close();
    killDaemon(home);
    const otherHome = path.join(tempRoot, "other-home");
    daemonHomes.add(otherHome);
    const gamma = await connectClient("smoke-gamma", "Smoke Gamma", {
      home: otherHome,
    });
    const result = await retryCall(
      gamma,
      "get url",
      20_000,
      // A moment after connecting, before the extension's nonce arrives, the message has no code yet
      (r) => r.text.includes("The code is"),
    );
    const code = /The code is (\d{3} \d{3})$/.exec(result.text)?.[1];
    expect(result.isError && !!code && code !== pairingCode, result.text);
    const popup = await openPopup();
    await popup.getByText(`Code: ${code}`).waitFor();
    await shot(popup, "popup-allow-new-key");
    await popup.close();
  });
} finally {
  for (const cleanup of cleanups.reverse()) {
    await Promise.resolve()
      .then(cleanup)
      .catch((error: unknown) => log("cleanup:", error));
  }
  // The browser and daemon may still be writing their last files as they exit
  rmSync(tempRoot, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 200,
  });
}

writeFileSync(
  path.join(outDir, "results.json"),
  JSON.stringify(results, null, 2),
);
const failed = results.filter((r) => !r.ok);
log(
  `${results.length - failed.length}/${results.length} passed; screenshots in ${outDir}`,
);
process.exit(failed.length ? 1 : 0);

// --- Sections and assertions ---

async function section(name: string, run: () => Promise<void>) {
  const start = Date.now();
  try {
    await withTimeout(run(), 120_000, name);
    results.push({ name, ok: true, ms: Date.now() - start });
    log(`✓ ${name}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    results.push({ name, ok: false, error: message, ms: Date.now() - start });
    log(`✗ ${name}\n${message}`);
  }
}

function expect(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function waitFor(
  what: string,
  check: () => Promise<boolean>,
  timeoutMs = 15_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check().catch(() => false)) {
      return;
    }
    await sleep(200);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  what: string,
): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} timed out`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- MCP clients ---

/** Runs the built server over stdio, as an AI app does, with the MCP roots `rootsDir` */
async function connectClient(
  name: string,
  title: string,
  options: { home: string },
) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry, "--port", String(relayPort)],
    env: {
      ...(process.env as Record<string, string>),
      BROWSER_MCP_HOME: options.home,
      BROWSER_MCP_EXTENSION_IDS: extensionId,
    },
    cwd: tempRoot,
    stderr: "pipe",
  });
  const client = new Client(
    { name, title, version: "1.0.0" },
    { capabilities: { roots: {} } },
  );
  client.setRequestHandler(ListRootsRequestSchema, () => ({
    roots: [{ uri: pathToFileURL(rootsDir).href, name: "roots" }],
  }));
  await client.connect(transport);
  clients.push(client);
  return client;
}

type CallResult = {
  text: string;
  images: { data: string }[];
  isError: boolean;
};

async function call(client: Client, commands: string): Promise<CallResult> {
  const result = await client.callTool(
    { name: "browser", arguments: { commands } },
    undefined,
    { timeout: 90_000 },
  );
  const content = result.content as {
    type: string;
    text?: string;
    data?: string;
  }[];
  return {
    text: content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n"),
    images: content.filter((c) => c.type === "image") as { data: string }[],
    isError: !!result.isError,
  };
}

/** Calls until the result passes `done` (by default: no error), e.g. while the extension reconnects */
async function retryCall(
  client: Client,
  commands: string,
  timeoutMs: number,
  done: (result: CallResult) => boolean = (r) => !r.isError,
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await call(client, commands);
    if (done(result) || Date.now() > deadline) {
      return result;
    }
    await sleep(500);
  }
}

async function currentTabId(client: Client) {
  const list = await call(client, "tab list");
  const id = Number(/^\* (\d+)/m.exec(list.text)?.[1]);
  expect(id, `no current tab in:\n${list.text}`);
  return id;
}

async function saveScreenshot(client: Client, name: string) {
  const result = await call(client, "screenshot");
  if (result.images[0]) {
    writeFileSync(
      path.join(outDir, `${name}.jpg`),
      Buffer.from(result.images[0].data, "base64"),
    );
  }
}

// --- The browser ---

/** Launches Playwright's Chromium headless with the extensions, without Playwright's flags that keep background tabs rendering */
async function launchChromium() {
  const userDataDir = path.join(tempRoot, "profile");
  const child = spawn(
    chromium.executablePath(),
    [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${userDataDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--use-mock-keychain",
      "--password-store=basic",
      `--proxy-server=http://127.0.0.1:${proxy.port}`,
      "--proxy-bypass-list=<-loopback>",
      `--disable-extensions-except=${extensionDir},${otherExtension.dir}`,
      `--load-extension=${extensionDir},${otherExtension.dir}`,
      "--window-size=1280,900",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  const wsEndpoint = await new Promise<string>((resolve, reject) => {
    let output = "";
    const timer = setTimeout(
      () => reject(new Error(`Chromium didn't start:\n${output}`)),
      30_000,
    );
    child.stderr!.on("data", (data: Buffer) => {
      output += data.toString();
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(output);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]!);
      }
    });
    child.once("exit", () => reject(new Error(`Chromium exited:\n${output}`)));
  });
  child.stderr!.resume();
  return { pid: child.pid!, wsEndpoint, process: child as ChildProcess };
}

/** The extension's service worker (a new one after a restart) */
async function extensionWorkers(): Promise<Worker[]> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const workers = context
      .serviceWorkers()
      .filter((worker) =>
        worker.url().startsWith(`chrome-extension://${extensionId}/`),
      );
    if (workers.length > 0) {
      return workers.reverse();
    }
    await sleep(100);
  }
  throw new Error("The extension's service worker didn't start");
}

/** Runs a function in the extension's service worker, where `chrome` is the extension's API. After a restart, Playwright may still list the stopped worker, so it tries the newest first */
async function inWorker<R, A = undefined>(
  fn: (arg: A) => R | Promise<R>,
  arg?: A,
): Promise<R> {
  let lastError: unknown;
  for (const worker of await extensionWorkers()) {
    try {
      return await worker.evaluate(fn as (arg: unknown) => R, arg);
    } catch (error) {
      if (!/Target.*closed|has been closed/i.test(String(error))) {
        throw error;
      }
      lastError = error;
    }
  }
  throw lastError;
}

async function badge() {
  return await inWorker(async () => {
    const { chrome } = globalThis as unknown as { chrome: Chrome };
    return await chrome.action.getBadgeText({});
  });
}

async function tabCount() {
  return await inWorker(async () => {
    const { chrome } = globalThis as unknown as { chrome: Chrome };
    return (await chrome.tabs.query({})).length;
  });
}

async function tabIdOf(url: string) {
  return await inWorker(async (url) => {
    const { chrome } = globalThis as unknown as { chrome: Chrome };
    const [tab] = await chrome.tabs.query({ url });
    return tab!.id!;
  }, url);
}

/** Opens the popup's page in a tab of its own. With `besideTab`, in a window of its own, then makes that tab's window the focused one, so the popup acts on it */
async function openPopup(options: { besideTab?: number } = {}): Promise<Page> {
  const url = `chrome-extension://${extensionId}/popup.html`;
  let page: Page;
  if (options.besideTab === undefined) {
    page = await context.newPage();
    await page.goto(url);
  } else {
    const opened = context.waitForEvent("page", (p) => p.url().startsWith(url));
    await inWorker(
      async ({ url, tabId }) => {
        const { chrome } = globalThis as unknown as { chrome: Chrome };
        await chrome.windows.create({ url, type: "normal", focused: false });
        const tab = await chrome.tabs.get(tabId);
        await chrome.tabs.update(tabId, { active: true });
        await chrome.windows.update(tab.windowId, { focused: true });
      },
      { url, tabId: options.besideTab },
    );
    page = await opened;
  }
  await page.setViewportSize({ width: 360, height: 560 });
  await page.getByText("Browser MCP").first().waitFor();
  return page;
}

async function shot(page: Page, name: string) {
  await page.screenshot({ path: path.join(outDir, `${name}.png`) });
}

// --- Daemons ---

function daemonInfo(dir: string): { pid: number } | null {
  try {
    return JSON.parse(
      readFileSync(path.join(dir, `daemon-${relayPort}.json`), "utf8"),
    );
  } catch {
    return null;
  }
}

function daemonPid(dir: string) {
  const info = daemonInfo(dir);
  expect(info, `no daemon-${relayPort}.json in ${dir}`);
  return info.pid;
}

function killDaemon(dir: string) {
  const info = daemonInfo(dir);
  if (info) killPid(info.pid);
}

function isRunning(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killPid(pid: number | undefined) {
  if (!pid) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {}
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      server.close(() =>
        FORBIDDEN_PORTS.has(port)
          ? freePort().then(resolve, reject)
          : resolve(port),
      );
    });
    server.once("error", reject);
  });
}

// --- Servers ---

/**
 * The browser's proxy for every request, loopback included (`--proxy-bypass-list=<-loopback>`): it passes requests and tunnels (WebSockets) through, and drops those to ports 9009–9012 as if nothing listened, so the browser can't reach the user's own Browser MCP
 */
async function startLoopbackProxy() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "", "http://invalid");
    const port = Number(url.port || 80);
    if (FORBIDDEN_PORTS.has(port)) {
      req.socket.destroy();
      return;
    }
    const upstream = http.request(
      {
        host: url.hostname,
        port,
        path: url.pathname + url.search,
        method: req.method,
        headers: req.headers,
      },
      (response) => {
        res.writeHead(response.statusCode ?? 502, response.rawHeaders);
        response.pipe(res);
      },
    );
    upstream.on("error", () => req.socket.destroy());
    req.pipe(upstream);
  });
  server.on("connect", (req, socket, head) => {
    const [host, portText] = (req.url ?? "").split(":");
    const port = Number(portText);
    socket.on("error", () => {});
    if (FORBIDDEN_PORTS.has(port)) {
      socket.destroy();
      return;
    }
    const upstream = net.connect(port, host, () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("close", () => upstream.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as AddressInfo).port,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

/** A 0.1.x server's WebSocket protocol: `{ id, type, payload }` requests, answered with `{ type: "messageResponse", payload: { requestId, result | error } }` */
async function startFakeLegacyServer() {
  const server = http.createServer((_req, res) => res.end("0.1.x"));
  const wss = new WebSocketServer({ server });
  const connected = new Promise<WebSocket>((resolve) =>
    wss.once("connection", resolve),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as AddressInfo).port,
    connected,
    send(ws: WebSocket, type: string, payload: unknown) {
      const id = randomUUID();
      return new Promise<{ result?: unknown; error?: string }>((resolve) => {
        ws.on("message", (data) => {
          const message = JSON.parse(data.toString());
          if (
            message.type === "messageResponse" &&
            message.payload.requestId === id
          ) {
            resolve(message.payload);
          }
        });
        ws.send(JSON.stringify({ id, type, payload }));
      });
    },
    close: async () => {
      for (const client of wss.clients) client.terminate();
      wss.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** A Chrome extension's ID: the first 128 bits of the SHA-256 of its key (or an unpacked one's path), in the letters a–p */
function extensionIdFrom(data: Buffer) {
  return Array.from(
    createHash("sha256").update(data).digest("hex").slice(0, 32),
  )
    .map((c) => String.fromCharCode(97 + Number.parseInt(c, 16)))
    .join("");
}

/** A tiny extension whose content script adds a `chrome-extension://` iframe to `/ext-frame`, which can block `debugger.attach()` */
function writeOtherExtension(dir: string) {
  mkdirSync(dir);
  writeFileSync(
    path.join(dir, "manifest.json"),
    JSON.stringify({
      manifest_version: 3,
      name: "Smoke frame extension",
      version: "1.0",
      content_scripts: [
        { matches: ["http://127.0.0.1/*"], js: ["content.js"] },
      ],
      web_accessible_resources: [
        { resources: ["frame.html"], matches: ["http://127.0.0.1/*"] },
      ],
    }),
  );
  writeFileSync(
    path.join(dir, "content.js"),
    `const frame = document.createElement("iframe");
frame.src = chrome.runtime.getURL("frame.html");
if (location.pathname === "/ext-frame") {
  document.body.appendChild(frame);
} else if (location.pathname === "/ext-frame-shadow") {
  // Like a password manager's inline menu: a host element with a closed shadow root around the frame
  const host = document.createElement("div");
  host.id = "ext-host";
  host.attachShadow({ mode: "closed" }).appendChild(frame);
  document.body.appendChild(host);
} else if (location.pathname === "/ext-frame-sticky") {
  // Like a password manager that puts its frame back as soon as the page loses it
  const add = () => {
    const sticky = document.createElement("iframe");
    sticky.src = chrome.runtime.getURL("frame.html");
    document.body.appendChild(sticky);
  };
  add();
  new MutationObserver(() => {
    if (!document.querySelector("iframe")) setTimeout(add, 50);
  }).observe(document.body, { childList: true });
}`,
  );
  writeFileSync(path.join(dir, "frame.html"), "<p>An extension's frame</p>");
  // Without a key, an unpacked extension's ID comes from its path
  return { dir, id: extensionIdFrom(Buffer.from(dir)) };
}

/** The test pages, on 127.0.0.1 */
async function startFixtureServer() {
  const page = (title: string, body: string) =>
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;
  const pages: Record<string, string> = {
    "/form": page(
      "Pizza order",
      `<form method="post" action="/post">
<p><label>Customer name: <input name="custname"></label></p>
<p><label>Telephone: <input type="tel" name="custtel"></label></p>
<p><label>E-mail address: <input type="email" name="custemail"></label></p>
<fieldset><legend>Pizza Size</legend>
<p><label><input type="radio" name="size" value="small"> Small</label></p>
<p><label><input type="radio" name="size" value="medium"> Medium</label></p>
<p><label><input type="radio" name="size" value="large"> Large</label></p></fieldset>
<fieldset><legend>Pizza Toppings</legend>
<p><label><input type="checkbox" name="topping" value="bacon"> Bacon</label></p>
<p><label><input type="checkbox" name="topping" value="cheese"> Extra Cheese</label></p>
<p><label><input type="checkbox" name="topping" value="mushroom"> Mushroom</label></p></fieldset>
<p><label>Delivery instructions: <textarea name="comments"></textarea></label></p>
<p><button>Submit order</button></p></form>`,
    ),
    "/lazy": page(
      "Lazy list",
      `<ul id="list"></ul><button id="more">Load more</button><div id="sentinel" style="height:1px"></div>
<script>
let n = 0;
const add = (k) => { for (let i = 0; i < k; i++) { const li = document.createElement("li"); li.textContent = "Item " + ++n; list.appendChild(li); } };
add(20);
// Loads the next 20 only once the button was clicked and a frame was drawn, as lazy lists do
more.onclick = () => requestAnimationFrame(() => new IntersectionObserver((entries, observer) => {
  if (entries[0].isIntersecting) { observer.disconnect(); add(20); }
}).observe(sentinel));
</script>`,
    ),
    "/reads": page(
      "Reads page",
      `<h1>Reads</h1><p>First paragraph</p><p>Second paragraph</p><a href="/docs">Docs</a>
<button id="log" onclick="console.log('hello from the page'); setTimeout(() => { throw new Error('Boom') }); fetch('/api/data')">Log something</button>`,
    ),
    "/second": page("Second page", "<h1>Second page</h1>"),
    "/popup": page("Popup page", "<h1>Popup page</h1>"),
    "/zoom": page(
      "Zoom",
      `<div style="display:grid;grid-template-columns:repeat(4,120px);gap:8px">${Array.from({ length: 12 }, (_, i) => `<button onclick="out.textContent='clicked ${i}'">B${i}</button>`).join("")}</div><p id="out"></p>`,
    ),
    "/opener": page(
      "Opener",
      `<a id="blank" href="/second" target="_blank">New tab</a>
<button id="popup" onclick="window.open('/popup', 'popup', 'width=400,height=300')">Popup</button>`,
    ),
    "/ext-frame": page(
      "Extension frame page",
      "<h1>A page with another extension's frame</h1>",
    ),
    "/ext-frame-sticky": page(
      "Extension frame that comes back page",
      "<h1>A page where another extension puts its frame back</h1>",
    ),
    "/ext-frame-shadow": page(
      "Extension frame in shadow page",
      // The SVG is not an `HTMLElement`, which `chrome.dom.openOrClosedShadowRoot()` throws on
      `<svg width="1" height="1"><path d="M0 0"/></svg><h1>A page with another extension's frame in a closed shadow root</h1>`,
    ),
    "/upload": page(
      "Upload",
      `<input type="file" id="file" onchange="out.textContent = this.files[0].name + ' ' + this.files[0].size"><p id="out"></p>`,
    ),
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "POST" && url.pathname === "/post") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const form = new URLSearchParams(body);
        const data = {
          custname: form.get("custname"),
          custtel: form.get("custtel"),
          custemail: form.get("custemail"),
          size: form.get("size"),
          topping: form.getAll("topping"),
          comments: form.get("comments"),
        };
        res.setHeader("content-type", "text/html");
        res.end(
          page(
            "Order received",
            `<h1>Thanks, order received</h1><pre>${JSON.stringify(data)}</pre>`,
          ),
        );
      });
      return;
    }
    if (url.pathname === "/api/data") {
      res.setHeader("content-type", "application/json");
      res.end('{"ok":true}');
      return;
    }
    const html = pages[url.pathname];
    res.statusCode = html ? 200 : 404;
    res.setHeader("content-type", "text/html");
    res.end(html ?? page("Not found", "Not found"));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: (pathname: string) => `http://127.0.0.1:${port}${pathname}`,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}
