# oneClient guide

> The full feature reference, FAQ and developer notes. For the short version, see the [README](../README.md).

[![CI](https://github.com/AhmedKhalil777/OneClient/actions/workflows/ci.yml/badge.svg)](https://github.com/AhmedKhalil777/OneClient/actions/workflows/ci.yml)
[![Release](https://github.com/AhmedKhalil777/OneClient/actions/workflows/release.yml/badge.svg)](https://github.com/AhmedKhalil777/OneClient/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](../LICENSE)

**One client for everything.** oneClient is a free, open-source developer console that puts your **PostgreSQL,
SQL Server and MySQL client**, a **Kafka UI**, a **Redis browser**, an **HTTP / REST client (Postman alternative)**,
**Docker** management, **Azure Blob Storage**, **Keycloak** admin and an **AI coding assistant** in one window that looks
and works like VS Code. Run it as a **desktop app** (Windows, macOS, Linux) or **self-host it in the browser**.

Every integration is a plugin. Plugins add connection types, explorer trees, editors, commands and title-bar actions at
runtime, with no rebuild or restart, and each runs in its own process.

![The oneClient workbench: Explorer, editor and terminal](images/workbench.png)

**[Download the latest release →](https://github.com/AhmedKhalil777/OneClient/releases/latest)** (Windows, macOS, Linux) ·
**[Website](https://ahmedkhalil777.github.io/OneClient/)** · **[Run it in a browser](#run-it-in-a-browser-self-hosted-no-electron)**

## What do you want to do?

| I'm looking for… | oneClient has |
| --- | --- |
| A free **PostgreSQL GUI** / **SQL Server GUI** / **MySQL & MariaDB GUI** | Object explorer, query windows with IntelliSense, result grids you can sort, filter and export, a table data editor with staged changes, CSV import, execution plans, query history, SSH tunnels |
| A **Kafka UI** / Kafka topic browser | Brokers, topics, consumer groups, message browser with filters, producer — Apache Kafka, Redpanda, Confluent Cloud, Azure Event Hubs |
| A **Redis GUI** / Redis key browser | Namespace tree, editors for strings, hashes, lists, sets, sorted sets, streams and JSON, TTL, rename, delete |
| A **Postman alternative** / REST API client, or a way to **run `.http` files** | Collections, environments, variables, auth, history, import from Postman, or paste **Copy as cURL / PowerShell / fetch** straight from the browser's dev tools, export to Postman — and `.http` / `.rest` files open in the editor with a ▶ **Send Request** button per endpoint, chained requests and a response viewer |
| A **Docker** UI and quick **test databases** | Containers, images, volumes, networks; one-click templates for PostgreSQL, SQL Server, Redis, Kafka, Azurite and Keycloak, each with a ready connection |
| **Azure Blob Storage** explorer / **Azurite** client | Containers and blobs, upload, download, edit, SAS links |
| A **Keycloak** admin console for developers | Realms, users, roles, clients and token tools |
| An **AI assistant** that sees your databases and files | Chat with Claude, OpenAI, Gemini, DeepSeek, Kimi, GLM, Grok, Mistral, Qwen, OpenRouter, Ollama or any OpenAI-compatible server using **your own API key** — it can list tables, run read-only SQL and propose file edits you approve |
| A **Git GUI** with a commit graph, **terminal** and **file editor** | Source Control, a full Git Graph tab, integrated terminal, task runner, multi-folder search |

## Features

### A real workbench

You get the Explorer, multi-folder workspaces, a shared editor (find / replace, go to line, format, breadcrumbs), an
integrated terminal (PowerShell, cmd, Git Bash, WSL, bash/zsh), title-bar menus, **quick-access icons** and a command
palette. Everything has a keyboard shortcut you already know. A **secondary side bar** on the right keeps a chat or any
view next to your editors, and editors can be **split** side by side.

| Search across every open folder | Command palette |
| --- | --- |
| ![Search](images/search.png) | ![Command palette](images/command-palette.png) |
| Match case, whole word, regex, include / exclude globs, and replace per file or everywhere. | Every core and plugin command, filtered as you type (`Ctrl+Shift+P`). |

The editor colors **TypeScript, JavaScript, CSS / SCSS / Less, C#, YAML, JSON, XML, SQL and Markdown** (Markdown and SVG
have a live preview), and opens **images** (PNG, JPEG, GIF, WebP, BMP, ICO, AVIF) in a viewer with zoom and pan.

### Source Control and Git Graph

The Source Control view works like VS Code's: staged and unstaged changes, a commit box with Commit / Amend / Push /
Sync, side-by-side or inline diffs, branch checkout and creation. The **Git Graph** tab (title bar → graph icon) shows
the whole history as a searchable table with branch lanes, refs, authors and dates; pick a commit to see its message and
changed files and open any file's diff. It uses your own `git`, so hooks, credentials and config just work.

![Source Control with a side-by-side diff and the commit graph](images/source-control.png)

### Background tasks

The task runner finds `package.json` scripts (npm / pnpm / yarn), `.vscode/tasks.json` / `.oneclient/tasks.json`
tasks and .NET builds. Tasks run in the background with live output, progress in the status bar, Stop and Run Again.
Git fetch / pull / push and long plugin jobs show up here too.

![The Tasks panel with a running build and finished test and lint tasks](images/tasks.png)

### SQL plugins: PostgreSQL, SQL Server and MySQL / MariaDB

The three SQL plugins share one core (`@oneclient/sql-core`), so they all get the same tools:

- **Query windows** with IntelliSense, multiple result sets, messages, cancel, and results you can sort, filter,
  multi-select, copy and export as CSV, TSV, JSON, Markdown or SQL `INSERT`s.
- **Query history** per connection, searchable, with one-click re-run; **Fast Tools** — saved queries per database and
  generators like the SQL Server fake-data tool.
- **Background queries:** mark a long query to run in the background, leave the tab, and watch it finish.
- **Table data editor** with staged changes and a SQL review before anything is written; **CSV import** into a table;
  **execution plans**; **Create Database**; **SSH tunnels** for every connection; **ER diagrams**.

| PostgreSQL & SQL Server | Apache Kafka |
| --- | --- |
| ![PostgreSQL query window](images/postgres.png) | ![Kafka topic browser](images/kafka.png) |
| Browse databases, schemas, tables, views, functions and procedures. Query windows with IntelliSense, multiple result sets and messages. | Brokers, topics and consumer groups. Browse and filter messages, view partitions and configuration, produce messages. |

| HTTP client | Redis |
| --- | --- |
| ![HTTP client request and response](images/http-client.png) | ![Redis key browser](images/redis.png) |
| Collections, folders, environments and history. Import from Postman or cURL. | Key tree grouped by namespace; editors for strings, hashes, lists, sets, sorted sets, streams and JSON; TTL, rename and delete. |

### AI assistant (bring your own key)

Add one **AI Assistant** connection, paste the API keys of the providers you use, and pick any model from one table in the
chat — prices shown, providers without a key dimmed. The chat lives in the secondary side bar (or a tab), keeps your
conversations, renders **Markdown tables, code and Mermaid diagrams**, and can work with your setup:

- **Your folders:** list, read and search files; every edit or write waits for your approval.
- **Your databases:** list connections, read the schema, run read-only SQL; anything that changes data shows the
  statement and waits for your approval. Other plugins can offer tools the same way (`oneclient.aiTools`).

Claude, OpenAI, Gemini, DeepSeek, Kimi, GLM, Grok, Mistral, Qwen, OpenRouter, Ollama (local) and any OpenAI-compatible
server work. Keys are stored encrypted (OS keychain on the desktop).

### Plugins for your infrastructure

Docker, Azure Blob Storage and Keycloak are included too. Docker's **Templates** start any of these servers in a
container for local testing (PostgreSQL, SQL Server, Redis, Kafka, Azurite, Keycloak). Each one gets a ready connection
in its plugin, and every container shows which plugin and connection it belongs to. The Miscellaneous plugin adds
editor support (syntax coloring, outlines, previews) and Material file icons. The Plugins view shows what is installed and, for each plugin, what it can do grouped by category (Explore, Query, Edit data…), searchable and with a **Try it** button. Plugin authors fill it in with the manifest's `features` list.
You can enable or disable any plugin live.

![The Plugins view](images/plugins.png)

## FAQ

**Is there a free, open-source alternative to a separate database client, Kafka UI, Redis GUI and Postman?**
oneClient combines them in one app: PostgreSQL, SQL Server and MySQL / MariaDB clients, Apache Kafka, Redis, an HTTP
client with Postman import, Docker, Azure Blob Storage and Keycloak, in one VS Code-style window. It is MIT-licensed.

**Does it run in the browser?** Yes. The web version is a self-hosted Node server you open from a browser; see
[Run it in a browser](#run-it-in-a-browser-self-hosted-no-electron). The desktop app uses Electron.

**Which databases does it support?** PostgreSQL (including Azure Database for PostgreSQL, AWS RDS / Aurora, Supabase,
Neon, TimescaleDB), Microsoft SQL Server, and MySQL / MariaDB. Redis and Kafka have their own plugins.

**Can an AI assistant query my database?** The AI Assistant plugin can list your connections, read schemas and run
read-only SQL, using your own provider API key. Statements that change data, and every file edit, wait for your
approval. You can turn the database and file access off per connection.

**Can I write my own plugin?** Yes — see [`packages/plugin-api`](../packages/plugin-api) and
[`ARCHITECTURE.md`](../ARCHITECTURE.md). A plugin is a manifest plus a Node entry point and optional web views.

**Where are my passwords stored?** Encrypted: in the OS keychain on the desktop, and with a server-side key in the web
version.

## For developers

See [`ARCHITECTURE.md`](../ARCHITECTURE.md) for the process topology, contribution model, plugin lifecycle, and trust
model, and [`packages/plugin-api`](../packages/plugin-api) for the interfaces plugins implement.

### What's in the repo

oneClient runs in two ways that share one backend and one UI. The desktop app runs on **Electron**. The web
version is a self-hosted **plain Node** server that you use from a browser.

| Package | What | Electron? |
|---|---|---|
| `packages/backend` | The backend: plugin hosts, connections, workspace, Git, tasks, terminal, search, themes | no |
| `packages/workbench` | The UI (React + Vite): title bar menus, Explorer, Search, editor, Source Control, Terminal, Tasks, Output | no |
| `packages/server` | **Web runtime:** an HTTP + WebSocket server for the backend, serving the workbench to a browser | no |
| `packages/core` | **Desktop runtime:** the Electron shell (main process, preloads, native windows and views) | yes |
| `packages/plugins/*` | SQL Server, PostgreSQL, MySQL / MariaDB, Redis, Kafka, Azure Blob Storage, Docker, Keycloak, HTTP client, Pipelines, AI Assistant, Miscellaneous | no |
| `packages/plugin-api`, `packages/editor-kit` | What plugins depend on, and the shared editor | no |
| `packages/sql-core`, `packages/editor-core` | The shared base of the SQL plugins, and the editor's syntax tokenizers (TypeScript, JavaScript, CSS, C#, YAML) | no |

Plugins run unchanged in both runtimes.

### Development

**You need:**

| Tool | Version | Notes |
|---|---|---|
| Node.js | **22 LTS**, 22.13 or later (minimum 20.19) | `.nvmrc` pins 22 (`nvm use`); CI and releases build on 22. Older 20.x / 22.x can't `require()` ES modules, which the faker library (SQL Server plugin) and the test runner need. |
| pnpm | **10** | `npm i -g pnpm@10` or `corepack enable`. Packaging uses `pnpm deploy --legacy`, which pnpm 9 doesn't have. |
| Git | any recent | For the Source Control view. |

On Windows and macOS you don't need Python or a C++ toolchain: the terminal's native module (`node-pty` 1.1) ships
prebuilt binaries for them. **On Linux** it has no prebuilt binary and compiles during `pnpm install`, so install
`python3`, `make` and `g++` first (Debian/Ubuntu: `sudo apt install build-essential python3`).

```sh
pnpm install
pnpm run build       # every package
pnpm run typecheck
pnpm run test
cd packages/core && pnpm run dev   # the app, with hot reload
```

### Run it in a browser (self-hosted, no Electron)

The web runtime installs and builds only the web packages, so Electron is never downloaded:

```sh
pnpm run web:install   # server, backend, workbench, plugins — no Electron
pnpm run web:build
pnpm run web:start     # prints:  Open: http://127.0.0.1:4180/?token=…
```

Open the printed link. The token in it is swapped for a cookie, so later visits only need `http://127.0.0.1:4180/`.
Run `node packages/server/dist/main.js --help` for every option. The main ones:

| Option / env | |
|---|---|
| `--port` / `PORT` | default 4180 |
| `--host` / `HOST` | default `127.0.0.1`, so only this machine can connect. Use `0.0.0.0` to serve your network, behind an HTTPS reverse proxy. |
| `--home` / `ONECLIENT_HOME` | config folder, default `~/.oneclient` |
| `--token` / `ONECLIENT_TOKEN` | access token; by default one is generated and kept in `<home>/server-token` |
| `--plugins` / `ONECLIENT_PLUGINS` | extra plugin folders. The bundled `packages/plugins` and `<home>/plugins` are always loaded. |
| `ONECLIENT_SECRET_KEY` | 32-byte key for saved passwords; by default one is generated in `<home>/server.key` |

**How the web version differs:**
- **Folders, Git and the terminal are on the server.** "Open Folder…" browses the server's disk, and the terminal opens
  a shell there.
- **Passwords are separate.** The server encrypts them with its own key, in `secrets-server.json`. The desktop app
  uses the OS keychain, so connections shared between the two need their passwords entered once in each.
- **One runtime per config folder.** The desktop app and the server refuse to run on the same config folder at the
  same time. Give each its own `ONECLIENT_HOME` to run both.
- **Some shortcuts belong to the browser,** such as Ctrl+W and Ctrl+N.

**Security:**
- Every request and the WebSocket need the token cookie (`HttpOnly`, `SameSite=Strict`).
- The WebSocket must come from the page's own origin.
- A server bound to localhost also rejects requests whose `Host` header is a foreign name (DNS rebinding).
- Whoever has the token has your connections and a terminal, so treat it like a password.

### Packaging & releases

```sh
pnpm run package       # installers for this OS → release/ (Windows: NSIS .exe + .zip, macOS: .dmg + .zip, Linux: AppImage + .tar.gz)
pnpm run package:dir   # just the unpacked app (quick check)
```

`scripts/package.mjs` builds everything, stages the app and each plugin with only their production dependencies
(`pnpm deploy`), and runs electron-builder; bundled plugins go to `resources/plugins`.

GitHub Actions:

- **CI** (`.github/workflows/ci.yml`) — every push to `main` and every pull request: install, build, typecheck and
  test on Windows; check that the app still packages; and check that the web runtime installs, builds and passes its
  tests with no Electron installed.
- **Release** (`.github/workflows/release.yml`) — push a version tag (`git tag v0.2.0 && git push origin v0.2.0`) or run
  it from the Actions tab with a version: tests, builds the installers on all three OSes, and publishes a GitHub
  Release with them, `SHA256SUMS.txt` and generated release notes. Tags with a `-` (`v0.2.0-beta.1`) become
  pre-releases; manual runs default to a draft. The installers aren't code-signed yet (Windows SmartScreen and macOS
  Gatekeeper will warn).

### Website

The landing page lives in [`site/`](../site). `node scripts/build-site.mjs` assembles it into `_site/`, adding the
screenshots from `docs/images`, the app logo and the plugin icons. The **Website** workflow
(`.github/workflows/pages.yml`) publishes it to GitHub Pages whenever any of those change on `main`. Its download
buttons resolve to the latest release's files through the GitHub API.

### Screenshots

The images in [`docs/images`](images) are real captures of the running app (1440×900, against local Docker
containers), taken with the `run-desktop` skill's driver: `size 1440x900` and then `ss-screen <name>`, which captures
the window as the OS shows it, plugin views included.
