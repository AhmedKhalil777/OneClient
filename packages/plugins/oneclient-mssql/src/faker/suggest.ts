import type { ColumnInfo, TableInfo } from "./schema.js";
import type { ColumnRule, TableRule } from "./rules.js";

const INTEGER = new Set(["int", "bigint", "smallint", "tinyint"]);
const DECIMAL = new Set(["decimal", "numeric", "money", "smallmoney", "float", "real"]);
const DATE = new Set(["date", "datetime", "datetime2", "smalldatetime", "datetimeoffset"]);
const TEXT = new Set(["char", "varchar", "nchar", "nvarchar", "text", "ntext"]);

/** Column-name patterns → catalog generator, checked in order (first match wins). Names are compared without _ and -. */
const BY_NAME: Array<[RegExp, string]> = [
  [/^e?mail(address)?$|email$/, "internet.email"],
  [/^(first|given)name$|^fname$|^forename$/, "person.firstName"],
  [/^(last|family|sur)name$|^lname$|^surname$/, "person.lastName"],
  [/^(full|display|contact|customer|employee|user)name$|^name$/, "person.fullName"],
  [/^(user|login|account)name$|^username$|^login$|^handle$/, "internet.userName"],
  [/password|passwd|pwd/, "internet.password"],
  [/phone|mobile|cell|fax|tel$/, "phone.number"],
  [/^(street|address|address1|addressline1|line1)$|streetaddress/, "location.streetAddress"],
  [/^(address2|addressline2|line2|suite|apartment)$/, "location.secondaryAddress"],
  [/city|town/, "location.city"],
  [/^(state|province|region|county)$/, "location.state"],
  [/zip|postal|postcode/, "location.zipCode"],
  [/countrycode|^iso2$/, "location.countryCode"],
  [/country/, "location.country"],
  [/^lat(itude)?$/, "location.latitude"],
  [/^(lng|lon|long|longitude)$/, "location.longitude"],
  [/timezone|^tz$/, "location.timeZone"],
  [/company|organi[sz]ation|employer|vendor|supplier|^org$/, "company.name"],
  [/department|^dept$/, "commerce.department"],
  [/jobtitle|^position$|^role$|^occupation$/, "person.jobTitle"],
  [/^(title|subject|headline|caption)$/, "lorem.sentence"],
  [/product(name)?$|^item(name)?$/, "commerce.productName"],
  [/description|summary|comment|notes?$|remarks|body|content|message|bio/, "lorem.paragraph"],
  [/price|cost|amount|total|balance|salary|fee|revenue/, "finance.amount"],
  [/iban/, "finance.iban"],
  [/currency/, "finance.currencyCode"],
  [/(credit)?card(number)?$/, "finance.creditCardNumber"],
  [/accountnumber|accountno/, "finance.accountNumber"],
  [/isbn/, "commerce.isbn"],
  [/^(url|website|homepage|link|uri)$|url$/, "internet.url"],
  [/avatar|image|photo|picture|thumbnail/, "image.url"],
  [/domain/, "internet.domainName"],
  [/^ip(address)?$|ipv4/, "internet.ipv4"],
  [/useragent/, "internet.userAgent"],
  [/colou?r/, "color.human"],
  [/^(gender|sex)$/, "person.sex"],
  [/^(prefix|salutation|honorific)$/, "person.prefix"],
  [/filename|^file$/, "system.fileName"],
  [/mimetype|contenttype/, "system.mimeType"],
  [/slug/, "lorem.slug"],
  [/^(code|sku|reference|ref|serial)$|code$/, "string.alphanumeric"],
  [/birth|dob|dateofbirth/, "date.birthdate"],
];

const clean = (name: string) => name.toLowerCase().replace(/[_\-\s]/g, "");

/** The longest text a column takes (nvarchar(max) → large but bounded so a "paragraph" still fits). */
export function textCapacity(c: Pick<ColumnInfo, "type" | "maxLength">): number {
  if (c.maxLength === -1 || c.type === "text" || c.type === "ntext") return 4000;
  return c.type === "nchar" || c.type === "nvarchar" ? Math.floor(c.maxLength / 2) : c.maxLength;
}

/** A sensible starting faker for a column, from its name and type — like Bogus' RuleFor, but automatic. */
export function suggestRule(c: ColumnInfo): ColumnRule {
  const base = { column: c.name };
  if (c.identity || c.computed) return { ...base, kind: "skip" };
  if (c.unsupported) return { ...base, kind: c.nullable || c.hasDefault ? "skip" : "null" };
  if (c.fk) return { ...base, kind: "fk-existing", ...(c.nullable ? { nullPercent: 0 } : {}) };
  if (c.type === "uniqueidentifier") return { ...base, kind: "guid" };
  if (c.primaryKey && INTEGER.has(c.type)) return { ...base, kind: "sequence", start: (c.maxValue ?? 0) + 1, step: 1 };

  const n = clean(c.name);
  // Dates by name ("createdAt", "modified_on", "expires") even when typed as dates.
  if (DATE.has(c.type)) {
    if (/birth|dob/.test(n)) return { ...base, kind: "faker", fakerId: "date.birthdate" };
    if (/created|inserted|registered|joined|start|opened|placed|ordered/.test(n)) return { ...base, kind: "faker", fakerId: "date.past" };
    if (/updated|modified|changed|last|seen/.test(n)) return { ...base, kind: "faker", fakerId: "date.recent" };
    if (/expire|due|end|until|scheduled|deadline/.test(n)) return { ...base, kind: "faker", fakerId: "date.future" };
    return { ...base, kind: "date", from: isoDaysAgo(365 * 2), to: isoDaysAgo(0) };
  }
  if (c.type === "bit") return { ...base, kind: "boolean" };
  if (c.type === "time") return { ...base, kind: "text" };

  if (TEXT.has(c.type)) {
    const hit = BY_NAME.find(([re]) => re.test(n));
    const cap = textCapacity(c);
    if (hit) {
      // A long generator into a short column would be cut mid-word — use text that fits instead.
      if ((hit[1] === "lorem.paragraph" || hit[1] === "commerce.productDescription") && cap < 60) return { ...base, kind: "faker", fakerId: "lorem.words" };
      return { ...base, kind: "faker", fakerId: hit[1] };
    }
    return { ...base, kind: "text" };
  }
  if (INTEGER.has(c.type)) {
    if (/age$/.test(n)) return { ...base, kind: "integer", min: 18, max: 90 };
    if (/qty|quantity|count|stock|units/.test(n)) return { ...base, kind: "integer", min: 1, max: 100 };
    if (/year/.test(n)) return { ...base, kind: "integer", min: 1990, max: new Date().getFullYear() };
    if (/rating|stars|score/.test(n)) return { ...base, kind: "integer", min: 1, max: 5 };
    const max = c.type === "tinyint" ? 255 : 1000;
    return { ...base, kind: "integer", min: 0, max };
  }
  if (DECIMAL.has(c.type)) {
    if (/lat(itude)?$/.test(n)) return { ...base, kind: "faker", fakerId: "location.latitude" };
    if (/(lng|lon|long|longitude)$/.test(n)) return { ...base, kind: "faker", fakerId: "location.longitude" };
    const decimals = c.type === "money" || c.type === "smallmoney" ? 2 : Math.min(c.scale || 2, 4);
    const intDigits = c.precision && c.scale !== undefined && c.type !== "float" && c.type !== "real" ? c.precision - c.scale : 6;
    return { ...base, kind: "decimal", min: 1, max: Math.min(10 ** Math.min(intDigits, 6) - 1, 10000), decimals };
  }
  if (c.type === "binary" || c.type === "varbinary") return { ...base, kind: c.nullable ? "null" : "text" };
  return { ...base, kind: c.nullable ? "null" : "text" };
}

export function suggestTable(info: TableInfo): TableRule {
  return { schema: info.schema, table: info.table, columns: info.columns.map(suggestRule) };
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}
