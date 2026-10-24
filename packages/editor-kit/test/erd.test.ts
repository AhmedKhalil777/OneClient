import { describe, expect, it } from "vitest";
import { type ErModel, type ErTable, bounds, edgeGeometry, layoutModel, measure, toDbml, toMermaid, toSvg, visibleColumns } from "../src/erd/model.js";

const col = (name: string, type: string, o: { pk?: boolean; fk?: boolean; nullable?: boolean } = {}) => ({ name, type, nullable: o.nullable ?? !o.pk, pk: !!o.pk, fk: !!o.fk });
const table = (name: string, columns: ErTable["columns"], schema = "public"): ErTable => ({ id: `${schema}.${name}`, schema, name, kind: "table", columns });

const shop: ErModel = {
  database: "shop",
  tables: [
    table("customers", [col("id", "integer", { pk: true }), col("name", "text", { nullable: false }), col("email", "text")]),
    table("orders", [col("id", "bigint", { pk: true }), col("customer_id", "integer", { fk: true, nullable: false }), col("total", "numeric(10,2)")]),
    table("order_items", [col("order_id", "bigint", { pk: true, fk: true }), col("line", "integer", { pk: true }), col("sku", "text", { fk: true })]),
    table("products", [col("sku", "text", { pk: true }), col("title", "character varying(200)")]),
    table("audit_log", [col("id", "bigint", { pk: true }), col("at", "timestamp with time zone")]),
    table("employees", [col("id", "integer", { pk: true }), col("manager_id", "integer", { fk: true })]),
  ],
  relations: [
    { id: "r1", name: "orders_customer_fk", from: "public.orders", fromColumns: ["customer_id"], to: "public.customers", toColumns: ["id"], onDelete: "CASCADE" },
    { id: "r2", name: "items_order_fk", from: "public.order_items", fromColumns: ["order_id"], to: "public.orders", toColumns: ["id"] },
    { id: "r3", name: "items_product_fk", from: "public.order_items", fromColumns: ["sku"], to: "public.products", toColumns: ["sku"] },
    { id: "r4", name: "employees_manager_fk", from: "public.employees", fromColumns: ["manager_id"], to: "public.employees", toColumns: ["id"] },
  ],
};

describe("layout", () => {
  const layout = layoutModel(shop, "all");

  it("places every table, parents left of the tables that reference them", () => {
    expect(Object.keys(layout).sort()).toEqual(shop.tables.map((t) => t.id).sort());
    for (const r of shop.relations.filter((x) => x.from !== x.to)) {
      expect(layout[r.to]!.x + layout[r.to]!.w, r.name).toBeLessThan(layout[r.from]!.x);
    }
  });

  it("never overlaps two tables", () => {
    const boxes = Object.entries(layout);
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const [, a] = boxes[i]!;
        const [, b] = boxes[j]!;
        const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
        expect(apart, `${boxes[i]![0]} vs ${boxes[j]![0]}`).toBe(true);
      }
    }
  });

  it("survives cycles and is deterministic", () => {
    const cyclic: ErModel = {
      ...shop,
      relations: [...shop.relations, { id: "r5", name: "customers_last_order_fk", from: "public.customers", fromColumns: ["email"], to: "public.orders", toColumns: ["id"] }],
    };
    expect(layoutModel(cyclic, "keys")).toEqual(layoutModel(cyclic, "keys"));
    expect(Object.keys(layoutModel(cyclic, "keys"))).toHaveLength(shop.tables.length);
  });

  it("sizes boxes by the column mode", () => {
    const orders = shop.tables[1]!;
    expect(measure(orders, "none").h).toBeLessThan(measure(orders, "keys").h);
    expect(measure(orders, "keys").h).toBeLessThan(measure(orders, "all").h);
    expect(bounds(layout).w).toBeGreaterThan(0);
  });
});

describe("columns", () => {
  it("keeps key columns visible when a table has too many to show", () => {
    const wide = table("wide", [...Array.from({ length: 30 }, (_, i) => col(`c${i}`, "int")), col("owner_id", "int", { fk: true })]);
    const { columns, hidden } = visibleColumns(wide, "all");
    expect(columns.map((c) => c.name)).toContain("owner_id");
    expect(columns.length + hidden).toBe(31);
    expect(visibleColumns(wide, "keys").columns.map((c) => c.name)).toEqual(["owner_id"]);
  });
});

describe("lines", () => {
  const layout = layoutModel(shop, "all");
  const byId = new Map(shop.tables.map((t) => [t.id, t]));

  it("draws a crow's foot at the child, two bars at a required parent", () => {
    const g = edgeGeometry(shop.relations[0]!, byId, layout, "all")!;
    expect(g.path.startsWith("M")).toBe(true);
    expect(g.childGlyph.match(/M/g)).toHaveLength(3); // three prongs
    expect(g.parentGlyph.match(/M/g)).toHaveLength(2); // mandatory: ||
    expect(g.optional).toBeNull();
  });

  it("marks an optional reference and a one-to-one link", () => {
    const optional = edgeGeometry(shop.relations[2]!, byId, layout, "all")!; // order_items.sku is nullable
    expect(optional.optional).not.toBeNull();
    const oneToOne: ErModel = { ...shop, relations: [{ id: "x", name: "x", from: "public.order_items", fromColumns: ["order_id", "line"], to: "public.orders", toColumns: ["id", "id"] }] };
    const g = edgeGeometry(oneToOne.relations[0]!, byId, layout, "all")!;
    expect(g.childGlyph.match(/M/g)).toHaveLength(1); // a single bar, not a crow's foot
  });

  it("loops a self-reference on the right side", () => {
    const g = edgeGeometry(shop.relations[3]!, byId, layout, "all")!;
    const b = layout["public.employees"]!;
    expect(g.path.startsWith(`M${b.x + b.w} `)).toBe(true);
  });
});

describe("exporters", () => {
  it("Mermaid: entities, keys and crow's-foot relationships", () => {
    const m = toMermaid(shop);
    expect(m).toMatch(/^erDiagram\n/);
    expect(m).toContain('customers ||--o{ orders : "orders_customer_fk"');
    expect(m).toContain('products |o--o{ order_items : "items_product_fk"');
    expect(m).toContain("numeric(10_2) total");
    expect(m).toContain("integer customer_id FK");
    expect(m).toContain("bigint order_id PK,FK");
  });

  it("DBML: tables, settings, quoted types and refs", () => {
    const d = toDbml(shop);
    expect(d).toContain("Table public.customers {");
    expect(d).toContain("  id integer [pk, not null]");
    expect(d).toContain('  title "character varying(200)"');
    expect(d).toContain("Ref orders_customer_fk: public.orders.customer_id > public.customers.id [delete: cascade]");
  });

  it("SVG: standalone, escaped, every table drawn", () => {
    const evil: ErModel = { ...shop, tables: [...shop.tables, table("a<b>&c", [col("x", "int")])] };
    const svg = toSvg(evil, layoutModel(evil, "all"), "all");
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(svg).toContain("a&lt;b&gt;&amp;c");
    expect(svg).not.toContain("a<b>");
    for (const t of shop.tables) expect(svg).toContain(`>${t.name}<`);
  });
});
