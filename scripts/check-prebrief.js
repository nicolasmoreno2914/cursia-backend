#!/usr/bin/env node
/* eslint-disable */
// Prebrief pedagógico (2026-10-08). USD 0, sin red ni DB (solo dist/ y fixtures sintéticos).
//   PB1 formatos S/M/L: catálogo, punto medio, prácticas fuera del N×M, una sola selección.
//   PB2 plausibilidad: plantilla / bibliografía / fragmento / párrafo / repetido requieren confirmación; los datos normales no.
//   PB3 modelo: formato, orígenes, excepción con motivo, requisitos, contexto de generación, sin costo.
//   PB4 COBERTURA DE LA HUELLA: cada entrada que cambia el curso generado cambia la huella; el costo y el orden de claves no.
//   PB5 determinismo: misma entrada → misma huella, mismo documento y mismos bytes de PDF.
//   PB6 preparación: críticos, cambios pendientes, diseño sin guardar, datos dudosos, motivo faltante, sin resultados,
//       contexto incompleto y español no neutro bloquean; el diseño limpio está listo.
//   PB7 documento: español neutro (Language QA = 0), sin costos ni proveedores, textos clave.
//   PB8 PDF: estados (borrador/listo/aprobado/invalidado), texto del documento presente en el PDF (paridad), paginación.
//   PB9 barrera de generación: requiresPrebrief (flujo del curso y DYNAMIC_PREBRIEF_REQUIRED_SINCE).
//   PB10 diferencias legibles entre versiones.
//   PB11 textos del backend (mensajes, sugerencias, errores) en español neutro: Language QA = 0 en src/.
//   PB12 CONSISTENCIA interfaz/PDF: el renderizador REAL del frontend (56-v2-prebrief.js) muestra exactamente los textos
//        del documento (los mismos que PB8 encuentra en el PDF). Requiere CURSIA_FRONTEND_REPO.
//   PB17 nivel y previos con rótulo y origen real; previos del documento. PB18 lo que Cursia no puede producir → excepción.
//   PB16 todo UPDATE … RETURNING de versiones usa returningRows ([filas, cantidad] con TypeORM).
//   PB15 el corte por fecha de creación usa el instante de Postgres (zona horaria del proceso irrelevante).
//   PB14 sin tablas del Prebrief, guardar tema/evaluación no aborta la transacción (to_regclass).
//   PB13 la barrera está CABLEADA: RunsService y PackagingService reciben PrebriefService (inyección de Nest); un PATCH
//        del curso no puede tocar las claves del Prebrief; la huella no depende de la redacción del código.
// Uso: node scripts/check-prebrief.js [path/to/dist]
'use strict';
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const DIST = path.resolve(process.argv[2] || path.join(REPO, 'dist'));
const D = (rel) => require(path.join(DIST, rel));
let ok = 0;
let fail = 0;
async function check(name, fn) {
  try { await fn(); ok++; console.log(`✅ ${name}`); } catch (e) { fail++; console.log(`❌ ${name}\n   ${String(e && e.stack || e).split('\n').slice(0, 5).join('\n   ')}`); }
}
const eq = (a, b, m) => { const x = JSON.stringify(a); const y = JSON.stringify(b); if (x !== y) throw new Error(`${m || ''}: esperado ${y}, encontrado ${x}`); };
const assert = (c, m) => { if (!c) throw new Error(m || 'falló'); };
const clone = (x) => JSON.parse(JSON.stringify(x));

const F = D('modules/prebrief/course-formats.js');
const PL = D('modules/prebrief/plausibility.js');
const M = D('modules/prebrief/prebrief-model.js');
const DOC = D('modules/prebrief/prebrief-document.js');
const RD = D('modules/prebrief/prebrief-readiness.js');
const PDF = D('modules/prebrief/prebrief-pdf.js');
const RA = D('modules/academic-context/requirements/requirement-authority.js');
const LQA = D('modules/language-qa/language-qa.js');
const RH = D('modules/dynamic-generation/run-hash.js');
const { fixture } = require(path.join(REPO, 'scripts/fixtures/prebrief-fixtures.js'));

const build = (inp) => M.buildPrebriefModel(inp, RA.actualText, RA.requirementText);
const shaOf = (inp) => M.prebriefModelSha(build(inp));
const META = (status, sha, extra = {}) => ({ status, version: status === 'draft' ? null : 2, date: status === 'draft' ? null : '2026-10-12T15:00:00.000Z', fingerprint: sha, approval: status === 'approved' ? { name: 'María Gómez', role: 'Coordinadora académica', at: '2026-10-13T15:42:00.000Z', email: null } : null, ...extra });
async function pdfText(buf) {
  const { PDFParse } = require('pdf-parse');
  const p = new PDFParse({ data: new Uint8Array(buf) });
  try { return (await p.getText()).text; } finally { await p.destroy().catch(() => {}); }
}
const norm = (s) => String(s).normalize('NFC').replace(/[«»"“”]/g, '').replace(/[‐-–—]/g, '-').replace(/\s+/g, ' ').trim().toLowerCase();

(async () => {
  await check('PB1 formatos S/M/L: catálogo comercial, punto medio, prácticas fuera del N×M, una sola selección', () => {
    eq(['S', 'M', 'L'].map((c) => { const d = F.COURSE_FORMATS[c]; return [d.modules, d.chaptersPerModule, d.hoursMin, d.hoursMax, d.targetHours]; }), [[3, 3, 20, 22, 21], [3, 4, 40, 44, 42], [4, 5, 60, 66, 63]], 'catálogo');
    const M_ = F.COURSE_FORMATS.M;
    const mods = [0, 1, 2].map(() => ({ chapters: [{ kind: 'content' }, { kind: 'content' }, { kind: 'content' }, { kind: 'content' }, { kind: 'practice' }] }));
    eq(F.formatFit(M_, mods, 42), { structureOk: true, hoursOk: true, contentShape: [4, 4, 4] }, 'las prácticas no cuentan');
    eq(F.formatFit(M_, mods.slice(0, 2), 45).structureOk, false, 'faltan módulos');
    eq(F.formatFit(M_, mods, 45).hoursOk, false, 'horas fuera de rango');
    eq(F.parseCourseFormat({ code: 'M', catalogVersion: 1 }).code, 'M', 'parse');
    eq(F.parseCourseFormat({ code: 'XL' }), null, 'código inválido');
    eq(F.parseCourseFormat(['S', 'M']), null, 'nunca varias a la vez');
    eq(F.formatSummary(M_), '3 módulos · 12 capítulos · 40–44 horas', 'resumen');
  });

  await check('PB2 plausibilidad: plantilla, bibliografía, fragmento, párrafo y repetidos requieren confirmación; lo normal pasa', () => {
    const pos = [
      ['outcome', 'INSTRUCCIÓN: Tomar ejemplos del sector productivo de la región.', 'template'],
      ['outcome', 'Pérez, J. (2019). Logística integral. Editorial Andina.', 'bibliography'],
      ['outcome', 'Unidad 1', 'fragment'],
      ['evaluation', 'Ver anexo', null],
      ['outcome', 'Escriba aquí el resultado de aprendizaje esperado del curso', 'template'],
      ['outcome', Array.from({ length: 80 }, (_, i) => `palabra${i}`).join(' '), 'too_long'],
      ['evaluation', 'Taller', 'fragment'],
    ];
    for (const [k, t, want] of pos) eq(PL.doubtOf(k, t), want, `${k}: ${t.slice(0, 40)}`);
    const negs = ['Analiza la cadena de suministro de una organización.', 'Diseña una propuesta de mejora de la operación logística.', 'Identifica los conceptos de emprendimiento e innovación en educación.'];
    for (const t of negs) eq(PL.doubtOf('outcome', t), null, t);
    eq(PL.doubtOf('evaluation', 'Estudio de caso'), null, 'evaluación corta válida');
    const inp = { outcomes: [{ id: 'RA1', text: negs[0], fromDocument: true }, { id: 'RA2', text: negs[0], fromDocument: true }, { id: 'RA3', text: pos[0][1], fromDocument: true }, { id: 'RA4', text: pos[0][1], fromDocument: false }], competencies: [], evaluations: [], objective: null, learner: null };
    const d = PL.doubtfulItems(inp, new Set());
    eq(d.map((x) => [x.id, x.reason]), [['RA2', 'duplicate'], ['RA3', 'template']], 'repetido + plantilla; lo escrito por el docente no se revisa');
    eq(PL.doubtfulItems(inp, new Set(d.map((x) => x.confirmKey))).length, 0, 'confirmados');
    assert(PL.confirmKeyOf('outcome', 'A b') === PL.confirmKeyOf('outcome', '  a   B '), 'clave insensible a espacios y mayúsculas');
  });

  const base = fixture({ format: 'M', doc4x5: true, reason: 'La institución prioriza una duración menor para el piloto.' });
  await check('PB3 modelo: formato M, orígenes, excepción con motivo, requisitos, contexto de generación, sin costo', () => {
    const m = build(base);
    eq([m.duration.format.code, m.duration.format.value, m.duration.targetHours.value, m.duration.targetHours.origin], ['M', 'Formato M', 42, 'format'], 'formato y horas');
    eq(m.structure.origin, 'format', 'estructura: configuración seleccionada');
    eq([m.structure.totals.modules, m.structure.totals.contentChapters, m.structure.totals.practiceChapters], [3, 12, 0], 'totales');
    eq(m.exceptions.map((e) => [e.requirementKey, e.requirementText, e.appliedText, e.reason]), [['structure|course', 'estructura 4 × 5 (20 capítulos)', '3 × 4 (12 capítulos)', 'La institución prioriza una duración menor para el piloto.']], 'excepción');
    eq(m.requirements.items.map((i) => [i.key, i.status]).sort(), [['evaluations|course|partial', 'met'], ['structure|course', 'exception'], ['videos|chapter|each', 'not_verifiable']].sort(), 'requisitos');
    eq(m.goals.outcomes.map((o) => o.origin), ['document', 'document', 'document', 'document'], 'resultados del documento');
    eq(m.pedagogy.approach.origin, 'cursia', 'enfoque recomendado');
    eq(Object.keys(m.generationContext).sort(), ['contexto', 'nivel', 'nombre', 'obj', 'pais', 'sector', 'tono'].sort(), 'contexto de generación (sin campos vacíos)');
    assert(!/USD|costo/i.test(JSON.stringify(m)), 'el modelo no tiene costo');
    assert(!m.observations.some((o) => /costo/i.test(o.text)), 'el check de costo no entra en las observaciones');
  });

  await check('PB4 cobertura de la huella: cada entrada que cambia el curso generado cambia la huella (y el costo no)', () => {
    const s0 = shaOf(base);
    const mut = [];
    for (const k of RH.CONTEXT_STRING_FIELDS) mut.push([`contexto.${k}`, (x) => { x.brief[k] = (x.brief[k] || '') + ' X'; }]);
    mut.push(['horas', (x) => { x.card.hours.target = 43; }]);
    mut.push(['título de un capítulo', (x) => { x.card.design.modules[0].chapters[0].title += ' (rev.)'; }]);
    mut.push(['video de un capítulo', (x) => { x.card.design.modules[1].chapters[2].videoEnabled = true; }]);
    mut.push(['Actividad de Aplicación', (x) => { x.card.design.modules[0].chapters[0].applicationMinutes = 45; }]);
    mut.push(['evaluación del módulo', (x) => { x.card.design.modules[2].examEnabled = false; }]);
    mut.push(['capítulo agregado', (x) => { x.card.design.modules[0].chapters.push({ ...x.card.design.modules[0].chapters[0], id: 'nuevo', title: 'Nuevo' }); }]);
    mut.push(['módulo quitado', (x) => { x.card.design.modules.pop(); }]);
    mut.push(['Blueprint (perfil/contexto académico/configuración)', (x) => { x.card.blueprintSha256 = 'c'.repeat(64); }]);
    mut.push(['formato', (x) => { x.format = { ...x.format, code: 'L' }; }]);
    mut.push(['sin formato', (x) => { x.format = null; }]);
    mut.push(['motivo de excepción', (x) => { x.exceptionReasons['structure|course'].reason += ' Otro motivo.'; }]);
    mut.push(['estado de un requisito', (x) => { x.card.requirements.checks[1].severity = 'critical'; }]);
    mut.push(['resultado de aprendizaje', (x) => { x.facts.outcomes.value[0].text += ' y la mejora'; }]);
    mut.push(['competencia', (x) => { x.facts.competencies.value[0] += ' X'; }]);
    mut.push(['enfoque', (x) => { x.card.approach = { ...x.card.approach, id: 'casos', label: 'Aprendizaje basado en casos', source: 'adjusted' }; }]);
    mut.push(['alternativa elegida', (x) => { x.card.requirements.alternatives = [{ groupId: 'g', label: 'Tamaño', options: [{ id: 'm', label: 'M' }, { id: 'l', label: 'L' }], selected: 'l' }]; }]);
    mut.push(['estudiante', (x) => { x.facts.learnerDescription.value += ' X'; }]);
    mut.push(['recursos', (x) => { x.card.manifestTotals.audiobookChapterCount = 0; }]);
    mut.push(['decisión audiovisual', (x) => { x.card.requirements.authority.decisions.audiovisual = 'less'; }]);
    mut.push(['institución', (x) => { x.course.institutionName = 'Otra institución'; }]);
    mut.push(['perfil de evaluación (nota, intentos, ponderaciones)', (x) => { x.profiles.assessment.sha256 = 'e'.repeat(64); }]);
    mut.push(['perfil de presentación (tema)', (x) => { x.profiles.presentation.sha256 = 'q'.repeat(64); }]);
    mut.push(['paleta del curso (sin perfil de presentación)', (x) => { x.profiles.paletteId = 'paleta-otra'; }]);
    mut.push(['valor de un requisito (misma redacción)', (x) => { x.card.requirements.items[0].shape = [6, 6, 6, 6]; }]);
    mut.push(['decisión audiovisual (código)', (x) => { x.card.requirements.authority.decisions.audiovisual = 'more'; }]);
    const same = [];
    for (const [label, f] of mut) { const x = clone({ ...base, alignContext: undefined }); x.alignContext = base.alignContext; f(x); if (shaOf(x) === s0) same.push(label); }
    eq(same, [], 'entradas que NO cambiaron la huella');
    // El costo, la fecha y el orden de las claves no la cambian.
    const y = clone({ ...base, alignContext: undefined }); y.alignContext = base.alignContext;
    y.card.cost = { min: 1, expected: 99, max: 999 };
    y.card.verification.checks.find((c) => c.area === 'cost').title = 'Costo estimado de generar ≈ USD 99';
    eq(shaOf(y), s0, 'costo');
    const z = clone({ ...base, alignContext: undefined }); z.alignContext = base.alignContext;
    z.brief = Object.fromEntries(Object.entries(z.brief).reverse());
    eq(shaOf(z), s0, 'orden de claves');
    // El contexto de generación cubre EXACTAMENTE los campos de texto que congela el run (run-hash).
    eq([...D('modules/prebrief/prebrief-context.js').PREBRIEF_CONTEXT_FIELDS], [...RH.CONTEXT_STRING_FIELDS], 'campos del contexto');
  });

  await check('PB5 determinismo: misma entrada → misma huella, mismo documento y mismos bytes de PDF', async () => {
    const shas = new Set();
    for (let i = 0; i < 100; i++) shas.add(shaOf(base));
    eq(shas.size, 1, 'huella');
    const d1 = DOC.buildPrebriefDocument(build(base));
    const d2 = DOC.buildPrebriefDocument(build(base));
    eq(DOC.documentSha(d1), DOC.documentSha(d2), 'documento');
    const s = shaOf(base);
    const a = await PDF.renderPrebriefPdf(d1, META('approved', s));
    const b = await PDF.renderPrebriefPdf(d2, META('approved', s));
    assert(a.pdf.equals(b.pdf), 'PDF con los mismos bytes');
  });

  await check('PB6 preparación: cada bloqueo se detecta; el diseño limpio está listo', () => {
    const ready = (o) => { const inp = fixture(o); const m = build(inp); const doubts = PL.doubtfulItems({ outcomes: m.goals.outcomes.map((x) => ({ id: x.id, text: x.text, fromDocument: x.origin === 'document' })), competencies: [], evaluations: [], objective: m.goals.generalObjective ? { text: m.goals.generalObjective.value, fromDocument: m.goals.generalObjective.origin === 'document' } : null, learner: null }, new Set()); return RD.prebriefReadiness(m, inp.card, doubts, []); };
    const r0 = ready({ format: 'M', doc4x5: true, reason: 'La institución prioriza una duración menor para el piloto.' });
    eq([r0.ready, r0.blockers.map((b) => b.code)], [true, []], 'limpio');
    const codes = (o) => ready(o).blockers.map((b) => b.code);
    assert(codes({ format: 'M', doc4x5: true }).includes('exception_reason'), 'motivo faltante');
    assert(codes({ critical: true }).includes('critical'), 'crítico');
    assert(codes({ pending: true }).includes('pending_changes'), 'cambios pendientes');
    assert(codes({ profileChanged: true }).includes('design_not_saved'), 'diseño sin guardar');
    assert(codes({ noOutcomes: true }).includes('no_outcomes'), 'sin resultados');
    assert(codes({ doc4x5: true, templateObjective: true, format: 'M', reason: 'La institución prioriza una duración menor.' }).includes('doubtful_data'), 'objetivo de plantilla');
    assert(codes({ applicable: false }).includes('design_not_applicable'), 'no aplicable');
    const inp = fixture({}); delete inp.brief.tono; const m = build(inp);
    assert(RD.prebriefReadiness(m, inp.card, [], []).blockers.some((b) => b.code === 'context_incomplete'), 'contexto incompleto');
    assert(RD.prebriefReadiness(build(fixture({})), fixture({}).card, [], ['voseo «podés»']).blockers.some((b) => b.code === 'language'), 'español no neutro');
  });

  const CASES = {
    simple: {},
    formato_m: { format: 'M' },
    requisitos: { doc4x5: true, shape: [5, 5, 5, 5] },
    excepcion: { format: 'M', doc4x5: true, reason: 'La institución prioriza una duración menor para el piloto.' },
    muchos_modulos: { shape: [5, 5, 5, 5, 5, 5], practice: true },
    nombre_largo: { longName: true, format: 'L', shape: [5, 5, 5, 5] },
    resultados_largos: { longOutcomes: true, longTitles: true },
    observaciones: { warning: true, format: 'S', shape: [3, 3] },
  };
  await check('PB7 documento: español neutro (Language QA = 0), sin costo ni proveedores, textos clave', () => {
    for (const [name, o] of Object.entries(CASES)) {
      const d = DOC.buildPrebriefDocument(build(fixture(o)));
      const texts = DOC.documentTexts(d);
      const hits = texts.flatMap((t) => LQA.lqaFindings(t).map((h) => `${LQA.lqaHitLabel(h)} «${t.slice(0, 60)}»`));
      eq(hits, [], `${name}: Language QA`);
      const all = texts.join('\n');
      assert(!/USD|\bcosto\b|Gamma|Videogen|OpenAI|Anthropic|HeyGen|Blueprint|Manifest|\bpins?\b/i.test(all), `${name}: sin costos, proveedores ni términos internos`);
      for (const s of ['Información general', 'Público objetivo', 'Objetivo general', 'Enfoque pedagógico', 'Metodología', 'Duración y estructura', 'Estrategia de evaluación', 'Recursos previstos', 'Requisitos institucionales y cumplimiento', 'Decisiones de la institución', 'Excepciones al documento', 'Observaciones', 'Aprobación']) {
        assert(texts.some((t) => t.endsWith(s)), `${name}: sección «${s}»`);
      }
    }
    const ex = DOC.documentTexts(DOC.buildPrebriefDocument(build(fixture(CASES.excepcion)))).join('\n');
    for (const s of ['Formato M', 'Configuración seleccionada', 'Requisito del documento', 'Excepción al requisito del documento', 'La institución prioriza una duración menor para el piloto.', 'Estructura 4 × 5 (20 capítulos)', '3 × 4 (12 capítulos)', 'No verificable']) assert(ex.includes(s), `excepción: «${s}»`);
    for (const t of Object.values(DOC.approvalStateTexts(META('approved', 'a'.repeat(64))))) assert(LQA.lqaFindings(t).length === 0, t);
  });

  await check('PB8 PDF: estados, paginación y PARIDAD (todo el texto del documento está en el PDF)', async () => {
    for (const [name, o] of Object.entries(CASES)) {
      const m = build(fixture(o));
      const d = DOC.buildPrebriefDocument(m);
      const sha = M.prebriefModelSha(m);
      for (const st of ['draft', 'ready', 'approved', 'invalidated']) {
        const r = await PDF.renderPrebriefPdf(d, META(st, sha));
        assert(r.pdf.slice(0, 5).toString() === '%PDF-' && r.pages >= 4, `${name}/${st}: PDF válido (${r.pages} páginas)`);
        const txt = norm(await pdfText(r.pdf));
        const want = { draft: 'borrador', ready: 'pendiente de aprobación', approved: 'aprobado', invalidated: 'versión invalidada' }[st];
        assert(txt.includes(want), `${name}/${st}: «${want}»`);
        if (st === 'approved') for (const s of ['aprobado por: maría gómez', 'cargo: coordinadora académica', 'versión 2']) assert(txt.includes(s), `${name}: «${s}»`);
        assert(new RegExp(`página ${r.pages} de ${r.pages}`).test(txt), `${name}/${st}: numeración «Página x de y»`);
        if (st === 'ready') {
          // Paridad: cada texto del documento aparece en el PDF (normalizado; los saltos de línea del PDF no importan).
          const flat = txt.replace(/\s+/g, '');
          const missing = DOC.documentTexts(d).map(norm).filter((t) => t && !flat.includes(t.replace(/\s+/g, '')));
          eq(missing.slice(0, 5), [], `${name}: textos del documento ausentes del PDF`);
        }
      }
    }
  });

  await check('PB9 barrera: requiresPrebrief por flujo del curso o por DYNAMIC_PREBRIEF_REQUIRED_SINCE; fecha inválida → 503', async () => {
    const { PrebriefService } = D('modules/prebrief/prebrief.service.js');
    const svc = Object.create(PrebriefService.prototype);
    const q = (meta, createdAt, hasVersion = false) => ({ query: async (sql) => (/course_prebrief_versions/.test(sql) ? (hasVersion ? [{ x: 1 }] : []) : [{ metadata: meta, created_ms: createdAt ? new Date(createdAt).getTime() : null }]) });
    const prev = process.env.DYNAMIC_PREBRIEF_REQUIRED_SINCE;
    try {
      delete process.env.DYNAMIC_PREBRIEF_REQUIRED_SINCE;
      eq(await svc.requiresPrebrief(q({}, '2026-10-09T00:00:00Z'), 1), false, 'sin flujo ni fecha');
      eq(await svc.requiresPrebrief(q({ approvalFlow: 'prebrief' }, '2020-01-01T00:00:00Z'), 1), true, 'curso que ya entró al flujo');
      eq(await svc.requiresPrebrief(q({}, '2020-01-01T00:00:00Z', true), 1), true, 'una versión preparada prueba el flujo aunque se borre la marca (review BE-1 C1)');
      process.env.DYNAMIC_PREBRIEF_REQUIRED_SINCE = '2026-10-08T05:00:00Z';
      eq(await svc.requiresPrebrief(q({}, '2026-10-08T06:00:00Z'), 1), true, 'curso nuevo');
      eq(await svc.requiresPrebrief(q({}, '2026-10-07T23:00:00Z'), 1), false, 'curso existente');
      process.env.DYNAMIC_PREBRIEF_REQUIRED_SINCE = 'mañana';
      let err = null; try { await svc.requiresPrebrief(q({}, '2026-10-08T06:00:00Z'), 1); } catch (e) { err = e; }
      assert(err && err.getStatus && err.getStatus() === 503, 'fecha inválida → 503 (falla cerrada)');
    } finally {
      if (prev === undefined) delete process.env.DYNAMIC_PREBRIEF_REQUIRED_SINCE; else process.env.DYNAMIC_PREBRIEF_REQUIRED_SINCE = prev;
    }
  });

  await check('PB10 diferencias legibles entre versiones', () => {
    const a = build(base);
    const x = clone({ ...base, alignContext: undefined }); x.alignContext = base.alignContext;
    x.card.hours.target = 44; x.brief.tono = 'Formal'; x.card.design.modules[0].chapters.pop();
    const d = M.diffModels(a, build(x));
    assert(d.some((l) => /^Horas: 42 h → 44 h/.test(l)), JSON.stringify(d));
    assert(d.some((l) => /^Estructura: 3 módulos \(4, 4, 4 capítulos\) → 3 módulos \(3, 4, 4 capítulos\)/.test(l)), JSON.stringify(d));
    assert(d.some((l) => /Datos del curso para producir: tono/.test(l)), JSON.stringify(d));
    eq(M.diffModels(a, build(base)), [], 'sin cambios');
  });

  await check('PB11 textos del backend en español neutro: ningún mensaje, sugerencia o error con voseo, «vosotros» o regionalismos', () => {
    const fs = require('fs');
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.ts') ? [path.join(d, e.name)] : []));
    // Listas internas de detectores (palabras que se buscan, no texto que se muestra) y el propio módulo de Language QA.
    const SKIP = [/language-qa[\/]/, /course-shell[\/]exam-bank\.ts$/];
    const hits = [];
    for (const f of walk(path.join(REPO, 'src')).filter((x) => !SKIP.some((re) => re.test(x)))) {
      fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
        for (const lit of line.replace(/\/\/.*$/, '').match(/(['"`])((?:\\.|(?!\1).)*)\1/g) || []) {
          const t = lit.slice(1, -1);
          if (/NUNCA|vosotros\/vuestro|tú o ustedes|NEUTRO/.test(t)) continue; // reglas que nombran lo prohibido
          for (const h of LQA.lqaFindings(t)) hits.push(`${path.relative(REPO, f)}:${i + 1} ${LQA.lqaHitLabel(h)}`);
        }
      });
    }
    eq(hits, [], 'textos no neutros en el backend');
  });

  await check('PB12 consistencia interfaz/PDF: el renderizador del frontend muestra los mismos textos que el PDF', async () => {
    const fs = require('fs');
    const vm = require('vm');
    const fe = process.env.CURSIA_FRONTEND_REPO;
    const file = fe && path.join(fe, 'src/js/56-v2-prebrief.js');
    if (!file || !fs.existsSync(file)) throw new Error('CURSIA_FRONTEND_REPO no apunta al frontend (con src/js/56-v2-prebrief.js)');
    const ctx = { window: {}, console };
    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(file, 'utf8'), ctx);
    const decode = (h) => h.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    for (const [name, o] of Object.entries(CASES)) {
      const m = build(fixture(o));
      const d = DOC.buildPrebriefDocument(m);
      const sha = M.prebriefModelSha(m);
      const ui = norm(decode(ctx.v2pDocumentHTML(d, null))).replace(/\s+/g, '');
      const missingUi = DOC.documentTexts(d).map(norm).filter((t) => t && !ui.includes(t.replace(/\s+/g, '')));
      eq(missingUi.slice(0, 5), [], `${name}: textos del documento ausentes de la interfaz`);
      // Las mismas cifras clave en la interfaz y en el PDF (formato, módulos·capítulos, horas).
      const pdf = norm(await pdfText((await PDF.renderPrebriefPdf(d, META('ready', sha))).pdf)).replace(/\s+/g, '');
      for (const key of [`${m.structure.totals.modules}·${m.structure.totals.chapters}`, ...(m.duration.format ? [norm(`Formato ${m.duration.format.code}`).replace(/\s+/g, '')] : []), ...(m.duration.targetHours ? [norm(`${String(m.duration.targetHours.value).replace('.', ',')} horas`).replace(/\s+/g, '')] : [])]) {
        assert(ui.includes(key) && pdf.includes(key), `${name}: «${key}» en interfaz y PDF`);
      }
      // Bloque de estado: los textos que da el servidor (approvalStateTexts) se pintan tal cual en la interfaz.
      const st = DOC.approvalStateTexts(META('approved', sha));
      ctx.V2P.data = { draft: { stateTexts: st } };
      const box = norm(decode(ctx.v2pDocumentHTML(d, { status: 'approved', stateTexts: st }))).replace(/\s+/g, '');
      for (const t of st) assert(box.includes(norm(t).replace(/\s+/g, '')), `${name}: estado «${t}» en la interfaz`);
    }
  });

  await check('PB13 barrera cableada: RunsService y PackagingService reciben PrebriefService; claves protegidas; huella sin redacción', () => {
    require('reflect-metadata');
    const { PrebriefService } = D('modules/prebrief/prebrief.service.js');
    for (const [rel, cls] of [['modules/dynamic-generation/runs.service.js', 'RunsService'], ['modules/dynamic-packaging/packaging.service.js', 'PackagingService']]) {
      const C = D(rel)[cls];
      const types = Reflect.getMetadata('design:paramtypes', C) || [];
      assert(types.includes(PrebriefService), `${cls} no recibe PrebriefService`);
    }
    const fs = require('fs');
    const src = fs.readFileSync(path.join(REPO, 'src/modules/courses/courses.service.ts'), 'utf8');
    assert(/\.\.\.PREBRIEF_METADATA_KEYS/.test(src), 'CoursesService.update no protege las claves del Prebrief');
    eq([...D('modules/prebrief/prebrief-keys.js').PREBRIEF_METADATA_KEYS].sort(), ['approvalFlow', 'courseFormat', 'prebriefConfirmations', 'requirementExceptionReasons'], 'claves');
    // Cambiar SOLO la redacción (títulos, directivas, etiquetas) no cambia la huella; cambiar un dato sí.
    const m = build(base);
    const m2 = JSON.parse(JSON.stringify(m));
    m2.pedagogy.cycle = ['otra redacción']; m2.observations = m2.observations.map((o) => ({ ...o, text: o.text + ' (otra redacción)' }));
    m2.requirements.items = m2.requirements.items.map((i) => ({ ...i, text: i.text + ' x' })); m2.decisions = m2.decisions.map((d) => ({ ...d, label: d.label + ' x' }));
    eq(M.prebriefModelSha(m2), M.prebriefModelSha(m), 'redacción');
    const m3 = JSON.parse(JSON.stringify(m)); m3.requirements.items[0].status = 'conflict';
    assert(M.prebriefModelSha(m3) !== M.prebriefModelSha(m), 'el estado de un requisito sí cambia la huella');
  });

  await check('PB14 sin tablas del Prebrief (producción): el bloqueo de perfiles no consulta tablas inexistentes dentro de la transacción', () => {
    // Un 42P01 dentro de la transacción la aborta (25P02 en la consulta siguiente) aunque el código lo atrape: la
    // consulta a course_prebrief_events solo corre si to_regclass confirma que la tabla existe.
    const src = require('fs').readFileSync(path.join(REPO, 'src/modules/course-profiles/course-profiles.service.ts'), 'utf8');
    const i = src.indexOf('course_prebrief_events e on');
    assert(i > 0, 'no se encontró la consulta del bloqueo');
    const before = src.slice(Math.max(0, i - 1200), i);
    assert(/to_regclass\('public\.course_prebrief_events'\)/.test(before), 'falta la comprobación to_regclass antes de la consulta');
    assert(/if \(prebriefTables\?\.present\)/.test(before), 'la consulta no depende de to_regclass');
    assert(!/42P01/.test(src.slice(i, i + 600)), 'la consulta del bloqueo no debe atrapar 42P01 dentro de la transacción');
  });

  await check('PB15 el corte DYNAMIC_PREBRIEF_REQUIRED_SINCE compara el instante real (Postgres), no la lectura del driver en la zona de Node', () => {
    // courses.created_at es `timestamp` sin zona: el driver lo lee en la zona horaria del proceso (en staging, 2 h antes)
    // y un curso nuevo parecía anterior al corte. El instante sale de Postgres con la zona de la sesión que lo escribió.
    const src = require('fs').readFileSync(path.join(REPO, 'src/modules/prebrief/prebrief.service.ts'), 'utf8');
    assert(/extract\(epoch from created_at::timestamptz\)/.test(src), 'metadata() debe calcular el instante con created_at::timestamptz');
    assert(/m\.__createdAtMs >= t/.test(src), 'requiresPrebrief debe comparar el instante en milisegundos');
    assert(!/new Date\(m\.__createdAt\)/.test(src), 'no se debe convertir created_at en Node');
  });

  await check('PB16 UPDATE … RETURNING de las versiones pasa por returningRows (TypeORM devuelve [filas, cantidad])', () => {
    const src = require('fs').readFileSync(path.join(REPO, 'src/modules/prebrief/prebrief.service.ts'), 'utf8');
    const ups = [...src.matchAll(/update public\.course_prebrief_versions[\s\S]*?returning/g)];
    assert(ups.length >= 5, 'se esperaban los UPDATE … RETURNING de las versiones');
    for (const m of ups) {
      const before = src.slice(Math.max(0, m.index - 120), m.index);
      assert(/returningRows\(await (this\.dataSource|qr)\.query\(\s*`?$/.test(before.trimEnd().replace(/`$/, '') + '`') || /returningRows\(await (this\.dataSource|qr)\.query\(/.test(before), `UPDATE sin returningRows: …${before.slice(-80)}`);
    }
  });

  await check('PB17 público objetivo para personas: nivel y conocimientos previos con rótulo y origen real (nunca un código ni un valor de partida como «decisión»)', () => {
    const m = build(fixture({ doc4x5: true }));
    const lvl = m.course.level;
    eq([lvl.value, lvl.origin], ['Técnico / tecnológico', 'document'], 'nivel: rótulo y origen del documento');
    eq([m.learner.priorKnowledge.value, m.learner.priorKnowledge.origin], ['Conoce lo esencial del tema', 'cursia'], 'previos: rótulo y origen Cursia (inferido)');
    eq(m.learner.prerequisites && m.learner.prerequisites.value, 'Contabilidad básica; Manejo de hoja de cálculo', 'previos del documento');
    const texts = D('modules/prebrief/prebrief-document.js').documentTexts(D('modules/prebrief/prebrief-document.js').buildPrebriefDocument(m));
    assert(!texts.some((t) => /^(none|basic|intermediate|advanced|technical|university|secondary|professional)$/.test(t)), 'ningún código interno en el documento');
    assert(texts.includes('Conocimientos previos que pide el documento'), 'fila de previos del documento');
  });

  await check('PB18 requisito que Cursia no puede producir (2 videos por capítulo) → excepción con motivo pendiente, no un crítico sin salida', () => {
    const inp = fixture({ doc4x5: true });
    const card = inp.card;
    card.requirements.items.push({ id: 'RQV', key: 'videos@chapter', kind: 'videos', value: 2, mode: 'exact', scope: { level: 'chapter', each: true }, applies: true, obligation: 'required', confidence: 'high', source: { quote: 'Cada capítulo debe incluir 2 videos.', page: null } });
    card.requirements.checks.push({ requirementId: 'RQV', status: 'not_verifiable', actual: {}, chosenBy: 'cursia', note: 'Cursia produce un video por capítulo: no puede cumplir más de uno por capítulo todavía.', impossible: true });
    const RAx = D('modules/academic-context/requirements/requirement-authority.js');
    const v = RAx.requirementVerificationChecks([card.requirements.items.find((r) => r.id === 'RQV')], [card.requirements.checks.find((c) => c.requirementId === 'RQV')], { status: 'within_tolerance', baseHours: 40, estimatedHours: 42, modules: 3, moduleExams: 3, exceptionFields: {} });
    eq(v[0].severity, 'warning', 'advertencia (excepción), no crítico');
    card.verification.checks.push(v[0]);
    const m = M.buildPrebriefModel(inp, RA.actualText, RA.requirementText);
    const ex = m.exceptions.find((e) => e.requirementKey === 'videos@chapter');
    assert(ex, 'figura en «Excepciones al documento»');
    eq([ex.reason, ex.appliedText], [null, 'Cursia produce un video por capítulo'], 'motivo pendiente; lo que Cursia produce');
    const r = D('modules/prebrief/prebrief-readiness.js').prebriefReadiness(m, card, [], []);
    assert(r.blockers.some((b) => b.code === 'exception_reason' && b.ref === 'videos@chapter'), 'la propuesta pide el motivo antes de prepararse');
    assert(!r.blockers.some((b) => b.code === 'critical'), 'sin crítico');
  });

  await check('PB19 Language QA de la propuesta: una cita LITERAL del documento (no editable en Cursia) no bloquea; lo que redacta Cursia sí', () => {
    const inp = fixture({ doc4x5: true });
    const m = build(inp);
    const doc = D('modules/prebrief/prebrief-document.js');
    const verbatim = M.documentVerbatimTexts(m);
    const o = m.goals.outcomes.find((x) => x.origin === 'document');
    assert(o && M.isDocumentVerbatim(o.text, verbatim), 'un resultado del documento es literal');
    assert(M.isDocumentVerbatim(`${o.text}`, verbatim) && !M.isDocumentVerbatim('Cursia recomienda el enfoque por competencias.', verbatim), 'lo de Cursia no');
    // Un resultado del documento con «coger» no se marca; el mismo texto como observación de Cursia sí se revisaría.
    const L = D('modules/language-qa/language-qa.js');
    const t = 'Coger el casco antes de entrar a la planta.';
    assert(L.lqaFindings(t, 3).length > 0, 'el detector lo ve');
    assert(M.isDocumentVerbatim(t, verbatim.concat([t])), 'pero si es literal del documento, se omite');
    assert(doc.documentTexts(doc.buildPrebriefDocument(m)).length > 0);
  });

  console.log(`\n${ok} OK · ${fail} fallas`);
  process.exit(fail ? 1 : 0);
})();
