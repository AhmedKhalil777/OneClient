# oneClient configuration files

Everything the app stores about itself lives in **`~/.oneclient/`** (override with the `ONECLIENT_HOME` environment variable):

| File | What | Safe to share? |
| --- | --- | --- |
| `oneclient.json` | Saved connections, the folders open in the Explorer (`workspace.folders`), which plugins are disabled, last-seen plugin versions, theme choices | Yes — it holds no secrets (folder paths are machine-specific, though) |
| `secrets.json` | Passwords / client secrets, each encrypted with the OS keychain (Electron `safeStorage`) | No — only the same OS user on the same machine can decrypt it |

There is no database. Both files are plain JSON, written atomically (temp file + rename).
A file that can't be parsed is set aside as `oneclient.json.broken-<time>` and the app starts fresh rather than overwriting it.

## Export / import connections

Command palette → **Connections: Export…** / **Export with Passwords (plain text)…** / **Import…**.

- An export is `{ format: "oneclient-connections", version, exportedAt, includesSecrets, plugins, connections }`.
  `plugins` records the plugin versions the connections were saved with.
- Passwords are **left out** unless you choose the plain-text variant (then treat the file like a password).
- Import accepts an export file or another `oneclient.json` (any file-format version — it is migrated first).
  Connections whose id already exists are skipped, so importing twice is harmless.
  The result warns when a connection's plugin isn't installed or is older than the one that saved it.
- Export documents are versioned too: an import refuses a file from a *newer* oneClient with a clear message.

## File format versions & migrations

`oneclient.json` has a top-level `"version"` (currently **2**); so does `secrets.json` (`{ "version": 1, "secrets": { … } }`).

On start-up:

1. **Older or unversioned file** → migrated in memory step by step (`MIGRATIONS` in `packages/core/src/main/config/config-store.ts`),
   the original is copied to `oneclient.json.v<N>.bak`, and the upgraded file is written back.
2. **Same version** → loaded as is.
3. **Newer version** (a downgrade) → the file is **not touched**; the app shows a message and quits, because guessing could lose data.

### Changing the format — the checklist

1. Bump `CONFIG_VERSION`.
2. Append a migration `{ from: <previous version>, describe, run(data) }` to `MIGRATIONS`. Never edit an existing migration.
3. Add a test in `packages/core/test/config-store.test.ts` that feeds a file of the old shape through `migrateConfig` / `new ConfigStore`.
4. Do the same for `secrets.json` (`SECRETS_VERSION` in `secrets/secret-store.ts`) and the export document (`EXPORT_VERSION`) if their shape changes.

History: **v1** normalized the shape; **v2** moved the Explorer's folders out of `connections` (they were connections of the
old Files plugin, `oneclient-files` / `folder`) into `workspace.folders` (same ids), when the Explorer became part of core.
Folders are not part of a connections export.

Adding an optional field does not need a migration, but it is still worth a version bump if older apps would mis-handle it.

## Plugin versions & compatibility

- Each plugin has its own semver `version` (validated by the manifest schema) and declares the plugin-API range it needs: `"engines": { "oneclient": "^0.1.0" }`.
- The host exposes `PLUGIN_API_VERSION` (`packages/plugin-api/src/version.ts`). A plugin whose range doesn't include it is loaded as **incompatible** (visible in the Plugin Manager, never activated).
- **Bump policy** for `PLUGIN_API_VERSION`: patch = fixes, minor = additive (new optional members), major = breaking. While below 1.0, a minor bump may break — plugins pin `^0.x.y` accordingly.
- `oneclient.json` records the last-seen version of every plugin (`plugins.<id>.version`) and each connection records the `pluginVersion` that wrote it, so a plugin that changes its connection settings can migrate older ones, and imports can warn about older plugins.
