import { defineConfig } from "vitest/config";
import { WxtVitest } from "wxt/testing/vitest-plugin";

// `WxtVitest()` replaces `wxt/browser` with WXT's `fakeBrowser`, which `src/background/fake-chrome.test-helper.ts` extends with the APIs it lacks
export default defineConfig({
  plugins: [WxtVitest()],
});
