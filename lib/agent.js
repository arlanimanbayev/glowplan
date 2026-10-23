/**
 * GlowPlan agent: turns a YouCam skin scan plus the person's goals into a plan.
 *
 * One set of tools, two policies:
 *   - Gemini policy: an LLM tool-calling loop (lib/llm.js) picks the focus
 *     concerns and ingredient classes and writes the plain-language notes.
 *   - Scripted policy: the same tools in a fixed order. Used when GEMINI_API_KEY
 *     is missing, when Gemini fails, and to finish anything Gemini left undone.
 *
 * Tools (all deterministic, see lib/routine.js):
 *   rank_concerns         measured scores ranked against the person's goals
 *   skin_profile          stated skin type + measured oil/hydration + measured skin tone
 *   find_ingredients      ingredient classes for chosen concerns, filtered by budget,
 *                         sensitivity and pregnancy
 *   draft_routine         builds morning/evening routines, enforces time limits and
 *                         layering rules, reports what it changed
 *   professional_options  in-clinic treatment categories for concerns below threshold
 *   finalize_plan         assembles the plan; rejects it unless every recommendation
 *                         cites a real measured score
 *
 * Numbers are never taken from the model: citations are attached server-side
 * from the scan, and model text that mentions a score that doesn't match is dropped.
 */
import { createGemini, functionResponseTurn, GEMINI_DEFAULT_MODEL } from './llm.js';
import { createYouCamClient, YOUCAM_DEFAULT_BASE_URL, YOUCAM_SKIN_VERSION } from './youcam.js';
import { createMockFetch, MOCK_API_KEY, MOCK_BASE_URL } from './mock-youcam.js';
import { sanitizeScan, CONCERN_KEYS, BY_KEY } from './concerns.js';
import { GOALS, INGREDIENTS, BUDGETS, TIMES, SKIN_TYPES } from './knowledge.js';
import * as R from './routine.js';

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

export function createDemoYouCam(env = process.env) {
  return createYouCamClient({
    apiKey: MOCK_API_KEY,
    baseUrl: MOCK_BASE_URL,
    version: env.YOUCAM_SKIN_VERSION || YOUCAM_SKIN_VERSION,
    fetchImpl: createMockFetch({ taskMs: Number(env.MOCK_TASK_MS ?? 1500), latencyMs: Number(env.MOCK_LATENCY_MS ?? 40) }),
    mode: 'mock',
    minIntervalMs: 0,
  });
}

/** YouCam client (live with a key, demo otherwise), a demo client for samples, and the LLM. */
export function depsFromEnv(env = process.env) {
  const live = Boolean(env.YOUCAM_API_KEY);
  const demo = createDemoYouCam(env);
  const youcam = live
    ? createYouCamClient({
      apiKey: env.YOUCAM_API_KEY,
      baseUrl: env.YOUCAM_BASE_URL || YOUCAM_DEFAULT_BASE_URL,
      version: env.YOUCAM_SKIN_VERSION || YOUCAM_SKIN_VERSION,
      mode: 'live',
      minIntervalMs: Number(env.YOUCAM_MIN_INTERVAL_MS ?? 220),
    })
    : demo;
  const llm = env.GEMINI_API_KEY ? createGemini({ apiKey: env.GEMINI_API_KEY, model: env.GEMINI_MODEL || GEMINI_DEFAULT_MODEL }) : null;
  return { youcam, demo, llm };
}

export function modeInfo({ youcam, llm }) {
  return { youcam: youcam.mode === 'live' ? 'live' : 'demo', skinApiVersion: youcam.version, agent: llm ? 'gemini' : 'scripted', model: llm?.model || null };
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export function validatePlanInput(body) {
  if (!body || typeof body !== 'object') return { error: 'Send a JSON body with a scan and your preferences.' };
  const scan = sanitizeScan(body.scan);
  if (!scan) return { error: 'Run a skin scan first: the plan needs at least three measured scores.' };
  const prefs = R.normalizePrefs(body.preferences || body);
  const previous = body.previous ? sanitizeScan(body.previous) : null;
  return { value: { scan, prefs, previous } };
}

// ---------------------------------------------------------------------------
// Context + trace
// ---------------------------------------------------------------------------

let traceSeq = 0;
function createContext(input, emit, budgetMs) {
  return {
    ...input,
    emit: emit || (() => {}),
    deadline: Date.now() + budgetMs,
    trace: [],
    policy: 'scripted',
    ranked: null,
    candidates: {},
    draft: null,
    pro: null,
    plan: null,
    finalized: false,
    finalizeAttempts: 0,
    stats: { modelTurns: 0, toolCalls: 0 },
  };
}

function traceStart(ctx, { kind = 'tool', tool, title, by }) {
  const event = { id: `t${(traceSeq += 1)}`, kind, tool, title, detail: '', status: 'running', ms: 0, by: by || ctx.policy };
  const started = Date.now();
  ctx.trace.push(event);
  ctx.emit({ type: 'trace', event: { ...event } });
  return {
    done(detail, status = 'done') {
      event.detail = detail || '';
      event.status = status;
      event.ms = Date.now() - started;
      ctx.emit({ type: 'trace', event: { ...event } });
    },
  };
}
const remaining = (ctx) => ctx.deadline - Date.now();
const labelOf = (k) => BY_KEY[k]?.label.toLowerCase() || k;
const listOf = (xs) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

// ---------------------------------------------------------------------------
// Tools (shared by both policies)
// ---------------------------------------------------------------------------

function toolRank(ctx) {
  const step = traceStart(ctx, { tool: 'rank_concerns', title: `Ranked ${ctx.scan.concerns.length} measured concerns against your goals` });
  ctx.ranked = R.rankConcerns(ctx.scan, ctx.prefs);
  step.done(`Lowest first: ${ctx.ranked.slice(0, 3).map((r) => `${labelOf(r.key)} ${r.score}`).join(', ')}`);
  return {
    scale: 'ui_score 1-100; higher means healthier-looking skin, lower means more of that concern',
    goals: ctx.prefs.goals.map((g) => GOALS[g].label),
    ranking: ctx.ranked.map((r) => ({ concern: r.key, label: r.label, score: r.score, band: r.band, matches_goals: r.goals, priority: r.priority, ...(r.lowestRegion ? { lowest_region: `${r.lowestRegion.label} ${r.lowestRegion.score}` } : {}) })),
  };
}

function toolProfile(ctx) {
  const step = traceStart(ctx, { tool: 'skin_profile', title: 'Read your skin profile (skin type, oil, hydration and measured skin tone)' });
  const p = R.skinProfile(ctx.scan, ctx.prefs);
  ctx.profiled = true;
  const t = p.tone;
  step.done(t ? `Skin colour ${t.skinHex}, ${t.depthLabel.toLowerCase()} on the ITA scale (${t.ita}°)${t.reused ? ', from an earlier scan' : ''}` : 'Skin tone not measured; planning from skin scores only');
  return {
    skin_type_stated: p.skinType,
    oiliness_score: p.oil?.score ?? null,
    hydration_score: p.moisture?.score ?? null,
    skin_tone: t ? { measured_skin_color: t.skinHex, ita_degrees: t.ita, depth: t.depthLabel, tint_family: t.tint, note: 'Measured colour only; the API does not return an undertone, so never mention one.' } : null,
    photo_quality_issues: p.quality.issues,
    notes: p.notes.map((n) => n.text),
    guidance: t && ['tan', 'brown', 'dark'].includes(t.depth) ? 'Medium-to-deep skin: prefer gentle, tone-evening options (azelaic acid, niacinamide) and avoid harsh exfoliation when breakouts or spots are in focus.' : undefined,
  };
}

function cleanConcerns(list) {
  return [...new Set((Array.isArray(list) ? list : []).filter((k) => CONCERN_KEYS.includes(k)))].slice(0, 5);
}

function toolIngredients(ctx, args) {
  const keys = cleanConcerns(args.concerns).filter((k) => ctx.scan.concerns.some((c) => c.key === k));
  if (!keys.length) return { error: 'Pass concerns from the rank_concerns ranking, e.g. ["pore","acne"].' };
  const step = traceStart(ctx, { tool: 'find_ingredients', title: `Looked up ingredient classes for ${listOf(keys.map(labelOf))}` });
  const found = R.candidatesFor(keys, ctx.prefs, ctx.scan);
  Object.assign(ctx.candidates, found);
  const all = Object.values(found).flat();
  const usable = new Set(all.filter((c) => !c.excluded).map((c) => c.id));
  const excluded = new Set(all.filter((c) => c.excluded).map((c) => c.id));
  step.done(`${usable.size} usable${excluded.size ? `, ${excluded.size} left out for your budget or safety settings` : ''}`);
  return { budget: { ...BUDGETS[ctx.prefs.budget], note: 'maxActives = how many treatment products fit the budget' }, candidates: found };
}

function compactStep(s) {
  return { id: s.id, name: s.name, cadence: s.cadence, because: s.because };
}

function toolDraft(ctx, args) {
  const ids = (Array.isArray(args.actives) ? args.actives : []).map(String).slice(0, 6);
  const focusKeys = ctx.focusKeys || R.pickFocus(ctx.ranked || R.rankConcerns(ctx.scan, ctx.prefs));
  const step = traceStart(ctx, { tool: 'draft_routine', title: 'Drafted morning and evening routines' });
  const r = R.buildRoutine(ids, ctx.scan, ctx.prefs, focusKeys);
  ctx.draft = { ids, actives: r.actives, issues: r.issues };
  step.done(`${r.am.length} morning and ${r.pm.length} evening steps${r.issues.length ? `. ${r.issues[0]}` : ''}`);
  return {
    limits: { time: TIMES[ctx.prefs.time].label, max_morning_steps: TIMES[ctx.prefs.time].am, max_evening_steps: TIMES[ctx.prefs.time].pm, max_treatment_products: BUDGETS[ctx.prefs.budget].maxActives },
    morning: r.am.map(compactStep),
    evening: r.pm.map(compactStep),
    kept_actives: r.actives,
    issues: r.issues,
  };
}

function toolProfessional(ctx) {
  const step = traceStart(ctx, { tool: 'professional_options', title: 'Checked when a professional could help' });
  ctx.pro = R.professionalGuidance(ctx.scan, ctx.prefs);
  step.done(ctx.pro.items.length ? `Below the consultation threshold: ${listOf(ctx.pro.items.map((i) => `${i.label.toLowerCase()} ${i.score}`))}` : 'No concern is below its consultation threshold');
  return {
    summary: ctx.pro.summary,
    items: ctx.pro.items.map((i) => ({ concern: i.key, score: i.score, threshold: i.threshold, categories: i.categories.map((c) => c.name) })),
  };
}

function toolFinalize(ctx, args = {}) {
  ctx.finalizeAttempts += 1;
  const step = traceStart(ctx, { tool: 'finalize_plan', title: 'Checked that every recommendation cites a measured score' });
  const focusIn = Array.isArray(args.focus) ? args.focus : [];
  const focusKeys = cleanConcerns(focusIn.map((f) => f?.concern)).filter((k) => ctx.scan.concerns.some((c) => c.key === k)).slice(0, 3);
  const problems = [];
  if (focusKeys.length < Math.min(3, ctx.scan.concerns.length)) problems.push('Give exactly 3 focus concerns that exist in the scan.');
  const focusNotes = Object.fromEntries(focusIn.filter((f) => f && typeof f.explanation === 'string').map((f) => [f.concern, f.explanation]));
  const stepNotes = Object.fromEntries((Array.isArray(args.step_notes) ? args.step_notes : []).filter((n) => n && typeof n.note === 'string').map((n) => [n.id, n.note]));
  const activeIds = (Array.isArray(args.actives) ? args.actives : ctx.draft?.actives || []).map(String);
  if (problems.length) {
    step.done(problems.join(' '), 'error');
    return { ok: false, problems };
  }
  const sameAsDraft = ctx.draft && activeIds.length === ctx.draft.actives.length && activeIds.every((id) => ctx.draft.actives.includes(id));
  const plan = R.assemblePlan({ scan: ctx.scan, prefs: ctx.prefs, focusKeys, activeIds, focusNotes, stepNotes, headline: args.headline, previous: ctx.previous, priorIssues: sameAsDraft ? ctx.draft.issues : [] });
  const n = plan.focus.length + plan.routine.am.length + plan.routine.pm.length + plan.professional.items.length;
  if (plan.grounding.problems.length) {
    step.done(`${plan.grounding.problems.length} ungrounded item(s)`, 'error');
    return { ok: false, problems: plan.grounding.problems.slice(0, 6) };
  }
  ctx.plan = plan;
  ctx.finalized = true;
  step.done(`${n} recommendations, each tied to a score from this scan`);
  return { ok: true, recommendations: n };
}

function makeToolRunner(ctx) {
  return async (name, args = {}) => {
    ctx.stats.toolCalls += 1;
    try {
      if (name === 'rank_concerns') return toolRank(ctx);
      if (name === 'skin_profile') return toolProfile(ctx);
      if (name === 'find_ingredients') return toolIngredients(ctx, args);
      if (name === 'draft_routine') return toolDraft(ctx, args);
      if (name === 'professional_options') return toolProfessional(ctx, args);
      if (name === 'finalize_plan') return toolFinalize(ctx, args);
      return { error: `Unknown tool ${name}` };
    } catch (err) {
      return { error: err.message };
    }
  };
}

export const TOOL_DECLARATIONS = [
  {
    name: 'rank_concerns',
    description: 'Rank the measured YouCam skin concerns (ui_score 1-100, higher is healthier) against the person’s goals. Call first.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'skin_profile',
    description: 'The person’s skin profile: stated skin type, measured oil balance and hydration, and the skin colour measured by YouCam Skin Tone Analysis (with its ITA depth estimate and tint family).',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'find_ingredients',
    description: 'Ingredient classes commonly used for the given concerns, with fit (0-1), timing, irritation and relative cost. Items marked excluded must not be used.',
    parameters: {
      type: 'object',
      properties: { concerns: { type: 'array', items: { type: 'string', enum: CONCERN_KEYS }, description: 'Up to 5 concern keys, usually your 3 focus concerns.' } },
      required: ['concerns'],
    },
  },
  {
    name: 'professional_options',
    description: 'Which measured concerns are low enough that an in-clinic consultation could help, with treatment categories clinics commonly offer.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'draft_routine',
    description: 'Build the morning and evening routine from treatment ingredient ids. Adds cleanser, moisturiser and sunscreen automatically, enforces the time and budget limits and layering rules, and reports issues.',
    parameters: {
      type: 'object',
      properties: { actives: { type: 'array', items: { type: 'string', enum: INGREDIENTS.map((i) => i.id) }, description: 'Treatment ingredient ids from find_ingredients, most important first.' } },
      required: ['actives'],
    },
  },
  {
    name: 'finalize_plan',
    description: 'Submit the plan. The app attaches the exact scores; do not write score numbers yourself.',
    parameters: {
      type: 'object',
      properties: {
        headline: { type: 'string', description: 'Max 10 words, calm and specific, no numbers.' },
        focus: {
          type: 'array',
          description: 'Exactly 3 focus concerns, most important first.',
          items: {
            type: 'object',
            properties: {
              concern: { type: 'string', enum: CONCERN_KEYS },
              explanation: { type: 'string', description: '1-2 plain sentences: what this means for this person and what the plan does about it. No diagnosis, no promises.' },
            },
            required: ['concern', 'explanation'],
          },
        },
        actives: { type: 'array', items: { type: 'string', enum: INGREDIENTS.map((i) => i.id) }, description: 'The treatment ingredient ids kept by draft_routine.' },
        step_notes: {
          type: 'array',
          description: 'Optional: one short sentence per ingredient id on how it helps this person.',
          items: { type: 'object', properties: { id: { type: 'string' }, note: { type: 'string' } }, required: ['id', 'note'] },
        },
      },
      required: ['headline', 'focus', 'actives'],
    },
  },
];

const PLAN_SYSTEM = `You are GlowPlan, a skin-care planning agent. You turn a YouCam AI Skin Analysis (scores 1-100 per concern; higher means healthier-looking skin, lower means more of that concern) and the person's goals into a cosmetic routine.
Rules: you are not a doctor. Never diagnose, never name a medical condition as a fact about this person, never promise results, never name brands or products. Use only ingredient ids returned by your tools. Do not write score numbers; the app adds them.
Work in as few turns as possible:
1. In ONE turn call rank_concerns and skin_profile.
2. Choose 3 focus concerns: usually the top of the ranking, favouring the person's goals. In ONE turn call find_ingredients for them and professional_options. Take the skin profile into account (for medium-to-deep skin with breakouts or spots, prefer gentle tone-evening options).
3. Call draft_routine with the best treatment ingredient ids (respect the budget's maxActives; prefer ingredients that help several focus concerns; avoid anything marked excluded). If it reports issues you can fix, call it once more.
4. Call finalize_plan with the headline, the 3 focus concerns with short plain-language explanations, the kept actives, and a one-sentence note per active.
Keep any text outside tool calls to one short sentence.`;

function briefFor(ctx) {
  const p = ctx.prefs;
  const lines = [
    `Scan tier: ${ctx.scan.tier.toUpperCase()}${ctx.scan.demo ? ' (demo data)' : ''}`,
    `Goals: ${p.goals.length ? p.goals.map((g) => GOALS[g].label).join('; ') : 'none given'}`,
    `Budget: ${BUDGETS[p.budget].label} (max ${BUDGETS[p.budget].maxActives} treatment products)`,
    `Time: ${TIMES[p.time].label}`,
    `Skin type (self-reported): ${SKIN_TYPES[p.skinType]}`,
    `Sensitive skin: ${p.sensitive ? 'yes' : 'no'}`,
    `Pregnant or breastfeeding: ${p.pregnant ? 'yes' : 'no'}`,
    `Measured concerns: ${ctx.scan.concerns.map((c) => `${c.key} ${c.score}`).join(', ')}`,
    ctx.scan.tone ? `Measured skin colour (YouCam Skin Tone Analysis): ${ctx.scan.tone.skinHex}, ITA ${ctx.scan.tone.ita}° (${ctx.scan.tone.depthLabel.toLowerCase()})` : 'Skin tone: not measured',
  ];
  if (ctx.previous) {
    const prev = new Map(ctx.previous.concerns.map((c) => [c.key, c.score]));
    lines.push(`Previous scan: ${ctx.scan.concerns.filter((c) => prev.has(c.key)).map((c) => `${c.key} ${prev.get(c.key)}→${c.score}`).join(', ')}`);
  }
  return lines.join('\n');
}

async function geminiLoop(ctx, deps, { maxTurns = 8, reserveMs = 3500 } = {}) {
  const run = makeToolRunner(ctx);
  const contents = [{ role: 'user', parts: [{ text: briefFor(ctx) }] }];
  for (let turn = 0; turn < maxTurns; turn += 1) {
    const left = remaining(ctx) - reserveMs;
    if (left < 2500) {
      traceStart(ctx, { kind: 'system', title: 'Time budget reached, the scripted planner finishes', by: 'system' }).done('');
      break;
    }
    const step = traceStart(ctx, { kind: 'model', title: turn === 0 ? `${deps.llm.model} read your scan and goals` : `${deps.llm.model} chose the next step` });
    let out;
    try {
      out = await deps.llm.generate({ system: PLAN_SYSTEM, contents, functionDeclarations: TOOL_DECLARATIONS, timeoutMs: Math.min(12000, left) });
    } catch (err) {
      step.done(err.message, 'error');
      throw err;
    }
    ctx.stats.modelTurns += 1;
    contents.push(out.content);
    step.done(out.functionCalls.length ? `Calling ${out.functionCalls.map((c) => c.name).join(', ')}` : out.text.slice(0, 160) || 'Finished');
    if (!out.functionCalls.length) break;
    // Remember the model's focus as soon as it is visible, so draft_routine cites focus concerns first.
    for (const fc of out.functionCalls) {
      if (fc.name === 'find_ingredients' && Array.isArray(fc.args?.concerns)) ctx.focusKeys = cleanConcerns(fc.args.concerns).slice(0, 3);
    }
    const results = await Promise.all(out.functionCalls.slice(0, 6).map(async (fc) => ({ id: fc.id, name: fc.name, response: await run(fc.name, fc.args) })));
    contents.push(functionResponseTurn(results));
    if (ctx.finalized) break;
  }
}

// ---------------------------------------------------------------------------
// Scripted policy (also completes whatever the LLM left unfinished)
// ---------------------------------------------------------------------------

function scriptedHeadline(ctx, focusKeys) {
  const names = focusKeys.map(labelOf);
  return `A steady plan for ${listOf(names)}`;
}

async function scriptedComplete(ctx) {
  const prev = ctx.policy;
  ctx.policy = 'scripted';
  const run = makeToolRunner(ctx);
  if (!ctx.ranked) await run('rank_concerns');
  if (!ctx.profiled) await run('skin_profile');
  const focusKeys = ctx.focusKeys?.length === 3 ? ctx.focusKeys : R.pickFocus(ctx.ranked);
  ctx.focusKeys = focusKeys;
  if (!focusKeys.every((k) => ctx.candidates[k])) await run('find_ingredients', { concerns: focusKeys });
  if (!ctx.pro) await run('professional_options');
  let actives = ctx.draft?.actives;
  if (!actives?.length) {
    actives = R.chooseActives(focusKeys, ctx.prefs, ctx.scan);
    await run('draft_routine', { actives });
    actives = ctx.draft.actives;
  }
  if (!ctx.finalized) {
    await run('finalize_plan', { focus: focusKeys.map((k) => ({ concern: k })), actives, headline: scriptedHeadline(ctx, focusKeys) });
  }
  ctx.policy = prev;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function planSkin(input, { llm, emit, budgetMs = 22000, youcam } = {}) {
  const ctx = createContext(input, emit, budgetMs);
  ctx.emit({ type: 'meta', mode: youcam ? modeInfo({ youcam, llm }) : { agent: llm ? 'gemini' : 'scripted', model: llm?.model || null } });
  let agentUsed = 'scripted';
  if (llm) {
    ctx.policy = 'gemini';
    try {
      await geminiLoop(ctx, { llm });
      agentUsed = ctx.finalized ? 'gemini' : 'gemini+scripted';
    } catch (err) {
      agentUsed = 'scripted-fallback';
      traceStart(ctx, { kind: 'system', title: 'Gemini was unavailable, so the scripted planner finished the plan', by: 'system' }).done(err.message, 'error');
    }
  }
  if (!ctx.finalized) await scriptedComplete(ctx);
  if (!ctx.finalized) throw new Error('The plan could not be grounded in the scan.');
  return {
    plan: ctx.plan,
    meta: { agent: agentUsed, model: llm?.model || null, stats: ctx.stats, trace: ctx.trace },
  };
}

