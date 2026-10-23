/**
 * GlowPlan's curated, conservative skin-care knowledge.
 *
 * - Ingredient CLASSES only (no brands, no prices), each mapped to the YouCam
 *   concerns it is commonly used for, with how irritating it tends to be,
 *   when to apply it, and what not to layer it with.
 * - In-clinic treatment CATEGORIES per concern, described neutrally. GlowPlan
 *   never diagnoses and never says a treatment will work for someone; it says
 *   which categories clinics commonly offer for a concern and when a
 *   consultation is worth considering.
 *
 * Everything here is cosmetic guidance, not medical advice. Sources are general
 * dermatology consensus (e.g. AAD patient guidance on sunscreen, retinoids,
 * acne and pigmentation); concentrations are typical over-the-counter ranges.
 */

export const GOALS = {
  breakouts: { label: 'Fewer breakouts', concerns: ['acne', 'pore', 'oiliness', 'redness', 'texture'] },
  even_tone: { label: 'More even tone', concerns: ['age_spot', 'redness', 'radiance', 'dark_circle'] },
  smoother: { label: 'Smoother, firmer skin', concerns: ['wrinkle', 'firmness', 'texture', 'tear_trough', 'droopy_upper_eyelid', 'droopy_lower_eyelid'] },
  hydration: { label: 'Comfortable, hydrated skin', concerns: ['moisture', 'texture', 'redness', 'radiance'] },
  eyes: { label: 'Fresher eye area', concerns: ['dark_circle', 'eye_bag', 'tear_trough', 'droopy_lower_eyelid', 'droopy_upper_eyelid'] },
  glow: { label: 'More glow', concerns: ['radiance', 'texture', 'moisture', 'age_spot'] },
};

export const BUDGETS = {
  1: { label: 'Essentials', detail: 'one treatment product, lowest-cost classes', maxActives: 1, maxCost: 1 },
  2: { label: 'Balanced', detail: 'up to two treatment products', maxActives: 2, maxCost: 2 },
  3: { label: 'Flexible', detail: 'up to three treatment products', maxActives: 3, maxCost: 3 },
};

export const TIMES = {
  quick: { label: 'Under 3 minutes a day', am: 3, pm: 3 },
  standard: { label: '5 to 10 minutes a day', am: 4, pm: 4 },
  unhurried: { label: '15 minutes or more', am: 5, pm: 5 },
};

export const SKIN_TYPES = {
  oily: 'Oily',
  combination: 'Combination',
  normal: 'Normal',
  dry: 'Dry',
  unsure: 'Not sure',
};

/** Plain-language meaning of each score, used for the focus summary. */
export const EXPLAIN = {
  wrinkle: {
    what: 'how visible fine lines and creases are',
    focus: 'Lines form where skin folds with expression and where collagen thins over time; daily sun exposure speeds this up.',
    region: (phrase) => `Lines show most ${phrase}`,
  },
  pore: {
    what: 'how visible your pores are',
    focus: 'Oil and dead skin that sit in pores make them look larger, so the plan keeps them clear and balances oil.',
    region: (phrase) => `Pores look most visible ${phrase}`,
  },
  texture: { what: 'how smooth and even the skin surface looks', focus: 'Uneven texture usually comes from slow shedding of dead skin and dehydration, so gentle exfoliation and moisture help most.' },
  acne: { what: 'how many active blemishes the scan found', focus: 'Breakouts start in clogged pores, so the plan targets oil, clogging and calm skin, and avoids over-scrubbing.' },
  redness: { what: 'how much visible redness there is', focus: 'Redness often flares when the skin barrier is stressed, so the plan favours soothing, barrier-friendly steps and avoids harsh scrubs.' },
  oiliness: { what: 'how balanced your oil levels look (lower means more visible shine)', focus: 'Shine comes from active oil glands; light textures and oil-balancing ingredients help without stripping the skin.' },
  moisture: { what: 'how hydrated your skin looks', focus: 'Dehydrated skin looks dull and shows lines more, so the plan adds water-binding and barrier-repair steps.' },
  radiance: { what: 'how bright and luminous your skin looks', focus: 'Dullness comes from dead skin build-up, dehydration and uneven tone; antioxidants, gentle exfoliation and hydration help.' },
  firmness: { what: 'how firm and lifted the skin looks', focus: 'Firmness depends on collagen and elastin, which daily sunscreen protects and retinoids are best studied to support.' },
  age_spot: { what: 'how many spots and patches of uneven pigment there are', focus: 'Sun exposure darkens spots, so daily sunscreen does most of the work; tone-evening ingredients help fade them over months.' },
  dark_circle: { what: 'how dark the under-eye area looks', focus: 'Dark circles can come from pigment, thin skin or shadowing; skin care helps some causes more than others.' },
  eye_bag: { what: 'how puffy the under-eye area looks', focus: 'Puffiness changes with sleep, salt and allergies; skin care can only reduce it a little and temporarily.' },
  tear_trough: { what: 'how deep the groove under the eyes looks', focus: 'The tear trough is mostly about volume and structure, which skin care changes little.' },
  droopy_upper_eyelid: { what: 'how much the upper eyelid skin folds or droops', focus: 'Eyelid laxity is structural; skin care changes it very little.' },
  droopy_lower_eyelid: { what: 'how loose the lower eyelid skin looks', focus: 'Lower-lid laxity is structural; gentle firming care helps the skin surface only.' },
};

/**
 * Treatment ingredient classes.
 * fit:        concern -> strength of fit (0-1)
 * time:       'am' | 'pm' | 'either'
 * cost:       1 low, 2 mid, 3 higher (relative, no prices)
 * irritation: 0 low, 1 some, 2 often irritating at first
 * strong:     exfoliating or retinoid class: only one per evening, others alternate
 * pregnancy:  'avoid' (left out when pregnant or breastfeeding) | 'ask' (check first) | 'ok'
 */
export const INGREDIENTS = [
  {
    id: 'niacinamide', name: 'Niacinamide serum (4–5%)', className: 'Niacinamide',
    does: 'Helps balance oil, makes pores look smaller and supports the skin barrier.',
    fit: { pore: 1, oiliness: 1, redness: 0.6, acne: 0.6, age_spot: 0.5, texture: 0.4, radiance: 0.4 },
    time: 'either', cost: 1, irritation: 0, slot: 'treat', pregnancy: 'ok', cadence: 'Daily',
  },
  {
    id: 'salicylic_acid', name: 'Salicylic acid (BHA, 0.5–2%)', className: 'Salicylic acid',
    does: 'Oil-soluble exfoliant that clears inside pores.',
    fit: { acne: 1, pore: 0.9, oiliness: 0.7, texture: 0.6 },
    time: 'pm', cost: 1, irritation: 1, slot: 'treat', strong: true, pregnancy: 'avoid', cadence: '3 evenings a week',
    start: 'Start 2 evenings a week, then build up.',
  },
  {
    id: 'benzoyl_peroxide', name: 'Benzoyl peroxide wash (2.5–5%)', className: 'Benzoyl peroxide',
    does: 'Reduces acne-causing bacteria; used as a short-contact wash.',
    fit: { acne: 1 },
    time: 'am', cost: 1, irritation: 2, slot: 'cleanse', pregnancy: 'ask', cadence: 'Mornings, in place of your cleanser',
    caution: 'Can bleach towels and pillowcases. Leave on for a minute, then rinse.',
  },
  {
    id: 'azelaic_acid', name: 'Azelaic acid (10% over-the-counter)', className: 'Azelaic acid',
    does: 'Calms redness, helps with breakouts and fades marks.',
    fit: { redness: 1, acne: 0.8, age_spot: 0.8, texture: 0.4 },
    time: 'either', cost: 2, irritation: 1, slot: 'treat', pregnancy: 'ask', cadence: 'Daily once comfortable',
    start: 'Start every other day; a mild tingle is common at first.',
  },
  {
    id: 'retinoid', name: 'Retinoid (retinol 0.3–0.5%, retinal, or adapalene 0.1% where sold over the counter)', className: 'Retinoid',
    does: 'The best-studied ingredient class for lines, texture, tone and clogged pores.',
    fit: { wrinkle: 1, texture: 0.9, firmness: 0.8, age_spot: 0.7, acne: 0.7, pore: 0.6, radiance: 0.5 },
    time: 'pm', cost: 2, irritation: 2, slot: 'treat', strong: true, pregnancy: 'avoid', cadence: 'Every other evening',
    start: 'Start 2 evenings a week; build up over 4 to 6 weeks.',
    caution: 'Keep away from the lash line. Sunscreen every morning matters more while you use it.',
  },
  {
    id: 'retinol_gentle', name: 'Low-strength retinol (0.1–0.2%)', className: 'Gentle retinol',
    does: 'A gentler entry to retinoids for lines and texture.',
    fit: { wrinkle: 0.8, texture: 0.7, firmness: 0.6, age_spot: 0.5, radiance: 0.4 },
    time: 'pm', cost: 2, irritation: 1, slot: 'treat', strong: true, pregnancy: 'avoid', cadence: 'Every other evening',
    start: 'Start 2 evenings a week over moisturiser if your skin is reactive.',
  },
  {
    id: 'vitamin_c', name: 'Vitamin C serum (L-ascorbic acid 10–15% or a stable derivative)', className: 'Vitamin C',
    does: 'Antioxidant that brightens and backs up sunscreen against daylight damage.',
    fit: { radiance: 1, age_spot: 0.8, wrinkle: 0.4, firmness: 0.3 },
    time: 'am', cost: 2, irritation: 1, slot: 'treat', pregnancy: 'ok', cadence: 'Every morning',
  },
  {
    id: 'aha', name: 'Lactic or glycolic acid (AHA) exfoliant', className: 'AHA exfoliant',
    does: 'Surface exfoliant that smooths texture and brightens.',
    fit: { texture: 1, radiance: 0.8, age_spot: 0.5 },
    time: 'pm', cost: 1, irritation: 2, slot: 'treat', strong: true, pregnancy: 'ask', cadence: '1 to 2 evenings a week',
    caution: 'Lactic acid is the gentler choice if your skin is dry or reactive.',
  },
  {
    id: 'tranexamic_acid', name: 'Tranexamic acid serum (2–5%)', className: 'Tranexamic acid',
    does: 'Helps fade dark spots and uneven patches.',
    fit: { age_spot: 1, redness: 0.3 },
    time: 'either', cost: 2, irritation: 0, slot: 'treat', pregnancy: 'ask', cadence: 'Daily',
  },
  {
    id: 'alpha_arbutin', name: 'Alpha arbutin serum (1–2%)', className: 'Alpha arbutin',
    does: 'A gentle, low-cost option for fading dark spots.',
    fit: { age_spot: 0.9, radiance: 0.3 },
    time: 'either', cost: 1, irritation: 0, slot: 'treat', pregnancy: 'ask', cadence: 'Daily',
  },
  {
    id: 'hydrating_serum', name: 'Hyaluronic acid or glycerin hydrating serum', className: 'Humectant serum',
    does: 'Draws water into the skin so it looks plumper and smoother.',
    fit: { moisture: 1, texture: 0.4, radiance: 0.5, wrinkle: 0.2 },
    time: 'either', cost: 1, irritation: 0, slot: 'treat', pregnancy: 'ok', cadence: 'Daily, on damp skin',
  },
  {
    id: 'soothing_serum', name: 'Centella asiatica or panthenol soothing serum', className: 'Soothing serum',
    does: 'Calms visible redness and supports barrier repair.',
    fit: { redness: 0.9, moisture: 0.4 },
    time: 'either', cost: 1, irritation: 0, slot: 'treat', pregnancy: 'ok', cadence: 'Daily',
  },
  {
    id: 'peptides', name: 'Peptide serum', className: 'Peptides',
    does: 'Supports firmness and smoothness; evidence is more modest than for retinoids.',
    fit: { firmness: 0.8, wrinkle: 0.5 },
    time: 'either', cost: 3, irritation: 0, slot: 'treat', pregnancy: 'ok', cadence: 'Daily',
  },
  {
    id: 'caffeine_eye', name: 'Caffeine eye serum', className: 'Caffeine eye serum',
    does: 'Can briefly reduce puffiness and shadowing under the eyes.',
    fit: { eye_bag: 0.7, dark_circle: 0.5 },
    time: 'am', cost: 1, irritation: 0, slot: 'eye', pregnancy: 'ok', cadence: 'Every morning',
  },
  {
    id: 'eye_cream_firming', name: 'Peptide or gentle retinol eye cream', className: 'Firming eye cream',
    does: 'Supports the thin under-eye skin; changes are small and gradual.',
    fit: { tear_trough: 0.4, droopy_lower_eyelid: 0.4, droopy_upper_eyelid: 0.3, dark_circle: 0.4, wrinkle: 0.3 },
    time: 'pm', cost: 2, irritation: 0, slot: 'eye', pregnancy: 'ask', cadence: 'Every evening',
  },
];
export const INGREDIENT_BY_ID = Object.fromEntries(INGREDIENTS.map((i) => [i.id, i]));

/**
 * Base steps every routine has. `cites` lists the concerns that justify the
 * step; the plan cites the lowest-scoring of them that the scan measured.
 */
export const BASE = {
  cleanser_gel: { id: 'cleanser_gel', slot: 'cleanse', name: 'Gentle gel cleanser', does: 'Lifts oil, sweat and sunscreen without stripping.', cites: ['oiliness', 'acne', 'pore'] },
  cleanser_cream: { id: 'cleanser_cream', slot: 'cleanse', name: 'Cream or milk cleanser', does: 'Cleans without taking moisture with it.', cites: ['moisture', 'redness', 'texture'] },
  moisturiser_light: { id: 'moisturiser_light', slot: 'moisturise', name: 'Light gel moisturiser', does: 'Hydrates without adding shine or clogging pores.', cites: ['oiliness', 'pore', 'acne'] },
  moisturiser_barrier: { id: 'moisturiser_barrier', slot: 'moisturise', name: 'Ceramide moisturiser', does: 'Repairs the barrier and holds water in the skin.', cites: ['moisture', 'redness', 'texture'] },
  sunscreen: { id: 'sunscreen', slot: 'protect', name: 'Broad-spectrum sunscreen, SPF 30 or higher', does: 'Daylight drives spots, lines and redness; this is the step that protects every other result.', cites: ['age_spot', 'wrinkle', 'firmness', 'redness'] },
  sunscreen_mineral: { id: 'sunscreen_mineral', slot: 'protect', name: 'Mineral sunscreen (zinc oxide), SPF 30 or higher', does: 'Gentler UV filters for reactive skin; protects every other result.', cites: ['redness', 'age_spot', 'wrinkle'] },
  moisturising_spf: { id: 'moisturising_spf', slot: 'protect', name: 'Moisturising sunscreen, SPF 30 or higher', does: 'Moisturiser and sun protection in one step to save time.', cites: ['age_spot', 'wrinkle', 'moisture'] },
  sunscreen_tinted: { id: 'sunscreen_tinted', slot: 'protect', name: 'Tinted mineral sunscreen with iron oxides, SPF 30 or higher', does: 'Iron oxides in the tint also filter visible light, which can deepen spots and marks, and a matched tint avoids the white cast zinc can leave.', cites: ['age_spot', 'acne', 'redness', 'wrinkle'] },
  moisturising_spf_tinted: { id: 'moisturising_spf_tinted', slot: 'protect', name: 'Tinted moisturising sunscreen with iron oxides, SPF 30 or higher', does: 'Moisturiser, sun protection and visible-light filtering in one step to save time.', cites: ['age_spot', 'acne', 'moisture'] },
};

/** Sunscreen finish from measured oil balance and hydration (cosmetic texture only). */
export const FINISHES = {
  matte: 'Matte or gel-fluid finish',
  cream: 'Moisturising cream finish',
  lotion: 'Light lotion finish',
};

/**
 * Skin-tone context, keyed by the depth GlowPlan estimates (ITA°) from the colour
 * YouCam's Skin Tone Analysis measures. Neutral, widely accepted points only.
 */
export const TONE_NOTES = {
  pih: 'On medium-to-deep skin, breakouts and irritation more often leave dark marks that can last for months, so the plan favours gentle, tone-evening steps and daily sunscreen.',
  redness: 'On deeper skin, irritation can look brown or purple rather than red, so watch for darkening as well as redness.',
  burn: 'Lighter skin burns more easily: reapply sunscreen every 2 hours when you are outdoors.',
  procedures: 'Ask whether laser, IPL or peel settings suit your skin tone: on medium-to-deep skin some settings carry a higher risk of dark or light patches.',
};

/**
 * In-clinic treatment categories commonly offered for each concern.
 * threshold: below this ui_score, GlowPlan suggests considering a consultation.
 */
export const PROFESSIONAL = {
  acne: {
    threshold: 55,
    categories: [
      { name: 'Dermatologist assessment', what: 'Prescription creams or tablets when over-the-counter care is not enough.' },
      { name: 'Chemical peels', what: 'Clinic-strength salicylic or glycolic peels, usually as a course.' },
      { name: 'Light-based treatments', what: 'Blue-light or photodynamic therapy, offered by some clinics.' },
    ],
    redFlag: 'Painful, deep breakouts or breakouts that leave marks or scars are worth a dermatologist visit soon.',
  },
  pore: {
    threshold: 45,
    categories: [
      { name: 'Chemical peels', what: 'Exfoliating peels that clear and refine the skin surface.' },
      { name: 'Microneedling', what: 'Fine needles stimulate collagen around enlarged pores.' },
      { name: 'Fractional laser resurfacing', what: 'Laser treatment that resurfaces skin in small columns.' },
    ],
  },
  texture: {
    threshold: 50,
    categories: [
      { name: 'Chemical peels', what: 'Remove the outer layer of dead skin for a smoother surface.' },
      { name: 'Hydradermabrasion facials', what: 'Exfoliation combined with hydrating serums.' },
      { name: 'Microneedling or fractional laser', what: 'Collagen-stimulating treatments for rougher texture.' },
    ],
  },
  wrinkle: {
    threshold: 50,
    categories: [
      { name: 'Energy-based resurfacing', what: 'Fractional laser or radiofrequency microneedling for fine lines.' },
    ],
    byRegion: {
      forehead: { name: 'Neuromodulator injections', what: 'Relax the muscles behind expression lines on the forehead, between the brows and at the crow’s feet.' },
      glabellar: { name: 'Neuromodulator injections', what: 'Relax the muscles behind expression lines on the forehead, between the brows and at the crow’s feet.' },
      crowfeet: { name: 'Neuromodulator injections', what: 'Relax the muscles behind expression lines on the forehead, between the brows and at the crow’s feet.' },
      nasolabial: { name: 'Dermal fillers', what: 'Add volume to deeper folds such as smile lines and mouth corners.' },
      marionette: { name: 'Dermal fillers', what: 'Add volume to deeper folds such as smile lines and mouth corners.' },
      periocular: { name: 'Under-eye skin treatments', what: 'Gentle lasers or microneedling designed for the thin skin around the eyes.' },
    },
  },
  firmness: {
    threshold: 50,
    categories: [
      { name: 'Radiofrequency or ultrasound tightening', what: 'Heat-based treatments that stimulate collagen below the surface.' },
      { name: 'Microneedling with radiofrequency', what: 'Combines both approaches for firmness and texture.' },
    ],
  },
  age_spot: {
    threshold: 50,
    categories: [
      { name: 'Laser or IPL for pigmentation', what: 'Light-based treatments that target darker spots.' },
      { name: 'Chemical peels', what: 'Peels that help fade uneven pigment over a course.' },
      { name: 'Dermatologist review of spots', what: 'A check that each spot is harmless before cosmetic treatment.' },
    ],
    redFlag: 'Any spot or mole that is new, changing in size, shape or colour, itchy or bleeding needs a doctor or dermatologist promptly.',
  },
  redness: {
    threshold: 45,
    categories: [
      { name: 'Dermatologist assessment', what: 'Persistent facial redness has several possible causes worth having checked.' },
      { name: 'Vascular laser or IPL', what: 'Light-based treatments that target visible redness and small vessels.' },
    ],
    redFlag: 'Redness with burning, swelling or spreading, or that comes with eye irritation, is worth a doctor’s visit.',
  },
  moisture: {
    threshold: 35,
    categories: [
      { name: 'Hydrating facials', what: 'Professional hydradermabrasion or barrier-repair facials.' },
      { name: 'Dermatologist assessment', what: 'Worth it if dryness comes with persistent itching, flaking or rash.' },
    ],
  },
  oiliness: {
    threshold: 35,
    categories: [
      { name: 'Dermatologist assessment', what: 'Prescription options exist for very oily skin.' },
      { name: 'Chemical peels', what: 'Peels that help control shine and clogged pores.' },
    ],
  },
  radiance: {
    threshold: 40,
    categories: [
      { name: 'Chemical peels', what: 'Light peels that brighten a dull surface.' },
      { name: 'Hydradermabrasion facials', what: 'Exfoliation with hydration for an instant, short-lived glow.' },
    ],
  },
  dark_circle: {
    threshold: 45,
    categories: [
      { name: 'Aesthetic doctor or dermatologist assessment', what: 'Dark circles have different causes (pigment, thin skin, hollowness) and each is treated differently.' },
      { name: 'Laser or peels for pigment', what: 'For circles that are mainly pigment.' },
      { name: 'Tear-trough filler', what: 'For circles that are mainly shadow from hollowness.' },
    ],
  },
  tear_trough: {
    threshold: 45,
    categories: [
      { name: 'Tear-trough filler', what: 'Soft filler placed by an experienced injector to reduce the hollow.' },
      { name: 'Energy-based tightening', what: 'Radiofrequency or laser to firm the under-eye skin.' },
    ],
  },
  eye_bag: {
    threshold: 40,
    categories: [
      { name: 'Aesthetic consultation', what: 'To tell puffiness apart from structural bags.' },
      { name: 'Lower eyelid surgery consultation', what: 'Blepharoplasty is the surgical option for persistent bags.' },
    ],
  },
  droopy_upper_eyelid: {
    threshold: 40,
    categories: [
      { name: 'Oculoplastic or plastic surgeon consultation', what: 'Upper blepharoplasty is the surgical option for excess upper-lid skin.' },
    ],
    redFlag: 'An eyelid that droops suddenly or gets in the way of your vision needs a doctor’s visit.',
  },
  droopy_lower_eyelid: {
    threshold: 40,
    categories: [
      { name: 'Oculoplastic or plastic surgeon consultation', what: 'Lower-lid tightening or blepharoplasty are surgical options.' },
      { name: 'Energy-based tightening', what: 'Non-surgical firming for mild laxity.' },
    ],
  },
};

export const GENERAL_RED_FLAGS = [
  'Stop a new product if it burns, stings for long, or causes a rash. Get urgent care for swelling of the face, lips or eyes, or trouble breathing.',
  'A spot or mole that is new, changing, itchy or bleeding needs a doctor or dermatologist promptly, whatever this scan says.',
];

export const DISCLAIMER = 'GlowPlan gives cosmetic skin-care guidance based on an AI photo analysis. It is not medical advice, a diagnosis or a treatment plan. Lighting and photo quality affect scores. For any skin-health concern, see a doctor or dermatologist.';
