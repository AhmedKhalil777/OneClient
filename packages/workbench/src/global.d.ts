import type { OneClientApi } from "@oneclient/backend/shared/ipc-contract.js";

declare global {
  interface Window {
    oneclient: OneClientApi;
  }
}
