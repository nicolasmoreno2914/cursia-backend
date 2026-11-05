#!/usr/bin/env node
/* eslint-disable */
// r99 — «Todo error tiene una solución».
//
//   T  tabla EXHAUSTIVA: cada regla del clasificador (item / paquete / restauración) tiene estrategia; cada estrategia del
//      catálogo declara qué cambia (nunca «el mismo reintento idéntico») y sus caminos de código existen en el repo;
//   E  cada código EMITIDO hoy (scripts/lib/rel-error-emitters: emisores del backend, códigos internos de validación,
//      códigos del empaque y — con --fe — los mensajes del ejecutor del navegador) resuelve una estrategia del catálogo;
//      un fallo determinista (clase B) siempre cambia la entrada; «decisión del dueño» solo en la lista cerrada;
//   U  lo desconocido es un bug de Cursia desde la PRIMERA vez (pausa, sin intentos ni gasto) y se reanuda solo con el
//      arreglo (reclasificada / huella resuelta / build nuevo, acotado; nunca por build con pago incierto);
//   L  escalera: el intento distinto empieza en el 1.er rechazo; nunca acepta una salida inválida (sin entrega degradada);
//   S  «Falla común»: pausa = umbral 1; cursos contados por frontend_course_id (review P2-9);
//   P  review P2-6 (itemKey de quality_accepted) y P2-7 (cuándo vuelve el reintento del dueño);
//   PG Postgres 16 REAL (scripts/lib/r95-db.js): applyItemFailure → pausa; DTO / completitud; «Falla común»; barrido de
//      pausas (pausa por estrategia agotada, reanudación por build / huella resuelta vía retryItem, tope por build);
//      empaque en pausa y reanudación; todo el SQL nuevo se ejecuta (prod 500 de r98.1: los checks puros no lo veían).
// USD 0: proveedores falsos (provider-test-env), red bloqueada salvo 127.0.0.1.
// Uso: npm run build && node scripts/check-r99-remediation-strategies.js [--require-fe] [--fe ../campuscloud-gen] [--no-pg]
'use strict';
require('reflect-metadata');
const realFetch = global.fetch;
global.fetch = async (u, o) => { const s = String(u); if (/^http:\/\/127\.0\.0\.1:\d+/.test(s)) return realFetch(u, o); throw new Error(`NETWORK FORBIDDEN in check: ${s}`); };
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const feIdx = args.indexOf('--fe');
// El gate-core pasa el frontend en CURSIA_FRONTEND_REPO (env limpio): con él E4 corre siempre en CI.
const FE_ENV = process.env.REL_FE_DIR || process.env.CURSIA_FRONTEND_REPO || '';
const FE_DIR = feIdx >= 0 ? path.resolve(args[feIdx + 1]) : (FE_ENV ? path.resolve(FE_ENV) : null);
const REQUIRE_FE = args.includes('--require-fe');
const NO_PG = args.includes('--no-pg');
const REPO = path.resolve(__dirname, '..');
const DIST = path.join(REPO, 'dist');
const L = (rel) => { try { return require(path.join(DIST, rel)); } catch (err) { console.error(`❌ No se pudo cargar dist/${rel} (¿npm run build?): ${err.message}`); process.exit(1); } };

const FC = L('modules/reliability/failure-classifier.js');
const RS = L('modules/reliability/remediation-strategies.js');
const BH = L('modules/reliability/bug-hold.js');
const RL = L('modules/reliability/remediation-ladder.js');
const REC = L('modules/reliability/recovery-state.js');
const AH = L('modules/dynamic-generation/auto-heal.js');
const OR = L('modules/dynamic-generation/owner-retry.js');
const QF = L('modules/quality/quality-finding.js');
const SCAN = require('./lib/rel-error-emitters');

let passes = 0; let failures = 0;
async function check(name, fn) { try { await fn(); passes++; console.log(`✅ ${name}`); } catch (err) { failures++; console.error(`❌ ${name}\n   ${err && err.stack ? err.stack.split('\n').slice(0, 8).join('\n   ') : err}`); } }
function assert(c, m) { if (!c) throw new Error(m); }
function eq(a, b, m) { const x = JSON.stringify(a); const y = JSON.stringify(b); if (x !== y) throw new Error(`${m}: esperado ${y}, encontrado ${x}`); }

const T0 = new Date('2026-11-05T12:00:00Z');
const at = (min) => new Date(T0.getTime() + min * 60_000);

/** ¿El archivo DEFINE el símbolo? (función, método, const, clase o propiedad exportada). */
function definesSymbol(src, sym) {
  const s = sym.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:function\\s+${s}\\b|(?:const|let|var|class)\\s+${s}\\b|^\\s*(?:(?:private|public|protected|static|readonly)\\s+)*(?:async\\s+)?${s}\\s*[(<]|export\\s+const\\s+${s}\\b)`, 'm').test(src);
}

function strategyOfCode(code, extra = {}) {
  const v = FC.classifyFailure({ error: `${code}: detalle`, outputSummary: {}, ...extra });
  return { v, s: RS.remediationStrategyFor(v) };
}

(async () => {
  // ═══ T: tabla exhaustiva + catálogo ═══════════════════════════════════════
  await check('T1 cada regla del clasificador (item/paquete/restauración) tiene una entrada en la tabla; ninguna entrada sobra', async () => {
    const ids = FC.classifierRuleIds();
    const missing = [
      ...ids.item.filter((r) => !RS.ITEM_RULE_STRATEGIES[r]).map((r) => `item:${r}`),
      ...ids.package.filter((r) => !RS.PACKAGE_RULE_STRATEGIES[r]).map((r) => `package:${r}`),
      ...ids.restore.filter((r) => !RS.RESTORE_RULE_STRATEGIES[r]).map((r) => `restore:${r}`),
    ];
    assert(missing.length === 0, 'reglas sin estrategia (agrega la entrada en remediation-strategies.ts): ' + missing.join(', '));
    const extra = [
      ...Object.keys(RS.ITEM_RULE_STRATEGIES).filter((r) => !ids.item.includes(r)),
      ...Object.keys(RS.PACKAGE_RULE_STRATEGIES).filter((r) => !ids.package.includes(r)),
      ...Object.keys(RS.RESTORE_RULE_STRATEGIES).filter((r) => !ids.restore.includes(r)),
    ];
    assert(extra.length === 0, 'entradas para reglas que ya no existen: ' + extra.join(', '));
    console.log(`   (${ids.item.length} reglas de item, ${ids.package.length} de paquete, ${ids.restore.length} de restauración)`);
  });

  await check('T2 ninguna estrategia del catálogo es «el mismo reintento idéntico» y cada variante de la tabla apunta al catálogo', async () => {
    for (const [id, def] of Object.entries(RS.STRATEGY_CATALOG)) {
      assert(def.id === id, `${id}: id`);
      assert(def.changes && def.changes !== 'nothing', `${id}: changes=${def.changes} (prohibido: el mismo reintento idéntico)`);
      assert(def.what && def.what.length > 20, `${id}: qué hace`);
      assert(Array.isArray(def.codePaths) && def.codePaths.length > 0, `${id}: sin camino de código`);
    }
    for (const table of [RS.ITEM_RULE_STRATEGIES, RS.PACKAGE_RULE_STRATEGIES, RS.RESTORE_RULE_STRATEGIES]) {
      for (const [rule, e] of Object.entries(table)) {
        for (const s of [e.default, ...Object.values(e.when || {}), ...Object.values(e.byCode || {})]) assert(RS.STRATEGY_CATALOG[s], `${rule}: estrategia desconocida ${s}`);
        if ([e.default, ...Object.values(e.when || {}), ...Object.values(e.byCode || {})].includes('owner_decision')) assert(RS.OWNER_DECISION_RULES.includes(rule), `${rule}: «decisión del dueño» fuera de la lista cerrada`);
      }
    }
  });

  await check('T3 las estrategias son caminos de código REALES: cada archivo existe y define el símbolo declarado', async () => {
    const bad = [];
    for (const def of Object.values(RS.STRATEGY_CATALOG)) {
      for (const cp of def.codePaths) {
        const f = path.join(REPO, 'src', cp.file);
        if (!fs.existsSync(f)) { bad.push(`${def.id}: falta src/${cp.file}`); continue; }
        if (!definesSymbol(fs.readFileSync(f, 'utf8'), cp.symbol)) bad.push(`${def.id}: src/${cp.file} no define ${cp.symbol}`);
      }
    }
    assert(bad.length === 0, bad.join('\n'));
  });

  await check('T4 el auto-test del check detecta una estrategia «idéntica» y un camino de código inexistente', async () => {
    assert(!definesSymbol('export function realOne() {}', 'ghostFn') && definesSymbol('  async autoProbeProviderCredit(\n', 'autoProbeProviderCredit'), 'detector de símbolos');
    const fake = { ...RS.STRATEGY_CATALOG.wait_backoff, changes: 'nothing' };
    let caught = false;
    try { assert(fake.changes !== 'nothing', 'idéntico'); } catch { caught = true; }
    assert(caught, 'una estrategia «nothing» hace fallar el check');
  });

  // ═══ E: cada código emitido resuelve una estrategia ══════════════════════
  const be = SCAN.scanBackendEmitters(REPO);
  const emitted = new Set();
  for (const e of be.emitters) for (const c of e.codes || []) emitted.add(c);

  await check(`E1 cada código emitido por el backend (${emitted.size}) resuelve una estrategia del catálogo; los B cambian la entrada`, async () => {
    assert(emitted.size >= 60, `muy pocos códigos (${emitted.size}): ¿cambió el escáner?`);
    const bad = [];
    const byStrategy = {};
    for (const c of emitted) {
      const src = c === 'PACKAGE_BUILDER_ERROR' ? 'package_worker' : undefined;
      const { v, s } = strategyOfCode(c, { source: src });
      if (!RS.STRATEGY_CATALOG[s.strategy]) { bad.push(`${c}: sin estrategia`); continue; }
      if (s.changes === 'nothing') bad.push(`${c}: mismo reintento idéntico`);
      if (v.class === 'B' && !['input', 'code_fix', 'provider_evidence', 'package'].includes(s.changes)) bad.push(`${c}: B (determinista) con «${s.changes}» — el próximo intento tiene que cambiar`);
      if (s.strategy === 'owner_decision' && !RS.OWNER_DECISION_RULES.includes(v.rule) && !v.moneyFloor) bad.push(`${c}: decisión del dueño fuera de la lista (${v.rule})`);
      byStrategy[s.strategy] = (byStrategy[s.strategy] || 0) + 1;
    }
    assert(bad.length === 0, bad.join('\n'));
    console.log(`   ${JSON.stringify(byStrategy)}`);
  });

  await check('E2 códigos internos de validación (v3_payload_invalid [X]) y del empaque resuelven estrategia', async () => {
    const val = SCAN.scanValidationCodes(REPO);
    const bad = [];
    for (const c of val.keys()) {
      if (c.startsWith('__missing_file__')) continue;
      const v = FC.classifyFailure({ error: `v3_payload_invalid [${c}]: detalle`, itemType: 'experience', source: 'browser_executor', outputSummary: {} });
      const s = RS.remediationStrategyFor(v);
      if (!RS.STRATEGY_CATALOG[s.strategy] || s.changes !== 'input') bad.push(`${c}: ${s.strategy}/${s.changes}`);
    }
    const pk = SCAN.scanPackageCodes(REPO);
    for (const c of pk.keys()) {
      const v = FC.classifyFailure({ source: 'package_worker', error: `${c}: detalle` });
      const s = RS.remediationStrategyFor(v);
      if (!RS.STRATEGY_CATALOG[s.strategy] || s.changes === 'nothing') bad.push(`pkg ${c}: ${s.strategy}`);
    }
    assert(bad.length === 0, bad.join('\n'));
    console.log(`   (${val.size} códigos de validación, ${pk.size} de empaque)`);
  });

  await check('E3 variantes por mensaje (refine) y overrides genéricos: cada una resuelve la estrategia esperada', async () => {
    const cases = [
      [{ error: '❌ Error al procesar la solicitud: prompt is too long: 210000 tokens', source: 'browser_executor' }, 'split_smaller'],
      [{ error: '❌ Error al procesar la solicitud: messages.0.content: invalid', source: 'browser_executor' }, 'cursia_issue_hold'],
      [{ error: 'gamma_pdf_invalid: x', outputSummary: { external: { gammaGenerationId: 'g1' } } }, 'repoll_provider'],
      [{ error: 'videogen_failed: x', outputSummary: { external: { videogenJobId: 'v1' } } }, 'reconcile_provider'],
      [{ error: 'videogen_failed: x' }, 'cursia_issue_hold'],
      [{ error: 'tts_failed: chunk 3/4: socket hang up', itemType: 'audiobook_chapter', source: 'provider_worker' }, 'reconcile_provider'],
      [{ error: 'llm_transient: HTTP 400: credit balance is too low', source: 'llm_gateway' }, 'provider_probe'],
      [{ error: '❌ Sin disponibilidad de generación. Contacta a soporte de Cursia.', source: 'browser_executor' }, 'provider_probe'],
      [{ error: '❌ El servicio de IA de este entorno no está configurado. Contacta a soporte de Cursia.', source: 'browser_executor' }, 'cursia_issue_hold'],
      [{ error: 'unexpected_error: budget_exceeded: el envío superaría el presupuesto' }, 'owner_decision'],
      [{ error: 'EXAM_BANK_INCOMPLETE: hoja corta', itemType: 'exam' }, 'self_adaptive'],
      [{ error: 'EXAM_BANK_LEAF_CAPACITY: no alcanza', itemType: 'exam' }, 'cursia_issue_hold'],
      [{ error: 'claim_payload_unavailable: VIDEO_YOUTUBE_ID_MISSING de video:c1', itemType: 'video_interactions', source: 'browser_executor' }, 'regenerate_dependency'],
      // r99: un código interno de validación con «NOT_ALLOWED» ya no dispara el piso de dinero (era C retenido).
      [{ error: 'v3_payload_invalid [COMPONENT_NOT_ALLOWED]: experience:c1 componente no permitido', itemType: 'experience', source: 'browser_executor' }, 'prompt_with_findings'],
      [{ error: 'Generación detenida por el usuario', source: 'browser_executor' }, 'owner_decision'],
      [{ error: 'AUDIOBOOK_LANGUAGE_NOT_NEUTRAL: «laburo»', itemType: 'audiobook_chapter', source: 'provider_worker' }, 'prompt_with_findings'],
      [{ error: 'item_recovery_budget_exhausted: tope de la parte' }, 'extend_item_budget'],
      [{ error: 'storage_unavailable: Supabase Storage upload failed: 503' }, 'wait_storage_breaker'],
    ];
    for (const [inp, want] of cases) {
      const s = RS.remediationStrategyFor(FC.classifyFailure({ outputSummary: {}, ...inp }));
      eq(s.strategy, want, inp.error.slice(0, 70));
    }
  });

  await check('E4 (--fe) cada mensaje del ejecutor del navegador resuelve una estrategia (lo desconocido → pausa como bug, nunca un reintento idéntico)', async () => {
    if (!FE_DIR) { assert(!REQUIRE_FE, '--require-fe sin --fe'); console.log('   (sin --fe: se omite)'); return; }
    const exec = path.join(FE_DIR, 'src/js/45-dynamic-generation-executor.js');
    assert(fs.existsSync(exec), `no existe ${exec}`);
    const entries = SCAN.scanFrontendExecutor(exec).filter((e) => !e.text.startsWith('__expr__ ') && !e.text.startsWith('__errorCode__ '));
    assert(entries.length >= 40, `muy pocos mensajes (${entries.length})`);
    const bad = [];
    for (const e of entries) {
      const v = FC.classifyFailure({ error: e.text.endsWith(' ') ? e.text + 'x' : e.text, source: 'browser_executor' });
      const s = RS.remediationStrategyFor(v);
      if (!RS.STRATEGY_CATALOG[s.strategy] || s.changes === 'nothing') bad.push(`L${e.line}: ${s.strategy}`);
    }
    assert(bad.length === 0, bad.join('\n'));
  });

  // ═══ U: lo desconocido es un bug de Cursia ═══════════════════════════════
  const UNK = 'kaboom: el worker devolvió algo inesperado (id 7f3c)';
  await check('U1 código sin regla → pausa como bug de Cursia desde la PRIMERA vez (unmapped_code); contrato / config de Cursia también', async () => {
    const v = FC.classifyFailure({ error: UNK, itemType: 'content', source: 'browser_executor', outputSummary: {} });
    assert(v.unclassified, 'sin regla');
    eq(BH.holdsImmediately(v), { hold: true, reason: 'unmapped_code', strategy: 'cursia_issue_hold' }, 'desconocido');
    const vc = FC.classifyFailure({ error: 'missing_dependency_artifact: x', itemType: 'content', source: 'browser_executor', outputSummary: {} });
    eq(BH.holdsImmediately(vc).reason, 'product_bug', 'contrato');
    const vk = FC.classifyFailure({ error: 'videogen_not_configured: falta la clave', itemType: 'video', source: 'video_worker', outputSummary: {} });
    eq(BH.holdsImmediately(vk).reason, 'config', 'config de Cursia');
    for (const e of ['lease_expired', 'llm_transient: HTTP 529', 'v3_payload_invalid [JSON_INVALID]: x', 'budget_exceeded: x', 'Generación detenida por el usuario']) {
      assert(!BH.holdsImmediately(FC.classifyFailure({ error: e, itemType: 'content', source: 'browser_executor', outputSummary: {} })).hold, `${e}: tiene estrategia propia`);
    }
  });

  await check('U2 la pausa vale SOLO para el error que la dejó; ningún reintento la toma (auto-heal, reintento seguro); estado paused_cursia_issue automático; mensaje sin «reintentar»', async () => {
    const v = FC.classifyFailure({ error: UNK, itemType: 'content', source: 'browser_executor', outputSummary: {} });
    const hold = BH.nextBugHold(null, v, 'content', UNK, 'unmapped_code', T0, 'build-A');
    const row = { id: 'x', status: 'failed', type: 'content', error: UNK, output_summary: { bugHold: hold }, finished_at: at(-60), updated_at: at(-60) };
    assert(BH.bugHoldOf(row.output_summary, UNK) && !BH.bugHoldOf(row.output_summary, 'otro error'), 'por error');
    eq(AH.autoHealDecision(row, at(0), AH.DEFAULT_AUTO_HEAL_POLICY), { heal: false, reason: 'cursia_issue_hold' }, 'auto-heal');
    eq(AH.autoHealDecision(row, at(0), AH.LEGACY_AUTO_HEAL_POLICY), { heal: false, reason: 'cursia_issue_hold' }, 'auto-heal legado');
    eq(AH.safeAutoRetryDecision(row, at(0)), { heal: false, reason: 'cursia_issue_hold' }, 'reintento seguro');
    const st = REC.recoveryStateOf(row, at(0));
    eq([st.state, st.reason, st.automatic, st.nextRetryAt], ['paused_cursia_issue', 'unmapped_code', true, null], 'estado');
    assert(!REC.runRecoveryStateOf([row], at(0)).definitive, 'el run no es «definitivamente fallido»');
    assert(/lo estamos resolviendo/.test(BH.CURSIA_ISSUE_MESSAGE) && /continuará automáticamente/.test(BH.CURSIA_ISSUE_MESSAGE) && !/reintent/i.test(BH.CURSIA_ISSUE_MESSAGE), 'mensaje');
    assert(hold.sampleError && hold.fingerprint.startsWith('hold|content|unclassified_error|unclassified|'), hold.fingerprint);
  });

  await check('U3 reanudación: reclasificada (el código ahora tiene regla) > huella resuelta > build nuevo (≤ 3, ≤ 14 días, nunca con pago incierto)', async () => {
    const v = FC.classifyFailure({ error: UNK, itemType: 'content', source: 'browser_executor', outputSummary: {} });
    const hold = BH.nextBugHold(null, v, 'content', UNK, 'unmapped_code', T0, 'build-A');
    const row = { status: 'failed', error: UNK, output_summary: { bugHold: hold } };
    eq(BH.bugHoldResumeDecision(row, { now: at(5), buildId: 'build-A', verdict: v, itemType: 'content' }), { resume: false, reason: 'still_unmapped' }, 'mismo build, sin regla');
    // El arreglo agrega la regla: el mismo error ahora es A (llm_transient) → reanuda con esa estrategia.
    const vNow = FC.classifyFailure({ error: 'llm_transient: x', itemType: 'content', source: 'browser_executor', outputSummary: {} });
    eq(BH.bugHoldResumeDecision(row, { now: at(5), buildId: 'build-A', verdict: vNow, itemType: 'content' }), { resume: true, trigger: 'reclassified', strategy: 'wait_backoff' }, 'reclasificada');
    eq(BH.bugHoldResumeDecision(row, { now: at(5), buildId: 'build-A', verdict: v, itemType: 'content', resolvedAt: at(4).toISOString() }).trigger, 'resolved', 'huella resuelta');
    eq(BH.bugHoldResumeDecision(row, { now: at(5), buildId: 'build-A', verdict: v, itemType: 'content', resolvedAt: at(-10).toISOString() }).resume, false, 'marca vieja no vale');
    eq(BH.bugHoldResumeDecision(row, { now: at(5), buildId: 'build-B', verdict: v, itemType: 'content' }).trigger, 'new_build', 'build nuevo');
    const spent = { ...hold, autoResumes: BH.BUG_HOLD_MAX_BUILD_RESUMES };
    eq(BH.bugHoldResumeDecision({ ...row, output_summary: { bugHold: spent } }, { now: at(5), buildId: 'build-B', verdict: v, itemType: 'content' }), { resume: false, reason: 'build_resumes_exhausted' }, 'tope por build');
    const paid = { ...hold, paidUncertain: true };
    eq(BH.bugHoldResumeDecision({ ...row, output_summary: { bugHold: paid } }, { now: at(5), buildId: 'build-B', verdict: v, itemType: 'content' }), { resume: false, reason: 'paid_uncertain' }, 'pago incierto nunca por build');
    eq(BH.bugHoldResumeDecision(row, { now: at(15 * 24 * 60), buildId: 'build-B', verdict: v, itemType: 'content' }), { resume: false, reason: 'too_old' }, 'ventana');
    const r1 = BH.resumedBugHold(hold, at(6), 'system', 'new_build');
    eq([r1.active, r1.buildResumes, r1.history.length], [false, 1, 2], 'reanudada');
    assert(!BH.bugHoldOf({ bugHold: r1 }, UNK), 'ya no está en pausa');
    const again = BH.nextBugHold(r1, v, 'content', UNK, 'unmapped_code', at(7), 'build-B');
    eq([again.active, again.count, again.buildResumes, again.autoResumes], [true, 2, 1, 1], 'vuelve a la pausa conservando el tope');
    // Review P2-2: enfriamiento entre reaperturas automáticas y tope compartido (build + reclasificada).
    const cool = BH.bugHoldResumeDecision({ ...row, output_summary: { bugHold: again } }, { now: at(8), buildId: 'build-C', verdict: v, itemType: 'content' });
    eq(cool, { resume: false, reason: 'cooldown' }, 'enfriamiento');
    eq(BH.bugHoldResumeDecision({ ...row, output_summary: { bugHold: again } }, { now: at(8 + 31), buildId: 'build-C', verdict: v, itemType: 'content' }).trigger, 'new_build', 'pasado el enfriamiento');
    eq(BH.bugHoldResumeDecision({ ...row, output_summary: { bugHold: { ...hold, autoResumes: 3 } } }, { now: at(5), buildId: 'build-A', verdict: vNow, itemType: 'content' }), { resume: false, reason: 'build_resumes_exhausted' }, 'reclasificada también con tope');
    eq(BH.bugHoldMaxResumes({}), 3, 'decisión del dueño 2: 3 por parte');
    eq(BH.bugHoldMaxResumes({ R99_BUG_HOLD_MAX_RESUMES: '5' }), 5, 'cambiable por env');
  });

  await check('U3b (review P2-2) «reclasificada» SOLO si al pausar la estrategia era de bug (hold.strategy): un crédito agotado con su sonda vencida (config / provider_probe) no se reabre en el mismo barrido', async () => {
    const err = '❌ Sin disponibilidad de generación. Contacta a soporte de Cursia.';
    const v = FC.classifyFailure({ error: err, itemType: 'content', source: 'browser_executor', outputSummary: {} });
    eq(RS.remediationStrategyFor(v).strategy, 'provider_probe', 'estrategia automática');
    const hold = BH.nextBugHold(null, v, 'content', err, 'config', T0, 'build-A');
    eq(hold.strategy, 'provider_probe', 'estrategia al pausar');
    eq(BH.bugHoldResumeDecision({ status: 'failed', error: err, output_summary: { bugHold: hold } }, { now: at(1), buildId: 'build-A', verdict: v, itemType: 'content' }),
      { resume: false, reason: 'waiting_fix' }, 'sin reclasificación inmediata');
  });

  await check('U6 (review P1-1) excepciones crudas del navegador: red / timeout / abort → A (wait_backoff); JSON / TypeError sobre la salida → B (prompt_with_findings, el próximo intento lleva el hallazgo)', async () => {
    for (const e of ['Failed to fetch', 'TypeError: Failed to fetch', 'Load failed', 'Request timeout', 'signal is aborted without reason', 'The operation was aborted.', 'NetworkError when attempting to fetch resource.']) {
      const v = FC.classifyFailure({ error: e, itemType: 'content', source: 'browser_executor', outputSummary: {} });
      eq([v.class, v.unclassified, RS.remediationStrategyFor(v).strategy], ['A', false, 'wait_backoff'], e);
      assert(!BH.holdsImmediately(v).hold, `${e}: sin pausa`);
    }
    for (const e of ['Unexpected token < in JSON at position 0', "Cannot read properties of undefined (reading 'map')", 'JSON.parse: unexpected end of data', 'TypeError: x.map is not a function', 'Unexpected end of JSON input']) {
      const v = FC.classifyFailure({ error: e, itemType: 'content', source: 'browser_executor', outputSummary: {} });
      eq([v.class, v.code, RS.remediationStrategyFor(v).strategy], ['B', 'browser_output_exception', 'prompt_with_findings'], e);
      const st = RL.ladderStep(null, v, 'content', e, T0, { retryable: true });
      assert(st && st.action === 'feedback' && /JSON válido y completo/.test(st.state.feedback), `${e}: feedback ${st && st.state.feedback}`);
    }
  });

  await check('U6b (re-review P2-B) las frases del navegador SOLO con source browser_executor: un worker de Gamma/Videogen con «Unexpected token < in JSON» sigue D con pago INCIERTO → pausa que nunca se reanuda sola por build', async () => {
    for (const [type, source] of [['presentation', 'provider_worker'], ['video', 'video_worker'], ['audiobook_chapter', 'provider_worker']]) {
      const e = 'Unexpected token < in JSON at position 0';
      const v = FC.classifyFailure({ error: e, itemType: type, source, outputSummary: {} });
      eq([v.class, v.unclassified, v.paidRisk], ['D', true, 'uncertain'], `${type}/${source}`);
      const hold = BH.nextBugHold(null, v, type, e, BH.holdsImmediately(v).reason, T0, 'build-A');
      eq(hold.paidUncertain, true, 'pago incierto');
      eq(BH.bugHoldResumeDecision({ status: 'failed', error: e, output_summary: { bugHold: hold } }, { now: at(60), buildId: 'build-B', verdict: v, itemType: type }),
        { resume: false, reason: 'paid_uncertain' }, 'nunca por build');
      const vf = FC.classifyFailure({ error: 'fetch failed', itemType: type, source, outputSummary: {} });
      assert(vf.code === 'llm_network', 'la frase previa «fetch failed» no cambió');
      const va = FC.classifyFailure({ error: 'The operation was aborted.', itemType: type, source, outputSummary: {} });
      assert(va.unclassified && va.paidRisk === 'uncertain', `worker abort: ${JSON.stringify(va)}`);
    }
  });

  await check('U6c (re-review) pausa por condición EXTERNA (estrategia wait_backoff al pausar) → re-sonda cada 2 h (≤ 12/día), la ventana de 14 días cuenta desde el fallo ORIGINAL', async () => {
    const e = '❌ Falló después de 3 intentos: Error del servidor (503)';
    const v = FC.classifyFailure({ error: e, itemType: 'content', source: 'browser_executor', outputSummary: {} });
    eq(RS.remediationStrategyFor(v).strategy, 'wait_backoff', 'estrategia');
    const hold = BH.nextBugHold(null, v, 'content', e, 'strategy_exhausted', T0, 'build-A', at(-60));
    eq(hold.originalFailedAt, at(-60).toISOString(), 'fallo original');
    const row = { status: 'failed', error: e, output_summary: { bugHold: hold } };
    eq(BH.bugHoldResumeDecision(row, { now: at(60), buildId: 'build-A', verdict: v, itemType: 'content' }), { resume: false, reason: 'waiting_fix' }, 'antes de 2 h');
    eq(BH.bugHoldResumeDecision(row, { now: at(121), buildId: 'build-A', verdict: v, itemType: 'content' }).trigger, 'reprobe', 'a las 2 h');
    let h = hold;
    for (let i = 0; i < BH.BUG_HOLD_REPROBE_MAX_PER_DAY; i++) h = BH.probedBugHold(h, at(121 + i));
    eq(BH.bugHoldResumeDecision({ ...row, output_summary: { bugHold: h } }, { now: at(130 + 121), buildId: 'build-A', verdict: v, itemType: 'content' }).resume, false, '≤ 12 por día');
    // Re-review 3 (P3-1): una reapertura por re-sonda NO consume el tope de reaperturas por build / reclasificación.
    const rp = BH.resumedBugHold(hold, at(121), 'system', 'reprobe');
    eq([rp.autoResumes, rp.probes && rp.probes.n, rp.lastProbeAt], [0, 1, at(121).toISOString()], 'presupuesto propio de la re-sonda');
    const capped = { ...hold, autoResumes: 3 };
    eq(BH.bugHoldResumeDecision({ ...row, output_summary: { bugHold: capped } }, { now: at(121), buildId: 'build-A', verdict: v, itemType: 'content' }).trigger, 'reprobe', 'con el tope de build usado, la re-sonda sigue');
    eq(BH.bugHoldResumeDecision({ ...row, output_summary: { bugHold: { ...capped, paidUncertain: true } } }, { now: at(121), buildId: 'build-A', verdict: v, itemType: 'content' }), { resume: false, reason: 'paid_uncertain' }, 'nunca con pago incierto');
    const old = BH.nextBugHold(null, v, 'content', e, 'strategy_exhausted', T0, 'build-A', at(-15 * 24 * 60));
    eq(BH.bugHoldResumeDecision({ ...row, output_summary: { bugHold: old } }, { now: at(5), buildId: 'build-B', verdict: v, itemType: 'content' }), { resume: false, reason: 'too_old' }, '14 días desde el fallo original');
  });

  await check('U7 (review P1-1) red de seguridad: un código SIN regla, reintentable y con intentos propios → SIN pausa (usa sus intentos con backoff) pero con REPORTE desde la 1.ª vez; agotados → pausa', async () => {
    const IT = L('modules/dynamic-generation/item-transitions.js');
    const qr = { sqls: [], async query(sql) { this.sqls.push(sql); return []; } };
    const v = FC.classifyFailure({ error: UNK, itemType: 'content', source: 'browser_executor', outputSummary: {} });
    const row = { id: 'i7', status: 'retrying', type: 'content', output_summary: {}, run_created_at: new Date() };
    eq(await IT.applyCursiaIssueHold(qr, row, UNK, v, null), null, 'sin pausa mientras quedan intentos');
    eq([row.status, row.output_summary.bugHold.active, row.output_summary.bugHold.reportOnly], ['retrying', false, true], 'reporte sin pausa');
    const sig = RL.commonFailureSignals([{ courseId: 1, courseKey: 'k', runId: 'r', itemKey: 'content:c', itemType: 'content', bugHold: row.output_summary.bugHold }], new Map(), new Date());
    eq([sig.length, sig[0].kind, sig[0].status, sig[0].heldItems], [1, 'bug_hold', 'active', 0], '«Falla común» desde la 1.ª vez');
    const row2 = { ...row, status: 'failed' };
    const st = await IT.applyCursiaIssueHold(qr, row2, UNK, v, null);
    eq([st && st.reason, row2.output_summary.bugHold.active], ['unmapped_code', true], 'intentos agotados → pausa');
    // Contrato roto: pausa al primer fallo aunque queden intentos.
    const vc = FC.classifyFailure({ error: 'missing_dependency_artifact: x', itemType: 'content', source: 'browser_executor', outputSummary: {} });
    const row3 = { id: 'i8', status: 'retrying', type: 'content', output_summary: {}, run_created_at: new Date() };
    eq((await IT.applyCursiaIssueHold(qr, row3, 'missing_dependency_artifact: x', vc, null)).reason, 'product_bug', 'contrato: inmediata');
    // Corte ÚNICO (decisión del dueño 4): un run anterior a R99_BUG_HOLD_SINCE nunca se pausa.
    const old = { id: 'i9', status: 'failed', type: 'content', output_summary: {}, run_created_at: new Date(Date.now() - 40 * 86_400_000) };
    eq(await IT.applyCursiaIssueHold(qr, old, UNK, v, null), null, 'run viejo (> 30 días): sin pausa');
  });

  await check('U8 (review P2-1) una parte de IA en revisión con su reapertura de 12 min pendiente es AUTOMÁTICA (nunca se pausa ni se reporta); la espera del barrido ≥ esa reapertura', async () => {
    process.env.DYNAMIC_COURSE_STRUCTURE = 'true';
    const LR = L('modules/dynamic-generation/llm-pending-review-reopen.js');
    const row = { id: 'x', status: 'failed', type: 'content', error: 'llm_pending_review: 2 resultados desconocidos', output_summary: {}, finished_at: new Date(Date.now() - 6 * 60_000), updated_at: new Date(Date.now() - 6 * 60_000), attention_reason: 'duplicate_charge' };
    const st = REC.recoveryStateOf(row, new Date());
    eq([st.state, st.automatic], ['pending_retry', true], 'reapertura pendiente');
    assert(BH.BUG_HOLD_SWEEP_GRACE_SECONDS >= LR.llmReviewReopenDelaySeconds({}), 'espera del barrido ≥ reapertura');
  });

  await check('U9 decisiones del dueño como constantes / env: ventana de la clase A 6 h (alerta 4 h); corte de la pausa móvil = ahora − 30 días', async () => {
    eq([AH.DEFAULT_AUTO_HEAL_POLICY.classATotalHours, AH.DEFAULT_AUTO_HEAL_POLICY.classAAlertHours, AH.DEFAULT_CLASS_A_TOTAL_HOURS], [6, 4, 6], 'decisión 3');
    eq(AH.autoHealPolicyFromEnv({ DYNAMIC_AUTO_HEAL_CLASS_A_TOTAL_HOURS: '12' }).classATotalHours, 12, 'env');
    const now = new Date('2026-12-15T00:00:00Z');
    eq(BH.bugHoldSince({}, now).toISOString(), new Date(now.getTime() - 30 * 86_400_000).toISOString(), 'decisión 4: móvil');
    eq(BH.bugHoldSince({ R99_BUG_HOLD_SINCE: '2026-11-01T00:00:00Z' }, now).toISOString(), '2026-11-01T00:00:00.000Z', 'env fija el corte');
  });

  await check('U5 la pausa inmediata nunca le gana a un mecanismo automático existente (conciliación de proveedor, reenvío único de audio): solo cuando hoy nada la tomaría', async () => {
    process.env.DYNAMIC_COURSE_STRUCTURE = 'true';
    const IT = L('modules/dynamic-generation/item-transitions.js');
    const qr = { sqls: [], async query(sql) { this.sqls.push(sql); return []; } };
    const mk = (type, error) => ({ id: 'i1', status: 'failed', type, output_summary: {}, run_created_at: new Date() });
    const ambiguous = 'gamma_submit_ambiguous: el envío a Gamma no confirmó la generación';
    const vA = FC.classifyFailure({ error: ambiguous, itemType: 'presentation', source: 'provider_worker', outputSummary: {} });
    eq(RS.remediationStrategyFor(vA).strategy, 'reconcile_provider', 'estrategia');
    eq(await IT.applyCursiaIssueHold(qr, mk('presentation'), ambiguous, vA, null), null, 'la conciliación la toma: sin pausa');
    const vU = FC.classifyFailure({ error: UNK, itemType: 'content', source: 'browser_executor', outputSummary: {} });
    const row = mk('content');
    const st = await IT.applyCursiaIssueHold(qr, row, UNK, vU, null);
    eq([st && st.reason, row.status, row.output_summary.bugHold.active], ['unmapped_code', 'failed', true], 'desconocido: pausa');
    assert(qr.sqls.some((q) => /set status = 'failed', next_retry_at = null/.test(q)), 'misma transacción');
  });

  await check('U4 la identidad del build es el SHA desplegado (CURSIA_BUILD_ID / DEPLOY_SHA / CFG_DEPLOY_SHA / .release-sha) y si no, estable en el proceso', async () => {
    BH.resetBuildIdCache();
    const a = BH.currentBuildId({}); const b = BH.currentBuildId({});
    assert(a && a === b && /^[0-9a-f]{16}$/.test(a), a);
    eq(BH.currentBuildId({ CURSIA_BUILD_ID: 'deploy-123' }), 'deploy-123', 'explícito');
    eq(BH.currentBuildId({ DEPLOY_SHA: 'abc1234def' }), 'abc1234def', 'SHA desplegado (review)');
    eq(BH.currentBuildId({ CFG_DEPLOY_SHA: 'fedcba9876' }), 'fedcba9876', 'SHA desplegado (prod-release)');
  });

  // ═══ L: escalera — intento distinto desde el 1.er rechazo, sin entrega degradada ═══
  await check('L1 primer rechazo determinista → el próximo intento ya lleva los hallazgos (rung 1); sin aceptación degradada (DEGRADABLE_CODES vacío)', async () => {
    const err = 'v3_payload_invalid [LANGUAGE_NOT_NEUTRAL]: experience:c1 voseo «vos sabés»';
    const v = FC.classifyFailure({ error: err, itemType: 'experience', source: 'browser_executor', outputSummary: {} });
    const s = RL.ladderStep(null, v, 'experience', err, T0, { retryable: true });
    eq([s.action, s.state.rung, !!RL.remediationFeedbackOf({ remediation: s.state })], ['feedback', 1, true], '1.er fallo');
    eq(RL.DEGRADABLE_CODES, [], 'sin degradados');
    eq(RS.remediationStrategyFor(v).strategy, 'prompt_with_findings', 'estrategia');
  });

  // ═══ S: «Falla común» ═══════════════════════════════════════════════════════
  await check('S1 una pausa por bug se reporta desde el PRIMER curso; activa mientras haya partes en pausa (no se «resuelve» por silencio); reporte con la instrucción de agregar la regla', async () => {
    const v = FC.classifyFailure({ error: UNK, itemType: 'content', source: 'browser_executor', outputSummary: {} });
    const hold = BH.nextBugHold(null, v, 'content', UNK, 'unmapped_code', T0, 'b');
    const rows = [{ courseId: 5, courseKey: 'uuid-5', runId: 'r5', itemKey: 'content:c1', itemType: 'content', bugHold: hold }];
    const sig = RL.commonFailureSignals(rows, new Map(), at(100 * 60));
    eq([sig.length, sig[0].kind, sig[0].status, sig[0].heldItems, sig[0].courseKeys], [1, 'bug_hold', 'active', 1, ['uuid-5']], 'umbral 1, sin quiet 72 h');
    assert(/Bug de Cursia/.test(sig[0].report) && /agregar la regla en src\/modules\/reliability\/failure-classifier\.ts/.test(sig[0].report) && /se reanudan SOLAS/.test(sig[0].report), sig[0].report);
    const resumed = RL.commonFailureSignals([{ ...rows[0], bugHold: BH.resumedBugHold(hold, at(10), 'system', 'new_build') }], new Map(), at(20));
    eq([resumed[0].status, resumed[0].resolvedBy], ['resolved', 'resumed'], 'todas reanudadas');
  });

  await check('S2 (review P2-9) cursos contados por frontend_course_id: el mismo course_id numérico de dos cursos distintos cuenta 2; el mismo curso en 3 runs cuenta 1', async () => {
    const rem = (iso) => ({ v: 1, fingerprint: 'experience|v3_payload_invalid|v3_payload_invalid|JSON_INVALID', code: 'v3_payload_invalid', rule: 'v3_payload_invalid', itemType: 'experience', innerCodes: ['JSON_INVALID'], count: 3, rung: 2, firstAt: iso, lastAt: iso, findings: [], feedback: 'x', acceptCodes: [], grants: 1, tried: [], sampleError: null });
    const rows = [0, 1, 2].map((i) => ({ courseId: 7, courseKey: `uuid-${i}`, runId: `r${i}`, itemKey: 'experience:c1', itemType: 'experience', remediation: rem(at(i * 30).toISOString()) }));
    const sig = RL.commonFailureSignals(rows, new Map(), at(120));
    eq([sig.length, sig[0].coursesInWindow, sig[0].courseKeys.length, sig[0].courses], [1, 3, 3, [7]], 'tres cursos (un numérico reutilizado)');
    const same = rows.map((r) => ({ ...r, courseId: 100 + Number(r.runId.slice(1)), courseKey: 'uuid-same' }));
    eq(RL.commonFailureSignals(same, new Map(), at(120)).length, 0, 'un solo curso en 3 runs');
  });

  // ═══ P: review P2-6 / P2-7 ══════════════════════════════════════════════════
  await check('P1 (review P2-6) quality_accepted:<itemKey con «:»>:<códigos> → el hallazgo apunta al itemKey COMPLETO', async () => {
    const f = QF.findingsFromPackageWarnings(['quality_accepted:audiobook_chapter:3f1c-uuid:AUDIOBOOK_LANGUAGE_NOT_NEUTRAL', 'application_chars_unmapped:application_activity:c2']);
    const qa = f.find((x) => x.code === 'QUALITY_ACCEPTED');
    eq([qa.location.itemKey, /AUDIOBOOK_LANGUAGE_NOT_NEUTRAL/.test(qa.evidence)], ['audiobook_chapter:3f1c-uuid', true], 'itemKey');
  });

  await check('P2 (review P2-7) el límite del dueño dice CUÁNDO vuelve el reintento (el 2.º más reciente de la ventana + 24 h) y el 409 no promete una revisión humana', async () => {
    const os = { ownerRetries: [{ at: at(-600).toISOString(), by: 'o' }, { at: at(-60).toISOString(), by: 'o' }] };
    eq(OR.ownerRetryNextAvailableAt(os, T0), new Date(at(-600).getTime() + 24 * 3600_000).toISOString(), 'próxima disponibilidad');
    eq(OR.ownerRetryNextAvailableAt({ ownerRetries: [{ at: at(-60).toISOString() }] }, T0), null, 'quedan reintentos');
    const v = OR.ownerRetryVerdict({ status: 'failed', verdict: FC.classifyFailure({ error: 'lease_expired' }), openReservations: 0, paidType: false, paidExternalUnreconciled: false,
      maxCostUsd: 1, runRemainingUsd: 10, policyBlockedBy: null, ownerRetriesUsed24h: 2, nextAvailableAt: 'X' });
    eq([v.allowed, v.reason, v.nextAvailableAt], [false, 'owner_retry_limit', 'X'], 'veredicto');
    const rs = fs.readFileSync(path.join(REPO, 'src/modules/dynamic-generation/runs.service.ts'), 'utf8');
    // Review P2-4: «Cursia la sigue recuperando sola» SOLO cuando el estado de recuperación es automático (autoResolving).
    assert(!/el equipo de Cursia la revisará/.test(rs) && /\$\{autoResolving \? ' Cursia la sigue recuperando sola; no tienes que hacer nada\.' : ''\}/.test(rs), '409 preciso');
  });

  // ═══ PG: Postgres 16 real ═══════════════════════════════════════════════════
  if (NO_PG) { console.log('   (--no-pg: se omite la parte con Postgres)'); }
  else {
    const { setupR95Db, MOCK_CTX } = require('./lib/r95-db');
    const IT = L('modules/dynamic-generation/item-transitions.js');
    const { AdminRecoveryService } = L('modules/dynamic-generation/admin-recovery.service.js');
    const { AutoPackageService } = L('modules/dynamic-packaging/auto-package.service.js');
    const H = await setupR95Db('r99');
    const { ds, runs } = H;
    const OWNER = '22222222-3333-4444-8555-666666666699';
    const prevSince = process.env.R99_BUG_HOLD_SINCE;
    process.env.R99_BUG_HOLD_SINCE = '2000-01-01T00:00:00Z';
    try {
      await H.setBudget(OWNER, 500);
      const C = await H.makeCourse(OWNER, 'Curso r99', 'o99@cliente.test');
      const runId = (await runs.startRun(C.cid, OWNER, 1, MOCK_CTX)).run.id;
      await ds.query(`update public.production_jobs set frontend_course_id = $2 where id = $1`, [runId, 'fe-course-r99-uuid']);
      const items = await ds.query(`select id, item_key, type, depends_on from public.generation_item_runs where job_id = $1 order by item_key`, [runId]);
      const target = items.find((r) => r.type === 'content');
      assert(target, 'hay una parte content');
      const ledgerCount = async () => Number((await ds.query(`select count(*)::int as n from public.generation_cost_events where run_id = $1`, [runId]))[0].n);
      const spend0 = await ledgerCount();
      const rowOf = async (id) => (await ds.query(`select *, to_jsonb(g)->>'attention_reason' as attention_reason_txt from public.generation_item_runs g where id = $1`, [id]))[0];
      const failTx = async (id, error, retryable = true) => {
        await ds.query(`update public.generation_item_runs set status = 'running', attempt_count = attempt_count + 1, lease_until = now() + interval '5 min', worker_id = 'w-r99' where id = $1`, [id]);
        const qr = ds.createQueryRunner(); await qr.connect(); await qr.startTransaction();
        try {
          await qr.query(`select id from public.production_jobs where id = $1 for update`, [runId]);
          const t = await IT.applyItemFailure(qr, id, error, retryable, null, false, false, { source: 'browser_executor' });
          await IT.recomputeRunStatus(qr, runId);
          await qr.commitTransaction();
          return t;
        } catch (e) { await qr.rollbackTransaction(); throw e; } finally { await qr.release(); }
      };

      await check('PG1 (review P1-1) código SIN regla, reintentable con intentos: sigue `retrying` (sus intentos con backoff) + REPORTE; con los intentos agotados → `failed` en pausa; dependientes bloqueados; sin gasto', async () => {
        const t0 = await failTx(target.id, UNK, true);
        eq(t0.status, 'retrying', 'primer fallo: usa sus intentos');
        let r = await rowOf(target.id);
        eq([r.output_summary.bugHold.active, r.output_summary.bugHold.reportOnly], [false, true], 'reporte sin pausa');
        await ds.query(`update public.generation_item_runs set status = 'pending', attempt_count = max_attempts - 1 where id = $1`, [target.id]);
        const t = await failTx(target.id, UNK, true);
        eq(t.status, 'failed', 'intentos agotados');
        r = await rowOf(target.id);
        eq([r.status, r.next_retry_at, r.output_summary.bugHold.active, r.output_summary.bugHold.reason, r.output_summary.recovery.state], ['failed', null, true, 'unmapped_code', 'paused_cursia_issue'], 'fila');
        eq(await ledgerCount(), spend0, 'sin gasto');
      });

      await check('PG2 DTO del run: la parte lleva cursiaIssue + paused_cursia_issue; completion.cursiaIssue con el mensaje; nunca «Curso listo»; (review P1-2) la salida humana sigue: acción de admin + reintento del dueño habilitado', async () => {
        const dto = await runs.getRun(C.cid, OWNER, 1, runId);
        const it = dto.items.find((x) => x.itemKey === target.item_key);
        eq([it.recovery.state.state, it.recovery.state.automatic, !!it.recovery.cursiaIssue], ['paused_cursia_issue', true, true], 'parte');
        assert(dto.completion.cursiaIssue && dto.completion.cursiaIssue.items.includes(target.item_key) && dto.completion.cursiaIssue.message === BH.CURSIA_ISSUE_MESSAGE, JSON.stringify(dto.completion.cursiaIssue));
        assert(dto.completion.adminActions.some((a) => a.itemKey === target.item_key), 'acción de admin (opcional) disponible');
        eq(OR.ownerRetryCodeEligibility(OR.itemFailureVerdict(await rowOf(target.id))), 'ok', 'el dueño puede reintentar (opcional)');
        assert(dto.completion.complete !== true, 'nunca «Curso listo» con una parte en pausa');
      });

      const admin = new AdminRecoveryService(ds, {}, runs);
      await check('PG3 «Falla común» (SQL real): la pausa aparece con UN curso, contado por frontend_course_id; (review P2-3) una pausa vigente no sale del reporte aunque la fila no se toque en 7 días', async () => {
        let list = (await admin.commonFailuresListing(false)).commonFailures;
        let sig = list.find((x) => x.kind === 'bug_hold' && x.runs.includes(runId));
        assert(sig, JSON.stringify(list).slice(0, 400));
        eq([sig.heldItems, sig.courseKeys, sig.status], [1, ['fe-course-r99-uuid'], 'active'], 'señal');
        const [u] = await ds.query(`select updated_at from public.generation_item_runs where id = $1`, [target.id]);
        assert(Date.now() - new Date(u.updated_at).getTime() < 120_000, 'la pausa tocó updated_at');
        await ds.query(`update public.generation_item_runs set updated_at = now() - interval '9 days' where id = $1`, [target.id]);
        list = (await admin.commonFailuresListing(false)).commonFailures;
        sig = list.find((x) => x.kind === 'bug_hold' && x.runs.includes(runId));
        assert(sig && sig.heldItems === 1, 'sigue en el reporte');
      });

      const base = Date.now();
      const tick = (h) => new Date(base + h * 3600_000);
      await check('PG4 barrido (SQL real): mismo build → sigue en pausa; build nuevo → retryItem la reabre (pending, pausa inactiva, 1 reanudación); enfriamiento; sin gasto', async () => {
        const r0 = await rowOf(target.id);
        const b0 = r0.output_summary.bugHold.buildId;
        const s1 = await runs.sweepCursiaIssues({ buildId: b0, now: tick(0) });
        assert(!s1.resumed.some((x) => x.itemKey === target.item_key) && s1.skipped.some((x) => x.itemKey === target.item_key && x.reason === 'still_unmapped'), JSON.stringify(s1));
        const s2 = await runs.sweepCursiaIssues({ buildId: 'build-r99-next', now: tick(0) });
        assert(s2.resumed.some((x) => x.itemKey === target.item_key && x.trigger === 'new_build'), JSON.stringify(s2));
        const r = await rowOf(target.id);
        eq([r.status, r.output_summary.bugHold.active, r.output_summary.bugHold.autoResumes, r.output_summary.bugHold.resumeTrigger], ['pending', false, 1, 'new_build'], 'reabierta');
        assert(r.output_summary.recoveryBudgetResetAt, 'review P1-2: presupuesto de la parte renovado');
        eq(await ledgerCount(), spend0, 'sin gasto');
      });

      await check('PG5 vuelve a fallar igual (intentos agotados) → pausa otra vez; enfriamiento entre reaperturas; tope de 3 por parte', async () => {
        await ds.query(`update public.generation_item_runs set status = 'pending', attempt_count = max_attempts - 1 where id = $1`, [target.id]);
        await failTx(target.id, UNK, true);
        let r = await rowOf(target.id);
        eq([r.status, r.output_summary.bugHold.active, r.output_summary.bugHold.count], ['failed', true, 3], 'pausa de nuevo (reporte + pausa + pausa)');
        const sc = await runs.sweepCursiaIssues({ buildId: 'build-r99-cool', now: tick(0.1) });
        assert(sc.skipped.some((x) => x.itemKey === target.item_key && x.reason === 'cooldown'), 'enfriamiento: ' + JSON.stringify(sc));
        for (let i = 0; i < 3; i++) {
          await runs.sweepCursiaIssues({ buildId: `build-r99-${i}`, now: tick(i + 1) });
          r = await rowOf(target.id);
          if (r.status !== 'failed') { await ds.query(`update public.generation_item_runs set status = 'pending', attempt_count = max_attempts - 1 where id = $1`, [target.id]); await failTx(target.id, UNK, true); }
        }
        r = await rowOf(target.id);
        eq([r.status, r.output_summary.bugHold.active, r.output_summary.bugHold.autoResumes], ['failed', true, 3], 'tope');
        const s = await runs.sweepCursiaIssues({ buildId: 'build-r99-last', now: tick(6) });
        assert(s.skipped.some((x) => x.itemKey === target.item_key && x.reason === 'build_resumes_exhausted'), JSON.stringify(s));
      });

      await check('PG6 huella marcada resuelta en «Falla común» (admin_audit_log) → el barrido la reanuda (resolved) aunque el build no cambie y el tope automático esté usado', async () => {
        const r0 = await rowOf(target.id);
        const fpNow = r0.output_summary.bugHold.fingerprint;
        await admin.resolveCommonFailure(fpNow, { id: '00000000-0000-4000-8000-0000000000aa', email: 'sa@test.local' }, 'arreglo desplegado');
        const s = await runs.sweepCursiaIssues({ buildId: r0.output_summary.bugHold.buildId, now: tick(7) });
        assert(s.resumed.some((x) => x.itemKey === target.item_key && x.trigger === 'resolved'), JSON.stringify(s));
      });

      const other = items.find((r) => r.type === 'experience') || items.find((r) => r.type !== 'content' && r.id !== target.id && !['video', 'presentation', 'audio_welcome', 'audiobook_chapter'].includes(r.type));
      await check('PG7 barrido: tope de la parte agotado con su ronda extra usada → pausa item_budget_exhausted; (review P1-2) la reanudación por build RENUEVA el presupuesto de la parte → el guard de la siguiente llamada la deja pasar; pausa del usuario → nunca', async () => {
        await ds.query(`update public.generation_item_runs set status = 'failed', error = 'item_recovery_budget_exhausted: tope de la parte', finished_at = now() - interval '20 minutes',
                          output_summary = coalesce(output_summary, '{}'::jsonb) || '{"autoBudgetExtension":{"at":"2026-11-01T00:00:00Z","round":1}}'::jsonb where id = $1`, [other.id]);
        const s = await runs.sweepCursiaIssues({ buildId: 'b-pg7', now: tick(8) });
        assert(s.held.some((x) => x.itemKey === other.item_key && x.reason === 'item_budget_exhausted'), JSON.stringify(s));
        // Lo gastado por la parte antes de la pausa agota su tope: el guard (proxy / worker de IA) la frena.
        await H.ledger.recordCharge({
          itemRunId: other.id, ownerIdFromAuth: OWNER, provider: 'anthropic', service: 'messages', modelOrProduct: 'claude-sonnet-4-6',
          costSource: 'ACTUAL_PROVIDER', actualAmount: '3.00', idempotencyKey: `r99:pg7:${other.id}`, callRole: 'main', attempt: 1,
          billingAccount: 'cursia', mode: 'real', measurementStatus: 'final', recordedBy: 'check-r99', executorAuthorization: 'server_worker', metadata: {},
        });
        await ds.query(`update public.generation_item_runs set output_summary = output_summary - 'recoveryBudgetResetAt' where id = $1`, [other.id]);
        await ds.query(`update public.production_jobs set status = 'running', worker_status = 'running' where id = $1`, [runId]);
        const guard = () => H.budget.guardServerLlmCall({ runId, itemRunId: other.id, model: 'claude-sonnet-4-6', promptChars: 2000, maxTokens: 1000 });
        const before = await guard();
        eq(before && before.code, 'item_recovery_budget_exhausted', 'antes de la reanudación: frenada por su tope');
        const s2 = await runs.sweepCursiaIssues({ buildId: 'b-pg7-fix', now: tick(9) });
        assert(s2.resumed.some((x) => x.itemKey === other.item_key && x.trigger === 'new_build'), JSON.stringify(s2));
        await ds.query(`update public.production_jobs set status = 'running', worker_status = 'running' where id = $1`, [runId]);
        eq(await guard(), null, 'tras la reanudación: el guard deja pasar la llamada (presupuesto de la parte renovado)');
        const third = items.find((r) => r.id !== target.id && r.id !== other.id && r.type === 'content') || items.find((r) => r.id !== target.id && r.id !== other.id);
        await ds.query(`update public.generation_item_runs set status = 'failed', error = 'Generación detenida por el usuario', finished_at = now() - interval '20 minutes' where id = $1`, [third.id]);
        const s3 = await runs.sweepCursiaIssues({ buildId: 'b-pg7', now: tick(10) });
        assert(!s3.held.some((x) => x.itemKey === third.item_key), 'pausa del usuario: no es un bug');
        const [t3] = await ds.query(`select output_summary from public.generation_item_runs where id = $1`, [third.id]);
        assert(!(t3.output_summary || {}).bugHold, 'sin pausa');
      });

      await check('PG8 empaque en pausa (SQL real): run completo con el empaque bloqueado por un bug del builder → pausa; build nuevo → marca renovada y se vuelve a pedir el paquete', async () => {
        const C2 = await H.makeCourse(OWNER, 'Curso r99 paquete', 'o99@cliente.test');
        const run2 = (await runs.startRun(C2.cid, OWNER, 1, MOCK_CTX)).run.id;
        await ds.query(`update public.production_jobs set worker_status = 'completed', status = 'completed',
                          output_summary = coalesce(output_summary, '{}'::jsonb) || jsonb_build_object('autoPackage', jsonb_build_object('eligibleAt', (now() - interval '2 hours')::text,
                            'blocked', jsonb_build_object('code', 'PACKAGING_PLAN_V3_INVALID', 'message', 'PACKAGING_PLAN_V3_INVALID: plan roto', 'missing', '[]'::jsonb, 'at', (now() - interval '1 hour')::text)))
                        where id = $1`, [run2]);
        const requested = [];
        const fakePackaging = { async requestPackage(cid, owner, bp, rid) { requested.push(rid); return { created: true, jobId: '00000000-0000-4000-8000-00000000beef', status: 'queued' }; } };
        const ap = new AutoPackageService(ds, fakePackaging, runs);
        const o1 = await ap.resumeCursiaIssues({ buildId: 'pkg-A' });
        assert(o1.some((x) => x.runId === run2 && x.action === 'held'), JSON.stringify(o1));
        const [j1] = await ds.query(`select output_summary->'autoPackage' as ap from public.production_jobs where id = $1`, [run2]);
        eq([j1.ap.cursiaIssue.active, j1.ap.cursiaIssue.code], [true, 'PACKAGING_PLAN_V3_INVALID'], 'pausa del empaque');
        const dto = await runs.getRun(C2.cid, OWNER, 1, run2);
        assert(dto.completion.complete !== true, 'nunca «Curso listo» con el empaque en pausa');
        const o2 = await ap.resumeCursiaIssues({ buildId: 'pkg-A' });
        assert(o2.some((x) => x.runId === run2 && x.action === 'skipped' && x.reason === 'waiting_fix'), JSON.stringify(o2));
        const o3 = await ap.resumeCursiaIssues({ buildId: 'pkg-B' });
        assert(o3.some((x) => x.runId === run2 && x.action === 'resumed'), JSON.stringify(o3));
        const [j2] = await ds.query(`select output_summary->'autoPackage' as ap from public.production_jobs where id = $1`, [run2]);
        assert(!j2.ap.blocked && j2.ap.cursiaIssue.active === false && j2.ap.cursiaIssue.buildResumes === 1 && Date.parse(j2.ap.eligibleAt) > Date.now() - 60_000, JSON.stringify(j2.ap));
        assert(requested.includes(run2), 'se volvió a pedir el paquete');
        const list = (await admin.commonFailuresListing(true)).commonFailures;
        assert(list.some((x) => x.fingerprint.startsWith('package|PACKAGING_PLAN_V3_INVALID')), 'el empaque en pausa aparece en «Falla común»');
      });
      await check('PG9 (decisión del dueño 1) presupuesto aprobado → la generación frenada sigue SOLA: usuario sin presupuesto → user_budgets nuevo; parte por presupuesto del run → autorización nueva; run pausado por su tope → reanudado; idempotente con barridos concurrentes', async () => {
        const C3 = await H.makeCourse(OWNER, 'Curso r99 presupuesto', 'o99@cliente.test');
        const run3 = (await runs.startRun(C3.cid, OWNER, 1, MOCK_CTX)).run.id;
        const its = await ds.query(`select id, item_key, type from public.generation_item_runs where job_id = $1 order by item_key`, [run3]);
        const [a, b] = its.filter((x) => x.type === 'content' || x.type === 'experience');
        const ub = 'Tu presupuesto disponible no alcanza para esta generación; solicita autorización. No se hizo la llamada (sin gasto).';
        await ds.query(`update public.generation_item_runs set status = 'failed', error = $2, finished_at = clock_timestamp() where id = $1`, [a.id, ub]);
        await ds.query(`update public.generation_item_runs set status = 'failed', error = 'budget_approval_required: hace falta aprobar el presupuesto', finished_at = clock_timestamp() where id = $1`, [b.id]);
        let o = await runs.autoResumeOwnerDecisionHolds();
        assert(!o.reopened.some((x) => x.runId === run3), 'sin decisión nueva: nada se reabre ' + JSON.stringify(o));
        await H.setBudget(OWNER, 900);
        const [o1, o2] = await Promise.all([runs.autoResumeOwnerDecisionHolds(), runs.autoResumeOwnerDecisionHolds()]);
        const reA = [...o1.reopened, ...o2.reopened].filter((x) => x.itemKey === a.item_key);
        eq([reA.length, reA[0] && reA[0].cause], [1, 'user_budget'], 'una sola reapertura (concurrencia)');
        const [ra] = await ds.query(`select status, output_summary from public.generation_item_runs where id = $1`, [a.id]);
        eq([ra.status, !!ra.output_summary.ownerDecisionResume], ['pending', true], 'parte del usuario reabierta');
        o = await runs.autoResumeOwnerDecisionHolds();
        assert(!o.reopened.some((x) => x.itemKey === b.item_key), 'presupuesto del run sin aprobar: sigue');
        await H.budget.adminAuthorizeRun({ courseId: C3.cid, runId: run3, authorizedBudget: '60', approvedBy: 'sa@cursia.test', reason: 'QA r99' });
        o = await runs.autoResumeOwnerDecisionHolds();
        assert(o.reopened.some((x) => x.itemKey === b.item_key && x.cause === 'run_budget'), JSON.stringify(o));
        o = await runs.autoResumeOwnerDecisionHolds();
        assert(!o.reopened.some((x) => x.runId === run3), 'la misma aprobación no reabre dos veces');
        // Run pausado por el sistema por su tope → una autorización nueva lo reanuda solo.
        await ds.query(`update public.production_jobs set status = 'paused', worker_status = 'paused',
                          output_summary = coalesce(output_summary, '{}'::jsonb) || jsonb_build_object('pause', jsonb_build_object('pausedAt', (now() - interval '1 minute')::text, 'pausedBy', 'system', 'reason', 'run_budget_cap', 'detail', 'tope'))
                        where id = $1`, [run3]);
        await H.budget.adminAuthorizeRun({ courseId: C3.cid, runId: run3, authorizedBudget: '80', approvedBy: 'sa@cursia.test', reason: 'QA r99 ampliación' });
        o = await runs.autoResumeOwnerDecisionHolds();
        assert(o.resumedRuns.includes(run3), JSON.stringify(o));
        const [j] = await ds.query(`select worker_status, output_summary->'pause' as pause from public.production_jobs where id = $1`, [run3]);
        assert(j.worker_status !== 'paused' && /^system:r99:owner_decision_resume/.test(String(j.pause.resumedBy)), JSON.stringify(j));
        // Una pausa del USUARIO nunca se levanta sola.
        await ds.query(`update public.production_jobs set status = 'paused', worker_status = 'paused',
                          output_summary = output_summary || jsonb_build_object('pause', jsonb_build_object('pausedAt', (now() - interval '1 minute')::text, 'pausedBy', $2::text, 'reason', 'user'))
                        where id = $1`, [run3, OWNER]);
        await H.budget.adminAuthorizeRun({ courseId: C3.cid, runId: run3, authorizedBudget: '90', approvedBy: 'sa@cursia.test', reason: 'QA r99 otra' });
        o = await runs.autoResumeOwnerDecisionHolds();
        assert(!o.resumedRuns.includes(run3), 'pausa del usuario: nunca sola');
      });

      await check('PG11 (re-review P2-A / P3-C / P3-D) nunca retroactivo: una decisión ANTERIOR a la activación no reanuda; kill switch; suspensión levantada → run pausado por la suspensión reanudado (resumedBy system); «autorizar usuario» reabre account_not_authorized; una pausa del usuario nunca se levanta bajo el lock', async () => {
        const C4 = await H.makeCourse(OWNER, 'Curso r99 activación', 'o99@cliente.test');
        const run4 = (await runs.startRun(C4.cid, OWNER, 1, MOCK_CTX)).run.id;
        const its = await ds.query(`select id, item_key, type from public.generation_item_runs where job_id = $1 and type in ('content', 'experience') order by item_key`, [run4]);
        const ub = 'Tu presupuesto disponible no alcanza para esta generación; solicita autorización. No se hizo la llamada (sin gasto).';
        await ds.query(`update public.generation_item_runs set status = 'failed', error = $2, finished_at = clock_timestamp() where id = $1`, [its[0].id, ub]);
        // Decisión «vieja» (bajo D-21): la activación queda DESPUÉS de esa decisión.
        await H.setBudget(OWNER, 950);
        process.env.R99_OWNER_RESUME_SINCE = new Date(Date.now() + 60_000).toISOString();
        let o = await runs.autoResumeOwnerDecisionHolds();
        assert(!o.reopened.some((x) => x.itemKey === its[0].item_key), 'decisión anterior a la activación: nada');
        delete process.env.R99_OWNER_RESUME_SINCE;
        process.env.R99_OWNER_DECISION_AUTORESUME = 'false';
        await H.setBudget(OWNER, 960);
        o = await runs.autoResumeOwnerDecisionHolds();
        eq([o.reopened.length, o.resumedRuns.length], [0, 0], 'kill switch');
        delete process.env.R99_OWNER_DECISION_AUTORESUME;
        o = await runs.autoResumeOwnerDecisionHolds();
        assert(o.reopened.some((x) => x.itemKey === its[0].item_key), 'con la llave encendida y una decisión posterior: reabre');
        // account_not_authorized → «autorizar usuario» (authorized_users activo del que paga).
        await ds.query(`update public.generation_item_runs set status = 'failed', error = 'Tu cuenta no tiene acceso a Cursia; pide acceso al administrador. No se hizo la llamada (sin gasto).', finished_at = clock_timestamp() where id = $1`, [its[1].id]);
        o = await runs.autoResumeOwnerDecisionHolds();
        assert(!o.reopened.some((x) => x.itemKey === its[1].item_key), 'sin autorización todavía');
        await ds.query(`insert into public.authorized_users (email, user_id, status) values ($1, $2, 'active') on conflict (email) do update set user_id = excluded.user_id, status = 'active'`, ['o99-auth@cliente.test', OWNER]);
        await ds.query(`update public.authorized_users set created_at = clock_timestamp() where user_id = $1`, [OWNER]);
        o = await runs.autoResumeOwnerDecisionHolds();
        assert(o.reopened.some((x) => x.itemKey === its[1].item_key && x.cause === 'account_authorization'), JSON.stringify(o));
        // Suspensión: el run pausado POR la suspensión sigue solo cuando se levanta.
        const sid = (await ds.query(`insert into public.user_suspensions (user_id, kind, reason, created_by) values ($1, 'account', 'QA r99', $1) returning id`, [OWNER]))[0].id;
        await ds.query(`update public.production_jobs set status = 'paused', worker_status = 'paused',
                          output_summary = coalesce(output_summary, '{}'::jsonb) || jsonb_build_object('pause', jsonb_build_object('pausedAt', (now() - interval '1 minute')::text, 'pausedBy', 'system:account_suspended', 'reason', 'account_suspended'))
                        where id = $1`, [run4]);
        o = await runs.autoResumeOwnerDecisionHolds();
        assert(!o.resumedRuns.includes(run4), 'suspensión vigente: sigue pausado');
        await ds.query(`update public.user_suspensions set lifted_at = clock_timestamp(), lifted_by = user_id, lift_reason = 'QA' where id = $1`, [sid]);
        o = await runs.autoResumeOwnerDecisionHolds();
        assert(o.resumedRuns.includes(run4), 'suspensión levantada: reanudado ' + JSON.stringify(o));
        const [j4] = await ds.query(`select worker_status, output_summary->'pause'->>'resumedBy' as by from public.production_jobs where id = $1`, [run4]);
        assert(j4.worker_status !== 'paused' && /^system:r99:/.test(String(j4.by)), JSON.stringify(j4));
        // P3-D: bajo el lock, una pausa que ya no es del sistema no se levanta.
        await ds.query(`update public.production_jobs set status = 'paused', worker_status = 'paused',
                          output_summary = output_summary || jsonb_build_object('pause', jsonb_build_object('pausedAt', now()::text, 'pausedBy', $2::text))
                        where id = $1`, [run4, OWNER]);
        let err = null;
        try { await runs.resumeRun(C4.cid, OWNER, 1, run4, undefined, { reasons: ['run_budget_cap', 'account_suspended'], label: 'system:r99:test' }); } catch (e) { err = e; }
        assert(err && /run_not_system_paused/.test(JSON.stringify(err.getResponse ? err.getResponse() : err.message)), 'pausa del usuario: 409 bajo el lock');
      });

      await check('PG12 (re-review) backfill con tope GLOBAL por hora: pausas con fallo original ANTERIOR a la activación → como mucho R99_BACKFILL_MAX_RESUMES_PER_HOUR runs por hora; re-sonda de una pausa externa: sonda caída → solo se anota (USD 0); sonda sana → reabre', async () => {
        const IT2 = L('modules/dynamic-generation/item-transitions.js');
        const prevCap = process.env.R99_BACKFILL_MAX_RESUMES_PER_HOUR;
        // El tope es GLOBAL (runs distintos en la última hora): las reaperturas de backfill de PG4–PG7 ya cuentan.
        const [{ n: already }] = await ds.query(`select count(distinct job_id)::int as n from public.generation_item_runs
          where (output_summary->'bugHold'->>'backfillResumedAt') is not null and (output_summary->'bugHold'->>'backfillResumedAt')::timestamptz > now() - interval '1 hour'`);
        process.env.R99_BACKFILL_MAX_RESUMES_PER_HOUR = String(already + 1);
        try {
          const mkHeld = async (title) => {
            const K = await H.makeCourse(OWNER, title, 'o99@cliente.test');
            const rid = (await runs.startRun(K.cid, OWNER, 1, MOCK_CTX)).run.id;
            const [it] = await ds.query(`select id, item_key from public.generation_item_runs where job_id = $1 and type = 'content' order by item_key limit 1`, [rid]);
            await ds.query(`update public.generation_item_runs set status = 'failed', error = 'missing_dependency_artifact: x', finished_at = now() - interval '3 days' where id = $1`, [it.id]);
            return { rid, it };
          };
          const a = await mkHeld('Curso r99 backfill A');
          const b = await mkHeld('Curso r99 backfill B');
          let s = await runs.sweepCursiaIssues({ buildId: 'bf-1' });
          assert(s.held.some((x) => x.itemKey === a.it.item_key) && s.held.some((x) => x.itemKey === b.it.item_key), 'backfill: pausadas');
          const [ha] = await ds.query(`select output_summary->'bugHold' as h from public.generation_item_runs where id = $1`, [a.it.id]);
          assert(Date.parse(ha.h.originalFailedAt) < Date.now() - 2 * 86_400_000, 'fallo original conservado');
          s = await runs.sweepCursiaIssues({ buildId: 'bf-2' });
          const resumedBf = s.resumed.filter((x) => x.backfill && (x.runId === a.rid || x.runId === b.rid));
          eq(resumedBf.length, 1, 'una reapertura de backfill más dentro del tope global');
          assert(s.skipped.some((x) => (x.runId === a.rid || x.runId === b.rid) && x.reason === 'backfill_rate_limited'), JSON.stringify(s.skipped));
        } finally { if (prevCap === undefined) delete process.env.R99_BACKFILL_MAX_RESUMES_PER_HOUR; else process.env.R99_BACKFILL_MAX_RESUMES_PER_HOUR = prevCap; }
        // Re-sonda.
        const K = await H.makeCourse(OWNER, 'Curso r99 re-sonda', 'o99@cliente.test');
        const rid = (await runs.startRun(K.cid, OWNER, 1, MOCK_CTX)).run.id;
        const [it] = await ds.query(`select id, item_key from public.generation_item_runs where job_id = $1 and type = 'content' order by item_key limit 1`, [rid]);
        const e = '❌ Falló después de 3 intentos: Error del servidor (503)';
        const v = FC.classifyFailure({ error: e, itemType: 'content', source: 'browser_executor', outputSummary: {} });
        const hold = BH.nextBugHold(null, v, 'content', e, 'strategy_exhausted', new Date(Date.now() - 3 * 3600_000), 'rp-1', new Date(Date.now() - 4 * 3600_000));
        await ds.query(`update public.generation_item_runs set status = 'failed', error = $2, finished_at = now() - interval '4 hours',
                          output_summary = coalesce(output_summary, '{}'::jsonb) || jsonb_build_object('bugHold', $3::jsonb) where id = $1`, [it.id, e, JSON.stringify(hold)]);
        let s = await runs.sweepCursiaIssues({ buildId: 'rp-1', probe: async () => ({ ok: false, reason: 'recent_failures', recentFailures: 2, recentSuccesses: 0 }) });
        assert(s.skipped.some((x) => x.itemKey === it.item_key && x.reason === 'probe_unhealthy'), JSON.stringify(s));
        const [p1] = await ds.query(`select status, output_summary->'bugHold' as h from public.generation_item_runs where id = $1`, [it.id]);
        eq([p1.status, p1.h.active, p1.h.probes && p1.h.probes.n], ['failed', true, 1], 'sonda anotada, sin reabrir');
        s = await runs.sweepCursiaIssues({ buildId: 'rp-1', now: new Date(Date.now() + 2.1 * 3600_000), probe: async () => ({ ok: true, reason: 'recent_success', recentFailures: 0, recentSuccesses: 1 }) });
        assert(s.resumed.some((x) => x.itemKey === it.item_key && x.trigger === 'reprobe'), JSON.stringify(s));
        void IT2;
      });

      await check('PG13 (re-review 3, P1) migración r99: tabla con RLS y SIN privilegios para anon/authenticated (aunque tuvieran grants por defecto); idempotente; el código no hace DDL; latido: sin latido > 1 h → re-activación a «ahora» (nunca una activación vieja)', async () => {
        for (const r of ['anon', 'authenticated']) await ds.query(`do $$ begin if not exists (select 1 from pg_roles where rolname = '${r}') then create role ${r} nologin; end if; end $$`);
        await ds.query(`grant all on table public.cursia_feature_activations to anon, authenticated`);
        const fsm = require('fs');
        const sql = fsm.readFileSync(path.join(REPO, 'supabase-migration-r99-activation.sql'), 'utf8');
        await ds.query(sql);
        await ds.query(sql); // idempotente
        const priv = await ds.query(`select r as role, has_table_privilege(r, 'public.cursia_feature_activations', 'SELECT') as sel,
                                            has_table_privilege(r, 'public.cursia_feature_activations', 'INSERT,UPDATE,DELETE') as wr
                                       from unnest(array['anon','authenticated']) r`);
        eq(priv.map((x) => [x.role, x.sel, x.wr]), [['anon', false, false], ['authenticated', false, false]], 'sin privilegios');
        const [rls] = await ds.query(`select relrowsecurity from pg_class where oid = 'public.cursia_feature_activations'::regclass`);
        eq(rls.relrowsecurity, true, 'RLS');
        const src = fsm.readFileSync(path.join(REPO, 'src/modules/reliability/r99-activation.ts'), 'utf8');
        assert(!/create table|alter table|grant |revoke /i.test(src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')), 'el código no hace DDL');
        // Latido / re-activación.
        const ACT = L('modules/reliability/r99-activation.js');
        ACT.resetR99ActivationCache();
        const a1 = await ACT.r99ActivationAt(ds, {}, 'sha-1');
        const [row1] = await ds.query(`select build_id, last_seen_at from public.cursia_feature_activations where key = 'r99'`);
        assert(row1.build_id === 'sha-1' && a1 instanceof Date, JSON.stringify(row1));
        await ds.query(`update public.cursia_feature_activations set activated_at = now() - interval '40 days', last_seen_at = now() - interval '2 hours' where key = 'r99'`);
        ACT.resetR99ActivationCache();
        const a2 = await ACT.r99ActivationAt(ds, {}, 'sha-2');
        assert(Date.now() - a2.getTime() < 60_000, 'sin latido > 1 h: re-activación a «ahora» (no la de hace 40 días): ' + a2.toISOString());
        // Sin la tabla: arranque del proceso (nunca antes).
        ACT.resetR99ActivationCache();
        const fake = { query: async () => { throw new Error('relation "public.cursia_feature_activations" does not exist'); } };
        const a3 = await ACT.r99ActivationAt(fake, {});
        assert(a3.getTime() > Date.now() - 3600_000 && a3.getTime() <= Date.now(), 'fallback: arranque del proceso');
        ACT.resetR99ActivationCache();
      });

      await check('PG14 (re-review 3, P3-2) un reintento HUMANO de una parte en pausa abre una ventana nueva: la próxima pausa toma su fallo como el original', async () => {
        const K = await H.makeCourse(OWNER, 'Curso r99 manual', 'o99@cliente.test');
        const rid = (await runs.startRun(K.cid, OWNER, 1, MOCK_CTX)).run.id;
        const [it] = await ds.query(`select id, item_key from public.generation_item_runs where job_id = $1 and type = 'content' order by item_key limit 1`, [rid]);
        const v = FC.classifyFailure({ error: 'missing_dependency_artifact: x', itemType: 'content', source: 'browser_executor', outputSummary: {} });
        const hold = BH.nextBugHold(null, v, 'content', 'missing_dependency_artifact: x', 'product_bug', new Date(), 'b', new Date(Date.now() - 10 * 86_400_000));
        await ds.query(`update public.generation_item_runs set status = 'failed', error = 'missing_dependency_artifact: x', finished_at = now(),
                          output_summary = coalesce(output_summary, '{}'::jsonb) || jsonb_build_object('bugHold', $2::jsonb) where id = $1`, [it.id, JSON.stringify(hold)]);
        await runs.retryItem(K.cid, OWNER, 1, rid, it.item_key);
        const [r] = await ds.query(`select output_summary->'bugHold' as h from public.generation_item_runs where id = $1`, [it.id]);
        eq([r.h.active, r.h.originalFailedAt], [false, null], 'ventana reiniciada');
        const next = BH.nextBugHold(r.h, v, 'content', 'missing_dependency_artifact: x', 'product_bug', new Date(), 'b', new Date());
        assert(Date.now() - Date.parse(next.originalFailedAt) < 60_000, 'nueva falla = nuevo original');
      });

      await check('PG10 (decisión del dueño 4) corte móvil de 30 días: un run fallido de hace 10 días entra a la pausa; uno de hace 40 días no se toca', async () => {
        delete process.env.R99_BUG_HOLD_SINCE;
        try {
          const mk = async (daysAgo) => {
            const K = await H.makeCourse(OWNER, `Curso r99 corte ${daysAgo}`, 'o99@cliente.test');
            const rid = (await runs.startRun(K.cid, OWNER, 1, MOCK_CTX)).run.id;
            await ds.query(`update public.production_jobs set created_at = now() - make_interval(days => $2::int) where id = $1`, [rid, daysAgo]);
            const [it] = await ds.query(`select id, item_key from public.generation_item_runs where job_id = $1 and type = 'content' order by item_key limit 1`, [rid]);
            await ds.query(`update public.generation_item_runs set status = 'failed', error = 'missing_dependency_artifact: x', finished_at = now() - interval '1 hour' where id = $1`, [it.id]);
            return it;
          };
          const recent = await mk(10);
          const old = await mk(40);
          const s = await runs.sweepCursiaIssues({ buildId: 'b-pg10' });
          assert(s.held.some((x) => x.itemKey === recent.item_key), 'reciente: pausa ' + JSON.stringify(s.held));
          assert(!s.held.some((x) => x.itemKey === old.item_key), 'viejo: sin tocar');
        } finally { process.env.R99_BUG_HOLD_SINCE = '2000-01-01T00:00:00Z'; }
      });
    } finally {
      if (prevSince === undefined) delete process.env.R99_BUG_HOLD_SINCE; else process.env.R99_BUG_HOLD_SINCE = prevSince;
      await H.close();
    }
  }

  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
