/**
 * Fase 5B.1 — B1: resolución del artifact final por item del Manifest
 * (spec §4). Cero regeneración: solo lee lo que 5A ya completó.
 *
 * Reglas vinculantes:
 * - El join es SIEMPRE por `item_run_id`, nunca por `storage_path` ni por
 *   `manifest_item_key` — el patrón exacto que ya usa el scheduler
 *   (`scheduler.service.ts:833-845`).
 * - Precondición dura: el run (`production_jobs`) debe existir, tener
 *   `execution_mode='dynamic_generation'` y estar completado
 *   (`worker_status`/`status` = 'completed'). Si no, `PackagingNotReadyError`.
 * - TODOS los items del Manifest deben tener un item run `completed` con
 *   el/los artifact(s) del tipo esperado para su rol. Si falta cualquiera,
 *   `PackagingNotReadyError(missing[])` con la lista completa (nunca se
 *   corta en el primer faltante — "falla fuerte y visible", CLAUDE.md).
 * - Nunca se empaqueta un placeholder: la ausencia de un artifact requerido
 *   es un error, no un plan parcial.
 */

import type { ManifestItemType, GenerationManifestV1 } from '../generation-manifests/generation-manifest-builder';
import type { ResolvedArtifact } from './packaging-types';
import { PackagingNotReadyError } from './packaging-types';
import type { ArtifactsService } from '../artifacts/artifacts.service';
import {
  VideoDeliveryStrategy,
  checkYoutubeDeliveryUrl,
  frozenVideoDeliveryOf,
} from '../dynamic-generation/dynamic-video-delivery';

/** Mínima interfaz de acceso a datos que necesita el resolver — un QueryRunner o DataSource de TypeORM cumplen esto, y también un pg.Pool/Client. */
export interface QueryExecutor {
  query(sql: string, params?: any[]): Promise<any[]>;
}

const ARTIFACT_TYPES_BY_ITEM_TYPE: Partial<Record<ManifestItemType, ResolvedArtifact['type'][]>> = {
  content: ['dynamic_content_md'],
  scorm: ['dynamic_scorm_html', 'dynamic_scorm_manifest'],
  exam: ['dynamic_exam_gift'],
  video: ['dynamic_video'],
};

/**
 * rulesVersion 2 (spec v2 §3, contrato R2 punto 6): roles obligatorios por
 * tipo. `content` exige además el Context Package congelado
 * (`dynamic_context_package_json`, el ejecutor v2 siempre lo sube; es
 * auditoría, no se empaqueta). El orden importa: el primero es el artifact
 * principal del item.
 *
 * `dynamic_context_summary_json` es OPCIONAL (su ausencia = marca
 * `contextSummary:'missing'` en output_summary): nunca se exige ni entra en
 * la resolución (ni, por lo tanto, en la clave de reuse del .mbz).
 */
const ARTIFACT_TYPES_BY_ITEM_TYPE_V2: Partial<Record<ManifestItemType, ResolvedArtifact['type'][]>> = {
  ...ARTIFACT_TYPES_BY_ITEM_TYPE,
  content: ['dynamic_content_md', 'dynamic_context_package_json'],
  course_plan: ['dynamic_course_plan_json'],
  course_intro: ['dynamic_course_intro_md'],
  module_intro: ['dynamic_module_intro_md'],
};

export const OPTIONAL_ARTIFACT_TYPES_V2 = ['dynamic_context_summary_json'] as const;

/** Roles obligatorios de un tipo de item según el rulesVersion del Manifest (v1: exactamente los de 5B.1). */
export function requiredArtifactTypes(rulesVersion: number, type: ManifestItemType): ResolvedArtifact['type'][] | undefined {
  return (rulesVersion === 2 ? ARTIFACT_TYPES_BY_ITEM_TYPE_V2 : ARTIFACT_TYPES_BY_ITEM_TYPE)[type];
}

interface ItemRunRow {
  item_key: string;
  item_run_id: string;
  gir_status: string;
  gir_type: ManifestItemType;
  artifact_id: string | null;
  artifact_type: ResolvedArtifact['type'] | null;
  storage_bucket: string | null;
  storage_path: string | null;
  mime_type: string | null;
  artifact_status: string | null;
}

/**
 * Resuelve, para un run 5A completado, el (los) artifact(s) final(es) de
 * CADA item del Manifest. Lanza `PackagingNotReadyError` con la lista
 * completa de lo que falta si el run no está listo para empaquetar.
 */
export async function resolveRunArtifacts(
  q: QueryExecutor,
  runId: string,
  manifest: GenerationManifestV1,
): Promise<Map<string, ResolvedArtifact[]>> {
  // 1) Precondición del run: existe, es un run dynamic_generation, y está
  // completado. `worker_status` es el campo que el resto del código de
  // Fase 5A usa como marca terminal (`runs.service.ts:362`); se acepta
  // también `status='completed'` por si algún camino histórico solo
  // escribió ese campo, sin depender de que ambos coincidan siempre.
  const jobRows = await q.query(
    `select id, execution_mode, worker_status, status
       from public.production_jobs
      where id = $1`,
    [runId],
  );
  const job = jobRows[0];
  if (!job) {
    throw new PackagingNotReadyError(
      [`run:${runId}:not_found`],
      `Empaquetado no listo: el run ${runId} no existe en production_jobs.`,
    );
  }
  if (job.execution_mode !== 'dynamic_generation') {
    throw new PackagingNotReadyError(
      [`run:${runId}:wrong_execution_mode=${job.execution_mode}`],
      `Empaquetado no listo: el run ${runId} no es un run dynamic_generation (execution_mode=${job.execution_mode}).`,
    );
  }
  const runCompleted = job.worker_status === 'completed' || job.status === 'completed';
  if (!runCompleted) {
    throw new PackagingNotReadyError(
      [`run:${runId}:not_completed:worker_status=${job.worker_status},status=${job.status}`],
      `Empaquetado no listo: el run ${runId} todavía no terminó (worker_status=${job.worker_status}, status=${job.status}).`,
    );
  }

  // 2) Todos los item runs de generation=1 de este run, con su(s)
  // artifact(s) enlazado(s) por item_run_id (LEFT JOIN: un item sin
  // artifact todavía aparece, para poder reportarlo como faltante).
  const rows: ItemRunRow[] = await q.query(
    `select gir.item_key       as item_key,
            gir.id              as item_run_id,
            gir.status          as gir_status,
            gir.type            as gir_type,
            a.id                as artifact_id,
            a.type              as artifact_type,
            a.storage_bucket    as storage_bucket,
            a.storage_path      as storage_path,
            a.mime_type         as mime_type,
            a.status            as artifact_status
       from public.generation_item_runs gir
       -- Fase 8: un artifact 'disabled' (SOFT_DISABLE) nunca se empaqueta; su
       -- ausencia cuenta como faltante. 'stale' sí (STALE_NO_AUTO, con aviso).
       left join public.artifacts a on a.item_run_id = gir.id and a.status is distinct from 'disabled'
      where gir.job_id = $1 and gir.generation = 1`,
    [runId],
  );

  const rowsByItemKey = new Map<string, ItemRunRow[]>();
  for (const r of rows) {
    const list = rowsByItemKey.get(r.item_key) ?? [];
    list.push(r);
    rowsByItemKey.set(r.item_key, list);
  }

  const missing: string[] = [];
  const resolved = new Map<string, ResolvedArtifact[]>();

  for (const item of manifest.items) {
    const itemRows = rowsByItemKey.get(item.key);
    if (!itemRows || itemRows.length === 0) {
      missing.push(`${item.key}:missing_item_run`);
      continue;
    }
    // Una fila por item_key+generation (uq gir_item_generation_key), así
    // que todas las filas devueltas para este item_key comparten status e
    // item_run_id; basta con la primera para leerlos.
    const status = itemRows[0].gir_status;
    if (status !== 'completed') {
      missing.push(`${item.key}:status=${status}`);
      continue;
    }

    const expectedTypes = requiredArtifactTypes(manifest.rulesVersion, item.type);
    if (!expectedTypes) {
      missing.push(`${item.key}:unknown_item_type=${item.type}`);
      continue;
    }
    const found: ResolvedArtifact[] = [];
    for (const expectedType of expectedTypes) {
      const match = itemRows.find((r) => r.artifact_type === expectedType && r.artifact_id);
      if (!match) {
        missing.push(`${item.key}:${expectedType}:missing_artifact`);
        continue;
      }
      found.push({
        itemKey: item.key,
        itemRunId: match.item_run_id,
        artifactId: match.artifact_id as string,
        type: expectedType,
        storageBucket: match.storage_bucket ?? '',
        storagePath: match.storage_path ?? '',
        mimeType: match.mime_type ?? null,
        // Fase 8: solo presente cuando el artifact está 'stale' (STALE_NO_AUTO);
        // un artifact vigente queda idéntico a 5B.1.
        ...(match.artifact_status === 'stale' ? { status: 'stale' as const } : {}),
      });
    }
    if (found.length === expectedTypes.length) {
      resolved.set(item.key, found);
    }
  }

  if (missing.length > 0) {
    throw new PackagingNotReadyError(missing);
  }

  return resolved;
}

/**
 * Timeout (ms) de cada descarga individual de artifact en `loadArtifactText`
 * — I3 (integral-review): sin esto, una descarga colgada dejaba el job
 * `running` para siempre (el heartbeat seguía extendiendo la lease mientras
 * el `fetch` nunca resolvía). Configurable por env para poder ajustarlo en
 * staging sin tocar código.
 */
export function artifactDownloadTimeoutMs(): number {
  const raw = Number(process.env.DYNAMIC_PACKAGE_ARTIFACT_DOWNLOAD_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 60_000;
}

/**
 * Descarga el contenido de texto de un artifact resuelto, usando
 * `ArtifactsService.getDownloadUrl` (header `apikey` ya corregido en 5A) +
 * `fetch`. Falla fuerte si el servicio no puede producir una URL firmada
 * (p.ej. si `SUPABASE_SERVICE_ROLE_KEY` no está configurada, `getDownloadUrl`
 * cae a `method: 'frontend'` sin `url` — eso es un error de configuración
 * del backend, no un caso a degradar en silencio), si la descarga falla, o si
 * tarda más de `artifactDownloadTimeoutMs()` (I3, integral-review).
 */
export async function loadArtifactText(
  artifacts: ArtifactsService,
  ownerId: string,
  a: ResolvedArtifact,
): Promise<string> {
  const download = await artifacts.getDownloadUrl(a.artifactId, ownerId);
  if (!download.url) {
    throw new Error(
      `No se pudo obtener una URL de descarga para el artifact ${a.artifactId} (item ${a.itemKey}, method=${download.method}).`,
    );
  }
  const timeoutMs = artifactDownloadTimeoutMs();
  let response: Response;
  try {
    response = await fetch(download.url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      throw new Error(
        `Timeout de ${timeoutMs}ms descargando el artifact ${a.artifactId} (item ${a.itemKey}).`,
      );
    }
    throw err;
  }
  if (!response.ok) {
    throw new Error(
      `Fallo al descargar el artifact ${a.artifactId} (item ${a.itemKey}): HTTP ${response.status} ${response.statusText}`,
    );
  }
  return response.text();
}

export interface ParsedDynamicVideo {
  url: string;
  videogenJobId: string;
  /**
   * 5B.2.A: presente SOLO para `youtube` (el builder cambia el texto de la
   * actividad). Con `videogen_direct` se omite a propósito: el objeto queda
   * idéntico al de 5B.1.
   */
  delivery?: 'youtube';
}

/**
 * 5B.2.A: estrategia de entrega congelada del run (`input_payload.videoDelivery`,
 * ausente → `videogen_direct`). Un valor desconocido lanza (nunca se asume
 * otra estrategia).
 */
export async function loadRunVideoDelivery(q: QueryExecutor, runId: string): Promise<VideoDeliveryStrategy> {
  const rows = await q.query(`select input_payload from public.production_jobs where id = $1`, [runId]);
  if (!rows[0]) {
    throw new PackagingNotReadyError(
      [`run:${runId}:not_found`],
      `Empaquetado no listo: el run ${runId} no existe en production_jobs.`,
    );
  }
  const payload = typeof rows[0].input_payload === 'string' ? JSON.parse(rows[0].input_payload) : rows[0].input_payload;
  return frozenVideoDeliveryOf(payload);
}

/** Hosts de video que NUNCA son un download real de Videogen — I4, integral-review. */
const MOCK_VIDEO_HOST_PATTERNS = [/\.local$/i, /^mock-cdn/i, /mock-cdn\./i];

function isMockVideoHost(url: string): boolean {
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  return MOCK_VIDEO_HOST_PATTERNS.some((re) => re.test(host));
}

/**
 * Parsea el JSON de un artifact `dynamic_video` (spec §4, §6). Decisión del
 * usuario (spec §12.2): NUNCA se usa una signed URL temporal del bucket
 * privado como enlace del video dentro del `.mbz` — solo la URL pública y
 * persistente de Videogen. Se rechaza cualquier URL que no sea https o que
 * tenga forma de signed URL (`token=` en la query, o el patrón de Supabase
 * Storage `/object/sign/`).
 *
 * I4 (integral-review): también se rechaza fuerte cualquier video producido
 * en modo simulado (`mode !== 'real'`, el default de staging) o cuya URL
 * apunte a un host mock/local (`*.local`, `mock-cdn*`) — nunca se empaqueta
 * un `.mbz` "exitoso" con links de video muertos.
 */
export function parseDynamicVideo(
  json: string | Record<string, any>,
  strategy: VideoDeliveryStrategy = 'videogen_direct',
): ParsedDynamicVideo {
  const data = typeof json === 'string' ? JSON.parse(json) : json;
  if (!data || typeof data !== 'object') {
    throw new Error('dynamic_video: contenido no es un objeto JSON válido.');
  }
  if (strategy === 'youtube') return parseYoutubeDynamicVideo(data);
  if (strategy !== 'videogen_direct') {
    throw new Error(`dynamic_video: estrategia de entrega desconocida: ${JSON.stringify(strategy)}`);
  }
  if (data.delivery !== undefined && data.delivery !== null && data.delivery !== 'videogen_direct') {
    throw new PackagingNotReadyError(
      [`video:${data.itemKey ?? data.chapterId ?? '?'}:delivery_mismatch`],
      `dynamic_video: el artifact declara delivery=${JSON.stringify(data.delivery)} pero el run está congelado en ` +
        `videogen_direct (videogenJobId=${data.videogenJobId ?? '?'}).`,
    );
  }
  const url = data.downloadUrl;
  const videogenJobId = data.videogenJobId;
  const mode = data.mode;
  if (typeof url !== 'string' || url.length === 0) {
    throw new Error('dynamic_video: falta downloadUrl (string) en el artifact.');
  }
  if (typeof videogenJobId !== 'string' || videogenJobId.length === 0) {
    throw new Error('dynamic_video: falta videogenJobId (string) en el artifact.');
  }
  if (mode !== 'real') {
    throw new Error(
      `dynamic_video: run con videos simulados: no empaquetable (mode=${mode ?? 'undefined'}, videogenJobId=${videogenJobId}). ` +
        `Solo se empaquetan runs con videoMode='real'.`,
    );
  }
  if (!/^https:\/\//i.test(url)) {
    throw new Error(`dynamic_video: downloadUrl debe ser https, encontrado: ${url}`);
  }
  if (url.includes('token=') || url.includes('/object/sign/')) {
    throw new Error(
      `dynamic_video: downloadUrl parece ser una signed URL temporal (contiene 'token=' o '/object/sign/'), ` +
        `prohibido dentro del .mbz por decisión del usuario (spec §12.2): ${url}`,
    );
  }
  if (isMockVideoHost(url)) {
    throw new Error(
      `dynamic_video: run con videos simulados: no empaquetable (downloadUrl apunta a un host mock/local: ${url}).`,
    );
  }
  return { url, videogenJobId };
}

/**
 * 5B.2.A — `youtube`: la URL de entrega es `youtubeUrl` del artifact
 * (`https://www.youtube.com/watch?v=<id>` o `https://youtu.be/<id>`), validada
 * (https, host de YouTube, sin firma ni parámetros extra, id coherente con
 * `youtubeVideoId`). Si falta o no valida → `PackagingNotReadyError` (409):
 * NUNCA cae a la URL de Videogen. Mantiene la regla I4 (sin videos simulados).
 */
function parseYoutubeDynamicVideo(data: Record<string, any>): ParsedDynamicVideo {
  const videogenJobId = data.videogenJobId;
  const where = `video:${data.itemKey ?? data.chapterId ?? '?'}`;
  if (typeof videogenJobId !== 'string' || videogenJobId.length === 0) {
    throw new Error('dynamic_video: falta videogenJobId (string) en el artifact.');
  }
  if (data.mode !== 'real') {
    throw new Error(
      `dynamic_video: run con videos simulados: no empaquetable (mode=${data.mode ?? 'undefined'}, videogenJobId=${videogenJobId}). ` +
        `Solo se empaquetan runs con videoMode='real'.`,
    );
  }
  if (data.delivery !== 'youtube') {
    throw new PackagingNotReadyError(
      [`${where}:delivery_mismatch`],
      `dynamic_video: el run está congelado en videoDelivery=youtube pero el artifact declara ` +
        `delivery=${JSON.stringify(data.delivery ?? null)} (videogenJobId=${videogenJobId}); no se cae a la URL de Videogen.`,
    );
  }
  const url = data.youtubeUrl;
  if (typeof url !== 'string' || url.length === 0) {
    throw new PackagingNotReadyError(
      [`${where}:missing_youtube_url`],
      `dynamic_video: falta youtubeUrl en el artifact (videogenJobId=${videogenJobId}); el video no está publicado ` +
        'en YouTube y nunca se usa la URL de Videogen como reemplazo.',
    );
  }
  const check = checkYoutubeDeliveryUrl(url);
  if (check.ok === false) {
    throw new PackagingNotReadyError([`${where}:invalid_youtube_url`], `dynamic_video: ${check.reason}`);
  }
  if (typeof data.youtubeVideoId === 'string' && data.youtubeVideoId !== check.videoId) {
    throw new PackagingNotReadyError(
      [`${where}:youtube_id_mismatch`],
      `dynamic_video: youtubeUrl (${check.videoId}) no coincide con youtubeVideoId (${data.youtubeVideoId}).`,
    );
  }
  return { url, videogenJobId, delivery: 'youtube' };
}
