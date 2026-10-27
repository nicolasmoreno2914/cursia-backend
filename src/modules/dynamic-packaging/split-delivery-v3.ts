/**
 * r74 — entrega de un curso que NO cabe en un archivo (audiolibro aparte), con recuperación por partes.
 *
 * Arma y sube, en este orden (cada paso es idempotente: un reintento reutiliza lo ya subido y validado):
 *   1. `linked` disponible (PUBLIC_MEDIA_BASE_URL): los MP3 del audiolibro por segmento (módulo) → `dynamic_media_audio`
 *      (dirección duradera de Cursia; mismo audio = mismo artifact = misma dirección en un re-empaque);
 *   2. versión AUTOCONTENIDA: principal sin MP3 (validateMbzV3) + partes de audio (validateAudiobookPartV3), cada una
 *      ≤ tamaño de parte → `dynamic_mbz_part` (o, sin `linked`, el principal autocontenido ES el `dynamic_mbz`);
 *   3. `linked`: el principal con el audiolibro en línea → `dynamic_mbz` (lo ÚLTIMO: su existencia = entrega completa).
 * Los bytes de las partes de audio y de los MP3 son determinísticos (reloj fijo): un corte a mitad de la subida se
 * reanuda sin rehacer las partes ya subidas. Ningún archivo supera `partMaxBytes` salvo el principal (tope: el
 * almacenamiento), con aviso.
 *
 * Sin dependencias de Nest ni de la base: el worker la llama con sus servicios; los harnesses, con fakes.
 */
import { createHash } from 'crypto';
import type { BuildDynamicMbzV3Input, BuildDynamicMbzV3Result, AudiobookDeliveryInputV3 } from '../../package/dynamic-mbz-builder-v3';
import type { MbzV3ValidationExpectations, MbzV3ValidationResult } from '../../package/v3/mbz-validator-v3';
import type { AudiobookPartValidation } from '../../package/v3/audiobook-part-validator';
import { AUDIO_PART_OVERHEAD_BYTES, DeliveryLimits, PACKAGE_MAIN_OVER_PART_WARN, planAudioParts } from '../../package/v3/delivery-plan';
import { concatMp3, mp3DurationSeconds } from '../../package/audio';
import { audiobookSegmentFile, audiobookSegmentKey } from '../course-shell/shell';
import { DYNAMIC_MEDIA_AUDIO_TYPE, mediaLinkUrl, newMediaKey } from '../course-media/course-media.service';
import { DYNAMIC_MBZ_BUILDER_VERSION_V3 } from '../../package/dynamic-mbz-builder-v3';
import type { AudiobookPartExpectations } from '../../package/dynamic-mbz-builder-v3';

export const DYNAMIC_MBZ_PART_TYPE = 'dynamic_mbz_part';
export const PACKAGE_DELIVERY_NOT_POSSIBLE = 'PACKAGE_DELIVERY_NOT_POSSIBLE';
export const SPLIT_DELIVERY_VERSION = 'r74-v1';

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

export interface SplitArtifactRow {
  id: string;
  type?: string;
  storagePath?: string | null;
  checksumSha256?: string | null;
  sizeBytes?: number | string | null;
  metadata?: Record<string, any> | null;
}

/** Lo que usa la entrega de los servicios (ArtifactsService lo cumple; los harnesses pasan un fake). */
export interface SplitDeliveryStore {
  findAll(ownerId: string, filters: { courseId?: string; type?: string }): Promise<SplitArtifactRow[]>;
  uploadBufferArtifact(input: {
    ownerId: string; courseId: string; jobId: string; type: string; filename: string; storagePath: string; buffer: Buffer;
    mimeType: string; upsert: false; adoptExistingOnConflict: true; replaceUnverifiedOnConflict: true; metadata: Record<string, any>;
  }): Promise<SplitArtifactRow>;
  /** Tamaño del objeto en Storage (null = no está). Opcional: sin él, el reuse confía en la fila (checksum del servidor). */
  headStorageObjectBytes?(bucket: string, storagePath: string): Promise<number | null>;
}

export interface SplitDeliveryFile {
  partNumber: number;
  role: 'main' | 'audio';
  artifactId: string;
  filename: string;
  bytes: number;
  sha256: string;
  reused: boolean;
}

export interface SplitDeliveryMedia {
  key: string;
  artifactId: string;
  file: string;
  url: string;
  bytes: number;
  seconds: number;
  sha256: string;
  reused: boolean;
}

export interface SplitDeliveryResult {
  /** `linked` = recomendada: UN .mbz con el audiolibro en línea; `parts` = solo la autocontenida (sin base pública). */
  mode: 'linked' | 'parts';
  /** El `dynamic_mbz` del job (el principal recomendado). */
  primary: { artifactId: string; bytes: number; sha256: string; built: BuildDynamicMbzV3Result; validation: MbzV3ValidationResult };
  selfContained: { files: SplitDeliveryFile[]; totalFiles: number };
  media: SplitDeliveryMedia[];
  warnings: string[];
  /** Resumen serializable (output_summary del job + metadata del `dynamic_mbz`). */
  summary: Record<string, any>;
}

export interface SplitDeliveryContext {
  jobId: string;
  ownerId: string;
  courseId: string;
  manifestId: number;
  runId: string;
  sourceIdsHash: string;
  /** Carpeta de Storage del run (`<owner>/dynamic/<course>/<manifest>`, o con el prefijo QA interno). */
  storagePrefix: string;
  qa: boolean;
  limits: DeliveryLimits;
  /** Base pública https para las direcciones duraderas (null = sin entrega en línea → solo autocontenida). */
  publicMediaBase: string | null;
  buildInput: BuildDynamicMbzV3Input;
  build: (input: BuildDynamicMbzV3Input) => Promise<BuildDynamicMbzV3Result>;
  validateMain: (mbz: Buffer, built: BuildDynamicMbzV3Result) => Promise<MbzV3ValidationResult>;
  validatePart: (mbz: Buffer, exp: AudiobookPartExpectations) => Promise<AudiobookPartValidation>;
  store: SplitDeliveryStore;
  /** Metadata común del `dynamic_mbz` (la arma el worker: resumen, restore, calidad…). */
  mainMetadata: (built: BuildDynamicMbzV3Result, delivery: Record<string, any>) => Record<string, any>;
  isLeaseLost?: () => boolean;
  log?: (msg: string) => void;
}

export class LeaseLostError extends Error {
  constructor() {
    super('lease_lost');
  }
}

/** Capítulos de contenido con audiolibro, en el orden del curso, con el módulo y los bytes REALES del MP3. */
export function audioChapterSizes(input: BuildDynamicMbzV3Input): Array<{ chapterId: string; moduleId: string; bytes: number }> {
  const out: Array<{ chapterId: string; moduleId: string; bytes: number }> = [];
  for (const m of input.manifest.modules ?? []) {
    for (const ch of m.chapters ?? []) {
      const mp3 = input.contents.audiobookChapters.get(ch.chapterId);
      if (mp3) out.push({ chapterId: ch.chapterId, moduleId: m.moduleId, bytes: mp3.length });
    }
  }
  return out;
}

/** Bytes de medios del curso (lo que el zip casi no comprime) + 8 MiB de XML/H5P/Libro: decide si cabe en un archivo. */
export function estimateSingleBytes(input: BuildDynamicMbzV3Input): number {
  const c = input.contents;
  let n = (c.audioWelcome?.length ?? 0) + 8 * 1024 * 1024;
  for (const b of c.audiobookChapters.values()) n += b.length;
  for (const p of c.presentations.values()) n += (p.pdf?.length ?? 0) + (p.cover?.length ?? 0);
  for (const b of c.practiceFiles?.values() ?? []) n += b.length;
  return n;
}

/** Segmentos del audiolibro (clave, archivo, capítulos, duración MEDIDA y su audio) según el plan de partes. */
export function audiobookSegmentsOf(input: BuildDynamicMbzV3Input, parts: AudiobookDeliveryInputV3['parts']): Array<{ key: string; file: string; moduleNumber: number; chapterNumbers: number[]; seconds: number; mp3: () => Buffer }> {
  const where = new Map<string, { moduleNumber: number; chapterNumber: number }>();
  for (const m of input.manifest.modules ?? []) for (const c of m.chapters ?? []) where.set(c.chapterId, { moduleNumber: m.moduleNumber, chapterNumber: c.chapterNumber });
  return parts.flatMap((p) => p.segments.map((sg) => {
    const w = sg.chapterIds.map((id) => where.get(id));
    if (w.some((x) => !x)) throw new Error('MBZ_V3_INVARIANT: segmento del audiolibro con un capítulo fuera del Manifest');
    const nums = w.map((x) => (x as { chapterNumber: number }).chapterNumber);
    const moduleNumber = (w[0] as { moduleNumber: number }).moduleNumber;
    const bufs = sg.chapterIds.map((id) => input.contents.audiobookChapters.get(id) as Buffer);
    return {
      key: audiobookSegmentKey(moduleNumber, nums[0]),
      file: audiobookSegmentFile(moduleNumber, nums[0], nums[nums.length - 1]),
      moduleNumber,
      chapterNumbers: nums,
      seconds: bufs.reduce((t, b) => t + mp3DurationSeconds(b), 0),
      mp3: () => concatMp3(bufs),
    };
  }));
}

export async function deliverSplitV3(ctx: SplitDeliveryContext): Promise<SplitDeliveryResult> {
  const log = ctx.log ?? (() => undefined);
  const lease = () => {
    if (ctx.isLeaseLost?.()) throw new LeaseLostError();
  };
  const warnings: string[] = [];
  const plan = planAudioParts(audioChapterSizes(ctx.buildInput), ctx.limits);
  if (plan.ok === false) throw new Error(`${PACKAGE_DELIVERY_NOT_POSSIBLE}: ${plan.reason}: ${plan.detail}`);
  const parts: AudiobookDeliveryInputV3['parts'] = plan.parts.map((p) => ({ partNumber: p.partNumber, segments: p.segments.map((s) => ({ chapterIds: [...s.chapterIds] })) }));
  const planSha = sha256(Buffer.from(JSON.stringify(parts)));
  const existingOf = async (type: string): Promise<SplitArtifactRow[]> => (await ctx.store.findAll(ctx.ownerId, { courseId: ctx.courseId, type })).filter((a) => a.metadata?.runId === ctx.runId);
  const stillThere = async (row: SplitArtifactRow, bytes: number): Promise<boolean> => {
    if (!ctx.store.headStorageObjectBytes || !row.storagePath) return true;
    const size = await ctx.store.headStorageObjectBytes('cursia-artifacts', row.storagePath).catch(() => null);
    return size === bytes;
  };
  /** Sube (o reutiliza) un objeto: ruta con su sha256 → mismo contenido = misma ruta = misma fila (sin re-subir). */
  const putByContent = async (type: string, dir: string, filename: string, buffer: Buffer, mimeType: string, metadata: Record<string, any>): Promise<{ row: SplitArtifactRow; sha: string; reused: boolean }> => {
    const sha = sha256(buffer);
    const storagePath = `${ctx.storagePrefix}/${dir}/${ctx.runId}/${sha.slice(0, 16)}/${filename}`;
    const prev = (await existingOf(type)).find((a) => a.storagePath === storagePath && a.checksumSha256 === sha);
    if (prev && (await stillThere(prev, buffer.length))) return { row: prev, sha, reused: true };
    lease();
    const row = await ctx.store.uploadBufferArtifact({
      ownerId: ctx.ownerId, courseId: ctx.courseId, jobId: ctx.jobId, type, filename, storagePath, buffer, mimeType,
      upsert: false, adoptExistingOnConflict: true, replaceUnverifiedOnConflict: true,
      metadata: { runId: ctx.runId, manifestId: ctx.manifestId, sourceIdsHash: ctx.sourceIdsHash, deliveryPlanSha256: planSha, sha256: sha, bytes: buffer.length, ...metadata },
    });
    return { row, sha, reused: false };
  };
  /** Principal (reloj del job, no determinístico): se reutiliza por clave si ya está subido y validado. */
  const findMain = async (variant: string, builderVersion: string): Promise<SplitArtifactRow | null> => {
    for (const a of await existingOf(DYNAMIC_MBZ_PART_TYPE)) {
      const m = a.metadata ?? {};
      if (m.role === 'main' && m.variant === variant && m.sourceIdsHash === ctx.sourceIdsHash && m.deliveryPlanSha256 === planSha && m.builderVersion === builderVersion &&
        m.validatedSha256 && m.validatedSha256 === a.checksumSha256 && (await stillThere(a, Number(a.sizeBytes ?? m.bytes)))) return a;
    }
    return null;
  };
  const builderVersion = DYNAMIC_MBZ_BUILDER_VERSION_V3;
  const fail = (what: string, v: { issues: Array<{ code: string; where: string; message: string }> }) =>
    new Error(`MBZ_V3_VALIDATION_FAILED (${what}): ${v.issues.slice(0, 8).map((i) => `${i.code} ${i.where}: ${i.message}`).join(' | ')}`);

  // ── 1. Audiolibro EN LÍNEA: MP3 por módulo con dirección duradera ───────
  const media: SplitDeliveryMedia[] = [];
  const links: Record<string, string> = {};
  if (ctx.publicMediaBase) {
    for (const sg of audiobookSegmentsOf(ctx.buildInput, parts)) {
      const mp3 = sg.mp3();
      const put = await putByContent(DYNAMIC_MEDIA_AUDIO_TYPE, 'media', sg.file, mp3, 'audio/mpeg', {
        mediaKey: newMediaKey(), retention: 'course_media', segmentKey: sg.key, moduleNumber: sg.moduleNumber, chapterNumbers: sg.chapterNumbers, seconds: sg.seconds,
      });
      const key = String(put.row.metadata?.mediaKey ?? '');
      const url = mediaLinkUrl(ctx.publicMediaBase, put.row.id, key, sg.file);
      links[sg.key] = url;
      media.push({ key: sg.key, artifactId: put.row.id, file: sg.file, url, bytes: mp3.length, seconds: sg.seconds, sha256: put.sha, reused: put.reused });
      log(`audiolibro en línea ${sg.key}: ${put.reused ? 'reutilizado' : 'subido'} ${put.row.id} (${mp3.length} B)`);
    }
  }

  // ── 2. Versión AUTOCONTENIDA (todos los medios dentro de Moodle) ─────────
  //  a) UN archivo (el .mbz de siempre, audiolibro embebido) si cabe en el almacenamiento;
  //  b) si no: principal sin MP3 + partes de audio que se combinan en el mismo curso.
  const files: SplitDeliveryFile[] = [];
  let selfPrimary: { built: BuildDynamicMbzV3Result; validation: MbzV3ValidationResult } | null = null;
  let totalFiles = 1;
  const trySingle = estimateSingleBytes(ctx.buildInput) <= ctx.limits.storageMaxBytes;
  let singleDone = false;
  if (trySingle) {
    lease();
    const prev = ctx.publicMediaBase ? await findMain('single', builderVersion) : null;
    if (prev) {
      files.push({ partNumber: 1, role: 'main', artifactId: prev.id, filename: 'curso-completo.mbz', bytes: Number(prev.sizeBytes ?? prev.metadata?.bytes), sha256: String(prev.checksumSha256), reused: true });
      singleDone = true;
    } else {
      const built = await ctx.build({ ...ctx.buildInput, audiobookDelivery: null });
      if (built.mbz.length <= ctx.limits.storageMaxBytes) {
        const v = await ctx.validateMain(built.mbz, built);
        if (!v.ok) throw fail('autocontenido', v);
        if (ctx.publicMediaBase) {
          const put = await putByContent(DYNAMIC_MBZ_PART_TYPE, 'dynamic_mbz_part', 'curso-completo.mbz', built.mbz, 'application/vnd.moodle.backup', {
            role: 'main', variant: 'single', partNumber: 1, totalFiles: 1, validatedSha256: sha256(built.mbz), builderVersion: built.summary.builderVersion,
          });
          files.push({ partNumber: 1, role: 'main', artifactId: put.row.id, filename: 'curso-completo.mbz', bytes: built.mbz.length, sha256: put.sha, reused: put.reused });
        } else {
          selfPrimary = { built, validation: v };
          files.push({ partNumber: 1, role: 'main', artifactId: '(dynamic_mbz)', filename: 'curso-completo.mbz', bytes: built.mbz.length, sha256: sha256(built.mbz), reused: false });
        }
        singleDone = true;
      } else {
        log(`autocontenido en un archivo: ${built.mbz.length} B > ${ctx.limits.storageMaxBytes} B → por partes`);
      }
    }
  }
  if (!singleDone) {
    lease();
    const scBuilt = await ctx.build({ ...ctx.buildInput, audiobookDelivery: { mode: 'parts', parts } });
    const scValidation = await ctx.validateMain(scBuilt.mbz, scBuilt);
    if (!scValidation.ok) throw fail('autocontenido por partes', scValidation);
    if (scBuilt.mbz.length > ctx.limits.storageMaxBytes) throw new Error(`${PACKAGE_DELIVERY_NOT_POSSIBLE}: main_over_storage: el principal sin audiolibro pesa ${scBuilt.mbz.length} B (almacenamiento ${ctx.limits.storageMaxBytes} B)`);
    if (scBuilt.mbz.length > ctx.limits.partMaxBytes) warnings.push(`${PACKAGE_MAIN_OVER_PART_WARN}:${scBuilt.mbz.length}:${ctx.limits.partMaxBytes}`);
    const audioParts = scBuilt.audiobookParts ?? [];
    if (!audioParts.length) throw new Error('MBZ_V3_INVARIANT: entrega aparte sin partes de audio');
    totalFiles = 1 + audioParts.length;
    for (const p of audioParts) {
      lease();
      const { mbz, expect } = await p.build();
      const v = await ctx.validatePart(mbz, expect);
      if (!v.ok) throw fail(`parte ${p.partNumber}`, v);
      if (mbz.length > ctx.limits.partMaxBytes) throw new Error(`MBZ_V3_INVARIANT: la parte ${p.partNumber} pesa ${mbz.length} B > ${ctx.limits.partMaxBytes} B (reserva de XML ${AUDIO_PART_OVERHEAD_BYTES} B)`);
      const put = await putByContent(DYNAMIC_MBZ_PART_TYPE, 'dynamic_mbz_part', p.filename, mbz, 'application/vnd.moodle.backup', {
        role: 'audio', partNumber: p.partNumber, totalFiles, validatedSha256: sha256(mbz), segments: p.segments,
      });
      files.push({ partNumber: p.partNumber, role: 'audio', artifactId: put.row.id, filename: p.filename, bytes: mbz.length, sha256: put.sha, reused: put.reused });
      log(`parte ${p.partNumber}/${totalFiles}: ${put.reused ? 'reutilizada' : 'subida'} ${put.row.id} (${mbz.length} B)`);
    }
    const scFilename = `parte-1-de-${totalFiles}.mbz`;
    if (ctx.publicMediaBase) {
      const prev = await findMain('parts', builderVersion);
      if (prev) files.unshift({ partNumber: 1, role: 'main', artifactId: prev.id, filename: scFilename, bytes: Number(prev.sizeBytes ?? prev.metadata?.bytes), sha256: String(prev.checksumSha256), reused: true });
      else {
        const put = await putByContent(DYNAMIC_MBZ_PART_TYPE, 'dynamic_mbz_part', scFilename, scBuilt.mbz, 'application/vnd.moodle.backup', {
          role: 'main', variant: 'parts', partNumber: 1, totalFiles, validatedSha256: sha256(scBuilt.mbz), builderVersion: scBuilt.summary.builderVersion,
        });
        files.unshift({ partNumber: 1, role: 'main', artifactId: put.row.id, filename: scFilename, bytes: scBuilt.mbz.length, sha256: put.sha, reused: put.reused });
      }
    } else {
      selfPrimary = { built: scBuilt, validation: scValidation };
      files.unshift({ partNumber: 1, role: 'main', artifactId: '(dynamic_mbz)', filename: scFilename, bytes: scBuilt.mbz.length, sha256: sha256(scBuilt.mbz), reused: false });
    }
  }
  const summaryOf = (mode: 'linked' | 'parts') => ({
    version: SPLIT_DELIVERY_VERSION,
    mode,
    deliveryPlanSha256: planSha,
    limits: ctx.limits,
    selfContained: { totalFiles, files: [...files].sort((a, b) => a.partNumber - b.partNumber).map(({ reused, ...f }) => f) },
    media: media.map(({ reused, ...m }) => m),
  });
  if (!ctx.publicMediaBase) {
    const sp = selfPrimary as { built: BuildDynamicMbzV3Result; validation: MbzV3ValidationResult };
    return { mode: 'parts', primary: { artifactId: '', bytes: sp.built.mbz.length, sha256: sha256(sp.built.mbz), ...sp }, selfContained: { files, totalFiles }, media, warnings, summary: summaryOf('parts') };
  }

  // ── 3. Principal RECOMENDADO: UN .mbz con el audiolibro en línea (lo último) ──
  lease();
  const linkedBuilt = await ctx.build({ ...ctx.buildInput, audiobookDelivery: { mode: 'linked', parts, links } });
  const linkedValidation = await ctx.validateMain(linkedBuilt.mbz, linkedBuilt);
  if (!linkedValidation.ok) throw fail('en línea', linkedValidation);
  if (linkedBuilt.mbz.length > ctx.limits.storageMaxBytes) throw new Error(`${PACKAGE_DELIVERY_NOT_POSSIBLE}: main_over_storage: ${linkedBuilt.mbz.length} B`);
  if (linkedBuilt.mbz.length > ctx.limits.partMaxBytes) warnings.push(`${PACKAGE_MAIN_OVER_PART_WARN}:${linkedBuilt.mbz.length}:${ctx.limits.partMaxBytes}`);
  return {
    mode: 'linked',
    primary: { artifactId: '', bytes: linkedBuilt.mbz.length, sha256: sha256(linkedBuilt.mbz), built: linkedBuilt, validation: linkedValidation },
    selfContained: { files, totalFiles },
    media,
    warnings,
    summary: summaryOf('linked'),
  };
}
