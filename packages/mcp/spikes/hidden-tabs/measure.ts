// Case × mitigation matrix: each run gets a fresh headed Chrome (no automation flags),
// sets up one case, applies one page-level mitigation (what chrome.debugger allows),
// and runs every operation with a timeout.
// node measure.ts [case,...] [--mitigations=none,focus,...] [--json=out.json]
import { writeFileSync } from "node:fs";
import type { CDPSession, Page } from "playwright-core";

import {
  evalRaw,
  launchChrome,
  openTab,
  printReport,
  runOps,
  setBounds,
  sleep,
  startFixtureServer,
  windowOf,
  type Chrome,
} from "./lib.ts";

// The agent's window, and a larger one that covers it (macOS clamps windows to 500px wide).
export const AGENT_BOUNDS = { left: 40, top: 600, width: 500, height: 360 };
export const COVER_BOUNDS = { left: 0, top: 480, width: 640, height: 500 };

/** macOS reports occlusion after a delay (~1-3 s); wait for it so the case is really covered. */
export async function waitHidden(session: CDPSession, timeoutMs = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if ((await evalRaw(session, "document.visibilityState")) === "hidden")
      return Date.now() - t0;
    await sleep(100);
  }
  console.log("  (warning: the covered window never became hidden)");
  return -1;
}

type Agent = { page: Page; session: CDPSession; targetId: string };

/** Each case returns the agent's tab; the user's tab (if any) is active in the user's window. */
export const CASES: Record<string, (c: Chrome, url: string) => Promise<Agent>> =
  {
    // Control: the agent's tab is the active tab of a visible window.
    foreground: async (c, url) => openTab(c, url),
    // A background tab in the same window as the user's active tab.
    background: async (c, url) => {
      await openTab(c, url);
      return openTab(c, url, { background: true });
    },
    // The agent's tab is active in its own window, and a larger window covers it.
    covered: async (c, url) => {
      const agent = await openTab(c, url);
      await setBounds(
        c,
        (await windowOf(c, agent.targetId)).windowId,
        AGENT_BOUNDS,
      );
      const cover = await openTab(c, url, { newWindow: true });
      await setBounds(
        c,
        (await windowOf(c, cover.targetId)).windowId,
        COVER_BOUNDS,
      );
      await cover.session.send("Page.bringToFront");
      await waitHidden(agent.session);
      return agent;
    },
    // The agent's tab is active in a minimized window.
    minimized: async (c, url) => {
      await openTab(c, url); // user's window
      const agent = await openTab(c, url, { newWindow: true });
      await setBounds(c, (await windowOf(c, agent.targetId)).windowId, {
        windowState: "minimized",
      });
      await sleep(800);
      return agent;
    },
    // The agents' own unfocused window, then the user goes back to their (larger) window, which covers it.
    ownWindowBehind: async (c, url) => {
      const user = await openTab(c, url);
      await setBounds(
        c,
        (await windowOf(c, user.targetId)).windowId,
        COVER_BOUNDS,
      );
      const agent = await openTab(c, url, {
        newWindow: true,
        background: true,
      });
      await setBounds(
        c,
        (await windowOf(c, agent.targetId)).windowId,
        AGENT_BOUNDS,
      );
      await user.session.send("Page.bringToFront");
      await waitHidden(agent.session);
      return agent;
    },
    // A window of the agents' own, opened unfocused (≈ chrome.windows.create({focused:false})).
    ownWindow: async (c, url) => {
      await openTab(c, url); // user's window
      const agent = await openTab(c, url, {
        newWindow: true,
        background: true,
      });
      await sleep(500);
      return agent;
    },
  };

export const MITIGATIONS: Record<string, (a: Agent) => Promise<void>> = {
  none: async () => {},
  focus: async (a) => {
    await a.session.send("Emulation.setFocusEmulationEnabled", {
      enabled: true,
    });
  },
  lifecycle: async (a) => {
    await a.session.send("Page.setWebLifecycleState", { state: "active" });
  },
  screencast: async (a) => {
    a.session.on("Page.screencastFrame", (f: any) =>
      a.session
        .send("Page.screencastFrameAck", { sessionId: f.sessionId })
        .catch(() => {}),
    );
    await a.session.send("Page.startScreencast", {
      format: "jpeg",
      quality: 10,
      maxWidth: 100,
      maxHeight: 100,
    });
  },
};

if (import.meta.main) {
  const args = process.argv.slice(2);
  const caseNames =
    args.find((a) => !a.startsWith("--"))?.split(",") ?? Object.keys(CASES);
  const mits =
    args
      .find((a) => a.startsWith("--mitigations="))
      ?.split("=")[1]
      .split(",") ?? Object.keys(MITIGATIONS);
  const jsonOut = args.find((a) => a.startsWith("--json="))?.split("=")[1];
  const headless = args.includes("--headless");
  const srv = await startFixtureServer();
  const results: Record<string, unknown> = {};
  try {
    for (const name of caseNames) {
      for (const m of mits) {
        const c = await launchChrome({ headless });
        try {
          const agent = await CASES[name](c, srv.url + "/fixture");
          await MITIGATIONS[m](agent);
          await sleep(300);
          const label = `${name}${headless ? " (headless)" : ""} + ${m}`;
          const r = await runOps(agent.page, agent.session, 3000, label);
          printReport(label, r);
          results[label] = r;
        } catch (e) {
          console.log(
            `\n=== ${name} + ${m}: setup failed: ${(e as Error).message}`,
          );
        } finally {
          await c.close();
        }
      }
    }
  } finally {
    await srv.close();
    if (jsonOut) writeFileSync(jsonOut, JSON.stringify(results, null, 2));
  }
}
