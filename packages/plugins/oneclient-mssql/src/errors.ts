/** SQL Server error details as `mssql`/tedious expose them on RequestError/ConnectionError. */
export interface SqlErrorInfo {
  number?: number | undefined;
  class?: number | undefined;
  state?: number | undefined;
  lineNumber?: number | undefined;
  procName?: string | undefined;
  message: string;
}

export function sqlErrorInfo(err: unknown): SqlErrorInfo {
  const e = err as Partial<SqlErrorInfo> & { message?: string; originalError?: { info?: Partial<SqlErrorInfo> } };
  const info = e.originalError?.info;
  return {
    number: e.number ?? info?.number,
    class: e.class ?? info?.class,
    state: e.state ?? info?.state,
    lineNumber: e.lineNumber ?? info?.lineNumber,
    procName: e.procName ?? info?.procName,
    message: info?.message ?? e.message ?? String(err),
  };
}

/** Readable one-liner for connection failures, with hints for the common local-dev ones. */
export function describeError(err: unknown): string {
  const { message } = sqlErrorInfo(err);
  const code = (err as { code?: string }).code;
  if (/self[- ]signed certificate|certificate/i.test(message)) {
    return `${message} — for a local/dev server, tick "Trust server certificate".`;
  }
  if (code === "ESOCKET" || /ECONNREFUSED|getaddrinfo/i.test(message)) {
    return `${message} — check the server name/port and that SQL Server accepts TCP connections.`;
  }
  if (code === "ETIMEOUT") return `${message} — the server didn't answer in time.`;
  return message;
}
