/** Fields node-postgres copies from the server's ErrorResponse. */
export interface PgErrorInfo {
  message: string;
  code?: string | undefined;
  severity?: string | undefined;
  detail?: string | undefined;
  hint?: string | undefined;
  /** 1-based character offset into the submitted text. */
  position?: number | undefined;
  where?: string | undefined;
}

export function pgErrorInfo(err: unknown): PgErrorInfo {
  const e = err as { message?: string; code?: string; severity?: string; detail?: string; hint?: string; position?: string; where?: string };
  return {
    message: e?.message ?? String(err),
    code: e?.code,
    severity: e?.severity,
    detail: e?.detail,
    hint: e?.hint,
    position: e?.position ? Number(e.position) : undefined,
    where: e?.where,
  };
}

/** Readable one-liner for connection failures, with hints for the usual local-dev ones. */
export function describeError(err: unknown): string {
  const { message, code } = pgErrorInfo(err);
  if (code === "ECONNREFUSED" || /ECONNREFUSED/.test(message)) return `${message} — is PostgreSQL running and listening on that host and port?`;
  if (code === "ENOTFOUND" || /ENOTFOUND|getaddrinfo/.test(message)) return `${message} — check the host name.`;
  if (code === "28P01") return `${message} — check the user name and password.`;
  if (code === "3D000") return `${message} — check the database name.`;
  if (/does not support SSL|server does not support/i.test(message)) return `${message} — set SSL to "Disable".`;
  if (/no pg_hba\.conf entry.*no encryption/i.test(message)) return `${message} — the server requires SSL: set SSL to "Require".`;
  if (/self[- ]signed|certificate/i.test(message)) return `${message} — choose "Require (don't verify certificate)" for a self-signed server.`;
  if (/timeout/i.test(message)) return `${message} — the server didn't answer in time.`;
  return message;
}
