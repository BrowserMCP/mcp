// Side effects and costs:
// 1. Page.bringToFront on a background agent tab: does it switch the user's visible tab,
//    activate Chrome (steal focus from the user's app), and how fast can we switch back?
// 2. Input sent to a hidden tab that times out: is it delivered later, when the tab becomes
//    visible (phantom clicks)?
// 3. Focus emulation on an agent tab: does it change the user's active tab?
// node side-effects.ts
import { execFileSync } from "node:child_process";

import {
  evalRaw,
  launchChrome,
  openTab,
  sleep,
  startFixtureServer,
  timed,
} from "./lib.ts";

const frontmostPid = () =>
  Number(
    execFileSync("osascript", [
      "-e",
      'tell application "System Events" to get unix id of first process whose frontmost is true',
    ])
      .toString()
      .trim(),
  );
const state = (s: any) =>
  evalRaw(s, "({vis: document.visibilityState, focus: document.hasFocus()})");
async function waitVis(s: any, want: string, timeoutMs = 5000) {
  const t0 = performance.now();
  while (performance.now() - t0 < timeoutMs) {
    if ((await evalRaw(s, "document.visibilityState")) === want)
      return Math.round(performance.now() - t0);
    await sleep(5);
  }
  return -1;
}
async function waitRaf(s: any, timeoutMs = 5000) {
  const t0 = performance.now();
  const r0 = await evalRaw(s, "__s.raf");
  while (performance.now() - t0 < timeoutMs) {
    if ((await evalRaw(s, "__s.raf")) > r0 + 1)
      return Math.round(performance.now() - t0);
    await sleep(5);
  }
  return -1;
}

const srv = await startFixtureServer();
const url = srv.url + "/fixture";

// ---- 1. bringToFront
{
  const c = await launchChrome();
  try {
    console.log("frontmost is ours after launch:", frontmostPid() === c.pid);
    const user = await openTab(c, url);
    console.log(
      "frontmost is ours after opening the user's tab:",
      frontmostPid() === c.pid,
    );
    const agent = await openTab(c, url, { background: true });
    const front0 = frontmostPid();
    console.log(
      "before: user",
      await state(user.session),
      "agent",
      await state(agent.session),
      "frontmost is ours:",
      front0 === c.pid,
    );
    const runs: string[] = [];
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      await agent.session.send("Page.bringToFront");
      const tBring = Math.round(performance.now() - t0);
      const tVis = await waitVis(agent.session, "visible");
      const tRaf = await waitRaf(agent.session);
      const userDuring = await state(user.session);
      const click = await timed(
        () => agent.page.click("#btn", { timeout: 3000 }),
        3000,
      );
      const shot = await timed(
        () => agent.page.screenshot({ timeout: 3000 }),
        3000,
      );
      const t1 = performance.now();
      await user.session.send("Page.bringToFront");
      const tBack = Math.round(performance.now() - t1);
      const tUserVis = await waitVis(user.session, "visible");
      const total = Math.round(performance.now() - t0);
      runs.push(
        `bringToFront ${tBring}ms, agent visible +${tVis}ms, first rAF +${tRaf}ms; user tab during: ${JSON.stringify(
          userDuring,
        )}; click ${click.ms}ms, screenshot ${shot.ms}ms; back ${tBack}ms + user visible ${tUserVis}ms; agent tab shown for ${total}ms total`,
      );
    }
    for (const r of runs) console.log(" ", r);
    console.log(
      "after: user",
      await state(user.session),
      "agent",
      await state(agent.session),
      "frontmost is ours:",
      frontmostPid() === c.pid,
      "(was",
      front0 === c.pid,
      ")",
    );
  } finally {
    await c.close();
  }
}

// ---- 2. phantom input
{
  const c = await launchChrome();
  try {
    await openTab(c, url);
    const agent = await openTab(c, url, { background: true });
    const pw = await timed(
      () => agent.page.click("#btn", { timeout: 1500 }),
      1500,
    );
    const rect = await evalRaw(
      agent.session,
      `(() => { const r = document.getElementById('btn').getBoundingClientRect(); return {x: r.x + r.width/2, y: r.y + r.height/2}; })()`,
    );
    const steps: string[] = [];
    const cdp = await timed(async () => {
      for (const type of [
        "mouseMoved",
        "mousePressed",
        "mouseReleased",
      ] as const) {
        const t = performance.now();
        await agent.session.send("Input.dispatchMouseEvent", {
          type,
          ...rect,
          button: "left",
          clickCount: 1,
        });
        steps.push(`${type} ${Math.round(performance.now() - t)}ms`);
      }
    }, 1500);
    await sleep(500);
    const before = await evalRaw(agent.session, "__s.clicks");
    await agent.session.send("Emulation.setFocusEmulationEnabled", {
      enabled: true,
    });
    await sleep(1500);
    const after = await evalRaw(agent.session, "__s.clicks");
    console.log(
      `phantom input: pwClick ${pw.note} ${pw.ms}ms, cdpClick ${cdp.note ?? "ok"} ${cdp.ms}ms [${steps}]; clicks while hidden=${before}, after the tab became visible=${after}`,
    );
  } finally {
    await c.close();
  }
}

// ---- 3. focus emulation on the agent's tab vs the user's tab
{
  const c = await launchChrome();
  try {
    const user = await openTab(c, url);
    const agents = await Promise.all(
      [1, 2, 3].map(() => openTab(c, url, { background: true })),
    );
    const before = await state(user.session);
    for (const a of agents)
      await a.session.send("Emulation.setFocusEmulationEnabled", {
        enabled: true,
      });
    await sleep(1000);
    const rafs = await Promise.all(
      agents.map((a) => evalRaw(a.session, "document.visibilityState")),
    );
    console.log(
      "focus emulation on 3 background tabs: user tab before",
      before,
      "after",
      await state(user.session),
      "agents",
      rafs,
    );
    // Turning it off: back to hidden?
    await agents[0].session.send("Emulation.setFocusEmulationEnabled", {
      enabled: false,
    });
    console.log(
      "after disabling on one agent tab, it becomes hidden in",
      await waitVis(agents[0].session, "hidden"),
      "ms",
    );
    // Detaching the session (chrome.debugger.detach) also ends the emulation?
    await agents[1].session.detach();
    const s2 = await c.browser.contexts()[0].newCDPSession(agents[1].page);
    const t0 = performance.now();
    let vis = "";
    while (
      performance.now() - t0 < 3000 &&
      (vis = await evalRaw(s2, "document.visibilityState")) !== "hidden"
    )
      await sleep(20);
    console.log(
      `after detaching the session that enabled it: ${vis} after ${Math.round(performance.now() - t0)}ms`,
    );
  } finally {
    await c.close();
  }
}
await srv.close();
