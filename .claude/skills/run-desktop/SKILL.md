---
name: run-desktop
description: Build, run, and drive the oneClient Electron desktop app (packages/core). Use when asked to start the app, take a screenshot of it, build it, or interact with its UI.
---

oneClient is an Electron + React desktop app at `packages/core`. For
agent/automated use, drive it via the Playwright `_electron` REPL at
`.claude/skills/run-desktop/driver.mjs`. This was built and validated on
native Windows (no xvfb/tmux needed there) — on headless Linux you will
additionally need xvfb and `--no-sandbox` is already passed by default.

All paths below are relative to the repo root.

## Build

```sh
pnpm install
pnpm --filter @oneclient/plugin-api run build   # core depends on this
pnpm --filter @oneclient/core run build         # electron-vite build -> packages/core/out/
```

`pnpm --filter @oneclient/core run rebuild-native` re-links `better-sqlite3`
against Electron's ABI if you ever see a `NODE_MODULE_VERSION` mismatch
error at startup (e.g. after bumping the Electron version).

## Run (agent path)

```sh
node .claude/skills/run-desktop/driver.mjs .claude/skills/run-desktop/smoke-test.txt
node .claude/skills/run-desktop/driver.mjs .claude/skills/run-desktop/tier2-smoke-test.txt  # Tier 2 view pipeline
node .claude/skills/run-desktop/driver.mjs .claude/skills/run-desktop/docker-smoke-test.txt  # oneclient-docker (needs Docker running)
```

This is non-interactive/batch mode: it runs every line in the file as a
driver command, then quits. Screenshots land in
`.claude/skills/run-desktop/shots/` (override with `SCREENSHOT_DIR`) —
**open the PNG, don't just trust the text dump.**

For interactive/iterative poking, run without a file argument and type
commands at the `driver>` prompt (reads from `/dev/stdin` directly so
Electron doesn't steal it):

```sh
node .claude/skills/run-desktop/driver.mjs
```

### Commands

| command | what it does |
|---|---|
| `launch` | launch the app, find the real window |
| `ss [name]` | screenshot of the main window -> `shots/<name>.png`. **Does not show Tier 2 views** — see Gotchas |
| `ss-view [urlSubstring] [name]` | screenshot of an open Tier 2 view's own content -> `shots/<name>.png`. **Unreliable** — see Gotchas |
| `eval-view [urlSubstring] <js>` | evaluate JS inside a Tier 2 view's webContents (via `executeJavaScript`), print the result |
| `click-text-view [urlSubstring] <text>` | `click-text`, but inside a Tier 2 view |
| `click <css-sel>` | click element via DOM `.click()` (not coordinates) |
| `click-text <text>` | click first `button/a/div/span/td/li` with matching text |
| `fill <css-sel> <text>` | **use this for text inputs**, not `type`/`eval` — see Gotchas |
| `select <css-sel> <value>` | set a `<select>`'s value correctly |
| `type <text>` / `press <key>` | raw keyboard input (e.g. `press Control+Shift+P`) |
| `wait <ms>` | sleep |
| `wait-sel <css-sel>` | wait for element, 10s timeout |
| `eval <js>` | evaluate in the page, print JSON |
| `text [css-sel]` | print `innerText` |
| `windows` | list windows (there's normally just the one) |
| `quit` | close app, exit |

## Run (human path)

```sh
cd packages/core
pnpm run dev     # electron-vite dev, hot reload, opens a real window
```

## Gotchas

- **Never set `el.value = x` then dispatch an `input` event to fill a React
  controlled input.** React patches `HTMLInputElement.prototype`'s value
  setter, so a direct `.value =` assignment updates React's internal value
  tracker *before* your event fires — React then sees "no change" and
  skips `onChange`. The field *looks* filled (raw DOM value changed) but
  the app's state never updated, and the next unrelated re-render snaps
  the input back to its real (empty) state, which looks like a mysterious
  "reset" bug. **Use the `fill`/`select` driver commands** (Playwright's
  `page.fill()`/`selectOption()`), which go through a real low-level path
  and trigger `onChange` correctly. Cost real debugging time to find —
  see the Phase 2 implementation notes if curious.
- **`better-sqlite3` is a native addon.** It's prebuilt for Electron's ABI
  via `@electron/rebuild` (see Build above) — if you add/bump Electron or
  `better-sqlite3`, rerun `pnpm --filter @oneclient/core run rebuild-native`
  or you'll get a `NODE_MODULE_VERSION` mismatch at require() time.
- **`@oneclient/plugin-api` is published as CommonJS, not ESM**, even
  though its source uses `import`/`export`. This is deliberate: electron-vite's
  main-process build output is CJS and leaves workspace deps un-bundled
  (`externalizeDepsPlugin`), so a CJS `require()` of an ESM-only package
  fails with `ERR_REQUIRE_ESM`. Keep plugin-api CJS unless core's main
  build is also switched to ESM output.
- **Dev-only fixture plugin**: `packages/core/dev-plugins/oneclient-sample`
  loads automatically when `!app.isPackaged`, giving the smoke test a real
  plugin to exercise (contributed command, connection type, explorer
  tree) without needing a real infrastructure integration.
- **SQLite persists across runs** in the real Electron userData dir
  (`%APPDATA%/oneClient` on Windows). Repeated smoke-test runs will leave
  behind multiple "My Sample" connections unless you delete that directory
  between runs — this is expected (it's exactly the persistence Phase 2
  was asked to add), not a bug. **Also stop any background `pnpm run dev`
  session first** — the sqlite file and a running Electron instance both
  hold OS-level locks that make `rm -rf` on userData fail with "Device or
  resource busy".
- **Neither `BrowserWindow.capturePage()` nor a Tier 2 view's own
  `WebContents.capturePage()` can be trusted to produce a real screenshot
  of that view's content.** Tier 2 views are hosted as separate
  `WebContentsView`s layered over the main window (see
  `view-host-manager.ts`). `ss` (window-level `capturePage()`) shows a
  blank hole where one is — expected, it doesn't composite child views.
  `ss-view` targets the view's own `webContents.capturePage()` directly
  (matching by URL — every Tier 2 entry lives under the plugin manifest's
  `ui` dir, so any loaded webContents URL containing `/ui/` is one; pass a
  substring to disambiguate multiple open views) and *usually* works, but
  has been observed returning a 0×0 image even when the view is fully
  loaded, responsive, correctly bounded on screen, and verified alive via
  `eval-view` at the same moment — a real user sees it fine via the OS
  compositor. Root cause not isolated (looks like `capturePage()`'s
  backing store not tracking bounds set via `View.setBounds()` for a
  child view, in this Electron version). **Don't block verification work
  on getting a pixel screenshot of Tier 2 content** — `eval-view` (reads
  DOM state / returns values via `executeJavaScript`, no paint required)
  and `click-text-view` are the reliable way to confirm a Tier 2 view is
  alive and behaving correctly; treat a captured screenshot as a nice-to-have
  bonus, not the primary evidence.

## Troubleshooting

- **`electronApplication.firstWindow` timeout**: check the main process
  actually started — run the electron binary directly (`node -e
  "console.log(require('electron'))"` to find the path, then run it with
  `--no-sandbox <packages/core dir>`) to see raw stdout/stderr instead of
  Playwright's generic timeout.
- **`ERR_REQUIRE_ESM` on startup**: see the plugin-api CJS gotcha above.
