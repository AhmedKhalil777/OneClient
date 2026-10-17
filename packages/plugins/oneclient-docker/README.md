# oneclient-docker (Phase 3 — first reference plugin)

Reference plugin, not implemented yet. Connects to the local (or remote)
Docker Engine API and gives oneClient its first real contribution:

- **Tier 1**: connection form (socket/named-pipe path or `tcp://host:port` +
  TLS), explorer nodes for containers / images / volumes / networks,
  commands (start/stop/restart/remove container, pull image).
- **Tier 2 (likely)**: a live log-tailing view, same pattern
  `oneclient-kafka`'s message browser will use later — Docker's log/stats
  endpoints are streams, which is exactly what Tier 1's static
  `TableResult` can't express.

**Client library**: [`dockerode`](https://github.com/apocas/dockerode) —
pure JS, talks to the Docker Engine API over a Unix socket
(`/var/run/docker.sock` on macOS/Linux) or a named pipe
(`\\.\pipe\docker_engine` on Windows). No native/node-gyp dependency, so no
per-OS prebuilt-binary concerns — just an OS-conditional transport path in
`connect()`. Requires the user to have Docker Desktop/Engine installed and
running; `test()` should give a clear error when the socket/pipe isn't
reachable rather than a raw ECONNREFUSED.
