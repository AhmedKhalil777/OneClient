/**
 * Lays out a commit graph (VS Code / GitLens style): commits in topological order, each in a lane (column), with the
 * line segments to draw in its row. A row is split at the node: `top` segments run from a lane at the top of the row
 * to a lane at the node's height, `bottom` ones from the node's height to the bottom.
 */

export interface GraphCommit {
  sha: string;
  parents: string[];
}

export interface Segment {
  from: number;
  to: number;
  color: number;
}

export interface GraphRow {
  sha: string;
  lane: number;
  color: number;
  top: Segment[];
  bottom: Segment[];
  /** Lanes used up to this row (for the column's width). */
  width: number;
}

export function layoutGraph(commits: GraphCommit[]): GraphRow[] {
  const lanes: Array<{ sha: string; color: number } | null> = [];
  let nextColor = 0;
  const free = (avoid: number[] = []) => {
    const i = lanes.findIndex((l, j) => l === null && !avoid.includes(j));
    return i === -1 ? lanes.length : i;
  };
  const rows: GraphRow[] = [];

  for (const c of commits) {
    const matches = lanes.flatMap((l, j) => (l?.sha === c.sha ? [j] : []));
    let lane: number;
    let color: number;
    if (matches.length === 0) {
      lane = free();
      color = nextColor++;
    } else {
      lane = matches[0]!;
      color = lanes[lane]!.color;
    }

    // Top half: children's lines converge on this commit; every other lane passes straight through.
    const top: Segment[] = [];
    lanes.forEach((l, j) => {
      if (!l) return;
      if (l.sha === c.sha) top.push({ from: j, to: lane, color: l.color });
      else top.push({ from: j, to: j, color: l.color });
    });
    for (const j of matches) if (j !== lane) lanes[j] = null;

    // Bottom half: to the parents.
    const bottom: Segment[] = [];
    const targets: number[] = [];
    if (c.parents.length === 0) lanes[lane] = null;
    else {
      lanes[lane] = { sha: c.parents[0]!, color };
      bottom.push({ from: lane, to: lane, color });
      targets.push(lane);
      for (const p of c.parents.slice(1)) {
        let k = lanes.findIndex((l) => l?.sha === p);
        if (k === -1) {
          k = free([lane]);
          lanes[k] = { sha: p, color: nextColor++ };
        }
        bottom.push({ from: lane, to: k, color: lanes[k]!.color });
        targets.push(k);
      }
    }
    lanes.forEach((l, j) => {
      if (l && !targets.includes(j) && top.some((s) => s.to === j && s.from === j)) bottom.push({ from: j, to: j, color: l.color });
    });
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
    const width = Math.max(lane + 1, ...top.map((s) => Math.max(s.from, s.to) + 1), ...bottom.map((s) => Math.max(s.from, s.to) + 1));
    rows.push({ sha: c.sha, lane, color, top, bottom, width });
  }
  return rows;
}
