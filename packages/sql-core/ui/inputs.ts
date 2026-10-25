/**
 * Which kind of form input a column gets, and how its value moves between the database's text and the input's own
 * format (a date picker wants "2024-05-01T10:30:00", the database has "2024-05-01 10:30:00" or an ISO instant).
 * Pure, so it is unit-tested; Aggregate.tsx uses it for every field.
 */

export interface ColumnLike {
  type: string;
  kind: string;
  lob?: boolean | undefined;
}

export type InputKind =
  | { kind: "bool" }
  | { kind: "integer" }
  | { kind: "decimal" }
  | { kind: "date" }
  | { kind: "time" }
  | { kind: "datetime"; zoned: boolean }
  | { kind: "json" }
  | { kind: "multiline" }
  | { kind: "text" };

const INTEGER = /^(tiny|small|medium|big)?int(eger)?(\d+)?\b|^serial|^bigserial|^smallserial|^int[248]$/i;
const ZONED = /with time zone|timestamptz|datetimeoffset|timestamp_ltz|timetz/i;

export function inputKindOf(col: ColumnLike): InputKind {
  const type = col.type.trim().toLowerCase();
  switch (col.kind) {
    case "bool":
      return { kind: "bool" };
    case "number":
      // "bigint unsigned", "int(11)", "serial" are whole numbers; numeric / decimal / float / money are not.
      return INTEGER.test(type) && !/^(interval|point)/.test(type) ? { kind: "integer" } : { kind: "decimal" };
    case "date":
      if (/^date$/.test(type)) return { kind: "date" };
      if (/^time(\(\d+\))?( with(out)? time zone)?$|^timetz/.test(type)) return { kind: "time" };
      if (/^interval/.test(type)) return { kind: "text" };
      return { kind: "datetime", zoned: ZONED.test(type) };
    case "json":
      return { kind: "json" };
    default:
      // A one-line box, even for a "large" column: PostgreSQL calls every text / varchar large, and a box the size of a
      // paragraph for a status or a name is the wrong default. The form switches to several lines for a long or multi-line value.
      return { kind: "text" };
  }
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

/** The parts of an instant in the browser's time zone — the zone the database driver's Date objects were read in. */
function local(d: Date) {
  return { date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, time: `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` };
}

/** The database's text → what the input shows ("" when it can't be read: the raw text then stays untouched). */
export function toInputValue(kind: InputKind, text: string): string {
  if (!text) return "";
  switch (kind.kind) {
    case "date": {
      if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
      const d = new Date(text);
      return Number.isNaN(d.getTime()) ? "" : local(d).date;
    }
    case "time": {
      const m = /^(\d{2}):(\d{2})(?::(\d{2}))?/.exec(text);
      return m ? `${m[1]}:${m[2]}:${m[3] ?? "00"}` : "";
    }
    case "datetime": {
      // A naive value ("2024-05-01 10:30:00") has no zone: show it as written. An instant (ISO with Z / an offset) is shown in local time.
      const naive = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)(?:\.\d+)?$/.exec(text);
      if (naive) return `${naive[1]}T${naive[2]!.length === 5 ? `${naive[2]}:00` : naive[2]}`;
      const d = new Date(text);
      if (Number.isNaN(d.getTime())) return "";
      const p = local(d);
      return `${p.date}T${p.time}`;
    }
    default:
      return text;
  }
}

/** What the input holds → the text sent to the database. */
export function fromInputValue(kind: InputKind, value: string): string {
  if (!value) return "";
  switch (kind.kind) {
    case "time":
      return value.length === 5 ? `${value}:00` : value;
    case "datetime": {
      const withSeconds = /T\d{2}:\d{2}$/.test(value) ? `${value}:00` : value;
      if (kind.zoned) {
        const d = new Date(withSeconds);
        return Number.isNaN(d.getTime()) ? withSeconds : d.toISOString();
      }
      return withSeconds.replace("T", " ");
    }
    default:
      return value;
  }
}

/** The HTML `type` (and `step`) for a kind. */
export function htmlInput(kind: InputKind): { type: string; step?: string } {
  switch (kind.kind) {
    case "integer":
      return { type: "number", step: "1" };
    case "decimal":
      return { type: "number", step: "any" };
    case "date":
      return { type: "date" };
    case "time":
      return { type: "time", step: "1" };
    case "datetime":
      return { type: "datetime-local", step: "1" };
    default:
      return { type: "text" };
  }
}
