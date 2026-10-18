# oneclient-misc

The built-in **Miscellaneous** plugin. One extension-host process, six small contributions:

| Contribution | What |
| --- | --- |
| JSON | Files-editor support: format, minify, path breadcrumbs, highlighting |
| XML | format, element breadcrumbs, highlighting (.xml, .csproj, .config, .svg, …) |
| SQL | highlighting, statement/object outline, formatter, Uppercase/Lowercase Keywords actions (.sql, .tsql, .ddl, …) |
| Markdown | live preview, heading outline, highlighting |
| Text utilities | sort lines, remove duplicates, trim trailing whitespace, final newline (every file) |
| **Material Icon Theme** | the default file/folder icon theme: 1,300+ file types, 2,000+ special file names, well-known folders, light-theme variants |

The editor features plug into core's file editor through the `oneclient.editors` extension point (see
`packages/plugin-api/src/file-editor.ts`); the icon theme is declarative (`contributes.iconThemes`).

## Material Icon Theme

The icons come from the [`material-icon-theme`](https://github.com/material-extensions/vscode-material-icon-theme) npm
package at build time and are not checked in:

```
pnpm --filter oneclient-misc run build   # tsc, then dist/material-icons/{icon-theme.json,icons/*.svg}
```

`scripts/generate-material-icons.mjs` converts the package's manifest into oneClient's icon theme format
(`IconThemeFile` in `@oneclient/plugin-api`): icon ids become `mi-<name>`, folder-name spellings (`.src`, `_src`,
`__src__`) collapse to one entry, and light / high-contrast overrides become the theme's `light` / `hc` blocks.
It is the default icon theme when installed and the user hasn't picked another (**Preferences: Icon Theme…**).

The icons are © Material Extensions, MIT licensed; the license text is copied to
`dist/material-icons/LICENSE-material-icon-theme.txt` on build and must ship with the app.
