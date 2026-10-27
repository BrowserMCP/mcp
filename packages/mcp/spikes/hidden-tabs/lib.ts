// Shared helpers for the hidden-tab spike.
//
// Launches the real Google Chrome binary with a fresh temp profile and none of
// the flags Playwright adds (no --enable-automation, no
// --disable-background-timer-throttling, no --disable-backgrounding-occluded-windows,
// no --disable-renderer-backgrounding), then connects with connectOverCDP.
import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  chromium,
  type Browser,
  type CDPSession,
  type Page,
} from "playwright-core";

export const CHROME =
  process.env.CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- fixtures

const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

export const FIXTURE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>fixture</title>
<style>
  body { font: 14px system-ui; margin: 8px; }
  .item { height: 120px; border-bottom: 1px solid #ccc; }
  .item img { width: 60px; height: 60px; background: #eee; }
  #anim { width: 20px; height: 20px; background: tomato; animation: spin 1s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style></head>
<body>
<h1>Fixture</h1>
<button id="btn" onclick="__s.clicks++">Click me</button>
<input id="inp" aria-label="Name">
<div id="anim"></div>
<ul id="list" aria-label="Items"></ul>
<div id="sentinel">loading more…</div>
<script>
const s = (window.__s = {
  raf: 0, timers: [], ioSeen: 0, imgsLoaded: 0, ioBatches: 0, scrollBatches: 0,
  scrollEvents: 0, clicks: 0, items: 0, visChanges: [], focusEvents: [],
});
(function raf() { s.raf++; requestAnimationFrame(raf); })();
(function tick() {
  s.timers.push(performance.now());
  if (s.timers.length > 5000) s.timers.shift();
  setTimeout(tick, 50);
})();
document.addEventListener("visibilitychange", () => s.visChanges.push([performance.now(), document.visibilityState]));
addEventListener("focus", () => s.focusEvents.push([performance.now(), "focus"]));
addEventListener("blur", () => s.focusEvents.push([performance.now(), "blur"]));

const list = document.getElementById("list");
const seen = new IntersectionObserver((entries) => {
  for (const e of entries) if (e.isIntersecting && !e.target.dataset.seen) { e.target.dataset.seen = "1"; s.ioSeen++; }
});
function addBatch(n) {
  for (let i = 0; i < n; i++) {
    const li = document.createElement("li");
    li.className = "item";
    li.id = "item-" + s.items;
    li.innerHTML = '<img loading="lazy" alt="" src="/img/' + s.items + '.png?r=' + Math.random() + '"> Item ' + s.items;
    li.querySelector("img").onload = () => s.imgsLoaded++;
    list.appendChild(li);
    seen.observe(li);
    s.items++;
  }
}
addBatch(20);
// Infinite scroll the modern way (IntersectionObserver on a sentinel)…
new IntersectionObserver((entries) => {
  if (entries.some((e) => e.isIntersecting) && s.items < 400) { s.ioBatches++; addBatch(20); }
}).observe(document.getElementById("sentinel"));
// …and the old way (scroll event).
addEventListener("scroll", () => {
  s.scrollEvents++;
  if (scrollY + innerHeight > document.documentElement.scrollHeight - 300 && s.items < 400) { s.scrollBatches++; addBatch(20); }
});
</script></body></html>`;

export async function startFixtureServer(): Promise<{
  url: string;
  server: Server;
  close: () => Promise<void>;
}> {
  const server = createServer((req, res) => {
    if (req.url?.startsWith("/img/")) {
      res.writeHead(200, {
        "content-type": "image/png",
        "cache-control": "no-store",
      });
      res.end(PNG_1x1);
      return;
    }
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(FIXTURE_HTML);
  });
  // Port 0: a random free port, never 9009-9012.
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  return {
    url: `http://127.0.0.1:${addr.port}`,
    server,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

// ---------------------------------------------------------------- chrome

export type Bounds = {
  left: number;
  top: number;
  width: number;
  height: number;
};

// A small window in a corner of the main display (logical points).
export const CORNER: Bounds = { left: 0, top: 560, width: 480, height: 400 };

export type Chrome = {
  pid: number;
  browser: Browser;
  cdp: CDPSession; // browser-level session (the daemon's view; the extension can't do Browser.*/Target.*)
  close: () => Promise<void>;
};

export async function launchChrome(
  opts: {
    headless?: boolean;
    bounds?: Bounds;
    extraArgs?: string[];
    noDefaults?: boolean;
    inBackground?: boolean;
  } = {},
): Promise<Chrome> {
  const dir = mkdtempSync(join(tmpdir(), "hidden-tabs-"));
  const b = opts.bounds ?? CORNER;
  const args = [
    `--user-data-dir=${dir}`,
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    // Keeps macOS from showing a Keychain prompt for the temp profile; doesn't affect rendering.
    "--use-mock-keychain",
    "--password-store=basic",
    `--window-position=${b.left},${b.top}`,
    `--window-size=${b.width},${b.height}`,
    ...(opts.headless ? ["--headless=new"] : []),
    ...(opts.extraArgs ?? []),
    "about:blank",
  ];
  let pid: number;
  if (opts.inBackground ?? process.platform === "darwin") {
    // `open -g -n` starts a new Chrome instance without activating it, so it doesn't take the
    // user's focus (spawning the binary directly makes Chrome the frontmost app).
    execFileSync("open", [
      "-g",
      "-n",
      "-a",
      CHROME.replace(/\/Contents\/MacOS\/.*$/, ""),
      "--args",
      ...args,
    ]);
    pid = await findMainPid(dir);
  } else {
    pid = spawn(CHROME, args, { stdio: "ignore", detached: false }).pid!;
  }
  const portFile = join(dir, "DevToolsActivePort");
  const deadline = Date.now() + 15_000;
  while (
    !existsSync(portFile) ||
    readFileSync(portFile, "utf8").split("\n").length < 2
  ) {
    if (Date.now() > deadline)
      throw new Error("Chrome didn't write DevToolsActivePort");
    await sleep(50);
  }
  const port = Number(readFileSync(portFile, "utf8").split("\n")[0]);
  // noDefaults: true by default. Without it Playwright enables Emulation.setFocusEmulationEnabled on
  // every page of the default context, which is itself one of the mitigations measured here.
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, {
    noDefaults: opts.noDefaults ?? true,
  });
  const cdp = await browser.newBrowserCDPSession();
  const close = async () => {
    await browser.close().catch(() => {});
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
    for (let i = 0; i < 60 && alive(pid); i++) await sleep(50);
    if (alive(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
    rmSync(dir, { recursive: true, force: true });
  };
  return { pid, browser, cdp, close };
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The browser process of the instance using `dir` (not its helpers, which carry --type=). */
async function findMainPid(dir: string): Promise<number> {
  for (let i = 0; i < 200; i++) {
    const out = execFileSync("ps", ["-axww", "-o", "pid=,command="]).toString();
    for (const line of out.split("\n")) {
      if (line.includes(`--user-data-dir=${dir}`) && !line.includes("--type="))
        return Number(line.trim().split(" ")[0]);
    }
    await sleep(50);
  }
  throw new Error("Chrome didn't start");
}

let seq = 0;
/** Opens a tab the way the extension would (chrome.tabs.create / windows.create), returns its Page. */
export async function openTab(
  c: Chrome,
  url: string,
  opts: { newWindow?: boolean; background?: boolean } = {},
): Promise<{ page: Page; targetId: string; session: CDPSession }> {
  const ctx = c.browser.contexts()[0];
  const u = `${url}${url.includes("?") ? "&" : "?"}t=${++seq}`;
  const pageP = ctx.waitForEvent("page", {
    predicate: (p) => p.url() === u || p.url() === "about:blank",
    timeout: 10_000,
  });
  const { targetId } = (await c.cdp.send("Target.createTarget", {
    url: u,
    newWindow: opts.newWindow,
    background: opts.background,
  })) as { targetId: string };
  await pageP;
  let page: Page | undefined;
  for (let i = 0; i < 100 && !page; i++) {
    for (const p of ctx.pages()) {
      const s = await ctx.newCDPSession(p);
      const info = (await s.send("Target.getTargetInfo")) as {
        targetInfo: { targetId: string };
      };
      await s.detach();
      if (info.targetInfo.targetId === targetId) page = p;
    }
    if (!page) await sleep(50);
  }
  if (!page) throw new Error("page not found");
  await page
    .waitForFunction(() => (window as any).__s, null, { timeout: 10_000 })
    .catch(() => {});
  const session = await ctx.newCDPSession(page);
  return { page, targetId, session };
}

export async function windowOf(c: Chrome, targetId: string) {
  return (await c.cdp.send("Browser.getWindowForTarget", { targetId })) as {
    windowId: number;
    bounds: Bounds & { windowState: string };
  };
}

export async function setBounds(
  c: Chrome,
  windowId: number,
  bounds: Partial<Bounds> & { windowState?: string },
) {
  if (bounds.windowState && bounds.windowState !== "normal") {
    await c.cdp.send("Browser.setWindowBounds", {
      windowId,
      bounds: { windowState: bounds.windowState as any },
    });
  } else {
    await c.cdp.send("Browser.setWindowBounds", {
      windowId,
      bounds: { windowState: "normal" },
    });
    await c.cdp.send("Browser.setWindowBounds", {
      windowId,
      bounds: bounds as any,
    });
  }
}

// ---------------------------------------------------------------- measuring

export type State = { visibility: string; hasFocus: boolean };

/** Reads page state through CDP Runtime.evaluate (works even when Playwright's own utility waits). */
export async function evalRaw<T = any>(
  session: CDPSession,
  expression: string,
  timeout = 3000,
): Promise<T> {
  const r = (await withTimeout(
    session.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    }),
    timeout,
  )) as any;
  if (r === TIMEOUT) throw new Error("evaluate timed out");
  return r.result.value as T;
}

export const TIMEOUT = Symbol("timeout");
export async function withTimeout<T>(
  p: Promise<T>,
  ms: number,
): Promise<T | typeof TIMEOUT> {
  let t: NodeJS.Timeout;
  return Promise.race([
    p,
    new Promise<typeof TIMEOUT>((r) => (t = setTimeout(() => r(TIMEOUT), ms))),
  ]).finally(() => clearTimeout(t!));
}

export type OpResult = { ok: boolean; ms: number; note?: string };

export async function timed(
  fn: () => Promise<unknown>,
  timeoutMs: number,
): Promise<OpResult> {
  const t0 = performance.now();
  try {
    const r = await withTimeout(fn(), timeoutMs + 500);
    const ms = Math.round(performance.now() - t0);
    if (r === TIMEOUT) return { ok: false, ms, note: "hung" };
    return { ok: true, ms, note: typeof r === "string" ? r : undefined };
  } catch (e) {
    const msg = String((e as Error).message ?? e).split("\n")[0];
    return {
      ok: false,
      ms: Math.round(performance.now() - t0),
      note: /Timeout|timed out/i.test(msg) ? "timeout" : msg.slice(0, 80),
    };
  }
}

/** rAF callbacks per second and setTimeout(50) cadence over a window. */
export async function cadence(session: CDPSession, ms = 2000) {
  const a = await evalRaw(
    session,
    `({raf: __s.raf, n: __s.timers.length, now: performance.now()})`,
  );
  await sleep(ms);
  const b = await evalRaw(
    session,
    `({raf: __s.raf, now: performance.now(), t: __s.timers.slice(-40), vis: document.visibilityState, focus: document.hasFocus()})`,
  );
  const since = b.t.filter((x: number) => x > a.now);
  const gaps = since.slice(1).map((x: number, i: number) => x - since[i]);
  gaps.sort((x: number, y: number) => x - y);
  return {
    rafPerSec: Math.round(((b.raf - a.raf) * 1000) / (b.now - a.now)),
    timerMedianMs: gaps.length
      ? Math.round(gaps[Math.floor(gaps.length / 2)])
      : null,
    timerFires: since.length,
    visibility: b.vis as string,
    hasFocus: b.focus as boolean,
  };
}

export type OpsReport = Record<string, unknown>;

/**
 * Runs every operation the spike measures on a page and returns a flat report.
 * Each op is bounded by `timeoutMs`; a hang shows as { ok:false, note:"timeout"|"hung" }.
 */
export async function runOps(
  page: Page,
  session: CDPSession,
  timeoutMs = 3000,
  label = "page",
): Promise<OpsReport> {
  const r: OpsReport = {};
  r.cadence = await cadence(session);

  // Playwright click (actionability: visible, stable (rAF), enabled, receives events).
  const c0 = await evalRaw(session, "__s.clicks");
  r.pwClick = await timed(
    () => page.click("#btn", { timeout: timeoutMs }),
    timeoutMs,
  );
  (r.pwClick as OpResult).note ??=
    `clicks +${(await evalRaw(session, "__s.clicks")) - c0}`;

  r.pwFill = await timed(
    () => page.fill("#inp", "hello", { timeout: timeoutMs }),
    timeoutMs,
  );
  (r.pwFill as OpResult).note ??=
    `value=${await evalRaw(session, "document.getElementById('inp').value")}`;

  // Raw CDP mouse click at the button's center (the fallback path: our own hit test + Input.*).
  const c1 = await evalRaw(session, "__s.clicks");
  r.cdpClick = await timed(async () => {
    const rect = await evalRaw(
      session,
      `(() => { const r = document.getElementById('btn').getBoundingClientRect(); return {x: r.x + r.width/2, y: r.y + r.height/2}; })()`,
    );
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"] as const)
      await session.send("Input.dispatchMouseEvent", {
        type,
        x: rect.x,
        y: rect.y,
        button: "left",
        clickCount: 1,
      });
  }, timeoutMs);
  (r.cdpClick as OpResult).note ??=
    `clicks +${(await evalRaw(session, "__s.clicks")) - c1}`;

  // Lazy list: scroll to the bottom twice, the way an agent would (mouse wheel and scrollIntoView).
  const before = await evalRaw(session, `({...__s, timers: undefined})`);
  r.wheel = await timed(() => page.mouse.wheel(0, 4000), timeoutMs);
  await sleep(800);
  r.scrollIntoView = await timed(
    () =>
      page
        .locator(`#item-${before.items - 1}`)
        .scrollIntoViewIfNeeded({ timeout: timeoutMs }),
    timeoutMs,
  );
  await sleep(1200);
  const after = await evalRaw(
    session,
    `({...__s, timers: undefined, scrollY})`,
  );
  r.lazy = {
    scrollY: after.scrollY,
    items: `${before.items}→${after.items}`,
    ioSeen: after.ioSeen - before.ioSeen,
    imgsLoaded: `${before.imgsLoaded}→${after.imgsLoaded}`,
    ioBatches: after.ioBatches - before.ioBatches,
    scrollEvents: after.scrollEvents - before.scrollEvents,
    scrollBatches: after.scrollBatches - before.scrollBatches,
  };

  r.screenshot = await timed(async () => {
    const buf = await page.screenshot({ timeout: timeoutMs });
    if (process.env.SHOT_DIR)
      writeFileSync(
        join(process.env.SHOT_DIR, `${label.replace(/\W+/g, "_")}.png`),
        buf,
      );
    return `${buf.length}B`;
  }, timeoutMs);
  r.cdpCapture = await timed(async () => {
    const res = (await session.send("Page.captureScreenshot", {
      format: "png",
    })) as { data: string };
    if (process.env.SHOT_DIR)
      writeFileSync(
        join(process.env.SHOT_DIR, `${label.replace(/\W+/g, "_")}_cdp.png`),
        Buffer.from(res.data, "base64"),
      );
    return `${Math.round((res.data.length * 3) / 4)}B`;
  }, timeoutMs);
  r.ariaSnapshot = await timed(async () => {
    const s = await page.ariaSnapshot({
      mode: "ai",
      timeout: timeoutMs,
    } as any);
    return `${s.split("\n").length} lines`;
  }, timeoutMs);
  return r;
}

export function fmtOp(o: unknown): string {
  if (!o || typeof o !== "object") return String(o);
  const op = o as OpResult;
  if ("ok" in op)
    return `${op.ok ? "ok" : "FAIL"} ${op.ms}ms${op.note ? ` (${op.note})` : ""}`;
  return JSON.stringify(o);
}

export function printReport(label: string, r: OpsReport) {
  console.log(`\n=== ${label}`);
  for (const [k, v] of Object.entries(r))
    console.log(`  ${k.padEnd(15)} ${fmtOp(v)}`);
}
