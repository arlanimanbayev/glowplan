/**
 * Progress between two scans. Shared by the browser (progress chart) and the
 * server (plan check-in notes), so both always agree on the numbers.
 *
 * Scores are YouCam ui_scores (1-100, higher = less of that concern), so a
 * positive delta is an improvement. Small moves are treated as noise: photo
 * lighting and angle shift scores by a few points between sessions.
 */

export const STEADY_BAND = 3;

/**
 * @param {{takenAt?:string, tier?:string, overall?:number, concerns:{key:string,label:string,score:number}[]}} before
 * @param {typeof before} after
 */
export function compareScans(before, after) {
  const prev = new Map((before?.concerns || []).map((c) => [c.key, c]));
  const items = [];
  for (const c of after?.concerns || []) {
    const p = prev.get(c.key);
    if (!p) continue;
    const delta = c.score - p.score;
    items.push({
      key: c.key,
      label: c.label,
      before: p.score,
      after: c.score,
      delta,
      direction: delta >= STEADY_BAND ? 'up' : delta <= -STEADY_BAND ? 'down' : 'steady',
    });
  }
  items.sort((a, b) => b.delta - a.delta || a.after - b.after);
  const t0 = Date.parse(before?.takenAt || '');
  const t1 = Date.parse(after?.takenAt || '');
  const days = Number.isFinite(t0) && Number.isFinite(t1) ? Math.max(0, Math.round((t1 - t0) / 86400000)) : null;
  const overall = Number.isFinite(before?.overall) && Number.isFinite(after?.overall)
    ? { before: before.overall, after: after.overall, delta: after.overall - before.overall }
    : null;
  const notes = [];
  if (before?.tier && after?.tier && before.tier !== after.tier) notes.push('One scan was HD and the other standard, so compare with care.');
  if (before?.demo !== after?.demo) notes.push('One of these scans used demo data.');
  return {
    days,
    items,
    improved: items.filter((i) => i.direction === 'up').length,
    declined: items.filter((i) => i.direction === 'down').length,
    steady: items.filter((i) => i.direction === 'steady').length,
    overall,
    notes,
    summary: summarize(items, days),
  };
}

function summarize(items, days) {
  if (!items.length) return 'These scans share no concerns to compare.';
  const up = items.filter((i) => i.direction === 'up');
  const down = items.filter((i) => i.direction === 'down');
  const span = days === null ? '' : days === 0 ? ' on the same day' : ` over ${days} day${days === 1 ? '' : 's'}`;
  const best = up[0];
  const worst = down.length ? down[down.length - 1] : null;
  const parts = [];
  parts.push(`${up.length} improved, ${down.length} dropped and ${items.length - up.length - down.length} held steady${span}.`);
  if (best) parts.push(`Biggest gain: ${best.label.toLowerCase()}, ${best.before} to ${best.after}.`);
  if (worst) parts.push(`Biggest drop: ${worst.label.toLowerCase()}, ${worst.before} to ${worst.after}.`);
  return parts.join(' ');
}
