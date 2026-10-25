import { quoteIdent } from "./config.js";
import { poolFor } from "./sessions.js";

/** CREATE DATABASE for the Databases folder's "Create Database…". Only the optional encoding needs checking: it can't be quoted as an identifier. */
export async function createDatabase(connectionId: string, name: string, options: Record<string, unknown>): Promise<void> {
  const encoding = String(options.encoding ?? "").trim();
  if (encoding && !/^[A-Za-z0-9_-]+$/.test(encoding)) throw new Error("The encoding can only contain letters, digits, _ and - (e.g. UTF8, LATIN1).");
  // A non-default encoding needs the pristine template: template1 may already hold data in another one.
  await poolFor(connectionId).query(`CREATE DATABASE ${quoteIdent(name)}${encoding ? ` TEMPLATE template0 ENCODING '${encoding}'` : ""}`);
}
