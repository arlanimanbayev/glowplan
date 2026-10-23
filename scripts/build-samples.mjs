#!/usr/bin/env node
/**
 * Generates the illustrated sample face used by demo mode (public/samples/face.svg)
 * and one overlay per concern (public/samples/overlays/hd_*.svg). The overlays play
 * the role of YouCam's `mask_urls` images (with enable_mask_overlay=true the API
 * returns the photo with the detected areas blended on top).
 *
 * The face is a drawn illustration, not a photo of a real person.
 *
 *   node scripts/build-samples.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const outDir = join(root, 'public', 'samples');
mkdirSync(join(outDir, 'overlays'), { recursive: true });

const W = 600;
const H = 800;

const face = `
  <rect width="${W}" height="${H}" fill="#d9e2de"/>
  <circle cx="470" cy="150" r="190" fill="#e6ece9"/>
  <!-- hair, back -->
  <path d="M120 420 C96 250 170 120 300 118 C430 120 506 250 480 420 C470 520 500 600 520 640 L80 640 C100 600 130 520 120 420 Z" fill="#2c2420"/>
  <!-- shoulders and neck -->
  <path d="M60 800 C70 700 150 660 240 640 L360 640 C450 660 530 700 540 800 Z" fill="#3e5a52"/>
  <path d="M252 540 L348 540 L356 652 C330 672 270 672 244 652 Z" fill="#b98466"/>
  <!-- ears -->
  <ellipse cx="150" cy="365" rx="20" ry="36" fill="#c48e6f"/>
  <ellipse cx="450" cy="365" rx="20" ry="36" fill="#c48e6f"/>
  <!-- face -->
  <path d="M300 165 C392 165 452 232 452 340 C452 452 392 560 300 568 C208 560 148 452 148 340 C148 232 208 165 300 165 Z" fill="#cf9a7b"/>
  <!-- fringe -->
  <path d="M150 292 C148 186 228 136 308 140 C390 144 454 196 454 286 C434 228 376 196 300 198 C236 196 182 226 150 292 Z" fill="#2c2420"/>
  <!-- brows -->
  <path d="M206 312 C226 300 254 300 274 308" stroke="#3a2c26" stroke-width="7" fill="none" stroke-linecap="round"/>
  <path d="M326 308 C346 300 374 300 394 312" stroke="#3a2c26" stroke-width="7" fill="none" stroke-linecap="round"/>
  <!-- eyes -->
  <path d="M212 348 C226 334 256 334 270 348 C256 358 226 358 212 348 Z" fill="#f4efe9"/>
  <path d="M330 348 C344 334 374 334 388 348 C374 358 344 358 330 348 Z" fill="#f4efe9"/>
  <circle cx="241" cy="347" r="8.5" fill="#3b2a22"/>
  <circle cx="359" cy="347" r="8.5" fill="#3b2a22"/>
  <path d="M210 347 C226 330 256 330 272 347" stroke="#3a2c26" stroke-width="3" fill="none" stroke-linecap="round"/>
  <path d="M328 347 C344 330 374 330 390 347" stroke="#3a2c26" stroke-width="3" fill="none" stroke-linecap="round"/>
  <!-- nose -->
  <path d="M300 352 C298 380 292 404 286 420 C292 430 308 430 314 420" stroke="#a9765a" stroke-width="3.5" fill="none" stroke-linecap="round"/>
  <!-- mouth -->
  <path d="M262 478 C280 470 320 470 338 478 C322 494 278 494 262 478 Z" fill="#b25f5a"/>
  <path d="M262 478 C282 484 318 484 338 478" stroke="#8e4744" stroke-width="2.5" fill="none" stroke-linecap="round"/>
`;

const svg = (body, label) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${label}">${body}</svg>\n`;

writeFileSync(join(outDir, 'face.svg'), svg(face, 'Illustrated sample face'));

// Seeded scatter helper for dots.
function scatter(cx, cy, rx, ry, n, seed, r = 3, fill = '#f2c14e', opacity = 0.9) {
  let s = seed;
  const rand = () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
  let out = '';
  for (let i = 0; i < n; i += 1) {
    const a = rand() * Math.PI * 2;
    const d = Math.sqrt(rand());
    out += `<circle cx="${(cx + Math.cos(a) * rx * d).toFixed(1)}" cy="${(cy + Math.sin(a) * ry * d).toFixed(1)}" r="${(r * (0.6 + rand() * 0.8)).toFixed(1)}" fill="${fill}" opacity="${opacity}"/>`;
  }
  return out;
}
const line = (d, color = '#f2c14e', w = 3) => `<path d="${d}" stroke="${color}" stroke-width="${w}" fill="none" stroke-linecap="round"/>`;
const blob = (cx, cy, rx, ry, color, opacity = 0.45) => `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="${color}" opacity="${opacity}"/>`;
const veil = '<rect width="600" height="800" fill="#0d1f1b" opacity="0.28"/>';

const OVERLAYS = {
  hd_pore: scatter(300, 252, 88, 24, 34, 7, 2.6) + scatter(300, 400, 22, 36, 34, 11, 2.4) + scatter(215, 425, 44, 32, 26, 13, 2.2) + scatter(385, 425, 44, 32, 26, 17, 2.2),
  hd_wrinkle: [
    'M242 240 C274 234 326 234 358 240', 'M232 262 C268 256 332 256 368 262', 'M292 316 L296 330', 'M308 316 L304 330',
    'M190 340 L172 330', 'M190 352 L170 352', 'M190 364 L172 374', 'M410 340 L428 330', 'M410 352 L430 352', 'M410 364 L428 374',
    'M220 372 C232 380 252 380 264 372', 'M336 372 C348 380 368 380 380 372',
    'M272 436 C258 456 252 476 256 496', 'M328 436 C342 456 348 476 344 496', 'M258 506 L264 536', 'M342 506 L336 536',
  ].map((d) => line(d)).join(''),
  hd_texture: scatter(300, 360, 130, 160, 220, 23, 1.6, '#f2c14e', 0.75),
  hd_acne: scatter(212, 440, 40, 34, 7, 29, 5, '#e2574c', 0.95) + scatter(300, 530, 30, 16, 4, 31, 4.5, '#e2574c', 0.95) + scatter(300, 252, 66, 18, 3, 37, 4.5, '#e2574c', 0.95),
  hd_redness: blob(215, 425, 58, 44, '#e2574c', 0.4) + blob(385, 425, 58, 44, '#e2574c', 0.4) + blob(300, 405, 26, 40, '#e2574c', 0.35),
  hd_oiliness: blob(300, 252, 96, 30, '#fff7d6', 0.55) + blob(300, 395, 30, 58, '#fff7d6', 0.6) + blob(300, 530, 34, 18, '#fff7d6', 0.5),
  hd_moisture: blob(205, 430, 52, 44, '#8ad1e0', 0.35) + blob(395, 430, 52, 44, '#8ad1e0', 0.35) + scatter(205, 430, 46, 38, 30, 41, 1.6, '#e8fbff', 0.9) + scatter(395, 430, 46, 38, 30, 43, 1.6, '#e8fbff', 0.9),
  hd_radiance: `${veil}${blob(300, 330, 120, 150, '#fff2c4', 0.25)}`,
  hd_firmness: line('M168 420 C190 500 240 552 300 562 C360 552 410 500 432 420', '#f2c14e', 4) + line('M190 470 C200 492 214 508 230 520', '#f2c14e', 3) + line('M410 470 C400 492 386 508 370 520', '#f2c14e', 3),
  hd_age_spot: scatter(220, 410, 52, 46, 9, 47, 4, '#7a4b2a', 0.75) + scatter(380, 400, 52, 46, 8, 53, 4, '#7a4b2a', 0.75) + scatter(300, 252, 80, 22, 6, 59, 3.5, '#7a4b2a', 0.7),
  hd_dark_circle: blob(240, 374, 40, 13, '#5b3f63', 0.55) + blob(360, 374, 40, 13, '#5b3f63', 0.55),
  hd_eye_bag: line('M214 368 C230 392 254 392 270 370', '#f2c14e', 3.5) + line('M330 370 C346 392 370 392 386 368', '#f2c14e', 3.5),
  hd_tear_trough: line('M232 384 C246 398 262 398 276 386', '#f2c14e', 3.5) + line('M324 386 C338 398 354 398 368 384', '#f2c14e', 3.5),
  hd_droopy_upper_eyelid: line('M208 340 C224 322 258 322 274 340', '#f2c14e', 3.5) + line('M326 340 C342 322 376 322 392 340', '#f2c14e', 3.5),
  hd_droopy_lower_eyelid: line('M212 354 C228 366 256 366 270 354', '#f2c14e', 3.5) + line('M330 354 C344 366 372 366 388 354', '#f2c14e', 3.5),
};

for (const [name, marks] of Object.entries(OVERLAYS)) {
  writeFileSync(join(outDir, 'overlays', `${name}.svg`), svg(`${face}<g>${marks}</g>`, `Illustrated sample face with ${name.replace('hd_', '').replace(/_/g, ' ')} areas highlighted`));
}
console.log(`Wrote face.svg and ${Object.keys(OVERLAYS).length} overlays to ${outDir}`);
