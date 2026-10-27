import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "wxt";

import { EXTENSION_KEY } from "./extension-key";

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ["@wxt-dev/module-react", "@wxt-dev/auto-icons"],
  srcDir: "src",
  manifestVersion: 3,
  autoIcons: {
    // Relative to `srcDir`
    baseIconPath: "assets/logo.svg",
  },
  // Building doesn't open a browser: load `.output/chrome-mv3` (or `chrome-mv3-dev`) unpacked in `chrome://extensions`
  webExt: { disabled: true },
  vite: () => ({ plugins: [tailwindcss()] }),
  manifest: {
    name: "Browser MCP (self-built)",
    description:
      "Lets AI apps use your browser through Browser MCP: built from source",
    key: EXTENSION_KEY,
    // `debugger` relays the daemon's CDP commands to the tabs agents use, `tabs` reports their URLs and titles, `tabGroups` makes each AI app's tab group, `webNavigation` finds tabs that pages open, `alarms` runs the connection's watchdog and `storage` keeps the extension's state. `<all_urls>` lets `scripting` and the content script (`frames.content.ts`, idle until asked) remove other extensions' frames (a password manager's inline menu), which block `debugger.attach()`
    host_permissions: ["<all_urls>"],
    permissions: [
      "alarms",
      "debugger",
      "scripting",
      "storage",
      "tabGroups",
      "tabs",
      "webNavigation",
    ],
    commands: {
      _execute_action: { suggested_key: { default: "Alt+J" } },
    },
  },
});
