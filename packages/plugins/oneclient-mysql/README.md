# oneclient-mysql

MySQL and MariaDB for oneClient: object explorer (databases → tables, views, stored procedures, functions → columns,
indexes, foreign keys), query windows with IntelliSense, streamed result grids, the table data editor with staged
changes, CSV import, execution plans (`EXPLAIN FORMAT=TREE` / `EXPLAIN ANALYZE`), SSH tunnels, Fast Tools and ER diagrams.

Everything shared with the other SQL plugins comes from [`@oneclient/sql-core`](../../sql-core/README.md); this package is
the MySQL dialect: connection, query runner, metadata, scripting, highlighting and IntelliSense.
