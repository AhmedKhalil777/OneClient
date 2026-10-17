# oneClient

One client for everything — a plug-and-play desktop console for infrastructure
tools (databases, REST APIs, message brokers, identity providers). The core
ships with zero infrastructure-specific code; all database/broker/IdP support
comes from installable plugins that extend the connection types, explorer
tree, views, and commands at runtime, with no rebuild or restart.

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the process topology,
contribution model, plugin lifecycle, and trust model, and
[`packages/plugin-api`](./packages/plugin-api) for the interfaces plugins
implement.

## Status

**Phase 2** (current): Electron + React shell — window layout, plugin
loader, extension-host supervisor, connection manager, command palette.
Phase 1 (`@oneclient/plugin-api` interfaces + `oneclient.json` schema +
architecture doc) is done.

## Repo layout

- `packages/plugin-api` — the only package plugins depend on
- `packages/core` — the Electron shell (Phase 2)
- `packages/plugins/*` — reference plugins: `oneclient-docker` (Phase 3,
  first real plugin), `oneclient-postgres` (Phase 4), `oneclient-kafka`
  (Phase 5, Tier 1 + Tier 2)

## Development

```sh
pnpm install
pnpm -r build
pnpm -r test
```
