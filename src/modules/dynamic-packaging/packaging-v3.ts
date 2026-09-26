/**
 * Cursia V2.1 — R12: empaque de runs rulesVersion 3 — resolución de
 * artifacts, perfiles vigentes, tema, clave de reuse y carga de contenidos.
 *
 * El v1/v2 (`artifact-resolver.resolveRunArtifacts`, `packaging-plan`) NO
 * cambia y sigue rechazando v3. Esto es su camino paralelo.
 *
 *  - `resolveRunArtifactsV3`: misma selección que v1/v2 (join por
 *    item_run_id, generación completed vigente, 'disabled' nunca, 'stale' con
 *    aviso) + roles v3 por `variant` + metadata del artifact (guarda de mocks)
 *    + output_summary (sha del contenido validado, review G5 M7).
 *  - `loadPackagingProfilesV3`: perfil de evaluación y de presentación
 *    VIGENTES (última versión de `course_profiles`, o el default). El tema de
 *    un curso sin perfil (F1/I4): derivado de la paleta guardada con el curso
 *    (`metadata.paletteId`/`pal.id`) para TODO curso; si no hay, el default v3
 *    aula-clara/light con el aviso `presentation_profile_defaulted`.
 *  - `packageReuseHashV3`: builder v3 + sha del Manifest + ids de artifacts
 *    + sha del tema + sha del perfil de evaluación + versión del perfil H5P +
 *    versión del renderer + versión de Moodle. Cambiar el tema o la nota
 *    mínima = paquete nuevo SIN generar nada nuevo.
 *  - `loadContentsV3`: descarga y valida cada contenido; los artifacts de
 *    proveedor SIMULADOS (run congelado en mock) se materializan con medios
 *    sintéticos (`package/v3/synthetic-media`), nunca en un run real.
 */
import { createHash } from 'crypto';
import type { GenerationManifestV1, ManifestItemType } from '../generation-manifests/generation-manifest-builder';
import { effectiveOutputRowsSql } from '../dynamic-generation/item-generations';
import { PackagingNotReadyError } from './packaging-types';
import type { QueryExecutor } from './artifact-resolver';
import { artifactDownloadTimeoutMs, parseDynamicVideo, requiredArtifactTypesV3 } from './artifact-resolver';
import type { ArtifactsService } from '../artifacts/artifacts.service';
import { frozenVideoDeliveryOf, checkYoutubeDeliveryUrl } from '../dynamic-generation/dynamic-video-delivery';
import { GuardArtifact, MockArtifactInRealRunError, assertNoMockArtifactsForRealPackage } from './packaging-guards';
import { frozenProviderModesOf, providerKindOfArtifactType } from '../dynamic-generation/provider-modes';
import { assertSafeStoragePath } from '../artifacts/artifacts.service';
import { ResolvedAssessment, assertCategoriesPopulated, assessmentItemCountsFromManifest } from '../../package/assessment';
import {
  AssessmentProfile,
  PresentationProfile,
  defaultAssessmentProfile,
  defaultPresentationProfile,
  normalizeAssessmentProfile,
  normalizePresentationProfile,
  profileSha256,
} from '../course-profiles/course-profiles';
import {
  LEGACY_PALETTES,
  PresentationProfileInput,
  presentationProfileFromPaletteId,
  resolveTheme,
  themeSha256,
} from '../theme-engine';
import { PackagingPlanV3 } from './packaging-plan-v3';
import type { DynamicPackageContentsV3, ActivityContentV3 } from '../../package/dynamic-mbz-builder-v3';
import {
  AssessmentPackageSummary,
  DYNAMIC_MBZ_BUILDER_VERSION_V3,
  VC_RENDERER_VERSION,
  assessmentPackageSummary,
  assessmentPackageWarnings,
} from '../../package/dynamic-mbz-builder-v3';
import { h5pProfileVersion } from '../../package/h5p';
import { resolveAssessment } from '../../package/assessment';
import { syntheticCoverPng, syntheticMp3, syntheticPdf } from '../../package/v3/synthetic-media';
import { themeMismatch, validatePresentationArtifact } from '../../package/presentation';
import { pdfPageCount } from '../../package/presentation';

export const PACKAGING_V3 = 'PACKAGING_V3';
export const V3_VIDEO_REQUIRES_YOUTUBE = 'v3_video_requires_youtube';

export interface ResolvedArtifactV3 {
  itemKey: string;
  itemType: ManifestItemType;
  itemRunId: string;
  artifactId: string;
  type: string;
  storageBucket: string;
  storagePath: string;
  mimeType: string | null;
  metadata: Record<string, any>;
  status?: 'stale';
}

export interface ResolvedItemV3 {
  itemKey: string;
  type: ManifestItemType;
  artifacts: ResolvedArtifactV3[];
  outputSummary: Record<string, any>;
}

function parseJson(v: any): any {
  if (typeof v === 'string') {
    try {
      return JSON.parse(v);
    } catch {
      return {};
    }
  }
  return v ?? {};
}

/** Resuelve los artifacts de TODOS los items de un run v3 completado. Lanza PackagingNotReadyError con la lista completa de faltantes. */
export async function resolveRunArtifactsV3(q: QueryExecutor, runId: string, manifest: GenerationManifestV1): Promise<Map<string, ResolvedItemV3>> {
  if (manifest?.rulesVersion !== 3) throw new Error(`${PACKAGING_V3}: resolveRunArtifactsV3 exige un Manifest rulesVersion 3`);
  const [job] = await q.query(`select id, execution_mode, worker_status, status from public.production_jobs where id = $1`, [runId]);
  if (!job) throw new PackagingNotReadyError([`run:${runId}:not_found`], `Empaquetado no listo: el run ${runId} no existe.`);
  if (job.execution_mode !== 'dynamic_generation') {
    throw new PackagingNotReadyError([`run:${runId}:wrong_execution_mode=${job.execution_mode}`]);
  }
  if (job.worker_status !== 'completed' && job.status !== 'completed') {
    throw new PackagingNotReadyError([`run:${runId}:not_completed:worker_status=${job.worker_status},status=${job.status}`]);
  }
  const rows: any[] = await q.query(
    `select gir.item_key as item_key, gir.id as item_run_id, gir.status as gir_status, gir.type as gir_type,
            gir.output_summary as output_summary,
            a.id as artifact_id, a.type as artifact_type, a.storage_bucket as storage_bucket,
            a.storage_path as storage_path, a.mime_type as mime_type, a.status as artifact_status, a.metadata as metadata
       from ${effectiveOutputRowsSql('$1')} gir
       left join public.artifacts a on a.item_run_id = gir.id and a.status is distinct from 'disabled'
      where gir.job_id = $1`,
    [runId],
  );
  const byKey = new Map<string, any[]>();
  for (const r of rows) {
    const l = byKey.get(r.item_key) ?? [];
    l.push(r);
    byKey.set(r.item_key, l);
  }
  const missing: string[] = [];
  const out = new Map<string, ResolvedItemV3>();
  for (const item of manifest.items) {
    const list = byKey.get(item.key);
    if (!list?.length) {
      missing.push(`${item.key}:missing_item_run`);
      continue;
    }
    if (list[0].gir_status !== 'completed') {
      missing.push(`${item.key}:status=${list[0].gir_status}`);
      continue;
    }
    const roles = requiredArtifactTypesV3(item.type, item.variant);
    if (!roles) {
      missing.push(`${item.key}:unknown_item_type=${item.type}`);
      continue;
    }
    const arts: ResolvedArtifactV3[] = [];
    for (const role of roles) {
      const matches = list.filter((r) => r.artifact_type === role && r.artifact_id);
      if (matches.length === 0) {
        missing.push(`${item.key}:${role}:missing_artifact`);
        continue;
      }
      if (matches.length > 1) {
        missing.push(`${item.key}:${role}:ambiguous_artifacts=${matches.length}`);
        continue;
      }
      const m = matches[0];
      arts.push({
        itemKey: item.key,
        itemType: item.type,
        itemRunId: m.item_run_id,
        artifactId: m.artifact_id,
        type: role,
        storageBucket: m.storage_bucket ?? '',
        storagePath: m.storage_path ?? '',
        mimeType: m.mime_type ?? null,
        metadata: parseJson(m.metadata),
        ...(m.artifact_status === 'stale' ? { status: 'stale' as const } : {}),
      });
    }
    if (arts.length === roles.length) out.set(item.key, { itemKey: item.key, type: item.type, artifacts: arts, outputSummary: parseJson(list[0].output_summary) });
  }
  if (missing.length) throw new PackagingNotReadyError(missing);
  return out;
}

export function allArtifactsV3(byItem: Map<string, ResolvedItemV3>): ResolvedArtifactV3[] {
  return [...byItem.values()].flatMap((i) => i.artifacts);
}

export function sortedArtifactIdsV3(byItem: Map<string, ResolvedItemV3>): string[] {
  return [...new Set(allArtifactsV3(byItem).map((a) => a.artifactId))].sort();
}

/**
 * Fix round 1 (review G6 I1): ÚNICA definición de "este artifact es simulado".
 * Cualquier señal alcanza: `metadata.mock`/`metadata.fixture` del artifact, o
 * `mock`/`fixture` = true o `mode: 'mock'` en el CUERPO (JSON) ya descargado.
 * La usan la guarda previa a la carga (solo metadata, lo único que hay antes
 * de descargar) y el cargador después de parsear cada cuerpo de proveedor.
 */
export function isMockSignaled(a: { metadata?: Record<string, any> | null }, payload?: any): boolean {
  const m = a?.metadata;
  if (m && (m.mock === true || m.fixture === true || m.mode === 'mock')) return true;
  return !!payload && typeof payload === 'object' && (payload.mock === true || payload.fixture === true || payload.mode === 'mock');
}

/** ¿El run está congelado en mock para el proveedor de este tipo de artifact? */
export function runAllowsMockFor(run: { input_payload?: any } | null | undefined, artifactType: string): boolean {
  const kind = providerKindOfArtifactType(artifactType);
  const modes = frozenProviderModesOf(run?.input_payload);
  return !!kind && !!modes && modes[kind] === 'mock';
}

/** Falla fuerte (MOCK_ARTIFACT_IN_REAL_RUN) si el artifact (metadata o cuerpo) es simulado y el run no está congelado en mock para su proveedor. */
export function assertArtifactMockAllowed(run: { id?: string; input_payload?: any }, a: ResolvedArtifactV3, payload?: any): boolean {
  if (!isMockSignaled(a, payload)) return false;
  if (!runAllowsMockFor(run, a.type)) throw new MockArtifactInRealRunError([`${a.itemKey}:${a.type}:${a.artifactId}`], run?.id);
  return true;
}

/** Guarda R-007 sobre el run + todos sus artifacts resueltos, ANTES de descargar nada (lanza MOCK_ARTIFACT_IN_REAL_RUN). */
export function assertRunArtifactsPackageable(run: { id?: string; input_payload?: any }, byItem: Map<string, ResolvedItemV3>): void {
  const arts: GuardArtifact[] = allArtifactsV3(byItem).map((a) => ({ id: a.artifactId, type: a.type, metadata: a.metadata, itemKey: a.itemKey }));
  assertNoMockArtifactsForRealPackage(run, arts);
  // Misma regla con el predicado único (cubre además metadata.mode='mock').
  const bad = allArtifactsV3(byItem)
    .filter((a) => isMockSignaled(a) && !runAllowsMockFor(run, a.type))
    .map((a) => `${a.itemKey}:${a.type}:${a.artifactId}`);
  if (bad.length) throw new MockArtifactInRealRunError(bad.sort(), run?.id);
}

export interface V3StaleWarning {
  code: 'stale_artifact';
  itemKey: string;
  artifactId: string;
  type: string;
  message: string;
}

export function staleWarningsV3(byItem: Map<string, ResolvedItemV3>): V3StaleWarning[] {
  return allArtifactsV3(byItem)
    .filter((a) => a.status === 'stale')
    .map((a) => ({
      code: 'stale_artifact' as const,
      itemKey: a.itemKey,
      artifactId: a.artifactId,
      type: a.type,
      message: `El artifact ${a.type} de ${a.itemKey} quedó desactualizado y se empaquetó igual (no se regenera solo: revisalo o pedí regenerarlo).`,
    }))
    .sort((x, y) => (x.itemKey + x.type + x.artifactId < y.itemKey + y.type + y.artifactId ? -1 : 1));
}

// ─── Perfiles y tema ───────────────────────────────────────────────────────

export type PresentationSource = 'profile' | 'palette' | 'default_v3';

/** F1 (I4): aviso del paquete cuando el tema cae al default aula-clara/light (sin perfil ni paleta). */
export const PRESENTATION_PROFILE_DEFAULTED = 'presentation_profile_defaulted';

export interface ResolvedPackagingTheme {
  input: PresentationProfileInput;
  source: PresentationSource;
}

/**
 * Tema del paquete: el perfil de presentación vigente; sin perfil (F1/I4), el
 * derivado de la paleta guardada con el curso para CUALQUIER curso
 * (`presentationProfileFromPaletteId`: claro → aula-clara/light, el resto →
 * oscuro-premium/dark, brandSeed de la paleta); si no hay paleta, el default
 * v3 (aula-clara/light) — el llamador registra `presentation_profile_defaulted`.
 * Una paleta desconocida falla fuerte (R1). `v2Migrated` ya no cambia nada
 * (se acepta por compatibilidad).
 */
export function resolvePackagingTheme(p: {
  presentationProfile: PresentationProfile | null;
  v2Migrated?: boolean;
  legacyPaletteId?: string | null;
}): ResolvedPackagingTheme {
  if (p.presentationProfile) {
    const pp = p.presentationProfile;
    return {
      source: 'profile',
      input: {
        themeFamily: pp.themeFamily,
        mode: pp.mode,
        ...(pp.brandSeed ? { brandSeed: { ...pp.brandSeed } } : {}),
        themeVersion: pp.themeVersion,
      } as PresentationProfileInput,
    };
  }
  if (typeof p.legacyPaletteId === 'string' && p.legacyPaletteId.trim()) {
    return { source: 'palette', input: presentationProfileFromPaletteId(p.legacyPaletteId.trim()) as PresentationProfileInput };
  }
  const d = defaultPresentationProfile();
  return { source: 'default_v3', input: { themeFamily: d.themeFamily, mode: d.mode, themeVersion: d.themeVersion } as PresentationProfileInput };
}

export interface PackagingProfilesV3 {
  assessment: AssessmentProfile;
  assessmentVersion: number;
  assessmentSha256: string;
  theme: ResolvedPackagingTheme;
  presentationVersion: number;
  themeSha256: string;
}

/** Id de paleta legacy guardado en `courses.metadata` (`paletteId` o `pal.id`), si lo hay. */
export function legacyPaletteIdOf(metadata: any): string | null {
  const m = parseJson(metadata);
  const id = m?.paletteId ?? m?.pal?.id ?? null;
  return typeof id === 'string' && id.trim() ? id.trim() : null;
}

/**
 * Lee los perfiles VIGENTES del curso (última versión, append-only) o los
 * defaults. El perfil de evaluación se valida contra el `finalExam` CONGELADO
 * en el Manifest del run (resolveAssessment falla fuerte si no casa: R3 ruling 7).
 */
export async function loadPackagingProfilesV3(q: QueryExecutor, courseId: number, finalExam: boolean): Promise<PackagingProfilesV3> {
  const rows: any[] = await q.query(
    `select distinct on (kind) kind, version, data from public.course_profiles where course_id = $1 order by kind, version desc`,
    [courseId],
  );
  const a = rows.find((r) => r.kind === 'assessment');
  const p = rows.find((r) => r.kind === 'presentation');
  const assessment = a ? normalizeAssessmentProfile(parseJson(a.data)) : defaultAssessmentProfile({ finalExam });
  const presentation = p ? normalizePresentationProfile(parseJson(p.data)) : null;
  let legacyPaletteId: string | null = null;
  if (!presentation) {
    // F1 (I4): la paleta guardada con el curso aplica a TODO curso sin perfil (no solo a los migrados).
    const [c] = await q.query(`select metadata from public.courses where id = $1`, [courseId]);
    legacyPaletteId = legacyPaletteIdOf(c?.metadata);
    if (legacyPaletteId && !LEGACY_PALETTES.some((x) => x.id === legacyPaletteId)) {
      throw new Error(
        `THEME_INVALID: el curso #${courseId} tiene la paleta desconocida "${legacyPaletteId}"; ` +
          'guardá un perfil de presentación ("Diseño y evaluación") para empaquetarlo.',
      );
    }
  }
  const theme = resolvePackagingTheme({ presentationProfile: presentation, legacyPaletteId });
  return {
    assessment,
    assessmentVersion: a ? Number(a.version) : 0,
    assessmentSha256: profileSha256(assessment),
    theme,
    presentationVersion: p ? Number(p.version) : 0,
    themeSha256: themeSha256(resolveTheme(theme.input)),
  };
}

// ─── Clave de reuse v3 ─────────────────────────────────────────────────────

export interface PackageReuseKeyV3Input {
  builderVersion: string;
  manifestSha256: string;
  sourceArtifactIds: string[];
  themeSha256: string;
  assessmentProfileSha256: string;
  h5pProfileVersion: number;
  vcRendererVersion: string;
  moodleVersion: string;
}

export function packageReuseHashV3(k: PackageReuseKeyV3Input): string {
  const canon = JSON.stringify({
    v: 3,
    builderVersion: k.builderVersion,
    manifestSha256: k.manifestSha256,
    sourceIdsHash: createHash('sha256').update([...k.sourceArtifactIds].sort().join(','), 'utf8').digest('hex'),
    themeSha256: k.themeSha256,
    assessmentProfileSha256: k.assessmentProfileSha256,
    h5pProfileVersion: k.h5pProfileVersion,
    vcRendererVersion: k.vcRendererVersion,
    moodleVersion: k.moodleVersion,
  });
  return createHash('sha256').update(canon, 'utf8').digest('hex');
}

// ─── Contenidos ────────────────────────────────────────────────────────────

export interface ContentLoadersV3 {
  loadText(a: ResolvedArtifactV3): Promise<string>;
  loadBytes(a: ResolvedArtifactV3): Promise<Buffer>;
  /** Archivos referenciados por un artifact de presentación real (PDF/portada en Storage). */
  loadStorageBytes(bucket: string, storagePath: string): Promise<Buffer>;
}

/** Cargadores reales (ArtifactsService + fetch con timeout). Un archivo de Storage fuera de la carpeta del dueño se rechaza. */
export function artifactsServiceLoadersV3(
  artifacts: Pick<ArtifactsService, 'getDownloadUrl' | 'downloadStorageObject'>,
  ownerId: string,
): ContentLoadersV3 {
  const fetchOk = async (a: ResolvedArtifactV3): Promise<Response> => {
    const d = await artifacts.getDownloadUrl(a.artifactId, ownerId);
    if (!d.url) throw new Error(`No se pudo obtener una URL de descarga para el artifact ${a.artifactId} (item ${a.itemKey}, method=${d.method}).`);
    const timeoutMs = artifactDownloadTimeoutMs();
    let res: Response;
    try {
      res = await fetch(d.url, { signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError') throw new Error(`Timeout de ${timeoutMs}ms descargando el artifact ${a.artifactId} (item ${a.itemKey}).`);
      throw err;
    }
    if (!res.ok) throw new Error(`Fallo al descargar el artifact ${a.artifactId} (item ${a.itemKey}): HTTP ${res.status}`);
    return res;
  };
  return {
    loadText: async (a) => (await fetchOk(a)).text(),
    loadBytes: async (a) => Buffer.from(await (await fetchOk(a)).arrayBuffer()),
    loadStorageBytes: async (bucket, storagePath) => {
      const segments = assertOwnerStoragePath(ownerId, storagePath);
      return artifacts.downloadStorageObject(bucket, segments.join('/'), artifactDownloadTimeoutMs());
    },
  };
}

/**
 * Fix round 1 (review G6 I2): el path se valida y normaliza ANTES del chequeo
 * de dueño (dot-segments, `\\`, `%`-encoding, absolutos, segmentos vacíos →
 * rechazo) y el primer segmento debe ser EXACTAMENTE el ownerId.
 */
export function assertOwnerStoragePath(ownerId: string, storagePath: string): string[] {
  const segments = assertSafeStoragePath(storagePath);
  if (!ownerId || segments[0] !== ownerId) {
    throw new Error(`${PACKAGING_V3}: el archivo ${JSON.stringify(storagePath)} no pertenece al dueño del run; no se descarga`);
  }
  return segments;
}

export interface LoadedContentsV3 {
  contents: DynamicPackageContentsV3;
  warnings: string[];
  mockProviderItems: string[];
}

const MOCK_COVER = { w: 1280, h: 720, color: '#5B6B7F' };

function one(byItem: Map<string, ResolvedItemV3>, key: string, type: string): ResolvedArtifactV3 {
  const it = byItem.get(key);
  const a = it?.artifacts.find((x) => x.type === type);
  if (!a) throw new Error(`${PACKAGING_V3}: falta el artifact ${type} de ${key} (integridad rota tras resolveRunArtifactsV3)`);
  return a;
}

function sha256(s: string | Buffer): string {
  return createHash('sha256').update(s).digest('hex');
}

/**
 * Texto de un artifact validado por el servidor al completarse (R11a): si el
 * item registró `output_summary.v3Validation.contentSha256`, el texto
 * descargado DEBE ser ese mismo (review G5 M7) — nunca se empaqueta algo
 * distinto de lo que se validó.
 */
async function validatedText(L: ContentLoadersV3, byItem: Map<string, ResolvedItemV3>, key: string, type: string): Promise<string> {
  const a = one(byItem, key, type);
  const text = await L.loadText(a);
  const v = byItem.get(key)?.outputSummary?.v3Validation;
  // El sha registrado corresponde a UN artifact (el validado): solo se compara contra ése.
  const applies = !!v && (!v.artifactType || v.artifactType === type) && (!v.artifactId || v.artifactId === a.artifactId);
  const expected = applies ? v.contentSha256 : undefined;
  if (typeof expected === 'string' && expected && sha256(text) !== expected) {
    throw new Error(`${PACKAGING_V3}: el contenido de ${key} (${type}) no es el que validó el servidor (sha256 distinto)`);
  }
  return text;
}

function json(text: string, key: string): any {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`${PACKAGING_V3}: ${key} no es JSON válido (${err instanceof Error ? err.message : String(err)})`);
  }
}


export async function loadContentsV3(
  L: ContentLoadersV3,
  plan: PackagingPlanV3,
  byItem: Map<string, ResolvedItemV3>,
  run: { id?: string; input_payload?: any },
  currentTheme: { familyId: string; mode: string },
): Promise<LoadedContentsV3> {
  const warnings: string[] = [];
  const mockProviderItems: string[] = [];
  // Doble seguro (R-007): la guarda también la corre el caller antes de cargar nada.
  assertRunArtifactsPackageable(run, byItem);
  const delivery = frozenVideoDeliveryOf(run?.input_payload);

  const audio = async (key: string): Promise<Buffer> => {
    const a = one(byItem, key, 'dynamic_audio_mp3');
    const looksJson = (a.mimeType ?? '').includes('json');
    if (isMockSignaled(a) || looksJson) {
      const payload = json(await L.loadText(a), key);
      // Un cuerpo JSON en un artifact de audio SOLO es válido como fixture de un run mock (G6 I1).
      if (!assertArtifactMockAllowed(run, a, payload)) {
        throw new Error(`${PACKAGING_V3}: ${key} es JSON pero no es una fixture simulada; se esperaba un MP3`);
      }
      const secs = Number(payload.durationSeconds);
      if (!Number.isFinite(secs) || secs <= 0) throw new Error(`${PACKAGING_V3}: fixture ${key} sin durationSeconds válido (G6 M3)`);
      mockProviderItems.push(key);
      return syntheticMp3(secs);
    }
    const bytes = await L.loadBytes(a);
    // Un MP3 "real" cuyo contenido resulta ser un JSON de fixture también se detecta.
    if (bytes.length > 0 && bytes[0] === 0x7b) {
      let payload: any = null;
      try { payload = JSON.parse(bytes.toString('utf8')); } catch { payload = null; }
      if (payload) assertArtifactMockAllowed(run, a, payload);
      throw new Error(`${PACKAGING_V3}: ${key} no es un MP3 (contenido JSON)`);
    }
    return bytes;
  };

  const courseIntro = json(await validatedText(L, byItem, plan.keys.courseIntro, 'dynamic_course_intro_json'), plan.keys.courseIntro);
  const moduleIntros = new Map<string, unknown>();
  const examGift = new Map<string, string>();
  const contentMd = new Map<string, string>();
  const experiences = new Map<string, unknown>();
  const presentations = new Map<string, { pdf: Buffer; cover: Buffer; mock?: boolean }>();
  const videos = new Map<string, { youtubeId: string; durationSec: number }>();
  const videoInteractions = new Map<string, unknown>();
  const activities = new Map<string, ActivityContentV3>();
  const audiobookChapters = new Map<string, Buffer>();

  for (const m of plan.modules) {
    moduleIntros.set(m.moduleId, json(await validatedText(L, byItem, m.keys.moduleIntro, 'dynamic_module_intro_json'), m.keys.moduleIntro));
    if (m.keys.exam) examGift.set(m.moduleId, await validatedText(L, byItem, m.keys.exam, 'dynamic_exam_gift'));
    for (const ch of m.chapters) {
      contentMd.set(ch.chapterId, await validatedText(L, byItem, ch.keys.content, 'dynamic_content_md'));
      experiences.set(ch.chapterId, json(await validatedText(L, byItem, ch.keys.experience, 'dynamic_experience_json'), ch.keys.experience));

      // Presentación (R9): real = PDF + portada en Storage (sha verificado); simulada = medios sintéticos.
      const pa = one(byItem, ch.keys.presentation, 'dynamic_presentation');
      const pres = json(await L.loadText(pa), ch.keys.presentation);
      if (assertArtifactMockAllowed(run, pa, pres)) {
        const n = Number(pres.slideCount);
        if (!Number.isInteger(n) || n < 1 || n > 500) throw new Error(`${PACKAGING_V3}: fixture ${ch.keys.presentation} sin slideCount válido (G6 M3)`);
        const pdf = syntheticPdf(n);
        presentations.set(ch.chapterId, { pdf, cover: syntheticCoverPng(MOCK_COVER.w, MOCK_COVER.h, MOCK_COVER.color), mock: true });
        mockProviderItems.push(ch.keys.presentation);
      } else {
        const errs = validatePresentationArtifact(pres);
        if (errs.length) throw new Error(`${PACKAGING_V3}: ${ch.keys.presentation} inválido: ${errs.map((e) => e.code).join(', ')}`);
        if (pres.chapterId !== ch.chapterId) throw new Error(`${PACKAGING_V3}: ${ch.keys.presentation} es de otro capítulo (${pres.chapterId})`);
        assertSafeStoragePath(pres.pdf.storagePath);
        assertSafeStoragePath(pres.cover.storagePath);
        const bucket = pa.storageBucket || 'cursia-artifacts';
        const pdf = await L.loadStorageBytes(bucket, pres.pdf.storagePath);
        const cover = await L.loadStorageBytes(bucket, pres.cover.storagePath);
        if (sha256(pdf) !== pres.pdf.sha256 || sha256(cover) !== pres.cover.sha256) {
          throw new Error(`${PACKAGING_V3}: los archivos de ${ch.keys.presentation} no coinciden con su sha256 declarado`);
        }
        if (pdfPageCount(pdf) !== pres.slideCount) warnings.push(`slide_count_declared_mismatch:${ch.keys.presentation}`);
        try {
          const tm = themeMismatch(pres, currentTheme as any);
          if (tm.mismatch) warnings.push(`theme_mismatch:${ch.keys.presentation}:${tm.changed.join('+')}`);
        } catch (err) {
          warnings.push(`theme_mismatch_unknown:${ch.keys.presentation}:${err instanceof Error ? err.message.split(':')[0] : 'error'}`);
        }
        presentations.set(ch.chapterId, { pdf, cover });
      }

      if (ch.keys.video) {
        if (delivery !== 'youtube') {
          throw new PackagingNotReadyError(
            [`${ch.keys.video}:${V3_VIDEO_REQUIRES_YOUTUBE}`],
            `${V3_VIDEO_REQUIRES_YOUTUBE}: el video interactivo H5P de V2.1 necesita el video publicado en YouTube (el run está congelado en ${delivery}).`,
          );
        }
        const va = one(byItem, ch.keys.video, 'dynamic_video');
        const data = json(await L.loadText(va), ch.keys.video);
        const parsed = parseDynamicVideo(data, 'youtube');
        const check = checkYoutubeDeliveryUrl(parsed.url);
        if (check.ok === false) throw new Error(`${PACKAGING_V3}: ${ch.keys.video}: ${check.reason}`);
        const dur = Number(data.durationSec ?? va.metadata?.durationSec);
        if (!Number.isFinite(dur) || dur <= 0) {
          throw new PackagingNotReadyError([`${ch.keys.video}:VIDEO_DURATION_MISSING`], `VIDEO_DURATION_MISSING: ${ch.keys.video} no tiene la duración medida del video.`);
        }
        videos.set(ch.chapterId, { youtubeId: check.videoId, durationSec: dur });
        videoInteractions.set(
          ch.chapterId,
          json(await validatedText(L, byItem, ch.keys.videoInteractions as string, 'dynamic_video_interactions_json'), ch.keys.videoInteractions as string),
        );
      }
      if (ch.keys.activity) {
        if (ch.activityVariant === 'h5p') {
          activities.set(ch.chapterId, {
            variant: 'h5p',
            payload: json(await validatedText(L, byItem, ch.keys.activity, 'dynamic_h5p_params_json'), ch.keys.activity),
          });
        } else {
          activities.set(ch.chapterId, {
            variant: 'scorm',
            html: await validatedText(L, byItem, ch.keys.activity, 'dynamic_scorm_html'),
            manifestXml: await validatedText(L, byItem, ch.keys.activity, 'dynamic_scorm_manifest'),
          });
        }
      }
      audiobookChapters.set(ch.chapterId, await audio(ch.keys.audiobookChapter));
    }
  }
  const finalExamGift = plan.keys.finalExam ? await validatedText(L, byItem, plan.keys.finalExam, 'dynamic_exam_gift') : null;
  const audioWelcome = await audio(plan.keys.audioWelcome);
  return {
    contents: {
      courseIntro,
      moduleIntros,
      contentMd,
      experiences,
      presentations,
      videos,
      videoInteractions,
      activities,
      examGift,
      finalExamGift,
      audioWelcome,
      audiobookChapters,
    },
    warnings,
    mockProviderItems: mockProviderItems.sort(),
  };
}

// ─── Preparación compartida (servicio + worker): una sola fuente de la clave ──

export interface PreparedV3Package {
  run: { id: string; owner_id: string; input_payload: any };
  byItem: Map<string, ResolvedItemV3>;
  profiles: PackagingProfilesV3;
  sourceArtifactIds: string[];
  /** Clave de reuse v3 (se guarda como `sourceIdsHash` en el job y en el artifact dynamic_mbz). */
  sourceIdsHash: string;
  staleWarnings: V3StaleWarning[];
  /** F1 (I3): evaluación resuelta contra los ítems del Manifest (pesos normalizados / sin nota). */
  resolved: ResolvedAssessment;
  /** F1: lo que el resumen del paquete registra de la evaluación (weightsNormalized + pesos originales). */
  assessment: AssessmentPackageSummary;
  /**
   * F1: avisos de perfiles para el resumen del paquete —
   * `presentation_profile_defaulted`, `course_without_grades`,
   * `assessment_weights_normalized:…`.
   */
  profileWarnings: string[];
}

/** F1: avisos de perfiles (tema por defecto + evaluación normalizada / sin nota). Pura. */
export function profileWarningsV3(theme: ResolvedPackagingTheme, resolved: ResolvedAssessment): string[] {
  return [
    ...(theme.source === 'default_v3' ? [PRESENTATION_PROFILE_DEFAULTED] : []),
    ...assessmentPackageWarnings(resolved),
  ];
}

/**
 * Resuelve el run v3, corre la guarda de mocks (R-007), exige video publicado
 * en YouTube si hay videos, lee los perfiles vigentes y calcula la clave de
 * reuse. La usan `PackagingService` (reuse/stale) y el worker (restore-first):
 * una única definición de "mismo paquete".
 */
export async function prepareV3Package(
  q: QueryExecutor,
  runId: string,
  manifest: { id: number; sha256: string; manifest: GenerationManifestV1 },
  courseId: number,
  moodleVersion: string,
): Promise<PreparedV3Package> {
  const [run] = await q.query(`select id, owner_id, input_payload from public.production_jobs where id = $1`, [runId]);
  if (!run) throw new PackagingNotReadyError([`run:${runId}:not_found`]);
  run.input_payload = parseJson(run.input_payload);
  const byItem = await resolveRunArtifactsV3(q, runId, manifest.manifest);
  assertRunArtifactsPackageable(run, byItem);
  const videoKeys = manifest.manifest.items.filter((i) => i.type === 'video').map((i) => i.key);
  if (videoKeys.length && frozenVideoDeliveryOf(run.input_payload) !== 'youtube') {
    throw new PackagingNotReadyError(
      videoKeys.map((k) => `${k}:${V3_VIDEO_REQUIRES_YOUTUBE}`),
      `${V3_VIDEO_REQUIRES_YOUTUBE}: el video interactivo H5P de V2.1 necesita cada video publicado en YouTube (run congelado en ${frozenVideoDeliveryOf(run.input_payload)}).`,
    );
  }
  const profiles = await loadPackagingProfilesV3(q, courseId, manifest.manifest.features?.finalExam === true);
  // Falla temprano (antes de encolar/descargar) si el perfil vigente no se puede aplicar a ESTE run
  // (p.ej. pesos con examen final y el run no lo tiene: R3 ruling 7; intentos no aplicables: R6).
  // F1 (I3): las categorías vacías se omiten y sus pesos se redistribuyen (o el curso queda sin nota).
  const itemCounts = assessmentItemCountsFromManifest(manifest.manifest);
  const resolved = resolveAssessment(profiles.assessment, {
    hasFinalExam: manifest.manifest.features?.finalExam === true,
    activityEngine: manifest.manifest.features?.activityEngine,
    itemCounts,
  });
  // Doble control (G6 M5): tras normalizar ninguna categoría ponderada puede quedar vacía.
  assertCategoriesPopulated(resolved, itemCounts);
  const sourceArtifactIds = sortedArtifactIdsV3(byItem);
  const sourceIdsHash = packageReuseHashV3({
    builderVersion: DYNAMIC_MBZ_BUILDER_VERSION_V3,
    manifestSha256: manifest.sha256,
    sourceArtifactIds,
    themeSha256: profiles.themeSha256,
    assessmentProfileSha256: profiles.assessmentSha256,
    h5pProfileVersion,
    vcRendererVersion: VC_RENDERER_VERSION,
    moodleVersion,
  });
  return {
    run,
    byItem,
    profiles,
    sourceArtifactIds,
    sourceIdsHash,
    staleWarnings: staleWarningsV3(byItem),
    resolved,
    assessment: assessmentPackageSummary(resolved),
    profileWarnings: profileWarningsV3(profiles.theme, resolved),
  };
}
