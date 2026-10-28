#!/usr/bin/env node
/* eslint-disable no-console */
// r79 (F2 · condición 5) · Una sola fuente de precios: la estimación en seco («Cursia recomienda», «Ajustar al
// presupuesto») y la «Estimación de producción» (previewStart → FinopsBudgetService.evaluateStart) dan la MISMA cifra
// sobre los mismos cursos sintéticos (tolerancia ±2 %; en la práctica, idénticas).
//
//   SP1  la misma lectura del catálogo: FinopsBudgetService.catalog() = readPricingCatalog() (misma SQL, mismas filas)
//   SP2  S/M/L × 20/60/100 h: esperado / mínimo / máximo del dry-run = evaluateStart (±2 %) con el catálogo de la base
//   SP3  un precio que existe SOLO en la base (Gamma verificado por el SuperAdmin) mueve las dos cifras igual
//   SP4  FINOPS_ESTIMATE_MAX_RETRIES (política de reintentos del servidor) mueve las dos cifras igual
//   SP5  sin catálogo legible: el dry-run usa el seed y lo dice (pricingSource 'seed_fallback'); nunca se cae
//   SP6  el seed solo sigue siendo la lógica pura de siempre (sin `pricing`, la salida no cambia: goldens intactos)
//
// Uso: node scripts/check-r79-single-price-source.js [path/to/dist]
'use strict';
const path = require('path');
const distRoot = path.resolve(process.cwd(), process.argv.slice(2).find((a) => !a.startsWith('--')) || 'dist');
const P = require(path.join(distRoot, 'modules/pedagogy/index.js'));
const FB = require(path.join(distRoot, 'modules/finops/finops-budget.service.js'));
const PC = require(path.join(distRoot, 'modules/finops/pricing-catalog-db.js'));
const DP = require(path.join(distRoot, 'modules/finops/dry-run-pricing.js'));
const seedJson = require('../src/modules/finops/pricing-seed.v1.json');
const PF = require('./fixtures/pedagogy/profiles.json');

let passes = 0;
let failures = 0;
async function check(name, fn) {
  try { await fn(); passes++; console.log(`  ✅ ${name}`); } catch (err) { failures++; console.log(`  ❌ ${name}\n      ${err && err.message}`); }
}
function assert(c, msg) { if (!c) throw new Error(msg); }

// Filas como las devuelve Postgres (numeric::text, fechas Date).
const dbRows = (extra = []) => [...seedJson.rows, ...extra].map((r, i) => ({ id: `db-${i}`, ...r, unit_size: String(r.unit_size), unit_price: String(r.unit_price), effective_from: new Date(r.effective_from), effective_to: r.effective_to ? new Date(r.effective_to) : null }));
function fakeDb(rows) {
  const sqls = [];
  return {
    sqls,
    query: async (sql) => { sqls.push(sql.replace(/\s+/g, ' ').trim()); if (/from public\.pricing_catalog/.test(sql)) return rows; return []; },
  };
}
const TOPICS = ['Peligros', 'Riesgos', 'Controles', 'Protección', 'Incidentes', 'Emergencias', 'Indicadores', 'Cultura'];
const course = (mods, chs) => ({ course: { title: 'Curso sintético', finalExam: true, activityEngine: 'h5p' }, modules: Array.from({ length: mods }, (_, i) => ({ id: `m${i + 1}`, title: TOPICS[i], examEnabled: true, chapters: Array.from({ length: chs }, (_, j) => ({ id: `m${i + 1}c${j + 1}`, title: `${TOPICS[i]}: análisis ${j + 1}`, objective: 'Analizar riesgos' })) })) });
const profile = (h) => ({ pedagogyProfileVersion: 1, primaryApproach: PF.profiles.competencias.primaryApproach, secondaryApproaches: [], learner: PF.learner, learningOutcomes: PF.outcomes, learningModes: [], experienceTypes: [], assessmentMethods: [], principles: [], origin: 'manual', targetHours: h, designPreferences: { audiovisual: 'recommended' } });
const near = (a, b) => Math.abs(Number(a) - Number(b)) <= Math.max(0.02 * Math.abs(Number(b)), 1e-9);

async function compare(rows, label) {
  const db = fakeDb(rows);
  const pricing = await DP.loadDryRunPricing(db);
  assert(pricing.source === 'pricing_catalog', `${label}: pricingSource ${pricing.source}`);
  const svc = new FB.FinopsBudgetService(db, null);
  const out = [];
  for (const [mods, chs] of [[3, 2], [6, 1], [8, 2]]) {
    for (const h of [20, 60, 100]) {
      const dr = P.runPedagogyDryRun({ structure: course(mods, chs), profile: profile(h), activityTypeRules: 2, pricing });
      const man = dr.distribution;
      assert(man && man.materialized && man.materialized.providers.estimateUsd, `${label}: sin estimación ${mods}x${chs} ${h} h`);
      // El Manifest que se congelaría (materializado) es el que estima previewStart.
      const side = P.runPedagogyDryRun({ structure: P.materializeDistribution(P.snapshotFromStructure(course(mods, chs)), man), profile: null, activityTypeRules: 2, pricing }).baseline;
      const ev = await svc.evaluateStart({ courseId: 1, ownerId: '00000000-0000-4000-8000-000000000001', mode: 'real', items: side.manifest.items });
      const dry = side.providers.estimateUsd;
      for (const k of ['min', 'expected', 'max']) assert(near(dry[k], ev.estimate.totals[k]), `${label} ${mods}x${chs} ${h} h ${k}: seco ${dry[k]} vs producción ${ev.estimate.totals[k]}`);
      out.push({ k: `${mods}x${chs}/${h}`, dry: Number(dry.expected), prod: Number(ev.estimate.totals.expected), gamma: Number(dry.byProvider.gamma || 0) });
    }
  }
  return { out, db };
}

(async () => {
  console.log('r79 · una sola fuente de precios');
  await check('SP1 la misma lectura del catálogo (FinopsBudgetService.catalog = readPricingCatalog)', async () => {
    const a = fakeDb(dbRows());
    const b = fakeDb(dbRows());
    const r1 = await new FB.FinopsBudgetService(a, null).catalog();
    const r2 = await PC.readPricingCatalog(b);
    assert(a.sqls[0] === b.sqls[0], 'SQL distinta');
    assert(JSON.stringify(r1) === JSON.stringify(r2), 'filas distintas');
  });
  let base;
  await check('SP2 S/M/L × 20/60/100 h: el dry-run y evaluateStart coinciden (±2 %) con el catálogo de la base', async () => {
    base = await compare(dbRows(), 'base');
    console.log(`      ${base.out.map((x) => `${x.k} USD ${x.dry.toFixed(2)}/${x.prod.toFixed(2)}`).join(' · ')}`);
  });
  await check('SP3 un precio que existe solo en la base (Gamma verificado) mueve las dos cifras igual', async () => {
    const g = { provider: 'gamma', service: 'generations', product_or_model: 'gamma-generate', meter: 'gamma_credit', unit_size: '1', unit_price: '0.0040000000', currency: 'USD', pricing_version: 'gamma-superadmin-2026-10-27T00:00:00.000Z', effective_from: '2026-10-27T00:00:00Z', effective_to: null, source: 'contract', source_ref: '{"plan":"Pro","pricePaidUsd":20,"creditsIncluded":5000}', verified: true };
    const r = await compare(dbRows([g]), 'gamma');
    assert(r.out.every((x, i) => x.gamma < base.out[i].gamma && x.dry < base.out[i].dry), 'el precio de Gamma de la base no se usó');
    const cur = PC.currentGammaPrice(dbRows([g]));
    assert(cur && cur.verified && cur.plan === 'Pro' && cur.creditsIncluded === 5000 && !cur.provisional, JSON.stringify(cur));
    const unver = PC.currentGammaPrice(dbRows());
    assert(unver && unver.provisional === true, 'el placeholder del seed debe verse como provisional');
  });
  await check('SP4 FINOPS_ESTIMATE_MAX_RETRIES mueve las dos cifras igual', async () => {
    const prev = process.env.FINOPS_ESTIMATE_MAX_RETRIES;
    process.env.FINOPS_ESTIMATE_MAX_RETRIES = '3';
    try {
      const r = await compare(dbRows(), 'retries');
      assert(r.out.every((x, i) => x.dry >= base.out[i].dry - 1e-9), 'sin efecto esperado');
    } finally {
      if (prev === undefined) delete process.env.FINOPS_ESTIMATE_MAX_RETRIES; else process.env.FINOPS_ESTIMATE_MAX_RETRIES = prev;
    }
  });
  await check('SP5 sin catálogo legible: seed rotulado (seed_fallback), sin caerse', async () => {
    const broken = { query: async () => { throw Object.assign(new Error('relation "pricing_catalog" does not exist'), { code: '42P01' }); } };
    const p = await DP.loadDryRunPricing(broken);
    assert(p.source === 'seed_fallback' && p.catalog.length === seedJson.rows.length, p.source);
    const empty = await DP.loadDryRunPricing(fakeDb([]));
    assert(empty.source === 'seed_fallback', 'catálogo vacío');
    const dr = P.runPedagogyDryRun({ structure: course(3, 2), profile: profile(20), activityTypeRules: 2, pricing: p });
    assert(dr.distribution.materialized.providers.pricingSource === 'seed_fallback', 'no informa la fuente');
  });
  await check('SP6 sin `pricing` la salida es la de siempre (seed) y con el seed explícito el número es el mismo', async () => {
    const a = P.runPedagogyDryRun({ structure: course(6, 1), profile: profile(60), activityTypeRules: 2 }).distribution.materialized.providers;
    const b = P.runPedagogyDryRun({ structure: course(6, 1), profile: profile(60), activityTypeRules: 2, pricing: P.seedPricing() }).distribution.materialized.providers;
    assert(!('pricingSource' in a) && !('provisionalPricing' in a) && !('byItemType' in a), 'claves nuevas sin pricing');
    assert(a.estimateUsd.expected === b.estimateUsd.expected && a.estimateUsd.max === b.estimateUsd.max, 'el seed explícito difiere');
  });
  console.log(`\n${passes} OK, ${failures} fallidas`);
  if (failures) process.exit(1);
})();
