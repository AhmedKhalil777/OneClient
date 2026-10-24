/**
 * The semver version of this API surface. Bumped whenever an interface in
 * this package changes in a way that could break existing plugins.
 *
 * The core checks a plugin's `manifest.engines.oneclient` range against this
 * value (via `semver.satisfies`) before activating it. Plugins declaring an
 * incompatible range are refused at install/load time — see
 * ARCHITECTURE.md § Plugin lifecycle.
 */
// 0.1.1: added context.connections, context.contributions and TreeNode description/tooltip (additive — kept in 0.1.x
// so "^0.1.0" plugins still load; a plugin that uses them declares "^0.1.1").
export const PLUGIN_API_VERSION = "0.1.1";
