import { quoteIdent } from "./config.js";
import { poolFor } from "./sessions.js";

const WORD = /^[A-Za-z0-9_]+$/;

/** CREATE DATABASE for the Databases folder's "Create Database…" (utf8mb4 unless told otherwise). Charset and collation can't be quoted, so they are checked. */
export async function createDatabase(connectionId: string, name: string, options: Record<string, unknown>): Promise<void> {
  const charset = String(options.charset ?? "").trim() || "utf8mb4";
  const collation = String(options.collation ?? "").trim();
  if (!WORD.test(charset)) throw new Error("The character set can only contain letters, digits and _ (e.g. utf8mb4).");
  if (collation && !WORD.test(collation)) throw new Error("The collation can only contain letters, digits and _ (e.g. utf8mb4_0900_ai_ci).");
  await poolFor(connectionId).query(`CREATE DATABASE ${quoteIdent(name)} CHARACTER SET ${charset}${collation ? ` COLLATE ${collation}` : ""}`);
}
