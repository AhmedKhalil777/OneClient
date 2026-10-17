import type { ViewHostApi } from "@oneclient/plugin-api";

// The host API core injects into every plugin view (see packages/core/src/preload/view.ts).
declare global {
  interface Window {
    oneclientView: ViewHostApi;
  }
}

export {};
