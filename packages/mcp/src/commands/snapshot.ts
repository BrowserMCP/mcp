/**
 * Snapshots from Playwright's AI mode (`ariaSnapshotJSON({ mode: "ai" })`), rendered in its YAML-like text format.
 *
 * Every read takes a full snapshot and filters it here (`-i`, a scope, `--depth`, `find`). A ref resolves against the latest snapshot of its frame, so a scoped Playwright snapshot would break every ref outside the scope.
 */
import type { Page } from "playwright-core";

export type AriaNode = {
  role: string;
  name?: string;
  text?: string;
  ref?: string;
  cursor?: string;
  url?: string;
  children?: AriaNode[];
  [key: string]: unknown;
};

/**
 * Playwright prefixes refs with their document's frame number (`f2e12`), and a page's main document gets a new number when it navigates. We show the main document's refs without it (`e12`) and add back the prefix seen at the last snapshot when resolving them, so a ref from before a navigation fails instead of hitting the new page's `f3e12`
 */
const mainPrefixes = new WeakMap<Page, string>();

export function fullRef(page: Page, ref: string): string {
  return /^e\d+$/.test(ref) ? (mainPrefixes.get(page) ?? "") + ref : ref;
}

export function shortRef(page: Page, ref: string): string {
  const prefix = mainPrefixes.get(page);
  return prefix && ref.startsWith(`${prefix}e`)
    ? ref.slice(prefix.length)
    : ref;
}

async function readSnapshot(
  page: Page,
): Promise<{ nodes: AriaNode[]; prefix: string }> {
  const nodes = (await page.ariaSnapshotJSON({
    mode: "ai",
    timeout: 10_000,
  })) as AriaNode[];
  const prefix = /^(f\d+)e\d+$/.exec(nodes[0]?.ref ?? "")?.[1] ?? "";
  if (prefix) {
    const strip = (list: AriaNode[]) => {
      for (const node of list) {
        if (node.ref?.startsWith(`${prefix}e`))
          node.ref = node.ref.slice(prefix.length);
        strip(node.children ?? []);
      }
    };
    strip(nodes);
  }
  return { nodes, prefix };
}

/** The agent's snapshot: its refs now resolve against this document (`fullRef`) */
export async function takeSnapshot(page: Page): Promise<AriaNode[]> {
  const { nodes, prefix } = await readSnapshot(page);
  mainPrefixes.set(page, prefix);
  return nodes;
}

/**
 * A snapshot the engine takes for itself (the change report): it doesn't touch which document the agent's refs resolve against, or a ref from before a navigation would hit the new page's element instead of failing. Returns the document's prefix, to tell whether the page navigated meanwhile
 */
export async function peekSnapshot(
  page: Page,
): Promise<{ nodes: AriaNode[]; prefix: string }> {
  return readSnapshot(page);
}

const INTERACTIVE = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "checkbox",
  "radio",
  "combobox",
  "listbox",
  "option",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "switch",
  "slider",
  "spinbutton",
  "treeitem",
]);
const LANDMARKS = new Set([
  "banner",
  "main",
  "navigation",
  "contentinfo",
  "complementary",
  "region",
  "form",
  "search",
  "dialog",
  "alertdialog",
]);
const CELLS = new Set(["cell", "gridcell", "columnheader", "rowheader"]);
const TRANSPARENT = new Set(["generic", "none", "presentation"]);
/** Layout roles `-i` drops when unnamed, keeping their children */
const LAYOUT = new Set([
  ...TRANSPARENT,
  "rowgroup",
  "strong",
  "emphasis",
  "paragraph",
  "group",
  "table",
  "list",
  "article",
  "section",
]);
/** Grouping roles `-i` keeps when they hold more than one kept child, so related elements stay together */
const GROUPS = new Set(["row", "listitem"]);
const OWN_KEYS = new Set([
  "role",
  "name",
  "text",
  "ref",
  "children",
  "cursor",
  "box",
]);

/** What `-i` keeps: interactive elements, named landmarks, headings and cells (plus their ancestors) */
function isKept(node: AriaNode): boolean {
  if (INTERACTIVE.has(node.role) || node.cursor === "pointer") return true;
  if (LANDMARKS.has(node.role)) return !!node.name || node.role === "main";
  if (CELLS.has(node.role)) return !!(node.name || node.text);
  return node.role === "heading";
}

/** Form controls whose purpose is usually given by the text before them, not by their own name */
export const FORM_CONTROLS = new Set([
  "textbox",
  "searchbox",
  "checkbox",
  "radio",
  "radiogroup",
  "combobox",
  "listbox",
  "switch",
  "slider",
  "spinbutton",
]);
export const LABEL_MAX = 160;

/** The visible text of a plain text node, or of an unnamed layout node that holds only text: a candidate label for the control after it */
function labelText(node: AriaNode): string | undefined {
  const raw =
    node.role === "text"
      ? node.text
      : LAYOUT.has(node.role) && !node.name && !node.children?.length
        ? node.text
        : undefined;
  const text = raw?.replace(/\s+/g, " ").trim();
  return text && text.length > 1 ? truncate(text, LABEL_MAX) : undefined;
}

/** `-i`: drops what isn't kept and unnamed wrappers, keeping the ancestors of kept nodes and the text right before a form control (its label) */
export function interactiveOnly(nodes: AriaNode[]): AriaNode[] {
  return keepLabelText(prune(nodes));
}

function prune(nodes: AriaNode[]): AriaNode[] {
  const out: AriaNode[] = [];
  for (const node of nodes) {
    const label = labelText(node);
    if (label) {
      out.push({ role: "text", text: label });
      continue;
    }
    if (node.role === "text") continue;
    const children = prune(node.children ?? []);
    const kept = isKept(node);
    if (!kept && children.length === 0) continue;
    const wrapper =
      !node.name &&
      (LAYOUT.has(node.role) ||
        CELLS.has(node.role) ||
        (GROUPS.has(node.role) && children.length === 1));
    if (!kept && wrapper) {
      out.push(...children);
      continue;
    }
    // Ancestors keep their role and name, not their text
    const { text, ...rest } = node;
    out.push({
      ...rest,
      ...(kept ? { text } : {}),
      name: kept ? node.name : truncate(node.name, 80),
      children,
    });
  }
  return out;
}

/** Drops the text nodes that aren't immediately followed by a form control, at every level */
function keepLabelText(nodes: AriaNode[]): AriaNode[] {
  const out: AriaNode[] = [];
  nodes.forEach((node, index) => {
    if (node.role === "text") {
      const next = nodes[index + 1];
      const echo =
        nodes[index - 1]?.name === node.text || next?.name === node.text;
      if (next && FORM_CONTROLS.has(next.role) && !echo) out.push(node);
      return;
    }
    out.push(
      node.children?.length
        ? { ...node, children: keepLabelText(node.children) }
        : node,
    );
  });
  return out;
}

/** What the change report compares: interactive nodes by ref, as the line they render to (without `active`, which changes with every click, or their value), and the page's short texts (messages, errors, headings) */
export type PageIndex = { controls: Map<string, string>; texts: Set<string> };

const TEXT_MAX = 200;
/** Text that's only an icon's ligature (Material icons render `add`, `help`, `info` as text) */
const ICON_TEXT = /^[a-z_]{2,24}$/;

export function pageIndex(nodes: AriaNode[]): PageIndex {
  const controls = new Map<string, string>();
  const texts = new Set<string>();
  const addText = (raw: unknown) => {
    const text = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
    if (text.length > 1 && text.length <= TEXT_MAX && !ICON_TEXT.test(text))
      texts.add(text);
  };
  const walk = (list: AriaNode[]) => {
    for (const node of list) {
      const control =
        node.ref &&
        (INTERACTIVE.has(node.role) || FORM_CONTROLS.has(node.role));
      if (control) {
        const { children, ...rest } = node;
        // Without the value: the agent knows what it typed (a password must not come back), and `form` shows values on request
        controls.set(
          node.ref as string,
          nodeLine({ ...rest, active: undefined, text: undefined }),
        );
      } else {
        addText(node.role === "text" ? node.text : (node.text ?? undefined));
        if (node.role === "heading" || node.role === "alert")
          addText(node.name);
      }
      walk(node.children ?? []);
    }
  };
  walk(nodes);
  return { controls, texts };
}

export function sameIndex(a: PageIndex, b: PageIndex): boolean {
  if (a.controls.size !== b.controls.size || a.texts.size !== b.texts.size)
    return false;
  for (const [ref, line] of a.controls)
    if (b.controls.get(ref) !== line) return false;
  for (const text of a.texts) if (!b.texts.has(text)) return false;
  return true;
}

/** What an action changed: new (`+`) and gone (`-`) interactive elements, and changed ones (`~`) unless `changed` is false (a fill or check changes its own field, which the agent expects), then texts that appeared (`+ text:`, error messages, toasts) or went away. Each list is capped; past the cap it says how many more, so a whole new step reads as a summary */
export function diffPage(
  before: PageIndex,
  after: PageIndex,
  { max = 10, changed = true } = {},
): string[] {
  const controls: string[] = [];
  for (const [ref, line] of after.controls) {
    const old = before.controls.get(ref);
    if (old === undefined) controls.push(`+ ${line}`);
    else if (changed && old !== line) controls.push(`~ ${line}`);
  }
  for (const [ref, line] of before.controls) {
    if (!after.controls.has(ref)) controls.push(`- ${line}`);
  }
  const added = [...after.texts].filter((text) => !before.texts.has(text));
  const gone = [...before.texts].filter((text) => !after.texts.has(text));
  const texts = [
    ...added.map((text) => `+ text: ${text}`),
    ...gone.map((text) => `- text: ${text}`),
  ];
  const textMax = Math.max(3, Math.floor(max / 2));
  const lines = controls.slice(0, max);
  if (controls.length > max)
    lines.push(
      `… ${controls.length - max} more element changes: run \`snapshot -i\``,
    );
  lines.push(...texts.slice(0, textMax));
  if (texts.length > textMax)
    lines.push(`… ${texts.length - textMax} more text changes`);
  return lines;
}

export function findByRef(
  nodes: AriaNode[],
  ref: string,
): AriaNode | undefined {
  for (const node of nodes) {
    if (node.ref === ref) return node;
    const found = findByRef(node.children ?? [], ref);
    if (found) return found;
  }
}

export function nodeLine(node: AriaNode): string {
  if (node.role === "text") return `text: ${node.text ?? ""}`;
  let line = node.role;
  if (node.name) line += ` ${JSON.stringify(node.name)}`;
  for (const [key, value] of Object.entries(node)) {
    if (OWN_KEYS.has(key) || value === undefined || value === false) continue;
    line += value === true ? ` [${key}]` : ` [${key}=${String(value)}]`;
  }
  if (node.ref) line += ` [ref=${node.ref}]`;
  if (
    node.cursor === "pointer" &&
    node.role !== "link" &&
    node.role !== "button"
  ) {
    line += " [cursor=pointer]";
  }
  if (node.text) line += `: ${node.text}`;
  return line;
}

/** Renders nodes as `- role "name" [ref=e1]: text` lines, two spaces per level. Nodes below `depth` are cut, marked with `…` */
export function render(nodes: AriaNode[], depth = Infinity): string {
  const lines: string[] = [];
  const walk = (list: AriaNode[], level: number) => {
    for (const node of list) {
      const children = node.children ?? [];
      const cut = level + 1 >= depth && children.length > 0;
      lines.push(
        `${"  ".repeat(level)}- ${nodeLine(node)}${cut ? " …" : children.length ? ":" : ""}`,
      );
      if (!cut) walk(children, level + 1);
    }
  };
  walk(nodes, 0);
  return lines.join("\n");
}

/** `find`: each node whose name, text or URL contains the text (ignoring case), with its ancestor path */
export function find(nodes: AriaNode[], query: string): string[] {
  const needle = query.toLowerCase();
  const matches: string[] = [];
  const walk = (list: AriaNode[], path: string[]) => {
    for (const node of list) {
      const own = [node.name, node.text, node.url]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(needle));
      const children = node.children ?? [];
      // A text fragment that matches shows as part of its parent's line
      const textChildMatch = children.some(
        (child) =>
          child.role === "text" &&
          (child.text ?? "").toLowerCase().includes(needle),
      );
      if (node.role !== "text" && (own || textChildMatch)) {
        const text = textChildMatch
          ? children
              .filter((child) => child.role === "text")
              .map((child) => child.text)
              .join(" ")
          : undefined;
        const line = nodeLine(text && !node.text ? { ...node, text } : node);
        matches.push(path.length ? `${path.join(" > ")} > ${line}` : line);
      }
      const label = pathLabel(node);
      walk(children, label ? [...path, label] : path);
    }
  };
  walk(nodes, []);
  return matches;
}

/** Ancestors shown in `find`'s paths: named elements and landmarks, not layout wrappers */
function pathLabel(node: AriaNode): string | undefined {
  if (node.name)
    return `${node.role} ${JSON.stringify(truncate(node.name, 40))}`;
  if (LANDMARKS.has(node.role) || node.role === "dialog") return node.role;
}

export function truncate(text: string | undefined, max: number) {
  if (!text || text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}
