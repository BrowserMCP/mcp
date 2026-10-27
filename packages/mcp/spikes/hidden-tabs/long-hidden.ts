// A background tab hidden for over 5 minutes: does Chrome's intensive throttling
// (chained timers aligned to once a minute) kick in, does focus emulation prevent
// it, and do operations still work afterwards?
// node long-hidden.ts [minutes=6.5]
import {
  CORNER,
  cadence,
  evalRaw,
  launchChrome,
  openTab,
  printReport,
  runOps,
  sleep,
  startFixtureServer,
} from "./lib.ts";

const minutes = Number(process.argv[2] ?? 6.5);
const srv = await startFixtureServer();
const c = await launchChrome({
  bounds: { ...CORNER, left: CORNER.left + 520 },
});
try {
  await openTab(c, srv.url + "/fixture"); // the user's active tab
  const plain = await openTab(c, srv.url + "/fixture", { background: true });
  const emulated = await openTab(c, srv.url + "/fixture", { background: true });
  await emulated.session.send("Emulation.setFocusEmulationEnabled", {
    enabled: true,
  });
  const t0 = Date.now();
  const gapsSince = async (s: typeof plain.session, sinceMs: number) => {
    const t: number[] = await evalRaw(s, "__s.timers");
    const now: number = await evalRaw(s, "performance.now()");
    const recent = t.filter((x) => x > now - sinceMs);
    const gaps = recent.slice(1).map((x, i) => Math.round(x - recent[i]));
    return {
      fires: recent.length,
      maxGapMs: gaps.length ? Math.max(...gaps) : null,
    };
  };
  while (Date.now() - t0 < minutes * 60_000) {
    await sleep(30_000);
    const m = ((Date.now() - t0) / 60_000).toFixed(1);
    console.log(
      `t=${m}min plain(last 30s)=${JSON.stringify(await gapsSince(plain.session, 30_000))} emulated(last 30s)=${JSON.stringify(
        await gapsSince(emulated.session, 30_000),
      )}`,
    );
  }
  console.log(
    "plain cadence after",
    minutes,
    "min:",
    JSON.stringify(await cadence(plain.session, 3000)),
  );
  printReport(
    `background tab hidden ${minutes} min, no mitigation`,
    await runOps(plain.page, plain.session),
  );
  const t1 = performance.now();
  await plain.session.send("Emulation.setFocusEmulationEnabled", {
    enabled: true,
  });
  console.log(
    `setFocusEmulationEnabled took ${Math.round(performance.now() - t1)}ms`,
  );
  console.log(
    "plain cadence right after focus emulation:",
    JSON.stringify(await cadence(plain.session, 2000)),
  );
  printReport(
    `background tab hidden ${minutes} min, then focus emulation`,
    await runOps(plain.page, plain.session),
  );
  printReport(
    `background tab with focus emulation from the start`,
    await runOps(emulated.page, emulated.session),
  );
} finally {
  await c.close();
  await srv.close();
}
