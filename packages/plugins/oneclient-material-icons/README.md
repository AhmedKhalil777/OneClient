# oneclient-material-icons

A **declarative plugin** (no code, no extension-host process): it contributes one icon theme, the
[Material Icon Theme](https://github.com/material-extensions/vscode-material-icon-theme) — file and
folder icons for 1,300+ file extensions, 2,000+ special file names (`package.json`, `Dockerfile`,
`.gitignore`, …) and well-known folders (`src`, `node_modules`, `.github`, …), with light-theme variants.

It's the default icon theme when installed and the user hasn't picked another one. Switch with
**Preferences: Icon Theme…**.

## Build

The icons come from the `material-icon-theme` npm package at build time and are not checked in:

```
pnpm --filter oneclient-material-icons run build   # → dist/icon-theme.json + dist/icons/*.svg
```

`scripts/generate.mjs` converts the package's manifest into oneClient's icon theme format
(`IconThemeFile` in `@oneclient/plugin-api`): icon ids become `mi-<name>`, folder-name spellings
(`.src`, `_src`, `__src__`) collapse to one entry, and the light / high-contrast overrides become
the theme's `light` / `hc` blocks.

## License

The icons are © Material Extensions, MIT licensed; the license text is copied to
`dist/LICENSE-material-icon-theme.txt` on build and must ship with the app.
