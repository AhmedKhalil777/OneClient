import { quoteIdent } from "./config.js";
import { requireSession } from "./sessions.js";

/** CREATE DATABASE for the Databases folder's "Create Database…". Only the optional collation needs checking: it can't be quoted. */
export async function createDatabase(connectionId: string, name: string, options: Record<string, unknown>): Promise<void> {
  const collation = String(options.collation ?? "").trim();
  if (collation && !/^[A-Za-z0-9_]+$/.test(collation)) throw new Error("The collation name can only contain letters, digits and _ (e.g. Latin1_General_100_CI_AS).");
  await requireSession(connectionId).pool.request().batch(`CREATE DATABASE ${quoteIdent(name)}${collation ? ` COLLATE ${collation}` : ""}`);
}
