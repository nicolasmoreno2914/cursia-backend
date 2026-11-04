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
    const spent = { ...hold, buildResumes: BH.BUG_HOLD_MAX_BUILD_RESUMES };
    eq(BH.bugHoldResumeDecision({ ...row, output_summary: { bugHold: spent } }, { now: at(5), buildId: 'build-B', verdict: v, itemType: 'content' }), { resume: false, reason: 'build_resumes_exhausted' }, 'tope por build');
    const paid = { ...hold, paidUncertain: true };
    eq(BH.bugHoldResumeDecision({ ...row, output_summary: { bugHold: paid } }, { now: at(5), buildId: 'build-B', verdict: v, itemType: 'content' }), { resume: false, reason: 'paid_uncertain' }, 'pago incierto nunca por build');
    eq(BH.bugHoldResumeDecision(row, { now: at(15 * 24 * 60), buildId: 'build-B', verdict: v, itemType: 'content' }), { resume: false, reason: 'too_old' }, 'ventana');
    const r1 = BH.resumedBugHold(hold, at(6), 'system', 'new_build');
    eq([r1.active, r1.buildResumes, r1.history.length], [false, 1, 2], 'reanudada');
    assert(!BH.bugHoldOf({ bugHold: r1 }, UNK), 'ya no está en pausa');
    const again = BH.nextBugHold(r1, v, 'content', UNK, 'unmapped_code', at(7), 'build-B');
    eq([again.active, again.count, again.buildResumes], [true, 2, 1], 'vuelve a la pausa conservando el tope');
  });

  await check('U4 la identidad del build es estable en el proceso y CURSIA_BUILD_ID la fija', async () => {
    BH.resetBuildIdCache();
    const a = BH.currentBuildId({}); const b = BH.currentBuildId({});
    assert(a && a === b && /^[0-9a-f]{16}$/.test(a), a);
    eq(BH.currentBuildId({ CURSIA_BUILD_ID: 'deploy-123' }), 'deploy-123', 'explícito');
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
    assert(!/el equipo de Cursia la revisará/.test(rs) && /Cursia sigue recuperándola sola/.test(rs), '409 sin «el equipo la revisará»');
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

      await check('PG1 applyItemFailure con un código SIN regla (reintentable, intentos disponibles) → `failed` con pausa (nunca `retrying` idéntico); dependientes bloqueados; sin gasto', async () => {
        const t = await failTx(target.id, UNK, true);
        eq(t.status, 'failed', 'transición');
        const r = await rowOf(target.id);
        eq([r.status, r.next_retry_at, r.output_summary.bugHold.active, r.output_summary.bugHold.reason, r.output_summary.recovery.state], ['failed', null, true, 'unmapped_code', 'paused_cursia_issue'], 'fila');
        assert(r.attempt_count < r.max_attempts, 'le quedaban intentos y NO se usaron (serían el mismo pedido)');
        eq(await ledgerCount(), spend0, 'sin gasto');
      });

      await check('PG2 DTO del run: la parte lleva cursiaIssue + estado paused_cursia_issue; completion.cursiaIssue con el mensaje; sin acción de admin por curso', async () => {
        const dto = await runs.getRun(C.cid, OWNER, 1, runId);
        const it = dto.items.find((x) => x.itemKey === target.item_key);
        eq([it.recovery.state.state, it.recovery.state.automatic, !!it.recovery.cursiaIssue], ['paused_cursia_issue', true, true], 'parte');
        assert(dto.completion.cursiaIssue && dto.completion.cursiaIssue.items.includes(target.item_key) && dto.completion.cursiaIssue.message === BH.CURSIA_ISSUE_MESSAGE, JSON.stringify(dto.completion.cursiaIssue));
        assert(!dto.completion.adminActions.some((a) => a.itemKey === target.item_key), 'sin acción de admin para la parte en pausa');
        assert(dto.completion.complete !== true, 'nunca «Curso listo» con una parte en pausa');
      });

      const admin = new AdminRecoveryService(ds, {}, runs);
      let fp = null;
      await check('PG3 «Falla común» (SQL real): la pausa aparece con UN curso, contado por frontend_course_id', async () => {
        const list = (await admin.commonFailuresListing(false)).commonFailures;
        const sig = list.find((x) => x.kind === 'bug_hold' && x.runs.includes(runId));
        assert(sig, JSON.stringify(list).slice(0, 400));
        eq([sig.heldItems, sig.courseKeys, sig.status], [1, ['fe-course-r99-uuid'], 'active'], 'señal');
        fp = sig.fingerprint;
      });

      await check('PG4 barrido (SQL real): mismo build → sigue en pausa; build nuevo → retryItem la reabre (pending, pausa inactiva, 1 reanudación por build); sin gasto', async () => {
        const r0 = await rowOf(target.id);
        const b0 = r0.output_summary.bugHold.buildId;
        const s1 = await runs.sweepCursiaIssues({ buildId: b0 });
        assert(!s1.resumed.some((x) => x.itemKey === target.item_key) && s1.skipped.some((x) => x.itemKey === target.item_key && x.reason === 'still_unmapped'), JSON.stringify(s1));
        const s2 = await runs.sweepCursiaIssues({ buildId: 'build-r99-next' });
        assert(s2.resumed.some((x) => x.itemKey === target.item_key && x.trigger === 'new_build'), JSON.stringify(s2));
        const r = await rowOf(target.id);
        eq([r.status, r.output_summary.bugHold.active, r.output_summary.bugHold.buildResumes, r.output_summary.bugHold.resumeTrigger], ['pending', false, 1, 'new_build'], 'reabierta');
        eq(await ledgerCount(), spend0, 'sin gasto');
        const [att] = await ds.query(`select strategy_applied from public.generation_item_attempts where item_run_id = $1 and strategy_applied like 'cursia_issue_resume%' order by started_at desc nulls last limit 1`, [target.id]).catch(() => [null]);
        assert(!att || /^cursia_issue_resume:new_build/.test(att.strategy_applied), JSON.stringify(att));
      });

      await check('PG5 vuelve a fallar igual → pausa otra vez (sin rehacer la escalera); tope de reanudaciones por build', async () => {
        await ds.query(`update public.generation_item_runs set status = 'pending' where id = $1`, [target.id]);
        await failTx(target.id, UNK, true);
        let r = await rowOf(target.id);
        eq([r.status, r.output_summary.bugHold.active, r.output_summary.bugHold.count], ['failed', true, 2], 'pausa de nuevo');
        for (let i = 0; i < 3; i++) {
          await runs.sweepCursiaIssues({ buildId: `build-r99-${i}` });
          r = await rowOf(target.id);
          if (r.status !== 'failed') await failTx(target.id, UNK, true);
        }
        r = await rowOf(target.id);
        eq([r.status, r.output_summary.bugHold.active, r.output_summary.bugHold.buildResumes], ['failed', true, BH.BUG_HOLD_MAX_BUILD_RESUMES], 'tope');
        const s = await runs.sweepCursiaIssues({ buildId: 'build-r99-last' });
        assert(s.skipped.some((x) => x.itemKey === target.item_key && x.reason === 'build_resumes_exhausted'), JSON.stringify(s));
      });

      await check('PG6 huella marcada resuelta en «Falla común» (admin_audit_log) → el barrido la reanuda (resolved) aunque el build no cambie', async () => {
        const r0 = await rowOf(target.id);
        const fpNow = r0.output_summary.bugHold.fingerprint;
        await admin.resolveCommonFailure(fpNow, { id: '00000000-0000-4000-8000-0000000000aa', email: 'sa@test.local' }, 'arreglo desplegado');
        const s = await runs.sweepCursiaIssues({ buildId: r0.output_summary.bugHold.buildId });
        assert(s.resumed.some((x) => x.itemKey === target.item_key && x.trigger === 'resolved'), JSON.stringify(s));
        void fp;
      });

      const other = items.find((r) => r.type !== 'content' && r.id !== target.id && !['video', 'presentation', 'audio_welcome', 'audiobook_chapter'].includes(r.type)) || items.find((r) => r.id !== target.id);
      await check('PG7 barrido: estrategia agotada (tope de la parte con su ronda extra usada) → pausa item_budget_exhausted; pausa del usuario → nunca (decisión del dueño)', async () => {
        await ds.query(`update public.generation_item_runs set status = 'failed', error = 'item_recovery_budget_exhausted: tope de la parte', finished_at = now() - interval '20 minutes',
                          output_summary = coalesce(output_summary, '{}'::jsonb) || '{"autoBudgetExtension":{"at":"2026-11-01T00:00:00Z","round":1}}'::jsonb where id = $1`, [other.id]);
        const s = await runs.sweepCursiaIssues({ buildId: 'b-pg7' });
        assert(s.held.some((x) => x.itemKey === other.item_key && x.reason === 'item_budget_exhausted'), JSON.stringify(s));
        const third = items.find((r) => r.id !== target.id && r.id !== other.id);
        await ds.query(`update public.generation_item_runs set status = 'failed', error = 'Generación detenida por el usuario', finished_at = now() - interval '20 minutes' where id = $1`, [third.id]);
        const s2 = await runs.sweepCursiaIssues({ buildId: 'b-pg7' });
        assert(!s2.held.some((x) => x.itemKey === third.item_key), 'pausa del usuario: no es un bug');
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
    } finally {
      if (prevSince === undefined) delete process.env.R99_BUG_HOLD_SINCE; else process.env.R99_BUG_HOLD_SINCE = prevSince;
      await H.close();
    }
  }

  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
