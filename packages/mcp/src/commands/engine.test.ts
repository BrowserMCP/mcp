/** The engine against real headless Chromium (`LaunchedBackend`) and the fixture pages */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { stepLimits } from "@/commands/engine";
import { HIDDEN_TAB_MESSAGE, hiddenTabs } from "@/commands/hidden-tabs";
import { type Harness, startHarness } from "@/commands/testing/harness";

let h: Harness;
const u = (p: string) => h.fixtures.url(p);
/** A new session (so a new tab) per test */
const session = (capabilities: "cdp"[] = []) =>
  h.openSession("test-app", capabilities);

beforeAll(async () => {
  h = await startHarness();
});
afterAll(() => h?.close());
afterEach(() => {
  hiddenTabs.forceHidden = false;
});

describe("output policy", () => {
  it("prints one line per action, read output inline and a trailer", async () => {
    const s = session();
    const text = await h.run(
      s,
      `goto ${u("/form")}
fill getByLabel('Customer name') "Secret Name"
check getByLabel('Medium')
click getByRole('button', { name: 'Submit order' })
get text h1
goto ${u("/dialogs")}`,
    );
    expect(text).toBe(`✓ goto ${u("/form")}
✓ fill getByLabel('Customer name')
✓ check getByLabel('Medium')
✓ click getByRole('button', { name: 'Submit order' }) — → /post
✓ get text h1
Thanks, order received
✓ goto ${u("/dialogs")}
Page: ${u("/dialogs")} — "Dialogs"`);
    expect(text).not.toContain("Secret Name");
  });

  it("stops at the first error and says which steps didn't run", async () => {
    const s = session();
    const { text, isError } = await h.call(
      s,
      `goto ${u("/misc")}\nclick getByRole('button', { name: 'Nope' })\nclick e1\nget title`,
    );
    expect(isError).toBe(true);
    expect(text).toContain(
      "✗ step 2: click getByRole('button', { name: 'Nope' }) — Nothing matches getByRole('button', { name: 'Nope' })",
    );
    expect(text).toContain("Steps 3–4 not run");
    expect(text).toContain(`Page: ${u("/misc")} — "Misc"`);
  });

  it("reports unknown commands and flags", async () => {
    const s = session();
    expect(await h.run(s, "frobnicate")).toMatch(
      /^✗ step 1: frobnicate — Unknown command frobnicate\. Commands: goto,/,
    );
    expect(await h.run(s, "help click\nsnapshot --bogus")).toContain(
      "✗ step 2: snapshot --bogus — snapshot has no --bogus flag. Run `help snapshot`",
    );
  });

  it("runs none of a call's steps when any line is invalid, listing every bad line", async () => {
    const s = session();
    await h.run(s, `goto ${u("/form")}`);
    const { text, isError } = await h.call(
      s,
      `fill getByLabel('Customer name') "Jane"\nclik e1\nget value getByLabel('Customer name')\nsnapshot --bogus`,
    );
    expect(isError).toBe(true);
    expect(text).toMatch(/^✗ step 2: clik — Unknown command clik\./);
    expect(text).toContain(
      "✗ step 4: snapshot --bogus — snapshot has no --bogus flag. Run `help snapshot`",
    );
    expect(text).toContain(
      "Nothing ran: fix these lines and send the call again",
    );
    expect(text).not.toContain("✓");
    expect(await h.run(s, "get value getByLabel('Customer name')")).toBe(
      "✓ get value getByLabel('Customer name')\n",
    );
  });

  it("says how to start when there's no tab", async () => {
    const s = session();
    expect(await h.run(s, "snapshot -i")).toBe(
      "✗ step 1: snapshot -i — There's no tab yet: use `goto <url>`, or `tab list` and `tab select <id>` to use one of the user's tabs",
    );
  });

  it("caps reads and says how to read all of it or narrow them", async () => {
    const s = session();
    const text = await h.run(s, `goto ${u("/big")}\nsnapshot`);
    expect(text.length).toBeLessThan(10_400);
    expect(text).toMatch(
      /… cut at \d+ of \d+ characters: --max all reads the first 75000, or narrow it with `find/,
    );
    const more = await h.run(s, "snapshot --max 30000");
    expect(more.length).toBeGreaterThan(20_000);
    const all = await h.run(s, "snapshot --max all");
    expect(all.length).toBeGreaterThan(70_000);
    expect(all).toMatch(/… cut at \d+ of \d+ characters: narrow it with/);
    const small = await h.run(s, "get text --max 200");
    expect(small.length).toBeLessThan(500);
  });

  it("notes new console errors once", async () => {
    const s = session();
    await h.run(s, `goto ${u("/errors")}`);
    const text = await h.run(
      s,
      "click getByRole('button', { name: 'Break' })\nclick getByRole('button', { name: 'Log' })",
    );
    expect(text).toMatch(
      /✓ click getByRole\('button', \{ name: 'Break' \}\) — 1 new console error: TypeError: Cannot read properties of null/,
    );
    expect(text).toMatch(
      /✓ click getByRole\('button', \{ name: 'Log' \}\) — 1 new console error: logged error/,
    );
    const errors = await h.run(s, "console --errors");
    expect(errors).toMatch(
      /\[uncaught\] TypeError: Cannot read properties of null[^\n]*\n\s+at /,
    );
    expect(errors).toContain("[error] logged error");
  });

  it("keeps uncaught errors when a page logs a lot after them", async () => {
    const s = session();
    await h.run(
      s,
      `goto ${u("/errors")}\nclick getByRole('button', { name: 'Break' })\nclick getByRole('button', { name: 'Chatty' })`,
    );
    const text = await h.run(s, "console --errors");
    expect(text).toContain("[uncaught] TypeError");
    expect(text).not.toContain("chatter");
    expect(await h.run(s, "console")).toContain("chatter 599");
  });

  it("help lists every command, and details one", async () => {
    const s = session();
    const all = await h.run(s, "help");
    for (const name of ["goto", "click", "snapshot", "scroll", "help"])
      expect(all).toContain(name);
    expect(all).not.toContain("cdp <");
    expect(await h.run(session(["cdp"]), "help")).toContain("cdp <");
    expect(await h.run(s, "help cdp")).toContain("Needs --caps cdp.");
  });

  it("lists cdp in the tool definition only with --caps cdp", () => {
    const s = session();
    const description = (id: string) => h.engine.tools(id)[0].description;
    expect(description(s)).not.toMatch(/\bcdp\b/);
    expect(description(session(["cdp"]))).toMatch(/\bcdp\b/);
  });
});

describe("targets", () => {
  it("acts on refs, every locator form and CSS", async () => {
    const s = session();
    await h.run(s, `goto ${u("/misc")}`);
    const snapshot = await h.run(s, "snapshot -i");
    const ref = /button "Save" \[ref=(\w+)\]/.exec(snapshot)?.[1];
    expect(ref).toBeTruthy();
    expect(
      await h.run(s, `click ${ref}\nget text getByTestId('save')`),
    ).toContain("Saved");
    expect(
      await h.run(
        s,
        `fill getByPlaceholder('Search here') "kettle"
get value #search
select getByLabel('Color') "Green"
get value getByLabel('Color')
check getByRole('checkbox', { name: 'Agree' })
get count getByRole('button', { name: 'Item' })
get attr title getByText('Go to form')
get text getByRole('button').filter({ hasText: 'Item' }).nth(1)
get text locator('h1')`,
      ),
    ).toBe(`✓ fill getByPlaceholder('Search here')
✓ get value #search
kettle
✓ select getByLabel('Color') "Green"
✓ get value getByLabel('Color')
g
✓ check getByRole('checkbox', { name: 'Agree' })
✓ get count getByRole('button', { name: 'Item' })
3
✓ get attr title getByText('Go to form')
Form link
✓ get text getByRole('button').filter({ hasText: 'Item' }).nth(1)
Item
✓ get text locator('h1')
Misc`);
  });

  it("fails on several matches and stale refs", async () => {
    const s = session();
    await h.run(s, `goto ${u("/misc")}`);
    expect(
      await h.run(s, "click getByRole('button', { name: 'Item' })"),
    ).toContain("getByRole('button', { name: 'Item' }) matched 3 elements");
    const snapshot = await h.run(s, "snapshot -i");
    const ref = /button "Save" \[ref=(\w+)\]/.exec(snapshot)?.[1];
    await h.run(
      s,
      "eval \"() => document.querySelector('[data-testid=save]').remove()\"",
    );
    expect(await h.run(s, `click ${ref}`)).toContain(
      `Ref ${ref} isn't on the page anymore. Run \`snapshot -i\` or use a locator`,
    );
    // After navigating, the old page's refs fail too
    const link = /link "Go to form" .*\[ref=(\w+)\]/.exec(snapshot)?.[1];
    await h.run(s, `goto ${u("/misc")}`);
    expect(await h.run(s, `click ${link}`)).toContain(
      `Ref ${link} isn't on the page anymore`,
    );
  });

  it("keeps refs stable for elements that survive", async () => {
    const s = session();
    await h.run(s, `goto ${u("/misc")}`);
    const first = await h.run(s, "snapshot -i");
    await h.run(
      s,
      `eval "() => document.body.prepend(Object.assign(document.createElement('button'), { textContent: 'New' }))"`,
    );
    const second = await h.run(s, "snapshot -i");
    const ref = (text: string) => /button "Save" \[ref=(\w+)\]/.exec(text)?.[1];
    expect(ref(second)).toBe(ref(first));
  });

  it("waits for a locator to appear", async () => {
    const s = session();
    expect(
      await h.run(s, `goto ${u("/misc")}\nget text getByText('Loaded later')`),
    ).toContain("Loaded later");
  });

  it("reaches into iframes and shadow DOM", async () => {
    const s = session();
    await h.run(s, `goto ${u("/iframe")}`);
    const snapshot = await h.run(s, "snapshot -i");
    const ref = /button "Inner button" \[ref=(f\d+e\d+)\]/.exec(snapshot)?.[1];
    expect(ref).toBeTruthy();
    expect(await h.run(s, `click ${ref}\nget text ${ref}`)).toContain(
      "Inner clicked",
    );
    expect(
      await h.run(
        s,
        `fill frameLocator('iframe').getByLabel('Inner field') "hi"\nget value frameLocator('iframe').getByLabel('Inner field')`,
      ),
    ).toContain("hi");

    await h.run(s, `goto ${u("/shadow")}`);
    expect(
      await h.run(
        s,
        `click getByRole('button', { name: 'Shadow button' })\nfill getByLabel('Shadow field') "x"\nget text #out`,
      ),
    ).toContain("Shadow clicked");
  });
});

describe("snapshots and find", () => {
  it("scopes and limits depth without breaking refs elsewhere", async () => {
    const s = session();
    await h.run(s, `goto ${u("/repo")}`);
    const scoped = await h.run(
      s,
      "snapshot getByRole('navigation', { name: 'Repository' })",
    );
    expect(scoped).toContain('- navigation "Repository"');
    expect(scoped).not.toContain("Star");
    // A ref from outside the scope still works
    const star = /button "Star this repository" \[ref=(\w+)\]/.exec(
      await h.run(s, 'find "Star"'),
    )?.[1];
    await h.run(s, "snapshot getByRole('navigation', { name: 'Global' })");
    expect(await h.run(s, `get text ${star}`)).toContain("Star 1.2k");
    const shallow = await h.run(s, "snapshot --depth 2");
    expect(shallow).toContain("…");
    expect(
      shallow.split("\n").every((line) => !line.startsWith("      ")),
    ).toBe(true);
  });

  it("find prints matches with ancestors", async () => {
    const s = session();
    await h.run(s, `goto ${u("/list")}`);
    const text = await h.run(s, 'find "homelab"');
    expect(text).toBe('✓ find "homelab"\nNo matches for "homelab"');
    const news = await h.run(s, 'find "past"');
    expect(news).toMatch(/link "past" \[url=\/past\] \[ref=\w+\]/);
  });
});

describe("actions", () => {
  it("names what covers an element", async () => {
    const s = session();
    await h.run(s, `goto ${u("/covered")}`);
    expect(await h.run(s, "click #target")).toContain(
      "#target is covered by `<div#overlay>`. Close or dismiss it first",
    );
  });

  it("clicks through the modal flow once it's closed", async () => {
    const s = session();
    const text = await h.run(
      s,
      `goto ${u("/modal")}
click getByRole('button', { name: 'Close' })
click getByRole('button', { name: 'Read article' })
get text #out`,
    );
    expect(text).toContain("Article opened");
  });

  it("refuses input and screenshots in a tab Chrome doesn't render, rather than queueing them", async () => {
    const s = session();
    await h.run(s, `goto ${u("/misc")}`);
    hiddenTabs.forceHidden = true;
    for (const step of [
      "click #far",
      "hover #hoverme",
      "press Enter",
      "scroll down",
      "screenshot",
    ]) {
      expect(await h.run(s, step)).toContain(HIDDEN_TAB_MESSAGE);
    }
    // Reading still works
    expect(await h.run(s, "get text #far")).not.toContain("✗");
    hiddenTabs.forceHidden = false;
    expect(await h.run(s, "click #far\nget text #far")).toContain(
      "far clicked",
    );
  });

  it("scrolls the page, a scroll area or to a target, noting where it ended", async () => {
    const s = session();
    const text = await h.run(
      s,
      `goto ${u("/scroll")}
scroll down 500
scroll bottom
scroll up
scroll top
scroll bottom --in #deep
scroll #end
eval "() => [scrollY > 2000, pane.scrollTop > 0]"`,
    );
    expect(text).toMatch(/✓ scroll down 500 — at 500 of \d+ px/);
    expect(text).toMatch(/✓ scroll bottom — at the bottom of the page, \d+ px/);
    expect(text).toMatch(/✓ scroll up — at \d+ of \d+ px/);
    expect(text).toContain("✓ scroll top — at the top of the page");
    expect(text).toMatch(
      /✓ scroll bottom --in #deep — at the bottom of the scroll area, \d+ px/,
    );
    expect(text).toContain("[true,true]");
    expect(await h.run(s, "scroll top 100")).toContain(
      "scroll top takes no <px>",
    );
    expect(await h.run(s, "scroll #end --in #pane")).toContain(
      "scroll <target> takes no <px> or --in",
    );
  });

  it("scrolls an app's main pane when the page itself doesn't scroll", async () => {
    const s = session();
    const text = await h.run(
      s,
      `goto ${u("/app-shell")}
scroll Bottom
scroll down 10.5
eval "() => [document.querySelector('main').scrollTop > 3000, document.querySelector('nav').scrollTop]"`,
    );
    expect(text).toMatch(
      /✓ scroll Bottom — at the bottom of the scroll area, \d+ px/,
    );
    expect(text).toContain("[true,0]");
  });

  it("loads more of a feed by scrolling to the bottom", async () => {
    const s = session();
    const text = await h.run(
      s,
      `goto ${u("/feed")}
${Array.from({ length: 4 }, () => "scroll bottom\nwait 500").join("\n")}
find "lighthouse"
get text #sentinel`,
    );
    expect(text).toContain("Post 37: a lighthouse keeper's notes");
    expect(text).toContain("You're all caught up");
  });

  it("keeps a background tab rendering with focus emulation", async () => {
    const s = session();
    expect(
      await h.run(
        s,
        `goto ${u("/misc")}\neval "() => document.visibilityState"`,
      ),
    ).toContain('"visible"');
  });

  it("clicks with modifiers, right button and double click", async () => {
    const s = session();
    await h.run(s, `goto ${u("/misc")}`);
    await h.run(
      s,
      `eval "() => { const b = document.querySelector('#far'); for (const t of ['click','dblclick','contextmenu']) b.addEventListener(t, e => b.dataset[t] = e.shiftKey + ':' + e.button) }"`,
    );
    await h.run(
      s,
      "click #far --modifiers Shift\nclick #far --double\nclick #far --button right",
    );
    expect(await h.run(s, `eval "el => ({ ...el.dataset })" #far`)).toContain(
      '{"click":"false:0","dblclick":"false:0","contextmenu":"false:2"}',
    );
    expect(await h.run(s, "click #far --modifiers Hyper")).toContain(
      "--modifiers takes",
    );
  });

  it("types into the focused element, presses keys and waits", async () => {
    const s = session();
    const text = await h.run(
      s,
      `goto ${u("/search")}
click getByLabel('Search products')
type "lamp"
press Enter
wait --url **/search?q=lamp*
wait --text "5 results"
wait 50
get text getByRole('listitem').first()`,
    );
    expect(text).toContain("✓ type\n");
    // The trailer has the URL, so the last step's own note is dropped
    expect(text).toContain("✓ press Enter\n");
    expect(text).toContain(`Page: ${u("/search?q=lamp")} — "Search: lamp"`);
    expect(text).toContain("Red lamp 6");
    expect(await h.run(s, `wait --text "Nope" --timeout 300`)).toContain(
      "Timed out after 300 ms",
    );
    expect(
      await h.run(
        s,
        "click getByRole('link', { name: 'Next' })\nwait --gone \"Red lamp 6\"",
      ),
    ).not.toContain("✗");
  });

  it("goes back, forward and reloads", async () => {
    const s = session();
    await h.run(
      s,
      `goto ${u("/list")}\nclick getByRole('link', { name: 'new', exact: true })`,
    );
    expect(await h.run(s, "back\nforward")).toBe(
      "✓ back — → /list\n✓ forward — → /newest",
    );
    expect(await h.run(s, "reload\nget title")).toContain(
      "New Links | Hacker Newz",
    );
  });

  it("uploads files read through the session", async () => {
    const s = session();
    writeFileSync(path.join(h.root, "a.txt"), "hello");
    writeFileSync(path.join(h.root, "b.txt"), "hi");
    await h.run(s, `goto ${u("/upload")}`);
    expect(await h.run(s, "upload #file a.txt b.txt\nget text #out")).toContain(
      "a.txt:5,b.txt:2",
    );
    expect(
      await h.run(
        s,
        "upload getByRole('button', { name: 'Choose' }) b.txt\nget text #out",
      ),
    ).toContain("b.txt:2");
    expect(await h.run(s, "upload #file ../missing.txt")).toContain("ENOENT");
  });

  it("evaluates functions and expressions in the page", async () => {
    const s = session();
    await h.run(s, `goto ${u("/misc")}`);
    expect(await h.run(s, `eval "() => document.title"`)).toContain('"Misc"');
    expect(await h.run(s, `eval "1 + 1"`)).toContain("\n2");
    expect(await h.run(s, `eval "async el => el.textContent" h1`)).toContain(
      '"Misc"',
    );
    expect(
      await h.run(s, `eval "() => { throw new Error('nope') }"`),
    ).toContain("nope");
  });

  it("runs eval's code with its own escapes", async () => {
    const s = session();
    await h.run(s, `goto ${u("/misc")}`);
    expect(await h.run(s, `eval "() => ['a', 'b'].join('\\n')"`)).toContain(
      '"a\\nb"',
    );
    expect(await h.run(s, `eval "() => /\\d+/.exec('x42')[0]"`)).toContain(
      '"42"',
    );
  });

  it("lists console messages and requests", async () => {
    const s = session();
    await h.run(s, `goto ${u("/misc")}\nwait 200`);
    expect(await h.run(s, "console")).toContain("[log] hello from misc");
    const requests = await h.run(s, "requests");
    expect(requests).toMatch(/#\d+ GET 200 .*\/misc/);
    expect(requests).toMatch(/#(\d+) GET 200 .*\/api\/data/);
    const id = /#(\d+) GET 200 .*\/api\/data/.exec(requests)?.[1];
    const detail = await h.run(s, `request ${id} --body`);
    expect(detail).toContain("content-type: application/json");
    expect(detail).toContain('{"ok":true');
    expect(await h.run(s, 'requests --filter "api"')).not.toContain("/misc");
  });

  it("takes JPEG screenshots that fit, and saves them", async () => {
    const s = session();
    await h.run(s, `goto ${u("/big")}`);
    const { result, text } = await h.call(
      s,
      "screenshot --full --path shot.jpg",
    );
    const image = result.content.find((item) => item.type === "image") as {
      data: string;
      mimeType: string;
    };
    expect(image.mimeType).toBe("image/jpeg");
    const [, width, height] = /(\d+)×(\d+) JPEG/.exec(text) ?? [];
    expect(Math.max(Number(width), Number(height))).toBeLessThanOrEqual(1568);
    expect(text).toContain(`saved to ${path.join(h.root, "shot.jpg")}`);
  });
});

describe("dialogs", () => {
  it("ends the batch on a dialog and answers it", async () => {
    const s = session();
    await h.run(s, `goto ${u("/dialogs")}`);
    const text = await h.run(
      s,
      "click getByRole('button', { name: 'Confirm' })\nget text #out",
    );
    expect(text).toContain(
      "✓ click getByRole('button', { name: 'Confirm' }) — confirm dialog \"Sure?\" opened. Answer it with `dialog accept` or `dialog dismiss`",
    );
    expect(text).toContain("Step 2 not run (a dialog is open)");
    expect(await h.run(s, "get title")).toContain("is open. Answer it with");
    expect(await h.run(s, "dialog accept\nget text #out")).toContain(
      "✓ dialog accept\n✓ get text #out\nyes",
    );
    await h.run(s, "click getByRole('button', { name: 'Prompt' })");
    const prompt = await h.run(s, 'dialog accept "Ada"\nget text #out');
    expect(prompt).toContain("Ada");
    expect(prompt).not.toContain('"Ada"');
    expect(await h.run(s, "dialog dismiss")).toContain("No dialog is open");
  });
});

describe("tabs", () => {
  it("opens its own tab in the app's group, lists and closes tabs", async () => {
    const s = session();
    await h.run(s, `goto ${u("/misc")}`);
    const userTab = await h.backend.openUserTab(u("/repo"));
    const list = await h.run(s, "tab list");
    expect(list).toMatch(
      new RegExp(`\\* (\\d+) "Misc" — ${u("/misc")} \\(yours\\)`),
    );
    expect(list).toContain(`${userTab} "acme/widget: Widgets for everyone"`);
    const own = Number(/\* (\d+)/.exec(list)?.[1]);
    expect(h.backend.appOf(own)).toBe("test-app");
    expect(await h.run(s, `tab close ${userTab}`)).toContain(
      `Tab ${userTab} isn't one you opened`,
    );
    expect(await h.run(s, `tab select ${userTab}\nget title`)).toContain(
      "acme/widget",
    );
    expect(h.backend.appOf(userTab)).toBe("test-app");
    expect(await h.run(s, `tab close ${own}`)).toContain(`✓ tab close ${own}`);
    expect(h.backend.tabs().some((tab) => tab.tabId === own)).toBe(false);
    expect(await h.run(s, "tab new\ntab list")).toMatch(
      /\* \d+ "" — about:blank \(yours\)/,
    );
  });

  it("notes tabs that pages open and lets the agent switch to them", async () => {
    const s = session();
    await h.run(s, `goto ${u("/popup")}`);
    const text = await h.run(
      s,
      "click getByRole('link', { name: 'Open form' })",
    );
    expect(text).toMatch(/opened tab \d+ "Pizza order"/);
    const tabId = /opened tab (\d+)/.exec(text)?.[1];
    expect(tabId).toBeTruthy();
    expect(h.backend.appOf(Number(tabId))).toBe("test-app");
    expect(await h.run(s, `tab select ${tabId}\nget title`)).toContain(
      "Pizza order",
    );
    expect(await h.run(s, `tab close ${tabId}`)).not.toContain("✗");
  });

  it("uses a tab dragged into the app's group", async () => {
    const s = session();
    await h.run(s, `goto ${u("/misc")}`);
    const dragged = await h.backend.openUserTab(u("/repo"));
    h.backend.assign(dragged, "test-app");
    expect(await h.run(s, "get title")).toContain("acme/widget");
    h.backend.assign(dragged, null);
    await new Promise((r) => setTimeout(r, 100));
    expect(h.backend.isClaimed(dragged)).toBe(false);
    expect(await h.run(s, "get title")).toContain("There's no tab yet");
  });

  it("serializes calls on the same tab", async () => {
    const s1 = session();
    await h.run(s1, `goto ${u("/misc")}`);
    const tabId = Number(/\* (\d+)/.exec(await h.run(s1, "tab list"))?.[1]);
    const s2 = session();
    await h.run(s2, `tab select ${tabId}`);
    const order: string[] = [];
    await Promise.all([
      h.run(s1, 'wait 300\neval "() => 1"').then(() => order.push("s1")),
      new Promise((r) => setTimeout(r, 50))
        .then(() => h.run(s2, "get title"))
        .then(() => order.push("s2")),
    ]);
    expect(order).toEqual(["s1", "s2"]);
  });

  it("releases tabs when the session closes, keeping them open", async () => {
    const s = session();
    await h.run(s, `goto ${u("/misc")}`);
    const tabId = Number(/\* (\d+)/.exec(await h.run(s, "tab list"))?.[1]);
    expect(h.backend.isClaimed(tabId)).toBe(true);
    await h.engine.closeSession(s);
    expect(h.backend.isClaimed(tabId)).toBe(false);
    expect(h.backend.tabs().some((tab) => tab.tabId === tabId)).toBe(true);
  });

  it("passes on the backend's pause and unavailable messages", async () => {
    const s = session();
    h.backend.unavailable =
      "Click Allow in the Browser MCP extension's popup. The code is 482 913";
    expect(await h.run(s, `goto ${u("/misc")}`)).toBe(
      "Click Allow in the Browser MCP extension's popup. The code is 482 913",
    );
    h.backend.unavailable = null;
    h.backend.setPaused(true);
    expect(await h.run(s, "tab list")).toBe(
      "The user paused Browser MCP. Ask them to click Resume in its popup",
    );
    expect(await h.run(s, "help goto")).toContain("goto <url>");
    h.backend.setPaused(false);
  });
});

describe("cdp", () => {
  it("answers with the flag that turns it on", async () => {
    const s = session();
    expect(await h.run(s, "cdp Runtime.evaluate {}")).toContain(
      "`cdp` is off. Start @browsermcp/mcp with `--caps cdp` to turn it on",
    );
  });

  it("sends commands, buffers events and cleans up on release", async () => {
    const s = session(["cdp"]);
    await h.run(s, `goto ${u("/misc")}`);
    const tabId = Number(/\* (\d+)/.exec(await h.run(s, "tab list"))?.[1]);
    expect(
      await h.run(
        s,
        `cdp Runtime.evaluate {"expression":"1+2","returnByValue":true}`,
      ),
    ).toContain('{"result":{"type":"number","value":3,"description":"3"}}');
    const text = await h.run(
      s,
      `cdp Network.enable
cdp on Network.requestWillBeSent
cdp Network.setExtraHTTPHeaders {"headers":{"x-agent":"yes"}}
cdp Emulation.setEmulatedMedia {"media":"print"}
reload
cdp events Network.requestWillBeSent --max 2000`,
    );
    expect(text).toContain("Network.requestWillBeSent {");
    expect(
      await h.run(s, `eval "() => matchMedia('print').matches"`),
    ).toContain("true");
    // The debugger pauses: every result says so until it resumes
    await h.run(s, "cdp Debugger.enable");
    const paused = h.run(
      s,
      `cdp Debugger.pause\ncdp wait Debugger.paused --timeout 3000`,
    );
    setTimeout(
      () =>
        void h.backend
          .pageOf(tabId)
          .evaluate("1")
          .catch(() => {}),
      200,
    );
    expect(await paused).toContain("⏸ The debugger is paused");
    expect(await h.run(s, "cdp Debugger.resume")).not.toContain("⏸");

    await h.engine.closeSession(s);
    const page = h.backend.pageOf(tabId);
    expect(await page.evaluate(() => matchMedia("print").matches)).toBe(false);
    const headers = await Promise.all([
      page.waitForRequest(/misc/),
      page.reload(),
    ]).then(([request]) => request.allHeaders());
    expect(headers["x-agent"]).toBeUndefined();
  });
});

/** The current tab's ID, from `tab list` */
const currentTabId = async (s: string) =>
  Number(/\* (\d+)/.exec(await h.run(s, "tab list"))?.[1]);

describe("steps that hang", () => {
  it("abandons a step that never finishes and frees its tab", async () => {
    const s = session();
    await h.run(s, `goto ${u("/misc")}`);
    const tabId = await currentTabId(s);
    const defaults = { ...stepLimits };
    stepLimits.defaultMs = 1000;
    try {
      const { text, isError } = await h.call(
        s,
        `eval "() => new Promise(() => {})"\nget title`,
      );
      expect(isError).toBe(true);
      expect(text).toContain(
        '✗ step 1: eval "() => new Promise(() => {})" — Timed out after 1 s',
      );
      expect(text).toContain("Step 2 not run");
    } finally {
      Object.assign(stepLimits, defaults);
    }
    // The tab is free for this session and others
    expect(await h.run(s, "get title")).toContain("Misc");
    const other = session();
    expect(await h.run(other, `tab select ${tabId}\nget title`)).toContain(
      "Misc",
    );
  });

  it("refuses wait and goto while a dialog is open, and answers it after", async () => {
    const s = session();
    await h.run(s, `goto ${u("/dialogs")}`);
    expect(
      await h.run(s, "click getByRole('button', { name: 'Alert' })"),
    ).toContain("alert dialog");
    const started = Date.now();
    expect(await h.run(s, 'wait --text "x" --timeout 1000')).toContain(
      'alert dialog "Hello there" is open',
    );
    expect(await h.run(s, `goto ${u("/misc")}`)).toContain("is open");
    expect(Date.now() - started).toBeLessThan(5000);
    // wait <ms> and tab commands still run
    expect(await h.run(s, "wait 10\ntab list")).not.toContain("✗");
    expect(await h.run(s, "dialog accept\nget title")).toContain("Dialogs");
  });

  it("clears a dialog the user answered in Chrome", async () => {
    const s = session();
    await h.run(s, `goto ${u("/dialogs")}`);
    const tabId = await currentTabId(s);
    // Stands in for the user's Chrome (attaching hangs while a dialog is open)
    const cdp = await h.backend.cdpSession(tabId);
    await cdp.send("Page.enable");
    await h.run(s, "click getByRole('button', { name: 'Confirm' })");
    expect(await h.run(s, "get text #out")).toContain("is open");
    await cdp.send("Page.handleJavaScriptDialog", { accept: true });
    await cdp.detach();
    await new Promise((r) => setTimeout(r, 100));
    expect(await h.run(s, "get text #out")).toBe("✓ get text #out\nyes");
  });
});

describe("typed text", () => {
  it("isn't echoed back when a line is invalid", async () => {
    const s = session();
    await h.run(s, `goto ${u("/form")}`);
    const cases: [string, string][] = [
      [
        `fill getByLabel('Telephone') "hunter2" --bogus`,
        "✗ step 1: fill getByLabel('Telephone') — fill has no --bogus flag",
      ],
      [`fill e1 "hunt\\er2"`, "✗ step 1: fill — Bad escaping"],
      [`fill "hunter2"`, "✗ step 1: fill — fill takes a target and the text"],
      [
        `fill getByLabel('Telephone') hunter2 more`,
        "✗ step 1: fill getByLabel('Telephone') — fill takes at most 2 arguments, got 3",
      ],
      [`type "hunter2" --bogus`, "✗ step 1: type — type has no --bogus flag"],
      [
        `dialog accept "hunter2" --bogus`,
        "✗ step 1: dialog accept — dialog has",
      ],
      [`dialog "hunter2"`, "✗ step 1: dialog — "],
      [`fil e1 "hunter2"`, "✗ step 1: fil — Unknown command fil"],
    ];
    for (const [line, expected] of cases) {
      const { text, isError } = await h.call(s, `get title\n${line}`);
      expect(isError, line).toBe(true);
      expect(text, line).toContain(expected.replace("step 1", "step 2"));
      expect(text, line).not.toContain("hunt");
    }
  });

  it("takes single-quoted text and refuses extra arguments", async () => {
    const s = session();
    await h.run(s, `goto ${u("/form")}`);
    expect(
      await h.run(
        s,
        `fill getByLabel('Customer name') 'Jane Doe'\nget value getByLabel('Customer name')`,
      ),
    ).toContain("\nJane Doe");
    expect(await h.run(s, "back now")).toContain(
      "back takes no arguments, got 1",
    );
  });
});

describe("locks", () => {
  it("locks the tab a call moves to", async () => {
    const owner = session();
    await h.run(owner, `goto ${u("/misc")}`);
    const tabId = await currentTabId(owner);
    const mover = session();
    const order: string[] = [];
    await Promise.all([
      h
        .run(mover, `tab select ${tabId}\nwait 300\neval "() => 1"`)
        .then(() => order.push("mover")),
      new Promise((r) => setTimeout(r, 100))
        .then(() => h.run(owner, "get title"))
        .then(() => order.push("owner")),
    ]);
    expect(order).toEqual(["mover", "owner"]);
  });
});

describe("response limits", () => {
  it("keeps status lines and the trailer when output fills the response", async () => {
    const s = session();
    await h.run(s, `goto ${u("/misc")}`);
    const big = `eval "() => 'x'.repeat(60000)" --max all`;
    const { text } = await h.call(
      s,
      `${big}\n${big}\nclick getByRole('button', { name: 'Nope' })`,
    );
    expect(text.length).toBeLessThanOrEqual(80_000);
    expect(text).toContain("the response is capped at 80000 characters");
    expect(text).toContain("✗ step 3: click");
    expect(text).toContain(`Page: ${u("/misc")} — "Misc"`);
  });

  it("caps images per response", async () => {
    const s = session();
    await h.run(s, `goto ${u("/misc")}`);
    const { result, text } = await h.call(
      s,
      "screenshot\nscreenshot\nscreenshot\nscreenshot",
    );
    expect(result.content.filter((item) => item.type === "image")).toHaveLength(
      3,
    );
    expect(text).toContain("image left out: at most 3 per response");
  });
});

describe("idle release", () => {
  it("releases tabs idle longer than idleReleaseMs and claims them again on use", async () => {
    const idle = await startHarness({ idleReleaseMs: 300 });
    try {
      const s = idle.openSession();
      await idle.run(s, `goto ${idle.fixtures.url("/misc")}`);
      const tabId = Number(/\* (\d+)/.exec(await idle.run(s, "tab list"))?.[1]);
      expect(idle.backend.isClaimed(tabId)).toBe(true);
      await new Promise((r) => setTimeout(r, 700));
      expect(idle.backend.isClaimed(tabId)).toBe(false);
      expect(await idle.run(s, "get title")).toContain("Misc");
      expect(idle.backend.isClaimed(tabId)).toBe(true);
    } finally {
      await idle.close();
    }
  });
});

describe("zoom", () => {
  it("clicks land at 125% zoom", async () => {
    const zoomed = await startHarness({ zoom: 1.25 });
    try {
      const s = zoomed.openSession();
      await zoomed.run(s, `goto ${zoomed.fixtures.url("/zoom")}`);
      expect(await zoomed.run(s, `eval "() => devicePixelRatio"`)).toContain(
        "1.25",
      );
      for (const i of [0, 7, 11]) {
        expect(
          await zoomed.run(
            s,
            `click getByRole('button', { name: 'B${i}', exact: true })\nget text #out`,
          ),
        ).toContain(`clicked ${i}`);
      }
    } finally {
      await zoomed.close();
    }
  });
});
