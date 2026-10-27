// Does Chrome on this OS mark a fully covered window hidden? Tries a few cover
// geometries and reports visibility over time.
// node covered-probe.ts
import {
  cadence,
  evalRaw,
  launchChrome,
  openTab,
  setBounds,
  sleep,
  startFixtureServer,
  windowOf,
} from "./lib.ts";

const srv = await startFixtureServer();
const c = await launchChrome();
try {
  const agent = await openTab(c, srv.url + "/fixture");
  const agentWin = (await windowOf(c, agent.targetId)).windowId;
  await setBounds(c, agentWin, { left: 40, top: 600, width: 400, height: 300 });
  const cover = await openTab(c, srv.url + "/fixture", { newWindow: true });
  const coverWin = (await windowOf(c, cover.targetId)).windowId;
  await setBounds(c, coverWin, { left: 0, top: 480, width: 640, height: 500 });
  await cover.session.send("Page.bringToFront");
  for (const wait of [200, 1000, 3000]) {
    await sleep(wait);
    console.log(
      `after +${wait}ms`,
      await evalRaw(agent.session, "document.visibilityState"),
      (await windowOf(c, agent.targetId)).bounds,
      (await windowOf(c, cover.targetId)).bounds,
    );
  }
  const { execFileSync } = await import("node:child_process");
  console.log(
    "z-order (front first):",
    execFileSync("osascript", [
      "-l",
      "JavaScript",
      new URL("./windows.jxa.js", import.meta.url).pathname,
      String(c.pid),
    ])
      .toString()
      .trim(),
  );
  console.log("agent cadence", JSON.stringify(await cadence(agent.session)));
  console.log("cover cadence", JSON.stringify(await cadence(cover.session)));
  console.log(
    "visChanges",
    JSON.stringify(await evalRaw(agent.session, "__s.visChanges")),
  );
} finally {
  await c.close();
  await srv.close();
}
