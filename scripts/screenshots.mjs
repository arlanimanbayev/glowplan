#!/usr/bin/env node
/**
 * End-to-end check + screenshots in demo mode (no keys needed).
 *
 *   npm run e2e        (same as npm run screenshots)
 *
 * Starts dev-server.js with keys blanked, drives the UI with Playwright and
 * asserts the full journey: sample scan (skin analysis + skin tone on one upload)
 * -> skin profile -> plan -> concern overlay -> check-in scan (tone reused) ->
 * progress chart -> print view (+ a PDF of the clinic summary), plus the
 * own-photo path (upload, crop, HD tier detection). Checks there is no horizontal
 * scroll and no console error, and writes PNGs to docs/screenshots/.
 * Playwright isn't a project dependency: install it globally or set PLAYWRIGHT_MODULE.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
function loadPlaywright() {
  const candidates = [process.env.PLAYWRIGHT_MODULE, 'playwright', '/opt/npm-tools/node_modules/playwright', '/usr/local/lib/node_modules/playwright', '/usr/lib/node_modules/playwright'].filter(Boolean);
  for (const c of candidates) {
    try {
      return require(c);
    } catch {
      /* try next */
    }
  }
  throw new Error('Playwright not found. Install it (npm i -g playwright) or set PLAYWRIGHT_MODULE.');
}
const { chromium } = loadPlaywright();

const root = fileURLToPath(new URL('..', import.meta.url));
const outDir = join(root, 'docs', 'screenshots');
mkdirSync(outDir, { recursive: true });
const port = Number(process.env.SHOT_PORT) || 3456;
const base = `http://localhost:${port}`;

const server = spawn(process.execPath, [join(root, 'dev-server.js')], {
  env: { ...process.env, PORT: String(port), RATE_LIMIT: 'off', MOCK_TASK_MS: '1400', MOCK_LATENCY_MS: '30', YOUCAM_API_KEY: '', GEMINI_API_KEY: '' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('dev server did not start')), 10000);
  server.stdout.on('data', (d) => {
    if (String(d).includes('running at')) {
      clearTimeout(t);
      resolve();
    }
  });
  server.stderr.on('data', (d) => process.stderr.write(d));
});

const failures = [];
const check = (cond, msg) => {
  if (!cond) failures.push(msg);
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`);
};

async function noHorizontalScroll(page, label, width) {
  const { sw, iw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
  check(sw <= width && iw <= width, `${label}: no horizontal overflow (scrollWidth ${sw}, viewport ${width})`);
}

async function settle(page) {
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => {
    document.activeElement?.blur();
  });
  await page.mouse.move(1, 1);
  await page.waitForTimeout(150);
}

async function waitResults(page) {
  await page.waitForSelector('#view-results:not([hidden])', { timeout: 30000 });
  await page.waitForSelector('#am-list li');
  await settle(page);
}

const browser = await chromium.launch();
const runs = [
  { device: 'desktop', theme: 'light', viewport: { width: 1440, height: 900 }, scale: 1, extras: true },
  { device: 'desktop', theme: 'dark', viewport: { width: 1440, height: 900 }, scale: 1 },
  { device: 'mobile', theme: 'light', viewport: { width: 390, height: 844 }, scale: 2, extras: true },
  { device: 'mobile', theme: 'dark', viewport: { width: 390, height: 844 }, scale: 2 },
];

for (const run of runs) {
  const tag = `${run.device}-${run.theme}`;
  const W = run.viewport.width;
  const context = await browser.newContext({ viewport: run.viewport, deviceScaleFactor: run.scale, colorScheme: run.theme, isMobile: run.device === 'mobile', hasTouch: run.device === 'mobile' });
  const page = await context.newPage();
  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));

  // 1. Start
  await page.goto(`${base}/?clinic=${encodeURIComponent('Lumen Skin Studio')}`);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#youcam-status')?.textContent.includes('Demo data'));
  await settle(page);
  await page.screenshot({ path: join(outDir, `01-start-${tag}.png`) });
  await noHorizontalScroll(page, `${tag} start`, W);
  check((await page.locator('input[name="goal"]:checked').count()) === 2, `${tag}: two goals preselected`);

  // 2. Sample scan -> plan
  await page.click('#sample-btn');
  check((await page.locator('#tier-note').textContent()).includes('Sample face'), `${tag}: sample face selected`);
  if (run.device === 'desktop' && run.theme === 'light') await page.locator('#scan-form').screenshot({ path: join(outDir, `02-sample-ready-${tag}.png`) });
  // Hold the plan request briefly so the working view can be captured with both YouCam analyses done.
  await page.route('**/api/plan', async (route) => {
    await new Promise((r) => setTimeout(r, 1200));
    await route.continue();
  });
  await page.click('#scan-btn');
  await page.waitForFunction(() => {
    const done = [...document.querySelectorAll('#steps li[data-status="done"] .st-title')].map((e) => e.textContent);
    return done.includes('Skin analysis') && done.includes('Skin tone');
  }, null, { timeout: 15000 });
  check(true, `${tag}: working view shows Skin analysis ✓ and Skin tone ✓ after one upload`);
  check((await page.locator('#steps li', { hasText: 'Uploaded once' }).count()) === 1, `${tag}: a single upload step`);
  await page.waitForTimeout(150);
  if (run.theme === 'light' || run.device === 'mobile') await page.screenshot({ path: join(outDir, `03-working-${tag}.png`) });
  await waitResults(page);
  await page.unroute('**/api/plan');

  // Skin profile from Skin Tone Analysis
  check(await page.locator('#profile-block').isVisible(), `${tag}: skin profile visible`);
  const facts = await page.locator('#profile-facts').textContent();
  check(facts.includes('#cf9a7b') && /intermediate on the ITA scale \(37°\)/.test(facts), `${tag}: profile shows measured skin colour and ITA depth`);
  check((await page.locator('#tone-swatch').evaluate((e) => getComputedStyle(e).backgroundColor)) === 'rgb(207, 154, 123)', `${tag}: swatch painted with the measured colour`);
  check(await page.locator('#ita-scale .ita-marker').isVisible(), `${tag}: ITA scale marker drawn`);
  const spfText = await page.locator('#am-list > li').last().textContent();
  check(/Tinted/.test(spfText) && /medium tint/.test(spfText) && /YouCam measured your skin colour as #cf9a7b/.test(spfText), `${tag}: sunscreen step uses the measured tone and cites it`);
  await settle(page);
  if (run.extras || run.theme === 'dark') await page.locator('#profile-block').screenshot({ path: join(outDir, `08-profile-${tag}.png`) });

  const focus = await page.locator('#focus-list > li').count();
  check(focus === 3, `${tag}: plan has 3 focus concerns`);
  const steps = await page.locator('#am-list > li, #pm-list > li').count();
  const cites = await page.locator('#am-list > li, #pm-list > li').evaluateAll((lis) => lis.map((li) => li.querySelector('.cite')?.textContent || ''));
  check(steps >= 5 && cites.every(Boolean), `${tag}: ${steps} routine steps, each with a citation`);
  check(cites.every((c) => /score is \d{1,3}\/100/.test(c)), `${tag}: every routine citation names a measured score`);
  check((await page.locator('#demo-flag').isVisible()) && (await page.locator('#demo-flag').textContent()).includes('Demo data'), `${tag}: results labelled as demo data`);
  check((await page.locator('#scores-chart .row').count()) === 15, `${tag}: score chart has 15 rows`);
  check((await page.locator('#zone-map .zone').count()) >= 4, `${tag}: face map drawn`);
  check((await page.locator('#pro-list .pro-item').count()) >= 1, `${tag}: professional guidance shown`);
  await noHorizontalScroll(page, `${tag} results`, W);
  await page.screenshot({ path: join(outDir, `04-results-top-${tag}.png`) });
  await page.screenshot({ path: join(outDir, `04-results-full-${tag}.png`), fullPage: true });

  // Overlay + face map modes
  await page.locator('#overlay-switch button', { hasText: 'Pores' }).click();
  await page.waitForFunction(() => !document.querySelector('#result-overlay').hidden && document.querySelector('#result-overlay').complete);
  check((await page.locator('#result-overlay').getAttribute('src')).includes('hd_pore'), `${tag}: pores overlay (YouCam mask_urls) shown`);
  await page.locator('#zone-tabs button', { hasText: 'Lines' }).click();
  check((await page.locator('#zone-note').textContent()).includes('Under the eyes'), `${tag}: face map shows wrinkle regions`);
  await settle(page);
  if (run.extras) await page.locator('.face-panel').screenshot({ path: join(outDir, `05-face-panel-${tag}.png`) });
  await page.locator('#zone-tabs button', { hasText: 'Pores' }).click();

  // Table view toggle
  await page.click('#scores-table-btn');
  check((await page.locator('#scores-table tbody tr').count()) === 15, `${tag}: score table view has 15 rows`);
  await page.click('#scores-table-btn');

  // 3. Check-in scan -> progress
  await page.click('#checkin-btn');
  check((await page.locator('#sample-btn').textContent()).includes('8-week'), `${tag}: check-in offers the sample's 8-week scan`);
  await page.click('#sample-btn');
  await page.click('#scan-btn');
  await page.waitForSelector('#steps li[data-status="skipped"]', { timeout: 15000 });
  check((await page.locator('#steps li[data-status="skipped"]').textContent()).includes('no extra units'), `${tag}: check-in reuses the skin tone (no extra units)`);
  await waitResults(page);
  check((await page.locator('#profile-facts').textContent()).includes('reused'), `${tag}: profile says the tone was reused`);
  check(await page.locator('#progress-block').isVisible(), `${tag}: progress section visible after check-in`);
  check((await page.locator('#progress-chart .row').count()) === 15, `${tag}: progress chart has 15 rows`);
  const summary = await page.locator('#progress-summary').textContent();
  check(/improved/.test(summary) && /56 days/.test(summary), `${tag}: progress summary ("${summary.slice(0, 70)}")`);
  await noHorizontalScroll(page, `${tag} progress`, W);
  await settle(page);
  await page.locator('#progress-block').screenshot({ path: join(outDir, `06-progress-${tag}.png`) });

  // 4. Print view
  if (run.extras) {
    await page.emulateMedia({ media: 'print' });
    check(await page.locator('#print-sheet').isVisible(), `${tag}: print sheet visible in print media`);
    check((await page.locator('#print-sheet').textContent()).includes('Lumen Skin Studio'), `${tag}: print sheet carries the clinic name`);
    if (run.device === 'desktop') {
      await page.setViewportSize({ width: 794, height: 1123 });
      await page.screenshot({ path: join(outDir, `07-print-${tag}.png`) });
      const pdf = await page.pdf({ format: 'A4', printBackground: true });
      writeFileSync(join(root, 'docs', 'clinic-summary-sample.pdf'), pdf);
      const pages = (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
      check(pages === 1, `${tag}: clinic summary prints on one page (${pages})`);
      await page.setViewportSize(run.viewport);
    }
    await page.emulateMedia({ media: 'screen' });
  }

  // 5. Own-photo path: upload, crop, HD detection (demo data, clearly labelled)
  if (run.extras) {
    const png = await page.evaluate(async () => {
      const img = new Image();
      img.src = '/samples/face.svg';
      await img.decode();
      const c = document.createElement('canvas');
      c.width = 1500;
      c.height = 2000;
      c.getContext('2d').drawImage(img, 0, 0, 1500, 2000);
      return c.toDataURL('image/png').split(',')[1];
    });
    await page.click('#restart-btn');
    await page.setInputFiles('#file-input', { name: 'selfie.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
    await page.waitForFunction(() => document.querySelector('#tier-note')?.textContent.includes('scan'));
    check((await page.locator('#tier-note').textContent()).includes('HD scan'), `${tag}: 1500×2000 upload qualifies for an HD scan`);
    await page.locator('#zoom').fill('1.4');
    await page.waitForTimeout(100);
    const note = await page.locator('#tier-note').textContent();
    check(/HD scan|Standard scan/.test(note), `${tag}: zoom updates the tier note ("${note.slice(0, 40)}")`);
    await settle(page);
    await page.locator('#scan-form').screenshot({ path: join(outDir, `02-photo-ready-${tag}.png`) });
    await page.click('#scan-btn');
    await waitResults(page);
    check((await page.locator('#demo-flag').textContent()).includes('not from your photo'), `${tag}: uploaded photo in demo mode is labelled as illustrative`);
    check((await page.locator('#profile-facts').textContent()).includes('on the ITA scale'), `${tag}: own photo gets a skin-tone profile`);
    check((await page.locator('#result-photo').getAttribute('src')).startsWith('blob:'), `${tag}: own photo shown from memory (blob URL)`);
    const stored = await page.evaluate(() => localStorage.getItem('glowplan-v1') || '');
    check(!stored.includes('data:image') && !stored.includes('blob:'), `${tag}: no photo data in localStorage`);
  }

  check(errors.length === 0, `${tag}: no console errors${errors.length ? `: ${errors.join(' | ')}` : ''}`);
  await context.close();
}

await browser.close();
server.kill();
if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log(`\nAll checks passed. Screenshots in ${outDir}`);
