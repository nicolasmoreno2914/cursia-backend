#!/usr/bin/env node
/* eslint-disable */
// Fase 7 — Coherence Engine: reglas S1–S3 / C1–C7, reporte determinístico y
// merge de la capa LLM (sin DB, sin red, sin LLM real).
//
// Carga los módulos COMPILADOS de dist/ (igual que
// check-packaging-exam-video-mapping.js). Cada regla tiene su fixture y se
// verifica por UUID en la evidencia, no solo por conteo; la fixture "limpia"
// no produce ningún finding.
//
// Usage:
//   node scripts/check-coherence-engine.js
//   node scripts/check-coherence-engine.js path/to/dist

const path = require('path');
const crypto = require('crypto');

const distRoot = path.resolve(process.cwd(), process.argv[2] || 'dist');

function loadDist(relPath) {
  const abs = path.join(distRoot, relPath);
  try {
    return require(abs);
  } catch (err) {
    console.error(`❌ No se pudo cargar el módulo compilado en ${abs}`);
    console.error(`   (¿corriste "npm run build" antes? — dist/ no se versiona)`);
    console.error(`   ${err.message}`);
    process.exit(1);
  }
}

const { buildBlueprintSnapshot, snapshotSha256 } = loadDist('modules/course-blueprints/blueprint-snapshot.js');
const { buildGenerationManifest, manifestSha256 } = loadDist('modules/generation-manifests/generation-manifest-builder.js');
const normalize = loadDist('modules/coherence/normalize.js');
const { buildCoherenceReport } = loadDist('modules/coherence/report.js');
const { runStructuralRules } = loadDist('modules/coherence/structural.js');
const { mergeLlmFindings, buildCompactLlmInput, LLM_INPUT_MAX_CHARS } = loadDist('modules/coherence/llm-merge.js');
const { COHERENCE_THRESHOLDS } = loadDist('modules/coherence/coherence-types.js');

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`✅ ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`❌ ${name}`);
    console.error(`   ${err && err.message ? err.message : err}`);
  }
}
function assertDeepEqual(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg}: esperado ${e}, encontrado ${a}`);
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
const clone = (x) => JSON.parse(JSON.stringify(x));

// ---------------------------------------------------------------------------
// Fixture limpia: 2 módulos × 2 capítulos, plan y sidecars reales coherentes.
// ---------------------------------------------------------------------------
const M1 = 'b7000000-0000-4000-8000-000000000001';
const M2 = 'b7000000-0000-4000-8000-000000000002';
const C1 = 'c7000000-0000-4000-8000-000000000001';
const C2 = 'c7000000-0000-4000-8000-000000000002';
const C3 = 'c7000000-0000-4000-8000-000000000003';
const C4 = 'c7000000-0000-4000-8000-000000000004';

function cleanSpec() {
  return [
    {
      id: M1,
      title: 'Fundamentos de hidráulica',
      objective: 'Comprender presión y caudal en sistemas hidráulicos',
      exam: true,
      chapters: [
        { id: C1, title: 'Presión en fluidos', objective: 'Explicar la presión hidrostática' },
        { id: C2, title: 'Caudal y continuidad', objective: 'Calcular caudal con la ecuación de continuidad' },
      ],
    },
    {
      id: M2,
      title: 'Bombas centrífugas',
      objective: 'Seleccionar bombas centrífugas según su curva característica',
      exam: true,
      chapters: [
        { id: C3, title: 'Componentes de una bomba centrífuga', objective: 'Identificar impulsor y voluta' },
        { id: C4, title: 'Curva característica y selección', objective: 'Seleccionar una bomba usando su curva característica' },
      ],
    },
  ];
}

function buildBp(spec) {
  const modules = spec.map((m, i) => ({
    id: m.id,
    position: i,
    title: m.title,
    objective: m.objective ?? null,
    exam_enabled: !!m.exam,
  }));
  const chapters = [];
  spec.forEach((m) =>
    m.chapters.forEach((c, j) =>
      chapters.push({
        id: c.id,
        module_id: m.id,
        position: j,
        title: c.title,
        objective: c.objective ?? null,
        video_enabled: !!c.video,
      }),
    ),
  );
  return buildBlueprintSnapshot({ id: 7007, title: 'Curso coherencia fixture' }, modules, chapters);
}

function cleanSummaries() {
  return {
    [C1]: {
      summary: 'Presión hidrostática en fluidos en reposo.',
      concepts_introduced: ['presión hidrostática', 'presión'],
      concepts_assumed: [],
      key_terms: ['presión', 'pascal'],
    },
    [C2]: {
      summary: 'Caudal volumétrico y ecuación de continuidad.',
      concepts_introduced: ['caudal', 'ecuación de continuidad'],
      concepts_assumed: ['presión'],
      key_terms: ['caudal', 'continuidad'],
    },
    [C3]: {
      summary: 'Partes de una bomba centrífuga.',
      concepts_introduced: ['impulsor', 'voluta', 'bomba centrífuga'],
      concepts_assumed: ['caudal'],
      key_terms: ['impulsor', 'voluta'],
    },
    [C4]: {
      summary: 'Lectura de la curva característica y selección.',
      concepts_introduced: ['curva característica', 'selección de bomba'],
      concepts_assumed: ['bomba centrífuga', 'caudal'],
      key_terms: ['curva característica', 'punto de operación'],
    },
  };
}
function planFrom(summaries) {
  return { chapters: clone(summaries), modules: { [M1]: { summary: 'Hidráulica básica' }, [M2]: { summary: 'Bombas' } } };
}

function report({ spec = cleanSpec(), summaries = cleanSummaries(), plan, declaredPriorConcepts, layers } = {}) {
  const blueprint = buildBp(spec);
  return buildCoherenceReport({
    blueprint,
    coursePlan: plan === undefined ? planFrom(cleanSummaries()) : plan,
    contextSummaries: summaries,
    declaredPriorConcepts,
    layers,
  });
}
const rulesFired = (r) => [...new Set(r.findings.map((f) => f.rule))].sort();
const byRule = (r, rule) => r.findings.filter((f) => f.rule === rule);

// ---------------------------------------------------------------------------
// Normalización
// ---------------------------------------------------------------------------
check('norm: minúsculas, sin acentos/puntuación, sin stopwords, plurales', () => {
  assertDeepEqual(normalize.norm('¡Tipos de Bombas Centrífugas!'), 'tipo bomba centrifuga', 'norm');
  assertDeepEqual(normalize.norm('Los motores y las redes'), 'motor red', 'plurales -es');
  assertDeepEqual(normalize.norm('Luces'), 'luz', '-ces');
  assertDeepEqual(normalize.norm('análisis'), 'analisis', '-is no se toca');
  assert(normalize.tokenJaccard('Tipos de bombas', 'Las bombas: tipos') === 1, 'tokenJaccard idéntico');
  assert(normalize.trigramJaccard('abc', 'abc') === 1, 'trigram idéntico');
  assert(normalize.tokenJaccard('', '') === 0, 'vacíos = 0');
});

check('INFO: ejemplo del brief "Tipos de bombas" vs "Tipos y características de bombas" (solo se informa)', () => {
  const a = 'Tipos de bombas';
  const b = 'Tipos y características de bombas';
  console.log(
    `   token=${normalize.round4(normalize.tokenJaccard(a, b))} trigram=${normalize.round4(normalize.trigramJaccard(a, b))} ` +
      `(umbrales S1: token≥${COHERENCE_THRESHOLDS.S1_TOKEN_JACCARD_MIN} o trigram≥${COHERENCE_THRESHOLDS.S1_TRIGRAM_JACCARD_MIN})`,
  );
});

// ---------------------------------------------------------------------------
// Fixture limpia: cero findings
// ---------------------------------------------------------------------------
check('fixture limpia: 0 findings (estructural + contenido)', () => {
  const r = report();
  assertDeepEqual(r.layers, { structural: true, content: true }, 'layers');
  assertDeepEqual(r.findings.map((f) => `${f.rule}:${JSON.stringify(f.evidence)}`), [], 'findings');
  assert(r.coherenceVersion === 1 && r.ruleset === 'coherence-rules@1', 'versión/ruleset');
  assert(r.llm === null, 'llm null');
});

check('inputs: hashes coinciden con los del sistema (blueprint/manifest v1) y null cuando falta el input', () => {
  const bp = buildBp(cleanSpec());
  const mf = buildGenerationManifest(bp, { courseId: 7007, blueprintId: 1, blueprintNumber: 1, blueprintSha256: snapshotSha256(bp) });
  const r = buildCoherenceReport({ blueprint: bp, manifest: mf });
  assert(r.inputs.blueprintSha256 === snapshotSha256(bp), 'blueprintSha256 = snapshotSha256');
  assert(r.inputs.manifestSha256 === manifestSha256(mf), 'manifestSha256 = manifestSha256 v1');
  assert(r.inputs.coursePlanSha256 === null && r.inputs.contextSummariesSha256 === null, 'null sin plan/sidecars');
  assertDeepEqual(r.layers, { structural: true, content: false }, 'sin inputs de contenido corre solo estructural');
});

// ---------------------------------------------------------------------------
// Estructurales
// ---------------------------------------------------------------------------
check('S1 (token-Jaccard): títulos casi duplicados → par de chapterId', () => {
  const spec = cleanSpec();
  spec[0].chapters[1].title = 'Presión de los fluidos';
  const r = report({ spec, layers: { structural: true, content: false } });
  assertDeepEqual(rulesFired(r), ['S1'], 'reglas');
  const f = byRule(r, 'S1')[0];
  assertDeepEqual(f.evidence.chapterIds, [C1, C2], 'evidencia chapterIds');
  assertDeepEqual(f.chapterIds, [C1, C2], 'chapterIds');
  assert(f.evidence.tokenJaccard === 1 && f.severity === 'warning', 'score/severidad');
});

check('S1 (trigram-Jaccard): variante morfológica entre módulos', () => {
  const spec = cleanSpec();
  spec[0].chapters[0].title = 'Seguridad eléctrica industrial';
  spec[1].chapters[0].title = 'Seguridad eléctrica en la industria';
  const r = report({ spec, layers: { structural: true, content: false } });
  assertDeepEqual(rulesFired(r), ['S1'], 'reglas');
  const f = byRule(r, 'S1')[0];
  assertDeepEqual(f.evidence.chapterIds, [C1, C3], 'evidencia chapterIds');
  assertDeepEqual(f.moduleIds, [M1, M2].sort(), 'moduleIds');
  assert(f.evidence.tokenJaccard < COHERENCE_THRESHOLDS.S1_TOKEN_JACCARD_MIN, 'debe entrar por trigramas');
  assert(f.evidence.trigramJaccard >= COHERENCE_THRESHOLDS.S1_TRIGRAM_JACCARD_MIN, 'trigram ≥ umbral');
});

check('S2: objetivo de módulo sin cobertura → moduleId + tokens sin cubrir', () => {
  const spec = cleanSpec();
  spec[0].objective = 'Dominar termodinámica avanzada de turbinas';
  const r = report({ spec, layers: { structural: true, content: false } });
  assertDeepEqual(rulesFired(r), ['S2'], 'reglas');
  const f = byRule(r, 'S2')[0];
  assertDeepEqual(f.evidence.moduleId, M1, 'moduleId');
  assertDeepEqual(f.evidence.uncoveredTokens, ['avanzada', 'dominar', 'termodinamica', 'turbina'], 'tokens');
  assert(f.severity === 'info', 'severidad');
});

check('S3: módulo con 1 capítulo y examen → moduleId', () => {
  const spec = cleanSpec();
  spec[1].chapters.pop();
  const r = report({ spec, layers: { structural: true, content: false } });
  assertDeepEqual(rulesFired(r), ['S3'], 'reglas');
  assertDeepEqual(byRule(r, 'S3')[0].moduleIds, [M2], 'moduleId');
  spec[1].exam = false;
  assertDeepEqual(rulesFired(report({ spec, layers: { structural: true, content: false } })), [], 'sin examen no hay S3');
});

// ---------------------------------------------------------------------------
// Contenido
// ---------------------------------------------------------------------------
check('C1: concepto introducido en más de un capítulo (real) → concepto + chapterIds', () => {
  const s = cleanSummaries();
  s[C3].concepts_introduced.push('Caudal');
  const r = report({ summaries: s });
  assertDeepEqual(rulesFired(r), ['C1'], 'reglas');
  const f = byRule(r, 'C1')[0];
  assertDeepEqual(f.evidence.concept, 'caudal', 'concepto');
  assertDeepEqual(f.evidence.chapterIds, [C2, C3], 'chapterIds');
  assertDeepEqual(f.evidence.basis, { [C2]: 'real', [C3]: 'real' }, 'basis');
});

check('C1 (planeado): sin sidecars reales usa el plan', () => {
  const plan = planFrom(cleanSummaries());
  plan.chapters[C4].concepts_introduced.push('impulsores');
  const r = report({ summaries: null, plan });
  assertDeepEqual(rulesFired(r), ['C1'], 'reglas');
  const f = byRule(r, 'C1')[0];
  assertDeepEqual([f.evidence.concept, f.evidence.chapterIds], ['impulsor', [C3, C4]], 'evidencia');
  assertDeepEqual(f.evidence.basis, { [C3]: 'plan', [C4]: 'plan' }, 'basis plan');
});

check('C2: asumido en i e introducido recién en j>i → chapterId i, j', () => {
  const s = cleanSummaries();
  s[C2].concepts_assumed.push('impulsor');
  const r = report({ summaries: s });
  assertDeepEqual(rulesFired(r), ['C2'], 'reglas');
  const f = byRule(r, 'C2')[0];
  assertDeepEqual(
    [f.evidence.concept, f.evidence.assumedInChapterId, f.evidence.introducedInChapterId],
    ['impulsor', C2, C3],
    'evidencia',
  );
  assertDeepEqual(f.chapterIds, [C2, C3], 'chapterIds');
});

check('C3: asumido y nunca introducido → chapterId; el contexto previo declarado lo silencia', () => {
  const s = cleanSummaries();
  s[C1].concepts_assumed.push('Viscosidad');
  const r = report({ summaries: s });
  assertDeepEqual(rulesFired(r), ['C3'], 'reglas');
  const f = byRule(r, 'C3')[0];
  assertDeepEqual([f.evidence.concept, f.evidence.chapterId], ['viscosidad', C1], 'evidencia');
  const r2 = report({ summaries: s, declaredPriorConcepts: ['viscosidad'] });
  assertDeepEqual(rulesFired(r2), [], 'silenciado por contexto previo');
  assert(r2.inputs.declaredPriorConceptsSha256 && r.inputs.declaredPriorConceptsSha256 === null, 'contexto previo hasheado');
});

check('C4: objetivo del capítulo con cobertura baja por sus concepts_introduced reales', () => {
  const spec = cleanSpec();
  spec[0].chapters[0].objective = 'Explicar la presión hidrostática en tanques abiertos y cerrados';
  const s = cleanSummaries();
  s[C1].concepts_introduced = ['presión', 'unidades'];
  const r = report({ spec, summaries: s });
  assertDeepEqual(rulesFired(r), ['C4'], 'reglas');
  const f = byRule(r, 'C4')[0];
  assertDeepEqual(f.evidence.chapterId, C1, 'chapterId');
  assertDeepEqual(f.evidence.uncoveredTokens, ['abierto', 'cerrado', 'explicar', 'hidrostatica', 'tanque'], 'tokens');
  assert(f.suggestedAction === 'regenerate_chapter', 'acción sugerida');
});

check('C5: key_terms reales de dos capítulos con Jaccard ≥ 0.5 → par de chapterId', () => {
  const s = cleanSummaries();
  s[C4].key_terms = ['impulsor', 'voluta', 'curva característica'];
  const r = report({ summaries: s });
  assertDeepEqual(rulesFired(r), ['C5'], 'reglas');
  const f = byRule(r, 'C5')[0];
  assertDeepEqual(f.evidence.chapterIds, [C3, C4], 'chapterIds');
  assertDeepEqual(f.evidence.sharedKeyTerms, ['impulsor', 'voluta'], 'shared');
});

check('C6: desvío plan vs real (< 30 %) → chapterId + conjuntos', () => {
  const s = cleanSummaries();
  s[C3].concepts_introduced = ['álabes curvados del impulsor', 'sello mecánico', 'rodamientos'];
  s[C4].concepts_assumed = ['caudal'];
  const plan = planFrom(cleanSummaries());
  plan.chapters[C4].concepts_assumed = ['caudal'];
  const r = report({ summaries: s, plan });
  assertDeepEqual(rulesFired(r), ['C6'], 'reglas');
  const f = byRule(r, 'C6')[0];
  assertDeepEqual(f.evidence.chapterId, C3, 'chapterId');
  assertDeepEqual(f.evidence.planned, ['bomba centrifuga', 'impulsor', 'voluta'], 'planned');
  assertDeepEqual(f.evidence.matched, [], 'matched');
});

check('C7: mismo key_term central en capítulos de dos módulos → término + moduleIds (co-dispara C1)', () => {
  const s = cleanSummaries();
  s[C3].concepts_introduced.push('presión');
  s[C3].key_terms.push('presión');
  const r = report({ summaries: s });
  assertDeepEqual(rulesFired(r), ['C1', 'C7'], 'reglas');
  const f = byRule(r, 'C7')[0];
  assertDeepEqual([f.evidence.term, f.evidence.moduleIds, f.evidence.chapterIds], ['presion', [M1, M2], [C1, C3]], 'evidencia');
});

// ---------------------------------------------------------------------------
// Determinismo e ids
// ---------------------------------------------------------------------------
function noisyInputs() {
  const spec = cleanSpec();
  spec[0].chapters[1].title = 'Presión de los fluidos'; // S1
  spec[1].chapters[1].objective = 'Dominar turbinas de vapor'; // C4
  const s = cleanSummaries();
  s[C3].concepts_introduced.push('Caudal'); // C1
  s[C2].concepts_assumed.push('impulsor'); // C2
  s[C1].concepts_assumed.push('viscosidad'); // C3
  s[C4].key_terms = ['impulsor', 'voluta', 'curva característica']; // C5
  return { spec, s };
}
function reverseKeysDeep(x) {
  if (Array.isArray(x)) return x.map(reverseKeysDeep);
  if (x && typeof x === 'object') {
    const out = {};
    for (const k of Object.keys(x).reverse()) out[k] = reverseKeysDeep(x[k]);
    return out;
  }
  return x;
}

check('determinismo: mismo hash/orden/ids ante claves y arreglos no semánticos barajados', () => {
  const { spec, s } = noisyInputs();
  const bp = buildBp(spec);
  const plan = planFrom(s);
  const a = buildCoherenceReport({ blueprint: bp, coursePlan: plan, contextSummaries: s, declaredPriorConcepts: ['x', 'y'] });
  assert(a.findings.length >= 5, `esperaba varios findings, hay ${a.findings.length}`);

  const bp2 = reverseKeysDeep(clone(bp));
  bp2.modules.reverse();
  bp2.modules.forEach((m) => m.chapters.reverse());
  const s2 = reverseKeysDeep(clone(s));
  for (const v of Object.values(s2)) {
    v.concepts_introduced.reverse();
    v.concepts_assumed.reverse();
    v.key_terms.reverse();
  }
  const plan2 = reverseKeysDeep(clone(plan));
  plan2.chapters = Object.entries(plan2.chapters)
    .reverse()
    .map(([chapterId, c]) => ({ ...c, chapterId, concepts_introduced: [...c.concepts_introduced].reverse() }));
  const b = buildCoherenceReport({ blueprint: bp2, coursePlan: plan2, contextSummaries: s2, declaredPriorConcepts: ['y', 'x'] });

  assertDeepEqual(b.findings.map((f) => f.id), a.findings.map((f) => f.id), 'ids y orden');
  assertDeepEqual(b.inputs, a.inputs, 'inputs');
  assert(a.reportSha256 === b.reportSha256, 'reportSha256');
  assertDeepEqual(b, a, 'reporte completo idéntico');
  const again = buildCoherenceReport({ blueprint: bp, coursePlan: plan, contextSummaries: s, declaredPriorConcepts: ['x', 'y'] });
  assert(again.reportSha256 === a.reportSha256, 'repetible');
});

check('id de finding = sha256(regla + ids ordenados + evidencia canónica); orden por regla', () => {
  const { spec, s } = noisyInputs();
  const r = report({ spec, summaries: s });
  const canon = (x) =>
    Array.isArray(x)
      ? `[${x.map(canon).join(',')}]`
      : x && typeof x === 'object'
        ? `{${Object.keys(x)
            .sort()
            .map((k) => `${JSON.stringify(k)}:${canon(x[k])}`)
            .join(',')}}`
        : JSON.stringify(x);
  for (const f of r.findings) {
    const ids = [...new Set([...f.moduleIds, ...f.chapterIds])].sort();
    const want = crypto.createHash('sha256').update(`${f.rule}\n${ids.join(',')}\n${canon(f.evidence)}`).digest('hex');
    assert(f.id === want, `id ${f.rule}`);
    assert(f.source === 'deterministic', 'source');
  }
  const order = ['S1', 'S2', 'S3', 'C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7'];
  const idx = r.findings.map((f) => order.indexOf(f.rule));
  assertDeepEqual(idx, [...idx].sort((x, y) => x - y), 'orden por regla');
});

check('cambiar un input cambia el hash del reporte', () => {
  const a = report();
  const s = cleanSummaries();
  s[C1].summary = 'otro resumen';
  const b = report({ summaries: s });
  assert(a.inputs.contextSummariesSha256 !== b.inputs.contextSummariesSha256, 'hash sidecars');
  assert(a.reportSha256 !== b.reportSha256, 'hash reporte');
});

// ---------------------------------------------------------------------------
// Capa LLM (mock)
// ---------------------------------------------------------------------------
check('LLM merge: descarta UUIDs inventados/mal tipados, rotula source:llm, no toca lo determinístico', () => {
  const { spec, s } = noisyInputs();
  const bp = buildBp(spec);
  const base = buildCoherenceReport({ blueprint: bp, coursePlan: planFrom(s), contextSummaries: s });
  const snapshot = clone(base);
  const FAKE = 'deadbeef-0000-4000-8000-000000000999';
  const merged = mergeLlmFindings(base, bp, {
    model: 'mock-llm',
    promptSha256: 'abc',
    findings: [
      { rule: 'tono', severity: 'warning', chapterIds: [C2], message: 'El capítulo cambia de tono.', suggestion: 'Unificá.' },
      { severity: 'warning', chapterIds: [FAKE], message: 'Inventado' },
      { severity: 'info', chapterIds: [M1], message: 'Módulo en chapterIds' },
      { severity: 'info', moduleIds: [M2], message: `Ver también ${FAKE}` },
      { severity: 'info', message: '' },
      'basura',
      { severity: 'error', moduleIds: [M1], chapterIds: [C1], evidence: { note: `ok ${C1}` }, message: 'Válido 2', suggestedAction: 'borrar_todo' },
    ],
  });
  assertDeepEqual(base, snapshot, 'el reporte de entrada no se muta');
  assertDeepEqual(
    merged.findings.filter((f) => f.source === 'deterministic'),
    base.findings,
    'determinísticos idénticos',
  );
  assert(merged.reportSha256 === base.reportSha256, 'reportSha256 intacto');
  const llm = merged.findings.filter((f) => f.source === 'llm');
  assertDeepEqual(llm.map((f) => f.message).sort(), ['El capítulo cambia de tono.', 'Válido 2'], 'aceptados');
  assertDeepEqual(
    [merged.llm.accepted, merged.llm.droppedInvalidIds, merged.llm.droppedMalformed, merged.llm.model],
    [2, 3, 2, 'mock-llm'],
    'contadores',
  );
  const v2 = llm.find((f) => f.message === 'Válido 2');
  assert(v2.severity === 'warning' && v2.suggestedAction === null && v2.rule === 'LLM', 'normalización severidad/acción');
  assert(merged.findings.slice(-2).every((f) => f.source === 'llm'), 'LLM al final');
  // Re-merge reemplaza la capa LLM anterior (no acumula).
  const re = mergeLlmFindings(merged, bp, { model: 'm2', promptSha256: 'p2', findings: [] });
  assert(re.findings.every((f) => f.source === 'deterministic') && re.llm.accepted === 0, 're-merge');
});

check('LLM merge: un reporte con la parte determinística alterada falla fuerte', () => {
  const { spec, s } = noisyInputs();
  const bp = buildBp(spec);
  const base = buildCoherenceReport({ blueprint: bp, coursePlan: planFrom(s), contextSummaries: s });
  const tampered = clone(base);
  tampered.findings.pop();
  let threw = false;
  try {
    mergeLlmFindings(tampered, bp, { model: 'm', promptSha256: 'p', findings: [] });
  } catch (e) {
    threw = /TAMPERED/.test(e.message);
  }
  assert(threw, 'debía lanzar COHERENCE_REPORT_TAMPERED');
});

check('LLM input: outline compacto con tope de tamaño, sin contenido completo', () => {
  const spec = [];
  const summaries = {};
  const SENTINEL = 'CONTENIDO_COMPLETO_NO_DEBE_VIAJAR';
  for (let m = 0; m < 6; m++) {
    const chapters = [];
    for (let c = 0; c < 10; c++) {
      const id = `c8000000-0000-4000-8000-${String(m * 10 + c).padStart(12, '0')}`;
      chapters.push({ id, title: `Capítulo ${m}.${c} sobre un tema largo`, objective: 'x'.repeat(500) });
      summaries[id] = {
        summary: 'r'.repeat(1500) + SENTINEL,
        concepts_introduced: Array.from({ length: 40 }, (_, i) => `concepto ${i} ${'z'.repeat(60)}`),
        concepts_assumed: Array.from({ length: 40 }, (_, i) => `asumido ${i}`),
        key_terms: Array.from({ length: 40 }, (_, i) => `termino ${i}`),
      };
    }
    spec.push({ id: `b8000000-0000-4000-8000-${String(m).padStart(12, '0')}`, title: `Módulo ${m}`, objective: 'o', exam: true, chapters });
  }
  const bp = buildBp(spec);
  const small = buildCompactLlmInput({ blueprint: buildBp(cleanSpec()), contextSummaries: cleanSummaries() });
  assert(small.compactionLevel === 0, 'curso chico sin recorte');
  const big = buildCompactLlmInput({ blueprint: bp, coursePlan: { chapters: summaries }, contextSummaries: summaries });
  assert(big.chars <= LLM_INPUT_MAX_CHARS, `chars ${big.chars} > ${LLM_INPUT_MAX_CHARS}`);
  assert(big.compactionLevel > 0, 'debía compactar');
  assert(!big.json.includes(SENTINEL), 'no debe incluir el resumen completo');
  const parsed = JSON.parse(big.json);
  assert(parsed.modules.length === 6 && parsed.modules[0].chapters.length === 10, 'outline completo');
  const again = buildCompactLlmInput({ blueprint: bp, coursePlan: { chapters: summaries }, contextSummaries: summaries });
  assert(again.promptInputSha256 === big.promptInputSha256, 'determinístico');
});

check('estructural: función pura, no muta el Blueprint', () => {
  const bp = buildBp(cleanSpec());
  const before = JSON.stringify(bp);
  runStructuralRules(bp);
  buildCoherenceReport({ blueprint: bp, coursePlan: planFrom(cleanSummaries()), contextSummaries: cleanSummaries() });
  assert(JSON.stringify(bp) === before, 'blueprint mutado');
});

if (failures > 0) {
  console.error(`\n${failures} check(s) fallaron`);
  process.exit(1);
}
console.log('\nCoherence Engine: todos los checks pasaron');
