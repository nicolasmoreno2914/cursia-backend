#!/usr/bin/env node
/* eslint-disable */
// r60 (Agent C) — conciliación PARCIAL de reservas (`charged_partial`). USD 0: PG16 desechable con las migraciones del
// repo, sin red, sin proveedores, sin datos reales.
//
//   [PU] puro: parseReconcileDecision / parseTtsReservationReconcileBody / applyReconcileDecision (409 si la reserva
//        ya está cerrada de otra forma) — amount > 0 en texto, evidence estructurada obligatoria y cerrada
//   [P1] ledger: ADJUSTMENT append-only (corrects_event_id = la reserva, delta = amount − reservado, final), metadata
//        con evidence/decidedBy/reservedAmount/countedAmount; el CHARGE original no cambia
//   [P2] idempotente: repetir = no-op; luego charged / not_charged / otro monto = alreadySettled (no cambia nada)
//   [P3] rechazos: amount > reservado, amount 0, sin evidence, no reserva, reserva no pendiente — sin escribir
//   [P4] concurrencia: N conciliaciones parciales simultáneas de la misma clave → UN solo ADJUSTMENT (lock por clave)
//   [P5] CostReadService: la reserva conciliada en parte sale de «reservado», cuenta como UNA llamada y el comprometido
//        baja exactamente a amount
//   [P6] uso tardío del proveedor tras una parcial: gana la medición real (mayor o menor), la llamada cuenta una vez
//   [P7] Videogen (servicio admin): charged_partial con evidencia; ack obligatorio si pudo renderizarse; repetir no-op;
//        no SUPER_ADMIN → 403
//   [P8] el ledger sigue append-only (UPDATE/DELETE rechazados por trigger)
//   [PR] propuesta de precios r60 (pricing-proposal.r60.json): append-only (sin colisión con el seed), mismas tarifas en
//        las re-emisiones, effective_from posterior (gana la nueva sin ambigüedad; cargos previos conservan su precio)
//
// Usage: npm run build && node scripts/check-r60-finops-partial-reconcile.js [--pure-only]
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const PURE_ONLY = process.argv.includes('--pure-only');
const REPO = path.resolve(__dirname, '..');
const distRoot = path.join(REPO, 'dist');
const L = (rel) => { try { return require(path.join(distRoot, rel)); } catch (err) { console.error(`❌ No se pudo cargar dist/${rel} (¿npm run build?): ${err.message}`); process.exit(1); } };
require('reflect-metadata');
const realFetch = global.fetch;
global.fetch = async (u, o) => { const s = String(u); if (s.startsWith('data:') || /^http:\/\/127\.0\.0\.1:\d+/.test(s)) return realFetch(u, o); throw new Error(`NETWORK FORBIDDEN in check: ${s}`); };
const { Logger, BadRequestException, ConflictException } = require('@nestjs/common');
Logger.overrideLogger(false);
const { applyFakeProviderEnv } = require('./lib/provider-test-env');

let passes = 0; let failures = 0;
async function check(name, fn) { try { await fn(); passes++; console.log(`✅ ${name}`); } catch (err) { failures++; console.error(`❌ ${name}\n   ${err && err.stack ? err.stack.split('\n').slice(0, 6).join('\n   ') : err}`); } }
function assert(c, m) { if (!c) throw new Error(m); }
function eq(a, b, m) { const x = JSON.stringify(a); const y = JSON.stringify(b); if (x !== y) throw new Error(`${m}: esperado ${y}, encontrado ${x}`); }
async function rejects(p, pred, m) { let e = null; try { await p; } catch (x) { e = x; } assert(e, `${m}: no lanzó`); assert(pred(e), `${m}: error inesperado ${e && e.constructor && e.constructor.name}: ${e && e.message}`); return e; }
function throwsSync(fn, re, m) { let e = null; try { fn(); } catch (x) { e = x; } assert(e, `${m}: no lanzó`); assert(re.test(e.message), `${m}: ${e.message}`); return e; }

const RD = L('modules/finops/reconcile-decision.js');
const CTRL = L('modules/finops/finops.controller.js');
const F = L('modules/finops/index.js');

const EVID = { source: 'provider_usage_log', referenceIds: ['videogen:job:edef3614', 'api_usage_logs'], observedAmount: '0.5351', notes: 'guion gpt-4o 0.371 + 4 imágenes 0.16 + 13 TTS 0.004; sin render' };

async function pureChecks() {
  await check('[PU] parseReconcileDecision: charged / not_charged sin amount/evidence; charged_partial exige ambos (amount > 0 decimal en texto, evidence cerrada)', async () => {
    eq(RD.parseReconcileDecision({ outcome: 'charged', reason: ' ok ' }), { outcome: 'charged', reason: 'ok' }, 'charged');
    eq(RD.parseReconcileDecision({ outcome: 'not_charged', reason: 'x' }), { outcome: 'not_charged', reason: 'x' }, 'not_charged');
    const d = RD.parseReconcileDecision({ outcome: 'charged_partial', reason: 'consumo interno Videogen', amount: '0.5351', evidence: EVID });
    eq([d.amount, d.evidence.observedAmount, d.evidence.currency, d.evidence.source, d.evidence.referenceIds.length], ['0.5351000000', '0.5351000000', 'USD', 'provider_usage_log', 2], 'partial normalizado');
    const bad = [
      [{ outcome: 'maybe', reason: 'x' }, /outcome/],
      [{ outcome: 'charged', reason: '' }, /reason/],
      [{ outcome: 'charged', reason: 'x', amount: '1' }, /solo con outcome charged_partial/],
      [{ outcome: 'not_charged', reason: 'x', evidence: EVID }, /solo con outcome charged_partial/],
      [{ outcome: 'charged_partial', reason: 'x', evidence: EVID }, /amount/],
      [{ outcome: 'charged_partial', reason: 'x', amount: 0.5, evidence: EVID }, /amount/],
      [{ outcome: 'charged_partial', reason: 'x', amount: '0', evidence: EVID }, /> 0/],
      [{ outcome: 'charged_partial', reason: 'x', amount: '-1', evidence: EVID }, /amount/],
      [{ outcome: 'charged_partial', reason: 'x', amount: '1e3', evidence: EVID }, /amount/],
      [{ outcome: 'charged_partial', reason: 'x', amount: '0.5' }, /evidence es obligatoria/],
      [{ outcome: 'charged_partial', reason: 'x', amount: '0.5', evidence: { ...EVID, source: 'me' } }, /evidence.source/],
      [{ outcome: 'charged_partial', reason: 'x', amount: '0.5', evidence: { ...EVID, referenceIds: [] } }, /referenceIds/],
      [{ outcome: 'charged_partial', reason: 'x', amount: '0.5', evidence: { ...EVID, referenceIds: ['a b'] } }, /referenceIds/],
      [{ outcome: 'charged_partial', reason: 'x', amount: '0.5', evidence: { ...EVID, observedAmount: 0.5 } }, /observedAmount/],
      [{ outcome: 'charged_partial', reason: 'x', amount: '0.5', evidence: { ...EVID, currency: 'EUR' } }, /currency/],
      [{ outcome: 'charged_partial', reason: 'x', amount: '0.5', evidence: { ...EVID, hack: 1 } }, /campo no permitido/],
      [{ outcome: 'charged', reason: 'x', force: true }, /campo no permitido/],
    ];
    for (const [b, re] of bad) throwsSync(() => RD.parseReconcileDecision(b), re, JSON.stringify(b).slice(0, 90));
  });

  await check('[PU] TTS: el cuerpo acepta charged_partial con amount+evidence; las validaciones previas (clave, campos extra) siguen igual → 400', async () => {
    const KEY = `reservation:tts:${crypto.randomUUID()}:g1:a1:seg_seg-0-0-d16e19c72621`;
    const p = CTRL.parseTtsReservationReconcileBody({ reservationKey: KEY, outcome: 'charged_partial', reason: 'equivalente', amount: '0.0545', evidence: { source: 'equivalent_request_ledger', referenceIds: ['openai:tts:req_x'], observedAmount: '0.0545' } });
    eq([p.reservationKey, p.outcome, p.amount], [KEY, 'charged_partial', '0.0545000000'], 'válido');
    for (const b of [{ reservationKey: 'x', outcome: 'charged_partial', reason: 'x', amount: '1', evidence: EVID }, { reservationKey: KEY, outcome: 'charged_partial', reason: 'x', amount: '1' }, { reservationKey: KEY, outcome: 'charged', reason: 'x', extra: 1 }]) {
      let e = null; try { CTRL.parseTtsReservationReconcileBody(b); } catch (x) { e = x; }
      assert(e instanceof BadRequestException, `400 para ${JSON.stringify(b).slice(0, 80)}`);
    }
  });

  await check('[PU] applyReconcileDecision: ruta por outcome; partial ya cerrada de otra forma u otro monto → 409 reservation_already_settled; mismo monto → no-op 200', async () => {
    const calls = [];
    const mk = (partialRes) => ({
      reconcileReservationAsCharged: async (k, r, o) => { calls.push(['charged', k, o.metadata]); return { reconciled: true, alreadySettled: false, amount: '1.0000000000' }; },
      reconcileReservationAsNotCharged: async (k, r, o) => { calls.push(['not_charged', k]); return { reconciled: true, alreadySettled: false, amount: '1.0000000000' }; },
      reconcileReservationAsChargedPartial: async (k, a, r, ev, o) => { calls.push(['partial', k, a, ev.source, o.decidedBy]); return partialRes; },
    });
    const dP = RD.parseReconcileDecision({ outcome: 'charged_partial', reason: 'x', amount: '0.5', evidence: EVID });
    const ok = await CTRL.applyReconcileDecision(mk({ reconciled: true, alreadySettled: false, amount: '1.0000000000', countedAmount: '0.5000000000', recordedSettlement: 'reconciled_as_charged_partial' }), 'k', dP, 'u1', { m: 1 });
    eq([ok.outcome, ok.countedAmount, ok.reconciled], ['charged_partial', '0.5000000000', true], 'partial');
    const same = await CTRL.applyReconcileDecision(mk({ reconciled: false, alreadySettled: true, amount: '1.0000000000', countedAmount: '0.5000000000', recordedSettlement: 'reconciled_as_charged_partial' }), 'k', dP, 'u1', {});
    eq([same.alreadySettled, same.reconciled], [true, false], 'repetir = no-op');
    for (const r of [{ countedAmount: '1.0000000000', recordedSettlement: 'reconciled_as_charged' }, { countedAmount: '0.4000000000', recordedSettlement: 'reconciled_as_charged_partial' }, { countedAmount: '0.0000000000', recordedSettlement: 'measured_differs' }]) {
      const e = await rejects(CTRL.applyReconcileDecision(mk({ reconciled: false, alreadySettled: true, amount: '1.0000000000', ...r }), 'k', dP, 'u1', {}), (x) => x instanceof ConflictException, 'conflicto');
      eq(e.getResponse().code, 'reservation_already_settled', 'código');
    }
    await CTRL.applyReconcileDecision(mk(null), 'k2', RD.parseReconcileDecision({ outcome: 'charged', reason: 'x' }), 'u1', { tts: true });
    eq(calls[calls.length - 1], ['charged', 'k2', { tts: true }], 'charged sigue igual');
    eq(calls[0], ['partial', 'k', '0.5000000000', 'provider_usage_log', 'u1'], 'partial con decidedBy');
  });

  await check('[PR] pricing-proposal.r60.json: filas nuevas append-only (sin colisión con el seed), re-emisiones con la MISMA tarifa, effective_from posterior, valores del CHECK de source', async () => {
    const seed = require(path.join(REPO, 'src/modules/finops/pricing-seed.v1.json')).rows;
    const prop = require(path.join(REPO, 'src/modules/finops/pricing-proposal.r60.json'));
    const k = (r) => [r.provider, r.service, r.product_or_model, r.meter, r.pricing_version].join('|');
    const seedKeys = new Set(seed.map(k));
    assert(prop.rows.length > 0 && prop.rows.every((r) => !seedKeys.has(k(r))), 'sin colisión de (provider, service, modelo, medidor, versión)');
    eq(new Set(prop.rows.map(k)).size, prop.rows.length, 'sin duplicados');
    for (const r of prop.rows) {
      assert(['public_pricing_page', 'contract', 'observed_invoice', 'observed', 'placeholder', 'by_design'].includes(r.source), `source ${r.source}`);
      assert(Number(r.unit_price) >= 0 && Number(r.unit_size) > 0 && r.currency === 'USD' && r.effective_to === null, 'forma');
      const old = seed.filter((o) => o.provider === r.provider && o.service === r.service && o.product_or_model === r.product_or_model && o.meter === r.meter);
      for (const o of old) {
        assert(Date.parse(r.effective_from) > Date.parse(o.effective_from), `effective_from posterior ${k(r)}`);
        eq(F.normalizeDecimal(r.unit_price), F.normalizeDecimal(o.unit_price), `re-emisión con la misma tarifa ${k(r)}`);
        eq(F.normalizeDecimal(r.unit_size), F.normalizeDecimal(o.unit_size), `misma unidad ${k(r)}`);
      }
      if (r.verified) assert(r.source === 'public_pricing_page' && /https:\/\//.test(r.source_ref), `verified con URL oficial ${k(r)}`);
    }
    const cat = [...seed, ...prop.rows].map((r, i) => ({ ...r, id: String(i) }));
    const at = (iso, product) => ({ provider: 'anthropic', service: 'messages', product, asOf: iso });
    const before = F.priceUsage({ input_tokens: 1000000, cache_read_tokens: 1000000 }, cat, at('2026-10-19T12:00:00Z', 'claude-sonnet-4-6'));
    const after = F.priceUsage({ input_tokens: 1000000, cache_read_tokens: 1000000 }, cat, at('2026-10-21T00:00:00Z', 'claude-sonnet-4-6'));
    eq([before.amount, after.amount], ['3.3000000000', '3.3000000000'], 'misma tarifa antes y después');
    eq([before.pricingSnapshot.lines[0].pricing_version, after.pricingSnapshot.lines[0].pricing_version], ['anthropic-2026-06', 'anthropic-2026-10-19-verified'], 'gana la versión vigente');
    eq(F.priceUsage({ input_tokens: 1000000, cache_read_tokens: 1000000, output_tokens: 1000000 }, cat, at('2026-10-21T00:00:00Z', 'claude-sonnet-5-5')).amount, '12.1000000000', 'sonnet-5-5 (cr 0,05×)');
    eq(F.priceUsage({ audio_seconds: 60 }, cat, { provider: 'openai', service: 'audio.speech', product: 'gpt-4o-mini-tts-2025-12-15', asOf: '2026-10-21T00:00:00Z' }).amount, '0.0150000000', 'snapshot 2025-12-15 con audio_seconds');
  });
}

// ─── DB ─────────────────────────────────────────────────────────────────────
function findPgBin() {
  const cands = [process.env.PG_BIN, '/opt/homebrew/opt/postgresql@16/bin', '/opt/homebrew/bin', '/usr/lib/postgresql/16/bin'].filter(Boolean);
  for (const d of cands) {
    const pg = path.join(d, 'postgres');
    if (!fs.existsSync(pg)) continue;
    const v = spawnSync(pg, ['--version'], { encoding: 'utf8' }).stdout || '';
    if (/\b16\./.test(v)) return d;
  }
  throw new Error('No encontré Postgres 16 (setear PG_BIN)');
}
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => ([5570, 8099].includes(port) ? freePort().then(resolve, reject) : resolve(port))); });
  });
}
function cleanEnv(extra) {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C', LC_ALL: 'C' };
  for (const [k, v] of Object.entries(extra || {})) if (v !== undefined && v !== null) env[k] = String(v);
  return env;
}

const OWNER = '11111111-2222-4333-8444-555555555555';
const ENV_KEYS = ['SUPER_ADMIN_EMAILS'];

async function dbChecks() {
  const { Client } = require('pg');
  const { DataSource } = require('typeorm');
  const { Artifact } = L('modules/artifacts/entities/artifact.entity.js');
  const CR = L('modules/finops/cost-read.service.js');
  const { VideogenReconciliationService } = L('modules/dynamic-generation/videogen-reconciliation.service.js');

  const pgBin = findPgBin();
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-r60-db16-'));
  const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-r60-cwd-'));
  const ROLE = 'postgres.r60local01';
  const DB = 'r60db';
  let started = false;
  const pg = (bin, a) => spawnSync(path.join(pgBin, bin), a, { env: cleanEnv(), encoding: 'utf8' });
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  const restoreProviders = applyFakeProviderEnv();
  let ds = null;
  try {
    let r = pg('initdb', ['-D', dataDir, '-U', 'postgres', '--auth=trust', '-E', 'UTF8', '--locale=C']);
    if (r.status !== 0) throw new Error('initdb falló: ' + r.stderr);
    r = pg('pg_ctl', ['-D', dataDir, '-l', path.join(dataDir, 'server.log'), '-w', '-o', `-p ${port} -k ${dataDir} -c listen_addresses=127.0.0.1 -c timezone=America/Bogota`, 'start']);
    if (r.status !== 0) throw new Error('pg_ctl start falló: ' + r.stderr + r.stdout);
    started = true;
    const withClient = async (db, fn) => { const c = new Client({ host: '127.0.0.1', port, user: 'postgres', database: db }); await c.connect(); try { return await fn(c); } finally { await c.end(); } };
    await withClient('postgres', async (c) => { await c.query(`create database ${DB}`); await c.query(`create role "${ROLE}" superuser login`); });
    const localEnv = (extra) => ({ DB_HOST: '127.0.0.1', DB_PORT: port, DB_USER: ROLE, DB_PASS: 'x', DB_NAME: DB, DB_SSL: 'false', ...extra });
    const runScript = (script, env) => { const res = spawnSync(process.execPath, [path.join(REPO, script)], { cwd: tmpCwd, env: cleanEnv(env), encoding: 'utf8', timeout: 120000 }); return { code: res.status, out: (res.stdout || '') + (res.stderr || '') }; };
    await withClient(DB, async (c) => {
      for (const f of ['scripts/prod/test/fixtures/legacy-baseline.sql', 'supabase-migration-dynamic-course-structure.sql', 'supabase-migration-course-blueprints.sql', 'supabase-migration-generation-manifests.sql']) await c.query(fs.readFileSync(path.join(REPO, f), 'utf8'));
    });
    { const res = runScript('scripts/migrate-production-jobs-constraints.js', localEnv({})); assert(res.code === 0, `migrate-production-jobs-constraints: ${res.out}`); }
    await withClient(DB, async (c) => { for (const f of ['supabase-migration-dynamic-generation.sql', 'supabase-migration-v21-blueprint-profiles.sql']) await c.query(fs.readFileSync(path.join(REPO, f), 'utf8')); });
    for (const s of ['scripts/migrate-dynamic-generation-v2.js', 'scripts/migrate-invalidation.js', 'scripts/migrate-v21-manifest-v3.js', 'scripts/migrate-v21-finops.js',
      'scripts/verify-v21-finops-schema.js', 'scripts/migrate-rel-recovery.js', 'scripts/migrate-rel-exec-lease.js', 'scripts/migrate-run-pause.js']) {
      const res = runScript(s, localEnv({ MIGRATION_ENV: 'staging' }));
      assert(res.code === 0, `${s}: exit ${res.code}\n${res.out.slice(-2000)}`);
    }
    process.env.SUPER_ADMIN_EMAILS = 'admin@cursia.test';
    ds = new DataSource({ type: 'postgres', host: '127.0.0.1', port, username: 'postgres', database: DB, entities: [Artifact], synchronize: false, extra: { max: 8 } });
    await ds.initialize();
    const ledger = new F.FinopsLedgerService(ds);
    const costRead = new CR.CostReadService(ds);

    // ── fixture: curso + run + partes (forma real del ledger; nada de datos reales) ──
    const CID = 9601;
    await ds.query(`insert into public.courses (id, owner_id, title, status, structure_version, metadata) values ($1, $2, 'Curso r60 parcial', 'draft', 'dynamic', '{}'::jsonb)`, [CID, OWNER]);
    const [{ id: RUN }] = await ds.query(
      `insert into public.production_jobs (owner_id, course_id, status, worker_status, execution_mode, input_payload) values ($1, $2, 'failed', 'failed', 'dynamic_generation', '{}'::jsonb) returning id`, [OWNER, CID]);
    const item = async (itemKey, type, status, error, outputSummary) => (await ds.query(
      `insert into public.generation_item_runs (job_id, course_id, item_key, generation, type, idempotency_key, status, error, finished_at, output_summary, scope, module_id, chapter_id)
       values ($1, $2, $3, 1, $4, $5, $6, $7, now(), $8::jsonb, 'chapter', 'aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000002') returning id`,
      [RUN, CID, itemKey, type, `${RUN}:${itemKey}:1`, status, error, JSON.stringify(outputSummary || {})]))[0].id;
    // Fixture mínima: las partes solo necesitan job/curso para la atribución del ledger (sin blueprint/manifest reales).
    for (const c of (await ds.query(`select column_name from information_schema.columns where table_schema = 'public' and table_name = 'generation_item_runs'
        and is_nullable = 'NO' and column_default is null and column_name not in ('id', 'job_id', 'item_key', 'type', 'status', 'generation', 'idempotency_key')`))) {
      await ds.query(`alter table public.generation_item_runs alter column "${c.column_name}" drop not null`);
    }
    const TTS_ITEM = await item('audiobook_chapter:c1', 'audiobook_chapter', 'completed', null, {});
    let seq = 0;
    const reservation = async (o) => {
      seq++;
      const [row] = await ds.query(
        `insert into public.generation_cost_events (event_kind, owner_id, course_id, run_id, item_run_id, item_key, item_type, operation, call_role, attempt, provider, service, model_or_product,
            idempotency_key, amount, cost_source, measurement_status, billing_account, billable, outcome, recorded_by, metadata, usage)
         values ('CHARGE',$1,$2,$3,$4,$5,$6,$7,'main',1,$8,$9,$10,$11,$12,'CALCULATED_FROM_USAGE',$13,'cursia',true,'succeeded','check-r60',$14::jsonb,$15::jsonb) returning id, idempotency_key`,
        [OWNER, CID, RUN, o.itemRunId, o.itemKey, o.itemType, o.operation, o.provider, o.service, o.model, o.key, o.amount, o.status || 'pending',
          JSON.stringify(o.meta || { reservation: true, estimatedPending: true, reservedBeforeCall: true, callTag: `t${seq}`, generation: 1 }), JSON.stringify(o.usage || {})]);
      return row;
    };
    const tts = (tag, amount = '0.0735000000') => reservation({ itemRunId: TTS_ITEM, itemKey: 'audiobook_chapter:c1', itemType: 'audiobook_chapter', operation: 'tts.speech', provider: 'openai', service: 'audio.speech',
      model: 'gpt-4o-mini-tts', key: `reservation:tts:${TTS_ITEM}:g1:a${seq + 1}:seg_${tag}`, amount, usage: { audio_seconds: 294 } });
    const family = async (key) => ds.query(
      `select e.event_kind, e.amount::text as amount, e.measurement_status, e.recorded_by, e.corrects_event_id, e.metadata, e.idempotency_key from public.generation_cost_events e
        where e.idempotency_key = $1 or e.corrects_event_id = (select id from public.generation_cost_events where idempotency_key = $1) order by e.created_at, e.id`, [key]);
    const net = async (key) => (await ds.query(
      `select coalesce(sum(amount),0)::text as t from public.generation_cost_events where idempotency_key = $1 or corrects_event_id = (select id from public.generation_cost_events where idempotency_key = $1)`, [key]))[0].t;
    const count = async () => Number((await ds.query(`select count(*)::int as n from public.generation_cost_events`))[0].n);
    const TEVID = { source: 'equivalent_request_ledger', referenceIds: ['openai_tts:req:equivalente-snapshot'], observedAmount: '0.0545' };

    const r1 = await tts('a');
    await check('[P1] charged_partial: UN ADJUSTMENT final append-only (corrects_event_id = reserva, delta = amount − reservado) con evidencia, actor y montos; el CHARGE original intacto', async () => {
      const out = await ledger.reconcileReservationAsChargedPartial(r1.idempotency_key, '0.0545', 'r60 check: equivalente medido', TEVID, { decidedBy: 'admin-uuid', metadata: { ttsReservation: true } });
      eq([out.reconciled, out.alreadySettled, out.amount, out.countedAmount, out.recordedSettlement], [true, false, '0.0735000000', '0.0545000000', 'reconciled_as_charged_partial'], 'resultado');
      const fam = await family(r1.idempotency_key);
      eq(fam.map((e) => [e.event_kind, e.amount, e.measurement_status]), [['CHARGE', '0.0735000000', 'pending'], ['ADJUSTMENT', '-0.0190000000', 'final']], 'familia');
      eq(fam[1].corrects_event_id, r1.id, 'corrects_event_id');
      const m = fam[1].metadata;
      eq([m.settlement, m.reservationReconciledAsCharged, m.reservationReconciledAsPartial, m.decidedBy, m.reservedAmount, m.countedAmount, m.ttsReservation, m.reason],
        ['reconciled_as_charged_partial', true, true, 'admin-uuid', '0.0735000000', '0.0545000000', true, 'r60 check: equivalente medido'], 'metadata');
      eq([m.evidence.source, m.evidence.referenceIds, m.evidence.observedAmount, m.evidence.currency], ['equivalent_request_ledger', ['openai_tts:req:equivalente-snapshot'], '0.0545000000', 'USD'], 'evidencia');
      eq(await net(r1.idempotency_key), '0.0545000000', 'neto = amount');
      eq(await ledger.reservationSettled(r1.idempotency_key), true, 'cerrada');
    });

    await check('[P2] idempotente: repetir = no-op; luego charged / not_charged / otro monto = alreadySettled sin escribir', async () => {
      const n0 = await count();
      const again = await ledger.reconcileReservationAsChargedPartial(r1.idempotency_key, '0.0545', 'otra vez', TEVID, { decidedBy: 'admin-uuid' });
      eq([again.reconciled, again.alreadySettled, again.countedAmount, again.recordedSettlement], [false, true, '0.0545000000', 'reconciled_as_charged_partial'], 'repetir');
      const other = await ledger.reconcileReservationAsChargedPartial(r1.idempotency_key, '0.0100', 'otro monto', TEVID, { decidedBy: 'admin-uuid' });
      eq([other.reconciled, other.alreadySettled, other.countedAmount], [false, true, '0.0545000000'], 'otro monto: informa lo registrado');
      eq((await ledger.reconcileReservationAsCharged(r1.idempotency_key, 'x', { decidedBy: 'a' })).alreadySettled, true, 'charged');
      eq((await ledger.reconcileReservationAsNotCharged(r1.idempotency_key, 'x', { decidedBy: 'a' })).alreadySettled, true, 'not_charged');
      eq(await count(), n0, 'sin filas nuevas');
      await rejects(CTRL.applyReconcileDecision(ledger, r1.idempotency_key, RD.parseReconcileDecision({ outcome: 'charged_partial', reason: 'x', amount: '0.0100', evidence: TEVID }), 'admin-uuid', {}),
        (e) => e instanceof ConflictException, 'endpoint: otro monto → 409');
      const ok = await CTRL.applyReconcileDecision(ledger, r1.idempotency_key, RD.parseReconcileDecision({ outcome: 'charged_partial', reason: 'x', amount: '0.0545', evidence: TEVID }), 'admin-uuid', {});
      eq([ok.alreadySettled, ok.countedAmount], [true, '0.0545000000'], 'endpoint: mismo monto → no-op');
    });

    await check('[P3] rechazos sin escribir: amount > reservado, amount 0, sin evidence/decidedBy, no es reserva, reserva no pendiente, no existe', async () => {
      const r = await tts('b');
      const n0 = await count();
      const inv = (e) => e && e.code === 'INVALID_INPUT';
      await rejects(ledger.reconcileReservationAsChargedPartial(r.idempotency_key, '0.0735000001', 'x', TEVID, { decidedBy: 'a' }), (e) => inv(e) && /supera lo reservado/.test(e.message), 'amount > reservado');
      await rejects(ledger.reconcileReservationAsChargedPartial(r.idempotency_key, '0', 'x', TEVID, { decidedBy: 'a' }), inv, 'amount 0');
      await rejects(ledger.reconcileReservationAsChargedPartial(r.idempotency_key, '0.01', 'x', null, { decidedBy: 'a' }), inv, 'sin evidence');
      await rejects(ledger.reconcileReservationAsChargedPartial(r.idempotency_key, '0.01', 'x', TEVID, {}), inv, 'sin decidedBy');
      const notRes = await reservation({ itemRunId: TTS_ITEM, itemKey: 'audiobook_chapter:c1', itemType: 'audiobook_chapter', operation: 'tts.speech', provider: 'openai', service: 'audio.speech', model: 'gpt-4o-mini-tts',
        key: `openai_tts:req:${crypto.randomUUID()}`, amount: '0.05', status: 'final', meta: {} });
      const n1 = await count();
      await rejects(ledger.reconcileReservationAsChargedPartial(notRes.idempotency_key, '0.01', 'x', TEVID, { decidedBy: 'a' }), (e) => inv(e) && /no es una reserva/.test(e.message), 'no reserva');
      const finalRes = await tts('c');
      await ds.query(`insert into public.generation_cost_events (event_kind, owner_id, course_id, run_id, operation, call_role, attempt, provider, idempotency_key, amount, cost_source, measurement_status, billing_account, billable, outcome, recorded_by, metadata)
        values ('CHARGE',$1,$2,$3,'tts.speech','main',1,'openai',$4,'0.07','CALCULATED_FROM_USAGE','final','cursia',true,'succeeded','check-r60','{"reservation":true}'::jsonb)`, [OWNER, CID, RUN, `reservation:tts:${TTS_ITEM}:g1:a99:seg_final`]);
      await rejects(ledger.reconcileReservationAsChargedPartial(`reservation:tts:${TTS_ITEM}:g1:a99:seg_final`, '0.01', 'x', TEVID, { decidedBy: 'a' }), (e) => inv(e) && /no está pendiente/.test(e.message), 'no pendiente');
      await rejects(ledger.reconcileReservationAsChargedPartial('reservation:tts:nope', '0.01', 'x', TEVID, { decidedBy: 'a' }), (e) => e.code === 'ORIGINAL_NOT_FOUND', 'no existe');
      eq(await count(), n1 + 2, 'solo las filas del fixture');
      assert(n1 === n0 + 1, 'rechazos sin escribir');
      eq(await ledger.reservationSettled(finalRes.idempotency_key), false, 'otra reserva sigue abierta');
    });

    await check('[P4] concurrencia: 8 conciliaciones parciales simultáneas (montos distintos) de la misma clave → UN ADJUSTMENT', async () => {
      const r = await tts('d');
      const outs = await Promise.all(Array.from({ length: 8 }, (_, i) => ledger.reconcileReservationAsChargedPartial(r.idempotency_key, `0.0${50 + i}`, `c${i}`, TEVID, { decidedBy: 'a' })));
      eq(outs.filter((o) => o.reconciled).length, 1, 'una sola decisión gana');
      const fam = await family(r.idempotency_key);
      eq(fam.filter((e) => e.event_kind === 'ADJUSTMENT').length, 1, 'un ADJUSTMENT');
      const winner = outs.find((o) => o.reconciled);
      eq(await net(r.idempotency_key), winner.countedAmount, 'neto = monto ganador');
      assert(outs.filter((o) => !o.reconciled).every((o) => o.alreadySettled && o.countedAmount === winner.countedAmount), 'los demás informan lo registrado');
    });

    await check('[P5] CostReadService: parcial = «real» (no reservado), UNA llamada; comprometido = Σ exacto; reservas abiertas siguen en reservado', async () => {
      const before = await costRead.runCost(RUN);
      const r = await tts('e');
      const mid = await costRead.runCost(RUN);
      eq(F.subDec(mid.reserved, before.reserved), '0.0735000000', 'abierta en reservado');
      eq(mid.counts.providerCalls - before.counts.providerCalls, 1, 'reserva abierta = 1 llamada');
      await ledger.reconcileReservationAsChargedPartial(r.idempotency_key, '0.0300', 'x', TEVID, { decidedBy: 'a' });
      const after = await costRead.runCost(RUN);
      eq([after.reserved, F.subDec(after.actual, mid.actual), F.subDec(mid.committed, after.committed)], [before.reserved, '0.0300000000', '0.0435000000'], 'reservado / real / comprometido');
      eq([after.counts.providerCalls, after.counts.openReservations], [mid.counts.providerCalls, mid.counts.openReservations - 1], 'llamadas sin doble conteo');
      const [sum] = await ds.query(`select coalesce(sum(amount),0)::text as t from public.generation_cost_events where run_id = $1 and billing_account = 'cursia'`, [RUN]);
      eq(after.committed, F.normalizeDecimal(sum.t), 'comprometido = neto del ledger');
    });

    await check('[P6] uso tardío del proveedor tras una parcial: gana la medición real (menor o mayor); la reserva queda a 0 y la llamada cuenta una vez', async () => {
      const charge = (rid, amount) => ({ itemRunId: TTS_ITEM, ownerIdFromAuth: OWNER, executorAuthorization: 'server_worker', provider: 'openai', service: 'audio.speech', modelOrProduct: 'gpt-4o-mini-tts',
        usage: { audio_seconds: 200 }, idempotencyKey: `openai_tts:req:${rid}`, billingAccount: 'cursia', mode: 'real', costSource: 'ACTUAL_PROVIDER', actualAmount: amount, recordedBy: 'check-r60' });
      for (const [tag, partial, real] of [['f', '0.0500', '0.0410000000'], ['g', '0.0300', '0.0700000000']]) {
        const r = await tts(tag);
        await ledger.reconcileReservationAsChargedPartial(r.idempotency_key, partial, 'x', TEVID, { decidedBy: 'a' });
        const c0 = await costRead.runCost(RUN);
        const s = await ledger.settleReservation(r.idempotency_key, charge(`late-${tag}`, real), 'openai_tts_measured');
        eq([s.finalInserted, s.alreadySettled], [true, true], `${tag}: cargo real insertado`);
        eq(await net(r.idempotency_key), '0.0000000000', `${tag}: reserva a 0`);
        const fam = await family(r.idempotency_key);
        eq(fam[fam.length - 1].metadata.supersededBy, `openai_tts:req:late-${tag}`, `${tag}: supersededBy`);
        const c1 = await costRead.runCost(RUN);
        eq([F.subDec(c1.committed, c0.committed), c1.counts.providerCalls - c0.counts.providerCalls], [F.subDec(real, F.normalizeDecimal(partial)), 0], `${tag}: comprometido ajustado, misma cantidad de llamadas`);
        const again = await ledger.settleReservation(r.idempotency_key, charge(`late-${tag}`, real), 'openai_tts_measured');
        eq(again.finalInserted, false, `${tag}: repetir = no-op`);
      }
      // charged (completo) mantiene su regla previa: un real MENOR no agrega cargo.
      const r = await tts('h');
      await ledger.reconcileReservationAsCharged(r.idempotency_key, 'x', { decidedBy: 'a' });
      const s = await ledger.settleReservation(r.idempotency_key, charge('late-h', '0.0100000000'), 'openai_tts_measured');
      eq(s.finalInserted, false, 'charged completo: real menor no se suma (regla previa intacta)');
    });

    await check('[P7] Videogen (servicio admin): charged_partial con evidencia; ack si pudo renderizarse; repetir no-op; otro monto → 409; no SUPER_ADMIN → 403', async () => {
      const VG_ITEM = await item('video:c1', 'video', 'failed', 'videogen_failed: generate_script failed (429)', {});
      const vg = await reservation({ itemRunId: VG_ITEM, itemKey: 'video:c1', itemType: 'video', operation: 'videogen.render', provider: 'videogen', service: 'render', model: 'video',
        key: `reservation:videogen:${VG_ITEM}:g1:a1:submit`, amount: '1.1750000000', usage: { video_render: 1.25 } });
      const svc = new VideogenReconciliationService(ds, ledger);
      const ADMIN = { id: 'admin-uuid', email: 'admin@cursia.test' };
      const body = { reservationKey: vg.idempotency_key, outcome: 'charged_partial', reason: 'Videogen api_usage_logs: job consumió 0.5351, sin render', amount: '0.5351', evidence: EVID };
      const pend = (await svc.listPending(RUN)).pending.find((p) => p.reservationKey === vg.idempotency_key);
      assert(pend, 'pendiente');
      await rejects(svc.reconcile(RUN, body, { id: 'x', email: 'owner@x.test' }), (e) => e.getStatus && e.getStatus() === 403, 'no admin → 403');
      await rejects(svc.reconcile(RUN, { ...body, evidence: undefined }, ADMIN), (e) => e instanceof BadRequestException, 'sin evidencia → 400');
      if (pend.mayHaveRendered) {
        await rejects(svc.reconcile(RUN, body, ADMIN), (e) => e instanceof ConflictException && e.getResponse().code === 'may_have_rendered_ack_required', 'ack obligatorio');
        body.acknowledgeMayHaveRendered = true;
      }
      await rejects(svc.reconcile(RUN, { ...body, amount: '2' }, ADMIN), (e) => /supera lo reservado/.test(e.message), 'amount > reservado');
      const out = await svc.reconcile(RUN, body, ADMIN);
      eq([out.outcome, out.reconciled, out.amount, out.countedAmount], ['charged_partial', true, '1.1750000000', '0.5351000000'], 'conciliada');
      assert(!out.remaining.some((p) => p.reservationKey === vg.idempotency_key), 'ya no pendiente');
      const fam = await family(vg.idempotency_key);
      eq([fam[1].amount, fam[1].recorded_by, fam[1].metadata.settlement, fam[1].metadata.decidedByRole, fam[1].metadata.evidence.referenceIds[0]],
        ['-0.6399000000', 'admin_reconcile_videogen', 'reconciled_as_charged_partial', 'SUPER_ADMIN', 'videogen:job:edef3614'], 'ADJUSTMENT');
      const again = await svc.reconcile(RUN, body, ADMIN);
      eq([again.reconciled, again.alreadySettled, again.countedAmount], [false, true, '0.5351000000'], 'repetir = no-op');
      await rejects(svc.reconcile(RUN, { ...body, amount: '0.6' }, ADMIN), (e) => e instanceof ConflictException, 'otro monto → 409');
      await rejects(svc.reconcile(RUN, { reservationKey: vg.idempotency_key, outcome: 'not_charged', reason: 'cambio de opinión ya registrado', acknowledgeMayHaveRendered: true }, ADMIN), (e) => e instanceof ConflictException, 'otra decisión → 409');
    });

    await check('[P8] el ledger sigue append-only: UPDATE y DELETE rechazados por la base', async () => {
      await rejects(ds.query(`update public.generation_cost_events set amount = 0 where idempotency_key = $1`, [r1.idempotency_key]), () => true, 'UPDATE');
      await rejects(ds.query(`delete from public.generation_cost_events where idempotency_key = $1`, [r1.idempotency_key]), () => true, 'DELETE');
      eq(await net(r1.idempotency_key), '0.0545000000', 'sin cambios');
    });
  } finally {
    try { if (ds) await ds.destroy(); } catch {}
    if (started) pg('pg_ctl', ['-D', dataDir, '-m', 'immediate', '-w', 'stop']);
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    restoreProviders();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(tmpCwd, { recursive: true, force: true });
  }
}

(async () => {
  await pureChecks();
  if (!PURE_ONLY) await dbChecks();
  console.log(`\n${passes} OK, ${failures} fallidos`);
  process.exit(failures ? 1 : 0);
})().catch((err) => {
  console.error(`❌ fatal: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
