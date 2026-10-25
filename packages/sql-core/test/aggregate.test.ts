import { describe, expect, it } from "vitest";
import { candidateFilter, childFilter, displayColumn, friendlyError, groupForeignKeys, searchFilter, justInsertedFilter, optionLabel, parentFilter, parentLinks, inheritedValues, linkRow, normalizeAggregate, suggestAggregate, validateAggregate } from "../src/aggregate/model.js";
import type { ForeignKey, Relation, TableRef } from "../src/aggregate/types.js";
import type { TableAccess, TableColumn } from "../src/table-editor/types.js";

const t = (table: string, schema = "public"): TableRef => ({ schema, table });
const fk = (name: string, table: string, columns: string[], refTable: string, refColumns: string[]): ForeignKey => ({ name, table: t(table), columns, refTable: t(refTable), refColumns });

// customers 1─* orders 1─* order_items *─1 products ; orders *─* tags via order_tags ; order_items 1─* item_notes
const FKS: ForeignKey[] = [
  fk("orders_customer", "orders", ["customer_id"], "customers", ["id"]),
  fk("items_order", "order_items", ["order_id"], "orders", ["id"]),
  fk("items_product", "order_items", ["product_id"], "products", ["id"]),
  fk("ot_order", "order_tags", ["order_id"], "orders", ["id"]),
  fk("ot_tag", "order_tags", ["tag_id"], "tags", ["id"]),
  fk("notes_item", "item_notes", ["item_id"], "order_items", ["id"]),
];
const PK = new Map<string, string[]>([["public.order_tags", ["order_id", "tag_id"]]]);

describe("suggestAggregate", () => {
  const config = suggestAggregate("shop", t("orders"), FKS, PK);

  it("finds one-to-many children and follows them", () => {
    expect(config.name).toBe("Orders");
    expect(config.root.label).toBe("Order");
    const items = config.root.children.find((c) => c.id === "order_items")!;
    expect(items).toMatchObject({ kind: "oneToMany", label: "Order items", link: [{ column: "order_id", parentColumn: "id" }] });
    expect(items.children.map((c) => c.id)).toEqual(["item_notes"]);
  });

  it("turns a join table into a many-to-many relation to the table on its other side", () => {
    const tags = config.root.children.find((c) => c.id === "tags")!;
    expect(tags.kind).toBe("manyToMany");
    expect(tags.table).toEqual(t("tags"));
    expect(tags.via).toEqual({ table: t("order_tags"), parent: [{ column: "order_id", parentColumn: "id" }], child: [{ column: "tag_id", parentColumn: "id" }] });
    expect(config.root.children.some((c) => c.id === "order_tags")).toBe(false);
  });

  it("does not follow a table back up its own path, and honours depth and exclusions", () => {
    const customers = suggestAggregate("shop", t("customers"), FKS, PK);
    expect(customers.root.children.map((c) => c.id)).toEqual(["orders"]);
    expect(customers.root.children[0]!.children.map((c) => c.id).sort()).toEqual(["order_items", "tags"]);
    const shallow = suggestAggregate("shop", t("orders"), FKS, PK, { depth: 1 });
    expect(shallow.root.children.every((c) => c.children.length === 0)).toBe(true);
    const without = suggestAggregate("shop", t("orders"), FKS, PK, { exclude: [t("item_notes")] });
    expect(without.root.children.find((c) => c.id === "order_items")!.children).toEqual([]);
  });

  it("treats a table with extra key columns as an ordinary child, not a join table", () => {
    const payload = new Map([["public.order_tags", ["order_id", "tag_id", "seq"]]]);
    const c = suggestAggregate("shop", t("orders"), FKS, payload);
    expect(c.root.children.find((r) => r.id === "order_tags")?.kind).toBe("oneToMany");
  });
});

describe("validate / normalize", () => {
  it("flags problems in a hand-edited file", () => {
    const bad = normalizeAggregate({ name: "", database: "", root: { table: { schema: "s", table: "" }, children: [{ id: "x y", kind: "manyToMany", table: { schema: "s", table: "a" }, via: { table: { schema: "s", table: "j" }, parent: [{ column: "a", parentColumn: "id" }], child: [] } }] } });
    const problems = validateAggregate(bad);
    expect(problems.join("\n")).toMatch(/needs a name/);
    expect(problems.join("\n")).toMatch(/needs a database/);
    expect(problems.join("\n")).toMatch(/needs a root table/);
    expect(problems.join("\n")).toMatch(/letters, digits/);
    expect(problems.join("\n")).toMatch(/one column/);
  });
  it("fills in what is missing", () => {
    const c = normalizeAggregate({ name: "X", database: "d", root: { table: t("a"), children: [{ table: t("b_items"), link: [{ column: "a_id", parentColumn: "id" }] }] } });
    expect(c.root.children[0]).toMatchObject({ id: "b_items", label: "B items", kind: "oneToMany", children: [] });
    expect(validateAggregate(c)).toEqual([]);
  });
});

describe("filters", () => {
  const col = (name: string, kind: TableColumn["kind"] = "number", over: Partial<TableColumn> = {}): TableColumn => ({ name, type: kind, kind, nullable: false, isPk: false, hasDefault: false, insertable: true, editable: true, ...over });
  const columns: Record<string, TableColumn[]> = {
    "public.order_items": [col("id", "number", { isPk: true }), col("order_id")],
    "public.tags": [col("id", "number", { isPk: true }), col("name", "text")],
    "public.order_tags": [col("order_id"), col("tag_id")],
    "public.notes": [col("code", "text"), col("owner", "text")],
  };
  const lookup = (r: TableRef) => columns[`${r.schema}.${r.table}`]!;
  const access = {
    quote: (n: string) => `"${n}"`,
    qualify: (x: { schema: string; table: string }) => `"${x.schema}"."${x.table}"`,
    literals: { string: "", bool: { true: "true", false: "false" } },
  } as unknown as TableAccess;
  const items: Relation = { id: "items", label: "Items", kind: "oneToMany", table: t("order_items"), link: [{ column: "order_id", parentColumn: "id" }], children: [] };
  const tags: Relation = { id: "tags", label: "Tags", kind: "manyToMany", table: t("tags"), link: [], via: { table: t("order_tags"), parent: [{ column: "order_id", parentColumn: "id" }], child: [{ column: "tag_id", parentColumn: "id" }] }, children: [] };

  it("selects a one-to-many parent's rows by the foreign key", () => {
    expect(childFilter(items, { id: 42 }, lookup, access, { database: "shop" })).toBe(`"order_id" = 42`);
    expect(childFilter(items, { id: "42" }, lookup, access, { database: "shop" })).toBe(`"order_id" = 42`);
  });

  it("asks the join table for a many-to-many parent's rows, and for the rows still free to link", () => {
    expect(childFilter(tags, { id: 7 }, lookup, access, { database: "shop" })).toBe(`"id" IN (SELECT "tag_id" FROM "public"."order_tags" WHERE "order_id" = 7)`);
    expect(candidateFilter(tags, { id: 7 }, lookup, access, { database: "shop" })).toBe(`NOT ("id" IN (SELECT "tag_id" FROM "public"."order_tags" WHERE "order_id" = 7))`);
    expect(() => candidateFilter(items, { id: 7 }, lookup, access, { database: "shop" })).toThrow(/many-to-many/);
  });

  it("quotes text keys safely and refuses a value that is not a number for a number column", () => {
    const notes: Relation = { id: "n", label: "N", kind: "oneToMany", table: t("notes"), link: [{ column: "owner", parentColumn: "code" }], children: [] };
    expect(childFilter(notes, { code: "O'Hara" }, lookup, access, { database: "d" })).toBe(`"owner" = 'O''Hara'`);
    expect(() => childFilter(items, { id: "1 OR 1=1" }, lookup, access, { database: "shop" })).toThrow(/not a number/);
  });

  it("refuses an unknown column and a missing parent value", () => {
    const wrong: Relation = { ...items, link: [{ column: "nope", parentColumn: "id" }] };
    expect(() => childFilter(wrong, { id: 1 }, lookup, access, { database: "shop" })).toThrow(/Unknown column "nope"/);
    expect(() => childFilter(items, {}, lookup, access, { database: "shop" })).toThrow(/no value for "id"/);
  });

  it("builds the join-table row to link, and the foreign key a new child inherits", () => {
    expect(linkRow(tags, { id: 7 }, { id: 3 })).toEqual({ order_id: 7, tag_id: 3 });
    expect(() => linkRow(tags, { id: 7 }, {})).toThrow(/no value/);
    expect(inheritedValues(items, { id: 7 })).toEqual({ order_id: 7 });
    expect(inheritedValues(tags, { id: 7 })).toEqual({});
  });
});

describe("groupForeignKeys", () => {
  it("joins per-column catalog rows into foreign keys, keeping column order", () => {
    const rows = [
      { name: "fk", schema: "dbo", table: "a", refSchema: "dbo", refTable: "b", column: "x", refColumn: "p" },
      { name: "fk", schema: "dbo", table: "a", refSchema: "dbo", refTable: "b", column: "y", refColumn: "q" },
      { name: "fk2", schema: "dbo", table: "c", refSchema: "dbo", refTable: "b", column: "z", refColumn: "p" },
    ];
    const out = groupForeignKeys(rows);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ columns: ["x", "y"], refColumns: ["p", "q"] });
  });
});

describe("parent lookups", () => {
  const col = (name: string, kind: TableColumn["kind"] = "text", over: Partial<TableColumn> = {}): TableColumn => ({ name, type: kind, kind, nullable: false, isPk: false, hasDefault: false, insertable: true, editable: true, ...over });
  const customers = [col("id", "number", { isPk: true }), col("created", "date"), col("name"), col("notes", "text", { lob: true })];
  const access = {
    quote: (n: string) => `"${n}"`,
    qualify: (x: { schema: string; table: string }) => `"${x.schema}"."${x.table}"`,
    literals: { string: "", bool: { true: "true", false: "false" } },
  } as unknown as TableAccess;

  it("names a row by a well-known column, else the first text one, else nothing", () => {
    expect(displayColumn(customers)).toBe("name");
    expect(displayColumn([col("id", "number", { isPk: true }), col("full_name")])).toBe("full_name");
    expect(displayColumn([col("id", "number", { isPk: true }), col("qty", "number")])).toBeNull();
    // PostgreSQL flags plain text / varchar as "large": still a fine name, and a short column wins over a large one.
    expect(displayColumn([col("id", "number", { isPk: true }), col("full_name", "text", { lob: true })])).toBe("full_name");
    expect(displayColumn([col("id", "number", { isPk: true }), col("bio", "text", { lob: true }), col("city")])).toBe("city");
    expect(displayColumn([col("id", "text", { isPk: true })])).toBeNull();
  });

  it("links single-column foreign keys only", () => {
    const fks = [fk("a", "orders", ["customer_id"], "customers", ["id"]), fk("b", "orders", ["x", "y"], "pairs", ["x", "y"]), fk("c", "items", ["order_id"], "orders", ["id"])];
    const links = parentLinks(t("orders"), fks, () => customers);
    expect(links).toEqual([{ column: "customer_id", refTable: t("customers"), refColumn: "id", display: "name" }]);
  });

  it("finds the chosen parent by key, and searches by name or number", () => {
    const link = { column: "customer_id", refTable: t("customers"), refColumn: "id", display: "name" };
    expect(parentFilter(link, customers, access, { value: "7" })).toBe(`"id" = 7`);
    expect(parentFilter(link, customers, access, { search: "AN" })).toBe(`(LOWER("name") LIKE '%an%')`);
    expect(parentFilter(link, customers, access, { search: "12" })).toBe(`(LOWER("name") LIKE '%12%' OR "id" = 12)`);
    expect(parentFilter(link, customers, access, { search: "O'Hara" })).toBe(`(LOWER("name") LIKE '%o''hara%')`);
    expect(parentFilter(link, customers, access, {})).toBeUndefined();
    expect(() => parentFilter(link, customers, access, { value: "1 OR 1=1" })).toThrow(/not a number/);
  });

  it("without a naming column, searches the key", () => {
    const link = { column: "c", refTable: t("codes"), refColumn: "code", display: null };
    const codes = [col("code", "text", { isPk: true })];
    expect(parentFilter(link, codes, access, { search: "ab" })).toBe(`(LOWER("code") LIKE '%ab%')`);
    const numeric = { ...link, refColumn: "id" };
    expect(parentFilter(numeric, customers, access, { search: "nope" })).toBe("1 = 0");
  });
});

describe("creating a parent from the picker", () => {
  const col = (name: string, kind: TableColumn["kind"] = "text", over: Partial<TableColumn> = {}): TableColumn => ({ name, type: kind, kind, nullable: false, isPk: false, hasDefault: false, insertable: true, editable: true, ...over });
  const access = {
    quote: (n: string) => `"${n}"`,
    qualify: (x: { schema: string; table: string }) => `"${x.schema}"."${x.table}"`,
    literals: { string: "", bool: { true: "true", false: "false" } },
  } as unknown as TableAccess;
  const columns = [col("id", "number", { isPk: true, hasDefault: true }), col("name"), col("age", "number"), col("vip", "bool"), col("bio", "text", { lob: true }), col("born", "date")];

  it("finds the new row by the exact values the user gave, leaving out blanks, large text and dates", () => {
    expect(justInsertedFilter({ name: "Ann", age: "30", vip: "true", bio: "long…", born: "2000-01-01" }, columns, access)).toBe(`"name" = 'Ann' AND "age" = 30 AND "vip" = true`);
    expect(justInsertedFilter({ name: "O'Hara", age: "" }, columns, access)).toBe(`"name" = 'O''Hara'`);
    expect(justInsertedFilter({}, columns, access)).toBeUndefined();
  });

  it("labels an option with its name and key, shortening long names and cut values", () => {
    expect(optionLabel("Ann Lee", "1")).toBe("Ann Lee (#1)");
    expect(optionLabel(null, "7")).toBe("7");
    expect(optionLabel("Moss Stores & Sons", "5")).toBe("Moss Stores & Sons (#5)"); // letters survive: only whitespace is squeezed
    expect(optionLabel("  two\n lines ", "2")).toBe("two lines (#2)");
    expect(optionLabel("x".repeat(100), "3")).toBe(`${"x".repeat(70)}… (#3)`);
    expect(optionLabel({ cut: true, preview: "huge text", size: 99999 }, "4")).toBe("huge text (#4)");
  });
});

describe("friendlyError", () => {
  const sum = (m: string) => friendlyError(m).summary;

  it("explains a missing parent on every database — including the one from the bug report", () => {
    expect(sum('The INSERT statement conflicted with the FOREIGN KEY constraint "FK__orders__customer__48CFD27E". The conflict occurred in database "erd_demo", table "sales.customers", column \'id\'.')).toBe("No row in sales.customers has id equal to that value. Pick an existing one, or create it first.");
    expect(sum('insert or update on table "orders" violates foreign key constraint "orders_customer_id_fkey"')).toMatch(/points to a row that doesn't exist/);
    expect(sum("Cannot add or update a child row: a foreign key constraint fails (`shop`.`orders`, CONSTRAINT ...)")).toMatch(/points to a row that doesn't exist/);
  });

  it("explains a row that is still in use", () => {
    expect(sum('update or delete on table "customers" violates foreign key constraint "orders_customer_id_fkey" on table "orders"')).toMatch(/rows in orders still use it/);
    expect(sum('The DELETE statement conflicted with the REFERENCE constraint "FK_x". The conflict occurred in database "d", table "dbo.orders", column \'customer_id\'.')).toMatch(/rows in dbo\.orders still use it/);
    expect(sum("Cannot delete or update a parent row: a foreign key constraint fails (...)")).toMatch(/other rows still use it/);
  });

  it("explains duplicates, required values, rules and types", () => {
    expect(sum('duplicate key value violates unique constraint "users_email_key"\nDETAIL:  Key (email)=(a@b.c) already exists.')).toBe("Another row already has email = a@b.c. It must be unique.");
    expect(sum("Violation of UNIQUE KEY constraint 'UQ_x'. Cannot insert duplicate key in object 'dbo.u'. The duplicate key value is (a@b.c).")).toMatch(/already has the value a@b\.c/);
    expect(sum("Duplicate entry 'a@b.c' for key 'users.email'")).toMatch(/already has the value a@b\.c/);
    expect(sum('null value in column "name" of relation "customers" violates not-null constraint')).toBe("name is required — give it a value.");
    expect(sum("Cannot insert the value NULL into column 'name', table 'd.dbo.c'; column does not allow nulls. INSERT fails.")).toBe("name is required — give it a value.");
    expect(sum('new row for relation "o" violates check constraint "o_qty_check"')).toMatch(/breaks a rule/);
    expect(sum('invalid input syntax for type integer: "abc"')).toMatch(/doesn't fit its column's type/);
    expect(sum("Statement 1 should have changed 1 row(s) but changed another number — someone else may have changed or deleted the data.")).toMatch(/data changed while you were editing/);
  });

  it("keeps the original text as detail, and shortens an unknown error to its first line", () => {
    const f = friendlyError("Something odd happened\nwith a long explanation");
    expect(f.summary).toBe("Something odd happened");
    expect(f.detail).toContain("long explanation");
  });
});

describe("searchFilter", () => {
  const col = (name: string, kind: TableColumn["kind"] = "text", over: Partial<TableColumn> = {}): TableColumn => ({ name, type: kind, kind, nullable: false, isPk: false, hasDefault: false, insertable: true, editable: true, ...over });
  const access = {
    quote: (n: string) => `"${n}"`,
    qualify: (x: { schema: string; table: string }) => `"${x.schema}"."${x.table}"`,
    literals: { string: "", bool: { true: "true", false: "false" } },
  } as unknown as TableAccess;
  const columns = [col("id", "number", { isPk: true }), col("name"), col("email"), col("qty", "number"), col("note", "text", { type: "ntext" })];

  it("matches words case-insensitively over the text columns, and a number against the key", () => {
    expect(searchFilter(columns, "Ann", access)).toBe(`(LOWER("name") LIKE '%ann%' OR LOWER("email") LIKE '%ann%')`);
    expect(searchFilter(columns, "42", access)).toBe(`(LOWER("name") LIKE '%42%' OR LOWER("email") LIKE '%42%' OR "id" = 42)`);
    expect(searchFilter(columns, "O'Hara", access)).toContain(`'%o''hara%'`);
  });
  it("is empty for blank input and matches nothing when there is nothing to search", () => {
    expect(searchFilter(columns, "  ", access)).toBeUndefined();
    expect(searchFilter([col("qty", "number")], "x", access)).toBe("1 = 0");
  });
});
