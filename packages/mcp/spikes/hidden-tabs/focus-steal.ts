// Does Page.bringToFront (≈ chrome.tabs.update({active:true})) or opening a background tab /
// an unfocused window activate Chrome when the user is in another app?
// macOS only. Re-activates the app that was frontmost before the run (the user's), then
// measures which app is frontmost after each step.
// node focus-steal.ts
import { execFileSync } from "node:child_process";

import { launchChrome, openTab, sleep, startFixtureServer } from "./lib.ts";

const jxa = (src: string) =>
  execFileSync("osascript", ["-l", "JavaScript", "-e", src]).toString().trim();
const frontmostPid = () =>
  Number(
    jxa(
      "ObjC.import('AppKit'); $.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier",
    ),
  );
const activate = (pid: number) =>
  jxa(
    `ObjC.import('AppKit'); $.NSRunningApplication.runningApplicationWithProcessIdentifier(${pid}).activateWithOptions(0); 'ok'`,
  );

const userApp = frontmostPid();
const srv = await startFixtureServer();
const c = await launchChrome();
try {
  const url = srv.url + "/fixture";
  const user = await openTab(c, url);
  activate(userApp);
  await sleep(700);
  const check = async (step: string) => {
    await sleep(500);
    const f = frontmostPid();
    console.log(
      `${step}: frontmost = ${f === c.pid ? "OUR CHROME (focus stolen)" : f === userApp ? "the user's app" : f}`,
    );
    if (f !== userApp) {
      activate(userApp);
      await sleep(700);
    }
  };
  await check("baseline");
  const agent = await openTab(c, url, { background: true });
  await check("Target.createTarget background tab");
  await openTab(c, url, { newWindow: true, background: true });
  await check("Target.createTarget newWindow+background");
  await agent.session.send("Page.bringToFront");
  await check("Page.bringToFront on the agent's tab");
  await user.session.send("Page.bringToFront");
  await check("Page.bringToFront back on the user's tab");
  await agent.session.send("Emulation.setFocusEmulationEnabled", {
    enabled: true,
  });
  await check("Emulation.setFocusEmulationEnabled");
} finally {
  await c.close();
  await srv.close();
  activate(userApp);
}
