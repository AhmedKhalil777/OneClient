# oneclient-postgres

PostgreSQL for oneClient, built on [node-postgres](https://node-postgres.com) (`pg`). Works with any PostgreSQL 12+ server, including Azure Database for PostgreSQL, AWS RDS / Aurora, Supabase, Neon and TimescaleDB.

## Connection

| Field | Notes |
|---|---|
| Host / Port | `localhost` is rewritten to `127.0.0.1` (Docker port maps usually answer on IPv4 only). |
| User / Password | The password is stored encrypted. |
| Database | Where the connection starts; the explorer lists every database on the server. |
| SSL | *Disable*, *Require (don't verify certificate)* or *Verify certificate*. Cloud servers usually need *Require*. |
| Connection string | `postgres://user:pass@host:5432/db?sslmode=require` — replaces the fields above. |
| Show system schemas and template databases | Adds `pg_catalog` / `information_schema` (under *System Schemas*) and `template0/1`. |

## Features

- **Explorer:** Databases → Schemas → Tables, Views, Materialized Views, Functions (overloads listed with their arguments and result type), Procedures and Sequences (identity / serial sequences are hidden). Tables expand to Columns (PK / FK, type, identity / generated, nullability), Indexes and Constraints.
- **Context menu:** New Query (on a connection, database or schema; a schema other than `public` starts with `SET search_path`), Select Top 1000 Rows, Count Rows, Script Table as CREATE (columns, defaults, identity, constraints, foreign keys, indexes, comment — re-runnable), Script as INSERT, Script as CREATE OR REPLACE (views, materialized views, functions, procedures, sequences), Script as SELECT / CALL with named parameters.
- **Query window** (`postgres.query`): each tab is its own session, so temp tables, `SET` and transactions persist between runs. F5 / Ctrl+Enter / Ctrl+E runs the selection or the whole script; scripts can hold many statements, each `SELECT` becoming a result set; like psql, the first error stops the rest. Esc cancels (`pg_cancel_backend`). Switching the database reconnects the tab. IntelliSense knows the database's schemas, tables, views, functions, procedures and columns, resolves unqualified names through `search_path`, and completes `alias.` / `schema.` / `table.`; it quotes `"MixedCase"` and reserved names for you. Highlighting understands `$$` bodies, `E'…'`, `"identifiers"`, `::` casts and `$1` parameters.
- **Results** (bottom panel, `postgres.results`): grids per result set (10,000 rows kept per set; values exactly as the server prints them — `int8` and `numeric` never lose precision), and Messages with `INSERT 0 2` / `UPDATE 3` counts, `RAISE NOTICE` output and psql-style errors (DETAIL, HINT, SQL state). Double-click an error to jump to its line. An aborted transaction is pointed out (run `ROLLBACK`).
- **Search:** tables, views, functions and procedures across all databases appear in the top search (Ctrl+P); a table opens *Select Top 1000*, a routine its `CREATE OR REPLACE` script.

## Development

```sh
pnpm --filter oneclient-postgres build
pnpm --filter oneclient-postgres test
docker run -d --name pg -e POSTGRES_PASSWORD=secret -p 15432:5432 postgres:17
```
