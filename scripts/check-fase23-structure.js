#!/usr/bin/env node
/**
 * Fase 2 y 3 · «¿Cómo quieres estructurar tu curso?» y la redistribución segura de los contenidos del documento.
 * Sin red ni base (USD 0).
 *   ST1 redistribución: cada contenido del documento en EXACTAMENTE un capítulo (ni se pierde ni se repite), en el orden
 *       del documento; con menos contenidos que capítulos, los que sobran son profundización (sin inventar contenido)
 *   ST2 documento 5 unidades (18 contenidos) → 3 × 4: 18/18, sin duplicados, todos los RA vinculados
 *   ST3 «Cursia recomienda» respeta lo que exige el documento; sin estructura obligatoria, sigue al documento o al
 *       formato S/M/L más cercano a las horas
 *   ST4 documento vs diseño: la diferencia se dice antes de aplicar («El documento establece 2 módulos y has
 *       seleccionado 4 módulos.»); un documento sin estructura obligatoria no genera diferencias (Fase 2.3)
 *   ST5 cobertura exacta por trazabilidad: cubierto / omitido (capítulo borrado) / duplicado / desactualizado
 *   ST6 Verificación: contenido omitido = crítico («Contenido no cubierto») con «Incluirlos en un capítulo»; todo
 *       cubierto = ok; mapa de otra versión = advertencia (y la comparación por términos de siempre)
 *   ST7 una forma personalizada es decisión de la institución (sus diferencias con el documento son SU excepción)
 *
 *   node scripts/check-fase23-structure.js   (requiere npm run build)
 */
const path = require('path');
const fs = require('fs');
const REPO = path.resolve(__dirname, '..');
const D = (p) => require(path.join(REPO, 'dist', p));
const E = D('modules/academic-context/extract/extractor.js');
const T = D('modules/academic-context/extract/text-sources.js');
const X = D('modules/academic-context/requirements/requirements-extractor.js');
const RA = D('modules/academic-context/requirements/requirement-authority.js');
const CD = D('modules/academic-context/context-design.js');
const CC = D('modules/academic-context/content-coverage.js');
const SO = D('modules/course-design/structure-options.js');
const DV = D('modules/course-design/design-verification.js');
const SA = D('modules/course-structure/structure-authority.js');
const AF = require(path.join(REPO, 'scripts/lib/academic-fixtures.js'));

let ok = 0;
let fail = 0;
async function check(name, fn) {
  try { await fn(); ok++; console.log(`✅ ${name}`); } catch (e) { fail++; console.log(`❌ ${name}\n   ${e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n   ') : e}`); }
}
const assert = (c, m) => { if (!c) throw new Error(m); };
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: esperado ${JSON.stringify(b)}, encontrado ${JSON.stringify(a)}`); };
const ctxOf = async (name, data) => (await E.extractAcademicContext([{ name, data }])).context;
const reqsOf = (buf, mt) => X.requirementsFor(X.extractRequirements(T.readText(buf, mt).lines), {}).filter((r) => r.obligation === 'required' && r.confidence === 'high');
const allIds = (ctx) => ctx.units.filter((u) => u.contents.length).flatMap((u) => u.contents.map((c) => c.id));
const assignedIds = (p) => p.modules.flatMap((m) => m.chapters.flatMap((c) => c.sourceContentIds));

(async () => {
  const PILOT = fs.readFileSync(path.join(REPO, 'scripts/fixtures/microcurriculum/atencion-violencia-sexual-2x2.docx'));
  const PILOT_TXT = fs.readFileSync(path.join(REPO, 'scripts/fixtures/microcurriculum/atencion-violencia-sexual-2x2.txt'));
  const pilot = await ctxOf('p.docx', PILOT);
  const costos = await ctxOf('c.docx', await AF.fixture('consistent', 'docx'));

  await check('ST1 redistribución: cada contenido en exactamente un capítulo, en orden; lo que sobra es profundización', () => {
    for (const [n, m] of [[3, 2], [1, 4], [2, 3], [4, 1], [2, 2]]) {
      const p = CD.proposeShapedStructureFromContext(pilot, { modules: n, chaptersPerModule: m });
      eq([p.modules.length, p.modules.every((x) => x.chapters.length === m)], [n, true], `forma ${n}×${m}`);
      const ids = assignedIds(p);
      eq(ids, allIds(pilot), `${n}×${m}: los 4 contenidos, una vez cada uno y en el orden del documento`);
      const extra = p.modules.flatMap((x) => x.chapters).filter((c) => !c.sourceContentIds.length);
      eq(extra.length, Math.max(0, n * m - 4), `${n}×${m}: capítulos sin contenido del documento`);
      assert(extra.every((c) => /^Profundización/.test(c.title)), 'los que sobran son profundización: ' + extra.map((c) => c.title).join(' | '));
    }
    const bad = CD.proposeShapedStructureFromContext(pilot, { modules: 0, chaptersPerModule: 2 });
    eq(bad.available, false, 'forma inválida');
  });

  await check('ST2 documento de 5 unidades (18 contenidos) → 3 × 4: 18/18, sin duplicados, 6/6 RA; un 4 × 5 también', () => {
    eq(CD.documentStructureShape(costos), [4, 4, 4, 3, 3], 'forma del documento');
    for (const [n, m] of [[3, 4], [4, 5], [2, 9]]) {
      const p = CD.proposeShapedStructureFromContext(costos, { modules: n, chaptersPerModule: m });
      const ids = assignedIds(p);
      eq([ids.length, new Set(ids).size], [18, 18], `${n}×${m}: sin pérdida ni duplicado`);
      eq(ids, allIds(costos), `${n}×${m}: en orden`);
      eq(p.counts.outcomesCovered, 6, `${n}×${m}: resultados`);
      assert(p.notes.some((t) => /ninguno se pierde ni se repite/.test(t)), 'nota de cobertura');
    }
  });

  await check('ST3 «Cursia recomienda»: lo que exige el documento; si no, su organización; si no, el formato más cercano', () => {
    const pilotReq = reqsOf(PILOT_TXT, 'text/plain');
    eq(SO.recommendShape(pilotReq, CD.documentStructureShape(pilot), 8), { modules: 2, chaptersPerModule: 2, reason: 'Es la estructura que exige el documento.' }, 'piloto');
    const r2 = SO.recommendShape([], [4, 4, 4, 3, 3], 64);
    eq([r2.modules, r2.chaptersPerModule], [5, 3], 'sin requisitos: un módulo por unidad, sin inventar capítulos (18 contenidos → 15 capítulos)');
    const sp = CD.proposeShapedStructureFromContext(costos, { modules: r2.modules, chaptersPerModule: r2.chaptersPerModule });
    assert(sp.modules.every((m) => m.chapters.every((c) => c.sourceContentIds.length > 0)), 'la forma recomendada no tiene capítulos vacíos');
    eq([SO.recommendShape([], null, 8).modules, SO.recommendShape([], null, 8).chaptersPerModule], [3, 3], '8 h → S');
    eq([SO.recommendShape([], null, 40).chaptersPerModule], [4], '40 h → M');
    eq([SO.recommendShape([], null, 64).modules, SO.recommendShape([], null, 64).chaptersPerModule], [4, 5], '64 h → L');
    const onlyMods = reqsOf(Buffer.from('El curso tendrá exactamente 5 módulos.'), 'text/plain');
    eq(SO.recommendShape(onlyMods, null, 40).modules, 5, 'lo que fija el documento se respeta');
  });

  await check('ST4 documento vs diseño: la diferencia se dice antes de aplicar; sin estructura obligatoria, ninguna', () => {
    const pilotReq = reqsOf(PILOT_TXT, 'text/plain');
    eq(SO.shapeDifferences(pilotReq, { modules: 2, chaptersPerModule: 2 }), [], '2 × 2 cumple');
    const d = SO.shapeDifferences(pilotReq, { modules: 4, chaptersPerModule: 2 }).map((x) => x.text);
    assert(d.includes('El documento establece 2 módulos y has seleccionado 4 módulos.'), JSON.stringify(d));
    assert(d.some((t) => /^El documento establece estructura 2 × 2 \(4 capítulos de contenido\) y has seleccionado 4 × 2\.$/.test(t)), JSON.stringify(d));
    const dc = SO.shapeDifferences(pilotReq, { modules: 2, chaptersPerModule: 3 }).map((x) => x.text);
    assert(dc.includes('El documento establece 2 capítulos de contenido por módulo y has seleccionado 3 capítulos de contenido por módulo.'), JSON.stringify(dc));
    const fm = SO.shapeDifferences(pilotReq, { modules: 3, chaptersPerModule: 4 }, 'M').map((x) => x.text);
    assert(fm.includes('El documento establece 8 horas y el Formato M es de 40–44 horas.'), JSON.stringify(fm));
    // Review I4: las horas respetan el modo del requisito («al menos 30 horas» con el Formato L se cumple).
    const atLeast = reqsOf(Buffer.from('Asignatura: Excel\nEl curso tendrá al menos 30 horas de trabajo del estudiante.'), 'text/plain');
    const hr = atLeast.filter((r) => r.kind === 'target_hours');
    assert(hr.length === 1 && hr[0].mode === 'min', 'requisito «al menos 30 horas»: ' + JSON.stringify(hr.map((r) => [r.mode, r.value])));
    eq(SO.shapeDifferences(atLeast, { modules: 4, chaptersPerModule: 5 }, 'L'), [], 'mínimo 30 h y Formato L (60–66 h): cumple');
    eq(SO.shapeDifferences(atLeast, { modules: 3, chaptersPerModule: 3 }, 'S').map((d) => d.text), ['El documento establece al menos 30 horas y el Formato S es de 20–22 horas.'], 'mínimo 30 h y Formato S: no cumple');
    // Fase 2.3: un documento sin estructura obligatoria (tema, resultados, horas) no genera excepciones.
    const noStruct = reqsOf(Buffer.from('Asignatura: Excel\nEl curso tendrá 40 horas de trabajo del estudiante.'), 'text/plain');
    eq(SO.shapeDifferences(noStruct, { modules: 2, chaptersPerModule: 5 }), [], 'sin estructura obligatoria');
  });

  await check('ST5 cobertura exacta: cubierto, omitido (capítulo borrado), duplicado y desactualizado', () => {
    const p = CD.proposeShapedStructureFromContext(costos, { modules: 3, chaptersPerModule: 4 });
    const chapters = {};
    p.modules.flatMap((m) => m.chapters).forEach((c, i) => { if (c.sourceContentIds.length) chapters['ch' + i] = c.sourceContentIds; });
    const map = { version: 1, contextVersion: 3, chapters, at: 't' };
    const liveAll = Object.keys(chapters);
    const full = CC.contentCoverage(costos, 3, map, liveAll);
    eq([full.available, full.stale, full.total, full.covered, full.omitted.length, full.duplicated.length], [true, false, 18, 18, 0, 0], 'todo cubierto');
    const removed = CC.contentCoverage(costos, 3, map, liveAll.filter((k) => k !== 'ch0'));
    eq([removed.covered, removed.omitted.length], [18 - chapters.ch0.length, chapters.ch0.length], 'un capítulo borrado deja sus contenidos sin cubrir');
    assert(removed.omitted.every((o) => o.text && o.unit), 'lo omitido dice qué es y de qué unidad');
    const dup = CC.contentCoverage(costos, 3, { ...map, chapters: { ...chapters, extra: [chapters.ch0[0]] } }, [...liveAll, 'extra']);
    eq(dup.duplicated.map((d) => d.chapters), [2], 'duplicado');
    eq(CC.contentCoverage(costos, 4, map, liveAll).stale, false, 'otra versión del contexto con los MISMOS contenidos: sigue vigente');
    const firstId = CC.documentContents(costos)[0].id;
    const fewer = JSON.parse(JSON.stringify(costos));
    fewer.units.find((u) => u.contents.some((c) => c.id === firstId)).contents = fewer.units.find((u) => u.contents.some((c) => c.id === firstId)).contents.filter((c) => c.id !== firstId);
    eq(CC.contentCoverage(fewer, 4, map, liveAll).stale, true, 'el documento cambió sus contenidos: desactualizado');
    eq(CC.contentMapIsStale(costos, map), false, 'mismos contenidos');
    eq(CC.contentCoverage(costos, 3, null, liveAll).available, false, 'sin trazabilidad');
    eq(CC.parseContentMap(JSON.stringify(map)).chapters.ch0, chapters.ch0, 'el mapa se lee de la base');
  });

  await check('ST6 Verificación: omitido = crítico «Contenido no cubierto» (Incluirlos); cubierto = ok; desactualizado = advertencia', () => {
    const base = {
      status: 'within_tolerance', targetHours: 40, estimatedHours: 40, toleranceHours: 2, baseHours: 30,
      counts: { modules: 3, chapters: 12, contentChapters: 12, practiceChapters: 0, videoChapters: 12, activities: 12, reviews: 0, applicationActivities: 0, applicationMinutes: 0, evaluations: 4 },
      manifestErrors: [], alignment: null, approach: { id: 'problemas', label: 'ABP' }, policyKind: 'application_first', audiovisual: null, pinnedChapters: [],
      cost: { min: 1, expected: 2, max: 3 }, preferences: { emphasis: 'balanced', applicationActivities: 'auto' }, autoLink: { chapterIds: [], outcomeIds: [], preview: [] },
      proposedChapterIds: [], uncoveredContents: ['Algo que no aparece'], requiredEvaluations: [], pinnedApplicationsOutsideMode: [], uncoveredEvaluations: [], requirementChecks: [], format: null,
    };
    const byId = (v, id) => v.checks.find((c) => c.id === id);
    const om = DV.verifyDesign({ ...base, contentCoverage: { available: true, stale: false, total: 18, covered: 16, omitted: [{ text: 'Hoja de costos', unit: 'U2' }, { text: 'Prorrateo', unit: 'U3' }], duplicated: [] } });
    const c1 = byId(om, 'contents');
    assert(c1 && c1.severity === 'critical' && /^Contenido no cubierto: 2 contenidos del documento no están en ningún capítulo$/.test(c1.title) && /«Hoja de costos», «Prorrateo»/.test(c1.detail), JSON.stringify(c1));
    eq(c1.fix, { kind: 'auto', action: 'cover_contents', label: 'Incluirlos en un capítulo' }, 'arreglo');
    assert(om.blocking === true || om.counts.critical > 0, 'bloquea');
    const okv = DV.verifyDesign({ ...base, contentCoverage: { available: true, stale: false, total: 18, covered: 18, omitted: [], duplicated: [] } });
    eq([byId(okv, 'contents').severity, byId(okv, 'contents').title], ['ok', 'Contenidos del documento: 18 de 18 en el diseño'], 'todo cubierto (la comparación por términos no se usa)');
    const st = DV.verifyDesign({ ...base, contentCoverage: { available: true, stale: true, total: 18, covered: 18, omitted: [], duplicated: [] } });
    eq([byId(st, 'contents_stale').severity, byId(st, 'contents').severity], ['warning', 'warning'], 'desactualizado: aviso + comparación por términos');
    const none = DV.verifyDesign({ ...base, contentCoverage: null });
    eq(byId(none, 'contents').severity, 'warning', 'sin trazabilidad: como siempre');
  });

  await check('ST7 forma personalizada = decisión de la institución; el origen guarda la elección', async () => {
    const parsed = SA.parseStructureOrigin({ source: 'academic_context', counter: 7, contextVersion: 2, at: 't', shape: [4, 4, 4], choice: 'custom' });
    eq(parsed.choice, 'custom', 'elección guardada');
    eq(SA.parseStructureOrigin({ source: 'academic_context', counter: 7, contextVersion: 2, at: 't', choice: 'raro' }).choice, undefined, 'elección inválida descartada');
    const fakeQ = (origin, counter, shape) => ({
      query: async (sql) => {
        if (/courseFormat/.test(sql)) return [{ f: null }];
        if (/structureOrigin/.test(sql)) return [{ o: origin }];
        if (/count\(c\.id\)/.test(sql)) return shape.map((n) => ({ n }));
        if (/structure_version_counter/.test(sql)) return [{ c: counter }];
        return [];
      },
    });
    eq(await RA.structureEditedByTeacher(fakeQ({ source: 'academic_context', counter: 7, contextVersion: 2, at: 't', shape: [4, 4, 4], choice: 'custom' }, 7, [4, 4, 4]), 1), true, 'personalizada');
    eq(await RA.structureEditedByTeacher(fakeQ({ source: 'academic_context', counter: 7, contextVersion: 2, at: 't', shape: [2, 2], choice: 'document' }, 7, [2, 2]), 1), false, 'según el documento (intacta)');
  });

  console.log(`\n${ok} OK · ${fail} fallas`);
  process.exit(fail ? 1 : 0);
})();
