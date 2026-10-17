# @oneclient/core (Phase 2)

The Electron shell. Not implemented yet — this package is a placeholder so
the monorepo layout is in place ahead of Phase 2.

Planned structure (see [`../../ARCHITECTURE.md`](../../ARCHITECTURE.md)):

```
src/
  main/            Electron main process: window, plugin manager, connection
                   manager, extension-host supervisor, IPC handlers
  preload/         contextIsolation-safe bridge exposed to the renderer
  renderer/        React UI: sidebar explorer, tabbed main area, command
                   palette, generic Tier 1 form/grid renderers, Tier 2 view
                   host chrome
  extension-host/  Runtime harness loaded inside each per-plugin
                   utilityProcess: resolves oneclient.json, loads `main`,
                   calls activate(context), marshals registry calls over IPC
```
