/**
 * The empty page the preview pane renders into. The content (HTML from another plugin) is written into
 * `#content` afterwards, so scroll position survives updates.
 *
 * Safety: the frame is `sandbox="allow-same-origin"` with no `allow-scripts`, and this CSP forbids
 * scripts, frames, forms and network access except https/data images — a previewed document can
 * display things but can't run anything.
 */
export const PREVIEW_SHELL = `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: data:; style-src 'unsafe-inline'">
<style id="oc-theme"></style>
<style id="oc-base">${previewBaseCss()}</style>
<style id="oc-plugin"></style>
</head><body><article id="content"></article></body></html>`;

/** Document styling for rendered content, driven by the theme variables injected into `#oc-theme`. */
function previewBaseCss(): string {
  const v = (key: string, fallback: string) => `var(--oc-${key}, ${fallback})`;
  return `
html { background: ${v("editor-background", "#1e1e1e")}; }
body {
  margin: 0; padding: 16px 28px 40px;
  font: 14px/1.65 -apple-system, "Segoe UI", system-ui, sans-serif;
  color: ${v("editor-foreground", "#d4d4d4")};
  word-wrap: break-word;
}
#content > :first-child { margin-top: 0; }
h1, h2, h3, h4, h5, h6 { margin: 1.4em 0 .6em; font-weight: 600; line-height: 1.25; }
h1 { font-size: 2em; } h2 { font-size: 1.5em; } h3 { font-size: 1.25em; } h4 { font-size: 1em; } h5 { font-size: .9em; } h6 { font-size: .85em; opacity: .8; }
h1, h2 { padding-bottom: .3em; border-bottom: 1px solid ${v("widget-border", "#3c3c3c")}; }
p, ul, ol, blockquote, pre, table, dl { margin: 0 0 1em; }
ul, ol { padding-left: 2em; }
a { color: ${v("textLink-foreground", "#3794ff")}; text-decoration: none; }
a:hover { text-decoration: underline; }
code { font: .9em Consolas, "Cascadia Mono", "Courier New", monospace; padding: .15em .35em; border-radius: 3px;
  background: color-mix(in srgb, ${v("foreground", "#cccccc")} 12%, transparent); }
pre { padding: 12px 14px; overflow: auto; border-radius: 5px; line-height: 1.45;
  background: ${v("sideBar-background", "#252526")}; border: 1px solid ${v("widget-border", "#3c3c3c")}; }
pre code { padding: 0; background: none; font-size: .9em; }
blockquote { margin-left: 0; padding: 0 1em; border-left: 4px solid ${v("widget-border", "#3c3c3c")}; color: ${v("descriptionForeground", "#8a8a8a")}; }
table { border-collapse: collapse; display: block; overflow: auto; }
th, td { border: 1px solid ${v("widget-border", "#3c3c3c")}; padding: 6px 12px; }
th { background: ${v("sideBar-background", "#252526")}; text-align: left; }
hr { border: 0; border-top: 1px solid ${v("widget-border", "#3c3c3c")}; margin: 1.6em 0; }
img { max-width: 100%; }
::-webkit-scrollbar { width: 10px; height: 10px; }
::-webkit-scrollbar-track, ::-webkit-scrollbar-corner { background: transparent; }
::-webkit-scrollbar-thumb { background: ${v("scrollbarSlider-background", "rgba(121,121,121,.4)")}; border: 2px solid transparent; border-radius: 6px; background-clip: padding-box; }
::-webkit-scrollbar-thumb:hover { background-color: ${v("scrollbarSlider-hoverBackground", "rgba(100,100,100,.7)")}; }
`;
}
