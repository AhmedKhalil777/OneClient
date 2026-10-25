import { homedir } from "node:os";
import { join } from "node:path";

/** Where oneClient keeps per-user data: `$ONECLIENT_HOME`, else `~/.oneclient`. Read on every call (tests change it). */
export function dataHome(): string {
  return process.env.ONECLIENT_HOME?.trim() || join(homedir(), ".oneclient");
}
