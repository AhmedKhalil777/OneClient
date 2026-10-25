# Fakers — fake data for SQL Server

A **faker** describes how to fill a table with realistic fake rows (like .NET's Bogus). Fakers are plain JSON files
(`*.faker.json`) in the [Fast Tools](FAST-TOOLS.md) folder you attach to a SQL Server connection, so you can keep them in a repo, review and share them.

## Using them

- **Attach a folder:** SQL Server sidebar → **FAST TOOLS** section → right-click the connection → *Attach Fast Tools Folder…*
  (the same folder holds the connection's [fast queries](FAST-TOOLS.md)). Fakers are listed under **Fakers** in it.
  Every `*.faker.json` in the folder (sub-folders too) is listed, grouped by database. Unreadable files are shown with the problem.
- **Create:** right-click → *New Faker…* (pick database and table), or right-click a table in the Object Explorer →
  *Generate Fake Data…*. New fakers are saved at the folder root as `<name>.faker.json`.
- **Edit:** click a faker. Each column gets a suggested generator (from its name and type); change any of them. Set the
  row count and an optional seed. The **JSON** tab shows the file and lets you edit it directly.
- **Nested rows:** *+ Add nested rows for each …* creates rows in tables that reference this one — e.g. 1–3 orders per
  customer and 2–4 lines per order — all from one faker.
- **Foreign keys** can point at existing rows, or *create new rows* in the referenced table with their own nested faker.
- **Run:** *Preview* (nothing written), *Generate & insert* in the editor, or right-click → *Run Faker*. Everything is
  inserted in one transaction: if anything fails, nothing is written.

## File format (version 1)

```jsonc
{
  "format": "oneclient-faker",
  "version": 1,
  "name": "Customers with orders",
  "database": "Shop",              // optional — omit to use the faker with any database
  "table": "dbo.Customers",
  "count": 50,                     // rows of the main table
  "seed": 42,                      // optional — same seed, same data
  "columns": {                     // optional — columns not listed get the automatic suggestion
    "email":        { "kind": "faker", "fakerId": "internet.email" },
    "tier":         { "kind": "pick", "value": "gold, silver, bronze" },
    "country_code": { "kind": "fk-existing" },
    "balance":      { "kind": "decimal", "min": 0, "max": 5000, "decimals": 2, "nullPercent": 10 }
  },
  "children": [
    {
      "table": "dbo.Orders", "via": "customer_id", "min": 1, "max": 3,
      "columns": { "status": { "kind": "pick", "value": "new, paid, shipped" } },
      "children": [{ "table": "dbo.OrderLines", "via": "order_id", "min": 2, "max": 4 }]
    }
  ]
}
```

Column `kind`s: `skip`, `null`, `constant` (`value`), `pick` (`value`: comma-separated), `faker` (`fakerId`, e.g.
`person.firstName`, `internet.email`, `location.city`, `commerce.productName`, `finance.amount`, `date.past`…),
`integer` / `decimal` (`min`, `max`, `decimals`), `date` (`from`, `to`), `boolean`, `guid`, `sequence` (`start`, `step`),
`text`, `fk-existing`, `fk-new` (`parentCount`, `parent`: `{ "table": …, "columns": … }`). Any column can add
`nullPercent` (0–100).

Identity, computed and rowversion columns are filled by SQL Server. Composite foreign keys and self-references can only
use existing rows. Up to 100,000 rows per run.

## Versioning

`version` is the file format. A newer app reads older files (migrating them in memory); a file from a newer app is refused
with a clear message instead of being misread.
