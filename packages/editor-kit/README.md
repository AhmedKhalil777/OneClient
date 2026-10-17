# @oneclient/editor-kit

Shared editor building blocks for plugin **Tier 2 views**. Source-only workspace package: your plugin's Vite build compiles it in, so there's nothing to build or publish separately.

## Autocomplete

Adds VS Code-style completion to any `<textarea>` editor:

- opens while typing a word, on a provider's trigger character (e.g. `.`), or with **Ctrl+Space**
- fuzzy filtering (the first typed letter must start a word), matched letters highlighted, kind badges, `detail` on the right, `documentation` below
- **↑/↓ PgUp/PgDn** to move, **Enter/Tab** to accept, **Esc** to close
- accepting is a single native undo step, and frameworks (React `onChange`) see a normal input event
- `insertText` may contain `$0` to place the caret, e.g. `"COUNT($0)"`

### Use it

```jsonc
// your plugin's package.json
"dependencies": { "@oneclient/editor-kit": "workspace:*" }
```

```ts
// vite.config.ts — make the shared package use your bundle's React
resolve: { dedupe: ["react", "react-dom"] },
```

React:

```tsx
import { wordsProvider, type CompletionProvider } from "@oneclient/editor-kit";
import { useAutocomplete } from "@oneclient/editor-kit/react";

const providers: CompletionProvider[] = [myLanguageProvider, wordsProvider()];

function Editor() {
  const ref = useRef<HTMLTextAreaElement>(null);
  useAutocomplete(ref, { providers });
  return <textarea ref={ref} />;
}
```

Anything else:

```ts
import { attachAutocomplete } from "@oneclient/editor-kit";
const ac = attachAutocomplete(textarea, { providers });
// ac.trigger(), ac.close(), ac.setProviders([...]), ac.dispose()
```

### Write a provider

The types (`CompletionProvider`, `CompletionItem`, `CompletionContext`) live in `@oneclient/plugin-api`, so a plugin's **backend** can build items too and return them from a command:

```ts
const myLanguageProvider: CompletionProvider = {
  triggerCharacters: ["."],
  async provideCompletions(ctx) {
    // ctx: text, offset, prefix (partial word), wordStart, linePrefix, triggerCharacter, explicit
    const items = await window.oneclientView.invokeCommand("myplugin.complete", [{ text: ctx.text, offset: ctx.offset }]);
    return items as CompletionItem[];
  },
};
```

Return everything relevant at that position. The kit filters and ranks it as the user keeps typing, without calling the provider again until a new word starts. Use `sortText` to group items when nothing is typed yet; the best match always wins once something is.

Built in: `wordsProvider()`, which suggests every word already in the document (VS Code's default word-based suggestions).

Theme the popup by overriding the `--oc-ac-*` CSS variables (see `src/styles.ts`).

### Used by

- **oneclient-mssql**: T-SQL IntelliSense (keywords, functions, databases, schemas, tables, columns, `alias.` / `schema.` / `db.schema.` completion, `@variables`). See `src-ui/completion.ts`.
- **oneclient-files**: word-based suggestions in the text editor.
