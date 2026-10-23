/**
 * One-page, clinic-ready summary for window.print() (save as PDF from the print
 * dialog). Built with DOM APIs only. No photo is included, on purpose.
 */

function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
  return node;
}

const fmtDate = (iso) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });

export function buildPrintSheet(sheet, { scan, plan, clinic, bandOf }) {
  sheet.replaceChildren();
  if (!scan || !plan) return;
  const focusKeys = plan.focus.map((f) => f.key);

  const head = h('header', { class: 'ps-head' },
    h('div', {},
      h('h1', {}, 'Skin scan summary'),
      h('div', { class: 'ps-small' }, `Prepared with GlowPlan from YouCam AI Skin Analysis (${scan.tier === 'hd' ? 'HD' : 'standard'} scan)${plan.profile?.tone ? ' and Skin Tone Analysis' : ''}`),
      scan.demo ? h('span', { class: 'ps-demo' }, 'Demo data: not a real analysis') : null),
    h('p', {},
      clinic ? h('span', {}, `For a consultation at ${clinic}`) : null,
      clinic ? h('br') : null,
      `Scanned ${fmtDate(scan.takenAt)}`,
      h('br'),
      `Printed ${fmtDate(new Date().toISOString())}`));

  const scoreRows = [...scan.concerns].sort((a, b) => a.score - b.score).map((c) =>
    h('tr', { class: focusKeys.includes(c.key) ? 'focus' : '' },
      h('td', {}, c.label, focusKeys.includes(c.key) ? ' (focus)' : ''),
      h('td', { class: 'num' }, String(c.score)),
      h('td', { class: 'band' }, bandOf(c.score)),
      h('td', { class: 'ps-small' }, c.regions?.length ? c.regions.map((r) => `${r.label} ${r.score}`).join(', ') : '')));
  const left = h('section', {},
    h('h2', {}, `Measured scores (1–100, higher is better)${Number.isFinite(scan.overall) ? `. Overall ${scan.overall}` : ''}`),
    h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Concern'), h('th', { class: 'num' }, 'Score'), h('th', {}, 'Band'), h('th', {}, 'By region'))), h('tbody', {}, scoreRows)),
    plan.progress ? h('div', {},
      h('h2', {}, 'Change since the previous scan'),
      h('p', { class: 'ps-small' }, plan.progress.summary),
      h('table', {}, h('tbody', {}, plan.progress.items.filter((i) => i.direction !== 'steady').slice(0, 6).map((i) =>
        h('tr', {}, h('td', {}, i.label), h('td', { class: 'num' }, `${i.before} → ${i.after}`), h('td', { class: 'num' }, i.delta > 0 ? `+${i.delta}` : String(i.delta))))))) : null,
    h('h2', {}, 'About me'),
    h('ul', { class: 'ps-small' },
      h('li', {}, `Goals: ${plan.preferences.goals.length ? plan.preferences.goals.join(', ') : 'none chosen'}`),
      h('li', {}, `Skin type (my own view): ${plan.preferences.skinType}`),
      plan.profile?.tone
        ? h('li', {}, `Skin colour (YouCam Skin Tone Analysis${plan.profile.tone.reused ? ', earlier scan' : ''}): ${plan.profile.tone.skinHex}, ${plan.profile.tone.depthLabel.toLowerCase()} on the ITA scale (${plan.profile.tone.ita}°)`)
        : null,
      plan.profile?.quality?.issues?.length ? h('li', {}, `Photo check: ${plan.profile.quality.issues.map((i) => `${i.label} ${i.value}`).join(', ')}`) : null,
      plan.preferences.sensitive ? h('li', {}, 'My skin reacts easily') : null,
      plan.preferences.pregnant ? h('li', {}, 'Pregnant or breastfeeding') : null,
      h('li', {}, `Budget: ${plan.preferences.budget}. Time: ${plan.preferences.time}`)));

  const routineList = (steps) => h('ol', {}, steps.map((s) => h('li', {}, `${s.name}${s.shade || s.finish ? ` (${[s.shade, s.finish].filter(Boolean).join(', ').toLowerCase()})` : ''}, ${s.cadence.toLowerCase()} `, h('span', { class: 'ps-small' }, `(${s.because}${s.toneBecause ? `; ${s.toneBecause.replace(/^because /, '')}` : ''})`))));
  const right = h('section', {},
    h('h2', {}, 'Focus areas'),
    h('ol', {}, plan.focus.map((f) => h('li', {}, h('b', {}, `${f.label} ${f.score}/100. `), f.regionNote || '', ' ', h('span', { class: 'ps-small' }, f.explanation)))),
    h('h2', {}, 'Current home routine'),
    h('div', { class: 'ps-small' }, h('b', {}, 'Morning')), routineList(plan.routine.am),
    h('div', { class: 'ps-small' }, h('b', {}, 'Evening')), routineList(plan.routine.pm),
    h('h2', {}, 'To discuss with a professional'),
    plan.professional.items.length
      ? h('ul', {}, plan.professional.items.map((p) => h('li', {}, h('b', {}, `${p.label} (${p.score}/100): `), p.categories.map((c) => c.name).join('; '), p.toneNote ? h('span', { class: 'ps-small' }, ` ${p.toneNote}`) : null)))
      : h('p', { class: 'ps-small' }, plan.professional.summary),
    h('h2', {}, 'Questions to ask'),
    h('ul', { class: 'ps-small' }, plan.professional.questions.map((q) => h('li', {}, q))),
    h('div', { class: 'ps-notes' }, 'Clinician notes'));

  sheet.append(head, h('div', { class: 'ps-grid' }, left, right), h('footer', { class: 'ps-foot' }, plan.disclaimer, ' Photo not included. Scores come from an AI photo analysis and vary with lighting.'));
}
