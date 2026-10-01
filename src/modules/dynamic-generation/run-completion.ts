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
import { autoHealDecision, autoHealEnabled, safeAutoRetryDecision } from './auto-heal';
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
  | 'generate_real_videos'
  /** BE-B: el paquete final falló (build o error transitorio) y no queda reintento automático: reintentar puede funcionar. */
  | 'retry_package'
  /**
   * BE-B fix round 1 (I2): el precheck del paquete lo bloquea por algo que no es de un componente concreto
   * (p.ej. el dueño quedó fuera de la allow-list): resolver la causa (`reason`) y después pedir el paquete.
   */
  | 'resolve_package_block';

export interface RunAdminAction {
  code: RunAdminActionCode;
  itemKey?: string;
  /** BE-B fix round 1 (I2): código del bloqueo del paquete que originó esta acción (nunca texto técnico). */
  reason?: string;
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
  /**
   * BE-B: estado del último job de paquete FINAL del run (solo cuando la generación está completa):
   * `none` (todavía no hay job), `queued`/`running`/`retrying` (armándose), `completed`, `failed`
   * (falló o no se pudo armar). `autoRetryPending`: el servidor lo va a reintentar solo. `auto`: el run
   * está cubierto por el empaque automático (completado desde BE-B y encendido); `false` = run anterior
   * (o empaque automático apagado): con `status:'none'` el paquete se pide a mano.
   */
  packageJob?: {
    status: string;
    autoRetryPending: boolean;
    auto: boolean;
    /** Fix round 1 (I2): el precheck no dejó armar el paquete (código + mensaje para admin). */
    blocked?: { code: string; message: string | null };
  } | null;
}

/**
 * BE-B: lo que el evaluador necesita saber del paquete. `ready` = paquete VIGENTE y ENTREGABLE;
 * `status` = estado del último job de paquete FINAL (ver RunCompletion.packageJob);
 * `autoRetryPending` = el servidor lo reintenta solo (empaque automático, intentos acotados).
 */
export interface CompletionPackageInfo {
  ready: boolean;
  status?: string | null;
  autoRetryPending?: boolean;
  /** El run está cubierto por el empaque automático. */
  auto?: boolean;
  /** Fix round 1 (I2): bloqueo del precheck (código, mensaje para admin, faltantes `<itemKey>:<problema>`). */
  blocked?: { code: string; message?: string | null; missing?: string[] } | null;
}

/**
 * BE-B fix round 1 (I2): acciones de admin para un paquete BLOQUEADO por el precheck — la del componente
 * que lo bloquea (nunca `retry_package`, que devolvería el mismo 409/403). Una vez resuelto el componente,
 * el run se reabre y al volver a completarse el paquete se arma solo.
 */
export function packageBlockActions(
  blocked: { code: string; missing?: string[] | null },
  manifest: CompletionManifest,
): RunAdminAction[] {
  const missing = Array.isArray(blocked.missing) ? blocked.missing : [];
  const out: RunAdminAction[] = [];
  for (const it of manifest.items) {
    if (!missing.some((m) => m === it.key || m.startsWith(`${it.key}:`))) continue;
    const yt = it.type === 'video' && (blocked.code === 'youtube_delivery_incomplete' || missing.some((m) => m.startsWith(`${it.key}:`) && /youtube/.test(m)));
    out.push({ code: yt ? 'resolve_youtube' : 'regenerate_item', itemKey: it.key, reason: blocked.code });
  }
  if (!out.length) out.push({ code: 'resolve_package_block', reason: blocked.code });
  return out;
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
  /** Fase 8: item run de otro run del que se arrastró esta fila (fromRun). */
  carried_from_item_run_id?: string | null;
  /**
   * Fix round 1 (C1): cadena de procedencia de la fila (ids de los item runs de los que se arrastró,
   * del más cercano al más lejano). La completa `attachCarryChains`; ausente = sin arrastre conocido.
   */
  carry_chain?: string[] | null;
  /** Fix round 3 (N1): `finished_at` de la fila ORIGINAL de la cadena de arrastre (la que produjo la salida). */
  carry_origin_finished_at?: Date | string | null;
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
  /**
   * Fix round 2: inicio de la validación de servidor por tipo de item en ESTA base (el primer
   * `finished_at` de una fila completada con `v3Validation`, ver `loadValidationCutoffs`). Un item
   * completado ANTES de ese instante sin `v3Validation` es anterior a la validación (curso viejo) y
   * cuenta como validado; uno posterior sin ella sigue «sin validar». Sin dato del tipo → sin excepción.
   */
  validationCutoffs?: Readonly<Record<string, Date>> | null;
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

function msOf(v: unknown): number {
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'string') return Date.parse(v);
  return NaN;
}

/** Fix round 2: ¿la fila completó antes de que existiera la validación de servidor de su tipo? */
export function predatesValidation(r: CompletionRow, type: string, cutoffs?: Readonly<Record<string, Date>> | null): boolean {
  const cut = cutoffs?.[type];
  if (!cut) return false;
  // Fix round 3 (N1): una fila arrastrada por fromRun (nace con finished_at = ahora) hereda la exención
  // de la fila original de la que se copió (su salida y su output_summary son los de esa fila).
  const done = msOf(r.carried_from_item_run_id && r.carry_origin_finished_at ? r.carry_origin_finished_at : r.finished_at);
  return Number.isFinite(done) && done < cut.getTime();
}

/**
 * Clasifica cada item del Manifest. Pura. `rowsByKey` = generación vigente por item_key.
 */
export function classifyRunItems(
  job: CompletionJob,
  rowsByKey: ReadonlyMap<string, CompletionRow>,
  manifest: CompletionManifest,
  validationCutoffs?: Readonly<Record<string, Date>> | null,
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
    // Fix round 1 (M5): en v3 el video interactivo exige YouTube (el empaque v3 rechaza otra entrega):
    // un video real entregado por videogen_direct nunca quedaría empaquetable → sin validar.
    if (manifest.rulesVersion === 3 && strategy !== 'youtube') return 'unvalidated';
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
      if (v && v.status === 'completed' && !questionsOfVideo(v, r, s)) {
        out.set(it.key, 'unvalidated');
        continue;
      }
    }
    if (manifest.rulesVersion === 3 && requiresV3Validation(it.type, it.variant ?? null)) {
      const v = s.v3Validation;
      if ((!v || typeof v !== 'object') && !predatesValidation(r, it.type, validationCutoffs)) {
        out.set(it.key, 'unvalidated');
        continue;
      }
    }
    out.set(it.key, 'done');
  }
  return out;
}

/**
 * ¿Las preguntas (`q`) son de la generación vigente del video (`v`)? Misma regla que el empaque
 * (`questionsBelongToVideo`) y, además (fix round 1, C1), una fila de preguntas ARRASTRADA por
 * fromRun conserva el `sourceVideoItemRunId` del run de origen: es válida si ese id está en la
 * cadena de procedencia del video vigente (el video también se arrastró, la misma salida).
 */
export function questionsOfVideo(v: CompletionRow, q: CompletionRow, qs?: Record<string, any>): boolean {
  const s = qs ?? os(q);
  if (questionsBelongToVideo({ id: v.id, finishedAt: v.finished_at }, { status: q.status, outputSummary: s, finishedAt: q.finished_at })) return true;
  const src = s.sourceVideoItemRunId;
  if (typeof src !== 'string' || !src || !q.carried_from_item_run_id) return false;
  const chain = Array.isArray(v.carry_chain) ? v.carry_chain : (v.carried_from_item_run_id ? [v.carried_from_item_run_id] : []);
  return chain.includes(src);
}

/**
 * Fix round 1 (C1): completa `carry_chain` de las filas de video arrastradas (sigue
 * `carried_from_item_run_id` hasta el origen; tope de 32 saltos). Solo lectura.
 */
export async function attachCarryChains<T extends CompletionRow>(q: Q, rows: T[]): Promise<T[]> {
  // Fix round 3 (N1): TODAS las filas arrastradas (no solo videos) — la exención de «anterior a la
  // validación» se juzga contra el `finished_at` de la fila ORIGINAL (la raíz de la cadena).
  const carried = rows.filter((r) => r.carried_from_item_run_id);
  if (!carried.length) return rows;
  const parent = new Map<string, string | null>();
  const finished = new Map<string, Date | string | null>();
  let frontier = [...new Set(carried.map((r) => String(r.carried_from_item_run_id)))];
  for (let hop = 0; hop < 32 && frontier.length; hop++) {
    const got: Array<{ id: string; carried_from_item_run_id: string | null; finished_at: Date | string | null }> = await q.query(
      `select id, carried_from_item_run_id, finished_at from public.generation_item_runs where id = any($1::uuid[])`,
      [frontier],
    );
    const next: string[] = [];
    for (const g of got) {
      parent.set(g.id, g.carried_from_item_run_id ?? null);
      finished.set(g.id, g.finished_at ?? null);
      if (g.carried_from_item_run_id && !parent.has(g.carried_from_item_run_id)) next.push(g.carried_from_item_run_id);
    }
    frontier = [...new Set(next)];
  }
  for (const r of carried) {
    const chain: string[] = [];
    let cur: string | null | undefined = r.carried_from_item_run_id;
    while (cur && !chain.includes(cur) && chain.length < 32) {
      chain.push(cur);
      cur = parent.get(cur) ?? null;
    }
    r.carry_chain = chain;
    // La raíz conocida más lejana con finished_at (la salida original de la que se copió esta fila).
    for (let i = chain.length - 1; i >= 0; i--) {
      const f = finished.get(chain[i]);
      if (f) {
        r.carry_origin_finished_at = f;
        break;
      }
    }
  }
  return rows;
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
  const ahRow = { status: r.status, type: r.type, error: r.error ?? null, output_summary: s, finished_at: r.finished_at ?? null, updated_at: r.updated_at ?? null };
  // Fix round 1 (M5): solo si el tick del auto-healer corre (si está apagado nadie lo va a reabrir).
  const tickOn = autoHealEnabled(process.env);
  const d = autoHealDecision(ahRow, now);
  if (tickOn && (d.heal === true || (d.heal === false && d.reason === 'backoff'))) return null;
  // BE-B: rechazo definitivo SIN gasto (videogen_submit_rejected / gamma_submit_failed) con su ÚNICO
  // reintento automático todavía disponible: lo toma el servidor, sin acción humana.
  const sd = safeAutoRetryDecision(ahRow, now);
  if (tickOn && (sd.heal === true || (sd.heal === false && sd.reason === 'backoff'))) return null;
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
  pkg?: CompletionPackageInfo | null,
  opts: CompletionOptions = {},
): RunCompletion {
  const rowsByKey = new Map(rows.map((r) => [r.item_key, r]));
  const classes = classifyRunItems(job, rowsByKey, manifest, opts.validationCutoffs);
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
  else if (generationComplete) {
    // BE-B: `packaging` mientras el paquete final se arma (o el servidor lo va a armar/reintentar solo);
    // un paquete que falló sin reintento automático pendiente → recuperación de admin (`retry_package`).
    // Fix round 1 (I1/I2): nunca `packaging` sin un job activo, un (re)intento automático pendiente o una
    // acción visible: run cubierto por el empaque automático sin nada pendiente → needs_attention.
    const st = pkg?.status ?? null;
    const pending = !!pkg?.autoRetryPending;
    if (packageReady) state = 'complete';
    else if (pkg?.blocked) {
      state = 'needs_attention';
      for (const a of packageBlockActions(pkg.blocked, manifest)) push(a);
    } else if (st === 'failed' && !pending) {
      state = 'needs_attention';
      push({ code: 'retry_package' });
    } else if ((st === 'none' || st === 'stale') && !pending && pkg?.auto) {
      state = 'needs_attention';
      push({ code: 'retry_package' });
    } else state = 'packaging';
  } else if (nonPreviewMissing === 0 && previewComponents.length > 0) state = 'preview';
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
    ...(generationComplete && pkg && pkg.status !== undefined
      ? { packageJob: {
          status: packageReady ? 'completed' : String(pkg.status ?? 'none'),
          autoRetryPending: !packageReady && !!pkg.autoRetryPending,
          auto: !!pkg.auto,
          ...(pkg.blocked && !packageReady ? { blocked: { code: pkg.blocked.code, message: pkg.blocked.message ?? null } } : {}),
        } }
      : {}),
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
 * Fix round 2 (cursos viejos): inicio REAL de la validación de servidor por tipo, medido en la propia
 * base — el `finished_at` más antiguo de una fila `completed` con `output_summary.v3Validation`.
 * Desde V2.1 R11a todo item validado que completa lo registra; por eso un item del mismo tipo que
 * completó ANTES de ese instante (sin `v3Validation`) es anterior a la validación y no se marca «sin
 * validar». Se eligió este marcador porque los datos no guardan la versión del validador ni la
 * fecha de despliegue (promptVersion/rulesVersion no distinguen antes/después de R11a: rulesVersion 3
 * ya existía y promptVersion no viaja en todos los tipos). Cache por proceso: un mínimo encontrado
 * solo puede bajar (se re-consulta cada 60 s y se combina); un tipo sin filas validadas no exime nada.
 */
let cutoffCache: { checkedAt: number; value: Record<string, Date> } | null = null;
/** Fix round 3 (N6): techo del marcador (ver loadValidationCutoffs). */
export const VALIDATION_CUTOFF_CEILING = new Date('2026-10-01T00:00:00Z');
const CUTOFF_RECHECK_MS = 60_000;

export async function loadValidationCutoffs(q: Q, now = Date.now()): Promise<Record<string, Date>> {
  if (cutoffCache && now - cutoffCache.checkedAt < CUTOFF_RECHECK_MS) return cutoffCache.value;
  const rows: Array<{ type: string; first: Date | string | null }> = await q.query(
    `select type, min(finished_at) as first from public.generation_item_runs
      where status = 'completed' and output_summary ? 'v3Validation' and finished_at is not null
      group by type`,
  );
  const value: Record<string, Date> = { ...(cutoffCache?.value ?? {}) };
  for (const r of rows) {
    const d = r.first instanceof Date ? r.first : r.first ? new Date(r.first) : null;
    if (!d || !Number.isFinite(d.getTime())) continue;
    if (!value[r.type] || d.getTime() < value[r.type].getTime()) value[r.type] = d;
  }
  // Fix round 3 (N6): techo fijo — para esta fecha la validación de servidor ya estaba desplegada en todo
  // entorno con runs v3 (R11a, 2026-09-26; staging la usa desde entonces y producción recibe V2.1 con
  // ella). Si las primeras filas validadas se borraran (cascada de un curso), el marcador NO puede
  // correrse después de este techo: nada completado después sin v3Validation queda exento.
  for (const t of Object.keys(value)) if (value[t].getTime() > VALIDATION_CUTOFF_CEILING.getTime()) value[t] = VALIDATION_CUTOFF_CEILING;
  cutoffCache = { checkedAt: now, value };
  return value;
}

/** Solo para tests: olvida el cache de `loadValidationCutoffs`. */
export function _resetValidationCutoffsForTests(): void {
  cutoffCache = null;
}

/**
 * Carga lo que el evaluador necesita de un run (job, generación vigente de cada item y el
 * Manifest congelado). Solo lectura.
 */
export async function loadCompletionInputs(q: Q, jobId: string): Promise<{
  validationCutoffs: Record<string, Date>;
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
    `select g.id, g.item_key, g.type, g.status, g.error, g.output_summary, g.finished_at, g.updated_at, g.chapter_id,
            g.carried_from_item_run_id
       from public.generation_item_runs g
      where g.job_id = $1
        and not exists (select 1 from public.generation_item_runs n
                         where n.manifest_id = g.manifest_id and n.item_key = g.item_key and n.job_id = g.job_id
                           and n.generation > g.generation)`,
    [jobId],
  );
  await attachCarryChains(q, rows);
  const validationCutoffs = await loadValidationCutoffs(q);
  return {
    validationCutoffs,
    job: { ...job, input_payload: payload },
    rows,
    manifest: { rulesVersion: Number(m.rules_version), items: Array.isArray(mj?.items) ? mj.items : [] },
  };
}
