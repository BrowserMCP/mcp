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

export async function takeSnapshot(page: Page): Promise<AriaNode[]> {
  const nodes = (await page.ariaSnapshotJSON({
    mode: "ai",
    timeout: 10_000,
  })) as AriaNode[];
  const prefix = /^(f\d+)e\d+$/.exec(nodes[0]?.ref ?? "")?.[1] ?? "";
  mainPrefixes.set(page, prefix);
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
  return nodes;
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

/** `-i`: drops what isn't kept and unnamed wrappers, keeping the ancestors of kept nodes */
export function interactiveOnly(nodes: AriaNode[]): AriaNode[] {
  const out: AriaNode[] = [];
  for (const node of nodes) {
    if (node.role === "text") continue;
    const children = interactiveOnly(node.children ?? []);
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

function truncate(text: string | undefined, max: number) {
  if (!text || text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}
