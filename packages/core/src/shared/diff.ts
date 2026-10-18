/**
 * Line diff (Myers' O(ND) algorithm) and the side-by-side rows the diff view draws. Pure, so it runs anywhere
 * (the diff view, tests).
 */

export type DiffOp = { kind: "same"; a: number; b: number } | { kind: "del"; a: number } | { kind: "add"; b: number };

/** Beyond this many differences the remainder is treated as one replaced block (keeps huge rewrites fast). */
const MAX_D = 4000;

/** Edit script turning `a` into `b`, line by line. */
export function diffLines(a: string[], b: string[]): DiffOp[] {
  // Common prefix / suffix first: most diffs are small edits in big files.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const ops: DiffOp[] = [];
  for (let i = 0; i < start; i++) ops.push({ kind: "same", a: i, b: i });
  ops.push(...myers(a, b, start, endA, start, endB));
  for (let i = 0; i < a.length - endA; i++) ops.push({ kind: "same", a: endA + i, b: endB + i });
  return ops;
}

function myers(a: string[], b: string[], a0: number, a1: number, b0: number, b1: number): DiffOp[] {
  const n = a1 - a0;
  const m = b1 - b0;
  if (n === 0) return Array.from({ length: m }, (_, i) => ({ kind: "add" as const, b: b0 + i }));
  if (m === 0) return Array.from({ length: n }, (_, i) => ({ kind: "del" as const, a: a0 + i }));
  const max = Math.min(n + m, MAX_D);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? v[offset + k + 1]! : v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[a0 + x] === b[b0 + y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
    if (found !== -1) break;
  }
  if (found === -1) {
    // Too different: everything is replaced.
    return [...Array.from({ length: n }, (_, i) => ({ kind: "del" as const, a: a0 + i })), ...Array.from({ length: m }, (_, i) => ({ kind: "add" as const, b: b0 + i }))];
  }
  // Walk back through the trace.
  const ops: DiffOp[] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const vd = trace[d]!;
    const k = x - y;
    const prevK = k === -d || (k !== d && vd[offset + k - 1]! < vd[offset + k + 1]!) ? k + 1 : k - 1;
    const prevX = vd[offset + prevK]!;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ kind: "same", a: a0 + --x, b: b0 + --y });
    }
    if (x === prevX) ops.push({ kind: "add", b: b0 + --y });
    else ops.push({ kind: "del", a: a0 + --x });
  }
  while (x > 0 && y > 0) ops.push({ kind: "same", a: a0 + --x, b: b0 + --y });
  return ops.reverse();
}

/** One row of the side-by-side view. Line numbers are 1-based. */
export interface DiffRow {
  kind: "same" | "add" | "del" | "mod";
  left?: { line: number; text: string };
  right?: { line: number; text: string };
}

/** Side-by-side rows: within a changed block, deleted and added lines are paired up as modifications. */
export function sideBySide(a: string[], b: string[], ops = diffLines(a, b)): DiffRow[] {
  const rows: DiffRow[] = [];
  let i = 0;
  while (i < ops.length) {
    const op = ops[i]!;
    if (op.kind === "same") {
      rows.push({ kind: "same", left: { line: op.a + 1, text: a[op.a]! }, right: { line: op.b + 1, text: b[op.b]! } });
      i++;
      continue;
    }
    const dels: number[] = [];
    const adds: number[] = [];
    while (i < ops.length && ops[i]!.kind !== "same") {
      const o = ops[i]!;
      if (o.kind === "del") dels.push(o.a);
      else if (o.kind === "add") adds.push(o.b);
      i++;
    }
    for (let j = 0; j < Math.max(dels.length, adds.length); j++) {
      const l = dels[j];
      const r = adds[j];
      rows.push({
        kind: l !== undefined && r !== undefined ? "mod" : l !== undefined ? "del" : "add",
        ...(l !== undefined ? { left: { line: l + 1, text: a[l]! } } : {}),
        ...(r !== undefined ? { right: { line: r + 1, text: b[r]! } } : {}),
      });
    }
  }
  return rows;
}

/** Splits text into lines the way the diff shows them (a final newline doesn't add an empty line). */
export function toLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Counts for a header: "+12 −3". */
export function diffStats(ops: DiffOp[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const o of ops) {
    if (o.kind === "add") added++;
    else if (o.kind === "del") removed++;
  }
  return { added, removed };
}
