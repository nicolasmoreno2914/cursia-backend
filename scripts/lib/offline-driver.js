/* eslint-disable */
// r58 (I1) — DRIVER OFFLINE DE COMPONENTES. Genera SOLO los componentes pedidos de un curso sintético (un capítulo, un
// H5P, un banco de examen, las interacciones de un video, una Actividad de Aplicación, …) con el MISMO motor del
// producto, sin DB, sin Storage, sin red y sin IA real:
//
//   configuración → prepareCourse (commercial-simulation: perfiles → dry-run → Prebrief → Blueprint → Manifest v3)
//   → selección (clave o tipo del Manifest) → sub-DAG por `dependsOn` → por item, en orden del Manifest:
//       · claim: assembleClaimedItem + buildClaimV3 del scheduler (mismo payload que recibe un worker);
//       · IA: createExecutorRuntime (ejecutor del navegador en un vm, el del worker) con un api() de replay/fake/record
//         (scripts/lib/replay-api.js, receta de hash del servidor);
//       · proveedores: mockProviderOutput del worker de proveedores (Gamma/TTS) y un video simulado (mode 'mock');
//       · validación: v3ValidationContext + validateV3ItemArtifact del scheduler (lo que valida completeItem);
//   → paquete opcional: buildPackagingPlanV3 + loadContentsV3 (cargadores en memoria) + buildDynamicMbzV3 + validateMbzV3.
//
// Garantías: barrera de red (scripts/lib/netguard.js) durante toda la corrida (un intento = la corrida falla);
// componentes APROBADOS se reutilizan sin cambios (sha256 verificado, nunca se regeneran); ids deterministas (mismo
// input → mismos ids y bytes); un artifact por (item, tipo) — sin duplicados; todo marcado sintético (título
// «[SINTÉTICO] …», aviso QA visible en la bienvenida y `cursia-synthetic.json` dentro del .mbz). Nunca escribe en la
// base ni en Storage: no hay forma de que una salida del driver quede registrada como curso comercial terminado.
'use strict';
require('reflect-metadata');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const JSZip = require('jszip');
const S = require('./commercial-simulation');
const PF = require('./v21-packaging-fixtures');
const C = require('./composition-fixtures');
const NG = require('./netguard');
const R = require('./replay-api');

const DRIVER_VERSION = 1;
const SYNTHETIC_TITLE_PREFIX = '[SINTÉTICO] ';
const SYNTHETIC_MARKER_FILE = 'cursia-synthetic.json';
const ZIP_DATE = new Date(Date.UTC(2026, 0, 1, 0, 0, 0));
const PACKAGE_TS = 1790500000;
const EXECUTOR_TYPES = new Set(['course_plan', 'course_intro', 'module_intro', 'content', 'experience', 'activity', 'video_interactions', 'application_activity', 'guided_practice', 'exam', 'final_exam']);
const PROVIDER_TYPES = new Set(['presentation', 'audio_welcome', 'audiobook_chapter']);
const VIDEO_TYPES = new Set(['video']);
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

/** UUID determinista (forma v4) a partir de una semilla. */
function detUuid(seed) {
  const h = sha256(`cursia-offline-driver|${seed}`);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

class DriverError extends Error {
  constructor(code, message, extra) { super(`${code}: ${message}`); this.code = code; Object.assign(this, extra || {}); }
}

function libs(distRoot) {
  const L = (rel) => require(path.join(distRoot, rel));
  return {
    SCH: L('modules/dynamic-generation/scheduler.service.js'),
    RH: L('modules/dynamic-generation/run-hash.js'),
    MB: L('modules/generation-manifests/generation-manifest-builder.js'),
    V3: L('modules/course-shell/v3-validation.js'),
    SHELL: L('modules/course-shell/index.js'),
    ABP: L('modules/quality/answer-bias-pool.js'),
    EXR: L('workers/llm-executor/executor-runtime.js'),
    PROV: L('workers/dynamic-provider-worker.js'),
    CASC: L('modules/dynamic-generation/regeneration-cascade.js'),
    PLAN: L('modules/dynamic-packaging/packaging-plan-v3.js'),
    PKG: L('modules/dynamic-packaging/packaging-v3.js'),
    B: L('package/dynamic-mbz-builder-v3.js'),
    VAL: L('package/v3/mbz-validator-v3.js'),
    ASM: L('package/assessment/index.js'),
    THEME: L('modules/theme-engine/index.js'),
  };
}

/** Frontend con las fixtures H5P v2 del LLM falso (video_interactions v2, caso ramificado). null si no está. */
function loadH5p2Fixture(feRoot) {
  const cands = [feRoot, process.env.CURSIA_FRONTEND_REPO, path.resolve(__dirname, '..', '..', '..', 'fe'), path.resolve(__dirname, '..', '..', '..', 'campuscloud-gen')].filter(Boolean);
  for (const fe of cands) {
    const f = path.join(fe, 'fixtures/h5p2/fake-llm-h5p2.json');
    if (fs.existsSync(f)) return { file: f, data: JSON.parse(fs.readFileSync(f, 'utf8')) };
  }
  return null;
}

// ── selección y dependencias ────────────────────────────────────────────────
/**
 * Selectores: 'type:<uuid>' (clave del Manifest) | { key } | { type, module?: n, chapter?: {m,c} } | { chapter: {m,c} }
 * (todos los items del capítulo). Devuelve las claves en orden del Manifest. Valida la entrada (falla fuerte).
 */
function resolveSelection(manifest, structure, selectors) {
  if (!Array.isArray(selectors) || selectors.length === 0) throw new DriverError('INPUT_INVALID', 'la selección de componentes está vacía');
  const items = manifest.items;
  const byKey = new Map(items.map((i) => [i.key, i]));
  const types = new Set(items.map((i) => i.type));
  const chapterIdOf = (pos) => {
    const m = structure.modules[pos && pos.m];
    const c = m && m.chapters[pos.c];
    if (!c) throw new DriverError('INPUT_INVALID', `capítulo inexistente en la estructura: ${JSON.stringify(pos)}`);
    return c.id;
  };
  const moduleIdOf = (n) => {
    const m = structure.modules[n];
    if (!m) throw new DriverError('INPUT_INVALID', `módulo inexistente en la estructura: ${n}`);
    return m.id;
  };
  const out = new Set();
  for (const sel of selectors) {
    const s = typeof sel === 'string' ? { key: sel } : sel;
    if (!s || typeof s !== 'object') throw new DriverError('INPUT_INVALID', `selector inválido: ${JSON.stringify(sel)}`);
    if (s.key !== undefined) {
      if (!byKey.has(s.key)) throw new DriverError('INPUT_INVALID', `la clave ${s.key} no está en el Manifest`);
      out.add(s.key);
      continue;
    }
    if (s.type !== undefined && !types.has(s.type)) throw new DriverError('INPUT_INVALID', `el Manifest no tiene items de tipo ${s.type}`);
    const chId = s.chapter !== undefined ? chapterIdOf(s.chapter) : null;
    const modId = s.module !== undefined ? moduleIdOf(s.module) : null;
    if (s.type === undefined && chId === null) throw new DriverError('INPUT_INVALID', `selector sin key, type ni chapter: ${JSON.stringify(s)}`);
    const hit = items.filter((i) => (s.type === undefined || i.type === s.type) && (chId === null || i.chapterId === chId) && (modId === null || i.moduleId === modId));
    if (!hit.length) throw new DriverError('INPUT_INVALID', `el selector ${JSON.stringify(s)} no corresponde a ningún item del Manifest`);
    for (const i of hit) out.add(i.key);
  }
  return items.filter((i) => out.has(i.key)).map((i) => i.key);
}

/** Sub-DAG: lo seleccionado + todas sus dependencias (transitivas), en orden del Manifest (topológico). */
function subDag(manifest, keys) {
  const byKey = new Map(manifest.items.map((i) => [i.key, i]));
  const need = new Set();
  const walk = (k, trail) => {
    if (need.has(k)) return;
    const it = byKey.get(k);
    if (!it) throw new DriverError('INPUT_INVALID', `dependencia ${k} ausente del Manifest (desde ${trail})`);
    need.add(k);
    for (const d of it.dependsOn || []) walk(d, k);
  };
  for (const k of keys) walk(k, 'selección');
  const order = manifest.items.filter((i) => need.has(i.key)).map((i) => i.key);
  // El Manifest ya viene en orden topológico; se verifica (una dependencia siempre antes que su item).
  const pos = new Map(order.map((k, i) => [k, i]));
  for (const k of order) for (const d of byKey.get(k).dependsOn || []) if (!(pos.get(d) < pos.get(k))) throw new DriverError('INPUT_INVALID', `orden del Manifest no topológico: ${d} después de ${k}`);
  return order;
}

/** Registro de afectados: qué otros componentes cambiaría regenerar lo seleccionado (cascada del producto + aristas). */
function affectedRegistry(X, manifest, selected) {
  const items = manifest.items.map((i) => ({ key: i.key, type: i.type, moduleId: i.moduleId ?? null, chapterId: i.chapterId ?? null, dependsOn: i.dependsOn }));
  const out = new Map();
  const add = (key, reason, via) => {
    if (selected.includes(key)) return;
    const cur = out.get(key) || { key, reasons: [] };
    if (!cur.reasons.some((r) => r.reason === reason && r.via === via)) cur.reasons.push({ reason, via });
    out.set(key, cur);
  };
  for (const k of selected) {
    const it = items.find((i) => i.key === k);
    const c = X.CASC.regenerationCascade(manifest.rulesVersion, items, it);
    for (const r of c.regenerate) add(r, 'cascade_regenerate', k);
    for (const s of c.stale) add(s, 'cascade_stale_no_auto', k);
    for (const d of items) if ((d.dependsOn || []).includes(k)) add(d.key, 'depends_on', k);
  }
  return manifest.items.filter((i) => out.has(i.key)).map((i) => out.get(i.key));
}

// ── almacén en memoria (artifacts sin duplicados) ───────────────────────────
function createMemStore(ns) {
  const byId = new Map();
  const byItemType = new Map();
  return {
    byId,
    put(itemKey, itemRunId, a, metadata) {
      const content = typeof a.content === 'string' ? a.content : Buffer.from(a.content).toString('utf8');
      const contentSha = sha256(content);
      const k = `${itemKey}|${a.type}`;
      const prev = byItemType.get(k);
      if (prev) {
        const p = byId.get(prev);
        if (p.sha256 === contentSha) return p; // mismo contenido: no se duplica
        throw new DriverError('DUPLICATE_ARTIFACT', `${itemKey} ya tiene un ${a.type} distinto (${prev})`);
      }
      const id = detUuid(`${ns}|artifact|${itemKey}|${a.type}|${contentSha}`);
      if (byId.has(id)) throw new DriverError('DUPLICATE_ARTIFACT', `id repetido ${id}`);
      const rec = {
        id, itemKey, itemRunId, type: a.type, filename: a.filename || `${a.type}`, mimeType: a.mimeType || null, content, sha256: contentSha,
        metadata: metadata || {}, storageBucket: 'synthetic-offline-driver', storagePath: `synthetic/${ns}/${a.type}/${itemKey.replace(/:/g, '_')}/${a.filename || a.type}`,
      };
      byId.set(id, rec);
      byItemType.set(k, id);
      return rec;
    },
    ofItem(itemKey) { return [...byId.values()].filter((r) => r.itemKey === itemKey); },
    text(id) { const r = byId.get(id); return r ? r.content : null; },
  };
}

// ── servicio del scheduler con lecturas en memoria (claim + validación del producto) ──
function schedulerFacade(X, state) {
  const proto = X.SCH.SchedulerService.prototype;
  const self = Object.create(proto);
  const completed = (pred) => [...state.items.values()].filter((r) => r.status === 'completed' && pred(r)).sort((a, b) => a.key.localeCompare(b.key));
  Object.assign(self, {
    v3Reader: { readText: async ({ id }) => { const t = state.store.text(id); if (t === null) throw new Error(`artifact ${id} no está en memoria`); return t; } },
    dataSource: { query: async (sql) => { throw new Error(`offline-driver: consulta SQL no soportada (${String(sql).slice(0, 60)})`); } },
    async answerBiasPoolFor(_q, _job, _m, itemKey) {
      const rows = completed((r) => X.ABP.ANSWER_BIAS_POOL_ITEM_TYPES.includes(r.type) && r.key !== itemKey);
      return X.ABP.answerBiasPoolFrom(rows.map((r) => ({ itemKey: r.key, summary: { answerBias: r.outputSummary.answerBias ?? null } })), itemKey);
    },
    async guidedPracticeAvoidFor(_q, _job, _m, manifest, snapshot, chapterId) {
      const mm = (manifest.modules || []).find((m) => (m.chapters || []).some((c) => c.chapterId === chapterId));
      const aaKeys = mm ? mm.chapters.filter((c) => c.applicationMinutes !== undefined).map((c) => `application_activity:${c.chapterId}`) : [];
      const aa = completed((r) => aaKeys.includes(r.key)).map((r) => r.outputSummary);
      const gp = completed((r) => r.type === 'guided_practice' && r.key !== `guided_practice:${chapterId}`).map((r) => ({ chapterId: r.chapterId ?? null, summary: r.outputSummary }));
      return X.SCH.guidedPracticeAvoidOf(manifest, snapshot, chapterId, aa, gp);
    },
    async loadVideoFacts(_q, _job, _m, videoItemKey, ivAdvanced = false) {
      const v = state.items.get(videoItemKey);
      if (!v || v.status !== 'completed') return { ok: false, code: 'VIDEO_NOT_COMPLETED', message: `el video ${videoItemKey} no está completado` };
      const art = state.store.ofItem(videoItemKey).find((a) => a.type === 'dynamic_video');
      const facts = X.V3.videoClaimFacts({ videoItemKey, outputSummary: v.outputSummary, artifactMetadata: art ? art.metadata : null, ...(ivAdvanced ? { ivAdvanced: true } : {}) });
      if (facts.ok) facts.videoItemRunId = v.itemRunId;
      return facts;
    },
    async loadExamChapterMd(_g, chapterIds) {
      const out = new Map();
      for (const id of chapterIds) {
        const a = state.store.ofItem(`content:${id}`).find((x) => x.type === 'dynamic_content_md');
        if (a && state.items.get(`content:${id}`)?.status === 'completed') out.set(id, a.content);
      }
      const missing = chapterIds.filter((id) => !out.has(id));
      if (missing.length) throw new DriverError('EXAM_CONTENT_MISSING', `sin el dynamic_content_md de ${missing.map((id) => `content:${id}`).join(', ')}`);
      return out;
    },
    async manifestBlueprintSnapshot() { return state.locked; },
  });
  return self;
}

/** ClaimedItem del item (mismo armado que el claim del scheduler; dependencias desde el almacén en memoria). */
async function claimFor(X, state, facade, mItem) {
  const row = state.rowOf(mItem);
  return X.SCH.assembleClaimedItem({
    job: state.job, row, ctx: state.ctx, manifest: state.manifest, snapshot: state.locked, source: state.source,
    blueprintNumber: state.source.blueprintNumber, artifactCourseId: String(state.job.course_id),
    fail: (msg) => new DriverError('CLAIM_INTEGRITY', `${mItem.key}: ${msg}`),
    loadDependencyArtifacts: async (deps) => {
      const rows = [];
      for (const d of deps) {
        if (state.items.get(d)?.status !== 'completed') continue;
        for (const a of state.store.ofItem(d)) rows.push({ item_key: d, id: a.id, type: a.type, storage_path: a.storagePath });
      }
      return rows;
    },
    claimV3: (it) => X.SCH.SchedulerService.prototype.buildClaimV3.call(facade, null, row, it, state.manifest, state.locked, true),
  });
}

/** Validación de completeItem (v3) sobre los artifacts del item; null = tipo sin validación de contenido. */
async function validateLikeComplete(X, state, facade, mItem, artifacts, summary) {
  const out = [];
  if (mItem.type === 'content') {
    const md = artifacts.find((a) => a.type === 'dynamic_content_md');
    const lang = md ? X.V3.v3LanguageErrors(md.content) : [];
    out.push({ validator: 'v3LanguageErrors', ok: lang.length === 0, codes: [...new Set(lang.map((e) => e.code))] });
    if (lang.length) return { ok: false, results: out, message: X.V3.v3ValidationErrorMessage({ itemKey: mItem.key, type: mItem.type }, lang) };
  }
  const types = X.V3.v3ValidatedArtifactTypes(mItem.type, mItem.variant ?? null);
  if (!types.length) return { ok: true, results: out, validated: null };
  const hits = artifacts.filter((a) => types.includes(a.type));
  if (hits.length !== 1) return { ok: false, results: out, message: `${mItem.key}: se esperaba exactamente un artifact validable (${types.join('|')}), hay ${hits.length}` };
  const art = hits[0];
  const g = { id: state.rowOf(mItem).id, job_id: state.job.id, manifest_id: state.manifestId, item_key: mItem.key, type: mItem.type, chapter_id: mItem.chapterId ?? null, module_id: mItem.moduleId ?? null, owner_id: state.ownerId };
  const built = await X.SCH.SchedulerService.prototype.v3ValidationContext.call(facade, g, mItem, state.manifest, { promptVersion: summary && summary.promptVersion ? summary.promptVersion : null, artifactType: art.type, languageCourse: false });
  if (built.kind === 'invalid') return { ok: false, results: out, message: built.message };
  const r = X.V3.validateV3ItemArtifact(built.ctx, art.content);
  out.push({ validator: 'validateV3ItemArtifact', artifactType: art.type, ok: r.ok, codes: r.ok ? [] : [...new Set(r.errors.map((e) => e.code))].sort() });
  if (!r.ok) return { ok: false, results: out, message: X.V3.v3ValidationErrorMessage({ itemKey: mItem.key, type: mItem.type }, r.errors) };
  return { ok: true, results: out, validated: { artifactType: art.type, artifactId: art.id, contentSha256: sha256(art.content), ...(r.summary || {}) } };
}

const VIDEO_FIXTURE = { youtubeVideoId: PF.YOUTUBE_ID, durationSec: PF.VIDEO_SECONDS };

/** Salida simulada de un item de proveedor (Gamma/TTS: la fixture del worker; video: vista previa con YouTube de prueba). */
function providerOutput(X, mItem, claimLike) {
  if (VIDEO_TYPES.has(mItem.type)) {
    const payload = { fixture: true, mock: true, mode: 'mock', provider: 'videogen', url: `https://www.youtube.com/watch?v=${VIDEO_FIXTURE.youtubeVideoId}`, durationSec: VIDEO_FIXTURE.durationSec, youtubeVideoId: VIDEO_FIXTURE.youtubeVideoId };
    return {
      artifacts: [{ type: 'dynamic_video', content: JSON.stringify(payload), filename: `${mItem.chapterId}.video.json`, mimeType: 'application/json' }],
      metadata: { mock: true, mode: 'mock', youtubeVideoId: VIDEO_FIXTURE.youtubeVideoId, durationSec: VIDEO_FIXTURE.durationSec },
      summary: { mode: 'mock', mock: true, fixture: true, delivery: 'youtube', youtubeVideoId: VIDEO_FIXTURE.youtubeVideoId, durationSec: VIDEO_FIXTURE.durationSec },
    };
  }
  const o = X.PROV.mockProviderOutput(claimLike);
  return {
    artifacts: [{ type: o.artifactType, content: JSON.stringify(o.payload), filename: o.filename, mimeType: 'application/json' }],
    metadata: { mock: true, fixture: true, mode: 'mock' },
    summary: o.summary,
  };
}

// ── corrida ─────────────────────────────────────────────────────────────────
/**
 * @param {string} distRoot
 * @param {object} cfg configuración del curso (forma de scripts/fixtures/commercial-simulation/courses.json)
 * @param {{ select: any[], approved?: Record<string, {artifacts: Array<{type,filename,mimeType,content,sha256,metadata?}>, outputSummary?: object}>,
 *           llm?: { mode: 'fake'|'replay'|'record', fixtures?: Map<string, any> }, package?: boolean, feRoot?: string, now?: string }} opts
 */
async function runComponents(distRoot, cfg, opts = {}) {
  const preBarrier = NG.networkBarrierActive();
  const barrier = NG.installNetworkBarrier({ label: 'offline-driver' });
  const attempts0 = barrier.attempts.length;
  const prevEnv = { drv: process.env.CURSIA_OFFLINE_DRIVER, backoff: process.env.DYNAMIC_LLM_WORKER_BACKOFF_MS };
  process.env.CURSIA_OFFLINE_DRIVER = '1';
  process.env.DYNAMIC_LLM_WORKER_BACKOFF_MS = '1';
  try {
    return await runInner(distRoot, cfg, opts, barrier, attempts0);
  } finally {
    if (prevEnv.drv === undefined) delete process.env.CURSIA_OFFLINE_DRIVER; else process.env.CURSIA_OFFLINE_DRIVER = prevEnv.drv;
    if (prevEnv.backoff === undefined) delete process.env.DYNAMIC_LLM_WORKER_BACKOFF_MS; else process.env.DYNAMIC_LLM_WORKER_BACKOFF_MS = prevEnv.backoff;
    if (!preBarrier) barrier.uninstall();
  }
}

async function runInner(distRoot, cfg0, opts, barrier, attempts0) {
  const X = libs(distRoot);
  if (!cfg0 || typeof cfg0 !== 'object' || !Array.isArray(cfg0.modules) || !cfg0.modules.length) throw new DriverError('INPUT_INVALID', 'configuración de curso sin módulos');
  if (!Number.isInteger(cfg0.courseId) || cfg0.courseId < 9700 || cfg0.courseId > 9999) throw new DriverError('INPUT_INVALID', `courseId sintético fuera del rango reservado 9700–9999: ${cfg0.courseId}`);
  const llmMode = (opts.llm && opts.llm.mode) || 'fake';
  if (!['fake', 'replay', 'record'].includes(llmMode)) throw new DriverError('INPUT_INVALID', `modo de IA desconocido: ${llmMode}`);
  if (opts.llm && opts.llm.provider && opts.llm.provider.real) R.assertRealRecordAllowed();
  const cfg = JSON.parse(JSON.stringify(cfg0));
  cfg.title = cfg.title.startsWith(SYNTHETIC_TITLE_PREFIX) ? cfg.title : SYNTHETIC_TITLE_PREFIX + cfg.title;
  const prep = await S.prepareCourse(distRoot, cfg);
  const { manifest, locked, structure } = prep;
  const selected = resolveSelection(manifest, structure, opts.select);
  const approvedIn = opts.approved || {};
  for (const k of Object.keys(approvedIn)) {
    if (!manifest.items.some((i) => i.key === k)) throw new DriverError('INPUT_INVALID', `componente aprobado ${k} no está en el Manifest`);
    if (selected.includes(k)) throw new DriverError('SELECTION_CONFLICT', `${k} está aprobado y seleccionado para regenerar a la vez`);
  }
  const order = subDag(manifest, [...selected, ...Object.keys(approvedIn)]);
  const manifestCanon = JSON.parse(X.MB.canonicalManifestJson(manifest));
  const manifestSha = X.MB.manifestSha256(manifestCanon);
  const ns = `${cfg.courseId}|${manifestSha}`;
  const manifestId = 900000 + cfg.courseId;
  const runId = detUuid(`${ns}|run`);
  const ownerId = detUuid(`${ns}|owner`);
  const context = X.RH.normalizeCourseContext({
    nombre: cfg.title, sector: (cfg.context && cfg.context.sector) || 'Formación técnica (sintético)', pais: (cfg.context && cfg.context.pais) || 'País de ejemplo',
    contexto: (cfg.context && cfg.context.contexto) || 'Curso sintético del driver offline: ningún cliente ni institución real', nivel: (cfg.context && cfg.context.nivel) || 'Intermedio', tono: (cfg.context && cfg.context.tono) || 'cercano y técnico',
  });
  const state = {
    manifest: manifestCanon, locked, structure, manifestId, ownerId, store: createMemStore(ns), items: new Map(),
    source: { courseId: locked.course.id, blueprintId: 1, blueprintNumber: 1, blueprintSha256: manifest.source.blueprintSha256 },
    job: { id: runId, course_id: cfg.courseId, frontend_course_id: null },
    ctx: { context, context_hash: X.RH.canonicalContextHash(context) },
    rowOf(mItem) {
      return {
        id: detUuid(`${ns}|itemrun|${mItem.key}`), job_id: runId, manifest_id: manifestId, course_id: locked.course.id, blueprint_id: 1,
        item_key: mItem.key, type: mItem.type, module_id: mItem.moduleId ?? null, chapter_id: mItem.chapterId ?? null, depends_on: mItem.dependsOn,
        idempotency_key: X.RH.itemIdempotencyKey(manifestId, mItem.key, 1), generation: 1, attempt_count: 1, output_summary: {},
      };
    },
  };
  const facade = schedulerFacade(X, state);
  const outline = structure.modules.map((m) => ({ id: m.id, title: m.title, chapters: m.chapters.map((c) => ({ id: c.id, title: c.title })) }));
  const h5p2 = loadH5p2Fixture(opts.feRoot);
  const provider = llmMode === 'replay' ? null : (opts.llm && opts.llm.provider) || R.createFakeProvider(distRoot, outline, { courseId: cfg.courseId, ...(h5p2 ? { h5p2: h5p2.data } : {}) });
  const replay = R.createReplayApi({ distRoot, mode: llmMode, fixtures: (opts.llm && opts.llm.fixtures) || new Map(), provider, now: opts.now });
  const validatorVersion = `v3-validation@${sha256(fs.readFileSync(path.join(distRoot, 'modules/course-shell/v3-validation.js'))).slice(0, 12)}`;
  const errors = [];
  const warnings = [];
  const results = [];
  const roleOf = (k) => (selected.includes(k) ? 'selected' : approvedIn[k] ? 'approved' : 'dependency');

  for (const key of order) {
    const mItem = state.manifest.items.find((i) => i.key === key);
    const row = state.rowOf(mItem);
    const rec = { key, type: mItem.type, role: roleOf(key), status: 'pending', itemRunId: row.id, chapterId: mItem.chapterId ?? null, moduleId: mItem.moduleId ?? null, outputSummary: {}, artifacts: [], validations: [], source: null, llmCalls: 0 };
    state.items.set(key, rec);
    results.push(rec);
    const blockedBy = (mItem.dependsOn || []).filter((d) => state.items.get(d)?.status !== 'completed');
    if (blockedBy.length) { rec.status = 'blocked'; rec.error = `dependencias sin completar: ${blockedBy.join(', ')}`; errors.push({ code: 'DEPENDENCY_BLOCKED', itemKey: key, message: rec.error }); continue; }
    try {
      if (approvedIn[key]) {
        // Aprobado: se reutiliza tal cual (sha verificado); nunca se regenera.
        const ap = approvedIn[key];
        if (!Array.isArray(ap.artifacts) || !ap.artifacts.length) throw new DriverError('APPROVED_INVALID', `${key}: aprobado sin artifacts`);
        for (const a of ap.artifacts) {
          if (typeof a.content !== 'string' || sha256(a.content) !== a.sha256) throw new DriverError('APPROVED_HASH_MISMATCH', `${key}: el artifact ${a.type} aprobado no coincide con su sha256`);
          const s = state.store.put(key, row.id, a, a.metadata || {});
          rec.artifacts.push(s.id);
        }
        rec.outputSummary = JSON.parse(JSON.stringify(ap.outputSummary || {}));
        rec.source = 'approved_reused';
        rec.status = 'completed';
        continue;
      }
      if (EXECUTOR_TYPES.has(mItem.type)) {
        const claim = await claimFor(X, state, facade, mItem);
        rec.inputHash = R.inputHashOf(claim);
        if (opts.keepClaims) rec.claim = JSON.parse(JSON.stringify(claim));
        replay.setItem({ componentType: mItem.type, itemKey: key, inputHash: rec.inputHash, validatorVersion, provenance: { driver: `offline-driver@${DRIVER_VERSION}`, courseConfig: cfg.id || String(cfg.courseId) } });
        const before = replay.calls.length;
        const runtime = X.EXR.createExecutorRuntime({
          api: replay.api, ownerId,
          artifactText: async (id) => state.store.text(id),
          logger: { log: () => {}, warn: (m) => warnings.push({ code: 'EXECUTOR_WARN', itemKey: key, message: String(m).slice(0, 300) }), error: (m) => warnings.push({ code: 'EXECUTOR_ERROR_LOG', itemKey: key, message: String(m).slice(0, 300) }) },
        });
        let res;
        try { res = await runtime.run(claim); } catch (e) { res = { ok: false, error: (e && (e.msg || e.message)) || String(e) }; }
        rec.llmCalls = replay.calls.length - before;
        const missing = replay.misses.filter((m) => m.itemKey === key);
        if (missing.length) throw new DriverError(R.REPLAY_FIXTURE_MISSING, `${key}: ${missing.length} llamada(s) sin fixture (${missing.map((m) => m.requestHash.slice(0, 12)).join(', ')})`, { misses: missing });
        if (!res || !res.ok) throw new DriverError('EXECUTOR_FAILED', `${key}: ${(res && res.error) || 'el ejecutor no devolvió resultado'}`);
        const summary = X.SCH.stripServerOwnedSummaryKeys(res.summary || {}).summary;
        for (const r of replay.recorded) if (r.itemKey === key && !r.contractVersion) r.contractVersion = summary.promptVersion || null;
        const stored = (res.artifacts || []).map((a) => state.store.put(key, row.id, a, {}));
        const v = await validateLikeComplete(X, state, facade, mItem, stored, summary);
        rec.validations = v.results;
        if (!v.ok) throw new DriverError('V3_PAYLOAD_INVALID', v.message);
        rec.artifacts = stored.map((s) => s.id);
        rec.outputSummary = { ...summary, ...(v.validated ? { v3Validation: v.validated } : {}) };
        rec.source = llmMode === 'replay' ? 'replay' : 'fake_llm';
        rec.status = 'completed';
        continue;
      }
      if (PROVIDER_TYPES.has(mItem.type) || VIDEO_TYPES.has(mItem.type)) {
        const o = providerOutput(X, mItem, { type: mItem.type, itemKey: key, idempotencyKey: row.idempotency_key, chapterId: mItem.chapterId ?? null, chapterNumber: mItem.chapterNumber ?? null });
        rec.artifacts = o.artifacts.map((a) => state.store.put(key, row.id, a, o.metadata).id);
        rec.outputSummary = o.summary;
        rec.source = 'provider_mock';
        rec.status = 'completed';
        continue;
      }
      throw new DriverError('UNSUPPORTED_ITEM_TYPE', `${key}: tipo ${mItem.type} sin ejecutor offline`);
    } catch (e) {
      rec.status = 'failed';
      rec.error = e.message;
      errors.push({ code: e.code || 'ERROR', itemKey: key, message: e.message });
    }
  }

  let pkg = null;
  if (opts.package) {
    if (errors.length) errors.push({ code: 'PACKAGE_SKIPPED', itemKey: null, message: 'no se empaqueta con componentes fallidos' });
    else {
      try { pkg = await buildPackage(X, distRoot, prep, state, cfg, warnings); } catch (e) { errors.push({ code: e.code || 'PACKAGE_FAILED', itemKey: null, message: e.message }); }
    }
  }

  const netAttempts = barrier.attempts.slice(attempts0);
  if (netAttempts.length) errors.push({ code: NG.NETWORK_BLOCKED, itemKey: null, message: `${netAttempts.length} intento(s) de red bloqueados` });
  const outItems = {};
  for (const r of results) {
    outItems[r.key] = {
      ...r,
      artifacts: r.artifacts.map((id) => { const a = state.store.byId.get(id); return { id, type: a.type, filename: a.filename, mimeType: a.mimeType, sha256: a.sha256, bytes: Buffer.byteLength(a.content), metadata: a.metadata, storagePath: a.storagePath }; }),
    };
  }
  return {
    driverVersion: DRIVER_VERSION,
    synthetic: true,
    ok: errors.length === 0,
    cfg, prep, manifestSha256: manifestSha, runId, manifestId,
    selection: { requested: opts.select, selected, approved: Object.keys(approvedIn), order },
    affected: affectedRegistry(X, state.manifest, selected),
    items: outItems,
    /** Artifacts exportables (para pasarlos como `approved` en otra corrida). */
    exportItem(key) {
      const r = state.items.get(key);
      if (!r || r.status !== 'completed') throw new DriverError('INPUT_INVALID', `${key} no está completado`);
      return { artifacts: state.store.ofItem(key).map((a) => ({ type: a.type, filename: a.filename, mimeType: a.mimeType, content: a.content, sha256: a.sha256, metadata: a.metadata })), outputSummary: JSON.parse(JSON.stringify(r.outputSummary)) };
    },
    artifactText: (id) => state.store.text(id),
    allArtifacts: () => [...state.store.byId.values()].map((a) => ({ id: a.id, itemKey: a.itemKey, type: a.type, sha256: a.sha256 })),
    llm: { mode: llmMode, provider: provider ? provider.name : 'replay', calls: replay.calls.length, misses: replay.misses.length, recorded: replay.recorded, models: [...new Set(replay.calls.map((c) => c.model))] },
    package: pkg,
    network: { barrier: true, attempts: netAttempts },
    errors, warnings,
    validatorVersion,
    /** Para los checks: el servicio del scheduler con las lecturas en memoria de ESTA corrida (claim/validación). */
    _facade: () => facade,
    _state: () => state,
  };
}

// ── paquete sintético ───────────────────────────────────────────────────────
/** Artifacts de relleno (fixtures del empaque) para los items que esta corrida NO generó; el resto, lo generado. */
function fixtureArtifactsFor(X, input, mItem) {
  const c = input.contents;
  const ch = mItem.chapterId;
  const J = (type, obj) => [{ type, content: JSON.stringify(obj), filename: `${type}.json`, mimeType: 'application/json' }];
  switch (mItem.type) {
    case 'course_plan': return J('dynamic_course_plan_json', { fixture: true });
    case 'course_intro': return J('dynamic_course_intro_json', c.courseIntro);
    case 'module_intro': return J('dynamic_module_intro_json', c.moduleIntros.get(mItem.moduleId));
    case 'content': return [{ type: 'dynamic_content_md', content: c.contentMd.get(ch), filename: `${ch}.md`, mimeType: 'text/markdown' }];
    case 'experience': return J('dynamic_experience_json', c.experiences.get(ch));
    case 'activity': {
      const a = c.activities.get(ch);
      if (a.variant === 'h5p') return J('dynamic_h5p_params_json', a.payload);
      return [{ type: 'dynamic_scorm_html', content: a.html, filename: 'index.html', mimeType: 'text/html' }, { type: 'dynamic_scorm_manifest', content: a.manifestXml, filename: 'imsmanifest.xml', mimeType: 'application/xml' }];
    }
    case 'video_interactions': return J('dynamic_video_interactions_json', c.videoInteractions.get(ch));
    case 'application_activity': return J(X.SHELL.APPLICATION_ARTIFACT_TYPE, c.applications.get(ch));
    case 'guided_practice': return J('dynamic_guided_practice_json', c.guidedPractices.get(ch));
    case 'exam': return [{ type: 'dynamic_exam_gift', content: c.examGift.get(mItem.moduleId), filename: 'exam.gift', mimeType: 'text/plain' }];
    case 'final_exam': return [{ type: 'dynamic_exam_gift', content: c.finalExamGift, filename: 'final.gift', mimeType: 'text/plain' }];
    default: return null;
  }
}

async function buildPackage(X, distRoot, prep, state, cfg, warnings) {
  const manifest = state.manifest;
  const input = PF.packagingInput(distRoot, { snapshot: state.locked, manifest, engine: cfg.engine || 'h5p', finalExam: cfg.finalExam !== false, profile: prep.assessment.profile });
  S.attachExamGift({ EB: require(path.join(distRoot, 'modules/course-shell/exam-bank.js')) }, input);
  const filled = [];
  const byItem = new Map();
  for (const it of manifest.items) {
    let rec = state.items.get(it.key);
    if (!rec || rec.status !== 'completed') {
      // Relleno: fixture de empaque (Gamma/TTS/video simulados por el worker; texto con las fixtures del empaque).
      const row = state.rowOf(it);
      let arts;
      let metadata = {};
      let summary = {};
      if (PROVIDER_TYPES.has(it.type) || VIDEO_TYPES.has(it.type)) {
        const o = providerOutput(X, it, { type: it.type, itemKey: it.key, idempotencyKey: row.idempotency_key, chapterId: it.chapterId ?? null, chapterNumber: it.chapterNumber ?? null });
        arts = o.artifacts; metadata = o.metadata; summary = o.summary;
      } else {
        arts = fixtureArtifactsFor(X, input, it);
        if (!arts) throw new DriverError('PACKAGE_FIXTURE_MISSING', `sin fixture de empaque para ${it.key}`);
      }
      rec = { key: it.key, type: it.type, status: 'completed', itemRunId: row.id, outputSummary: summary, artifacts: arts.map((a) => state.store.put(it.key, row.id, a, metadata).id), source: 'package_fixture', role: 'package_fixture' };
      state.items.set(it.key, rec);
      filled.push(it.key);
    }
    byItem.set(it.key, {
      itemKey: it.key, type: it.type, outputSummary: rec.outputSummary,
      artifacts: rec.artifacts.map((id) => { const a = state.store.byId.get(id); return { itemKey: it.key, itemType: it.type, itemRunId: rec.itemRunId, artifactId: a.id, type: a.type, storageBucket: a.storageBucket, storagePath: a.storagePath, mimeType: a.mimeType, metadata: a.metadata }; }),
    });
  }
  // Run sintético congelado en vista previa: Gamma/TTS simulados y videos de vista previa (se omiten del paquete).
  const run = { id: state.job.id, owner_id: state.ownerId, input_payload: { providerModes: { presentation: 'mock', audio: 'mock' }, videoMode: 'mock', videoDelivery: 'youtube', synthetic: true } };
  const split = X.PKG.splitPendingVideosV3(manifest, byItem, 'mock', { runId: run.id });
  X.PKG.assertRunArtifactsPackageable(run, split.byItem);
  const pendingVideoChapterIds = split.pendingVideos.map((p) => p.chapterId);
  const omittedVideoKeys = split.pendingVideos.map((p) => p.itemKey);
  const plan = X.PLAN.buildPackagingPlanV3(manifest, state.locked, { manifestId: state.manifestId, omitVideoChapterIds: pendingVideoChapterIds });
  const presentation = input.presentation;
  const theme = X.THEME.resolveTheme(presentation);
  const loaders = {
    loadText: async (a) => { const t = state.store.text(a.artifactId); if (t === null) throw new Error(`artifact ${a.artifactId} no está en memoria`); return t; },
    loadBytes: async (a) => Buffer.from(state.store.text(a.artifactId) || '', 'utf8'),
    loadStorageBytes: async (bucket, p) => { throw new DriverError('STORAGE_FORBIDDEN', `el driver offline no lee Storage (${bucket}/${p})`); },
  };
  const loaded = await X.PKG.loadContentsV3(loaders, plan, split.byItem, run, { familyId: theme.familyId, mode: theme.mode });
  if (prep.assessment.files.size) loaded.contents.practiceFiles = prep.assessment.files;
  for (const w of loaded.warnings) warnings.push({ code: String(w).split(':')[0], itemKey: null, message: String(w) });
  const built = await X.B.buildDynamicMbzV3({
    manifest, blueprint: state.locked, manifestId: state.manifestId, assessmentProfile: prep.assessment.profile, presentation,
    contents: loaded.contents, ts: PACKAGE_TS, pendingVideoChapterIds, qaPreviewNotice: true,
  });
  const resolved = X.ASM.resolveAssessment(prep.assessment.profile, {
    hasFinalExam: manifest.features && manifest.features.finalExam === true, activityEngine: manifest.features && manifest.features.activityEngine,
    itemCounts: X.ASM.assessmentItemCountsForPackage(manifest, omittedVideoKeys, prep.assessment.profile),
  });
  if (JSON.stringify(resolved) !== JSON.stringify(built.expectations.resolved)) throw new DriverError('MBZ_V3_VALIDATION_FAILED', 'el builder resolvió una evaluación distinta de la del perfil');
  const vargs = { facts: built.expectations.facts, resolved, examBankPlans: built.expectations.examBankPlans, shellProseByLabel: built.expectations.shellProseByLabel, builderVersion: built.expectations.builderVersion, internalVocabularyExempt: built.expectations.internalVocabularyExempt, internalVocabularyUserTexts: built.expectations.internalVocabularyUserTexts };
  const validation = await X.VAL.validateMbzV3(built.mbz, vargs);
  if (!validation.ok) throw new DriverError('MBZ_V3_VALIDATION_FAILED', `${validation.issues.length} hallazgo(s): ${validation.issues.slice(0, 5).map((i) => `${i.code} ${i.where}`).join(' | ')}`);
  // Marca sintética oculta dentro del .mbz (además del título y del aviso QA visible).
  const marker = {
    cursiaSynthetic: true, driver: `offline-driver@${DRIVER_VERSION}`, runKind: 'synthetic', deliverable: false,
    manifestSha256: X.MB.manifestSha256(manifest), runId: state.job.id, generated: [...state.items.values()].filter((r) => r.source !== 'package_fixture').map((r) => r.key).sort(), packageFixtures: filled.slice().sort(),
  };
  const z = await JSZip.loadAsync(built.mbz);
  z.file(SYNTHETIC_MARKER_FILE, JSON.stringify(marker, null, 2), { date: ZIP_DATE, createFolders: false });
  const mbz = await z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  const validationMarked = await X.VAL.validateMbzV3(mbz, vargs);
  if (!validationMarked.ok) throw new DriverError('MBZ_V3_VALIDATION_FAILED', `con la marca sintética: ${validationMarked.issues.slice(0, 5).map((i) => `${i.code} ${i.where}`).join(' | ')}`);
  return {
    mbz, sha256: sha256(mbz), bytes: mbz.length, builderVersion: X.B.DYNAMIC_MBZ_BUILDER_VERSION_V3, validation: { ok: validationMarked.ok, issues: validationMarked.issues.length },
    pendingVideos: split.pendingVideos, packageFixtures: filled, mockProviderItems: loaded.mockProviderItems, facts: built.expectations.facts, marker,
  };
}

/** Marca sintética de un .mbz del driver (título + archivo oculto). */
async function readSyntheticMarker(mbz) {
  const z = await JSZip.loadAsync(mbz);
  const f = z.file(SYNTHETIC_MARKER_FILE);
  const course = z.file('course/course.xml') ? await z.file('course/course.xml').async('string') : '';
  const fullname = (/<fullname>([\s\S]*?)<\/fullname>/.exec(course) || [])[1] || null;
  return { marker: f ? JSON.parse(await f.async('string')) : null, fullname };
}

module.exports = {
  runComponents, resolveSelection, subDag, affectedRegistry, readSyntheticMarker, detUuid, loadH5p2Fixture, createMemStore,
  DriverError, DRIVER_VERSION, SYNTHETIC_TITLE_PREFIX, SYNTHETIC_MARKER_FILE, EXECUTOR_TYPES, PROVIDER_TYPES,
};
