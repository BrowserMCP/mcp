import { describe, expect, it } from "vitest";

import {
  type AriaNode,
  find,
  interactiveOnly,
  render,
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
  it("keeps interactive elements, headings and named landmarks, dropping wrappers and text", () => {
    expect(render(interactiveOnly(tree)))
      .toBe(`- heading "Shop" [level=1] [ref=e2]
- navigation "Main" [ref=e4]:
  - link "Home" [url=/] [ref=e5]
  - link "New arrivals" [url=/new] [ref=e6]
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
