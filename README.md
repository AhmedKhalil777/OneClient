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

**Phase 1** (current): monorepo layout, `@oneclient/plugin-api` interfaces,
the `oneclient.json` manifest JSON Schema, and this architecture doc. No
app yet — that starts in Phase 2.

## Repo layout

- `packages/plugin-api` — the only package plugins depend on
- `packages/core` — the Electron shell (Phase 2)
- `packages/plugins/*` — reference plugins: `oneclient-postgres` (Phase 3,
  Tier 1), `oneclient-kafka` (Phase 4, Tier 1 + Tier 2)

## Development

```sh
pnpm install
pnpm -r build
pnpm -r test
```
