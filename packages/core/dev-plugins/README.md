# dev-plugins

Dev-only fixture plugins, loaded automatically when `app.isPackaged` is
false (see `src/main/index.ts`). **Not** shipped in a packaged build and
**not** one of the real reference plugins (`oneclient-docker`, etc. live
under `packages/plugins/`) — this exists purely to exercise the plugin
loader, extension-host supervisor, connection manager, and explorer tree
end-to-end without waiting on a real infrastructure integration.
