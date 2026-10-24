/** Keys a `when` clause can test — see `CommandContribution.when` and `MenuContribution.when` in plugin-api. */
export interface WhenContext {
  contextValue?: string;
  nodeType?: string;
  connectionType?: string;
  /** Menus: the view id of the active editor tab (e.g. 'postgres.query'). */
  activeView?: string;
  /** Menus: the plugin owning the active editor tab. */
  activePlugin?: string;
}

/**
 * Evaluates a `when` clause. Deliberately small: `||` / `&&` (`&&` binds tighter), parentheses, `!` and the
 * terms `key == 'v'`, `key != 'v'`, `key =~ /re/`, `key`. Anything unparseable is false, so a typo hides a menu
 * item rather than showing it everywhere.
 */
export function evaluateWhen(expr: string, ctx: WhenContext): boolean {
  try {
    return evalOr(expr.trim(), ctx);
  } catch {
    return false;
  }
}

/** Splits on a two-character operator outside parentheses and quotes/regexes. */
function splitTop(expr: string, op: "||" | "&&"): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i]!;
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === "/" && /=~\s*$/.test(expr.slice(0, i))) quote = "/";
    else if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (depth === 0 && expr.startsWith(op, i)) {
      parts.push(expr.slice(start, i));
      start = i + 2;
      i++;
    }
  }
  if (depth !== 0 || quote) throw new Error("unbalanced");
  parts.push(expr.slice(start));
  return parts.map((p) => p.trim());
}

function evalOr(expr: string, ctx: WhenContext): boolean {
  return splitTop(expr, "||").some((group) => splitTop(group, "&&").every((term) => evalTerm(term, ctx)));
}

/** True when the whole term is one parenthesised group: "(a || b)" but not "(a) || (b)". */
function wrapped(term: string): boolean {
  if (!term.startsWith("(") || !term.endsWith(")")) return false;
  let depth = 0;
  for (let i = 0; i < term.length; i++) {
    if (term[i] === "(") depth++;
    else if (term[i] === ")") depth--;
    if (depth === 0 && i < term.length - 1) return false;
  }
  return true;
}

function evalTerm(term: string, ctx: WhenContext): boolean {
  if (wrapped(term)) return evalOr(term.slice(1, -1).trim(), ctx);
  if (term.startsWith("!") && !term.startsWith("!=")) {
    const rest = term.slice(1).trim();
    if (wrapped(rest)) return !evalOr(rest.slice(1, -1).trim(), ctx);
  }
  const get = (key: string) => (ctx as Record<string, string | undefined>)[key];

  let m = /^([\w.]+)\s*(==|!=)\s*(?:'([^']*)'|"([^"]*)")$/.exec(term);
  if (m) {
    const equal = get(m[1]!) === (m[3] ?? m[4]);
    return m[2] === "==" ? equal : !equal;
  }

  m = /^([\w.]+)\s*=~\s*\/(.*)\/([a-z]*)$/.exec(term);
  if (m) {
    try {
      return new RegExp(m[2]!, m[3]).test(get(m[1]!) ?? "");
    } catch {
      return false;
    }
  }

  m = /^(!?)([\w.]+)$/.exec(term);
  if (m) return m[1] === "!" ? !get(m[2]!) : Boolean(get(m[2]!));

  return false;
}
