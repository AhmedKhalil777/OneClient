/** Keys a `when` clause can test — see `CommandContribution.when` in plugin-api. */
export interface WhenContext {
  contextValue?: string;
  nodeType?: string;
  connectionType?: string;
}

/**
 * Evaluates a command's `when` clause. Deliberately tiny: `||` of `&&`
 * groups of `key == 'v'`, `key != 'v'`, `key =~ /re/`, `key`, `!key`.
 * An unparseable term is false, so a typo hides a menu item rather than
 * showing it everywhere.
 */
export function evaluateWhen(expr: string, ctx: WhenContext): boolean {
  return expr.split("||").some((group) => group.split("&&").every((term) => evaluateTerm(term.trim(), ctx)));
}

function evaluateTerm(term: string, ctx: WhenContext): boolean {
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
