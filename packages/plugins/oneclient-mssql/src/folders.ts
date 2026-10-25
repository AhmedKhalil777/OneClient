import { createFolderStore } from "@oneclient/sql-core";

/** The connection's Fast Tools folder (fast queries and fakers), shared with the SQL core (see main.ts). */
export const folders = createFolderStore("mssql");
