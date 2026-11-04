#!/usr/bin/env node
/* eslint-disable */
// r98 — escalera de remediación de un fallo DETERMINISTA conocido (reliability/remediation-ladder.ts) + «Falla común».
// Incidente: prod run 4c6a9f71, `audiobook_chapter` falló 6 veces con AUDIOBOOK_LANGUAGE_NOT_NEUTRAL (sin regla →
// D «unclassified», el worker lo marcaba reintentable, cada reintento repetía la misma llamada con el mismo prompt).
//
//   C  clasificación: AUDIOBOOK_LANGUAGE_NOT_NEUTRAL es B (validación de contenido), determinista; transitorios,
//      presupuesto, configuración y pago incierto NO son deterministas; la huella ignora el texto libre;
//   R1 rung 1: 2.º fallo con la misma huella → feedback con los hallazgos del validador (idioma: «evita estos términos …
//      cítalos entre comillas»; datos inventados: «no uses cifras que no estén en la fuente») que llega al prompt (brief
//      del ejecutor / guion del audiolibro) y UN intento más aunque se hubieran agotado;
//   R2 rung 2: 3.er fallo con huella degradable (lista corta explícita) → el próximo intento acepta con marca de calidad
//      (guion del audiolibro, validación v3 del servidor, ejecutor del navegador); nada estructural degrada;
//   R3 rung 3: no degradable o persiste → sin intentos extra ni reaperturas automáticas con esa huella (auto-heal, reintento seguro,
//      estado de recuperación) y con motivo claro; el DUEÑO puede reintentar (owner-retry), con los guards de dinero;
//   K  tope: ≤ MAX_LADDER_GRANTS intentos extra por huella y ≤ MAX_LADDER_GRANTS_PER_ITEM por parte; nunca con pago
//      incierto ni si el emisor dice no reintentable;
//   Review r98: P0-1 (la escalera no apaga las rondas B del auto-heal), P1-1 (D hold_for_human / sin clasificar fuera),
//      P1-2 (pago incierto fuera; conciliación primero), P1-3 (reintento humano = ciclo nuevo), P2-1/3/4/5/8;
//   S  señal agregada «Falla común»: ≥ 3 cursos en 24 h; reporte para desarrollo (huella, fechas, cursos/runs, ejemplos
//      redactados, escalones, archivo y función, punto de partida); resuelta por admin o tras 72 h sin aparecer;
//   P  marca de calidad → informe de calidad del paquete (QUALITY_ACCEPTED).
// Puro (sin DB, sin red, USD 0). Uso: node scripts/check-r98-remediation-ladder.js [path/to/dist]
'use strict';
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const DIST = path.resolve(process.argv[2] || path.join(REPO, 'dist'));
function loadDist(rel) {
  try { return require(path.join(DIST, rel)); } catch (err) {
    console.error(`❌ No se pudo cargar ${rel} desde ${DIST} (¿npm run build?): ${err.message}`);
    process.exit(1);
  }
}
require('reflect-metadata');
const FC = loadDist('modules/reliability/failure-classifier.js');
const L = loadDist('modules/reliability/remediation-ladder.js');
const AH = loadDist('modules/dynamic-generation/auto-heal.js');
const IT = loadDist('modules/dynamic-generation/item-transitions.js');
const RS = loadDist('modules/reliability/recovery-state.js');
const OR = loadDist('modules/dynamic-generation/owner-retry.js');
const GD = loadDist('modules/pedagogy/generator-directives.js');
const A = loadDist('workers/provider-real/audio-scripts.js');
const RV = loadDist('modules/dynamic-generation/item-recovery-view.js');
const QF = loadDist('modules/quality/quality-finding.js');
const PW = loadDist('workers/dynamic-package-worker.js');

let ok = 0;
let fail = 0;
async function check(name, fn) {
  try { await fn(); ok++; console.log(`✅ ${name}`); } catch (e) { fail++; console.log(`❌ ${name}\n   ${String((e && e.stack) || e).split('\n').slice(0, 5).join('\n   ')}`); }
}
function assert(c, m) { if (!c) throw new Error(m || 'assert'); }
function eq(a, b, m) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m || 'eq'}: esperado ${JSON.stringify(b)}, encontrado ${JSON.stringify(a)}`); }

const T0 = new Date('2026-11-04T10:00:00Z');
// El barrido del auto-heal solo corre con V2 encendido (autoHealEnabled): el check lo enciende como en staging/prod.
process.env.DYNAMIC_COURSE_STRUCTURE = 'true';
delete process.env.DYNAMIC_AUTO_HEAL_ENABLED;
const ENV_ON = { DYNAMIC_COURSE_STRUCTURE: 'true' };
const ENV_TICK_OFF = { DYNAMIC_COURSE_STRUCTURE: 'true', DYNAMIC_AUTO_HEAL_ENABLED: 'false' };
const at = (min) => new Date(T0.getTime() + min * 60_000);
const LANG = (blk, term) => `AUDIOBOOK_LANGUAGE_NOT_NEUTRAL: el guion del bloque ${blk} del capítulo 3 no está en español neutro: «${term}» (regionalismo de Argentina; usa «trabajo»)`;
const verdictOf = (error, itemType = 'audiobook_chapter') => FC.classifyFailure({ error, itemType, source: 'provider_worker', outputSummary: {} });

/** Encadena fallos como lo hace applyItemFailure (estado previo → paso). */
function run(errors, itemType = 'audiobook_chapter', opts = { retryable: true }) {
  let prev = null;
  const steps = [];
  errors.forEach((e, i) => {
    const s = L.ladderStep(prev, verdictOf(e, itemType), itemType, e, at(i), opts);
    steps.push(s);
    if (s) prev = s.state;
  });
  return { steps, state: prev };
}

/** QueryRunner falso: una fila en memoria; aplica las UPDATE de applyRemediationLadder por su forma. */
function fakeQr(row) {
  const sqls = [];
  return {
    sqls,
    row,
    async query(sql, params) {
      sqls.push(sql.replace(/\s+/g, ' ').trim());
      if (/set status = 'retrying', max_attempts = greatest\(max_attempts, attempt_count\) \+ 1/.test(sql) && row.status === 'failed') {
        row.status = 'retrying'; row.max_attempts = Math.max(row.max_attempts, row.attempt_count) + 1; row.finished_at = null;
      } else if (/set status = 'failed', next_retry_at = null, finished_at = now\(\)/.test(sql) && row.status === 'retrying') {
        row.status = 'failed';
      } else if (/jsonb_build_object\('remediation'/.test(sql)) {
        row.output_summary = { ...(row.output_summary || {}), remediation: JSON.parse(params[1]) };
      }
      return [];
    },
  };
}

(async () => {
  // ── C: clasificación y huella ───────────────────────────────────────────────
  await check('C1 AUDIOBOOK_LANGUAGE_NOT_NEUTRAL → B regenerate_targeted (ya no D «unclassified» con pago incierto) y determinista', async () => {
    const v = verdictOf(LANG(2, 'laburo'));
    eq([v.class, v.code, v.unclassified, v.paidRisk], ['B', 'AUDIOBOOK_LANGUAGE_NOT_NEUTRAL', false, 'none'], 'veredicto');
    assert(FC.isFailureCodeClassified('AUDIOBOOK_LANGUAGE_NOT_NEUTRAL'), 'regla explícita');
    assert(L.isDeterministicVerdict(v), 'determinista');
  });
  await check('C2 NO deterministas: lease_expired, llm_transient, budget (D budget), config del proveedor (wait_provider), audio con escalera propia', async () => {
    for (const [e, t] of [['lease_expired', 'content'], ['llm_transient: HTTP 529 overloaded', 'content'], ['item_recovery_budget_exhausted: tope de la parte', 'content'],
      ['tts_failed: chunk 1/3: HTTP 429 insufficient_quota', 'audiobook_chapter'], ['AUDIO_WPM_OUT_OF_RANGE: el segmento seg-1 narra 343 palabras', 'audiobook_chapter'],
      ['EXAM_BANK_INCOMPLETE: hoja corta', 'exam']]) {
      const v = FC.classifyFailure({ error: e, itemType: t, source: t === 'content' ? 'browser_executor' : 'provider_worker', outputSummary: {} });
      assert(!L.isDeterministicVerdict(v), `${e} no debería ser determinista (${v.class}/${v.strategy}/${v.humanReason})`);
      assert(L.ladderStep(null, v, t, e, T0, { retryable: true }) === null, `${e}: la escalera no lo toca`);
    }
  });
  await check('C3 la huella ignora el texto libre (bloque, término, cifras) y distingue código, códigos internos y tipo', async () => {
    const a = L.failureFingerprintOf(verdictOf(LANG(1, 'laburo')), 'audiobook_chapter');
    const b = L.failureFingerprintOf(verdictOf(LANG(7, 'pibe')), 'audiobook_chapter');
    eq(a, b, 'mismo código, otro texto → misma huella');
    assert(a === 'audiobook_chapter|AUDIOBOOK_LANGUAGE_NOT_NEUTRAL|validation_invalid|', a);
    const v1 = FC.classifyFailure({ error: 'v3_payload_invalid [JSON_INVALID]: experience:c1 …', itemType: 'experience', source: 'browser_executor', outputSummary: {} });
    const v2 = FC.classifyFailure({ error: 'v3_payload_invalid [LANGUAGE_NOT_NEUTRAL]: experience:c1 …', itemType: 'experience', source: 'browser_executor', outputSummary: {} });
    assert(L.failureFingerprintOf(v1, 'experience') !== L.failureFingerprintOf(v2, 'experience'), 'códigos internos distintos');
    assert(L.failureFingerprintOf(v2, 'experience') !== L.failureFingerprintOf(v2, 'activity'), 'tipo distinto');
  });

  // ── R1: feedback ────────────────────────────────────────────────────────────
  await check('R1 1.er fallo observa; 2.º con la misma huella → feedback con los hallazgos («evita estos términos … cítalos entre comillas»)', async () => {
    const { steps } = run([LANG(1, 'laburo'), LANG(4, 'laburo')]);
    eq(steps.map((s) => s.action), ['observe', 'feedback'], 'acciones');
    const st = steps[1].state;
    eq([st.rung, st.count], [1, 2], 'rung/count');
    assert(/evita estos términos: .*laburo/i.test(st.feedback) && /cítalos entre comillas/.test(st.feedback), st.feedback);
    assert(L.remediationFeedbackOf({ remediation: st }) === st.feedback, 'feedback para el prompt');
    assert(steps[0].state.feedback === null, 'el 1.er fallo no cambia el pedido');
  });
  await check('R1 datos inventados → «no uses cifras … que no estén en la fuente»; otros validadores → «corrige exactamente esos puntos»', async () => {
    const fb = L.feedbackFor('v3_payload_invalid', ['FABRICATED_DATA'], ['«el 87 % de las empresas»']);
    assert(/No uses cifras/.test(fb) && /no estén en la fuente/.test(fb), fb);
    assert(/Corrige exactamente esos puntos/.test(L.feedbackFor('v3_payload_invalid', ['TEXT_DENSE'], ['bloque de 900 caracteres'])), 'genérico');
  });
  await check('R1 el feedback llega al prompt: brief del ejecutor (existente o mínimo, ≤ 4000, con el marcador) y guion del audiolibro', async () => {
    const fb = L.feedbackFor('LANGUAGE_NOT_NEUTRAL', [], ['«laburo»']);
    const b = GD.withRemediationFeedback(null, { type: 'content' }, fb);
    assert(b && b.generator === 'content' && b.text.includes(GD.PEDAGOGY_PROMPT_MARKER) && b.text.includes(fb) && /^[0-9a-f]{64}$/.test(b.textSha256), 'brief mínimo');
    const big = { version: 1, engineVersion: 1, generator: 'experience', directives: [], overridden: [], text: '\n\n── ' + GD.PEDAGOGY_PROMPT_MARKER + ' ──\n' + 'x'.repeat(3700), textSha256: 'y' };
    const b2 = GD.withRemediationFeedback(big, { type: 'experience' }, fb);
    assert(b2.text.length <= GD.PEDAGOGY_BRIEF_TEXT_MAX && b2.text.endsWith(fb) && b2.text.startsWith(big.text.slice(0, 200)) && b2.textSha256 !== 'y', 'al tope: se recorta el final del brief, el feedback entra completo');
    assert(GD.withRemediationFeedback(null, { type: 'presentation' }, fb) === null, 'proveedor (Gamma) sin bloque: sin cambios');
    // Guion del audiolibro: el prompt del bloque lleva el feedback.
    const words = (n) => Array.from({ length: n }, (_, i) => `palabra${i}`).join(' ');
    const section = { idx: 0, title: 'Bloque', text: words(120), words: 120, sha256: 'x' };
    const prompts = [];
    const llm = async (p) => { prompts.push(p.user); return { text: 'Hoy revisas el proceso con calma. ' + words(110), messageId: 'm1' }; };
    await A.generateSectionScript({ courseTitle: 'Curso', chapterNumber: 1, chapterTitle: 'Cap', contentMarkdown: words(120), remediation: { feedback: 'CORRECCIÓN: evita «laburo»' } }, section, 1, null, llm);
    assert(prompts[0].endsWith('CORRECCIÓN: evita «laburo»'), 'feedback al final del pedido del bloque');
  });
  await check('R1 applyRemediationLadder: parte `failed` (intentos agotados) + feedback → `retrying` con UN intento más (misma transacción)', async () => {
    const e1 = LANG(1, 'laburo');
    const first = L.ladderStep(null, verdictOf(e1), 'audiobook_chapter', e1, T0, { retryable: true }).state;
    const row = { id: 'r1', status: 'failed', type: 'audiobook_chapter', attempt_count: 3, max_attempts: 3, output_summary: { remediation: first } };
    const qr = fakeQr(row);
    const step = await IT.applyRemediationLadder(qr, row, LANG(2, 'laburo'), true, verdictOf(LANG(2, 'laburo')), at(5));
    eq([step.action, step.grant, row.status, qr.row.max_attempts, row.output_summary.remediation.grants], ['feedback', true, 'retrying', 4, 1], 'transición');
  });

  // ── R2: aceptación con marca de calidad ─────────────────────────────────────
  await check('R2 3.er fallo con huella degradable → accept (acceptCodes); el guion del audiolibro se acepta con marca de calidad en vez de fallar', async () => {
    const { steps, state } = run([LANG(1, 'laburo'), LANG(2, 'laburo'), LANG(3, 'laburo')]);
    eq(steps.map((s) => s.action), ['observe', 'feedback', 'accept'], 'acciones');
    eq([...L.acceptCodesOf({ remediation: state })], ['AUDIOBOOK_LANGUAGE_NOT_NEUTRAL'], 'acceptCodes');
    const words = (n) => Array.from({ length: n }, (_, i) => `palabra${i}`).join(' ');
    const section = { idx: 0, title: 'Bloque', text: words(120), words: 120, sha256: 'x' };
    const say = async () => ({ text: 'Hoy revisas el laburo con calma. ' + words(110), messageId: 'm1' });
    const input = { courseTitle: 'Curso', chapterNumber: 1, chapterTitle: 'Cap', contentMarkdown: words(120) };
    let err = null;
    try { await A.generateSectionScript(input, section, 1, null, say); } catch (e) { err = e; }
    assert(err && err.code === 'AUDIOBOOK_LANGUAGE_NOT_NEUTRAL', 'sin rung 2 sigue fallando');
    const r = await A.generateSectionScript({ ...input, remediation: { acceptLanguage: true } }, section, 1, null, say);
    assert(r.qualityAccepted && r.qualityAccepted.code === 'AUDIOBOOK_LANGUAGE_NOT_NEUTRAL' && r.qualityAccepted.findings.length > 0, JSON.stringify(r.qualityAccepted));
    const q = L.withQualityWarning(undefined, L.qualityAcceptance(['AUDIOBOOK_LANGUAGE_NOT_NEUTRAL'], r.qualityAccepted.findings, T0, state.fingerprint));
    eq([q.degraded, q.warnings.length, q.warnings[0].code, q.warnings[0].rung], [true, 1, 'quality_accepted', 2], 'output_summary.quality');
  });
  await check('R2 lista EXPLÍCITA y corta; lo estructural / veracidad nunca degrada (JSON_INVALID, MISSING_FIELD, FABRICATED_DATA, EXAM_BANK_*, PACKAGE_*)', async () => {
    eq(L.DEGRADABLE_CODES, ['LANGUAGE_NOT_NEUTRAL', 'AUDIOBOOK_LANGUAGE_NOT_NEUTRAL'], 'lista');
    for (const c of ['JSON_INVALID', 'MISSING_FIELD', 'FABRICATED_DATA', 'EXAM_BANK_LEAF_CAPACITY', 'PACKAGE_BUILDER_ERROR', 'GIFT_UNPARSEABLE_BLOCK']) {
      assert(!L.isDegradableFingerprint('v3_payload_invalid', [c]), c);
    }
    assert(!L.isDegradableFingerprint('v3_payload_invalid', ['LANGUAGE_NOT_NEUTRAL', 'JSON_INVALID']), 'mezcla con estructural → no');
    assert(L.isDegradableFingerprint('v3_payload_invalid', ['LANGUAGE_NOT_NEUTRAL']), 'solo idioma → sí');
  });
  await check('R2 el servidor y el ejecutor aceptan SOLO el idioma: prevalidateV3 revalida la estructura (languageCourse) y el ejecutor vuelve blandos voseo/vosotros/regionalismos', async () => {
    const sch = fs.readFileSync(path.join(REPO, 'src/modules/dynamic-generation/scheduler.service.ts'), 'utf8');
    assert(/accept\.has\('LANGUAGE_NOT_NEUTRAL'\) && r\.errors\.length > 0 && r\.errors\.every\(\(e\) => e\.code === 'LANGUAGE_NOT_NEUTRAL'\)/.test(sch), 'solo si TODOS los errores son de idioma');
    assert(/validateV3ItemArtifact\(\{ \.\.\.ctx, languageCourse: true \}, text\)/.test(sch), 'revalidación estructural');
    const ex = fs.readFileSync(path.join(REPO, 'vendor/dynamic-executor/45-dynamic-generation-executor.js'), 'utf8');
    assert(!/!DYN_SOFT_LANG_CODES\[h\.code\]/.test(ex) && (ex.match(/_dynSoftLang\(item\)\[h\.code\]/g) || []).length === 6, 'todos los filtros por ítem');
    assert(/DYN_REMEDIATION_LANG_CODES = \{ VOSEO: true, VOSOTROS: true, REGIONAL: true \}/.test(ex) && !/DYN_REMEDIATION_LANG_CODES = \{[^}]*ENGLISH/.test(ex), 'inglés y veracidad siguen duros');
    // Evaluación real de _dynSoftLang en un contexto aislado.
    const vm = require('vm');
    const src = ex.slice(ex.indexOf('var DYN_SOFT_LANG_CODES'), ex.indexOf('function dynLintGrammarPerson'));
    const ctx = {}; vm.createContext(ctx); vm.runInContext(src, ctx);
    assert(!ctx._dynSoftLang({ outputSummary: {} }).VOSEO, 'sin escalera: voseo duro');
    assert(ctx._dynSoftLang({ outputSummary: { remediation: { rung: 2, acceptCodes: ['LANGUAGE_NOT_NEUTRAL'] } } }).REGIONAL, 'rung 2: blando');
    assert(!ctx._dynSoftLang({ outputSummary: { remediation: { rung: 2, acceptCodes: ['LANGUAGE_NOT_NEUTRAL'], outcome: 'completed' } } }).REGIONAL, 'cerrada: duro');
  });

  // ── R3: agotada ─────────────────────────────────────────────────────────────
  await check('R3 no degradable al 3.er fallo (o degradable al 4.º) → exhausted, sin intentos extra', async () => {
    const e = 'v3_payload_invalid [JSON_INVALID]: experience:c1 el artifact no es JSON';
    const { steps } = run([e, e, e], 'experience');
    eq(steps.map((s) => s.action), ['observe', 'feedback', 'exhausted'], 'no degradable');
    const { steps: s4 } = run([LANG(1, 'a'), LANG(2, 'b'), LANG(3, 'c'), LANG(4, 'd')]);
    eq(s4.map((s) => s.action), ['observe', 'feedback', 'accept', 'exhausted'], 'degradable que persiste');
    const st = s4[3].state;
    assert(st.exhaustedError === LANG(4, 'd') && st.tried.some((t) => t.rung === 2 && t.outcome === 'failed_same_fingerprint') && st.tried.some((t) => t.rung === 3), JSON.stringify(st.tried));
    // Sin intentos extra: una parte `failed` queda `failed`; una `retrying` termina sus intentos propios (default 3).
    const row = { id: 'r1', status: 'failed', type: 'audiobook_chapter', attempt_count: 3, max_attempts: 3, output_summary: { remediation: s4[2].state } };
    const qr = fakeQr(row);
    const step = await IT.applyRemediationLadder(qr, row, LANG(5, 'e'), true, verdictOf(LANG(5, 'e')), at(9));
    eq([step.action, step.grant, row.status, row.max_attempts], ['exhausted', false, 'failed', 3], 'sin intento extra');
  });
  await check('R3 ningún mecanismo automático la reabre (auto-heal por clase y legado, reintento seguro); estado failed_no_strategies / remediation_exhausted', async () => {
    const { state } = run([LANG(1, 'a'), LANG(2, 'b'), LANG(3, 'c'), LANG(4, 'd')]);
    const row = { id: 'x', status: 'failed', type: 'audiobook_chapter', error: LANG(4, 'd'), output_summary: { remediation: state }, finished_at: at(-600), updated_at: at(-600) };
    eq(AH.autoHealDecision(row, at(10), AH.DEFAULT_AUTO_HEAL_POLICY), { heal: false, reason: 'remediation_exhausted' }, 'auto-heal por clase');
    eq(AH.autoHealDecision(row, at(10), AH.LEGACY_AUTO_HEAL_POLICY), { heal: false, reason: 'remediation_exhausted' }, 'auto-heal legado');
    eq(AH.safeAutoRetryDecision(row, at(10)), { heal: false, reason: 'remediation_exhausted' }, 'reintento seguro');
    assert(AH.AUTO_HEAL_PERMANENT_SKIPS.includes('remediation_exhausted'), 'skip permanente');
    const v = RS.recoveryStateOf(row, at(10));
    eq([v.state, v.reason, v.automatic], ['failed_no_strategies', 'remediation_exhausted', false], 'estado');
    // Otro error (p. ej. tras un reintento del dueño que falló distinto) ya no queda bloqueado por la marca vieja.
    assert(!L.remediationBlocksAuto({ remediation: state }, 'lease_expired'), 'solo ESTE error');
  });
  await check('R3 el DUEÑO puede reintentar sin admin (owner-retry), con los guards de dinero intactos; motivo claro en la vista', async () => {
    const err = 'llm_output_invalid: JSON inválido en la salida del capítulo';
    const v0 = FC.classifyFailure({ error: err, itemType: 'content', source: 'browser_executor', outputSummary: {} });
    eq([v0.class, v0.paidRisk], ['B', 'none'], 'B sin riesgo de pago');
    let prev = null;
    for (let i = 0; i < 3; i++) prev = L.ladderStep(prev, v0, 'content', err, at(i), { retryable: true, autoRegenSpent: true }).state;
    eq(prev.rung, 3, 'agotada');
    const r = { status: 'failed', type: 'content', error: err, output_summary: { remediation: prev } };
    const vf = OR.itemFailureVerdict(r);
    assert(vf.remediationExhausted === true && OR.ownerRetryCodeEligibility(vf) === 'ok', 'elegible para el dueño');
    eq(OR.ownerRetryCodeEligibility({ ...vf, paidRisk: 'uncertain' }), 'ambiguous_paid_result', 'dinero primero');
    const view = RV.recoveryViewOf({ ...r, id: 'i1', failure_class: null }, at(5));
    assert(view.remediation && view.remediation.next === 'owner_retry' && /falla repetida con la misma causa; reintentar igual no lo arregla/.test(view.remediation.reasonText), JSON.stringify(view.remediation));
  });

  // ── Review r98: P0-1 / P1-1 / P1-2 / P1-3 / P2-* ───────────────────────────
  await check('P0-1 la escalera NO apaga el auto-heal de clase B: SCORM OUTPUT_TRUNCATED_MAX_TOKENS ×3 → sigue regenerate_split; agotada solo con las rondas propias usadas', async () => {
    const e = 'OUTPUT_TRUNCATED_MAX_TOKENS: la salida se cortó';
    const v = FC.classifyFailure({ error: e, itemType: 'scorm', source: 'browser_executor', outputSummary: {} });
    eq([v.class, v.strategy], ['B', 'regenerate_split'], 'veredicto');
    const policy = AH.DEFAULT_AUTO_HEAL_POLICY;
    // Vía real: applyRemediationLadder con autoRegenSpentFor (0 rondas usadas → no se agota; el feedback viaja en ellas).
    let os = {};
    const acts = [];
    for (let i = 0; i < 3; i++) {
      const row = { id: 's1', status: i < 2 ? 'retrying' : 'failed', type: 'scorm', attempt_count: i + 1, max_attempts: 3, output_summary: os };
      const st = await IT.applyRemediationLadder(fakeQr(row), row, e, true, v, at(i));
      acts.push(st.action); os = row.output_summary;
    }
    eq(acts, ['observe', 'feedback', 'feedback'], 'sin agotar mientras queden rondas B');
    assert(L.remediationFeedbackOf(os), 'el feedback viaja en la regeneración');
    const failed = { id: 's1', status: 'failed', type: 'scorm', error: e, output_summary: os, finished_at: at(-600), updated_at: at(-600), failure_class: 'B', run_created_at: at(-700) };
    const d = AH.autoHealDecision(failed, at(10), policy);
    eq([d.heal, d.kind, d.strategy, d.round], [true, 'B', 'regenerate_split', 1], 'auto-heal B intacto');
    // Aunque la marca diga agotada (llamada directa sin la opción), el auto-heal B gana mientras le queden rondas.
    let p = null;
    for (let i = 0; i < 3; i++) p = L.ladderStep(p, v, 'scorm', e, at(i), { retryable: true }).state;
    eq(p.rung, 3, 'marca agotada');
    eq(AH.autoHealDecision({ ...failed, output_summary: { remediation: p } }, at(10), policy).heal, true, 'rondas B primero');
    // Con las rondas propias usadas → recién ahí agotada y sin reabrir.
    const spent = { remediation: p, autoHeal: { rounds: 0, regenRounds: AH.autoRegenMaxRoundsFor('scorm', v.code, policy) } };
    assert(AH.autoRegenSpentFor({ ...failed, output_summary: spent }, at(10), policy, ENV_ON), 'rondas usadas');
    eq(AH.autoHealDecision({ ...failed, output_summary: spent }, at(10), policy), { heal: false, reason: 'remediation_exhausted' }, 'agotada tras sus rondas');
    for (const [err, t] of [['llm_output_invalid: x', 'content'], ['scorm_invalid: x', 'scorm'], ['gift_invalid: x', 'exam'], ['CONTENT_TRUTH: persisten 2 oraciones', 'content'], ['v3_payload_invalid [SCHEMA_MISSING]: x', 'experience']]) {
      const vv = FC.classifyFailure({ error: err, itemType: t, source: 'browser_executor', outputSummary: {} });
      assert(vv.class === 'B', `${err}: B`);
      assert(!AH.autoRegenSpentFor({ id: 'z', status: 'failed', type: t, error: err, output_summary: {}, finished_at: at(0), updated_at: at(0), failure_class: vv.class }, at(0), policy, ENV_ON), `${err}: rondas B disponibles → la escalera no se agota`);
    }
  });
  await check('RR-P2a una sola fuente de verdad: con el barrido apagado (DYNAMIC_AUTO_HEAL_ENABLED=false) la escalera SÍ se agota al 3.er fallo; deny-list / reintento seguro / sin clasificar → «sin rondas»', async () => {
    const e = 'OUTPUT_TRUNCATED_MAX_TOKENS: la salida se cortó';
    const v = FC.classifyFailure({ error: e, itemType: 'scorm', source: 'browser_executor', outputSummary: {} });
    const row = { id: 's2', status: 'failed', type: 'scorm', error: e, output_summary: {}, finished_at: at(0), updated_at: at(0), failure_class: 'B' };
    assert(!AH.autoRegenSpentFor(row, at(0), AH.DEFAULT_AUTO_HEAL_POLICY, ENV_ON), 'barrido encendido: quedan rondas');
    assert(AH.autoRegenSpentFor(row, at(0), AH.DEFAULT_AUTO_HEAL_POLICY, ENV_TICK_OFF), 'barrido apagado: ninguna ronda va a venir');
    // Vía real (applyRemediationLadder lee process.env): con el barrido apagado, 3.er fallo → agotada.
    process.env.DYNAMIC_AUTO_HEAL_ENABLED = 'false';
    try {
      let os = {};
      const acts = [];
      for (let i = 0; i < 3; i++) {
        const r = { id: 's2', status: 'failed', type: 'scorm', attempt_count: 3, max_attempts: 3, output_summary: os };
        acts.push((await IT.applyRemediationLadder(fakeQr(r), r, e, true, v, at(i))).action); os = r.output_summary;
      }
      eq(acts, ['observe', 'feedback', 'exhausted'], 'agotada sin barrido');
    } finally { delete process.env.DYNAMIC_AUTO_HEAL_ENABLED; }
    // Sin clasificar (mensaje libre) o con la deny-list: el barrido no la toma → «sin rondas».
    assert(AH.autoRegenSpentFor({ ...row, error: 'provider_reconciliation_required: anthropic …', failure_class: 'B' }, at(0), AH.DEFAULT_AUTO_HEAL_POLICY, ENV_ON), 'deny-list');
  });
  await check('RR-P2b corrupt_dependency del navegador (mensaje A, clase registrada B) con marca agotada → el auto-heal sigue regenerando (regenerate_targeted)', async () => {
    const err = 'Error de red: fetch failed';
    const vA = FC.classifyFailure({ error: err, itemType: 'experience', source: 'browser_executor', outputSummary: {} });
    eq(vA.class, 'A', 'el mensaje solo es A');
    const vB = FC.classifyFailure({ error: err, errorCode: 'context_package_failed', itemType: 'experience', source: 'browser_executor', outputSummary: {} });
    eq([vB.class, vB.rule], ['B', 'corrupt_dependency'], 'el errorCode lo sube a B');
    let p = null;
    for (let i = 0; i < 3; i++) p = L.ladderStep(p, vB, 'experience', err, at(i), { retryable: true }).state;
    eq(p.rung, 3, 'marca agotada');
    const row = { id: 'c1', status: 'failed', type: 'experience', error: err, output_summary: { remediation: p }, finished_at: at(-600), updated_at: at(-600), failure_class: 'B', run_created_at: at(-700) };
    const d = AH.autoHealDecision(row, at(10), AH.DEFAULT_AUTO_HEAL_POLICY);
    eq([d.heal, d.kind, d.strategy], [true, 'B', 'regenerate_targeted'], 'misma decisión que el barrido');
    assert(!AH.autoRegenSpentFor(row, at(10), AH.DEFAULT_AUTO_HEAL_POLICY, ENV_ON), 'y la escalera lo ve igual');
  });
  await check('RR-P2c claim_payload_unavailable queda FUERA de la escalera (lo resuelve su barrido) y el estado agotado va después de los barridos automáticos', async () => {
    const err = 'claim_payload_unavailable: falta el dato de video:c1 (youtubeId)';
    const v = FC.classifyFailure({ error: err, itemType: 'video_interactions', source: 'browser_executor', outputSummary: {} });
    assert(L.ladderStep(null, v, 'video_interactions', err, T0, { retryable: true }) === null, 'fuera de la escalera');
    const src = fs.readFileSync(path.join(REPO, 'src/modules/reliability/recovery-state.ts'), 'utf8');
    const iAuto = src.indexOf("if (cur === 'auto_heal' || cur === 'auto_regenerate' || cur === 'safe_auto_retry' || cur === 'spend_control_resume')");
    const iExh = src.indexOf('if (remediationBlocksAuto(os, error))');
    assert(iAuto > 0 && iExh > iAuto, 'agotada después de auto_heal / auto_regenerate / claim incompleto');
  });
  await check('RR-P1 audiolibro aceptado en rung 2 → al completar la marca se CONSERVA, el desenlace es «accepted» y el paquete trae el aviso', async () => {
    const SCH = loadDist('modules/dynamic-generation/scheduler.service.js');
    const q = L.withQualityWarning(undefined, { ...L.qualityAcceptance(['AUDIOBOOK_LANGUAGE_NOT_NEUTRAL'], ['«laburo»'], T0, 'fp'), section: 1, messageId: 'm1' });
    const os = { quality: q, audiobookSections: { 0: { messageIds: ['m1'] } } };
    // completeItemDetailed del worker del audiolibro: sin validación v3 (skip) y sin marca de prevalidateV3.
    eq(SCH.completionQualityPatch(null, 'skip', 'audiobook_chapter', os), {}, 'la marca del worker no se toca');
    const merged = SCH.mergeOutputSummary(os, { ...SCH.completionQualityPatch(null, 'skip', 'audiobook_chapter', os), artifactIds: ['a1'] });
    assert(merged.ok && merged.merged.quality && merged.merged.quality.degraded === true, 'marca conservada');
    // Desenlace de recordItemCompleted: 'accepted' ⇔ rung 2 y quality.degraded = true (misma regla que su SQL).
    const al = fs.readFileSync(path.join(REPO, 'src/modules/reliability/attempt-log.ts'), 'utf8');
    assert(/= 2\s+and \(output_summary->'quality'->>'degraded'\) = 'true' then 'accepted'/.test(al), 'regla del desenlace');
    eq(PW.qualityAcceptedWarnings(new Map([['audio:c1', { itemKey: 'audio:c1', outputSummary: merged.merged }]])), ['quality_accepted:audio:c1:AUDIOBOOK_LANGUAGE_NOT_NEUTRAL'], 'aviso del paquete');
    // v3 / contenido: la marca vieja se borra si esta validación no degradó; con aceptación nueva, la reemplaza.
    eq(SCH.completionQualityPatch(null, 'valid', 'experience', { quality: q }), { quality: null }, 'v3 sin degradar: fuera la vieja');
    eq(SCH.completionQualityPatch(null, 'skip', 'content', { quality: q }), { quality: null }, 'capítulo sin degradar: fuera la vieja');
    eq(SCH.completionQualityPatch(null, 'skip', 'experience', {}), {}, 'nada que borrar');
    const acc = L.qualityAcceptance(['LANGUAGE_NOT_NEUTRAL'], ['x'], T0, 'fp2');
    eq(SCH.completionQualityPatch(acc, 'valid', 'experience', { quality: q }).quality.warnings.length, 1, 'aceptación nueva reemplaza');
  });
  await check('P1-1 D hold_for_human y sin clasificar NO entran a la escalera (sin feedback, sin intento extra, sin «Falla común» por colapso de huellas)', async () => {
    for (const [err, t, src] of [['algo raro pasó en el navegador', 'content', 'browser_executor'], ['TypeError: x is undefined', 'content', 'browser_executor'],
      ['EXAM_BANK_LEAF_CAPACITY: no hay texto suficiente', 'exam', 'provider_worker'], ['llm_output_cut_repeated: la salida se cortó dos veces', 'content', 'provider_worker'],
      ['claim_payload_unavailable: PEDAGOGY_DIRECTIVE_UNKNOWN', 'content', 'browser_executor']]) {
      const v = FC.classifyFailure({ error: err, itemType: t, source: src, outputSummary: {} });
      assert(!L.isDeterministicVerdict(v), `${err}: ${v.class}/${v.strategy}/${v.unclassified}`);
      assert(L.ladderStep(null, v, t, err, T0, { retryable: true }) === null, `${err}: fuera de la escalera`);
    }
    eq(L.LADDER_D_CODES, [], 'lista explícita de D (vacía)');
  });
  await check('P1-2 pago incierto / piso de dinero: fuera de la escalera; el estado sigue siendo la conciliación (automática)', async () => {
    const v = { ...verdictOf(LANG(1, 'a')), paidRisk: 'uncertain' };
    assert(!L.isDeterministicVerdict(v) && L.ladderStep(null, v, 'audiobook_chapter', LANG(1, 'a'), T0, { retryable: true }) === null, 'incierto');
    assert(!L.isDeterministicVerdict({ ...verdictOf(LANG(1, 'a')), moneyFloor: true }), 'piso de dinero');
    // Fila con una marca vieja de agotada y un error de conciliación: manda la conciliación, nunca failed_no_strategies.
    const err = 'provider_reconciliation_required: openai TTS chunk 2/4 (persisted 1): corte de conexión';
    const os = { remediation: { ...run([LANG(1, 'a'), LANG(2, 'a'), LANG(3, 'a'), LANG(4, 'a')]).state, exhaustedError: err } };
    const src = fs.readFileSync(path.join(REPO, 'src/modules/reliability/recovery-state.ts'), 'utf8');
    assert(src.indexOf("if (cur === 'provider_reconcile' || cur === 'ambiguous_audio_resubmit')") < src.indexOf('if (remediationBlocksAuto(os, error))'), 'la conciliación va antes');
    const vs = RS.recoveryStateOf({ id: 'x', status: 'failed', type: 'audiobook_chapter', error: err, output_summary: os, finished_at: at(-5), updated_at: at(-5), attention_reason: 'duplicate_charge' }, at(0));
    assert(vs.state !== 'failed_no_strategies' || vs.reason !== 'remediation_exhausted', JSON.stringify(vs));
  });
  await check('P1-3 un reintento humano (dueño/admin) abre un ciclo nuevo: count=1, sin agotada; el próximo fallo igual vuelve a rung 1 (con intento) y después rung 2', async () => {
    const { state } = run([LANG(1, 'a'), LANG(2, 'a'), LANG(3, 'a'), LANG(4, 'a')]);
    eq(state.rung, 3, 'agotada');
    const reset = L.resetRemediationForManualRetry(state, at(10));
    eq([reset.count, reset.rung, reset.exhaustedError, reset.acceptCodes.length, reset.grants], [1, 1, null, 0, 0], 'ciclo nuevo');
    assert(reset.feedback === state.feedback && reset.grantsTotal === state.grantsTotal && reset.tried.some((t) => t.outcome === 'manual_retry'), 'conserva feedback, total y rastro');
    assert(!L.remediationBlocksAuto({ remediation: reset }, LANG(4, 'a')), 'sin marca de agotada');
    assert(L.remediationFeedbackOf({ remediation: reset }), 'el intento del dueño ya lleva el pedido corregido');
    const s2 = L.ladderStep(reset, verdictOf(LANG(5, 'a')), 'audiobook_chapter', LANG(5, 'a'), at(11), { retryable: true });
    const s3 = L.ladderStep(s2.state, verdictOf(LANG(6, 'a')), 'audiobook_chapter', LANG(6, 'a'), at(12), { retryable: true });
    eq([s2.action, s2.grant, s3.action], ['feedback', true, 'accept'], 'vuelve a rung 1 (intento) y rung 2');
    const rs = fs.readFileSync(path.join(REPO, 'src/modules/dynamic-generation/runs.service.ts'), 'utf8');
    assert(/const remediationReset = !auto \? resetRemediationForManualRetry\(remediationOf\(target\.output_summary\)/.test(rs) && /\.\.\.\(remediationReset \? \{ remediation: remediationReset \} : \{\}\)/.test(rs), 'retryItem (manual) lo aplica en la misma escritura');
  });
  await check('P2-1 tope TOTAL de intentos de la escalera por parte (todas las huellas, reintentos humanos incluidos): nunca se reinicia', async () => {
    eq(L.MAX_LADDER_GRANTS_PER_ITEM, 3, 'tope por parte');
    const OTHER = (n) => `v3_payload_invalid [LANGUAGE_NOT_NEUTRAL]: experience:c1 voseo «${n}»`;
    let p = null;
    const grants = [];
    // huella A ×3 (2 intentos), huella B ×3 (solo 1 más: total 3), reintento humano, huella B ×2 (0 más).
    const seq = [[LANG(1, 'a'), 'audiobook_chapter'], [LANG(2, 'a'), 'audiobook_chapter'], [LANG(3, 'a'), 'audiobook_chapter'],
      ['AUDIOBOOK_SECTION_TOO_SHORT: bloque 1 corto', 'audiobook_chapter'], ['AUDIOBOOK_SECTION_TOO_SHORT: bloque 2 corto', 'audiobook_chapter'], ['AUDIOBOOK_SECTION_TOO_SHORT: bloque 3 corto', 'audiobook_chapter']];
    for (const [e, t] of seq) { const s = L.ladderStep(p, verdictOf(e, t), t, e, T0, { retryable: true }); grants.push(s.grant); p = s.state; }
    eq(grants, [false, true, true, false, true, false], 'tercer intento y no más');
    eq(p.grantsTotal, 3, 'total');
    p = L.resetRemediationForManualRetry(p, at(20));
    const s = L.ladderStep(p, verdictOf('AUDIOBOOK_SECTION_TOO_SHORT: bloque 4 corto'), 'audiobook_chapter', 'AUDIOBOOK_SECTION_TOO_SHORT: bloque 4 corto', at(21), { retryable: true });
    eq([s.action, s.grant, s.state.grantsTotal], ['feedback', false, 3], 'tras el reintento humano: feedback sin intento extra');
    void OTHER;
  });
  // ── S: señal agregada «Falla común» ─────────────────────────────────────────
  const remAt = (code, iso, extra = {}) => ({ v: 1, fingerprint: `audiobook_chapter|${code}|validation_invalid|`, code, rule: 'validation_invalid', itemType: 'audiobook_chapter', innerCodes: [], count: 4, rung: 3, firstAt: iso, lastAt: iso, findings: ['«laburo» (regionalismo)'], feedback: 'x', acceptCodes: [], grants: 2, tried: [{ rung: 1, at: iso, outcome: 'failed_same_fingerprint' }], sampleError: LANG(1, 'laburo'), ...extra });
  const rowsFor = (hours) => hours.map((h, i) => ({ courseId: 100 + i, runId: `run-${i}`, itemKey: `audio:ch${i}`, itemType: 'audiobook_chapter', remediation: remAt('AUDIOBOOK_LANGUAGE_NOT_NEUTRAL', at(h * 60).toISOString()) }));
  await check('S ≥ 3 cursos distintos dentro de 24 h → una entrada (no por curso); 3 cursos repartidos en 3 días → nada; 2 cursos → nada', async () => {
    const sig = L.commonFailureSignals(rowsFor([0, 5, 20]), new Map(), at(21 * 60));
    eq([sig.length, sig[0].courses, sig[0].coursesInWindow, sig[0].status], [1, [100, 101, 102], 3, 'active'], 'activa');
    eq(L.commonFailureSignals(rowsFor([0, 30, 60]), new Map(), at(61 * 60)).length, 0, 'repartidos');
    eq(L.commonFailureSignals(rowsFor([0, 1]), new Map(), at(2 * 60)).length, 0, 'dos cursos');
    // El mismo curso varias veces no cuenta como cursos distintos.
    const same = rowsFor([0, 1, 2]).map((r) => ({ ...r, courseId: 7 }));
    eq(L.commonFailureSignals(same, new Map(), at(3 * 60)).length, 0, 'un solo curso');
  });
  await check('S resuelta: marca de admin posterior a la última aparición (vuelve si reaparece) o 72 h sin aparecer', async () => {
    const rows = rowsFor([0, 5, 20]);
    const fp = rows[0].remediation.fingerprint;
    const r1 = L.commonFailureSignals(rows, new Map([[fp, at(21 * 60).toISOString()]]), at(22 * 60))[0];
    eq([r1.status, r1.resolvedBy], ['resolved', 'admin'], 'admin');
    const r2 = L.commonFailureSignals(rows, new Map([[fp, at(10 * 60).toISOString()]]), at(22 * 60))[0];
    eq(r2.status, 'active', 'marca vieja: reapareció después');
    const r3 = L.commonFailureSignals(rows, new Map(), at((20 + 73) * 60))[0];
    eq([r3.status, r3.resolvedBy], ['resolved', 'quiet_72h'], '72 h');
  });
  await check('S reporte para desarrollo: huella, código/validador/tipo, primera y última vez, cursos y runs (solo ids), ejemplos, escalones, archivo+función, punto de partida', async () => {
    const s = L.commonFailureSignals(rowsFor([0, 5, 20]), new Map(), at(21 * 60))[0];
    const r = s.report;
    for (const needle of ['Falla común (bug probable): 3 cursos con la misma falla AUDIOBOOK_LANGUAGE_NOT_NEUTRAL', s.fingerprint, 'validador/regla: validation_invalid', 'tipo de parte: audiobook_chapter',
      s.firstSeen, s.lastSeen, '100, 101, 102', 'run-0, run-1, run-2', 'src/workers/provider-real/audio-scripts.ts — generateSectionScript', 'rung 3: agotado (falló igual)',
      'Ejemplos (recortados, sin secretos)', 'hallazgos:', 'Punto de partida sugerido: revisar el prompt del guion']) {
      assert(r.includes(needle), `falta «${needle}» en:\n${r}`);
    }
  });
  await check('S redacción: claves, tokens y emails nunca llegan al reporte (helper existente redactErrorExcerpt + emails)', async () => {
    const leaky = 'AUDIOBOOK_LANGUAGE_NOT_NEUTRAL: fallo con sk-ABCDEFGHIJKLMNOP1234 y Bearer abcdefghijklmnop.qrstuv para ana.perez@example.com ' + 'x'.repeat(800);
    const rows = rowsFor([0, 5, 20]).map((r) => ({ ...r, remediation: { ...r.remediation, sampleError: leaky, findings: ['token=supersecretvalue123 en ana.perez@example.com'] } }));
    const s = L.commonFailureSignals(rows, new Map(), at(21 * 60))[0];
    const all = s.report + JSON.stringify(s.samples);
    assert(!/sk-ABCDEFGHIJKLMNOP1234|abcdefghijklmnop\.qrstuv|ana\.perez@example\.com|supersecretvalue123/.test(all), all.slice(0, 600));
    assert(/sk-\[redacted\]/.test(all) && /\[email\]/.test(all), 'marcas de redacción');
    assert(s.samples.every((x) => (x.error || '').length <= 300), 'recortado');
  });
  await check('S mapa estático código → archivo/función junto a la tabla: cada archivo existe y emite el código', async () => {
    for (const [code, src] of Object.entries(FC.FAILURE_CODE_SOURCES)) {
      const f = path.join(REPO, 'src', src.file);
      assert(fs.existsSync(f), `${code}: falta ${src.file}`);
      assert(fs.readFileSync(f, 'utf8').includes(code), `${code} no aparece en ${src.file}`);
      assert(src.fn && src.hint, `${code}: fn/hint`);
    }
    assert(FC.FAILURE_CODE_SOURCES.AUDIOBOOK_LANGUAGE_NOT_NEUTRAL, 'el código del incidente está mapeado');
  });
  await check('S endpoint de admin + vista de Salud de cursos: GET common-failures, POST resolve (admin_audit_log), needs-attention con commonFailures; sin issues de GitHub', async () => {
    const ctl = fs.readFileSync(path.join(REPO, 'src/modules/dynamic-generation/admin-runs.controller.ts'), 'utf8');
    assert(/@Get\('common-failures'\)/.test(ctl) && /@Post\('common-failures\/resolve'\)/.test(ctl) && /@SuperAdminOnly\(\)/.test(ctl), 'endpoints de SUPER_ADMIN');
    const svc = fs.readFileSync(path.join(REPO, 'src/modules/dynamic-generation/admin-recovery.service.ts'), 'utf8');
    assert(/out\.commonFailures = \(await this\.listCommonFailuresCached\(\)\)\.filter\(\(x\) => x\.status === 'active'\)/.test(svc) && /commonFailuresListing\(all === '1' \|\| all === 'true'\)/.test(ctl), 'en needs-attention y en el endpoint');
    assert(/insert into public\.admin_audit_log/.test(svc) && !/api\.github\.com|octokit|issues/i.test(svc), 'marca en el log; nada hacia afuera');
    assert(/reasonText: REMEDIATION_EXHAUSTED_REASON/.test(svc), 'motivo claro en failedComponents');
  });

  await check('P2-3/P2-4/P2-5/P2-8 rung 0 no cuenta para «Falla común»; marca de calidad atada al intento; feedback nunca descartado en silencio; sin admin_audit_log → 200 con motivo', async () => {
    const rows = rowsFor([0, 5, 20]).map((r) => ({ ...r, remediation: { ...r.remediation, count: 1, rung: 0, tried: [] } }));
    eq(L.commonFailureSignals(rows, new Map(), at(21 * 60)).length, 0, 'rung 0 no cuenta');
    // P2-4: v3 → la marca es del artifact que se completa; audiolibro → solo bloques cuyo guion aceptado sigue.
    const sch = fs.readFileSync(path.join(REPO, 'src/modules/dynamic-generation/scheduler.service.ts'), 'utf8');
    assert(/const qualityPatch = completionQualityPatch\(acc\.quality \?\? null, pre\.kind, item\.type, item\.output_summary \?\? \{\}\);/.test(sch), 'v3: sin arrastre (completionQualityPatch, ver RR-P1)');
    const RP = loadDist('workers/provider-real/real-providers.js');
    const q = { degraded: true, warnings: [{ code: 'quality_accepted', section: 1, messageId: 'm-old' }, { code: 'quality_accepted', section: 2, messageId: 'm2' }] };
    eq(RP.pruneAudioQuality(q, { 0: { messageIds: ['m-new'] }, 1: { messageIds: ['m2'] } }).warnings.map((w) => w.messageId), ['m2'], 'bloque regenerado: marca vieja fuera');
    eq(RP.pruneAudioQuality(q, {}), undefined, 'sin bloques: sin marca');
    // P2-5: brief lleno → se recorta el brief, el feedback entra.
    const full = { version: 1, engineVersion: 1, generator: 'experience', directives: [], overridden: [], text: '\n\n── ' + GD.PEDAGOGY_PROMPT_MARKER + ' ──\n' + 'x'.repeat(3990 - 40), textSha256: 'y' };
    const fb = L.feedbackFor('LANGUAGE_NOT_NEUTRAL', [], ['«laburo»']);
    const b = GD.withRemediationFeedback(full, { type: 'experience' }, fb);
    assert(b.text.endsWith(fb) && b.text.length <= GD.PEDAGOGY_BRIEF_TEXT_MAX && b.text.includes(GD.PEDAGOGY_PROMPT_MARKER) && !b.feedbackDropped, 'feedback entra recortando el brief');
    // P2-8
    const svc = fs.readFileSync(path.join(REPO, 'src/modules/dynamic-generation/admin-recovery.service.ts'), 'utf8');
    assert(/to_regclass\('public\.admin_audit_log'\)/.test(svc) && /resolved: false, resolvedAt: null, message:/.test(svc), 'sin la tabla: 200 con motivo');
    // P2-2: consulta acotada por updated_at y needs-attention con la señal cacheada.
    assert(/where g\.updated_at >= \$1::timestamptz/.test(svc) && /listCommonFailuresCached\(\)/.test(svc), 'consulta acotada + caché');
  });

  // ── K: tope del gasto ───────────────────────────────────────────────────────
  await check('K ≤ MAX_LADDER_GRANTS intentos extra por huella; nunca con pago incierto ni si el emisor dice «no reintentable»', async () => {
    eq(L.MAX_LADDER_GRANTS, 2, 'tope');
    const { steps } = run([LANG(1, 'a'), LANG(2, 'b'), LANG(3, 'c'), LANG(4, 'd'), LANG(5, 'e')]);
    eq(steps.map((s) => s.grant), [false, true, true, false, false], 'grants');
    assert(steps.every((s) => s.state.grants <= L.MAX_LADDER_GRANTS), 'acotado');
    const { steps: nr } = run([LANG(1, 'a'), LANG(2, 'b'), LANG(3, 'c')], 'audiobook_chapter', { retryable: false });
    assert(nr.every((s) => !s.grant), 'no reintentable → sin intentos extra');
    const v = { ...verdictOf(LANG(1, 'a')), paidRisk: 'uncertain' };
    assert(L.ladderStep(null, v, 'audiobook_chapter', LANG(1, 'a'), T0, { retryable: true }) === null, 'pago incierto → fuera de la escalera (decide la conciliación)');
    const src = fs.readFileSync(path.join(REPO, 'src/workers/provider-real/real-providers.ts'), 'utf8');
    // Cada intento del guion sigue pasando por guard → reserva → llamada (presupuesto de la parte, tope del run).
    assert(/if \(!\(await guard\(deps, item, 'anthropic', llmCallEstimate\(scriptModel/.test(src) && /reservePaidCall\(deps\.finops/.test(src), 'guards de gasto por llamada');
  });
  await check('K un fallo transitorio en el medio no reinicia la cuenta; otra huella sí (y la anterior queda en `previous`)', async () => {
    let prev = null;
    const steps = [];
    for (const [e, t] of [[LANG(1, 'a'), 'audiobook_chapter'], ['lease_expired', 'audiobook_chapter'], [LANG(2, 'b'), 'audiobook_chapter']]) {
      const s = L.ladderStep(prev, verdictOf(e, t), t, e, T0, { retryable: true });
      if (s) { prev = s.state; steps.push(s.action); }
    }
    eq(steps, ['observe', 'feedback'], 'lease_expired no cuenta');
    const other = 'AUDIOBOOK_SECTION_TOO_SHORT: el guion del bloque 2 quedó con 40 palabras';
    const s = L.ladderStep(prev, verdictOf(other), 'audiobook_chapter', other, at(3), { retryable: true });
    eq([s.action, s.state.count, s.state.previous.length, s.state.previous[0].rung], ['observe', 1, 1, 1], 'huella nueva');
  });

  // ── P: marca de calidad en el informe del paquete ───────────────────────────
  await check('P output_summary.quality → aviso quality_accepted → hallazgo QUALITY_ACCEPTED (no bloquea)', async () => {
    const by = new Map([['audio:c1', { itemKey: 'audio:c1', outputSummary: { quality: { degraded: true, warnings: [{ code: 'quality_accepted', codes: ['AUDIOBOOK_LANGUAGE_NOT_NEUTRAL'] }] } } }], ['content:c1', { itemKey: 'content:c1', outputSummary: {} }]]);
    const w = PW.qualityAcceptedWarnings(by);
    eq(w, ['quality_accepted:audio:c1:AUDIOBOOK_LANGUAGE_NOT_NEUTRAL'], 'avisos');
    const f = QF.findingsFromPackageWarnings(w);
    assert(f.length === 1 && f[0].code === 'QUALITY_ACCEPTED' && f[0].blocksDelivery === false, JSON.stringify(f));
  });

  console.log(`\n${ok} OK · ${fail} con fallas`);
  process.exit(fail ? 1 : 0);
})();
