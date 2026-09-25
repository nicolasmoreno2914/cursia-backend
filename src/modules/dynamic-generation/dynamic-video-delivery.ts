/**
 * Fase 5B.2.A — entrega final del video del flujo dynamic (parte autónoma).
 * Spec: campuscloud-gen docs/superpowers/specs/2026-09-25-cursia-v2-5b2a-video-delivery-design.md
 *
 * Módulo PURO (sin I/O, sin Nest): estrategia de entrega, congelado por run,
 * máquina de estados de la entrega del item `video` y validación de la URL
 * de YouTube que se empaqueta. No toca `isJobCompleted`/`isJobFailed`
 * (compartidos con el legacy) ni `src/workers/video-worker.ts`.
 *
 * DN-1 (resuelta por Nicolás, 2026-09-25): YouTube Unlisted con conexión por
 * cuenta. Un run con ≥1 video y `videoMode='real'` congela `youtube` (ver
 * `resolveRunVideoDelivery`); `videogen_direct` queda solo como salida de
 * emergencia de staging (`DYNAMIC_ALLOW_VIDEOGEN_DIRECT=true`, default OFF) y
 * para runs sin video o mock, donde su `.mbz` sigue byte-idéntico a 5B.1.
 */

export const VIDEO_DELIVERY_STRATEGIES = ['videogen_direct', 'youtube'] as const;
export type VideoDeliveryStrategy = (typeof VIDEO_DELIVERY_STRATEGIES)[number];
export const DEFAULT_VIDEO_DELIVERY: VideoDeliveryStrategy = 'videogen_direct';
export const VIDEO_DELIVERY_ENV = 'DYNAMIC_VIDEO_DELIVERY';

/**
 * Estados de entrega en `output_summary.delivery` del item `video`:
 * `pending → completed_local → [uploading_youtube →] completed`, más las
 * esperas reanudables `blocked_auth` / `blocked_quota`, `upload_failed`
 * (fallo de subida sin video creado: se reintenta SOLO el upload) y
 * `ambiguous` (DN-1: la subida empezó y no se sabe si YouTube creó el
 * video — decisión explícita del usuario, nunca automática).
 */
export const VIDEO_DELIVERY_STATES = [
  'pending',
  'completed_local',
  'uploading_youtube',
  'completed',
  'blocked_auth',
  'blocked_quota',
  'upload_failed',
  'ambiguous',
] as const;
export type VideoDeliveryState = (typeof VIDEO_DELIVERY_STATES)[number];

export type VideoDeliveryNext =
  | 'poll_videogen'
  | 'publish_youtube'
  | 'done'
  | 'wait_auth'
  | 'wait_quota'
  | 'resolve_ambiguous';

export interface VideoDeliveryPhase {
  /** true → el item `video` puede pasar a `completed`. */
  itemTerminal: boolean;
  next: VideoDeliveryNext;
}

function isStrategy(v: unknown): v is VideoDeliveryStrategy {
  return typeof v === 'string' && (VIDEO_DELIVERY_STRATEGIES as readonly string[]).includes(v);
}

/**
 * Valor de config `DYNAMIC_VIDEO_DELIVERY`. Ausente o vacío → default
 * (`videogen_direct`). Cualquier otro valor desconocido lanza (fail-fast):
 * nunca se cae en silencio a otra estrategia.
 */
export function parseVideoDeliveryConfig(raw: string | undefined | null): VideoDeliveryStrategy {
  const v = (raw ?? '').trim();
  if (v === '') return DEFAULT_VIDEO_DELIVERY;
  if (isStrategy(v)) return v;
  throw new Error(
    `${VIDEO_DELIVERY_ENV} inválido: "${v}". Valores permitidos: ${VIDEO_DELIVERY_STRATEGIES.join(', ')} ` +
      `(o sin definir = ${DEFAULT_VIDEO_DELIVERY}).`,
  );
}

/** Lee y valida `process.env.DYNAMIC_VIDEO_DELIVERY` (lanza si es inválido). */
export function readVideoDeliveryConfig(env: NodeJS.ProcessEnv = process.env): VideoDeliveryStrategy {
  return parseVideoDeliveryConfig(env[VIDEO_DELIVERY_ENV]);
}

/**
 * M6 (review-it2): chequeo de arranque SOLO para los workers dynamic. Un
 * valor inválido se loguea como error claro pero NO tumba el proceso: los
 * workers usan la estrategia CONGELADA de cada run, y la validación que
 * falla ruidoso vive donde la config se consume (creación del run,
 * `RunsService.startRun`). Nunca se valida en el constructor de un servicio
 * de `AppModule`: eso tumbaría la API y los workers legacy por un typo.
 * Devuelve la estrategia configurada, o null si es inválida.
 */
export function reportVideoDeliveryConfigAtStartup(
  logger: { error(message: string): unknown },
  env: NodeJS.ProcessEnv = process.env,
): VideoDeliveryStrategy | null {
  try {
    return readVideoDeliveryConfig(env);
  } catch (err) {
    logger.error(
      `${err instanceof Error ? err.message : String(err)} Los runs NUEVOS van a fallar al crearse hasta corregirlo; ` +
        `los runs existentes siguen con su estrategia congelada.`,
    );
    return null;
  }
}

/**
 * Estrategia congelada de un run (`production_jobs.input_payload.videoDelivery`).
 * Runs sin el campo (anteriores a 5B.2.A) → `videogen_direct`. Un valor
 * presente pero desconocido es integridad rota → lanza.
 */
export function frozenVideoDeliveryOf(inputPayload: Record<string, any> | null | undefined): VideoDeliveryStrategy {
  const v = inputPayload?.videoDelivery;
  if (v === undefined || v === null) return DEFAULT_VIDEO_DELIVERY;
  if (isStrategy(v)) return v;
  throw new Error(`input_payload.videoDelivery desconocido en el run: ${JSON.stringify(v)} (integridad rota)`);
}

/** `output_summary.delivery` de un item; ausente → `pending`. Desconocido → lanza. */
export function normalizeDeliveryState(v: unknown): VideoDeliveryState {
  if (v === undefined || v === null || v === '') return 'pending';
  if (typeof v === 'string' && (VIDEO_DELIVERY_STATES as readonly string[]).includes(v)) return v as VideoDeliveryState;
  throw new Error(`output_summary.delivery desconocido: ${JSON.stringify(v)}`);
}

/**
 * Render "listo" de Videogen para el flujo dynamic: los estados terminales
 * de `isJobCompleted` (`completed|done|success|finished`) + `completed_local`
 * (MP4 listo, sin subir a YouTube). Réplica local a propósito de la lista de
 * `isJobCompleted` para que este módulo sea puro (sin importar el cliente
 * HTTP); `isDynamicVideoCompleted` del worker sigue siendo la fuente usada
 * en el poll, y el harness verifica que ambas coincidan.
 */
export function isVideogenRenderReady(status: string | null | undefined): boolean {
  const s = String(status ?? '').toLowerCase();
  return s === 'completed' || s === 'done' || s === 'success' || s === 'finished' || s === 'completed_local';
}

/**
 * Máquina de estados de la entrega del item `video` (spec §2):
 *
 * | Estrategia        | completed_local | uploading_youtube | completed |
 * |-------------------|-----------------|-------------------|-----------|
 * | videogen_direct   | terminal        | n/a (lanza)       | terminal  |
 * | youtube           | intermedio      | intermedio        | terminal  |
 *
 * - `videogenStatus` es el estado que informa Videogen (render); el
 *   `deliveryState` es estado propio de Cursia (`output_summary.delivery`).
 * - Un fallo de Videogen NO se decide acá: el worker lo detecta antes con
 *   `isJobFailed` (sin cambios); para un render no listo esto devuelve
 *   `poll_videogen`.
 * - `wait_auth`/`wait_quota`: esperas reanudables. El worker, al volver a
 *   reclamar el item (tras un retry manual), vuelve a verificar la
 *   condición (conexión activa / cuota) intentando publicar de nuevo.
 * - Combinaciones imposibles (estado de YouTube en un run `videogen_direct`)
 *   lanzan: nunca se degradan en silencio.
 */
export function dynamicVideoDeliveryPhase(
  videogenStatus: string | null | undefined,
  deliveryState: VideoDeliveryState | null | undefined,
  strategy: VideoDeliveryStrategy,
): VideoDeliveryPhase {
  if (!isStrategy(strategy)) throw new Error(`estrategia de entrega desconocida: ${JSON.stringify(strategy)}`);
  const state = normalizeDeliveryState(deliveryState);

  if (strategy === 'videogen_direct') {
    if (
      state === 'uploading_youtube' ||
      state === 'blocked_auth' ||
      state === 'blocked_quota' ||
      state === 'upload_failed' ||
      state === 'ambiguous'
    ) {
      throw new Error(`estado de entrega "${state}" imposible con la estrategia videogen_direct`);
    }
    if (state === 'completed_local' || state === 'completed') return { itemTerminal: true, next: 'done' };
    return isVideogenRenderReady(videogenStatus)
      ? { itemTerminal: true, next: 'done' }
      : { itemTerminal: false, next: 'poll_videogen' };
  }

  // youtube
  switch (state) {
    case 'completed':
      return { itemTerminal: true, next: 'done' };
    case 'uploading_youtube':
    case 'completed_local':
    case 'upload_failed':
      return { itemTerminal: false, next: 'publish_youtube' };
    case 'blocked_auth':
      return { itemTerminal: false, next: 'wait_auth' };
    case 'blocked_quota':
      return { itemTerminal: false, next: 'wait_quota' };
    case 'ambiguous':
      return { itemTerminal: false, next: 'resolve_ambiguous' };
    case 'pending':
    default:
      return isVideogenRenderReady(videogenStatus)
        ? { itemTerminal: false, next: 'publish_youtube' }
        : { itemTerminal: false, next: 'poll_videogen' };
  }
}

// ─── URL de YouTube que se empaqueta ────────────────────────────────────────

const YOUTUBE_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE_WATCH_HOSTS = new Set(['www.youtube.com', 'youtube.com']);
const YOUTUBE_SHORT_HOST = 'youtu.be';

export type YoutubeUrlCheck = { ok: true; videoId: string } | { ok: false; reason: string };

/**
 * Valida una URL de entrega de YouTube para el `.mbz`: https, host de
 * YouTube (`www.youtube.com`/`youtube.com` con `/watch?v=<id>`, o
 * `youtu.be/<id>`), id de 11 caracteres, y SIN firma ni parámetros extra
 * (nada de `token=`, `sig=`, `expire=`…: el link debe ser permanente),
 * sin credenciales, puerto ni fragmento.
 */
export function checkYoutubeDeliveryUrl(raw: unknown): YoutubeUrlCheck {
  if (typeof raw !== 'string' || raw.length === 0) return { ok: false, reason: 'youtubeUrl ausente' };
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, reason: `youtubeUrl no es una URL válida: ${raw}` };
  }
  if (u.protocol !== 'https:') return { ok: false, reason: `youtubeUrl debe ser https: ${raw}` };
  if (u.username || u.password || u.port || u.hash) {
    return { ok: false, reason: `youtubeUrl con credenciales, puerto o fragmento: ${raw}` };
  }
  const host = u.hostname.toLowerCase();
  const params = [...u.searchParams.keys()];
  if (YOUTUBE_WATCH_HOSTS.has(host)) {
    if (u.pathname !== '/watch') return { ok: false, reason: `youtubeUrl de youtube.com debe ser /watch?v=<id>: ${raw}` };
    if (params.length !== 1 || params[0] !== 'v') {
      return { ok: false, reason: `youtubeUrl con parámetros extra o firma (solo se permite v=<id>): ${raw}` };
    }
    const id = u.searchParams.get('v') ?? '';
    if (!YOUTUBE_ID_RE.test(id)) return { ok: false, reason: `youtubeUrl con id de video inválido: ${raw}` };
    return { ok: true, videoId: id };
  }
  if (host === YOUTUBE_SHORT_HOST) {
    if (params.length !== 0 || u.search) return { ok: false, reason: `youtubeUrl de youtu.be con parámetros o firma: ${raw}` };
    const id = u.pathname.replace(/^\//, '');
    if (!YOUTUBE_ID_RE.test(id)) return { ok: false, reason: `youtubeUrl con id de video inválido: ${raw}` };
    return { ok: true, videoId: id };
  }
  return { ok: false, reason: `youtubeUrl con host no permitido (${host}); solo youtube.com / youtu.be: ${raw}` };
}

/** URL canónica que Cursia persiste para un id de YouTube. */
export function canonicalYoutubeWatchUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

// ─── DN-1: política de entrega por run ──────────────────────────────────────

/**
 * Salida de emergencia SOLO para staging: con el string exacto `'true'` un run
 * real con videos puede congelar `videogen_direct` (si además
 * `DYNAMIC_VIDEO_DELIVERY=videogen_direct`). Ausente / cualquier otro valor →
 * OFF (default, y el único valor aceptable en producción: nunca la URL directa
 * de Videogen en un curso real).
 */
export const ALLOW_VIDEOGEN_DIRECT_ENV = 'DYNAMIC_ALLOW_VIDEOGEN_DIRECT';

/** Prefijos estables (UI/ops) de los 409 del gate de entrega. */
export const VIDEO_DELIVERY_NOT_YOUTUBE = 'video_delivery_not_youtube';
export const YOUTUBE_PREFLIGHT_FAILED = 'youtube_preflight_failed';

export function isVideogenDirectAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[ALLOW_VIDEOGEN_DIRECT_ENV] === 'true';
}

/** ¿El run (o la porción que se va a (re)generar) necesita YouTube? ≥1 video y video real (con gasto). */
export function runNeedsYoutube(videoCount: number, videoMode: string | null | undefined): boolean {
  return videoCount > 0 && videoMode === 'real';
}

export type VideoDeliveryGateResult =
  | { ok: true; strategy: VideoDeliveryStrategy; requiresYoutubePreflight: boolean }
  | { ok: false; code: typeof VIDEO_DELIVERY_NOT_YOUTUBE; message: string };

export function videoDeliveryNotYoutubeMessage(): string {
  return (
    `${VIDEO_DELIVERY_NOT_YOUTUBE}: este curso tiene videos reales y su entrega final debe ser YouTube (Unlisted). ` +
    'La entrega directa de Videogen no está permitida (solo staging, con DYNAMIC_ALLOW_VIDEOGEN_DIRECT=true). ' +
    'No se creó nada ni se envió ningún video.'
  );
}

/**
 * Estrategia a congelar en un run NUEVO (DN-1). `videoCount` = videos del
 * Manifest; `configured` = `DYNAMIC_VIDEO_DELIVERY` ya parseado (fail-fast).
 * - Sin video o `videoMode` mock → la configurada (default `videogen_direct`,
 *   `.mbz` byte-idéntico a 5B.1; un run mock nunca se empaqueta, I4).
 * - Con video real → `youtube` (default), o `videogen_direct` SOLO si la
 *   config lo pide explícitamente Y `DYNAMIC_ALLOW_VIDEOGEN_DIRECT=true`;
 *   si la config lo pide sin el permiso → `video_delivery_not_youtube`.
 */
export function resolveRunVideoDelivery(opts: {
  videoCount: number;
  videoMode: string | null | undefined;
  configured: VideoDeliveryStrategy;
  env?: NodeJS.ProcessEnv;
}): VideoDeliveryGateResult {
  if (!runNeedsYoutube(opts.videoCount, opts.videoMode)) {
    return { ok: true, strategy: opts.configured, requiresYoutubePreflight: false };
  }
  if (opts.configured === 'videogen_direct') {
    const explicit = ((opts.env ?? process.env)[VIDEO_DELIVERY_ENV] ?? '').trim() !== '';
    if (!explicit) return { ok: true, strategy: 'youtube', requiresYoutubePreflight: true };
    if (isVideogenDirectAllowed(opts.env)) return { ok: true, strategy: 'videogen_direct', requiresYoutubePreflight: false };
    return { ok: false, code: VIDEO_DELIVERY_NOT_YOUTUBE, message: videoDeliveryNotYoutubeMessage() };
  }
  return { ok: true, strategy: 'youtube', requiresYoutubePreflight: true };
}

/**
 * Gate de un camino que RE-envía trabajo de video de un run YA congelado
 * (reabrir, retry, regenerar, fromRun). `videoWork` = cantidad de videos que
 * ese camino puede enviar a Videogen. La estrategia congelada no cambia nunca:
 * `videogen_direct` real con trabajo de video → solo con el permiso de staging.
 */
export function frozenRunVideoGate(opts: {
  videoWork: number;
  videoMode: string | null | undefined;
  strategy: VideoDeliveryStrategy;
  env?: NodeJS.ProcessEnv;
}): VideoDeliveryGateResult {
  if (!runNeedsYoutube(opts.videoWork, opts.videoMode)) {
    return { ok: true, strategy: opts.strategy, requiresYoutubePreflight: false };
  }
  if (opts.strategy === 'youtube') return { ok: true, strategy: 'youtube', requiresYoutubePreflight: true };
  if (isVideogenDirectAllowed(opts.env)) return { ok: true, strategy: 'videogen_direct', requiresYoutubePreflight: false };
  return { ok: false, code: VIDEO_DELIVERY_NOT_YOUTUBE, message: videoDeliveryNotYoutubeMessage() };
}

// ─── DN-1: preflight de YouTube (tipos y mensajes, sin I/O) ─────────────────

/** Privacidad del upload V2: SIEMPRE Unlisted (nunca público ni un canal central de Cursia). */
export const YOUTUBE_UPLOAD_PRIVACY = 'unlisted' as const;

export const YOUTUBE_PREFLIGHT_CHECK_KEYS = [
  'connected',
  'oauth_valid',
  'refresh_usable',
  'channel_resolved',
  'upload_permission',
  'privacy_unlisted',
] as const;
export type YoutubePreflightCheckKey = (typeof YOUTUBE_PREFLIGHT_CHECK_KEYS)[number];

/** En orden de prioridad: el primer check que falla define el `reason`. */
export const YOUTUBE_PREFLIGHT_REASONS = [
  'no_connection',
  'reauth_required',
  'token_refresh_failed',
  'channel_unresolved',
  'missing_upload_scope',
] as const;
export type YoutubePreflightReason = (typeof YOUTUBE_PREFLIGHT_REASONS)[number];

export interface YoutubePreflightChannel {
  id: string;
  title: string | null;
  thumbnail: string | null;
}

export interface YoutubePreflightResult {
  ok: boolean;
  channel: YoutubePreflightChannel | null;
  checks: Array<{ key: YoutubePreflightCheckKey; ok: boolean }>;
  reason?: YoutubePreflightReason;
}

const REASON_BY_CHECK: Partial<Record<YoutubePreflightCheckKey, YoutubePreflightReason>> = {
  connected: 'no_connection',
  oauth_valid: 'reauth_required',
  refresh_usable: 'token_refresh_failed',
  channel_resolved: 'channel_unresolved',
  upload_permission: 'missing_upload_scope',
};

/** Arma el resultado del preflight desde los checks evaluados (reason = primer check fallido, en el orden de las keys). */
export function buildYoutubePreflightResult(
  checks: Record<YoutubePreflightCheckKey, boolean>,
  channel: YoutubePreflightChannel | null,
): YoutubePreflightResult {
  const list = YOUTUBE_PREFLIGHT_CHECK_KEYS.map((key) => ({ key, ok: checks[key] === true }));
  const firstFail = list.find((c) => !c.ok);
  const out: YoutubePreflightResult = { ok: !firstFail, channel: checks.channel_resolved ? channel : null, checks: list };
  if (firstFail) {
    const reason = REASON_BY_CHECK[firstFail.key];
    // privacy_unlisted es constante (true): nunca debería fallar; si falla es un bug → reason explícito igual.
    out.reason = reason ?? 'channel_unresolved';
  }
  return out;
}

/** Scopes guardados en youtube_connections.scopes (coma o espacio; nombre corto o URL completa). */
export function hasYoutubeUploadScope(scopes: string | null | undefined): boolean {
  return String(scopes ?? '')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .some((s) => s === 'youtube.upload' || s === 'https://www.googleapis.com/auth/youtube.upload');
}

/** Mensajes legibles (español, sin tokens ni errores crudos de Google) por reason. */
export const YOUTUBE_PREFLIGHT_MESSAGES: Record<YoutubePreflightReason, string> = {
  no_connection: 'No hay un canal de YouTube conectado a esta cuenta. Conectá tu canal en la sección Cuenta.',
  reauth_required: 'La conexión con YouTube expiró o fue revocada. Volvé a conectar tu canal en la sección Cuenta.',
  token_refresh_failed: 'No se pudo renovar el acceso a YouTube. Volvé a conectar tu canal en la sección Cuenta.',
  channel_unresolved: 'No se pudo verificar tu canal de YouTube. Revisá que la cuenta de Google tenga un canal y reintentá.',
  missing_upload_scope: 'La conexión con YouTube no tiene permiso para subir videos. Volvé a conectar tu canal aceptando el permiso de subida.',
};

/** Mensaje del 409 de un run bloqueado por el preflight: `youtube_preflight_failed:<reason>: <texto>`. */
export function youtubePreflightFailedMessage(reason: YoutubePreflightReason | string): string {
  const text = (YOUTUBE_PREFLIGHT_MESSAGES as Record<string, string>)[reason] ?? 'El preflight de YouTube no pasó.';
  return `${YOUTUBE_PREFLIGHT_FAILED}:${reason}: ${text} No se creó nada ni se envió ningún video.`;
}

// ─── DN-1: vista de entrega para la UI (run/item payload) ───────────────────

export const VIDEO_DELIVERY_VIEW_STATES = [
  'pending',
  'rendering',
  'completed_local',
  'uploading_youtube',
  'completed',
  'blocked_auth',
  'blocked_quota',
  'upload_failed',
  'ambiguous',
] as const;
export type VideoDeliveryViewState = (typeof VIDEO_DELIVERY_VIEW_STATES)[number];

export type VideoDeliveryAction = 'reconnect_youtube' | 'retry_upload' | 'resolve_ambiguous' | 'retry';

export interface VideoDeliveryView {
  state: VideoDeliveryViewState;
  strategy: VideoDeliveryStrategy;
  youtubeVideoId: string | null;
  youtubeUrl: string | null;
  /** Motivo legible (bloqueos/fallos); null si no aplica. */
  detail: string | null;
  /** Acciones que la UI puede ofrecer en este estado. */
  actions: VideoDeliveryAction[];
}

/**
 * Estado de entrega de un item `video` para la UI, derivado de su fila
 * (`status`, `error`, `output_summary`) y de la estrategia congelada del run.
 * Nunca lanza: un `output_summary.delivery` desconocido se muestra como
 * `pending` con el detalle (la integridad la valida el worker, no la vista).
 */
export function deliveryViewOf(opts: {
  strategy: VideoDeliveryStrategy;
  itemStatus: string;
  error: string | null | undefined;
  outputSummary: Record<string, any> | null | undefined;
}): VideoDeliveryView {
  const os = opts.outputSummary ?? {};
  const ext = (os.external ?? {}) as Record<string, any>;
  const youtubeVideoId: string | null = (typeof os.youtubeVideoId === 'string' && os.youtubeVideoId) || ext.youtubeVideoId || null;
  const youtubeUrl: string | null = (typeof os.youtubeUrl === 'string' && os.youtubeUrl) || ext.youtubeUrl || null;
  const err = String(opts.error ?? '');
  const failed = opts.itemStatus === 'failed';
  const base = { strategy: opts.strategy, youtubeVideoId, youtubeUrl };
  const view = (state: VideoDeliveryViewState, detail: string | null, actions: VideoDeliveryAction[]): VideoDeliveryView => ({
    state,
    ...base,
    detail,
    actions,
  });

  if (opts.strategy === 'videogen_direct') {
    if (opts.itemStatus === 'completed') return view('completed', null, []);
    if (ext.videogenJobId && !failed) return view('rendering', null, []);
    return view('pending', failed ? err || null : null, failed ? ['retry'] : []);
  }

  let state: VideoDeliveryState | 'unknown';
  try {
    state = normalizeDeliveryState(os.delivery);
  } catch {
    state = 'unknown';
  }
  const blockDetail: string | null = typeof os.youtubeBlockDetail === 'string' ? os.youtubeBlockDetail : null;
  const uploadDetail: string | null = typeof os.youtubeUploadError === 'string' ? os.youtubeUploadError : null;

  if (opts.itemStatus === 'completed' && youtubeVideoId && youtubeUrl) return view('completed', null, []);
  if (state === 'ambiguous' || (failed && err.startsWith('ambiguous_youtube_upload'))) {
    return view('ambiguous', err || 'La subida a YouTube quedó sin confirmar.', ['resolve_ambiguous']);
  }
  if (state === 'blocked_auth') return view('blocked_auth', blockDetail ?? (err || null), ['reconnect_youtube', 'retry_upload']);
  if (state === 'blocked_quota') return view('blocked_quota', blockDetail ?? (err || null), failed ? ['retry_upload'] : []);
  if (state === 'upload_failed') return view('upload_failed', uploadDetail ?? (err || null), failed ? ['retry_upload'] : []);
  if (state === 'uploading_youtube') {
    return view('uploading_youtube', null, []);
  }
  if (state === 'completed_local' || state === 'completed') {
    return view('completed_local', failed ? err || null : null, failed ? ['retry_upload'] : []);
  }
  // pending (antes o durante el render)
  if (failed && err.startsWith(YOUTUBE_PREFLIGHT_FAILED)) return view('blocked_auth', err, ['reconnect_youtube', 'retry']);
  if (ext.videogenJobId && !failed) return view('rendering', null, []);
  if (state === 'unknown') return view('pending', `output_summary.delivery desconocido: ${JSON.stringify(os.delivery)}`, []);
  return view('pending', failed ? err || null : null, failed ? ['retry'] : []);
}

// ─── DN-1: requisito de packaging de un run youtube ─────────────────────────

/**
 * Problemas (keys `"<itemKey>:<motivo>"`) que impiden empaquetar un item
 * `video` de un run `youtube`: tiene que estar `completed`, con
 * `youtubeVideoId`, `youtubeUrl` válida (https, youtube.com/youtu.be, sin
 * firma) y del MISMO id, y `delivery='completed'`. Lista vacía = empaquetable.
 */
export function youtubeDeliveryProblems(
  itemKey: string,
  status: string | null | undefined,
  outputSummary: Record<string, any> | null | undefined,
): string[] {
  const os = outputSummary ?? {};
  const ext = (os.external ?? {}) as Record<string, any>;
  const out: string[] = [];
  if (status !== 'completed') out.push(`${itemKey}:youtube_not_completed`);
  const id = (typeof os.youtubeVideoId === 'string' && os.youtubeVideoId) || ext.youtubeVideoId || null;
  const url = (typeof os.youtubeUrl === 'string' && os.youtubeUrl) || ext.youtubeUrl || null;
  if (!id) out.push(`${itemKey}:missing_youtube_video_id`);
  if (!url) out.push(`${itemKey}:missing_youtube_url`);
  else {
    const c = checkYoutubeDeliveryUrl(url);
    if (c.ok === false || (id && c.videoId !== id)) out.push(`${itemKey}:invalid_youtube_url`);
  }
  if (os.delivery !== 'completed') out.push(`${itemKey}:youtube_delivery_not_completed`);
  return out;
}
