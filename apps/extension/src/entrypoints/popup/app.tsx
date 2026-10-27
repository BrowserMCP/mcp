import { useEffect, useState } from "react";

import { sendBrowserControlMessage } from "@browsermcp/extension-core/popup";

import { BrowserControlPanel } from "@/components/browser-control-panel";
import { PopupHeader } from "@/components/popup-header";
import { SettingsScreen } from "@/components/settings-screen";

/**
 * The popup: the connection to the Browser MCP server, the AI apps using the browser, Stop and Resume, and the settings
 */
export function App() {
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Starts the background if Chrome stopped it, and has it look for the Browser MCP server now
  useEffect(() => {
    sendBrowserControlMessage("ping").catch((error: unknown) => {
      console.warn("Couldn't reach the background", error);
    });
  }, []);

  if (settingsOpen) {
    return <SettingsScreen onBack={() => setSettingsOpen(false)} />;
  }

  return (
    // The panel's status and footer run edge to edge, so each part pads itself
    <div className="w-80 text-[13px]">
      <PopupHeader onOpenSettings={() => setSettingsOpen(true)} />
      <BrowserControlPanel />
    </div>
  );
}
