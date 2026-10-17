# @oneclient/plugin-api

The **only** package oneClient plugins are allowed to import. It has zero
runtime dependencies and exports nothing but TypeScript interfaces/types plus
one constant (`PLUGIN_API_VERSION`). Everything plugins see — connection
providers, explorer tree providers, command handlers, the Tier 1 form/grid
descriptors, the Tier 2 view-host contract, and the `PluginContext` passed to
`activate()` — lives here.

See [`../../ARCHITECTURE.md`](../../ARCHITECTURE.md) for how these interfaces
fit into the rest of the app, and
[`schema/oneclient-manifest.schema.json`](./schema/oneclient-manifest.schema.json)
for the `oneclient.json` manifest format (mirrors `src/manifest.ts` by hand —
keep both in sync when either changes).

## Layout

```
src/
  version.ts      PLUGIN_API_VERSION
  json-schema.ts  Minimal JSON Schema + UiSchema types for Tier 1 forms
  logging.ts      Logger
  secrets.ts      SecretStore
  connection.ts   ConnectionProvider / ConnectionHandle / ConnectionContext
  explorer.ts     ExplorerProvider / TreeNode / ExplorerContext
  commands.ts     CommandHandler / CommandContext
  ui.ts           Tier 1 TableResult/ColumnDescriptor; Tier 2 ViewHostApi/ViewMessageHandler
  manifest.ts     PluginManifest + contribution types (oneclient.json shape)
  context.ts      PluginContext, PluginModule (activate/deactivate)
  index.ts        public exports
schema/
  oneclient-manifest.schema.json   JSON Schema for oneclient.json
test/
  manifest-schema.test.ts          validates fixtures/ against the schema
```

## Why no implementation lives here

This package is pure contract. The core (Phase 2) implements the other half
of every interface above (the registries, the IPC marshalling, the generic
form/grid renderers, the view host). Reference plugins (Phase 3/4) are the
first real consumers.
