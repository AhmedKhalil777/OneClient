/**
 * Fuzzy matching for completion filtering, VS Code-style: the typed
 * characters must appear in order (case-insensitive), the first one at the
 * start of a word; contiguous runs,
 * matches at the start and at word boundaries (camelCase, `_`, `.`) score
 * higher. Returns null when it doesn't match at all.
 */
export interface FuzzyMatch {
  score: number;
  /** Indexes into the candidate of the matched characters (for highlighting). */
  positions: number[];
}

export function fuzzyMatch(pattern: string, candidate: string): FuzzyMatch | null {
  if (!pattern) return { score: 0, positions: [] };
  const p = pattern.toLowerCase();
  const c = candidate.toLowerCase();

  // Fast path: plain prefix match is always the best kind of match.
  if (c.startsWith(p)) {
    const exactCase = candidate.startsWith(pattern) ? 2 : 0;
    return { score: 1000 + exactCase - (candidate.length - pattern.length) * 0.01, positions: range(p.length) };
  }

  const positions: number[] = [];
  let score = 0;
  let ci = 0;
  let prev = -2;
  for (let pi = 0; pi < p.length; pi++) {
    const ch = p[pi]!;
    // Prefer the next occurrence that sits on a word boundary, else the next occurrence at all.
    let found = -1;
    for (let k = ci; k < c.length; k++) {
      if (c[k] !== ch) continue;
      if (found === -1) found = k;
      if (isBoundary(candidate, k)) {
        found = k;
        break;
      }
    }
    if (found === -1) return null;
    // Like VS Code: the first typed character must start a word, or "se" would match "cuStomErs".
    if (pi === 0 && !isBoundary(candidate, found)) return null;
    if (found === prev + 1) score += 8; // contiguous
    if (isBoundary(candidate, found)) score += 10;
    if (found === 0) score += 15;
    score -= Math.min(found - ci, 10) * 0.5; // gaps cost a little
    positions.push(found);
    prev = found;
    ci = found + 1;
  }
  return { score, positions };
}

function isBoundary(s: string, i: number): boolean {
  if (i === 0) return true;
  const prev = s[i - 1]!;
  const cur = s[i]!;
  if (/[_\-.\s[\]@#$]/.test(prev)) return true;
  return prev === prev.toLowerCase() && cur !== cur.toLowerCase(); // camelCase hump
}

function range(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i);
}
