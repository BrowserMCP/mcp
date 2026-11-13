import { describe, expect, it } from "vitest";

import {
  type AriaNode,
  diffPage,
  find,
  interactiveOnly,
  pageIndex,
  render,
  sameIndex,
} from "@/commands/snapshot";

const tree: AriaNode[] = [
  {
    role: "generic",
    ref: "e1",
    children: [
      { role: "heading", name: "Shop", level: 1, ref: "e2" },
      { role: "paragraph", ref: "e3", text: "Welcome to the shop" },
      {
        role: "navigation",
        name: "Main",
        ref: "e4",
        children: [
          {
            role: "link",
            name: "Home",
            url: "/",
            ref: "e5",
            cursor: "pointer",
          },
          {
            role: "link",
            name: "New arrivals",
            url: "/new",
            ref: "e6",
            cursor: "pointer",
          },
        ],
      },
      {
        role: "generic",
        ref: "e7",
        children: [
          { role: "text", text: "Subscribe to news" },
          { role: "textbox", name: "Email", ref: "e8" },
          { role: "checkbox", name: "Agree", checked: true, ref: "e9" },
        ],
      },
    ],
  },
];

describe("render", () => {
  it("renders Playwright's line format", () => {
    expect(render(tree)).toBe(`- generic [ref=e1]:
  - heading "Shop" [level=1] [ref=e2]
  - paragraph [ref=e3]: Welcome to the shop
  - navigation "Main" [ref=e4]:
    - link "Home" [url=/] [ref=e5]
    - link "New arrivals" [url=/new] [ref=e6]
  - generic [ref=e7]:
    - text: Subscribe to news
    - textbox "Email" [ref=e8]
    - checkbox "Agree" [checked] [ref=e9]`);
  });

  it("cuts at a depth, marking cut nodes", () => {
    expect(render(tree, 2)).toBe(`- generic [ref=e1]:
  - heading "Shop" [level=1] [ref=e2]
  - paragraph [ref=e3]: Welcome to the shop
  - navigation "Main" [ref=e4] …
  - generic [ref=e7] …`);
  });
});

describe("interactiveOnly", () => {
  it("keeps interactive elements, headings and named landmarks, dropping wrappers and text that doesn't label a form control", () => {
    expect(render(interactiveOnly(tree)))
      .toBe(`- heading "Shop" [level=1] [ref=e2]
- navigation "Main" [ref=e4]:
  - link "Home" [url=/] [ref=e5]
  - link "New arrivals" [url=/new] [ref=e6]
- text: Subscribe to news
- textbox "Email" [ref=e8]
- checkbox "Agree" [checked] [ref=e9]`);
  });
});

describe("find", () => {
  it("prints matching lines with their named ancestors", () => {
    expect(find(tree, "ARRIVALS")).toEqual([
      'navigation "Main" > link "New arrivals" [url=/new] [ref=e6]',
    ]);
    expect(find(tree, "subscribe")).toEqual([
      "generic [ref=e7]: Subscribe to news",
    ]);
    expect(find(tree, "nothing")).toEqual([]);
  });
});

describe("diffPage", () => {
  const row = (ref: string, extra: Partial<AriaNode> = {}): AriaNode => ({
    role: "textbox",
    name: "Link",
    ref,
    ...extra,
  });

  it("reports new, gone and changed elements, ignoring focus", () => {
    const before = pageIndex([
      row("e1", { active: true }),
      { role: "button", name: "Next", disabled: true, ref: "e2" },
      row("e3"),
    ]);
    const after = pageIndex([
      row("e1"),
      { role: "button", name: "Next", ref: "e2" },
      row("e4"),
    ]);
    expect(diffPage(before, after)).toEqual([
      '~ button "Next" [ref=e2]',
      '+ textbox "Link" [ref=e4]',
      '- textbox "Link" [ref=e3]',
    ]);
  });

  it("reports texts that appeared or went away, skipping icon ligatures", () => {
    const before = pageIndex([
      row("e1"),
      { role: "text", text: "Saving…" },
      { role: "text", text: "help" },
    ]);
    const after = pageIndex([
      row("e1"),
      { role: "generic", text: "This field is required" },
      { role: "text", text: "info" },
    ]);
    expect(diffPage(before, after)).toEqual([
      "+ text: This field is required",
      "- text: Saving…",
    ]);
  });

  it("leaves out changed elements when asked, and never shows values", () => {
    const before = pageIndex([
      { role: "textbox", name: "Password", ref: "e1", text: "" },
      { role: "button", name: "Next", disabled: true, ref: "e2" },
    ]);
    const after = pageIndex([
      { role: "textbox", name: "Password", ref: "e1", text: "hunter2" },
      { role: "button", name: "Next", ref: "e2" },
    ]);
    expect(diffPage(before, after)).toEqual(['~ button "Next" [ref=e2]']);
    expect(diffPage(before, after, { changed: false })).toEqual([]);
  });

  it("is empty when nothing changed", () => {
    const tree = [row("e1"), { role: "text", text: "Hello there" }];
    expect(sameIndex(pageIndex(tree), pageIndex(tree))).toBe(true);
    expect(diffPage(pageIndex(tree), pageIndex(tree))).toEqual([]);
  });

  it("caps the lists, saying how many more", () => {
    const after = pageIndex(
      Array.from({ length: 5 }, (_, i) => ({
        role: "button",
        name: `B${i}`,
        ref: `e${i}`,
      })),
    );
    expect(diffPage(pageIndex([]), after, { max: 2 })).toEqual([
      '+ button "B0" [ref=e0]',
      '+ button "B1" [ref=e1]',
      "… 3 more element changes: run `snapshot -i`",
    ]);
  });
});
