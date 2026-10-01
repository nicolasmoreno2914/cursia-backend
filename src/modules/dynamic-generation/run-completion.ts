/**
 * EV6 DoD «curso completo» (BE-A) — evaluador de completitud de un run.
 *
 * Definition of Done: generación iniciada → TODOS los componentes contratados (los items del
 * Manifest congelado) generados, validados y REALES → paquete Moodle disponible → curso completo.
 * Nunca `completed` si falta un componente o si alguno es de vista previa (mock).
 *
 * `evaluateRunCompletion` es PURA (sin DB ni red): recibe el job del run, las filas de la
 * generación VIGENTE de cada item, el Manifest y (opcional) si hay un paquete vigente y
 * entregable. La usan:
 *  - `recomputeRunStatus` (item-transitions.ts): al terminar todos los items decide
 *    `completed` | `preview` | `failed` (nunca `completed` con un componente de vista previa);
 *  - `RunsService.buildRunDto`: `RunDto.completion` (computado en cada lectura → los runs viejos
 *    `completed` con componentes mock se leen como `preview` SIN escribir nada);
 *  - el empaquetado (`preview_not_deliverable`).
 * BE-B (empaque automático, listado de admin, auto-reintento seguro) se engancha acá: el estado
 * `packaging` es exactamente «generación completa sin paquete vigente».
 *
 * Validación por componente (§7.1 del diagnóstico):
 *  - video: salida REAL (`output_summary.mode`, o el modo congelado del run para filas viejas) +
 *    entrega YouTube `completed` con id (si el run entrega por YouTube) + sus preguntas
 *    (`video_interactions`) pertenecen a ESA generación del video (`questionsBelongToVideo`);
 *  - presentation / audio_welcome / audiobook_chapter: proveedor congelado `real` y sin señal mock
 *    en la salida (`mode:'mock'`, `mock`, `fixture`);
 *  - tipos v3 que el servidor valida al completar (course_intro, module_intro, experience,
 *    video_interactions, activity h5p, final_exam): `output_summary.v3Validation` presente.
 *    `exam` en GIFT no tiene validación de servidor (solo el banco): cuenta al completarse.
 *  - sin validación de servidor (content, activity SCORM, course_plan, exam GIFT): cuentan como
 *    hechos al completarse (sin validación nueva acá — ver el reporte de BE-A).
 */
import { frozenProviderModesOf, providerKindOfItemType } from './provider-modes';
import { fallbackVideoModeOf, questionsBelongToVideo } from './video-upgrade';
import { v3ValidatedArtifactTypes } from '../course-shell/v3-validation';
import { autoHealDecision } from './auto-heal';
import { BUDGET_EXCEEDED, PROVIDER_RECONCILIATION_REQUIRED } from '../finops/run-budget';

export type RunCompletionState = 'in_progress' | 'packaging' | 'complete' | 'preview' | 'needs_attention' | 'cancelled';

/**
 * Acciones de admin derivadas de los códigos de fallo (§7.1). BE-A solo las informa; los
 * endpoints dedicados llegan en BE-B. Nunca llevan el texto técnico del error.
 */
export type RunAdminActionCode =
  | 'retry_video_render'
  | 'resolve_youtube'
  | 'reconcile_videogen'
  | 'reconcile_provider'
  | 'approve_budget'
  | 'retry_item'
  | 'regenerate_item'
  | 'generate_real_videos';

export interface RunAdminAction {
  code: RunAdminActionCode;
  itemKey?: string;
}

export interface RunCompletion {
  state: RunCompletionState;
  /** Todos los items del Manifest hechos, validados y reales. */
  generationComplete: boolean;
  /** Existe un paquete Moodle VIGENTE y ENTREGABLE (no QA) del run. */
  packageReady: boolean;
  /** generationComplete && packageReady. */
  complete: boolean;
  /** Items requeridos que no están hechos (incluye los de vista previa). Orden del Manifest. */
  missingComponents: string[];
  /** Items completados pero de vista previa (mock). Orden del Manifest. */
  previewComponents: string[];
  adminActions: RunAdminAction[];
}

export interface CompletionJob {
  status?: string | null;
  worker_status?: string | null;
  input_payload?: any;
}

export interface CompletionRow {
  id: string;
  item_key: string;
  type: string;
  status: string;
  error?: string | null;
  output_summary?: Record<string, any> | null;
  finished_at?: Date | string | null;
  updated_at?: Date | string | null;
  chapter_id?: string | null;
}

export interface CompletionManifest {
  rulesVersion: number;
  items: ReadonlyArray<{ key: string; type: string; variant?: string | null; chapterId?: string | null }>;
}

export interface CompletionOptions {
  /** §2.6: el run terminó failed/cancelled SOLO por videos de un upgrade (runIsUpgradeOnlyFailure). */
  upgradeOnlyFailure?: boolean;
  /** Reloj para decidir si el auto-healer todavía va a reabrir un item (default: ahora). */
  now?: Date;
}

/** Clasificación de UN item requerido. */
export type ItemCompletionClass = 'done' | 'preview' | 'in_flight' | 'not_done' | 'unvalidated';

const IN_FLIGHT = new Set(['pending', 'running', 'retrying']);
// Mismos sets que item-transitions.ts (sin importarlo: item-transitions importa este módulo).
const ACTIVE_RUN = new Set(['queued', 'running', 'retrying']);
const CANCELLED_LIKE = new Set(['cancelled', 'cancelling']);
function isCancelledLike(job: CompletionJob): boolean {
  return CANCELLED_LIKE.has(String(job?.worker_status ?? '').trim()) || CANCELLED_LIKE.has(String(job?.status ?? '').trim());
}
function isActiveRun(job: CompletionJob): boolean {
  return ACTIVE_RUN.has(String(job?.worker_status ?? '')) && !isCancelledLike(job);
}
const PROVIDER_TYPES = new Set(['presentation', 'audio_welcome', 'audiobook_chapter']);

function os(r: { output_summary?: Record<string, any> | null } | null | undefined): Record<string, any> {
  const v = r?.output_summary;
  if (typeof v === 'string') {
    try {
      return JSON.parse(v) ?? {};
    } catch {
      return {};
    }
  }
  return (v ?? {}) as Record<string, any>;
}

function payloadOf(job: CompletionJob): Record<string, any> {
  const p = job?.input_payload;
  if (typeof p === 'string') {
    try {
      return JSON.parse(p) ?? {};
    } catch {
      return {};
    }
  }
  return (p ?? {}) as Record<string, any>;
}

/** Señal de salida simulada de un proveedor (dynamic-provider-worker: mode/mock/fixture). */
export function hasMockSignal(outputSummary: Record<string, any> | null | undefined): boolean {
  const s = outputSummary ?? {};
  return s.mode === 'mock' || s.mock === true || s.fixture === true;
}

/** ¿El video vigente es real? Igual que `isRealVideoOutput` del empaque (sin modo → el ORIGINAL del run). */
function videoIsReal(outputSummary: Record<string, any>, payload: Record<string, any>): boolean {
  const mode = outputSummary?.mode;
  if (mode === 'real') return true;
  if (mode === 'mock') return false;
  return fallbackVideoModeOf(payload) === 'real';
}

function videoDeliveryOf(payload: Record<string, any>): string {
  const v = payload?.videoDelivery;
  return typeof v === 'string' && v ? v : 'videogen_direct';
}

/** ¿Este tipo v3 lo valida el servidor al completar (y por lo tanto debe traer v3Validation)? */
export function requiresV3Validation(type: string, variant?: string | null): boolean {
  // `exam` en GIFT no tiene validación de servidor (solo el banco la tiene): no se exige.
  if (type === 'exam') return false;
  return v3ValidatedArtifactTypes(type, variant ?? null).length > 0;
}

/**
 * Clasifica cada item del Manifest. Pura. `rowsByKey` = generación vigente por item_key.
 */
export function classifyRunItems(
  job: CompletionJob,
  rowsByKey: ReadonlyMap<string, CompletionRow>,
  manifest: CompletionManifest,
): Map<string, ItemCompletionClass> {
  const payload = payloadOf(job);
  const modes = frozenProviderModesOf(payload);
  const strategy = videoDeliveryOf(payload);
  const out = new Map<string, ItemCompletionClass>();
  const videoClass = new Map<string, ItemCompletionClass>();

  const classifyVideo = (it: { key: string }): ItemCompletionClass => {
    const r = rowsByKey.get(it.key);
    if (!r) return 'not_done';
    if (IN_FLIGHT.has(r.status)) return 'in_flight';
    if (r.status !== 'completed') return 'not_done';
    const s = os(r);
    if (!videoIsReal(s, payload)) return 'preview';
    if (strategy === 'youtube') {
      const id = (typeof s.youtubeVideoId === 'string' && s.youtubeVideoId) || s.external?.youtubeVideoId;
      if (s.delivery !== 'completed' || !id) return 'unvalidated';
    }
    return 'done';
  };

  for (const it of manifest.items) {
    if (it.type === 'video') videoClass.set(it.key, classifyVideo(it));
  }

  for (const it of manifest.items) {
    if (it.type === 'video') {
      out.set(it.key, videoClass.get(it.key) as ItemCompletionClass);
      continue;
    }
    const r = rowsByKey.get(it.key);
    if (!r) {
      out.set(it.key, 'not_done');
      continue;
    }
    if (IN_FLIGHT.has(r.status)) {
      out.set(it.key, 'in_flight');
      continue;
    }
    if (r.status !== 'completed') {
      out.set(it.key, 'not_done');
      continue;
    }
    const s = os(r);
    if (PROVIDER_TYPES.has(it.type)) {
      const kind = providerKindOfItemType(it.type);
      if (hasMockSignal(s) || (kind && modes && modes[kind] === 'mock')) {
        out.set(it.key, 'preview');
        continue;
      }
      if (!kind || !modes || modes[kind] !== 'real') {
        // v3 sin modos congelados (integridad): nunca se asume real.
        out.set(it.key, 'unvalidated');
        continue;
      }
    }
    if (it.type === 'video_interactions') {
      const chapterId = String(it.chapterId ?? it.key.slice('video_interactions:'.length));
      const vKey = `video:${chapterId}`;
      const vc = videoClass.get(vKey);
      // Preguntas de un video de vista previa: describen un video simulado → vista previa también.
      if (vc === 'preview') {
        out.set(it.key, 'preview');
        continue;
      }
      const v = rowsByKey.get(vKey);
      if (v && v.status === 'completed' &&
        !questionsBelongToVideo({ id: v.id, finishedAt: v.finished_at }, { status: r.status, outputSummary: s, finishedAt: r.finished_at })) {
        out.set(it.key, 'unvalidated');
        continue;
      }
    }
    if (manifest.rulesVersion === 3 && requiresV3Validation(it.type, it.variant ?? null)) {
      const v = s.v3Validation;
      if (!v || typeof v !== 'object') {
        out.set(it.key, 'unvalidated');
        continue;
      }
    }
    out.set(it.key, 'done');
  }
  return out;
}

function isAmbiguousYoutube(r: CompletionRow): boolean {
  const s = os(r);
  if (s.external?.youtubeVideoId) return false;
  return s.delivery === 'ambiguous' || String(r.error ?? '').startsWith('ambiguous_youtube_upload') ||
    (!!s.youtubeUploadStartedAt && s.delivery !== 'blocked_auth' && s.delivery !== 'blocked_quota');
}

/** Acción de admin para un item no hecho (null = el auto-healer lo toma o es un bloqueo por dependencia). */
export function adminActionFor(r: CompletionRow | undefined, cls: ItemCompletionClass, now: Date): RunAdminAction | null {
  if (!r) return null;
  const key = r.item_key;
  const err = String(r.error ?? '');
  const s = os(r);
  if (cls === 'unvalidated') {
    if (r.type === 'video') return { code: 'resolve_youtube', itemKey: key };
    return { code: 'regenerate_item', itemKey: key };
  }
  if (cls !== 'not_done') return null;
  if (r.status === 'blocked') {
    if (err.startsWith(BUDGET_EXCEEDED)) return { code: 'approve_budget', itemKey: key };
    return null; // bloqueado por una dependencia: la acción es la de la dependencia
  }
  if (r.status === 'cancelled') return null;
  // El auto-healer todavía lo va a reabrir (allow-list, dentro de su ventana): sin acción humana.
  const d = autoHealDecision({ status: r.status, type: r.type, error: r.error ?? null, output_summary: s, finished_at: r.finished_at ?? null, updated_at: r.updated_at ?? null }, now);
  if (d.heal === true || (d.heal === false && d.reason === 'backoff')) return null;
  if (err.includes(PROVIDER_RECONCILIATION_REQUIRED)) {
    return { code: r.type === 'video' ? 'reconcile_videogen' : 'reconcile_provider', itemKey: key };
  }
  if (err.includes(BUDGET_EXCEEDED) || /budget_approval_required/.test(err)) return { code: 'approve_budget', itemKey: key };
  if (r.type === 'video') {
    if (/^(videogen_failed|videogen_submit_rejected)/.test(err)) return { code: 'retry_video_render', itemKey: key };
    if (err.startsWith('ambiguous_video_submission') || (!!s.externalSubmitStartedAt && !s.external?.videogenJobId)) {
      return { code: 'reconcile_videogen', itemKey: key };
    }
    if (isAmbiguousYoutube(r) || ['blocked_auth', 'blocked_quota', 'upload_failed', 'ambiguous'].includes(String(s.delivery ?? '')) ||
      /^youtube_/.test(err)) {
      return { code: 'resolve_youtube', itemKey: key };
    }
  }
  if (PROVIDER_TYPES.has(r.type) && /^(gamma_submit_ambiguous|gamma_generation_failed)/.test(err)) {
    return { code: 'reconcile_provider', itemKey: key };
  }
  return { code: 'retry_item', itemKey: key };
}

/**
 * Completitud del run (pura). `pkg.ready` = hay un paquete VIGENTE y ENTREGABLE (lo calcula el
 * caller con la clave de reuse del empaque; nunca un paquete QA).
 */
export function evaluateRunCompletion(
  job: CompletionJob,
  rows: ReadonlyArray<CompletionRow>,
  manifest: CompletionManifest,
  pkg?: { ready: boolean } | null,
  opts: CompletionOptions = {},
): RunCompletion {
  const rowsByKey = new Map(rows.map((r) => [r.item_key, r]));
  const classes = classifyRunItems(job, rowsByKey, manifest);
  const missingComponents: string[] = [];
  const previewComponents: string[] = [];
  let inFlight = 0;
  let nonPreviewMissing = 0;
  for (const it of manifest.items) {
    const c = classes.get(it.key) as ItemCompletionClass;
    if (c === 'done') continue;
    missingComponents.push(it.key);
    if (c === 'preview') previewComponents.push(it.key);
    else nonPreviewMissing++;
    if (c === 'in_flight') inFlight++;
  }
  const generationComplete = missingComponents.length === 0 && manifest.items.length > 0;
  const packageReady = generationComplete && !!pkg?.ready;

  const now = opts.now ?? new Date();
  const actions: RunAdminAction[] = [];
  const seen = new Set<string>();
  const push = (a: RunAdminAction | null) => {
    if (!a) return;
    const k = `${a.code}|${a.itemKey ?? ''}`;
    if (seen.has(k)) return;
    seen.add(k);
    actions.push(a);
  };
  for (const it of manifest.items) {
    const c = classes.get(it.key) as ItemCompletionClass;
    if (c === 'not_done' || c === 'unvalidated') push(adminActionFor(rowsByKey.get(it.key), c, now));
  }
  if (previewComponents.some((k) => k.startsWith('video:')) && manifest.rulesVersion === 3) push({ code: 'generate_real_videos' });

  let state: RunCompletionState;
  if (isCancelledLike(job) && !opts.upgradeOnlyFailure) state = 'cancelled';
  else if (!isCancelledLike(job) && (isActiveRun(job) || inFlight > 0)) state = 'in_progress';
  else if (generationComplete) state = packageReady ? 'complete' : 'packaging';
  else if (nonPreviewMissing === 0 && previewComponents.length > 0) state = 'preview';
  else state = 'needs_attention';

  // §2.6: upgrade fallido de un run de vista previa → siempre recuperación (nunca «listo»).
  if (opts.upgradeOnlyFailure && state !== 'in_progress') state = 'needs_attention';

  return {
    state,
    generationComplete,
    packageReady,
    complete: generationComplete && packageReady,
    missingComponents,
    previewComponents,
    adminActions: actions,
  };
}

/** ¿El run terminado debe quedar `preview` (todo completado; algún componente de vista previa; nada más falta)? */
export function terminalStatusFor(c: RunCompletion): 'completed' | 'preview' | 'failed' {
  if (c.generationComplete) return 'completed';
  const nonPreview = c.missingComponents.filter((k) => !c.previewComponents.includes(k));
  if (nonPreview.length === 0 && c.previewComponents.length > 0) return 'preview';
  return 'failed';
}

type Q = { query: (sql: string, params?: any[]) => Promise<any> };

/**
 * Carga lo que el evaluador necesita de un run (job, generación vigente de cada item y el
 * Manifest congelado). Solo lectura.
 */
export async function loadCompletionInputs(q: Q, jobId: string): Promise<{
  job: CompletionJob & { id: string };
  rows: CompletionRow[];
  manifest: CompletionManifest;
} | null> {
  const [job] = await q.query(
    `select id, status, worker_status, input_payload from public.production_jobs where id = $1`,
    [jobId],
  );
  if (!job) return null;
  const payload = payloadOf(job);
  const manifestId = Number(payload.manifestId);
  if (!Number.isInteger(manifestId)) return null;
  const [m] = await q.query(`select rules_version, manifest_json from public.course_generation_manifests where id = $1`, [manifestId]);
  if (!m) return null;
  const mj = typeof m.manifest_json === 'string' ? JSON.parse(m.manifest_json) : m.manifest_json;
  const rows: CompletionRow[] = await q.query(
    `select g.id, g.item_key, g.type, g.status, g.error, g.output_summary, g.finished_at, g.updated_at, g.chapter_id
       from public.generation_item_runs g
      where g.job_id = $1
        and not exists (select 1 from public.generation_item_runs n
                         where n.manifest_id = g.manifest_id and n.item_key = g.item_key and n.job_id = g.job_id
                           and n.generation > g.generation)`,
    [jobId],
  );
  return {
    job: { ...job, input_payload: payload },
    rows,
    manifest: { rulesVersion: Number(m.rules_version), items: Array.isArray(mj?.items) ? mj.items : [] },
  };
}
