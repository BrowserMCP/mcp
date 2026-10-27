/**
 * Browser control for the popup: its state from the background, and the messages that act on it. The background's side is `@browsermcp/extension-core`
 */
import { useCallback, useEffect, useState } from "react";

import { sendBrowserControlMessage } from "./messages";
import type { BrowserControlView } from "./types";

export {
  type BrowserControlMessages,
  sendBrowserControlMessage,
} from "./messages";
export * from "./types";

/** How often the open popup refreshes what it shows (the attached tabs live in the background's memory) */
const REFRESH_MS = 1000;

/** Browser control's state from the background, refreshed while the popup is open */
export function useBrowserControl() {
  const [view, setView] = useState<BrowserControlView | null>(null);
  const refresh = useCallback(async () => {
    try {
      setView(await sendBrowserControlMessage("getBrowserControl"));
    } catch (error) {
      console.warn("Couldn't get browser control's state", error);
    }
  }, []);
  useEffect(() => {
    void refresh();
    const interval = setInterval(() => void refresh(), REFRESH_MS);
    return () => clearInterval(interval);
  }, [refresh]);
  return [view, refresh] as const;
}
