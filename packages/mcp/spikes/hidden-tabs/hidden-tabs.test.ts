// Hidden tabs in a real, headed Chrome with no automation flags.
// Opens windows on screen, so it only runs with BROWSER_MCP_HEADED_TESTS=1:
//   BROWSER_MCP_HEADED_TESTS=1 pnpm --filter @browsermcp/mcp exec vitest run spikes/hidden-tabs
// The hidden-for-over-5-minutes case takes ~6 minutes; BROWSER_MCP_HIDDEN_MINUTES shortens it.
import type { CDPSession, Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  cadence,
  evalRaw,
  launchChrome,
  runOps,
  sleep,
  startFixtureServer,
  timed,
  type OpResult,
} from "./lib.ts";
import { CASES } from "./measure.ts";

const enabled = process.env.BROWSER_MCP_HEADED_TESTS === "1";
const coveredWorks =
  process.platform === "darwin" || process.platform === "win32"; // OS occlusion tracking
const hiddenMinutes = Number(process.env.BROWSER_MCP_HIDDEN_MINUTES ?? 5.5);

let srv: Awaited<ReturnType<typeof startFixtureServer>>;
beforeAll(async () => {
  if (enabled) srv = await startFixtureServer();
});
afterAll(async () => {
  await srv?.close();
});

async function inCase<T>(
  name: keyof typeof CASES,
  fn: (a: { page: Page; session: CDPSession }) => Promise<T>,
) {
  const c = await launchChrome();
  try {
    return await fn(await CASES[name](c, srv.url + "/fixture"));
  } finally {
    await c.close();
  }
}

const ok = (r: unknown) => (r as OpResult).ok;

describe.skipIf(!enabled)(
  "hidden tabs in headed Chrome without automation flags",
  () => {
    const cases = [
      "background",
      "minimized",
      ...(coveredWorks ? (["covered", "ownWindowBehind"] as const) : []),
    ] as const;

    for (const name of cases) {
      test(`${name}: hidden, so rendering stops and Playwright's click times out`, async () => {
        await inCase(name, async ({ page, session }) => {
          const cad = await cadence(session, 2500);
          expect(cad.visibility).toBe("hidden");
          expect(cad.rafPerSec).toBe(0);
          expect(cad.timerFires).toBeLessThanOrEqual(4); // a 50 ms timer, at most once a second (~50 when visible)
          expect(
            ok(await timed(() => page.click("#btn", { timeout: 1500 }), 1500)),
          ).toBe(false);
          // These don't need a frame
          expect(
            ok(
              await timed(
                () => page.fill("#inp", "x", { timeout: 1500 }),
                1500,
              ),
            ),
          ).toBe(true);
          expect(
            ok(
              await timed(
                () => page.ariaSnapshot({ mode: "ai", timeout: 1500 } as any),
                1500,
              ),
            ),
          ).toBe(true);
        });
      }, 60_000);

      test(`${name}: Emulation.setFocusEmulationEnabled makes it render: click, lazy list, screenshot`, async () => {
        await inCase(name, async ({ page, session }) => {
          await session.send("Emulation.setFocusEmulationEnabled", {
            enabled: true,
          });
          const r = await runOps(page, session, 3000, name);
          expect((r.cadence as any).visibility).toBe("visible");
          expect((r.cadence as any).rafPerSec).toBeGreaterThan(20);
          for (const op of [
            "pwClick",
            "pwFill",
            "cdpClick",
            "wheel",
            "scrollIntoView",
            "screenshot",
            "ariaSnapshot",
          ])
            expect(ok(r[op]), op).toBe(true);
          expect((r.pwClick as OpResult).note).toBe("clicks +1");
          const lazy = r.lazy as {
            items: string;
            imgsLoaded: string;
            ioSeen: number;
          };
          const [i0, i1] = lazy.items.split("→").map(Number);
          const [m0, m1] = lazy.imgsLoaded.split("→").map(Number);
          expect(i1).toBeGreaterThan(i0); // infinite scroll appended a batch
          expect(m1).toBeGreaterThan(m0); // loading=lazy images loaded
          expect(lazy.ioSeen).toBeGreaterThan(0); // IntersectionObserver fired
        });
      }, 60_000);
    }

    test("background: Page.setWebLifecycleState({state:'active'}) doesn't help", async () => {
      await inCase("background", async ({ session }) => {
        await session.send("Page.setWebLifecycleState", { state: "active" });
        const cad = await cadence(session, 1500);
        expect(cad.visibility).toBe("hidden");
        expect(cad.rafPerSec).toBe(0);
      });
    }, 60_000);

    test("background: detaching the session ends focus emulation", async () => {
      const c = await launchChrome();
      try {
        const { page, session } = await CASES.background(
          c,
          srv.url + "/fixture",
        );
        await session.send("Emulation.setFocusEmulationEnabled", {
          enabled: true,
        });
        expect(await evalRaw(session, "document.visibilityState")).toBe(
          "visible",
        );
        await session.detach();
        const s2 = await c.browser.contexts()[0].newCDPSession(page);
        await sleep(200);
        expect(await evalRaw(s2, "document.visibilityState")).toBe("hidden");
      } finally {
        await c.close();
      }
    }, 60_000);

    test(
      `background: hidden for ${hiddenMinutes} min, chained timers throttle to once a minute; focus emulation recovers at once`,
      async () => {
        await inCase("background", async ({ page, session }) => {
          await sleep(hiddenMinutes * 60_000);
          const fires = await evalRaw<number>(
            session,
            "(() => { const now = performance.now(); return __s.timers.filter((t) => t > now - 30000).length; })()",
          );
          // A 50 ms chained timer: ~600 fires in 30 s when visible, 30 when hidden,
          // at most 1 once intensive throttling aligns it to once a minute.
          expect(fires).toBeLessThanOrEqual(1);
          await session.send("Emulation.setFocusEmulationEnabled", {
            enabled: true,
          });
          const cad = await cadence(session, 1500);
          expect(cad.rafPerSec).toBeGreaterThan(20);
          expect(cad.timerMedianMs).toBeLessThan(200);
          expect(
            ok(await timed(() => page.click("#btn", { timeout: 3000 }), 3000)),
          ).toBe(true);
        });
      },
      (hiddenMinutes + 2) * 60_000,
    );
  },
);
