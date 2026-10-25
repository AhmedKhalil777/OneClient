# @oneclient/editor-core

The editor's language core: dependency-free syntax tokenizers that return the `TokensResult` the file editor draws
(`plugin-api/src/file-editor.ts`).

| Function | Files |
|---|---|
| `typescriptTokens(text, jsx?)` | `.ts` `.mts` `.cts` `.tsx` |
| `javascriptTokens(text, jsx?)` | `.js` `.mjs` `.cjs` `.jsx` |
| `cssTokens(text, lineComments?)` | `.css`, and `.scss` / `.less` with `lineComments` |
| `csharpTokens(text)` | `.cs` `.csx` `.cake` |

They are tolerant (half-typed code never throws; unterminated strings/comments just end at the line/file end),
linear-time, and skip files over `MAX_HIGHLIGHT_CHARS` so typing stays instant.

## Using it

`oneclient-misc` exposes them as `*.tokens` commands and declares one `oneclient.editors` contribution per language
in its `oneclient.json`. To add a language: write a tokenizer here (`tokenizeCFamily` covers most C-like syntax with a
config of keywords/types/string styles), export a `…Tokens` function, then add a command and a contribution.
