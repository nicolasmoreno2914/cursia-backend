#!/usr/bin/env node
/* eslint-disable */
// r63 (SC) — simulación de carga DETERMINISTA del scheduler de la generación dinámica: 1, 2, 12, 50 y 100 cursos.
//
// DOS PARTES (ninguna demuestra capacidad de producción: proveedores FALSOS, tiempos de #1353/#1510, límites de
// proveedor SUPUESTOS; ver ~/cursia-test-env/work/r63/SC-design.md):
//
//  A. «código real» (--part=real): Postgres 16 DESECHABLE + el SchedulerService REAL (claim / failItem / barrido de
//     leases / recomputeRunStatus), el loop real de los workers (runClaimLoop) y el ledger FinOps REAL (reservas antes
//     de cada llamada falsa, liquidación / liberación, priorPaidOperations al re-reclamar). Cursos 1×2 (16 partes, todos
//     los tipos v3) con tiempos ACELERADOS (×TIME_SCALE: 1 s real = TIME_SCALE s simulados). El cierre de una parte
//     exitosa lo hace el harness con la misma transición que completeItem tras validar (la validación v3 de artifacts no
//     se mide acá). Fallas inyectadas (5xx conocidos, cobros con falla, 429 de los límites falsos) y reinicio de los dos
//     «procesos» de workers a mitad de corrida. El backoff del scheduler (30·2^n s reales) y el vencimiento de la lease
//     se comprimen con el mismo factor (el harness reescribe next_retry_at / lease_until); todo lo demás es real.
//  B. «modelo» (--part=model): simulación de eventos discretos (tiempo virtual, sin DB) con cursos M 3×4 (112 partes,
//     las cantidades y tiempos medidos de #1353) para estimar la capacidad: throughput por tipo, tiempo hasta el último
//     curso, equidad, espera en cola; topologías actual / propuesta / escala y la cuota de YouTube.
//
// Determinista: PRNG con semilla fija (--seed). Netguard: correr con NODE_OPTIONS="--require test/e2e-v2/netguard.js".
// USD 0: ningún proveedor real (fetch bloqueado salvo data:).
//
// Usage: npm run build && node scripts/e2e/r63-load-sim.js [--part=real|model|all] [--n=1,2,12,50,100] [--seed=63]
//        [--out=<archivo.json>]
'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
require('reflect-metadata');
const realFetch = global.fetch;
global.fetch = async (u, o) => { if (String(u).startsWith('data:')) return realFetch(u, o); throw new Error(`NETWORK FORBIDDEN in sim: ${u}`); };

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = /^--([^=]+)(?:=(.*))?$/.exec(a); return m ? [m[1], m[2] ?? 'true'] : [a, 'true']; }));
const PART = args.part || 'all';
const NS = String(args.n || '1,2,12,50,100').split(',').map(Number);
const SEED = Number(args.seed || 63);

// ─── PRNG determinista ──────────────────────────────────────────────────────
function rng(seed) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
/** Lognormal con mediana `p50` y p90 ≈ p50·r90. */
function lognorm(rand, p50, r90 = 1.25) {
  const u1 = Math.max(rand(), 1e-12); const u2 = rand();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return p50 * Math.exp((Math.log(r90) / 1.2816) * z);
}
const pct = (xs, p) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
/** Índice de Jain sobre x_i (1 = perfectamente parejo). */
const jain = (xs) => { if (!xs.length) return null; const s = xs.reduce((a, b) => a + b, 0); const s2 = xs.reduce((a, b) => a + b * b, 0); return (s * s) / (xs.length * s2); };
const h = (s) => (s === null || s === undefined ? '—' : (s / 3600).toFixed(s < 36000 ? 2 : 1));

// ─── Tiempos por tipo (segundos), fuente ────────────────────────────────────
// [V] medido en #1353 (pilot-metrics, p50): video 572, application_activity 463, audiobook_chapter 433, experience 208,
//     guided_practice 173; #1510: audio_welcome ≈13 s. [E] estimado (no medido por tipo): el resto.
const DUR = {
  video: { p50: 572, src: 'V' }, application_activity: { p50: 463, src: 'V' }, audiobook_chapter: { p50: 433, src: 'V' },
  experience: { p50: 208, src: 'V' }, guided_practice: { p50: 173, src: 'V' }, audio_welcome: { p50: 13, src: 'V' },
  presentation: { p50: 170, src: 'E' }, content: { p50: 150, src: 'E' }, video_interactions: { p50: 120, src: 'E' },
  activity: { p50: 100, src: 'E' }, exam: { p50: 900, src: 'E' }, final_exam: { p50: 600, src: 'E' },
  course_plan: { p50: 120, src: 'E' }, course_intro: { p50: 60, src: 'E' }, module_intro: { p50: 60, src: 'E' },
};
const CLASS_OF = (t) => (t === 'video' ? 'video' : ['presentation', 'audio_welcome', 'audiobook_chapter'].includes(t) ? 'provider' : 'llm');
const PROVIDER_OF = (t) => (t === 'video' ? 'videogen' : t === 'presentation' ? 'gamma' : ['audio_welcome', 'audiobook_chapter'].includes(t) ? 'openai_tts' : 'anthropic');
const PACKAGE_SECONDS = 94; // [V] #1353 empaque 94 s
const YT_UPLOAD_SECONDS = 60; // [E] solo la subida del MP4 ya generado (reintento por cuota)

// ═════════════════════════════════════════════════════════════════════════════
// B. MODELO (eventos discretos)
// ═════════════════════════════════════════════════════════════════════════════

/** Curso M 3×4 con las cantidades de #1353 (112 partes) y las dependencias del Manifest v3. */
function courseM(ci) {
  const items = [];
  const add = (type, key, deps) => items.push({ key: `${ci}:${key}`, type, deps: deps.map((d) => `${ci}:${d}`) });
  add('course_plan', 'cp', []);
  add('course_intro', 'ci', ['cp']);
  add('audio_welcome', 'aw', ['ci']);
  let exp = 0;
  for (let m = 1; m <= 3; m++) {
    add('module_intro', `mi${m}`, ['cp']);
    const cs = [];
    for (let c = 1; c <= 4; c++) {
      const k = `${m}.${c}`; cs.push(`ct${k}`);
      add('content', `ct${k}`, ['cp']);
      add('experience', `ex${k}`, [`ct${k}`]); exp++;
      add('activity', `ac${k}`, [`ct${k}`]);
      add('guided_practice', `gp${k}`, [`ct${k}`]);
      add('video', `v${k}`, [`ct${k}`]);
      add('video_interactions', `vi${k}`, [`v${k}`, `ct${k}`]);
      add('presentation', `p${k}`, [`ct${k}`]);
      add('audiobook_chapter', `ab${k}`, [`ct${k}`]);
    }
    add('experience', `exP${m}`, cs); exp++;
    add('application_activity', `aa${m}`, cs);
    add('exam', `e${m}`, cs);
  }
  add('final_exam', 'fe', ['e1', 'e2', 'e3']);
  return items;
}

/** Cola de prioridad (heap binario) de eventos {t, seq, fn}. */
class Heap {
  constructor() { this.a = []; this.seq = 0; }
  get size() { return this.a.length; }
  push(t, fn) { const a = this.a; a.push({ t, s: this.seq++, fn }); let i = a.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (this.lt(a[i], a[p])) { [a[i], a[p]] = [a[p], a[i]]; i = p; } else break; } }
  pop() { const a = this.a; const top = a[0]; const last = a.pop(); if (a.length) { a[0] = last; let i = 0; for (;;) { const l = 2 * i + 1; const r = l + 1; let m = i; if (l < a.length && this.lt(a[l], a[m])) m = l; if (r < a.length && this.lt(a[r], a[m])) m = r; if (m === i) break; [a[i], a[m]] = [a[m], a[i]]; i = m; } } return top; }
  lt(x, y) { return x.t < y.t || (x.t === y.t && x.s < y.s); }
}
const lexLess = (a, b) => { for (let i = 0; i < a.length; i++) { if (a[i] < b[i]) return true; if (a[i] > b[i]) return false; } return false; };

/**
 * Simulación de eventos discretos. cfg: { n, owners:[cantidad por dueño], policy, admission, workers:{video,provider,llm},
 * caps:{videogen,gamma,openai_tts,anthropic}, youtubePerDay, failP, restartsEveryH, seed }.
 * Mismo orden de reparto que el claim real: fifo = orden de alta (run, posición); owner_rr = dueño servido hace más
 * tiempo (por clase de worker), FIFO dentro del dueño; run_rr = run servido hace más tiempo. Admisión: máximo de cursos
 * empezados a la vez (un curso entra con su primera parte y sale al terminar la generación).
 */
function simulateModel(cfg) {
  const rand = rng(cfg.seed);
  const courses = [];
  let ci = 0;
  cfg.owners.forEach((cnt, oi) => { for (let k = 0; k < cnt; k++) courses.push({ ci: ci++, owner: oi }); });
  const items = [];
  const byKey = new Map();
  for (const c of courses) for (const it of courseM(c.ci)) {
    const x = { ...it, course: c.ci, owner: c.owner, cls: CLASS_OF(it.type), prov: PROVIDER_OF(it.type), status: 'pending', attempts: 0, readyAt: null, doneAt: null, nextRetry: 0, ord: items.length, epoch: 0 };
    items.push(x); byKey.set(x.key, x);
  }
  for (const x of items) x.depItems = x.deps.map((d) => byKey.get(d));
  const dependents = new Map();
  for (const x of items) for (const d of x.depItems) { if (!dependents.has(d.key)) dependents.set(d.key, []); dependents.get(d.key).push(x); }
  const remaining = new Map(courses.map((c) => [c.ci, 0]));
  for (const x of items) remaining.set(x.course, remaining.get(x.course) + 1);
  const courseDone = new Map();
  const running = { video: 0, provider: 0, llm: 0 };
  const provRunning = { videogen: 0, gamma: 0, openai_tts: 0, anthropic: 0 };
  const lastRun = { video: new Map(), provider: new Map(), llm: new Map() };
  const lastOwner = { video: new Map(), provider: new Map(), llm: new Map() };
  const admitted = new Set();
  const pool = { video: new Set(), provider: new Set(), llm: new Set() }; // pendientes con dependencias completas
  const ytByDay = new Map(); const ytWaiting = new Set();
  let now = 0;
  const ev = new Heap();
  const waits = [];
  const stats = { failures: 0, restarts: 0, lost: 0, ytWaits: 0, ytExhausted: 0 };
  for (const x of items) if (!x.depItems.length) { x.readyAt = 0; pool[x.cls].add(x); }
  let pkgBusy = 0; const pkgQueue = []; const pkgDone = new Map();
  let serveSeq = 0;
  const keyOf = (x) => (cfg.policy === 'owner_rr' ? [lastOwner[x.cls].get(x.owner) ?? -1, x.ord]
    : cfg.policy === 'run_rr' ? [lastRun[x.cls].get(x.course) ?? -1, x.course, x.ord] : [x.ord]);
  function pick(cls) {
    let best = null; let bk = null;
    for (const x of pool[cls]) {
      if (x.nextRetry > now) continue;
      const cap = cfg.caps && cfg.caps[x.prov];
      if (cap && provRunning[x.prov] >= cap) continue;
      if (cfg.admission && !admitted.has(x.course) && admitted.size >= cfg.admission) continue;
      const k = keyOf(x);
      if (!bk || lexLess(k, bk)) { best = x; bk = k; }
    }
    return best;
  }
  function dispatch() {
    for (const cls of ['llm', 'provider', 'video']) {
      while (running[cls] < cfg.workers[cls]) {
        const x = pick(cls);
        if (!x) break;
        if (cfg.admission) admitted.add(x.course);
        start(x);
      }
    }
  }
  function start(x) {
    pool[x.cls].delete(x);
    x.status = 'running'; x.attempts++; running[x.cls]++; provRunning[x.prov]++;
    serveSeq++; lastRun[x.cls].set(x.course, serveSeq); lastOwner[x.cls].set(x.owner, serveSeq);
    waits.push(now - (x.readyAt ?? now));
    // Video ya renderizado que espera cuota de YouTube: el reintento solo sube el MP4 guardado (no se re-renderiza).
    const d = x.rendered ? YT_UPLOAD_SECONDS : lognorm(rand, DUR[x.type].p50);
    const fail = rand() < cfg.failP;
    const epoch = ++x.epoch;
    ev.push(now + (fail ? d * rand() : d), () => finish(x, fail, epoch));
  }
  function requeue(x, at) { x.status = 'pending'; x.nextRetry = at; x.readyAt = at; pool[x.cls].add(x); ev.push(at, () => {}); }
  function finish(x, fail, epoch) {
    if (x.status !== 'running' || x.epoch !== epoch) return;
    running[x.cls]--; provRunning[x.prov]--;
    if (fail) { stats.failures++; requeue(x, now + Math.min(600, 30 * 2 ** (x.attempts - 1))); return; }
    if (x.type === 'video' && cfg.youtubePerDay) {
      // YouTube (dynamic-item-worker.blockYoutubeQuota): sin cuota, el item vuelve a la cola (retrying) hasta el próximo
      // reinicio diario de la cuota + su turno FIFO (60 s por lugar); el worker queda libre. Más de 7 días esperando →
      // youtube_quota_exhausted (failed, retry humano): se cuenta y se sigue como si el humano reintentara.
      const day = Math.floor(now / 86400);
      const used = ytByDay.get(day) || 0;
      if (used >= cfg.youtubePerDay) {
        x.rendered = true;
        if (x.quotaSince === undefined) x.quotaSince = now;
        if (now - x.quotaSince > 7 * 86400 && !x.quotaExhausted) { x.quotaExhausted = true; stats.ytExhausted++; }
        stats.ytWaits++;
        ytWaiting.add(x);
        requeue(x, (day + 1) * 86400 + ytWaiting.size * 60);
        return;
      }
      ytByDay.set(day, used + 1); ytWaiting.delete(x);
    }
    x.status = 'done'; x.doneAt = now;
    for (const y of dependents.get(x.key) || []) if (y.status === 'pending' && y.depItems.every((d) => d.status === 'done')) { y.readyAt = Math.max(now, y.nextRetry); pool[y.cls].add(y); }
    remaining.set(x.course, remaining.get(x.course) - 1);
    if (remaining.get(x.course) === 0) { courseDone.set(x.course, now); admitted.delete(x.course); pkgQueue.push(x.course); runPackage(); }
  }
  function runPackage() {
    while (pkgBusy < 1 && pkgQueue.length) { const c = pkgQueue.shift(); pkgBusy++; ev.push(now + PACKAGE_SECONDS, () => { pkgBusy--; pkgDone.set(c, now); runPackage(); }); }
  }
  let nextRestart = cfg.restartsEveryH ? cfg.restartsEveryH * 3600 : Infinity;
  const restart = () => {
    stats.restarts++;
    for (const x of items) if (x.status === 'running') {
      running[x.cls]--; provRunning[x.prov]--; x.epoch++; stats.lost++;
      requeue(x, now + (x.cls === 'video' ? 120 : 300)); // lease vencida → barrido → reintento (trabajo perdido)
    }
  };
  if (Number.isFinite(nextRestart)) ev.push(nextRestart, function tick() { restart(); nextRestart += cfg.restartsEveryH * 3600; if (courseDone.size < courses.length) ev.push(nextRestart, tick); });
  dispatch();
  let guard = 0;
  while ((courseDone.size < courses.length || pkgQueue.length || pkgBusy) && ev.size && guard++ < 5e7) {
    const e = ev.pop(); now = e.t; e.fn(); if (courseDone.size < courses.length) dispatch();
  }
  const done = courses.map((c) => pkgDone.get(c.ci) ?? courseDone.get(c.ci));
  const makespan = Math.max(...done);
  const busy = {};
  for (const cls of ['video', 'provider', 'llm']) busy[cls] = items.filter((x) => x.cls === cls).reduce((a, x) => a + DUR[x.type].p50, 0) / (cfg.workers[cls] * makespan);
  const small = courses.filter((c) => cfg.owners[c.owner] === 1).map((c) => done[c.ci]);
  const firstOwnerDone = cfg.owners.map((_, oi) => Math.min(...courses.filter((c) => c.owner === oi).map((c) => done[c.ci])));
  return {
    makespan, firstDone: Math.min(...done), meanDone: mean(done), p50Done: pct(done, 50), p90Done: pct(done, 90),
    smallOwnersMeanDone: small.length ? mean(small) : null,
    jainOwnersFirst: jain(firstOwnerDone.map((t) => 1 / t)), jainCourses: jain(done.map((t) => 1 / t)),
    coursesPerDay: courses.length / (makespan / 86400),
    waitP50: pct(waits, 50), waitP95: pct(waits, 95), waitMax: Math.max(...waits),
    utilization: busy, ...stats,
  };
}

const OWNER_MIX = { 1: [1], 2: [1, 1], 12: [8, 1, 1, 1, 1], 50: [30, 10, ...Array(10).fill(1)], 100: [60, 20, ...Array(20).fill(1)] };
const TOPOLOGIES = {
  T0_staging_hoy: { workers: { video: 1, provider: 1, llm: 4 }, caps: null, note: 'video 1, Gamma/TTS 1 (serial), IA 4 (staging)' },
  T1_propuesta: { workers: { video: 3, provider: 3, llm: 6 }, caps: { videogen: 3, gamma: 2, openai_tts: 2, anthropic: 6 }, note: 'video 3, proveedor 3 (topes Gamma 2 / TTS 2), IA 6' },
  T2_escala: { workers: { video: 6, provider: 8, llm: 16 }, caps: { videogen: 6, gamma: 4, openai_tts: 4, anthropic: 16 }, note: '2–3 procesos por clase; exige tier de Anthropic, pooler y VPS' },
};

function runModel() {
  const out = [];
  for (const n of NS) for (const [tn, topo] of Object.entries(TOPOLOGIES)) for (const pol of [
    { name: 'actual (fifo)', policy: 'fifo', admission: null },
    { name: 'nuevo (owner_rr)', policy: 'owner_rr', admission: null },
    { name: 'nuevo (owner_rr + admisión 12)', policy: 'owner_rr', admission: 12 },
  ]) {
    if (n <= 2 && pol.admission) continue;
    for (const yt of [null, 12]) {
      if (yt && tn !== 'T0_staging_hoy' && n !== 12) continue; // la cuota de YouTube solo se muestra en una fila por escala (12/día = cota inferior verificada en #1353)
      const r = simulateModel({ n, owners: OWNER_MIX[n], policy: pol.policy, admission: pol.admission, workers: topo.workers, caps: topo.caps,
        youtubePerDay: yt, failP: 0.05, restartsEveryH: 24, seed: SEED + n });
      out.push({ n, topology: tn, policy: pol.name, youtubePerDay: yt, ...r });
    }
  }
  return out;
}

// ═════════════════════════════════════════════════════════════════════════════
// A. CÓDIGO REAL (PG + scheduler real + ledger real, tiempos acelerados)
// ═════════════════════════════════════════════════════════════════════════════

const REAL_LIMITS = {
  // Límites FALSOS de los proveedores falsos (supuestos; ver SC-design.md §1.4). Exceso → 429 (conocido, sin cobro).
  anthropic: { maxConcurrent: 8 }, gamma: { maxConcurrent: 2 }, openai_tts: { maxConcurrent: 2 }, videogen: { maxConcurrent: 2 },
};

async function runReal() {
  const B = require('./lib/r63-sim-pg');
  const { Logger } = require('@nestjs/common');
  Logger.overrideLogger(['error']);
  const WD = B.L('workers/worker-drain.js');
  const WH = B.L('workers/finops-worker-hooks.js');
  const QM = B.L('modules/dynamic-generation/scheduler-queue-metrics.js');
  const ALL = [...B.L('modules/generation-manifests/generation-manifest-builder.js').ALL_MANIFEST_ITEM_TYPES];
  const LLM_TYPES = ALL.filter((t) => CLASS_OF(t) === 'llm');
  const PROVIDER_TYPES = ['presentation', 'audio_welcome', 'audiobook_chapter'];
  const CONFIGS = [
    { name: 'actual', env: {}, workers: { video: 1, provider: 1, llm: 4 } },
    { name: 'nuevo', env: { DYNAMIC_SCHEDULER_POLICY: 'owner_rr', DYNAMIC_ADMISSION_ENABLED: 'true', DYNAMIC_ADMISSION_MAX_ACTIVE_RUNS: '12' }, workers: { video: 1, provider: 1, llm: 4 } },
    { name: 'nuevo+escala+topes', env: { DYNAMIC_SCHEDULER_POLICY: 'owner_rr', DYNAMIC_ADMISSION_ENABLED: 'true', DYNAMIC_ADMISSION_MAX_ACTIVE_RUNS: '12',
      DYNAMIC_SCHEDULER_PROVIDER_CAPS: 'videogen=2,gamma=2,openai_tts=2,anthropic=6' }, workers: { video: 3, provider: 3, llm: 6 } },
    { name: 'escala sin topes', env: { DYNAMIC_SCHEDULER_POLICY: 'owner_rr' }, workers: { video: 3, provider: 3, llm: 6 } },
  ];
  const results = [];
  for (const n of NS) for (const conf of CONFIGS) {
    if (n >= 50 && conf.name === 'escala sin topes') continue;
    const TIME_SCALE = n >= 50 ? 1000 : n >= 12 ? 500 : 250; // s simulados por s real
    for (const k of ['DYNAMIC_SCHEDULER_CAP_INFLIGHT_GRACE_SECONDS', 'DYNAMIC_SCHEDULER_POLICY', 'DYNAMIC_SCHEDULER_TYPE_CAPS', 'DYNAMIC_SCHEDULER_PROVIDER_CAPS', 'DYNAMIC_ADMISSION_ENABLED', 'DYNAMIC_ADMISSION_MAX_ACTIVE_RUNS', 'DYNAMIC_ADMISSION_MAX_ACTIVE_PER_OWNER']) delete process.env[k];
    const env = await B.startSimPg({ poolMax: 6, log: () => {} });
    Object.assign(process.env, conf.env);
    // La gracia de los topes (600 s reales por defecto) se comprime con el mismo factor que el resto de los tiempos.
    if (conf.env.DYNAMIC_SCHEDULER_PROVIDER_CAPS) process.env.DYNAMIC_SCHEDULER_CAP_INFLIGHT_GRACE_SECONDS = String(Math.ceil(600 / TIME_SCALE));
    const rand = rng(SEED * 1000 + n);
    let t0Real = Date.now();
    const procs = [];
    const simNow = () => ((Date.now() - t0Real) / 1000) * TIME_SCALE;
    const sleepSim = (s) => new Promise((r) => setTimeout(r, Math.max(1, (s / TIME_SCALE) * 1000)));
    try {
      // Siembra: dueños según la mezcla (el dueño grande envía primero: peor caso del FIFO).
      const owners = OWNER_MIX[n].map((_, i) => `${String(i + 1).padStart(8, '0')}-2222-4333-8444-555555555555`);
      const runs = [];
      for (let oi = 0; oi < owners.length; oi++) for (let k = 0; k < OWNER_MIX[n][oi]; k++) runs.push(await B.createCourseRun(env, { ownerId: owners[oi], title: `sim-${oi}-${k}`, chapters: 2, authorizedUsd: '20' }));
      const ownerOfRun = new Map(runs.map((r) => [r.runId, r.ownerId]));
      t0Real = Date.now();
      const ownerIdx = new Map(owners.map((o, i) => [o, i]));
      // Reloj comprimido del backoff: cada fallo nuevo (id + intento) se reescribe una vez.
      const compressed = new Set();
      const ticker = setInterval(async () => {
        try {
          const rows = await env.ds.query(`select id, attempt_count, next_retry_at, updated_at from public.generation_item_runs where status = 'retrying' and next_retry_at > now()`);
          for (const r of rows) {
            const key = `${r.id}:${r.attempt_count}`;
            if (compressed.has(key)) continue;
            compressed.add(key);
            const ms = Math.max(0, new Date(r.next_retry_at).getTime() - new Date(r.updated_at).getTime()) / TIME_SCALE;
            await env.ds.query(`update public.generation_item_runs set next_retry_at = updated_at + make_interval(secs => $2::float) where id = $1 and status = 'retrying' and attempt_count = $3`, [r.id, ms / 1000, r.attempt_count]);
          }
        } catch {}
      }, 25);
      // Proveedores falsos (estado compartido por todos los procesos): en vuelo por proveedor + verdad de cobro.
      const inflight = { anthropic: 0, gamma: 0, openai_tts: 0, videogen: 0 };
      const truth = new Map(); // reservationKey → 'charged' | 'not_charged'
      const counters = { calls: 0, http429: 0, known5xx: 0, chargedFail: 0, reconciled: 0, budgetCap: 0, lostOnKill: 0, claimMs: [] };
      const reservationKind = (t) => (t === 'video' ? 'videogen' : t === 'presentation' ? 'gamma' : ['audio_welcome', 'audiobook_chapter'].includes(t) ? 'tts' : 'llm');
      const chargeFor = (kind, item, ownerId) => {
        const role = WH.providerCallRoleOf(item.attempt);
        if (kind === 'llm') return WH.serverLlmChargeInput({ ownerId, itemRunId: item.itemRunId, model: 'claude-sonnet-4-6', messageId: `msg_sim_${crypto.randomUUID()}`, requestId: null,
          usage: { input_tokens: 6000, output_tokens: 3000 }, callRole: role.callRole, attempt: role.attempt });
        if (kind === 'gamma') return WH.gammaChargeInput({ ownerId, itemRunId: item.itemRunId, generationId: crypto.randomUUID(), creditsDeducted: 42, creditsRemaining: null, itemAttempt: item.attempt });
        if (kind === 'tts') return WH.ttsChargeInput({ ownerId, itemRunId: item.itemRunId, requestId: crypto.randomUUID(), audioSeconds: 60, characters: 900, model: 'gpt-4o-mini-tts', generation: item.generation, chunk: 0, itemAttempt: item.attempt });
        return WH.videogenChargeInput({ ownerId, itemRunId: item.itemRunId, jobId: crypto.randomUUID(), mode: 'real', cost: 0.92, outputSummary: null });
      };
      const estimate = (kind) => (kind === 'llm' ? { promptChars: 20000, maxTokens: 8000, model: 'claude-sonnet-4-6' } : kind === 'tts' ? { characters: 3900, model: 'gpt-4o-mini-tts' } : {});

      /** Un «proceso» de workers (pool de 1 conexión, como staging) con sus loops; kill() = caída dura. */
      async function spawnProc(name, classes, gen) {
        const svc = await env.proc(1);
        const p = { name: `${name}#${gen}`, svc, drain: new WD.DrainSignal(), killed: false, loops: [], active: [] };
        const mkLoop = (cls, types, conc) => {
          const active = new Set();
          p.active.push(active);
          const executorId = `${p.name}:${cls}`;
          return WD.runClaimLoop({
            name: executorId, logger: { log() {}, warn() {}, error() {} }, concurrency: conc, pollMs: Math.max(20, 5000 / TIME_SCALE), drain: p.drain, active,
            claim: async () => {
              const t = Date.now();
              const it = await svc.sched.claimNextItem({ executorId, types, leaseSeconds: cls === 'video' ? 120 : 300 });
              counters.claimMs.push(Date.now() - t);
              return it;
            },
            process: (item) => processItem(p, svc, executorId, item),
          });
        };
        if (classes.includes('video')) p.loops.push(mkLoop('video', ['video'], conf.workers.video));
        if (classes.includes('provider')) p.loops.push(mkLoop('provider', PROVIDER_TYPES, conf.workers.provider));
        if (classes.includes('llm')) p.loops.push(mkLoop('llm', LLM_TYPES, conf.workers.llm));
        procs.push(p);
        return p;
      }
      async function processItem(p, svc, executorId, item) {
        const ownerId = ownerOfRun.get(item.runId);
        const kind = reservationKind(item.type);
        const prov = PROVIDER_OF(item.type);
        // Q-21 / FinOps: cargos o reservas de intentos anteriores sin cerrar → se concilian con la evidencia del
        // proveedor falso (como el GET de Gamma/Videogen; en LLM/TTS reales esto es la ventana Q-21 o un humano).
        if (item.attempt > 1) {
          const prior = await WH.priorPaidOperations(svc.ledger, item.itemRunId, { currentAttempt: item.attempt, acknowledgedThroughAttempt: 0 });
          for (const r of [...prior.blocking, ...prior.releasable]) {
            if (!r.reservation || r.settled) continue;
            const charged = truth.get(r.idempotency_key) === 'charged';
            await svc.ledger.settleReservation(r.idempotency_key, charged ? chargeFor(kind, { ...item, attempt: r.attempt }, ownerId) : null, 'r63-sim: conciliada con la evidencia del proveedor falso');
            counters.reconciled++;
          }
        }
        if (p.killed) return;
        let key;
        try {
          key = await WH.reservePaidCall(svc.ledger, { kind, ownerId, itemRunId: item.itemRunId, generation: item.generation, itemAttempt: item.attempt, tag: 'main', estimate: estimate(kind) });
        } catch (err) {
          if (err instanceof WH.RunBudgetCapReached) { counters.budgetCap++; await svc.sched.failItem(item.itemRunId, executorId, 'run_budget_cap: sim', true); return; }
          throw err;
        }
        // Límite del proveedor falso: exceso → 429 inmediato (conocido, sin cobro) → reserva liberada, reintento.
        if (inflight[prov] >= REAL_LIMITS[prov].maxConcurrent) {
          counters.http429++;
          truth.set(key, 'not_charged');
          await svc.ledger.settleReservation(key, null, 'r63-sim: 429 (sin cobro)');
          await svc.sched.failItem(item.itemRunId, executorId, `provider_rate_limited: ${prov} 429 (sim)`, true);
          return;
        }
        inflight[prov]++; counters.calls++;
        const roll = rand();
        const dur = lognorm(rand, DUR[item.type].p50);
        const fail = roll < 0.04 ? 'known5xx' : roll < 0.05 ? 'chargedFail' : null;
        try {
          await sleepSim(fail ? dur * 0.3 : dur);
        } finally { inflight[prov]--; }
        if (p.killed) { truth.set(key, rand() < 0.5 ? 'charged' : 'not_charged'); counters.lostOnKill++; return; } // caída: reserva pendiente
        if (fail === 'known5xx') {
          counters.known5xx++; truth.set(key, 'not_charged');
          await svc.ledger.settleReservation(key, null, 'r63-sim: 5xx conocido (sin cobro)');
          await svc.sched.failItem(item.itemRunId, executorId, `provider_5xx: ${prov} (sim)`, true);
          return;
        }
        truth.set(key, 'charged');
        await svc.ledger.settleReservation(key, chargeFor(kind, item, ownerId), fail ? 'r63-sim: cobrado con falla' : 'r63-sim: ok');
        if (fail === 'chargedFail') { counters.chargedFail++; await svc.sched.failItem(item.itemRunId, executorId, `provider_failed_after_charge: ${prov} (sim)`, true); return; }
        await B.simCompleteItem(svc.ds, item.itemRunId, executorId);
      }
      async function kill(p, delaySim) {
        p.killed = true;
        p.drain.request('sim_kill');
        const dead = procs.filter((x) => x === p).map((x) => x.name);
        // Lease «vencida» tras su duración (comprimida): el barrido del próximo claim la devuelve a la cola.
        setTimeout(async () => {
          await env.ds.query(`update public.generation_item_runs set lease_until = now() - interval '1 second' where status = 'running' and split_part(worker_id, ':', 1) = any($1::text[])`, [dead]).catch(() => {});
        }, Math.max(1, (300 / TIME_SCALE) * 1000));
      }
      let gen = 1;
      let pa = await spawnProc('video-worker', ['video'], gen);
      let pb = await spawnProc('provider-worker', ['provider', 'llm'], gen);
      // Métricas de cola muestreadas (solo lectura).
      const qsamples = [];
      const sampler = setInterval(async () => { try { const m = await QM.computeSchedulerQueueMetrics(env.ds); qsamples.push({ t: simNow(), queued: m.totals.queuedRuns, admitted: m.totals.admittedRuns, claimable: m.totals.claimableItems, oldest: Math.max(0, ...m.byType.map((x) => x.oldestReadyWaitSec || 0)) }); } catch {} }, 250);
      // Reinicios: el proceso de proveedor+IA al ~25 % de la corrida estimada, el de video al ~50 %.
      const estMakespanSim = Math.max(3000, n * 1300 / (conf.workers.provider || 1));
      const killers = [
        setTimeout(async () => { await kill(pb); gen++; setTimeout(async () => { pb = await spawnProc('provider-worker', ['provider', 'llm'], gen); }, (60 / TIME_SCALE) * 1000); }, (0.25 * estMakespanSim / TIME_SCALE) * 1000),
        setTimeout(async () => { await kill(pa); gen++; setTimeout(async () => { pa = await spawnProc('video-worker', ['video'], gen); }, (60 / TIME_SCALE) * 1000); }, (0.5 * estMakespanSim / TIME_SCALE) * 1000),
      ];
      // Espera a que todos los runs terminen (o tope de tiempo real).
      const capRealMs = 20 * 60 * 1000;
      const doneAt = new Map();
      let maxRunningByProv = { anthropic: 0, gamma: 0, openai_tts: 0, videogen: 0 };
      let maxAdmitted = 0;
      while (Date.now() - t0Real < capRealMs) {
        const rows = await env.ds.query(`select id, worker_status from public.production_jobs where id = any($1::uuid[])`, [runs.map((r) => r.runId)]);
        for (const r of rows) if (['completed', 'preview', 'failed'].includes(r.worker_status) && !doneAt.has(r.id)) doneAt.set(r.id, { t: simNow(), status: r.worker_status });
        const rp = await env.ds.query(`select type, count(*)::int n from public.generation_item_runs where status = 'running' group by type`);
        const byP = { anthropic: 0, gamma: 0, openai_tts: 0, videogen: 0 };
        for (const r of rp) byP[PROVIDER_OF(r.type)] += r.n;
        byP.anthropic += (rp.find((r) => r.type === 'audiobook_chapter') || { n: 0 }).n; // el guion del audiolibro es Anthropic
        for (const k of Object.keys(byP)) maxRunningByProv[k] = Math.max(maxRunningByProv[k], byP[k]);
        const [adm] = await env.ds.query(`select count(*)::int n from public.production_jobs where execution_mode = 'dynamic_generation' and worker_status in ('running', 'retrying')`);
        maxAdmitted = Math.max(maxAdmitted, adm.n);
        if (doneAt.size === runs.length) break;
        await new Promise((r) => setTimeout(r, 40));
      }
      for (const t of killers) clearTimeout(t);
      clearInterval(sampler);
      for (const p of procs) p.drain.request('fin');
      await Promise.race([Promise.all(procs.flatMap((p) => p.loops)), new Promise((r) => setTimeout(r, 3000))]);
      clearInterval(ticker);
      await new Promise((r) => setTimeout(r, 200));
      // Resultados.
      const fin = runs.map((r) => (doneAt.get(r.runId) || { t: null, status: 'unfinished' }));
      const times = fin.map((f) => f.t).filter((x) => x !== null);
      const itemsDb = await env.ds.query(
        `select g.type, g.status, g.attempt_count, extract(epoch from (g.claimed_at - greatest(g.created_at,
                coalesce((select max(d.finished_at) from public.generation_item_runs d where d.job_id = g.job_id and d.item_key = any(g.depends_on)), g.created_at))))::float as wait
           from public.generation_item_runs g where g.job_id = any($1::uuid[])`, [runs.map((r) => r.runId)]);
      const waits = itemsDb.filter((x) => x.wait !== null).map((x) => Math.max(0, x.wait * TIME_SCALE));
      const ledger = await env.ds.query(
        `select e.run_id,
                coalesce(sum(e.amount), 0)::float as total,
                count(*) filter (where e.event_kind = 'CHARGE' and (e.metadata->>'reservation') = 'true'
                   and not exists (select 1 from public.generation_cost_events a where a.corrects_event_id = e.id))::int as orphans
           from public.generation_cost_events e where e.run_id = any($1::uuid[]) group by e.run_id`, [runs.map((r) => r.runId)]);
      const authorized = await env.ds.query(`select run_id, authorized_budget::float as a from public.cost_budget_authorizations where run_id = any($1::uuid[])`, [runs.map((r) => r.runId)]);
      const authBy = new Map(authorized.map((a) => [a.run_id, a.a]));
      const overBudget = ledger.filter((l) => l.total > (authBy.get(l.run_id) ?? 0) + 1e-9).length;
      const orphans = ledger.reduce((a, l) => a + l.orphans, 0);
      const small = runs.filter((r) => OWNER_MIX[n][ownerIdx.get(r.ownerId)] === 1).map((r) => (doneAt.get(r.runId) || {}).t).filter((x) => x != null);
      const firstOwner = owners.map((o) => Math.min(...runs.filter((r) => r.ownerId === o).map((r) => (doneAt.get(r.runId) || { t: Infinity }).t)));
      const res = {
        n, config: conf.name, timeScale: TIME_SCALE,
        finished: times.length, statuses: fin.reduce((a, f) => { a[f.status] = (a[f.status] || 0) + 1; return a; }, {}),
        makespanSim: times.length ? Math.max(...times) : null, firstDoneSim: times.length ? Math.min(...times) : null, meanDoneSim: mean(times),
        smallOwnersMeanDoneSim: mean(small), jainOwnersFirst: jain(firstOwner.filter(Number.isFinite).map((t) => 1 / t)), jainCourses: jain(times.map((t) => 1 / t)),
        itemsPerSimHour: times.length ? (itemsDb.filter((x) => x.status === 'completed').length / (Math.max(...times) / 3600)) : null,
        waitP50Sim: pct(waits, 50), waitP95Sim: pct(waits, 95), waitMaxSim: waits.length ? Math.max(...waits) : null,
        maxQueuedRuns: Math.max(0, ...qsamples.map((q) => q.queued)), maxAdmittedRuns: maxAdmitted, maxOldestReadyWaitSec: Math.max(0, ...qsamples.map((q) => q.oldest)),
        maxRunningByProvider: maxRunningByProv, limits: Object.fromEntries(Object.entries(REAL_LIMITS).map(([k, v]) => [k, v.maxConcurrent])),
        orphanReservations: orphans, runsOverAuthorized: overBudget, ledgerTotalUsd: ledger.reduce((a, l) => a + l.total, 0),
        attempts: itemsDb.reduce((a, x) => a + Number(x.attempt_count), 0), items: itemsDb.length,
        failedItems: itemsDb.filter((x) => x.status === 'failed').length,
        claimMsP50: pct(counters.claimMs, 50), claimMsP95: pct(counters.claimMs, 95),
        ...counters, claimMs: undefined, realSeconds: Math.round((Date.now() - t0Real) / 1000),
      };
      results.push(res);
      console.log(`[A] n=${n} ${conf.name}: terminados ${res.finished}/${n} ${JSON.stringify(res.statuses)} · último ${h(res.makespanSim)} h sim · huérfanas ${orphans} · sobre lo autorizado ${overBudget} · 429 ${counters.http429} · real ${res.realSeconds}s`);
    } finally {
      for (const p of procs) { p.killed = true; p.drain.request('fin'); }
      await new Promise((r) => setTimeout(r, 300));
      await env.stop();
    }
  }
  return results;
}

(async () => {
  const out = { seed: SEED, generatedAt: new Date().toISOString(), note: 'Simulación: proveedores falsos y límites supuestos; NO demuestra capacidad de producción.' };
  if (PART === 'model' || PART === 'all') {
    out.model = runModel();
    for (const r of out.model) console.log(`[B] n=${r.n} ${r.topology} ${r.policy}${r.youtubePerDay ? ` yt=${r.youtubePerDay}/día` : ''}: último ${h(r.makespan)} h · primero ${h(r.firstDone)} h · media ${h(r.meanDone)} h · chicos ${h(r.smallOwnersMeanDone)} h · cursos/día ${r.coursesPerDay.toFixed(1)} · Jain(dueños) ${r.jainOwnersFirst.toFixed(2)}`);
  }
  if (PART === 'real' || PART === 'all') out.real = await runReal();
  if (args.out) fs.writeFileSync(args.out, JSON.stringify(out, null, 2));
  process.exit(0);
})().catch((err) => { console.error(err && err.stack ? err.stack : err); process.exit(1); });
