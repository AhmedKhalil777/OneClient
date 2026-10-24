/**
 * Entity–relationship diagrams for SQL plugins: one dialect-neutral model (PostgreSQL, SQL Server… each extract it from
 * their own catalog), an automatic layout, the geometry of every box and line, and exporters (Mermaid, DBML, SVG).
 * Everything here is pure — the React view (ErDiagram.tsx) only draws it and handles the mouse.
 */

export interface ErColumn {
  name: string;
  type: string;
  nullable: boolean;
  pk: boolean;
  fk: boolean;
}

export interface ErTable {
  /** Unique in the model, e.g. "public.orders". */
  id: string;
  schema: string;
  name: string;
  kind: "table" | "view";
  columns: ErColumn[];
  comment?: string | undefined;
}

export interface ErRelation {
  id: string;
  /** Constraint name. */
  name: string;
  /** The referencing (child) table and its columns. */
  from: string;
  fromColumns: string[];
  /** The referenced (parent) table and its columns. */
  to: string;
  toColumns: string[];
  /** "CASCADE", "SET NULL"… (omitted for NO ACTION). */
  onDelete?: string | undefined;
}

export interface ErModel {
  database: string;
  tables: ErTable[];
  relations: ErRelation[];
  /** More tables existed than the extractor returned. */
  truncated?: boolean | undefined;
}

/** How much of each table to show: every column, only key columns, or just the name. */
export type ColumnMode = "all" | "keys" | "none";

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
export type Layout = Record<string, Box>;

// ---- sizes -------------------------------------------------------------------------------------------------------------

export const HEADER = 30;
export const ROW = 20;
const PAD = 6;
/** Columns shown per table before "+N more" (key columns are always kept). */
export const MAX_ROWS = 14;

/** The columns a table shows in this mode, and how many are left out. */
export function visibleColumns(table: ErTable, mode: ColumnMode): { columns: ErColumn[]; hidden: number } {
  if (mode === "none") return { columns: [], hidden: table.columns.length };
  const wanted = mode === "keys" ? table.columns.filter((c) => c.pk || c.fk) : table.columns;
  if (wanted.length <= MAX_ROWS) return { columns: wanted, hidden: table.columns.length - wanted.length };
  // Too many: keep every key column (lines attach to them), fill up with the rest in table order.
  const keys = new Set(wanted.filter((c) => c.pk || c.fk));
  let room = Math.max(0, MAX_ROWS - keys.size);
  const columns = wanted.filter((c) => keys.has(c) || room-- > 0);
  return { columns, hidden: table.columns.length - columns.length };
}

/** Approximate text widths for the diagram's 12.5px UI font (layout runs without a DOM). */
const textWidth = (s: string, perChar: number) => s.length * perChar;

export function measure(table: ErTable, mode: ColumnMode): { w: number; h: number } {
  const { columns, hidden } = visibleColumns(table, mode);
  const title = textWidth(table.name, 7.6) + 44;
  const rows = columns.map((c) => textWidth(c.name, 6.9) + textWidth(c.type, 6.3) + 64);
  const w = Math.round(Math.min(380, Math.max(150, title, ...rows)));
  // "+N more" only where columns were cut for room (All); Keys and Names leave columns out on purpose.
  const more = hidden > 0 && mode === "all" ? 1 : 0;
  const h = HEADER + (columns.length + more) * ROW + (columns.length + more ? PAD : 0);
  return { w, h };
}

/** Vertical position (from the table's top) where a column's line attaches; the header when it isn't shown. */
export function columnY(table: ErTable, column: string | undefined, mode: ColumnMode): number {
  const { columns } = visibleColumns(table, mode);
  const i = column === undefined ? -1 : columns.findIndex((c) => c.name === column);
  return i < 0 ? HEADER / 2 : HEADER + i * ROW + ROW / 2;
}

// ---- layout ------------------------------------------------------------------------------------------------------------

const RANK_GAP = 96;
const NODE_GAP = 28;
const COMPONENT_GAP = 80;

/**
 * Places every table. Tables joined by foreign keys form a component; inside one, referenced (parent) tables sit to the
 * left of the tables that reference them, in columns ("ranks"), ordered to keep lines short. Components are then packed
 * in rows, biggest first, unrelated tables last.
 */
export function layoutModel(model: ErModel, mode: ColumnMode): Layout {
  const sizes = new Map(model.tables.map((t) => [t.id, measure(t, mode)]));
  const ids = model.tables.map((t) => t.id);
  const known = new Set(ids);
  const relations = model.relations.filter((r) => known.has(r.from) && known.has(r.to) && r.from !== r.to);

  // Components (union-find).
  const parent = new Map(ids.map((id) => [id, id]));
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(x, r);
    return r;
  };
  for (const r of relations) parent.set(find(r.from), find(r.to));
  const groups = new Map<string, string[]>();
  for (const id of ids) {
    const root = find(id);
    groups.set(root, [...(groups.get(root) ?? []), id]);
  }

  const placed: Array<{ boxes: Layout; w: number; h: number; n: number }> = [];
  for (const members of groups.values()) placed.push(layoutComponent(members, relations, sizes));

  // Pack: biggest components first, single tables last, in rows no wider than about a screen and a half.
  placed.sort((a, b) => b.n - a.n || b.h - a.h);
  const area = placed.reduce((s, c) => s + (c.w + COMPONENT_GAP) * (c.h + COMPONENT_GAP), 0);
  const maxRow = Math.max(1400, Math.sqrt(area) * 1.6, ...placed.map((c) => c.w));
  const layout: Layout = {};
  let x = 0;
  let y = 0;
  let rowH = 0;
  for (const c of placed) {
    if (x > 0 && x + c.w > maxRow) {
      x = 0;
      y += rowH + COMPONENT_GAP;
      rowH = 0;
    }
    for (const [id, b] of Object.entries(c.boxes)) layout[id] = { ...b, x: b.x + x, y: b.y + y };
    x += c.w + COMPONENT_GAP;
    rowH = Math.max(rowH, c.h);
  }
  return layout;
}

function layoutComponent(members: string[], relations: ErRelation[], sizes: Map<string, { w: number; h: number }>) {
  const inside = new Set(members);
  const rels = relations.filter((r) => inside.has(r.from) && inside.has(r.to));
  // Rank = 1 + the rank of the deepest table it references (bounded, so cycles end).
  const rank = new Map(members.map((id) => [id, 0]));
  for (let i = 0; i < members.length; i++) {
    let changed = false;
    for (const r of rels) {
      const want = rank.get(r.to)! + 1;
      if (want > rank.get(r.from)! && want < members.length) {
        rank.set(r.from, want);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const levels: string[][] = [];
  for (const id of [...members].sort()) {
    const r = rank.get(id)!;
    (levels[r] ??= []).push(id);
  }
  const ranks = levels.filter((l) => l && l.length);

  // Order inside each rank by the average position of neighbours (barycentre), a few sweeps each way.
  const neighbours = new Map<string, string[]>(members.map((id) => [id, []]));
  for (const r of rels) {
    neighbours.get(r.from)!.push(r.to);
    neighbours.get(r.to)!.push(r.from);
  }
  const position = new Map<string, number>();
  const index = () => ranks.forEach((level) => level.forEach((id, i) => position.set(id, i)));
  index();
  const sweep = (level: string[]) => {
    const score = (id: string) => {
      const ns = neighbours.get(id)!.filter((n) => position.has(n));
      return ns.length ? ns.reduce((s, n) => s + position.get(n)!, 0) / ns.length : position.get(id)!;
    };
    level.sort((a, b) => score(a) - score(b));
    level.forEach((id, i) => position.set(id, i));
  };
  for (let pass = 0; pass < 4; pass++) {
    for (let r = 1; r < ranks.length; r++) sweep(ranks[r]!);
    for (let r = ranks.length - 2; r >= 0; r--) sweep(ranks[r]!);
  }

  // Coordinates: one column per rank, centred vertically.
  const heights = ranks.map((level) => level.reduce((s, id) => s + sizes.get(id)!.h, 0) + NODE_GAP * (level.length - 1));
  const h = Math.max(...heights);
  const boxes: Layout = {};
  let x = 0;
  ranks.forEach((level, r) => {
    const w = Math.max(...level.map((id) => sizes.get(id)!.w));
    let y = (h - heights[r]!) / 2;
    for (const id of level) {
      const s = sizes.get(id)!;
      boxes[id] = { x, y: Math.round(y), w: s.w, h: s.h };
      y += s.h + NODE_GAP;
    }
    x += w + RANK_GAP;
  });
  return { boxes, w: x - RANK_GAP, h, n: members.length };
}

/** The bounding box of a layout (for "fit" and export). */
export function bounds(layout: Layout, ids?: Iterable<string>): Box {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const id of ids ?? Object.keys(layout)) {
    const b = layout[id];
    if (!b) continue;
    x0 = Math.min(x0, b.x);
    y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.w);
    y1 = Math.max(y1, b.y + b.h);
  }
  return Number.isFinite(x0) ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : { x: 0, y: 0, w: 0, h: 0 };
}

// ---- lines -------------------------------------------------------------------------------------------------------------

export interface EdgeGeometry {
  /** The curve from the child (referencing) column to the parent (referenced) column. */
  path: string;
  /** Crow's foot (many) at the child end, or a bar for one-to-one. */
  childGlyph: string;
  /** One bar (+ a second bar when required) at the parent end. */
  parentGlyph: string;
  /** Optional reference (nullable FK): a small circle at the parent end. */
  optional: { cx: number; cy: number } | null;
  /** Where to put a label: the curve's midpoint. */
  mid: { x: number; y: number };
}

/** Whether the FK's columns are the child's whole primary key (or a unique set) → one-to-one. */
export function isOneToOne(rel: ErRelation, child: ErTable): boolean {
  const pk = child.columns.filter((c) => c.pk).map((c) => c.name);
  return pk.length > 0 && pk.length === rel.fromColumns.length && pk.every((c) => rel.fromColumns.includes(c));
}

export function edgeGeometry(rel: ErRelation, tables: Map<string, ErTable>, layout: Layout, mode: ColumnMode): EdgeGeometry | null {
  const child = tables.get(rel.from);
  const parentTable = tables.get(rel.to);
  const c = layout[rel.from];
  const p = layout[rel.to];
  if (!child || !parentTable || !c || !p) return null;
  const sy = c.y + columnY(child, rel.fromColumns[0], mode);
  const ey = p.y + columnY(parentTable, rel.toColumns[0], mode);
  let sx: number;
  let ex: number;
  let ds: number;
  let de: number;
  if (rel.from === rel.to) {
    // Self-reference: a loop on the right side.
    sx = ex = c.x + c.w;
    ds = de = 1;
  } else if (c.x >= p.x + p.w) {
    sx = c.x;
    ds = -1;
    ex = p.x + p.w;
    de = 1;
  } else if (c.x + c.w <= p.x) {
    sx = c.x + c.w;
    ds = 1;
    ex = p.x;
    de = -1;
  } else {
    // Stacked in the same column: leave and enter on the right.
    sx = c.x + c.w;
    ds = 1;
    ex = p.x + p.w;
    de = 1;
  }
  const g = 14; // glyph length: the curve starts past the markers
  const a = { x: sx + ds * g, y: sy };
  const b = { x: ex + de * g, y: ey };
  const bend = rel.from === rel.to ? 48 : Math.max(36, Math.abs(b.x - a.x) / 2);
  const path = `M${sx} ${sy}H${a.x}C${a.x + ds * bend} ${a.y} ${b.x + de * bend} ${b.y} ${b.x} ${b.y}H${ex}`;

  const oneToOne = isOneToOne(rel, child);
  const childGlyph = oneToOne
    ? `M${sx + ds * 8} ${sy - 6}V${sy + 6}`
    : `M${sx + ds * 12} ${sy}L${sx} ${sy - 6}M${sx + ds * 12} ${sy}L${sx} ${sy + 6}M${sx + ds * 12} ${sy}L${sx} ${sy}`;
  const required = rel.fromColumns.every((name) => child.columns.find((col) => col.name === name)?.nullable === false);
  const parentGlyph = required ? `M${ex + de * 5} ${ey - 6}V${ey + 6}M${ex + de * 10} ${ey - 6}V${ey + 6}` : `M${ex + de * 5} ${ey - 6}V${ey + 6}`;
  const optional = required ? null : { cx: ex + de * 13, cy: ey };
  return { path, childGlyph, parentGlyph, optional, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
}

// ---- exporters ---------------------------------------------------------------------------------------------------------

const mermaidName = (s: string) => s.replace(/[^A-Za-z0-9_]/g, "_").replace(/^(\d)/, "_$1");
const mermaidType = (s: string) => s.replace(/\s+/g, "_").replace(/[^A-Za-z0-9_\-[\]()]/g, "_") || "unknown";

/** Mermaid `erDiagram` — renders in GitHub, GitLab, Notion, docs sites. */
export function toMermaid(model: ErModel): string {
  const name = tableNamer(model);
  const lines = ["erDiagram"];
  const byId = new Map(model.tables.map((t) => [t.id, t]));
  for (const r of model.relations) {
    const child = byId.get(r.from);
    if (!child || !byId.has(r.to)) continue;
    const required = r.fromColumns.every((c) => child.columns.find((x) => x.name === c)?.nullable === false);
    const left = required ? "||" : "|o";
    const right = isOneToOne(r, child) ? "||" : "o{";
    lines.push(`    ${name(r.to)} ${left}--${right} ${name(r.from)} : "${r.name.replace(/"/g, "'")}"`);
  }
  for (const t of model.tables) {
    lines.push(`    ${name(t.id)} {`);
    for (const c of t.columns) {
      const keys = [c.pk ? "PK" : "", c.fk ? "FK" : ""].filter(Boolean).join(",");
      lines.push(`        ${mermaidType(c.type)} ${mermaidName(c.name)}${keys ? ` ${keys}` : ""}`);
    }
    lines.push("    }");
  }
  return `${lines.join("\n")}\n`;
}

/** Entity names for Mermaid: just the table name, schema-prefixed only where two schemas share a name. */
function tableNamer(model: ErModel): (id: string) => string {
  const counts = new Map<string, number>();
  for (const t of model.tables) counts.set(t.name, (counts.get(t.name) ?? 0) + 1);
  const byId = new Map(model.tables.map((t) => [t.id, t]));
  return (id) => {
    const t = byId.get(id);
    if (!t) return mermaidName(id);
    return mermaidName((counts.get(t.name) ?? 0) > 1 ? `${t.schema}_${t.name}` : t.name);
  };
}

const dbmlIdent = (s: string) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(s) ? s : `"${s.replace(/"/g, '\\"')}"`);

/** DBML — dbdiagram.io / dbdocs.io, and convertible back to SQL. */
export function toDbml(model: ErModel): string {
  const out: string[] = [`// ${model.database} — exported by oneClient`, ""];
  const byId = new Map(model.tables.map((t) => [t.id, t]));
  const ref = (t: ErTable) => `${dbmlIdent(t.schema)}.${dbmlIdent(t.name)}`;
  for (const t of model.tables) {
    out.push(`Table ${ref(t)} {`);
    for (const c of t.columns) {
      const settings = [c.pk ? "pk" : "", c.nullable ? "" : "not null"].filter(Boolean);
      const type = /^[A-Za-z0-9_]+$/.test(c.type) ? c.type : `"${c.type}"`;
      out.push(`  ${dbmlIdent(c.name)} ${type}${settings.length ? ` [${settings.join(", ")}]` : ""}`);
    }
    if (t.comment) out.push(`  Note: '${t.comment.replace(/'/g, "\\'")}'`);
    out.push("}", "");
  }
  for (const r of model.relations) {
    const child = byId.get(r.from);
    const par = byId.get(r.to);
    if (!child || !par) continue;
    const cols = (t: ErTable, cs: string[]) => (cs.length === 1 ? `${ref(t)}.${dbmlIdent(cs[0]!)}` : `${ref(t)}.(${cs.map(dbmlIdent).join(", ")})`);
    const op = isOneToOne(r, child) ? "-" : ">";
    const del = r.onDelete ? ` [delete: ${r.onDelete.toLowerCase()}]` : "";
    out.push(`Ref ${dbmlIdent(r.name)}: ${cols(child, r.fromColumns)} ${op} ${cols(par, r.toColumns)}${del}`);
  }
  return `${out.join("\n").trimEnd()}\n`;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** A standalone SVG of the diagram (light colours, fonts inline) — for documents, wikis and PNG export. */
export function toSvg(model: ErModel, layout: Layout, mode: ColumnMode, ids?: Set<string>): string {
  const tables = model.tables.filter((t) => layout[t.id] && (!ids || ids.has(t.id)));
  const shown = new Set(tables.map((t) => t.id));
  const byId = new Map(model.tables.map((t) => [t.id, t]));
  const m = 24;
  const b = bounds(layout, shown);
  const ox = m - b.x;
  const oy = m - b.y;
  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${Math.ceil(b.w + 2 * m)}" height="${Math.ceil(b.h + 2 * m)}" viewBox="0 0 ${Math.ceil(b.w + 2 * m)} ${Math.ceil(b.h + 2 * m)}" font-family="Segoe UI, -apple-system, system-ui, sans-serif" font-size="12.5">`);
  parts.push(`<rect width="100%" height="100%" fill="#ffffff"/><g transform="translate(${ox} ${oy})">`);
  for (const r of model.relations) {
    if (!shown.has(r.from) || !shown.has(r.to)) continue;
    const g = edgeGeometry(r, byId, layout, mode);
    if (!g) continue;
    parts.push(`<g fill="none" stroke="#8a94a6" stroke-width="1.3"><path d="${g.path}"/><path d="${g.childGlyph}"/><path d="${g.parentGlyph}"/></g>`);
    if (g.optional) parts.push(`<circle cx="${g.optional.cx}" cy="${g.optional.cy}" r="3.5" fill="#fff" stroke="#8a94a6" stroke-width="1.3"/>`);
  }
  for (const t of tables) {
    const box = layout[t.id]!;
    const { columns, hidden } = visibleColumns(t, mode);
    parts.push(`<g transform="translate(${box.x} ${box.y})">`);
    parts.push(`<rect width="${box.w}" height="${box.h}" rx="6" fill="#ffffff" stroke="#c5cbd6"/>`);
    parts.push(`<path d="M0 6a6 6 0 0 1 6-6H${box.w - 6}a6 6 0 0 1 6 6V${HEADER}H0z" fill="${t.kind === "view" ? "#eef2e6" : "#e8f0fb"}"/>`);
    parts.push(`<text x="12" y="${HEADER / 2 + 4.5}" font-weight="600" fill="#1f2937">${esc(t.name)}</text>`);
    if (t.kind === "view") parts.push(`<text x="${box.w - 10}" y="${HEADER / 2 + 4}" text-anchor="end" font-size="10.5" fill="#6b7280">view</text>`);
    columns.forEach((c, i) => {
      const y = HEADER + i * ROW + ROW / 2 + 4.5;
      const key = c.pk ? "PK" : c.fk ? "FK" : "";
      if (key) parts.push(`<text x="10" y="${y}" font-size="9.5" font-weight="700" fill="${c.pk ? "#b45309" : "#2563eb"}">${key}</text>`);
      parts.push(`<text x="32" y="${y}" fill="#1f2937"${c.nullable ? "" : ' font-weight="500"'}>${esc(c.name)}</text>`);
      parts.push(`<text x="${box.w - 10}" y="${y}" text-anchor="end" font-size="11" fill="#6b7280">${esc(c.type)}</text>`);
    });
    if (hidden > 0 && mode === "all") parts.push(`<text x="32" y="${HEADER + columns.length * ROW + ROW / 2 + 4}" font-size="11" fill="#9ca3af">+${hidden} more</text>`);
    parts.push("</g>");
  }
  parts.push("</g></svg>");
  return parts.join("");
}
