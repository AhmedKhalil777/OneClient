# Contributing to oneClient

Thanks for helping. oneClient is a pnpm workspace (TypeScript, React, Electron) where **every integration is a plugin**, so there is
usually a small, well-contained place to make a change.

## Ways to help

- **Try it and report what's rough.** Open an [issue](https://github.com/AhmedKhalil777/OneClient/issues/new/choose). Every plugin
  writes its activity and errors to the in-app **Output** panel (bottom panel → Output → pick the plugin's *Log*); pasting that makes
  a bug far quicker to fix.
- **Write or improve a plugin** — a database, broker or service you use. Start from [`packages/plugin-api`](packages/plugin-api) and an
  existing plugin such as [`oneclient-redis`](packages/plugins/oneclient-redis).
- **Pick up a [good first issue](https://github.com/AhmedKhalil777/OneClient/issues?q=is%3Aopen+label%3A%22good+first+issue%22)**,
  improve the docs, or add a screenshot.
- **Ask or suggest** in [Discussions](https://github.com/AhmedKhalil777/OneClient/discussions) before a big change.

## Set up

You need **Node.js 22 LTS** (22.13+), **pnpm 10** and Git. On Linux, install `python3`, `make` and `g++` once (the terminal's native
module compiles on install).

```sh
git clone https://github.com/<you>/OneClient.git
cd OneClient
pnpm install
pnpm run build        # every package
pnpm run typecheck
pnpm run test
```

Run the desktop app with hot reload: `pnpm --filter @oneclient/core run dev`. Run the web version:
`pnpm run web:build && pnpm run web:start`. The [guide](docs/GUIDE.md#development) has the details, and
[ARCHITECTURE.md](ARCHITECTURE.md) explains how the processes and plugins fit together.

## Where things live

| Path | What |
| --- | --- |
| `packages/plugin-api` | The typed API plugins implement; the manifest schema |
| `packages/backend` | Plugin hosts, connections, workspace, Git, tasks, notifications, output |
| `packages/workbench` | The UI shell (React): sidebar, tabs, panels, menus |
| `packages/core`, `packages/server` | The desktop (Electron) and web (Node) runtimes |
| `packages/sql-core` | What PostgreSQL, SQL Server and MySQL share: query windows, table editor, Fast Aggregates |
| `packages/plugins/*` | One folder per integration (`oneclient.json` manifest + `src/` + `src-ui/`) |

## Making a change

1. **Branch** from `main`; keep a PR to one idea.
2. **Test the behaviour, not just the types.** Pure logic gets a unit test (`vitest`, next to the package). For anything with a
   screen, run it and look at it — the desktop and web builds can both be driven with Playwright.
3. Run `pnpm run typecheck` and `pnpm run test` for the packages you touched. CI runs them for everything.
4. **Plugins:** declare commands, views and nodes in `oneclient.json` (the manifest schema test catches typos), log through the
   plugin's Output channel, and never put secrets in a notification or log line.
5. Open the PR using the template. Screenshots help for UI changes.

## Style

Match the surrounding code: small modules, comments that explain *why*, plain English in user-facing text (say what happened and what
to do next, not a stack trace). The UI is keyboard-first — new screens should work without a mouse.

## Conduct

Be kind and assume good faith. See the [Code of Conduct](CODE_OF_CONDUCT.md). Security issues: see [SECURITY.md](SECURITY.md) — please
don't open a public issue for those.

By contributing you agree your work is released under the [MIT license](LICENSE).
