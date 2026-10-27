// Quick probe: does launching steal focus, where does the window land, is the
// foreground tab visible, and does a background tab differ (headed vs headless)?
// node probe.ts [--headless]
import { execFileSync } from "node:child_process";

import {
  cadence,
  launchChrome,
  openTab,
  startFixtureServer,
  windowOf,
} from "./lib.ts";

const frontmost = () =>
  execFileSync("osascript", [
    "-e",
    'tell application "System Events" to set p to first process whose frontmost is true',
    "-e",
    'tell application "System Events" to get (name of p) & " " & (unix id of p)',
  ])
    .toString()
    .trim();

const headless = process.argv.includes("--headless");
const srv = await startFixtureServer();
console.log("frontmost before:", frontmost());
const c = await launchChrome({
  headless,
  noDefaults: !process.argv.includes("--defaults"),
});
try {
  const fg = await openTab(c, srv.url + "/fixture");
  const bg = await openTab(c, srv.url + "/fixture", { background: true });
  console.log("frontmost after:", frontmost(), "ours:", c.pid);
  console.log(
    "window:",
    JSON.stringify((await windowOf(c, fg.targetId)).bounds),
  );
  console.log("fg", JSON.stringify(await cadence(fg.session)));
  console.log("bg", JSON.stringify(await cadence(bg.session)));
} finally {
  await c.close();
  await srv.close();
}
