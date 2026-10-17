/**
 * Tiny T-SQL highlighter for the editor overlay: one regex pass, HTML out.
 * Not a parser — it only needs to colour what SSMS colours.
 */

export const KEYWORDS = new Set(
  `ADD ALL ALTER AS ASC AUTHORIZATION BACKUP BEGIN BREAK BROWSE BULK BY CASCADE CASE CHECK CHECKPOINT CLOSE CLUSTERED
  COLUMN COMMIT COMPUTE CONSTRAINT CONTAINS CONTINUE CREATE CROSS CURRENT CURSOR DATABASE DBCC DEALLOCATE DECLARE DEFAULT
  DELETE DENY DESC DISTINCT DISTRIBUTED DROP ELSE END ERRLVL ESCAPE EXCEPT EXEC EXECUTE EXIT EXTERNAL FETCH FILE FILLFACTOR
  FOR FOREIGN FREETEXT FROM FULL FUNCTION GOTO GRANT GROUP HAVING HOLDLOCK IDENTITY IDENTITY_INSERT IF INDEX INSERT INTERSECT
  INTO KEY KILL LINENO MERGE NOCHECK NONCLUSTERED OF OFF OFFSETS ON OPEN OPTION ORDER OUTPUT OVER PERCENT PIVOT PLAN PRIMARY
  PRINT PROC PROCEDURE PUBLIC RAISERROR READ RECONFIGURE REFERENCES REPLICATION RESTORE RESTRICT RETURN RETURNS REVERT REVOKE
  ROLLBACK ROWCOUNT ROWGUIDCOL RULE SAVE SCHEMA SELECT SET SETUSER SHUTDOWN STATISTICS TABLE TEXTSIZE THEN TO TOP TRAN
  TRANSACTION TRIGGER TRUNCATE TRY CATCH UNION UNIQUE UNPIVOT UPDATE USE VALUES VIEW WAITFOR WHEN WHERE WHILE WITH NOCOUNT
  OFFSET ROWS ONLY NEXT FIRST MATCHED TARGET SOURCE USING PARTITION APPLY THROW READONLY NOLOCK DELAY GO OR ALTER`.split(/\s+/),
);

/** SSMS draws these in grey, not blue. */
export const OPERATORS = new Set("AND OR NOT IN IS NULL LIKE BETWEEN EXISTS SOME ANY JOIN INNER LEFT RIGHT OUTER".split(" "));

export const TYPES = new Set(
  `BIGINT INT SMALLINT TINYINT BIT DECIMAL NUMERIC MONEY SMALLMONEY FLOAT REAL DATE TIME DATETIME DATETIME2 SMALLDATETIME
  DATETIMEOFFSET CHAR VARCHAR NCHAR NVARCHAR TEXT NTEXT BINARY VARBINARY IMAGE UNIQUEIDENTIFIER XML SQL_VARIANT
  HIERARCHYID GEOGRAPHY GEOMETRY SYSNAME MAX`.split(/\s+/),
);

export const FUNCTIONS = new Set(
  `COUNT SUM AVG MIN MAX COUNT_BIG STDEV VAR STRING_AGG GROUPING ROW_NUMBER RANK DENSE_RANK NTILE LAG LEAD FIRST_VALUE
  LAST_VALUE CAST CONVERT TRY_CAST TRY_CONVERT PARSE TRY_PARSE ISNULL COALESCE NULLIF IIF CHOOSE GETDATE GETUTCDATE
  SYSDATETIME SYSUTCDATETIME DATEADD DATEDIFF DATEDIFF_BIG DATENAME DATEPART DAY MONTH YEAR EOMONTH DATEFROMPARTS FORMAT
  LEN DATALENGTH LEFT RIGHT SUBSTRING CHARINDEX PATINDEX REPLACE REPLICATE REVERSE LOWER UPPER LTRIM RTRIM TRIM CONCAT
  CONCAT_WS STUFF STRING_SPLIT QUOTENAME SPACE STR ABS CEILING FLOOR ROUND POWER SQRT RAND SIGN NEWID NEWSEQUENTIALID
  OBJECT_ID OBJECT_NAME DB_ID DB_NAME SCHEMA_NAME SCOPE_IDENTITY IDENT_CURRENT OPENJSON JSON_VALUE JSON_QUERY ISJSON
  OBJECT_DEFINITION SERVERPROPERTY SUSER_SNAME USER_NAME ERROR_MESSAGE ERROR_NUMBER ERROR_LINE`.split(/\s+/),
);

const TOKEN =
  /(--[^\n]*)|(\/\*[\s\S]*?(?:\*\/|$))|(N?'(?:[^']|'')*'?)|(\[[^\]\n]*\]?)|(@@?[\w#$]+)|(\b0x[0-9a-fA-F]*\b|\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|([A-Za-z_#][\w#$]*)/g;

function escape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function highlightSql(text: string): string {
  let out = "";
  let last = 0;
  for (const m of text.matchAll(TOKEN)) {
    const index = m.index ?? 0;
    out += escape(text.slice(last, index));
    last = index + m[0].length;
    const tok = escape(m[0]);
    if (m[1] || m[2]) out += `<span class="t-comment">${tok}</span>`;
    else if (m[3]) out += `<span class="t-string">${tok}</span>`;
    else if (m[4]) out += tok;
    else if (m[5]) out += `<span class="t-var">${tok}</span>`;
    else if (m[6]) out += `<span class="t-number">${tok}</span>`;
    else {
      const upper = m[0].toUpperCase();
      // Look ahead for "(" so e.g. LEFT( is a function but LEFT JOIN is an operator.
      const isCall = text[last] === "(";
      if (isCall && FUNCTIONS.has(upper)) out += `<span class="t-func">${tok}</span>`;
      else if (OPERATORS.has(upper)) out += `<span class="t-op">${tok}</span>`;
      else if (KEYWORDS.has(upper)) out += `<span class="t-keyword">${tok}</span>`;
      else if (TYPES.has(upper)) out += `<span class="t-type">${tok}</span>`;
      else if (FUNCTIONS.has(upper)) out += `<span class="t-func">${tok}</span>`;
      else out += tok;
    }
  }
  out += escape(text.slice(last));
  // A trailing newline needs content after it or the overlay is one line shorter than the textarea.
  return `${out}\n `;
}
