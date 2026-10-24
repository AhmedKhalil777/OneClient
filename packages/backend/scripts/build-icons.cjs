/**
 * Source of oneClient's built-in product icons. Each icon is drawn on a 16×16
 * grid with 1.2px strokes (codicon-like) and written to resources/icons/<id>.svg.
 * They're monochrome on purpose: the UI uses them as CSS masks and paints them
 * with the theme's text colour. Re-run after editing:
 *
 *   node packages/core/scripts/build-icons.cjs
 */
const fs = require("node:fs");
const path = require("node:path");

const S = 'fill="none" stroke="#000" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"';
const F = 'fill="#000"';

const icons = {
  // files
  folder: `<path ${S} d="M1.5 4.2v8.3a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1V5.7a1 1 0 0 0-1-1H7.6L6.1 3.2H2.5a1 1 0 0 0-1 1z"/>`,
  "folder-opened": `<path ${S} d="M1.5 12.5V4.2a1 1 0 0 1 1-1h3.6l1.5 1.5h5a1 1 0 0 1 1 1v1.3"/><path ${S} d="M1.5 12.5l1.8-5.3a1 1 0 0 1 .95-.7h9.95a.6.6 0 0 1 .57.8l-1.7 5a1 1 0 0 1-.95.7H2.5a1 1 0 0 1-1-.5z"/>`,
  file: `<path ${S} d="M3.5 1.5h6l3 3v10h-9z"/><path ${S} d="M9.5 1.5v3h3"/>`,
  "file-code": `<path ${S} d="M3.5 1.5h6l3 3v10h-9z"/><path ${S} d="M9.5 1.5v3h3M6.5 8 5 9.5 6.5 11M9.5 8 11 9.5 9.5 11"/>`,
  files: `<path ${S} d="M5.5 1.5h5l3 3v8h-8z"/><path ${S} d="M10.5 1.5v3h3M5.5 4.5h-3v10h8v-2"/>`,
  // data
  server: `<rect ${S} x="2" y="2" width="12" height="5" rx="1"/><rect ${S} x="2" y="9" width="12" height="5" rx="1"/><circle ${F} cx="4.6" cy="4.5" r=".8"/><circle ${F} cx="4.6" cy="11.5" r=".8"/>`,
  database: `<ellipse ${S} cx="8" cy="3.8" rx="5.3" ry="2"/><path ${S} d="M2.7 3.8v8.4c0 1.1 2.4 2 5.3 2s5.3-.9 5.3-2V3.8M2.7 8c0 1.1 2.4 2 5.3 2s5.3-.9 5.3-2"/>`,
  table: `<rect ${S} x="1.5" y="2.5" width="13" height="11" rx="1"/><path ${S} d="M1.5 6h13M1.5 9.7h13M6 6v7.5"/>`,
  view: `<rect ${S} x="1.5" y="2.5" width="13" height="11" rx="1" stroke-dasharray="2 1.4"/><circle ${S} cx="8" cy="8" r="2"/>`,
  column: `<rect ${S} x="5" y="1.5" width="6" height="13" rx="1"/><path ${S} d="M5 5.8h6M5 10.2h6"/>`,
  key: `<circle ${S} cx="5" cy="8" r="3"/><path ${S} d="M8 8h6.5M12.5 8v2.5M14.5 8v2"/>`,
  index: `<path ${S} d="M3 3.5h10M3 6.5h6.5M3 9.5h10M3 12.5h5"/>`,
  function: `<path ${S} d="M10.5 2.3c-1.6-.5-2.8.3-3.1 1.9L5.9 11.8c-.3 1.6-1.5 2.4-3.1 1.9M4.6 6.2h5"/><path ${S} d="M10 9.2l3 3.8M13 9.2l-3 3.8"/>`,
  procedure: `<path ${S} d="M3.5 1.5h6l3 3v10h-9z"/><path ${S} d="M5.5 8l1.6 1.5L5.5 11M8.5 11.5h2.5"/>`,
  // tools
  terminal: `<rect ${S} x="1.5" y="2.5" width="13" height="11" rx="1.2"/><path ${S} d="M4.5 6.3 6.8 8l-2.3 1.7M8.3 10.5h3.2"/>`,
  results: `<rect ${S} x="1.5" y="2.5" width="13" height="11" rx="1"/><path ${S} d="M1.5 6.2h13M1.5 9.9h13M6 2.5v11M10 2.5v11"/>`,
  output: `<path ${S} d="M2 3.5h12M2 6.5h9M2 9.5h12M2 12.5h7"/>`,
  plug: `<path ${S} d="M6 1.5v3M10 1.5v3M4 4.5h8v3a4 4 0 0 1-8 0zM8 11.5v3"/>`,
  extensions: `<rect ${S} x="1.5" y="1.5" width="5.5" height="5.5" rx=".8"/><rect ${S} x="1.5" y="9" width="5.5" height="5.5" rx=".8"/><rect ${S} x="9" y="9" width="5.5" height="5.5" rx=".8"/><rect ${S} x="9.3" y="1.3" width="5.5" height="5.5" rx=".8" transform="rotate(15 12 4)"/>`,
  gear: `<circle ${S} cx="8" cy="8" r="2.2"/><path ${S} d="M8 1.5v1.8M8 12.7v1.8M14.5 8h-1.8M3.3 8H1.5M12.6 3.4l-1.3 1.3M4.7 11.3l-1.3 1.3M12.6 12.6l-1.3-1.3M4.7 4.7 3.4 3.4"/><circle ${S} cx="8" cy="8" r="4.6"/>`,
  search: `<circle ${S} cx="6.8" cy="6.8" r="4.3"/><path ${S} d="M10 10l4.5 4.5"/>`,
  // actions
  play: `<path ${S} d="M4.5 2.8v10.4L13 8z"/>`,
  stop: `<rect ${S} x="3.5" y="3.5" width="9" height="9" rx="1"/>`,
  refresh: `<path ${S} d="M13.3 7.2A5.3 5.3 0 1 0 12 11.5"/><path ${S} d="M13.6 3.2v4h-4"/>`,
  add: `<path ${S} d="M8 2.5v11M2.5 8h11"/>`,
  close: `<path ${S} d="M3.5 3.5l9 9M12.5 3.5l-9 9"/>`,
  trash: `<path ${S} d="M2.5 4h11M6 4V2.5h4V4M4 4l.8 10h6.4L12 4M6.6 6.5v5M9.4 6.5v5"/>`,
  ellipsis: `<circle ${F} cx="3.5" cy="8" r="1.1"/><circle ${F} cx="8" cy="8" r="1.1"/><circle ${F} cx="12.5" cy="8" r="1.1"/>`,
  "chevron-right": `<path ${S} d="M6 3.5 10.5 8 6 12.5"/>`,
  "chevron-down": `<path ${S} d="M3.5 6 8 10.5 12.5 6"/>`,
  "chevron-up": `<path ${S} d="M3.5 10 8 5.5 12.5 10"/>`,
  "split-horizontal": `<rect ${S} x="1.5" y="2.5" width="13" height="11" rx="1"/><path ${S} d="M1.5 8h13"/>`,
  "color-mode": `<circle ${S} cx="8" cy="8" r="6.3"/><path ${F} d="M8 1.7a6.3 6.3 0 0 1 0 12.6z"/>`,
  preview: `<path ${S} d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8s-2.4 4.5-6.5 4.5S1.5 8 1.5 8z"/><circle ${S} cx="8" cy="8" r="1.9"/>`,
  symbol: `<path ${S} d="M5 2.5H3.5v11H5M11 2.5h1.5v11H11"/>`,
  // people & access
  user: `<circle ${S} cx="8" cy="5.2" r="2.7"/><path ${S} d="M2.6 14c.3-2.9 2.5-4.6 5.4-4.6s5.1 1.7 5.4 4.6"/>`,
  users: `<circle ${S} cx="6" cy="5.4" r="2.4"/><path ${S} d="M1.5 13.6c.3-2.6 2.1-4.1 4.5-4.1s4.2 1.5 4.5 4.1"/><path ${S} d="M10.4 3.4a2.4 2.4 0 0 1 0 4.6M12 9.6c1.4.5 2.3 1.8 2.5 4"/>`,
  shield: `<path ${S} d="M8 1.6 2.8 3.5v4c0 3.2 2.1 5.5 5.2 6.9 3.1-1.4 5.2-3.7 5.2-6.9v-4z"/><path ${S} d="M5.6 7.9 7.3 9.6 10.5 6.2"/>`,
  lock: `<rect ${S} x="3" y="7" width="10" height="7" rx="1.2"/><path ${S} d="M5.2 7V5a2.8 2.8 0 0 1 5.6 0v2"/><circle ${F} cx="8" cy="10.5" r="1"/>`,
  tag: `<path ${S} d="M1.8 2.5v5.1l6.6 6.6a1 1 0 0 0 1.4 0l4.4-4.4a1 1 0 0 0 0-1.4L7.6 1.8H2.5a.7.7 0 0 0-.7.7z"/><circle ${F} cx="5" cy="5" r="1"/>`,
  // places & things
  globe: `<circle ${S} cx="8" cy="8" r="6.3"/><path ${S} d="M1.7 8h12.6M8 1.7c1.8 1.9 2.7 4 2.7 6.3S9.8 12.4 8 14.3M8 1.7C6.2 3.6 5.3 5.7 5.3 8s.9 4.4 2.7 6.3"/>`,
  link: `<path ${S} d="M6.8 9.2a2.7 2.7 0 0 0 3.8 0l2.2-2.2a2.7 2.7 0 0 0-3.8-3.8l-.9.9"/><path ${S} d="M9.2 6.8a2.7 2.7 0 0 0-3.8 0L3.2 9a2.7 2.7 0 0 0 3.8 3.8l.9-.9"/>`,
  window: `<rect ${S} x="1.5" y="2.5" width="13" height="11" rx="1.2"/><path ${S} d="M1.5 5.7h13"/><circle ${F} cx="3.6" cy="4.1" r=".6"/><circle ${F} cx="5.4" cy="4.1" r=".6"/>`,
  cube: `<path ${S} d="M8 1.6 13.8 4.8v6.4L8 14.4 2.2 11.2V4.8z"/><path ${S} d="M2.4 4.9 8 8l5.6-3.1M8 8v6.2"/>`,
  // utilities
  clock: `<circle ${S} cx="8" cy="8" r="6.3"/><path ${S} d="M8 4.2V8l2.6 1.6"/>`,
  bell: `<path ${S} d="M3.6 11.2V7.4a4.4 4.4 0 0 1 8.8 0v3.8l1.1 1.3H2.5z"/><path ${S} d="M6.6 14a1.5 1.5 0 0 0 2.8 0"/>`,
  wrench: `<path ${S} d="M9.6 2.2a3.4 3.4 0 0 0-3.2 4.5L2.3 10.8a1.5 1.5 0 0 0 2.1 2.1l4.1-4.1a3.4 3.4 0 0 0 4.5-3.2l-2.1 1.6-1.9-.5-.5-1.9z"/>`,
};

const outDir = path.join(__dirname, "..", "resources", "icons");
fs.mkdirSync(outDir, { recursive: true });
for (const [id, body] of Object.entries(icons)) {
  fs.writeFileSync(path.join(outDir, `${id}.svg`), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16">${body}</svg>\n`);
}
console.log(`${Object.keys(icons).length} icons → ${path.relative(process.cwd(), outDir)}`);
