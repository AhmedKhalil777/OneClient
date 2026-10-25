import type { TokensResult } from "@oneclient/plugin-api";
import { type CFamilyConfig, tokenizeCFamily } from "./cfamily.js";
import { tokenizeCss } from "./css.js";
import { tokenizeYaml } from "./yaml.js";
import { EMPTY, MAX_HIGHLIGHT_CHARS } from "./tokens.js";

const words = (s: string): ReadonlySet<string> => new Set(s.split(/\s+/).filter(Boolean));

const JS_KEYWORDS = `break case catch class const continue debugger default delete do else enum export extends false finally for function
  if import in instanceof new null return super switch this throw true try typeof var void while with yield let static async await of
  from as get set undefined NaN Infinity`;
const TS_KEYWORDS = `${JS_KEYWORDS} abstract declare implements interface namespace module private protected public readonly override
  satisfies type keyof infer is asserts unique accessor require global`;
const TS_TYPES = "any unknown never void string number boolean bigint symbol object";

const JS: CFamilyConfig = {
  keywords: words(JS_KEYWORDS),
  types: words(""),
  typeIntroducers: words("class extends new"),
  regexLiterals: true,
  templates: true,
};

const TS: CFamilyConfig = {
  keywords: words(TS_KEYWORDS),
  types: words(TS_TYPES),
  typeIntroducers: words("class extends new implements interface enum type namespace as satisfies is"),
  regexLiterals: true,
  templates: true,
  decorators: true,
};

const CS: CFamilyConfig = {
  keywords: words(`abstract as base break case catch checked class const continue default delegate do else enum event explicit extern false
    finally fixed for foreach goto if implicit in interface internal is lock namespace new null operator out override params private protected
    public readonly ref return sealed sizeof stackalloc static struct switch this throw true try typeof unchecked unsafe using virtual volatile
    while var async await yield get set init value add remove partial where when record required file scoped global nameof with and or not
    managed unmanaged notnull dynamic select from let orderby group by into join on equals ascending descending`),
  types: words("bool byte sbyte char decimal double float int uint nint nuint long ulong short ushort object string void"),
  typeIntroducers: words("class struct interface enum record new is as typeof namespace using"),
  csharpStrings: true,
  preprocessor: true,
  attributeBrackets: true,
};

export type CodeLanguage = "typescript" | "javascript" | "css" | "csharp" | "yaml";

/** Tokens for TypeScript / TSX (`jsx` turns on `<Tag>` coloring). */
export function typescriptTokens(text: string, jsx = false): TokensResult {
  return text.length > MAX_HIGHLIGHT_CHARS ? EMPTY : tokenizeCFamily(text, jsx ? { ...TS, jsx } : TS).result();
}

/** Tokens for JavaScript / JSX / ES modules. */
export function javascriptTokens(text: string, jsx = false): TokensResult {
  return text.length > MAX_HIGHLIGHT_CHARS ? EMPTY : tokenizeCFamily(text, jsx ? { ...JS, jsx } : JS).result();
}

/** Tokens for C#. */
export function csharpTokens(text: string): TokensResult {
  return text.length > MAX_HIGHLIGHT_CHARS ? EMPTY : tokenizeCFamily(text, CS).result();
}

/** Tokens for CSS; `lineComments` accepts `//` comments (SCSS, Less). */
export function cssTokens(text: string, lineComments = false): TokensResult {
  return text.length > MAX_HIGHLIGHT_CHARS ? EMPTY : tokenizeCss(text, { lineComments }).result();
}

/** Tokens for YAML (`.yml`, `.yaml`). */
export function yamlTokens(text: string): TokensResult {
  return text.length > MAX_HIGHLIGHT_CHARS ? EMPTY : tokenizeYaml(text).result();
}
