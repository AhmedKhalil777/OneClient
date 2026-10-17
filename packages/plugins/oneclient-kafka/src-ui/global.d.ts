import type { ViewHostApi } from "@oneclient/plugin-api";

declare global {
  interface Window {
    oneclientView: ViewHostApi;
  }
}
