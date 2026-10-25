import type { Faker } from "@faker-js/faker";

/**
 * @faker-js/faker is an ES module, which this CommonJS plugin can only load with import() on Node < 22.12 — so it is
 * loaded by loadFaker(), awaited before the catalog is shown or a faker runs (see api.ts).
 */
let faker: Faker;
export async function loadFaker(): Promise<void> {
  if (!faker) faker = (await import("@faker-js/faker")).faker;
}

/**
 * The Bogus-style value generators a column can use. Each entry names a function of `@faker-js/faker`; the map
 * below is the only way a configuration reaches faker (no dynamic property lookups on user input).
 */
export interface FakerEntry {
  /** Stable id stored in saved configurations, e.g. "person.firstName". */
  id: string;
  label: string;
  group: string;
  /** What it produces — used to offer only sensible generators for a column type. */
  produces: "string" | "number" | "date" | "boolean";
  make: () => unknown;
}

const e = (id: string, label: string, group: string, produces: FakerEntry["produces"], make: () => unknown): FakerEntry => ({ id, label, group, produces, make });

export const FAKERS: FakerEntry[] = [
  e("person.firstName", "First name", "Person", "string", () => faker.person.firstName()),
  e("person.lastName", "Last name", "Person", "string", () => faker.person.lastName()),
  e("person.fullName", "Full name", "Person", "string", () => faker.person.fullName()),
  e("person.prefix", "Title (Mr, Ms…)", "Person", "string", () => faker.person.prefix()),
  e("person.sex", "Sex", "Person", "string", () => faker.person.sex()),
  e("person.jobTitle", "Job title", "Person", "string", () => faker.person.jobTitle()),
  e("person.bio", "Short bio", "Person", "string", () => faker.person.bio()),
  e("date.birthdate", "Birth date", "Person", "date", () => faker.date.birthdate({ min: 18, max: 80, mode: "age" })),

  e("internet.email", "Email", "Internet", "string", () => faker.internet.email()),
  e("internet.userName", "User name", "Internet", "string", () => faker.internet.username()),
  e("internet.password", "Password", "Internet", "string", () => faker.internet.password({ length: 14 })),
  e("internet.url", "URL", "Internet", "string", () => faker.internet.url()),
  e("internet.domainName", "Domain", "Internet", "string", () => faker.internet.domainName()),
  e("internet.ipv4", "IPv4 address", "Internet", "string", () => faker.internet.ipv4()),
  e("internet.ipv6", "IPv6 address", "Internet", "string", () => faker.internet.ipv6()),
  e("internet.userAgent", "User agent", "Internet", "string", () => faker.internet.userAgent()),
  e("image.url", "Image URL", "Internet", "string", () => faker.image.url()),

  e("phone.number", "Phone number", "Phone", "string", () => faker.phone.number()),

  e("location.streetAddress", "Street address", "Address", "string", () => faker.location.streetAddress()),
  e("location.secondaryAddress", "Apartment / suite", "Address", "string", () => faker.location.secondaryAddress()),
  e("location.city", "City", "Address", "string", () => faker.location.city()),
  e("location.state", "State / region", "Address", "string", () => faker.location.state()),
  e("location.zipCode", "Postal code", "Address", "string", () => faker.location.zipCode()),
  e("location.country", "Country", "Address", "string", () => faker.location.country()),
  e("location.countryCode", "Country code (ISO-2)", "Address", "string", () => faker.location.countryCode()),
  e("location.latitude", "Latitude", "Address", "number", () => faker.location.latitude()),
  e("location.longitude", "Longitude", "Address", "number", () => faker.location.longitude()),
  e("location.timeZone", "Time zone", "Address", "string", () => faker.location.timeZone()),

  e("company.name", "Company name", "Company", "string", () => faker.company.name()),
  e("company.catchPhrase", "Catch phrase", "Company", "string", () => faker.company.catchPhrase()),
  e("commerce.department", "Department", "Company", "string", () => faker.commerce.department()),

  e("commerce.productName", "Product name", "Commerce", "string", () => faker.commerce.productName()),
  e("commerce.productDescription", "Product description", "Commerce", "string", () => faker.commerce.productDescription()),
  e("commerce.price", "Price", "Commerce", "number", () => Number(faker.commerce.price({ min: 1, max: 1000 }))),
  e("commerce.isbn", "ISBN", "Commerce", "string", () => faker.commerce.isbn()),

  e("finance.accountNumber", "Account number", "Finance", "string", () => faker.finance.accountNumber()),
  e("finance.iban", "IBAN", "Finance", "string", () => faker.finance.iban()),
  e("finance.creditCardNumber", "Credit card number", "Finance", "string", () => faker.finance.creditCardNumber()),
  e("finance.currencyCode", "Currency code", "Finance", "string", () => faker.finance.currencyCode()),
  e("finance.amount", "Amount", "Finance", "number", () => Number(faker.finance.amount({ min: 1, max: 10000, dec: 2 }))),

  e("lorem.word", "Word", "Text", "string", () => faker.lorem.word()),
  e("lorem.words", "Few words", "Text", "string", () => faker.lorem.words({ min: 2, max: 5 })),
  e("lorem.sentence", "Sentence", "Text", "string", () => faker.lorem.sentence()),
  e("lorem.paragraph", "Paragraph", "Text", "string", () => faker.lorem.paragraph()),
  e("lorem.slug", "Slug", "Text", "string", () => faker.lorem.slug()),
  e("hacker.phrase", "Tech phrase", "Text", "string", () => faker.hacker.phrase()),

  e("date.past", "Date in the past year", "Date", "date", () => faker.date.past()),
  e("date.recent", "Recent date (last days)", "Date", "date", () => faker.date.recent({ days: 30 })),
  e("date.future", "Date in the next year", "Date", "date", () => faker.date.future()),

  e("color.human", "Color name", "Other", "string", () => faker.color.human()),
  e("color.rgb", "Color hex", "Other", "string", () => faker.color.rgb()),
  e("system.fileName", "File name", "Other", "string", () => faker.system.fileName()),
  e("system.mimeType", "MIME type", "Other", "string", () => faker.system.mimeType()),
  e("vehicle.vehicle", "Vehicle", "Other", "string", () => faker.vehicle.vehicle()),
  e("animal.type", "Animal", "Other", "string", () => faker.animal.type()),
  e("string.alphanumeric", "Random code (10 chars)", "Other", "string", () => faker.string.alphanumeric(10).toUpperCase()),
];

const BY_ID = new Map(FAKERS.map((f) => [f.id, f]));
export const fakerEntry = (id: string | undefined): FakerEntry | undefined => (id ? BY_ID.get(id) : undefined);

/** For the UI: the catalog without the functions. */
export const catalog = () => FAKERS.map(({ id, label, group, produces }) => ({ id, label, group, produces }));

/** Same seed → same data (handy for repeatable test data); no seed → random. */
export function seedFaker(seed: number | undefined): void {
  if (seed === undefined || !Number.isFinite(seed)) {
    faker.seed();
    faker.setDefaultRefDate();
  } else {
    faker.seed(seed);
    // "Recent" / "past" dates are relative to a reference date — pin it (to today) so a seed really repeats.
    const today = new Date();
    faker.setDefaultRefDate(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())));
  }
}

export { faker };
