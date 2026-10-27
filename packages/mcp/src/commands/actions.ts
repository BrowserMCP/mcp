/**
 * Finding elements and acting on them.
 *
 * Pointer actions check actionability themselves (scroll into view, visible, enabled, not covered, by hit-testing the element's center) and then use Playwright's action with `force`, which skips Playwright's own checks (its stability check waits for animation frames). They first make sure Chrome renders the tab (`hiddenTabs.ensureVisible`): mouse input sent to a hidden tab hangs and lands later.
 */
import type { ElementHandle, Locator, Page, Request } from "playwright-core";

import { hiddenTabs } from "@/commands/hidden-tabs";
import { sleep, StepError } from "@/commands/output";
import { type Target, toLocator } from "@/commands/targets";

/** How long locators wait for an element to appear */
export const FIND_TIMEOUT_MS = 5000;
/** How long pointer actions wait for an element to become visible, enabled and uncovered */
const ACTIONABLE_TIMEOUT_MS = 3000;

export function staleRefMessage(ref: string) {
  return `Ref ${ref} isn't on the page anymore. Run \`snapshot -i\` or use a locator`;
}

/** Resolves a target to exactly one element, waiting for a locator to match */
export async function resolveOne(
  page: Page,
  target: Target,
  timeout = FIND_TIMEOUT_MS,
): Promise<Locator> {
  const locator = toLocator(page, target);
  if (target.kind === "ref") {
    const count = await locator.count().catch(() => 0);
    if (count === 0) throw new StepError(staleRefMessage(target.ref));
    return locator;
  }
  const deadline = Date.now() + timeout;
  for (;;) {
    let count: number;
    try {
      count = await locator.count();
    } catch (error) {
      throw new StepError(
        `${target.source} isn't a valid target: ${String((error as Error).message).split("\n")[0]}. Use a ref, a locator such as getByRole('button', { name: 'Submit' }), or a CSS selector`,
      );
    }
    if (count === 1) return locator;
    if (count > 1) {
      throw new StepError(
        `${target.source} matched ${count} elements. Use a ref from \`snapshot -i\`, add { exact: true }, or pick one with .first() or .nth(i)`,
      );
    }
    if (Date.now() >= deadline) {
      throw new StepError(
        `Nothing matches ${target.source}. Run \`find "<text>"\` or \`snapshot -i\` to see what's on the page`,
      );
    }
    await sleep(100);
  }
}

type Actionability =
  | { ok: true; retargeted: boolean }
  | { ok: false; reason: "hidden" | "disabled" | "outside" }
  | { ok: false; reason: "covered"; by: string };

/**
 * Scrolls the element into view and hit-tests its center. A visually hidden checkbox, radio or file input is retargeted to its visible label, as users click those
 */
async function checkActionable(
  handle: ElementHandle<Element>,
): Promise<{ state: Actionability; handle: ElementHandle<Element> }> {
  const labelHandle = await handle.evaluateHandle((el) => {
    const input = el as HTMLInputElement;
    const box = el.getBoundingClientRect();
    const hidden =
      box.width === 0 ||
      box.height === 0 ||
      getComputedStyle(el).visibility === "hidden" ||
      getComputedStyle(el).opacity === "0";
    if (hidden && input.labels?.length) {
      for (const label of input.labels) {
        if (label.getBoundingClientRect().width > 0) return label;
      }
    }
    return el;
  });
  const target = (labelHandle.asElement() ?? handle) as ElementHandle<Element>;
  const state = await target.evaluate((el): Actionability => {
    const view = el.ownerDocument!.defaultView ?? window;
    let box = el.getBoundingClientRect();
    if (
      box.bottom <= 0 ||
      box.right <= 0 ||
      box.top >= view.innerHeight ||
      box.left >= view.innerWidth
    ) {
      el.scrollIntoView({
        block: "center",
        inline: "center",
        behavior: "instant",
      });
      box = el.getBoundingClientRect();
    }
    const style = view.getComputedStyle(el);
    if (box.width === 0 || box.height === 0 || style.visibility === "hidden") {
      return { ok: false, reason: "hidden" };
    }
    if (
      (el as HTMLButtonElement).disabled ||
      el.getAttribute("aria-disabled") === "true"
    ) {
      return { ok: false, reason: "disabled" };
    }
    const x = box.left + Math.min(box.width, view.innerWidth - box.left) / 2;
    const y = box.top + Math.min(box.height, view.innerHeight - box.top) / 2;
    if (x < 0 || y < 0) return { ok: false, reason: "outside" };
    let hit: Element | null = el.ownerDocument!.elementFromPoint(x, y);
    while (hit?.shadowRoot) {
      const inner = hit.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === hit) break;
      hit = inner;
    }
    const within = (node: Node | null) => {
      for (
        let n = node;
        n;
        n = n.parentNode ?? (n as ShadowRoot).host ?? null
      ) {
        if (n === el) return true;
      }
      return false;
    };
    if (!hit || within(hit)) return { ok: true, retargeted: false };
    // A label for the element, e.g. a styled checkbox, receives the click for it
    if ((el as HTMLInputElement).labels) {
      for (const label of (el as HTMLInputElement).labels ?? []) {
        if (label === hit || label.contains(hit)) {
          return { ok: true, retargeted: false };
        }
      }
    }
    const describe = (node: Element) => {
      const id = node.id ? `#${node.id}` : "";
      const cls =
        !id && typeof node.className === "string" && node.className.trim()
          ? `.${node.className.trim().split(/\s+/)[0]}`
          : "";
      return `<${node.tagName.toLowerCase()}${id}${cls}>`;
    };
    return { ok: false, reason: "covered", by: describe(hit) };
  });
  if (state.ok && target !== handle) state.retargeted = true;
  return { state, handle: target };
}

export type PointerTarget = { handle: ElementHandle; x: number; y: number };

/** Waits until the element can take pointer input, and returns the point to use (main frame coordinates) */
export async function preparePointer(
  locator: Locator,
  source: string,
): Promise<PointerTarget> {
  const handle = (await locator.elementHandle({
    timeout: FIND_TIMEOUT_MS,
  })) as ElementHandle<Element> | null;
  if (!handle) throw new StepError(`Nothing matches ${source}`);
  const deadline = Date.now() + ACTIONABLE_TIMEOUT_MS;
  for (;;) {
    const { state, handle: target } = await checkActionable(handle);
    if (state.ok) {
      const box = await target.boundingBox();
      if (box) {
        return {
          handle: target,
          x: box.x + box.width / 2,
          y: box.y + box.height / 2,
        };
      }
    } else if (Date.now() >= deadline) {
      if (state.reason === "covered") {
        throw new StepError(
          `${source} is covered by \`${state.by}\`. Close or dismiss it first`,
        );
      }
      throw new StepError(
        state.reason === "disabled"
          ? `${source} is disabled`
          : `${source} isn't visible`,
      );
    }
    await sleep(100);
  }
}

export type ClickOptions = {
  button?: "left" | "right" | "middle";
  clickCount?: number;
  modifiers?: ("Alt" | "Control" | "ControlOrMeta" | "Meta" | "Shift")[];
};

export async function click(
  page: Page,
  target: PointerTarget,
  options: ClickOptions = {},
) {
  await hiddenTabs.ensureVisible(page);
  await moveCursor(page, target.x, target.y);
  await target.handle.click({ ...options, force: true, timeout: 5000 });
}

export async function hover(page: Page, target: PointerTarget) {
  await hiddenTabs.ensureVisible(page);
  await moveCursor(page, target.x, target.y);
  await target.handle.hover({ force: true, timeout: 5000 });
}

export async function drag(page: Page, from: PointerTarget, to: PointerTarget) {
  await hiddenTabs.ensureVisible(page);
  await moveCursor(page, from.x, from.y);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await moveCursor(page, to.x, to.y);
  await page.mouse.up();
}

// --- Cursor overlay ---

/**
 * Shows where the agent acts, unlike the user's own cursor (a small black arrow): a large blue arrow with a glow and a "Browser MCP" label, gliding to each point in about 300 ms. It's `aria-hidden` (out of snapshots), `pointer-events: none` (out of hit-testing) and lives on `<html>`, outside `body`
 */
export async function moveCursor(page: Page, x: number, y: number) {
  await page
    .evaluate(
      ([x, y]) => {
        const id = "__browsermcp_cursor";
        let host = document.getElementById(id);
        if (!host) {
          host = document.createElement("browsermcp-cursor");
          host.id = id;
          host.setAttribute("aria-hidden", "true");
          host.style.cssText =
            "position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none;transition:transform 300ms ease-out;";
          host.style.transform = `translate(${x}px, ${y}px)`;
          host.attachShadow({ mode: "closed" }).innerHTML = `
            <style>
              .arrow { position:absolute; left:-3px; top:-3px; filter:drop-shadow(0 2px 3px rgba(0,0,0,.45)) drop-shadow(0 0 6px rgba(37,99,235,.9)); }
              .label { position:absolute; left:22px; top:26px; padding:3px 9px; border-radius:999px; background:#2563eb; color:#fff; font:600 12px/16px system-ui,-apple-system,sans-serif; white-space:nowrap; border:1.5px solid #fff; box-shadow:0 2px 6px rgba(0,0,0,.35); }
            </style>
            <svg class="arrow" width="30" height="36" viewBox="0 0 20 24"><path d="M1 1 L1 19 L6 14.5 L9.5 22 L12.5 20.7 L9 13.3 L15.5 13 Z" fill="#2563eb" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>
            <div class="label">Browser MCP</div>`;
          document.documentElement.appendChild(host);
        }
        host.style.transform = `translate(${x}px, ${y}px)`;
      },
      [x, y],
    )
    .catch(() => {});
}

export async function setCursorHidden(page: Page, hidden: boolean) {
  await page
    .evaluate((hidden) => {
      const host = document.getElementById("__browsermcp_cursor");
      if (host) host.style.visibility = hidden ? "hidden" : "visible";
    }, hidden)
    .catch(() => {});
}

/**
 * Waits for the page's load event, up to `timeout`. Returns false on timeout. Also checks `document.readyState`, since a page restored from the back/forward cache doesn't fire `load` again
 */
export async function waitForLoad(
  page: Page,
  timeout = NAVIGATION_LOAD_MS,
): Promise<boolean> {
  const deadline = Date.now() + timeout;
  let loaded = false;
  const event = page
    .waitForLoadState("load", { timeout })
    .then(() => (loaded = true))
    .catch(() => {});
  while (!loaded && Date.now() < deadline) {
    const state = await page
      .evaluate(() => document.readyState)
      .catch(() => "loading");
    if (state === "complete") return true;
    await Promise.race([event, sleep(100)]);
  }
  return loaded;
}

// --- Settling ---

/** How long after an action a navigation may start and still be waited for */
const NAVIGATION_START_MS = 500;
const NAVIGATION_LOAD_MS = 10_000;

/**
 * Runs an action, then waits for a navigation it started within 500 ms to load (up to 10 s), so the next step sees the new page. Returns whether the load timed out
 */
export async function withSettle<T>(
  page: Page,
  action: () => Promise<T>,
): Promise<{ result: T; loadTimedOut: boolean }> {
  let navigation: Request | null = null;
  let navigationEnded = false;
  let committed = false;
  const onRequest = (request: Request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
      navigation = request;
      navigationEnded = false;
    }
  };
  const onEnd = (request: Request) => {
    if (request === navigation) navigationEnded = true;
  };
  const onNavigated = (frame: unknown) => {
    if (frame === page.mainFrame()) committed = true;
  };
  page.on("request", onRequest);
  page.on("requestfinished", onEnd);
  page.on("requestfailed", onEnd);
  page.on("framenavigated", onNavigated);
  try {
    const result = await action();
    const startBy = Date.now() + NAVIGATION_START_MS;
    while (!navigation && !committed && Date.now() < startBy) await sleep(25);
    let loadTimedOut = false;
    if (navigation || committed) {
      const deadline = Date.now() + NAVIGATION_LOAD_MS;
      let endedAt = 0;
      while (!committed && Date.now() < deadline) {
        // A navigation that ends without committing (a download, 204, an error) leaves the page as it was
        if (navigationEnded) {
          endedAt ||= Date.now();
          if (Date.now() - endedAt > 300) break;
        }
        await sleep(25);
      }
      if (committed) {
        await page
          .waitForLoadState("load", {
            timeout: Math.max(1, deadline - Date.now()),
          })
          .catch(() => {
            loadTimedOut = true;
          });
      }
    }
    return { result, loadTimedOut };
  } finally {
    page.off("request", onRequest);
    page.off("requestfinished", onEnd);
    page.off("requestfailed", onEnd);
    page.off("framenavigated", onNavigated);
  }
}
