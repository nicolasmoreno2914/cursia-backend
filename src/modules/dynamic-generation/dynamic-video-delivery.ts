/**
 * Fase 5B.2.A — entrega final del video del flujo dynamic (parte autónoma).
 * Spec: campuscloud-gen docs/superpowers/specs/2026-09-25-cursia-v2-5b2a-video-delivery-design.md
 *
 * Módulo PURO (sin I/O, sin Nest): estrategia de entrega, congelado por run,
 * máquina de estados de la entrega del item `video` y validación de la URL
 * de YouTube que se empaqueta. No toca `isJobCompleted`/`isJobFailed`
 * (compartidos con el legacy) ni `src/workers/video-worker.ts`.
 *
 * La decisión de producto (DN-1: YouTube vs storage propio vs Videogen
 * directo) sigue abierta: el default es `videogen_direct`, que deja el
 * `.mbz` byte-idéntico a 5B.1. `youtube` queda detrás de config.
 */

export const VIDEO_DELIVERY_STRATEGIES = ['videogen_direct', 'youtube'] as const;
export type VideoDeliveryStrategy = (typeof VIDEO_DELIVERY_STRATEGIES)[number];
export const DEFAULT_VIDEO_DELIVERY: VideoDeliveryStrategy = 'videogen_direct';
export const VIDEO_DELIVERY_ENV = 'DYNAMIC_VIDEO_DELIVERY';

/**
 * Estados de entrega en `output_summary.delivery` del item `video`:
 * `pending → completed_local → [uploading_youtube →] completed`, más las
 * esperas reanudables `blocked_auth` / `blocked_quota`.
 */
export const VIDEO_DELIVERY_STATES = [
  'pending',
  'completed_local',
  'uploading_youtube',
  'completed',
  'blocked_auth',
  'blocked_quota',
] as const;
export type VideoDeliveryState = (typeof VIDEO_DELIVERY_STATES)[number];

export type VideoDeliveryNext = 'poll_videogen' | 'publish_youtube' | 'done' | 'wait_auth' | 'wait_quota';

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
    if (state === 'uploading_youtube' || state === 'blocked_auth' || state === 'blocked_quota') {
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
      return { itemTerminal: false, next: 'publish_youtube' };
    case 'blocked_auth':
      return { itemTerminal: false, next: 'wait_auth' };
    case 'blocked_quota':
      return { itemTerminal: false, next: 'wait_quota' };
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
