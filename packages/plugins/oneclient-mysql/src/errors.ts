/** Fields mysql2 copies from the server's error packet. */
export interface MysqlErrorInfo {
  message: string;
  code?: string | undefined;
  errno?: number | undefined;
  sqlState?: string | undefined;
}

export function mysqlErrorInfo(err: unknown): MysqlErrorInfo {
  const e = err as { sqlMessage?: string; message?: string; code?: string; errno?: number; sqlState?: string };
  return { message: e?.sqlMessage ?? e?.message ?? String(err), code: e?.code, errno: e?.errno, sqlState: e?.sqlState };
}

/** Readable one-liner for connection failures, with hints for the usual local-dev ones. */
export function describeError(err: unknown): string {
  const { message, code } = mysqlErrorInfo(err);
  const raw = (err as { message?: string })?.message ?? message;
  if (code === "ECONNREFUSED" || /ECONNREFUSED/.test(raw)) return `${raw} — is MySQL running and listening on that host and port?`;
  if (code === "ENOTFOUND" || /ENOTFOUND|getaddrinfo/.test(raw)) return `${raw} — check the host name.`;
  if (code === "ER_ACCESS_DENIED_ERROR" || code === "ER_ACCESS_DENIED_NO_PASSWORD_ERROR") return `${message} — check the user name and password.`;
  if (code === "ER_BAD_DB_ERROR") return `${message} — check the database name.`;
  if (code === "ER_HOST_NOT_PRIVILEGED" || code === "HANDSHAKE_NO_SSL_SUPPORT") return `${message} — set SSL to "Disable" if the server has no TLS.`;
  if (/ssl|tls|certificate|self[- ]signed/i.test(raw) && !code?.startsWith("ER_")) return `${raw} — choose "Require (don't verify certificate)" for a self-signed server.`;
  if (code === "ETIMEDOUT" || /timeout/i.test(raw)) return `${raw} — the server didn't answer in time.`;
  if (code === "PROTOCOL_CONNECTION_LOST" || code === "ECONNRESET") return `${raw} — the server closed the connection.`;
  return message;
}
