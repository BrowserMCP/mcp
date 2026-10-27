/** What the page script returns: what it removed and saw, for the error when attaching still fails */
export interface FrameScan {
  removed: number;
  iframes: number;
  shadowRoots: number;
  hasDom: boolean;
  schemes: string[];
}

/** The message the background sends the content script (`@browsermcp/extension-core/content`) when another extension's frame blocks attaching */
export const REMOVE_FRAMES_MESSAGE = "browsermcp:removeExtensionFrames";

/**
 * Runs in the page: removes the iframes and embeds of extensions other than `ownId`, also from open and closed shadow roots, where password managers put their inline menus (the shadow host goes too when the frame was all that was in it). Closed shadow roots need `chrome.dom`, which content scripts in the manifest have. Returns how many frames it removed and what it saw. Self-contained, since `scripting.executeScript()` serializes it
 */
export function removeExtensionFrames(ownId: string): FrameScan {
  const scheme = "chrome-extension://";
  const dom = (
    globalThis as {
      chrome?: {
        dom?: { openOrClosedShadowRoot?: (el: Element) => ShadowRoot | null };
      };
    }
  ).chrome?.dom;
  let removed = 0;
  let iframes = 0;
  let shadowRoots = 0;
  const schemes = new Set<string>();
  const visit = (root: ParentNode) => {
    for (const element of root.querySelectorAll("*")) {
      // `openOrClosedShadowRoot()` throws for anything but an `HTMLElement` (an SVG icon, say)
      let shadow = element.shadowRoot;
      if (dom?.openOrClosedShadowRoot && element instanceof HTMLElement) {
        try {
          shadow = dom.openOrClosedShadowRoot(element) ?? shadow;
        } catch {
          // Keep the open shadow root, if any
        }
      }
      if (shadow) {
        shadowRoots++;
        const before = removed;
        visit(shadow);
        // The host the frame lived in would only be filled again, so it goes too when nothing but styles is left
        if (
          removed > before &&
          [...shadow.children].every((child) => child.matches("style, link"))
        ) {
          shadow.host.remove();
        }
      }
    }
    for (const frame of root.querySelectorAll("iframe, frame, embed, object")) {
      const url = frame.getAttribute("src") ?? frame.getAttribute("data") ?? "";
      iframes++;
      if (url.startsWith(scheme) && !url.startsWith(`${scheme}${ownId}/`)) {
        frame.remove();
        removed++;
      } else if (!/^https?:/.test(url)) {
        // Frames that might be an extension's but aren't recognized: only the URL's scheme, never its path or query, since the note goes into an error for the model
        const urlScheme = /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1];
        schemes.add(urlScheme ?? (url ? "relative" : "no src"));
      }
    }
  };
  visit(document);
  return {
    removed,
    iframes,
    shadowRoots,
    hasDom: !!dom,
    schemes: [...schemes],
  };
}
