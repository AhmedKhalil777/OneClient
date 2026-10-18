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

[![CI](https://github.com/AhmedKhalil777/OneClient/actions/workflows/ci.yml/badge.svg)](https://github.com/AhmedKhalil777/OneClient/actions/workflows/ci.yml)
[![Release](https://github.com/AhmedKhalil777/OneClient/actions/workflows/release.yml/badge.svg)](https://github.com/AhmedKhalil777/OneClient/releases)

## What's in it

- **Core workbench** (`packages/core`): title bar menus, Explorer, Search, file editor, Source Control (git),
  Terminal, background tasks / Task Runner, Output, themes, and the plugin host.
- **Plugins** (`packages/plugins/*`): SQL Server, PostgreSQL, Redis, Kafka, Azure Blob Storage, Docker, Keycloak,
  HTTP client, and Miscellaneous (JSON / XML / SQL / Markdown editor features, Material icons).
- `packages/plugin-api` — the only package plugins depend on; `packages/editor-kit` — the shared editor.

## Development

```sh
pnpm install
pnpm run build       # every package
pnpm run typecheck
pnpm run test
cd packages/core && pnpm run dev   # the app, with hot reload
```

## Packaging & releases

```sh
pnpm run package       # installers for this OS → release/ (Windows: NSIS .exe + .zip, macOS: .dmg + .zip, Linux: AppImage + .tar.gz)
pnpm run package:dir   # just the unpacked app (quick check)
```

`scripts/package.mjs` builds everything, stages the app and each plugin with only their production dependencies
(`pnpm deploy`), and runs electron-builder; bundled plugins go to `resources/plugins`.

GitHub Actions:

- **CI** (`.github/workflows/ci.yml`) — every push to `main` and every pull request: install, build, typecheck and
  test on Windows, macOS and Linux, then check that the app still packages.
- **Release** (`.github/workflows/release.yml`) — push a version tag (`git tag v0.2.0 && git push origin v0.2.0`) or run
  it from the Actions tab with a version: tests, builds the installers on all three OSes, and publishes a GitHub
  Release with them, `SHA256SUMS.txt` and generated release notes. Tags with a `-` (`v0.2.0-beta.1`) become
  pre-releases; manual runs default to a draft. The installers aren't code-signed yet (Windows SmartScreen and macOS
  Gatekeeper will warn).
