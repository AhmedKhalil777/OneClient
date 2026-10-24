import type { ViewHostApi } from "@oneclient/plugin-api";

/** Core views (file editor, terminal) run in sandboxed view hosts, like plugin views: the view preload's API. */
declare global {
  interface Window {
    oneclientView: ViewHostApi;
  }
}
