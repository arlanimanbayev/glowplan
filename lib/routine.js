/**
 * Deterministic planning engine. Both agent policies (Gemini tool calls and the
 * scripted fallback) go through these functions, so every plan obeys the same
 * rules: budget and time limits, layering conflicts, pregnancy and sensitivity
 * exclusions, and a citation to a measured YouCam score on every recommendation.
 */
import { band, citeText, REGION_PHRASE } from './concerns.js';
import { GOALS, BUDGETS, TIMES, SKIN_TYPES, INGREDIENTS, INGREDIENT_BY_ID, BASE, PROFESSIONAL, EXPLAIN, GENERAL_RED_FLAGS, DISCLAIMER, FINISHES, TONE_NOTES } from './knowledge.js';
import { isDeeper, qualityIssues, toneCiteText } from './tone.js';
import { compareScans } from '../public/shared/progress.js';

const str = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim().slice(0, max) : '');

/** Validate the person's preferences. */
export function normalizePrefs(body = {}) {
  const goals = (Array.isArray(body.goals) ? body.goals : []).filter((g) => GOALS[g]).slice(0, 3);
  return {
    goals: [...new Set(goals)],
    budget: [1, 2, 3].includes(Number(body.budget)) ? Number(body.budget) : 2,
    time: TIMES[body.time] ? body.time : 'standard',
    skinType: SKIN_TYPES[body.skinType] ? body.skinType : 'unsure',
    sensitive: body.sensitive === true,
    pregnant: body.pregnant === true,
  };
}

const byKey = (scan) => new Map(scan.concerns.map((c) => [c.key, c]));
const need = (c) => (c ? (100 - c.score) / 100 : 0);
const cite = (c) => ({ key: c.key, noun: c.noun, score: c.score });
export const becauseText = (cites) => `because ${cites.map((c) => citeText(c)).join(' and ')}`;
/** Citation of the measured skin colour (YouCam Skin Tone Analysis). */
const toneCite = (tone) => ({ hex: tone.skinHex, ita: tone.ita, depth: tone.depth });
const withTone = (tone) => (tone ? { toneCite: toneCite(tone), toneBecause: `because ${toneCiteText(tone)}` } : {});

/**
 * How much a home routine can change each concern. Structural eye-area concerns
 * rank lower so the plan spends its steps where skin care actually helps.
 */
export const ACTIONABILITY = { tear_trough: 0.6, droopy_upper_eyelid: 0.5, droopy_lower_eyelid: 0.55, eye_bag: 0.65, dark_circle: 0.8, firmness: 0.85 };
const GOAL_WEIGHT = 1.6;

/** Rank measured concerns: lower score = higher priority, goals weighted up, structural concerns down. */
export function rankConcerns(scan, prefs) {
  const goalMap = new Map();
  for (const g of prefs.goals) for (const k of GOALS[g].concerns) goalMap.set(k, [...(goalMap.get(k) || []), GOALS[g].label]);
  return scan.concerns
    .map((c) => {
      const goals = goalMap.get(c.key) || [];
      const lowest = c.regions?.length ? c.regions.reduce((a, b) => (b.score < a.score ? b : a)) : null;
      return {
        key: c.key,
        label: c.label,
        noun: c.noun,
        score: c.score,
        band: band(c.score).label,
        goals,
        priority: Math.round((100 - c.score) * (goals.length ? GOAL_WEIGHT : 1) * (ACTIONABILITY[c.key] ?? 1) * 10) / 10,
        lowestRegion: lowest && lowest.score < c.score ? { region: lowest.region, label: lowest.label, score: lowest.score } : null,
      };
    })
    .sort((a, b) => b.priority - a.priority || a.score - b.score);
}

/** The scripted policy's focus: the top three ranked concerns that aren't already excellent. */
export function pickFocus(ranked, n = 3) {
  const open = ranked.filter((r) => r.score < 85);
  return (open.length ? open : ranked).slice(0, n).map((r) => r.key);
}

function excludedReason(ing, prefs) {
  if (ing.cost > BUDGETS[prefs.budget].maxCost) return 'above your budget';
  if (prefs.pregnant && ing.pregnancy === 'avoid') return 'left out while pregnant or breastfeeding';
  if (prefs.sensitive && ing.irritation >= 2) return 'often irritating for sensitive skin';
  return null;
}

/** Candidate ingredient classes for the given concerns, filtered by the person's constraints. */
export function candidatesFor(concernKeys, prefs, scan) {
  const scores = byKey(scan);
  const keys = concernKeys.filter((k) => scores.has(k));
  const out = {};
  for (const k of keys) {
    out[k] = INGREDIENTS.filter((i) => i.fit[k] >= 0.3)
      .map((i) => ({ i, why: excludedReason(i, prefs) }))
      .sort((a, b) => b.i.fit[k] - a.i.fit[k])
      .map(({ i, why }) => ({
        id: i.id,
        name: i.name,
        fit: i.fit[k],
        also_helps: Object.keys(i.fit).filter((x) => x !== k && keys.includes(x)),
        time: i.time,
        irritation: ['low', 'some', 'often at first'][i.irritation],
        relative_cost: ['', 'low', 'mid', 'higher'][i.cost],
        ...(i.strong ? { exfoliant_or_retinoid: true } : {}),
        ...(why ? { excluded: why } : {}),
      }));
  }
  return out;
}

/**
 * Would these treatment products fit the time budget without dropping any?
 * Each routine keeps two base slots (cleanse + moisturise/protect, merged in the
 * morning when needed); evening exfoliants/retinoids alternate and share one slot.
 */
export function fitsTime(list, prefs) {
  const lim = TIMES[prefs.time];
  let am = lim.am - 2;
  let pm = lim.pm - 2;
  if (list.some((i) => i.strong && i.time === 'pm')) pm -= 1;
  let either = 0;
  for (const i of list) {
    if (i.slot === 'cleanse' || (i.strong && i.time === 'pm')) continue;
    if (i.time === 'am') am -= 1;
    else if (i.time === 'pm') pm -= 1;
    else either += 1;
  }
  return am >= 0 && pm >= 0 && either <= am + pm;
}

const TONE_BIAS = { azelaic_acid: 0.12, niacinamide: 0.06, tranexamic_acid: 0.05, aha: -0.08, benzoyl_peroxide: -0.05 };

/** Greedy choice of treatment products that cover the most remaining need. */
export function chooseActives(focusKeys, prefs, scan) {
  const scores = byKey(scan);
  const remaining = new Map(focusKeys.map((k) => [k, need(scores.get(k))]));
  const eyeFocus = focusKeys.some((k) => ['dark_circle', 'eye_bag', 'tear_trough', 'droopy_lower_eyelid', 'droopy_upper_eyelid'].includes(k));
  const pool = INGREDIENTS.filter((i) => !excludedReason(i, prefs) && (i.slot !== 'eye' || eyeFocus));
  // Medium-to-deep skin with breakouts, spots or redness in focus: favour options that
  // also fade marks, and go easier on strong exfoliants (dark marks after irritation).
  const pigmentCare = isDeeper(scan.tone) && focusKeys.some((k) => ['acne', 'age_spot', 'redness'].includes(k));
  const chosen = [];
  for (let n = 0; n < BUDGETS[prefs.budget].maxActives; n += 1) {
    let best = null;
    let bestValue = 0.04;
    for (const ing of pool) {
      if (chosen.includes(ing) || !fitsTime([...chosen, ing], prefs)) continue;
      let value = 0;
      for (const [k, r] of remaining) value += (ing.fit[k] || 0) * r;
      value -= ing.irritation * (prefs.sensitive ? 0.12 : 0.03);
      if (ing.strong && chosen.some((c) => c.strong)) value -= 0.06;
      if ((ing.slot === 'cleanse' || ing.slot === 'eye') && chosen.some((c) => c.slot === ing.slot)) value = 0;
      if (pigmentCare) value += TONE_BIAS[ing.id] || 0;
      if (value > bestValue) {
        best = ing;
        bestValue = value;
      }
    }
    if (!best) break;
    chosen.push(best);
    for (const [k, r] of remaining) remaining.set(k, r * (1 - (best.fit[k] || 0) * 0.7));
  }
  return chosen.map((c) => c.id);
}

/** Pick the citation(s) for a step: concerns it addresses, focus first, then lowest score. */
function citesFor(fitKeys, scan, focusKeys, max = 2) {
  const scores = byKey(scan);
  const present = fitKeys.filter((k) => scores.has(k));
  present.sort((a, b) => {
    const fa = focusKeys.includes(a) ? 0 : 1;
    const fb = focusKeys.includes(b) ? 0 : 1;
    return fa - fb || scores.get(a).score - scores.get(b).score;
  });
  return present.slice(0, max).map((k) => cite(scores.get(k)));
}

function baseStep(def, scan, focusKeys, extra = {}) {
  // Cite the first listed concern that shows room to improve (< 75), else the lowest listed one.
  const scores = byKey(scan);
  const listed = def.cites.filter((k) => scores.has(k)).map((k) => scores.get(k));
  const pick = listed.find((c) => c.score < 75) || listed.sort((a, b) => a.score - b.score)[0];
  const cites = pick ? [cite(pick)] : [];
  if (!cites.length) {
    // Fall back to the lowest score in the scan so the step is always grounded.
    const lowest = scan.concerns.reduce((a, b) => (b.score < a.score ? b : a));
    cites.push(cite(lowest));
  }
  return { id: def.id, slot: def.slot, kind: 'base', name: def.name, does: def.does, cadence: extra.cadence || 'Daily', cites, because: becauseText(cites), ...extra };
}

function activeStep(ing, scan, focusKeys, prefs, extra = {}) {
  const fitKeys = Object.entries(ing.fit).filter(([, v]) => v >= 0.5).sort((a, b) => b[1] - a[1]).map(([k]) => k);
  const cites = citesFor(fitKeys.length ? fitKeys : Object.keys(ing.fit), scan, focusKeys, 2);
  const cautions = [];
  if (ing.caution) cautions.push(ing.caution);
  if (prefs.pregnant && ing.pregnancy === 'ask') cautions.push('Check with your doctor or midwife before using this while pregnant or breastfeeding.');
  if (prefs.sensitive) cautions.push('Patch test on your jaw for 3 days first.');
  return {
    id: ing.id,
    slot: ing.slot,
    kind: 'active',
    name: ing.name,
    className: ing.className,
    does: ing.does,
    cadence: ing.cadence,
    ...(ing.start ? { start: ing.start } : {}),
    ...(cautions.length ? { caution: cautions.join(' ') } : {}),
    cites,
    because: becauseText(cites),
    ...extra,
  };
}

/** Finish from measured oil balance / hydration and the stated skin type, with the score that drove it. */
function finishFor(scan, prefs) {
  const scores = byKey(scan);
  const oil = scores.get('oiliness');
  const moist = scores.get('moisture');
  if (oil && (prefs.skinType === 'oily' || prefs.skinType === 'combination' || oil.score < 55) && prefs.skinType !== 'dry') return { id: 'matte', label: FINISHES.matte, cite: cite(oil) };
  if (moist && (prefs.skinType === 'dry' || moist.score < 55)) return { id: 'cream', label: FINISHES.cream, cite: cite(moist) };
  return { id: 'lotion', label: FINISHES.lotion, cite: null };
}

/**
 * The morning sunscreen, personalised by measured scores and (when measured) skin
 * tone: tinted iron-oxide mineral for medium-to-deep skin or when spots/marks are a
 * concern, mineral for reactive skin, otherwise any broad-spectrum SPF 30+.
 */
function sunscreenStep(scan, prefs, focusKeys, { combined = false } = {}) {
  const scores = byKey(scan);
  const tone = scan.tone || null;
  const spots = scores.get('age_spot')?.score ?? 100;
  const acne = scores.get('acne')?.score ?? 100;
  const red = scores.get('redness')?.score ?? 70;
  const tinted = Boolean(tone) && (isDeeper(tone) || spots < 70 || (tone.depth === 'intermediate' && acne < 60));
  const def = tinted
    ? (combined ? BASE.moisturising_spf_tinted : BASE.sunscreen_tinted)
    : combined ? BASE.moisturising_spf : prefs.sensitive || red < 50 ? BASE.sunscreen_mineral : BASE.sunscreen;
  const step = baseStep(def, scan, focusKeys, { cadence: 'Every morning, rain or shine', caution: combined ? 'Use two finger-lengths for face and neck.' : 'Use two finger-lengths for face and neck. Reapply when outdoors for long.' });
  const finish = finishFor(scan, prefs);
  step.finish = finish.label;
  if (finish.cite && !step.cites.some((c) => c.key === finish.cite.key)) {
    step.cites.push(finish.cite);
    step.because = becauseText(step.cites);
  }
  if (tone && (tinted || def === BASE.sunscreen_mineral)) {
    step.shade = `${tone.tint.charAt(0).toUpperCase()}${tone.tint.slice(1)} tint`;
    Object.assign(step, withTone(tone));
  }
  return step;
}

const SLOT_ORDER = { cleanse: 0, treat: 1, eye: 2, moisturise: 3, protect: 4 };
const NIGHTS = [['Mon', 'Wed', 'Fri'], ['Tue', 'Thu', 'Sat'], ['Sun']];

/**
 * Build the full morning and evening routine from chosen active ids.
 * Returns { am, pm, actives, issues } where issues explain anything dropped or moved.
 */
export function buildRoutine(activeIds, scan, prefs, focusKeys) {
  const issues = [];
  const scores = byKey(scan);
  const budget = BUDGETS[prefs.budget];
  const limits = TIMES[prefs.time];

  let actives = [];
  for (const id of [...new Set(activeIds || [])]) {
    const ing = INGREDIENT_BY_ID[id];
    if (!ing) {
      issues.push(`Unknown ingredient id "${String(id).slice(0, 40)}" was ignored.`);
      continue;
    }
    const why = excludedReason(ing, prefs);
    if (why) {
      issues.push(`${ing.className} was left out: ${why}.`);
      continue;
    }
    if (ing.slot === 'cleanse' && actives.some((a) => a.slot === 'cleanse')) {
      issues.push(`${ing.className} was left out: only one treatment cleanser fits.`);
      continue;
    }
    actives.push(ing);
  }
  if (actives.length > budget.maxActives) {
    const dropped = actives.slice(budget.maxActives);
    issues.push(`Your ${budget.label} budget allows ${budget.maxActives} treatment product${budget.maxActives > 1 ? 's' : ''}; dropped ${dropped.map((d) => d.className).join(', ')}.`);
    actives = actives.slice(0, budget.maxActives);
  }

  // Place actives into morning and evening.
  const am = [];
  const pm = [];
  const strong = actives.filter((a) => a.strong);
  for (const a of actives.filter((x) => x.time === 'am')) am.push(a);
  for (const a of actives.filter((x) => x.time === 'pm')) pm.push(a);
  for (const a of actives.filter((x) => x.time === 'either')) {
    const amTreat = am.filter((x) => x.slot !== 'cleanse').length;
    const pmTreat = pm.filter((x) => x.slot !== 'cleanse' && !x.strong).length + (strong.length ? 1 : 0);
    (amTreat <= pmTreat ? am : pm).push(a);
  }

  // Base products, chosen from measured oil/hydration and the stated skin type.
  const oil = scores.get('oiliness')?.score ?? 60;
  const moist = scores.get('moisture')?.score ?? 60;
  const red = scores.get('redness')?.score ?? 70;
  const oilyLeaning = prefs.skinType === 'oily' || prefs.skinType === 'combination' || (prefs.skinType !== 'dry' && oil < moist && oil < 60);
  const cleanser = prefs.skinType === 'dry' || (!oilyLeaning && moist < 60) ? BASE.cleanser_cream : BASE.cleanser_gel;
  const moisturiser = prefs.skinType === 'dry' || moist < 55 || (red < 50 && !oilyLeaning) ? BASE.moisturiser_barrier : oilyLeaning ? BASE.moisturiser_light : BASE.moisturiser_barrier;

  const amWash = am.find((a) => a.slot === 'cleanse');
  let amSteps = [
    amWash ? activeStep(amWash, scan, focusKeys, prefs) : baseStep(cleanser, scan, focusKeys, { cadence: 'Every morning' }),
    ...am.filter((a) => a.slot === 'treat').map((a) => activeStep(a, scan, focusKeys, prefs)),
    ...am.filter((a) => a.slot === 'eye').map((a) => activeStep(a, scan, focusKeys, prefs)),
    baseStep(moisturiser, scan, focusKeys, { cadence: 'Every morning' }),
    sunscreenStep(scan, prefs, focusKeys),
  ];

  const pmStrong = pm.filter((a) => a.strong);
  const pmTreats = pm.filter((a) => a.slot === 'treat');
  let pmSteps = [
    baseStep(cleanser, scan, focusKeys, { cadence: 'Every evening' }),
    ...pmTreats.map((a) => {
      const idx = pmStrong.indexOf(a);
      if (pmStrong.length > 1 && idx >= 0) {
        const nights = NIGHTS[Math.min(idx, NIGHTS.length - 1)];
        return activeStep(a, scan, focusKeys, prefs, { cadence: `${nights.join(', ')} evenings`, alternates: true });
      }
      return activeStep(a, scan, focusKeys, prefs);
    }),
    ...pm.filter((a) => a.slot === 'eye').map((a) => activeStep(a, scan, focusKeys, prefs)),
    baseStep(moisturiser, scan, focusKeys, { cadence: 'Every evening' }),
  ];
  if (pmStrong.length > 1) issues.push(`${pmStrong.map((a) => a.className).join(' and ')} alternate evenings so they are never layered together.`);

  // Fit the time budget. Alternating actives share one evening slot.
  const pmCount = () => pmSteps.length - Math.max(0, pmSteps.filter((s) => s.alternates).length - 1);
  if (amSteps.length > limits.am) {
    const m = amSteps.findIndex((s) => s.slot === 'moisturise');
    const p = amSteps.findIndex((s) => s.slot === 'protect');
    if (m >= 0 && p >= 0) {
      amSteps.splice(m, 1);
      amSteps[amSteps.findIndex((s) => s.slot === 'protect')] = sunscreenStep(scan, prefs, focusKeys, { combined: true });
      issues.push('Moisturiser and sunscreen are one step in the morning to fit your time.');
    }
  }
  const tryMove = (from, to, toLimit, toCount, label) => {
    const idx = from.findIndex((s) => s.kind === 'active' && s.slot === 'treat' && INGREDIENT_BY_ID[s.id]?.time === 'either');
    if (idx >= 0 && toCount() < toLimit) {
      const [step] = from.splice(idx, 1);
      to.splice(to.findIndex((s) => s.slot === 'moisturise' || s.slot === 'protect'), 0, step);
      issues.push(`${step.className} moved to the ${label} to fit your time.`);
      return true;
    }
    return false;
  };
  while (amSteps.length > limits.am) {
    if (tryMove(amSteps, pmSteps, limits.pm, pmCount, 'evening')) continue;
    const eye = amSteps.findIndex((s) => s.slot === 'eye');
    const victim = eye >= 0 ? eye : amSteps.map((s, i) => (s.kind === 'active' && s.slot === 'treat' ? i : -1)).filter((i) => i >= 0).pop();
    if (victim === undefined || victim < 0) break;
    issues.push(`${amSteps[victim].className} was dropped to keep your morning short.`);
    amSteps.splice(victim, 1);
  }
  while (pmCount() > limits.pm) {
    if (tryMove(pmSteps, amSteps, limits.am, () => amSteps.length, 'morning')) continue;
    const eye = pmSteps.findIndex((s) => s.slot === 'eye');
    const victim = eye >= 0 ? eye : pmSteps.map((s, i) => (s.kind === 'active' && s.slot === 'treat' ? i : -1)).filter((i) => i >= 0).pop();
    if (victim === undefined || victim < 0) break;
    issues.push(`${pmSteps[victim].className} was dropped to keep your evening short.`);
    pmSteps.splice(victim, 1);
  }

  amSteps = amSteps.sort((a, b) => SLOT_ORDER[a.slot] - SLOT_ORDER[b.slot]);
  pmSteps = pmSteps.sort((a, b) => SLOT_ORDER[a.slot] - SLOT_ORDER[b.slot]);
  const kept = new Set([...amSteps, ...pmSteps].filter((s) => s.kind === 'active').map((s) => s.id));
  return { am: amSteps, pm: pmSteps, actives: actives.filter((a) => kept.has(a.id)).map((a) => a.id), issues };
}

/** Introduce one new product at a time. */
export function rampUp(routine) {
  const actives = [...routine.am, ...routine.pm].filter((s) => s.kind === 'active');
  const order = actives.map((s) => ({ s, irr: INGREDIENT_BY_ID[s.id]?.irritation ?? 0 })).sort((a, b) => a.irr - b.irr).map((x) => x.s);
  const steps = [];
  if (!order.length) {
    steps.push({ when: 'Weeks 1–4', text: 'Use the routine every day. Consistency matters more than extra products.' });
  } else {
    steps.push({ when: 'Weeks 1–2', text: `Cleanser, moisturiser and sunscreen, plus ${order[0].className}${order[0].start ? `. ${order[0].start}` : ', every other day at first.'}` });
    if (order[1]) steps.push({ when: 'Weeks 3–4', text: `Add ${order[1].className}${order[1].start ? `. ${order[1].start}` : '.'}` });
    if (order[2]) steps.push({ when: 'Weeks 5–6', text: `Add ${order[2].className}${order[2].start ? `. ${order[2].start}` : '.'}` });
  }
  steps.push({ when: order.length > 2 ? 'Week 7 onward' : order.length > 1 ? 'Week 5 onward' : 'Week 3 onward', text: 'Full routine as planned. If something stings for more than a few minutes, go back a step for a week.' });
  steps.push({ when: 'Week 8', text: 'Scan again in the same place and light, then compare in GlowPlan.' });
  return steps;
}

/** Concerns below their consultation threshold, with region-aware treatment categories. */
export function professionalGuidance(scan, prefs) {
  const items = scan.concerns
    .filter((c) => PROFESSIONAL[c.key] && c.score < PROFESSIONAL[c.key].threshold)
    .sort((a, b) => a.score - b.score)
    .slice(0, 4)
    .map((c) => {
      const def = PROFESSIONAL[c.key];
      const categories = [...def.categories];
      const regionNotes = [];
      if (def.byRegion && c.regions?.length) {
        for (const r of [...c.regions].sort((a, b) => a.score - b.score)) {
          const cat = def.byRegion[r.region];
          if (cat && r.score < 60) {
            regionNotes.push({ ...cite({ ...c, score: r.score, noun: `${r.label.toLowerCase()} ${c.noun}` }), region: r.region });
            if (!categories.some((x) => x.name === cat.name)) categories.unshift(cat);
          }
        }
      }
      const cites = [cite(c)];
      const procedural = categories.some((x) => /laser|IPL|peel|light-based|resurfacing/i.test(`${x.name} ${x.what}`));
      return {
        key: c.key,
        label: c.label,
        score: c.score,
        threshold: def.threshold,
        categories,
        ...(procedural && isDeeper(scan.tone) ? { toneNote: TONE_NOTES.procedures, ...withTone(scan.tone) } : {}),
        cites,
        because: becauseText(cites),
        ...(regionNotes.length ? { regionCites: regionNotes.map((r) => ({ ...r, because: `your ${r.noun} score is ${r.score}/100` })) } : {}),
        ...(def.redFlag ? { redFlag: def.redFlag } : {}),
      };
    });
  return {
    summary: items.length
      ? `${items.length === 1 ? 'One area sits' : `${items.length} areas sit`} low enough that a professional opinion could add to home care.`
      : 'Nothing in this scan points to a clinic visit right now.',
    when: 'Consider a consultation if a focus area has not improved after 8 to 12 weeks of consistent care, or sooner for anything under “See someone promptly”.',
    items,
    redFlags: [...GENERAL_RED_FLAGS, ...items.filter((i) => i.redFlag).map((i) => i.redFlag)],
    questions: [
      'Which of these options suit my skin type, budget and schedule?',
      'How many sessions are usual, and what downtime should I plan for?',
      'Should anything on this summary be checked medically first?',
      ...(prefs.pregnant ? ['Which treatments should wait until after pregnancy or breastfeeding?'] : []),
    ],
  };
}

/**
 * "Your skin profile": stated skin type + measured oil/hydration (Skin Analysis)
 * + measured skin colour and photo quality (Skin Tone Analysis). Every note cites
 * a measured score or the measured colour.
 */
export function skinProfile(scan, prefs) {
  const scores = byKey(scan);
  const tone = scan.tone || null;
  const oil = scores.get('oiliness');
  const moist = scores.get('moisture');
  const finish = finishFor(scan, prefs);
  const notes = [];
  const add = (id, text, cites = [], useTone = false) => {
    const n = { id, text, cites, ...(cites.length ? { because: becauseText(cites) } : {}), ...(useTone ? withTone(tone) : {}) };
    notes.push(n);
  };
  if (tone) {
    const shade = `${tone.tint} tint`;
    add('spf', `Sunscreen: look for a ${shade} if you use a tinted or mineral formula, with a ${finish.label.toLowerCase()}.`, finish.cite ? [finish.cite] : [], true);
    const pigment = ['acne', 'age_spot'].map((k) => scores.get(k)).filter((c) => c && c.score < 70).sort((a, b) => a.score - b.score);
    if (isDeeper(tone) && pigment.length) add('pih', TONE_NOTES.pih, [cite(pigment[0])], true);
    const red = scores.get('redness');
    if (isDeeper(tone) && red && red.score < 70) add('redness', TONE_NOTES.redness, [cite(red)], true);
    if (['very_light', 'light'].includes(tone.depth)) add('burn', TONE_NOTES.burn, [], true);
  } else {
    add('spf', `Sunscreen: a ${finish.label.toLowerCase()} suits you.`, finish.cite ? [finish.cite] : []);
  }
  const issues = qualityIssues(tone);
  return {
    skinType: SKIN_TYPES[prefs.skinType],
    oil: oil ? cite(oil) : null,
    moisture: moist ? cite(moist) : null,
    tone: tone ? { skinHex: tone.skinHex, ita: tone.ita, depth: tone.depth, depthLabel: tone.depthLabel, tint: tone.tint, lab: tone.lab, ...(tone.measuredAt ? { measuredAt: tone.measuredAt } : {}), ...(tone.reused ? { reused: true } : {}) } : null,
    toneStatus: tone ? (tone.reused ? 'reused' : 'measured') : 'not_measured',
    ...(scan.toneError ? { toneError: scan.toneError } : {}),
    quality: tone?.quality ? { checked: true, issues } : { checked: false, issues: [] },
    notes: notes.filter((n) => n.cites.length || n.toneCite),
  };
}

// ---------------------------------------------------------------------------
// Text safety and grounding
// ---------------------------------------------------------------------------

const BANNED = /\b(cure[sd]?|guarantee[sd]?|diagnos(?:e|es|is|ed)|prescribe[sd]?|disease)\b/i;

/** Accept model text only if every "N/100" in it matches one of the allowed scores. */
export function safeText(text, allowedScores, max = 280) {
  const t = str(text, max);
  if (!t || BANNED.test(t)) return '';
  for (const m of t.matchAll(/(\d{1,3})\s*\/\s*100/g)) if (!allowedScores.includes(Number(m[1]))) return '';
  return t;
}

export function focusItems(focusKeys, scan, prefs, notes = {}) {
  const ranked = rankConcerns(scan, prefs);
  const scores = byKey(scan);
  return focusKeys.filter((k) => scores.has(k)).slice(0, 3).map((k) => {
    const c = scores.get(k);
    const r = ranked.find((x) => x.key === k);
    const ex = EXPLAIN[k];
    const regionNote = r.lowestRegion && ex.region ? `${ex.region(REGION_PHRASE[r.lowestRegion.region] || `on your ${r.lowestRegion.label.toLowerCase()}`)} (${r.lowestRegion.score}/100).` : null;
    const allowed = [c.score, ...(c.regions || []).map((x) => x.score)];
    const cites = [cite(c)];
    return {
      key: k,
      label: c.label,
      score: c.score,
      band: band(c.score).label,
      goals: r.goals,
      measures: ex.what,
      explanation: safeText(notes[k], allowed, 320) || ex.focus,
      ...(regionNote ? { regionNote } : {}),
      cites,
      because: becauseText(cites),
    };
  });
}

/**
 * Every recommendation must cite a real measured score.
 * Returns a list of problems (empty when the plan is fully grounded).
 */
export function checkGrounding(plan, scan) {
  const scores = byKey(scan);
  const problems = [];
  const checkCites = (where, item) => {
    if (!Array.isArray(item.cites) || !item.cites.length) {
      problems.push(`${where}: no citation`);
      return;
    }
    for (const c of item.cites) {
      const real = scores.get(c.key);
      if (!real) problems.push(`${where}: cites unmeasured concern ${c.key}`);
      else if (real.score !== c.score) problems.push(`${where}: cites ${c.key} ${c.score} but scan says ${real.score}`);
      else if (!item.because?.includes(`${c.score}/100`)) problems.push(`${where}: citation text missing ${c.score}/100`);
    }
    const allowed = [...item.cites.map((c) => c.score), ...(scores.get(item.cites[0].key)?.regions || []).map((r) => r.score)];
    for (const field of ['explanation', 'note', 'because', 'regionNote']) {
      for (const m of String(item[field] || '').matchAll(/(\d{1,3})\s*\/\s*100/g)) {
        if (!allowed.includes(Number(m[1]))) problems.push(`${where}: ${field} mentions ${m[1]}/100, which is not a cited score`);
      }
    }
  };
  const checkTone = (where, item) => {
    if (!item.toneCite) return;
    const t = scan.tone;
    if (!t) problems.push(`${where}: cites a skin colour but none was measured`);
    else if (item.toneCite.hex !== t.skinHex || item.toneCite.ita !== t.ita) problems.push(`${where}: cites skin colour ${item.toneCite.hex} (ITA ${item.toneCite.ita}) but the scan says ${t.skinHex} (ITA ${t.ita})`);
    else if (!item.toneBecause?.includes(t.skinHex) || !item.toneBecause.includes(`${t.ita}°`)) problems.push(`${where}: tone citation text missing the measured colour`);
  };
  (plan.focus || []).forEach((f, i) => checkCites(`focus[${i}] ${f.key}`, f));
  for (const part of ['am', 'pm']) {
    (plan.routine?.[part] || []).forEach((s, i) => {
      checkCites(`routine.${part}[${i}] ${s.id}`, s);
      checkTone(`routine.${part}[${i}] ${s.id}`, s);
    });
  }
  (plan.professional?.items || []).forEach((p, i) => {
    checkCites(`professional[${i}] ${p.key}`, p);
    checkTone(`professional[${i}] ${p.key}`, p);
  });
  (plan.profile?.notes || []).forEach((n, i) => {
    if (!n.cites?.length && !n.toneCite) problems.push(`profile.notes[${i}] ${n.id}: no citation`);
    if (n.cites?.length) checkCites(`profile.notes[${i}] ${n.id}`, n);
    checkTone(`profile.notes[${i}] ${n.id}`, n);
  });
  if (!plan.focus?.length) problems.push('plan has no focus concerns');
  if (!plan.routine?.am?.length || !plan.routine?.pm?.length) problems.push('plan is missing a morning or evening routine');
  return problems;
}

/** Put the final plan together from choices made by either policy. */
export function assemblePlan({ scan, prefs, focusKeys, activeIds, focusNotes = {}, stepNotes = {}, headline, previous, priorIssues = [] }) {
  const routine = buildRoutine(activeIds, scan, prefs, focusKeys);
  routine.issues = [...new Set([...priorIssues, ...routine.issues])];
  const allowedFor = (s) => s.cites.map((c) => c.score);
  for (const s of [...routine.am, ...routine.pm]) {
    const note = safeText(stepNotes[s.id], allowedFor(s), 200);
    if (note) s.note = note;
  }
  const focus = focusItems(focusKeys, scan, prefs, focusNotes);
  const professional = professionalGuidance(scan, prefs);
  const profile = skinProfile(scan, prefs);
  const progress = previous ? compareScans(previous, scan) : null;
  const top = focus[0];
  const plan = {
    headline: safeText(headline, [], 80).replace(/\d+\s*\/\s*100/g, '') || (top ? `A calm, steady plan for ${top.label.toLowerCase()}` : 'Your skin plan'),
    profile,
    focus,
    routine: { am: routine.am, pm: routine.pm, issues: routine.issues, rampUp: rampUp(routine) },
    professional,
    ...(progress ? { progress } : {}),
    preferences: {
      goals: prefs.goals.map((g) => GOALS[g].label),
      budget: `${BUDGETS[prefs.budget].label} (${BUDGETS[prefs.budget].detail})`,
      time: TIMES[prefs.time].label,
      skinType: SKIN_TYPES[prefs.skinType],
      sensitive: prefs.sensitive,
      pregnant: prefs.pregnant,
    },
    disclaimer: DISCLAIMER,
  };
  plan.grounding = { problems: checkGrounding(plan, scan) };
  return plan;
}
