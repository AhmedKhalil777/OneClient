# Fast Tools — reusable developer tools for SQL connections

**FAST TOOLS** is a sidebar section of the SQL plugins (SQL Server and PostgreSQL). Each connection gets a folder you
attach once (keep it in a repo, next to the schema). Every tool keeps its files there as plain text:

```
FAST TOOLS
└ My server
  ├ C:\repo\db                  the attached folder
  ├ Fast Queries                *.query.sql   — saved scripts, run in one click          (every SQL plugin)
  │ ├ Shop                      queries for one database
  │ │ └ Orders today
  │ └ Any database              queries you run wherever you need them
  └ Fakers                      *.faker.json  — fake data generators, see FAKERS.md      (SQL Server)
```

## Fast Queries

- **Attach a folder:** right-click the connection in FAST TOOLS → *Attach Fast Tools Folder…*.
- **Save:** write a script in any query window → **★ Save as Fast Query** (Ctrl+S). Give it a name and choose
  *Only for &lt;database&gt;* (listed under that database, runs there) or *Any database*. Or right-click
  *Fast Queries* → *New Fast Query…*.
- **Open and edit:** click a fast query. Its window shows ● while it has unsaved changes; Ctrl+S saves it back to its file.
- **Run:** right-click → *Run Fast Query* runs it in its database straight away. A query for *Any database* opens
  in a window so you can pick the database first, or use *Run Fast Query on Database…* to name one.
- **Rename / Delete:** right-click the query. Files in sub-folders are listed too, so you can organise them in folders.

### File format

A fast query is a normal `.sql` file named `<name>.query.sql`. Only the `-- key: value` comment lines at the very top
are settings; everything after them is the script, exactly as written:

```sql
-- name: Blocking sessions
-- database: Shop
-- description: Who blocks whom right now
SELECT blocking_session_id, session_id, wait_type, wait_time
  FROM sys.dm_exec_requests
 WHERE blocking_session_id <> 0;
```

| Key           | Meaning                                                                          |
| ------------- | -------------------------------------------------------------------------------- |
| `name`        | Shown in the tree. Optional: the file name is used without it.                   |
| `database`    | Optional. The query is listed under, and runs in, this database.                 |
| `description` | Optional. Shown as the tooltip.                                                  |

## For plugin authors: the SQL core

Fast Tools, query windows, the Query Results panel and query history come from **`@oneclient/sql-core`**, the shared
base of the SQL plugins. A new SQL plugin brings its dialect (connection, query runner, metadata, highlighting,
IntelliSense) and gets the rest; it can turn features off or add its own Fast Tools. See
[packages/sql-core/README.md](../packages/sql-core/README.md).
