#!/usr/bin/env node
/* eslint-disable */
// Fase 3 · Contexto académico — exporta salidas REALES del backend compilado (dist/) como fixtures del harness del
// panel del frontend (cursia: src/js/__harness__/fixtures/academic-backend-v1.json). Sin red, sin DB, sin gasto.
//
//   extract / extractInconsistent   respuesta de POST …/academic-context/extract (microcurrículo de prueba en DOCX)
//   savedDto                        GET …/profiles/academic con ese contexto guardado (versión 1)
//   designPristine / designExisting respuesta de GET …/academic-context/design para el esqueleto 1×1 y para una
//                                   estructura existente (ids fijos del harness)
//
// Usage: node scripts/academic-export-fe-fixtures.js <frontend-repo>/src/js/__harness__/fixtures [path/to/dist]
const fs = require('fs');
const path = require('path');
const [outDir, distArg] = process.argv.slice(2);
if (!outDir) { console.error('Uso: node scripts/academic-export-fe-fixtures.js <dir de fixtures del frontend> [dist]'); process.exit(2); }
const dist = path.resolve(process.cwd(), distArg || 'dist');
const A = require(path.join(dist, 'modules/academic-context/index.js'));
const P = require(path.join(dist, 'modules/pedagogy/index.js'));
const F = require('./lib/academic-fixtures.js');

const EXISTING = [
  { id: 'a1b2c3d4-0000-4000-8000-0000000000c1', moduleId: 'a1b2c3d4-0000-4000-8000-0000000000a1', title: 'Punto de equilibrio', objective: null, description: null, outcomeIds: null },
  { id: 'a1b2c3d4-0000-4000-8000-0000000000c2', moduleId: 'a1b2c3d4-0000-4000-8000-0000000000a1', title: 'Costeo por órdenes de producción', objective: 'Aplicar la hoja de costos por orden', description: null, outcomeIds: ['RA3'] },
  { id: 'a1b2c3d4-0000-4000-8000-0000000000c3', moduleId: 'a1b2c3d4-0000-4000-8000-0000000000a1', title: 'Bienvenida al curso', objective: null, description: null, outcomeIds: null },
];
const PRISTINE = [{ id: 'a1b2c3d4-0000-4000-8000-0000000000c9', moduleId: 'a1b2c3d4-0000-4000-8000-0000000000a9', title: 'Nuevo capítulo', objective: null, description: null, outcomeIds: null }];

(async () => {
  const ex = async (variant) => {
    const r = await A.extractAcademicContext([{ name: 'microcurriculo-costos.docx', data: await F.fixture(variant, 'docx') }]);
    return { draft: r.context, validation: A.validateAcademicContext(r.context), notes: r.notes, stats: r.stats, saved: false };
  };
  const extract = await ex('consistent');
  const extractInconsistent = await ex('inconsistent');
  const ctx = extract.draft;
  const sha = A.academicContextSha256(ctx);
  const savedDto = { courseId: 42, kind: 'academic', version: 1, profile: ctx, sha256: sha, isDefault: false, createdAt: '2026-10-06T00:00:00.000Z', createdBy: 'u', warnings: [], defaultSource: null, academicValidation: A.validateAcademicContext(ctx) };
  const design = (chapters) => ({
    available: true, reason: null, contextVersion: 1, contextSha256: sha, validation: A.validateAcademicContext(ctx),
    profileSuggestion: A.suggestProfileFromContext(ctx, null),
    structureProposal: A.proposeStructureFromContext(ctx),
    outcomeLinks: A.suggestOutcomeLinks(ctx, chapters),
    providersCalled: 0,
  });
  // Fase 4: dry-run del curso con contexto (alineación del diseño actual y del propuesto) — estructura del microcurrículo
  // con un capítulo sin vínculos y las competencias sin vincular (hallazgos reales para el panel).
  const SNAP = require(path.join(dist, 'modules/course-blueprints/blueprint-snapshot.js'));
  const prop = A.proposeStructureFromContext(ctx);
  let n = 0;
  const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
  const mods = [];
  const chs = [];
  prop.modules.forEach((m, mi) => {
    const id = uuid();
    mods.push({ id, position: mi, title: m.title, objective: m.objective, description: m.description, exam_enabled: true });
    m.chapters.forEach((c, ci) => chs.push({ id: uuid(), module_id: id, position: ci, title: c.title, objective: c.objective, description: c.description, video_enabled: true, activity_enabled: true, ...(mi === 0 && ci === 3 ? {} : { outcome_ids: c.outcomeIds }) }));
  });
  const snap = SNAP.buildBlueprintSnapshotV2({ id: 42, title: 'Contabilidad de Costos', finalExam: true, activityEngine: 'h5p', academicContext: A.academicBlueprintContext(ctx) }, mods, chs);
  const prof = { ...A.suggestProfileFromContext(ctx, null).profile, primaryApproach: 'competencias', secondaryApproaches: [] };
  const dr = P.runPedagogyDryRun({ structure: snap, profile: prof, activityTypeRules: 2, alignment: { priorKnowledgeDeclared: true } });
  const dryRunAlignment = { alignment: dr.alignment, distribution: { status: dr.distribution.status, materialized: { alignment: dr.distribution.materialized.alignment } } };
  const out = { generatedFrom: 'cursia-backend scripts/academic-export-fe-fixtures.js', extract, extractInconsistent, savedDto, designPristine: design(PRISTINE), designExisting: design(EXISTING), existingChapters: EXISTING, dryRunAlignment };
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, 'academic-backend-v1.json');
  fs.writeFileSync(file, JSON.stringify(out, null, 1) + '\n');
  console.log(`✅ ${file} (${Math.round(fs.statSync(file).size / 1024)} KB)`);
})().catch((e) => { console.error(e); process.exit(1); });
