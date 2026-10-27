// An extension's `wxt prepare` types `getURL()` with its own paths. This package has none, so the paths it uses are typed here, for its own typecheck only (the extensions importing it use theirs)
import "wxt/browser";

declare module "wxt/browser" {
  export interface WxtRuntime {
    getURL(path: "/popup.html"): string;
  }
}
