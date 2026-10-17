import type { OneClientApi } from "../../shared/ipc-contract";

declare global {
  interface Window {
    oneclient: OneClientApi;
  }
}
