#!/usr/bin/env node
/**
 * Check a YouCam API key without spending units, and optionally run one real scan.
 *
 *   YOUCAM_API_KEY=... npm run youcam:check                 # balance + skin-analysis unit costs (free)
 *   YOUCAM_API_KEY=... npm run youcam:check -- selfie.jpg   # also runs ONE real skin + skin-tone scan (uses units)
 *
 * Balance and cost endpoints come from Perfect Corp's official YouCam-API/skills
 * repo (GET /s2s/v1.0/client/credit, GET /s2s/v2.0/credit/feature-cost). Reads .env if present.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, basename } from 'node:path';
import { createYouCamClient, YOUCAM_DEFAULT_BASE_URL, YOUCAM_SKIN_VERSION, TONE_UNITS } from '../lib/youcam.js';
import { inspectImage } from '../lib/image.js';
import { estimateUnits, CONCERN_KEYS } from '../lib/concerns.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const envFile = join(root, '.env');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}
const key = process.env.YOUCAM_API_KEY;
const base = (process.env.YOUCAM_BASE_URL || YOUCAM_DEFAULT_BASE_URL).replace(/\/+$/, '');
if (!key) {
  console.error('Set YOUCAM_API_KEY (in .env or the environment) first.');
  process.exit(1);
}
const headers = { Authorization: `Bearer ${key}`, Accept: 'application/json' };

async function get(path) {
  const res = await fetch(`${base}${path}`, { headers });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

const credit = await get('/s2s/v1.0/client/credit');
if (credit.status === 401) {
  console.error('YouCam rejected the key (401). Check YOUCAM_API_KEY.');
  process.exit(1);
}
const batches = Array.isArray(credit.body?.results) ? credit.body.results : [];
const units = batches.filter((b) => String(b.type || '').startsWith('Api')).reduce((s, b) => s + (b.amount || 0), 0);
console.log(`Key OK (HTTP ${credit.status}). API units available: ${units}`);

const cost = await get('/s2s/v2.0/credit/feature-cost?page_size=20');
const skus = (cost.body?.result?.skus || []).filter((s) => /skin-analysis|skin-tone-analysis/.test(String(s.run_task_url || '')));
if (skus.length) for (const s of skus) console.log(`  ${s.description}: ${s.amount} ${s.unit || 'units'}`);
else console.log(`  (feature-cost lookup returned HTTP ${cost.status}; documented: skin analysis of 15 concerns HD ${estimateUnits('hd', 15)} / SD ${estimateUnits('sd', 15)} units, skin tone ${TONE_UNITS} units)`);

const file = process.argv[2];
if (file) {
  const buf = readFileSync(file);
  const info = inspectImage(buf);
  console.log(`\nRunning one ${info.tier.toUpperCase()} skin analysis + skin tone scan of ${basename(file)} (${info.width}x${info.height}); about ${estimateUnits(info.tier, CONCERN_KEYS.length) + TONE_UNITS} units.`);
  const yc = createYouCamClient({ apiKey: key, baseUrl: base, version: process.env.YOUCAM_SKIN_VERSION || YOUCAM_SKIN_VERSION });
  const out = await yc.analyzeProfile(buf, { contentType: info.type, fileName: basename(file), tier: info.tier, deadline: Date.now() + 90000, onStep: (s) => s.status !== 'running' && console.log(`  ${s.id}: ${s.status} ${s.detail || ''}`) });
  console.log(`Uploads: ${out.uploads} (1 means the file_id was reused for both tasks)`);
  if (out.status !== 'success') {
    console.log(`Still running. Skin task id: ${out.skin.taskId}`);
  } else {
    const r = out.skin.result;
    console.log(`Overall ${r.overall} (${r.overallSource})${r.skinAge ? `, skin age ${r.skinAge}` : ''}`);
    for (const c of r.concerns) console.log(`  ${c.label.padEnd(20)} ${String(c.score).padStart(3)}${c.regions.length ? `  ${c.regions.map((x) => `${x.label} ${x.score}`).join(', ')}` : ''}`);
    if (r.unknownTypes.length) console.log(`Unrecognised result types (please report): ${r.unknownTypes.join(', ')}`);
    if (out.tone.status === 'success') console.log(`Skin tone: ${out.tone.result.skinHex}, ITA ${out.tone.result.ita}° (${out.tone.result.depthLabel}); photo check ${JSON.stringify(out.tone.result.quality)}`);
    else console.log(`Skin tone: ${out.tone.status} ${out.tone.error?.message || ''}`);
  }
}
