interface ErrnoLike {
  code?: string;
}

/** Turns the raw ENOENT/ECONNREFUSED/EACCES Node errors dockerode throws into something a user can act on. */
export function describeDockerError(err: unknown): string {
  const code = (err as ErrnoLike)?.code;
  if (code === "ENOENT") {
    return "Could not reach the Docker daemon (socket/pipe not found). Is Docker Desktop/Engine running?";
  }
  if (code === "ECONNREFUSED") {
    return "Connection refused. Is the Docker daemon running and reachable at that address?";
  }
  if (code === "EACCES") {
    return "Permission denied talking to the Docker socket. Add your user to the \"docker\" group, or run with sufficient privileges.";
  }
  if (err instanceof Error) return err.message;
  return String(err);
}
