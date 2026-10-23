// The agent: scripted fallback, a scripted Gemini tool-calling session, and
// what happens when Gemini fails or writes numbers that don't match the scan.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sampleScan, fakeGemini, call, lastToolResult } from './helpers.js';
import { planSkin, validatePlanInput, TOOL_DECLARATIONS, depsFromEnv, modeInfo } from '../lib/agent.js';
import { checkGrounding } from '../lib/routine.js';

const input = (prefs = { goals: ['breakouts', 'even_tone'], budget: 2, time: 'standard', skinType: 'combination' }, extra = {}) => {
  const v = validatePlanInput({ scan: sampleScan('demo-a'), preferences: prefs, ...extra });
  assert.ok(v.value, v.error);
  return v.value;
};

test('scripted policy (no GEMINI_API_KEY) produces a complete, grounded plan', async () => {
  const events = [];
  const { plan, meta } = await planSkin(input(), { emit: (e) => events.push(e) });
  assert.equal(meta.agent, 'scripted');
  assert.deepEqual(plan.focus.map((f) => f.key), ['pore', 'oiliness', 'acne']);
  assert.ok(plan.routine.am.length >= 3 && plan.routine.pm.length >= 3);
  assert.deepEqual(plan.grounding.problems, []);
  assert.deepEqual(checkGrounding(plan, input().scan), []);
  assert.ok(plan.routine.am.some((s) => s.id === 'niacinamide'));
  assert.ok(plan.professional.items.length >= 1);
  const tools = meta.trace.filter((t) => t.status === 'done').map((t) => t.tool);
  assert.deepEqual(tools, ['rank_concerns', 'skin_profile', 'find_ingredients', 'professional_options', 'draft_routine', 'finalize_plan']);
  assert.ok(events.some((e) => e.type === 'trace'));
  assert.match(plan.disclaimer, /not medical advice/);
});

test('validatePlanInput rejects missing or tiny scans', () => {
  assert.match(validatePlanInput({}).error, /scan/);
  assert.match(validatePlanInput({ scan: { concerns: [{ key: 'pore', score: 4 }] } }).error, /three/);
  const v = validatePlanInput({ scan: sampleScan(), goals: ['nope', 'glow'], budget: 9 });
  assert.deepEqual(v.value.prefs.goals, ['glow']);
  assert.equal(v.value.prefs.budget, 2);
});

test('previous scan adds progress to the plan and the brief', async () => {
  const v = validatePlanInput({ scan: sampleScan('demo-b'), previous: sampleScan('demo-a'), preferences: { goals: ['breakouts'] } });
  let brief = '';
  const { llm } = fakeGemini((turn, body) => {
    brief = body.contents[0].parts[0].text;
    return { parts: [{ text: 'Done.' }] };
  });
  const { plan, meta } = await planSkin(v.value, { llm });
  assert.equal(plan.progress.days, 56);
  assert.match(brief, /Previous scan: .*acne 47→59/);
  assert.equal(meta.agent, 'gemini+scripted', 'Gemini stopped early, the scripted planner finished');
});

test('Gemini tool-calling loop: model picks focus and actives, notes are kept, numbers come from the scan', async () => {
  const { llm, requests } = fakeGemini((turn, body) => {
    if (turn === 0) return { parts: [{ text: 'Ranking first.' }, call('rank_concerns')] };
    if (turn === 1) {
      const rank = lastToolResult(body, 'rank_concerns');
      assert.equal(rank.ranking[0].concern, 'pore');
      return { parts: [call('find_ingredients', { concerns: ['pore', 'acne', 'redness'] }), call('professional_options')] };
    }
    if (turn === 2) {
      const found = lastToolResult(body, 'find_ingredients');
      assert.ok(found.candidates.acne.length);
      return { parts: [call('draft_routine', { actives: ['azelaic_acid', 'niacinamide'] })] };
    }
    if (turn === 3) {
      const draft = lastToolResult(body, 'draft_routine');
      assert.ok(draft.morning.length && draft.evening.length);
      return {
        parts: [call('finalize_plan', {
          headline: 'Calm, clear skin without overdoing it',
          focus: [
            { concern: 'pore', explanation: 'Your pores show most on the nose (33/100), so we keep them clear.' },
            { concern: 'acne', explanation: 'A few active breakouts; the plan calms them gently.' },
            { concern: 'redness', explanation: 'Your redness is 90/100 which is perfect.' },
          ],
          actives: draft.kept_actives,
          step_notes: [{ id: 'azelaic_acid', note: 'Calms redness and helps clear breakouts.' }, { id: 'niacinamide', note: 'This will cure everything.' }],
        })],
      };
    }
    return { parts: [{ text: 'Plan ready.' }] };
  });
  const { plan, meta } = await planSkin(input(), { llm });
  assert.equal(meta.agent, 'gemini');
  assert.equal(meta.model, 'test-model');
  assert.equal(requests.length, 4, 'finalize ends the loop');
  assert.equal(requests[0].body.tools[0].functionDeclarations.length, TOOL_DECLARATIONS.length);
  assert.equal(plan.headline, 'Calm, clear skin without overdoing it');
  assert.deepEqual(plan.focus.map((f) => f.key), ['pore', 'acne', 'redness']);
  assert.match(plan.focus[0].explanation, /33\/100/, 'a real regional score is allowed');
  assert.doesNotMatch(plan.focus[2].explanation, /90\/100/, 'an invented score is dropped for the template text');
  const steps = [...plan.routine.am, ...plan.routine.pm];
  assert.equal(steps.find((s) => s.id === 'azelaic_acid').note, 'Calms redness and helps clear breakouts.');
  assert.equal(steps.find((s) => s.id === 'niacinamide').note, undefined, 'medical-claim note rejected');
  assert.deepEqual(plan.grounding.problems, []);
  assert.ok(meta.trace.some((t) => t.kind === 'model' && t.by === 'gemini'));
});

test('a rejected finalize (bad focus) is returned to the model with problems, then fixed', async () => {
  let rejection;
  const { llm } = fakeGemini((turn, body) => {
    if (turn === 0) return { parts: [call('rank_concerns')] };
    if (turn === 1) return { parts: [call('finalize_plan', { headline: 'x', focus: [{ concern: 'pore', explanation: 'x' }], actives: ['niacinamide'] })] };
    if (turn === 2) {
      rejection = lastToolResult(body, 'finalize_plan');
      return { parts: [call('finalize_plan', { headline: 'Fixed plan', focus: [{ concern: 'pore', explanation: 'a' }, { concern: 'oiliness', explanation: 'b' }, { concern: 'acne', explanation: 'c' }], actives: ['niacinamide'] })] };
    }
    return { parts: [{ text: 'ok' }] };
  });
  const { plan, meta } = await planSkin(input(), { llm });
  assert.equal(rejection.ok, false);
  assert.match(rejection.problems[0], /exactly 3/);
  assert.equal(meta.agent, 'gemini');
  assert.equal(plan.headline, 'Fixed plan');
});

test('Gemini HTTP failure falls back to the scripted planner with a valid plan', async () => {
  const { llm } = fakeGemini(() => ({ status: 503, message: 'overloaded' }));
  const { plan, meta } = await planSkin(input(), { llm });
  assert.equal(meta.agent, 'scripted-fallback');
  assert.ok(meta.trace.some((t) => t.kind === 'system' && /scripted planner/.test(t.title)));
  assert.equal(plan.focus.length, 3);
  assert.deepEqual(plan.grounding.problems, []);
});

test('unknown tools and bad arguments come back as tool errors, not crashes', async () => {
  let errs = {};
  const { llm } = fakeGemini((turn, body) => {
    if (turn === 0) return { parts: [call('delete_everything'), call('find_ingredients', { concerns: ['not_a_concern'] })] };
    if (turn === 1) {
      errs = { unknown: lastToolResult(body, 'delete_everything'), bad: lastToolResult(body, 'find_ingredients') };
      return { parts: [{ text: 'stopping' }] };
    }
    return { parts: [] };
  });
  const { plan } = await planSkin(input(), { llm });
  assert.match(errs.unknown.error, /Unknown tool/);
  assert.match(errs.bad.error, /Pass concerns/);
  assert.deepEqual(plan.grounding.problems, []);
});

test('environment picks demo YouCam + scripted planner without keys', () => {
  const deps = depsFromEnv({});
  assert.deepEqual(modeInfo(deps), { youcam: 'demo', skinApiVersion: 'v2.1', agent: 'scripted', model: null });
  const live = depsFromEnv({ YOUCAM_API_KEY: 'k', GEMINI_API_KEY: 'g', YOUCAM_SKIN_VERSION: 'v2.0' });
  assert.equal(modeInfo(live).youcam, 'live');
  assert.equal(live.youcam.taskPath, '/s2s/v2.0/task/skin-analysis');
  assert.equal(live.youcam.baseUrl, 'https://yce-api-01.makeupar.com');
  assert.equal(modeInfo(live).agent, 'gemini');
  assert.equal(live.demo.mode, 'mock', 'samples always use the demo client');
});

test('skin tone reaches the agent: brief, skin_profile tool and a grounded plan', async () => {
  const v = validatePlanInput({ scan: { ...sampleScan('demo-a'), tone: { skinHex: '#8d5a3c', ita: 99, quality: { lighting: 'good' } } }, preferences: { goals: ['breakouts'] } });
  assert.equal(v.value.scan.tone.ita, -15, 'ITA is re-derived on the server, never trusted from the client');
  let brief = '';
  let profile;
  const { llm } = fakeGemini((turn, body) => {
    if (turn === 0) {
      brief = body.contents[0].parts[0].text;
      return { parts: [call('rank_concerns'), call('skin_profile')] };
    }
    if (turn === 1) {
      profile = lastToolResult(body, 'skin_profile');
      return { parts: [{ text: 'done' }] };
    }
    return { parts: [] };
  });
  const { plan } = await planSkin(v.value, { llm });
  assert.match(brief, /Measured skin colour \(YouCam Skin Tone Analysis\): #8d5a3c, ITA -15°/);
  assert.equal(profile.skin_tone.measured_skin_color, '#8d5a3c');
  assert.match(profile.skin_tone.note, /does not return an undertone/);
  assert.match(profile.guidance, /gentle, tone-evening/);
  assert.equal(plan.profile.tone.depth, 'brown');
  assert.ok(plan.profile.notes.some((n) => n.id === 'pih' && n.toneCite.hex === '#8d5a3c'));
  assert.deepEqual(plan.grounding.problems, []);
});
