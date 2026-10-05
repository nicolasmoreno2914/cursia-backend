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
import { artifactDownloadTimeoutMs, parseDynamicVideo, resolveRequiredArtifactTypesV3 } from './artifact-resolver';
import type { ArtifactsService } from '../artifacts/artifacts.service';
import { frozenVideoDeliveryOf, checkYoutubeDeliveryUrl } from '../dynamic-generation/dynamic-video-delivery';
import { GuardArtifact, MockArtifactInRealRunError, assertNoMockArtifactsForRealPackage } from './packaging-guards';
import { frozenProviderModesOf, providerKindOfArtifactType } from '../dynamic-generation/provider-modes';
import { assertSafeStoragePath } from '../artifacts/artifacts.service';
import {
  VideoModeInconsistentError,
  fallbackVideoModeOf,
  questionsBelongToVideo,
  runIsUpgradeOnlyFailure,
  upgradedVideoKeysOf,
  videoUpgradeOf,
} from '../dynamic-generation/video-upgrade';
import { ResolvedAssessment, assertCategoriesPopulated, assessmentItemCountsForPackage } from '../../package/assessment';
import {
  AssessmentProfile,
  PresentationProfile,
  defaultAssessmentProfile,
  defaultPresentationProfile,
  isLightDefaultCourse,
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
import { runOrderedWithLimit } from './ordered-limit';
import type { DynamicPackageContentsV3, ActivityContentV3, ExamSource } from '../../package/dynamic-mbz-builder-v3';
import { EXAM_BANK_ARTIFACT_TYPE, ExamBankV1, validateExamBank } from '../course-shell/exam-bank';

/** EV6 P2: un banco que no pasa la re-validación con el Markdown de sus capítulos no se empaqueta. */
export const EXAM_BANK_INVALID = 'EXAM_BANK_INVALID';
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
import { LibroLogoCandidate, resolveLibroLogo } from '../../package/v3/libro-logo';

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
  /** Fix round 3 (I-4): fin de la generación vigente (regla de procedencia de las preguntas, filas legacy). */
  finishedAt?: unknown;
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
  const [job] = await q.query(`select id, execution_mode, worker_status, status, input_payload from public.production_jobs where id = $1`, [runId]);
  if (!job) throw new PackagingNotReadyError([`run:${runId}:not_found`], `Empaquetado no listo: el run ${runId} no existe.`);
  if (job.execution_mode !== 'dynamic_generation') {
    throw new PackagingNotReadyError([`run:${runId}:wrong_execution_mode=${job.execution_mode}`]);
  }
  job.input_payload = parseJson(job.input_payload);
  // EV6 T5 B2 (§2.6): un run que terminó sin completar SOLO por videos del upgrade se empaqueta igual
  // (esos capítulos quedan con su video pendiente: la generación completada vigente es la de vista previa).
  // EV6 DoD: `preview` (todo completado, algún componente de vista previa) se resuelve igual; su paquete es QA.
  const done = ['completed', 'preview'].includes(String(job.worker_status)) || ['completed', 'preview'].includes(String(job.status));
  if (!done && !(await runIsUpgradeOnlyFailure(q, job))) {
    throw new PackagingNotReadyError([`run:${runId}:not_completed:worker_status=${job.worker_status},status=${job.status}`]);
  }
  const rows: any[] = await q.query(
    `select gir.item_key as item_key, gir.id as item_run_id, gir.status as gir_status, gir.type as gir_type,
            gir.output_summary as output_summary, gir.finished_at as finished_at,
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
    // EV6 P2: exam/final_exam → el rol de examen es el banco JSON o el GIFT (exactamente uno).
    const rolesR = resolveRequiredArtifactTypesV3(item.type, item.variant, list.filter((r) => r.artifact_id).map((r) => r.artifact_type));
    if (!rolesR) {
      missing.push(`${item.key}:unknown_item_type=${item.type}`);
      continue;
    }
    if (rolesR.ok === false) {
      missing.push(`${item.key}:EXAM_ARTIFACT_AMBIGUOUS=${rolesR.types.join('+')}`);
      continue;
    }
    const roles = rolesR.types;
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
    if (arts.length === roles.length) {
      out.set(item.key, { itemKey: item.key, type: item.type, artifacts: arts, outputSummary: parseJson(list[0].output_summary), finishedAt: list[0].finished_at ?? null });
    }
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
      message: `El artifact ${a.type} de ${a.itemKey} quedó desactualizado y se empaquetó igual (no se regenera solo: revísalo o pide regenerarlo).`,
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
  /** V542 (G2): curso nuevo (isLightDefaultCourse) → aula-clara/light con el brandSeed de la paleta. */
  lightDefault?: boolean;
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
    const fromPalette = presentationProfileFromPaletteId(p.legacyPaletteId.trim());
    if (p.lightDefault) {
      const d = defaultPresentationProfile();
      const seed = fromPalette.brandSeed;
      const hasSeed = !!seed && (!!seed.accent || (Array.isArray(seed.moduleColors) && seed.moduleColors.length > 0));
      return {
        source: 'palette',
        input: { themeFamily: d.themeFamily, mode: d.mode, ...(hasSeed ? { brandSeed: { ...seed } } : {}), themeVersion: d.themeVersion } as PresentationProfileInput,
      };
    }
    return { source: 'palette', input: fromPalette as PresentationProfileInput };
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
  let lightDefault = false;
  if (!presentation) {
    // F1 (I4): la paleta guardada con el curso aplica a TODO curso sin perfil (no solo a los migrados).
    const [c] = await q.query(`select metadata, created_at from public.courses where id = $1`, [courseId]);
    legacyPaletteId = legacyPaletteIdOf(c?.metadata);
    lightDefault = isLightDefaultCourse(c?.created_at);
    if (legacyPaletteId && !LEGACY_PALETTES.some((x) => x.id === legacyPaletteId)) {
      throw new Error(
        `THEME_INVALID: el curso #${courseId} tiene la paleta desconocida "${legacyPaletteId}"; ` +
          'guarda un perfil de presentación ("Diseño y evaluación") para empaquetarlo.',
      );
    }
  }
  const theme = resolvePackagingTheme({ presentationProfile: presentation, legacyPaletteId, lightDefault });
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
  /** EV6 T5: keys de los videos pendientes omitidos (entra en la clave SOLO si no está vacía). */
  omittedVideoKeys?: string[];
  /** r19 (L3): sha256 de la marca del Libro Guía (logo resuelto + nombre): un cambio de logo re-empaqueta. */
  libroBrandSha256?: string;
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
    // EV6 T5: solo si hay omisiones → la clave de un run 100% real no cambia.
    ...(k.omittedVideoKeys && k.omittedVideoKeys.length ? { omittedVideoKeys: [...k.omittedVideoKeys].sort() } : {}),
    ...(k.libroBrandSha256 ? { libroBrandSha256: k.libroBrandSha256 } : {}),
  });
  return createHash('sha256').update(canon, 'utf8').digest('hex');
}

// ─── Marca del Libro Guía (r19 L3) ─────────────────────────────────────────

export interface LibroBrandV3 {
  /** Primer logo candidato de la cuenta (compatibilidad; = candidates[0] ?? null). */
  logo: LibroLogoCandidate | null;
  /** Fix round 3: candidatos EN ORDEN [brand_profile, user_settings], sin validar; gana el primero que valida. */
  candidates: LibroLogoCandidate[];
  /** Nombre de la institución del curso (portada y pie del PDF), si hay. */
  name: string | null;
  /** Avisos de la búsqueda (p.ej. una tabla ausente o un logo solo como artifact). */
  warnings: string[];
}

/**
 * Logo y nombre para el Libro Guía, SIN llamadas pagas ni red (lecturas baratas a la base):
 *   1. `brand_profiles` ACTIVO de la institución del curso → `palette.logoUrl` (data URI del frontend);
 *   2. si no, `user_settings.logo_b64` del dueño del curso (lo que sube «Logo del centro»; PNG/JPEG/SVG tal cual);
 *   3. si no, ninguno → logo de Cursia en el builder.
 * `user_settings` (y `authorized_users`) es una tabla administrada por Supabase, SIN entidad ni migración en este
 * backend (docs/memory/00_estado_actual.md, docs/ARQUITECTURA_V1.md): la base del backend ES la de Supabase y
 * `courses.owner_id` es el uid de Supabase (sub del JWT). `brand_profiles` / `institutions` son entidades NestJS.
 * Fix round 1 (I3): si una fuente que debería consultarse no existe (to_regclass nulo) o su consulta falla por
 * estructura (tabla o columna ausente, permisos), el aviso `libro_logo_source_unavailable:<tabla>[:motivo]` queda
 * visible en el resumen del paquete; nunca una caída silenciosa al logo de Cursia.
 * `brand_profiles.logo_artifact_id` no lo llena hoy ningún flujo del producto: si aparece SIN `logoUrl` se avisa
 * (`libro_logo_artifact_unsupported`) y se sigue con el paso 2.
 */
export async function loadLibroBrandV3(q: QueryExecutor, courseId: number, ownerId: string | null): Promise<LibroBrandV3> {
  const warnings: string[] = [];
  const why = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 80).replace(/\s+/g, ' ').replace(/:/g, ';');
  let course: any;
  let reg: any;
  try {
    [course] = await q.query(`select owner_id, institution_id from public.courses where id = $1`, [courseId]);
    [reg] = await q.query(
      `select to_regclass('public.brand_profiles') is not null as bp, to_regclass('public.user_settings') is not null as us, to_regclass('public.institutions') is not null as inst`,
      [],
    );
  } catch (err) {
    return { logo: null, candidates: [], name: null, warnings: [`libro_logo_source_unavailable:courses:${why(err)}`] };
  }
  const owner = (course?.owner_id ?? ownerId ?? null) as string | null;
  let name: string | null = null;
  const candidates: LibroLogoCandidate[] = [];
  if (course?.institution_id) {
    if (!reg?.inst) warnings.push('libro_logo_source_unavailable:institutions');
    else {
      try {
        const [inst] = await q.query(`select name from public.institutions where id::text = $1`, [String(course.institution_id)]);
        if (typeof inst?.name === 'string' && inst.name.trim()) name = inst.name.trim().slice(0, 120);
      } catch (err) {
        warnings.push(`libro_logo_source_unavailable:institutions:${why(err)}`);
      }
    }
    if (!reg?.bp) warnings.push('libro_logo_source_unavailable:brand_profiles');
    else {
      try {
        const [bp] = await q.query(
          `select palette->>'logoUrl' as logo_url, logo_artifact_id from public.brand_profiles where institution_id::text = $1 and status = 'active' order by version desc limit 1`,
          [String(course.institution_id)],
        );
        if (typeof bp?.logo_url === 'string' && bp.logo_url.trim()) candidates.push({ source: 'brand_profile', dataUri: bp.logo_url });
        else if (bp?.logo_artifact_id) warnings.push('libro_logo_artifact_unsupported:brand_profile');
      } catch (err) {
        warnings.push(`libro_logo_source_unavailable:brand_profiles:${why(err)}`);
      }
    }
  }
  // fix round 3: user_settings se lee SIEMPRE (no solo sin brand profile): es el respaldo si el logo de la marca no valida.
  if (owner) {
    if (!reg?.us) warnings.push('libro_logo_source_unavailable:user_settings');
    else {
      try {
        const [us] = await q.query(`select logo_b64 from public.user_settings where user_id::text = $1`, [String(owner)]);
        if (typeof us?.logo_b64 === 'string' && us.logo_b64.trim()) candidates.push({ source: 'user_settings', dataUri: us.logo_b64 });
      } catch (err) {
        warnings.push(`libro_logo_source_unavailable:user_settings:${why(err)}`);
      }
    }
  }
  return { logo: candidates[0] ?? null, candidates, name, warnings };
}

/** Hash de la marca del Libro Guía tal como la verá el builder (logo YA resuelto + nombre) y sus avisos. */
export function libroBrandFingerprintV3(brand: Pick<LibroBrandV3, 'logo' | 'name'> & { candidates?: LibroLogoCandidate[] }): { sha256: string; warnings: string[]; logoSource: string } {
  // fix round 3: hash de los bytes del logo RESUELTO (el primer candidato válido), igual que antes.
  const logo = resolveLibroLogo(brand.candidates ?? brand.logo);
  const sha256 = createHash('sha256').update(`${logo.sha256}|${brand.name ?? ''}`, 'utf8').digest('hex');
  return { sha256, warnings: logo.warnings, logoSource: logo.source };
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
  /** EV6 P2: fuente de cada examen (GIFT de siempre o banco JSON validado), en orden del plan. */
  exams: { modules: Map<string, ExamSource>; final: ExamSource | null };
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


/**
 * R16: descargas de artifacts en vuelo a la vez al armar un paquete v3. Chico y fijo:
 * suficiente para esconder la latencia de Storage (~3 idas y vueltas por archivo) sin
 * multiplicar la memoria ni saturar el pool de la base (cada descarga hace un findOne).
 */
export const PACKAGING_V3_DOWNLOAD_CONCURRENCY = 6;

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

  // R16 (rendimiento): las descargas corren con a lo sumo PACKAGING_V3_DOWNLOAD_CONCURRENCY
  // en vuelo (antes, una detrás de otra: ~55–60 descargas × 3 idas y vueltas en un curso
  // mediano). Cada tarea escribe en su propia ranura y los Maps se arman DESPUÉS, en el
  // orden del plan, así el contenido y el orden de inserción son idénticos a los del loop
  // secuencial; los avisos también se juntan en ese orden. Errores: runOrderedWithLimit
  // no arranca nada nuevo tras una falla y rechaza con el error de la tarea de menor
  // índice (el mismo que daba el loop secuencial).
  type PresentationSlot = { value: { pdf: Buffer; cover: Buffer; mock?: boolean }; warnings: string[] };
  type ChapterSlots = {
    content?: string;
    experience?: unknown;
    presentation?: PresentationSlot;
    video?: { youtubeId: string; durationSec: number };
    videoInteractions?: unknown;
    activityPayload?: unknown;
    scormHtml?: string;
    scormManifest?: string;
    audio?: Buffer;
  };
  const tasks: Array<() => Promise<void>> = [];
  let courseIntro: any;
  const moduleIntroSlots = new Map<string, unknown>();
  const examSlots = new Map<string, ExamSource>();
  const chapterSlots = new Map<string, ChapterSlots>();
  let finalExamSource: ExamSource | null = null;
  // EV6 P2: el examen se carga según el artifact que resolvió el item (banco JSON o GIFT).
  const loadExam = async (key: string): Promise<ExamSource> => {
    if (byItem.get(key)?.artifacts.some((a) => a.type === EXAM_BANK_ARTIFACT_TYPE)) {
      return { kind: 'bank', bank: json(await validatedText(L, byItem, key, EXAM_BANK_ARTIFACT_TYPE), key) };
    }
    return { kind: 'gift', gift: await validatedText(L, byItem, key, 'dynamic_exam_gift') };
  };
  let audioWelcome: Buffer | undefined;

  const loadPresentation = async (ch: PackagingPlanV3['modules'][number]['chapters'][number]): Promise<PresentationSlot> => {
    // Presentación (R9): real = PDF + portada en Storage (sha verificado); simulada = medios sintéticos.
    const pa = one(byItem, ch.keys.presentation, 'dynamic_presentation');
    const pres = json(await L.loadText(pa), ch.keys.presentation);
    if (assertArtifactMockAllowed(run, pa, pres)) {
      const n = Number(pres.slideCount);
      if (!Number.isInteger(n) || n < 1 || n > 500) throw new Error(`${PACKAGING_V3}: fixture ${ch.keys.presentation} sin slideCount válido (G6 M3)`);
      const pdf = syntheticPdf(n);
      mockProviderItems.push(ch.keys.presentation);
      return { value: { pdf, cover: syntheticCoverPng(MOCK_COVER.w, MOCK_COVER.h, MOCK_COVER.color), mock: true }, warnings: [] };
    }
    const w: string[] = [];
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
    if (pdfPageCount(pdf) !== pres.slideCount) w.push(`slide_count_declared_mismatch:${ch.keys.presentation}`);
    try {
      const tm = themeMismatch(pres, currentTheme as any);
      if (tm.mismatch) w.push(`theme_mismatch:${ch.keys.presentation}:${tm.changed.join('+')}`);
    } catch (err) {
      w.push(`theme_mismatch_unknown:${ch.keys.presentation}:${err instanceof Error ? err.message.split(':')[0] : 'error'}`);
    }
    return { value: { pdf, cover }, warnings: w };
  };

  const loadVideo = async (ch: PackagingPlanV3['modules'][number]['chapters'][number]): Promise<{ youtubeId: string; durationSec: number }> => {
    if (delivery !== 'youtube') {
      throw new PackagingNotReadyError(
        [`${ch.keys.video}:${V3_VIDEO_REQUIRES_YOUTUBE}`],
        `${V3_VIDEO_REQUIRES_YOUTUBE}: el video interactivo H5P de V2.1 necesita el video publicado en YouTube (el run está congelado en ${delivery}).`,
      );
    }
    const va = one(byItem, ch.keys.video as string, 'dynamic_video');
    const data = json(await L.loadText(va), ch.keys.video as string);
    const parsed = parseDynamicVideo(data, 'youtube');
    const check = checkYoutubeDeliveryUrl(parsed.url);
    if (check.ok === false) throw new Error(`${PACKAGING_V3}: ${ch.keys.video}: ${check.reason}`);
    const dur = Number(data.durationSec ?? va.metadata?.durationSec);
    if (!Number.isFinite(dur) || dur <= 0) {
      throw new PackagingNotReadyError([`${ch.keys.video}:VIDEO_DURATION_MISSING`], `VIDEO_DURATION_MISSING: ${ch.keys.video} no tiene la duración medida del video.`);
    }
    return { youtubeId: check.videoId, durationSec: dur };
  };

  // Tareas en el MISMO orden que el loop secuencial de antes.
  tasks.push(async () => {
    courseIntro = json(await validatedText(L, byItem, plan.keys.courseIntro, 'dynamic_course_intro_json'), plan.keys.courseIntro);
  });
  for (const m of plan.modules) {
    tasks.push(async () => {
      moduleIntroSlots.set(m.moduleId, json(await validatedText(L, byItem, m.keys.moduleIntro, 'dynamic_module_intro_json'), m.keys.moduleIntro));
    });
    if (m.keys.exam) {
      const examKey = m.keys.exam;
      tasks.push(async () => {
        examSlots.set(m.moduleId, await loadExam(examKey));
      });
    }
    for (const ch of m.chapters) {
      const slot: ChapterSlots = {};
      chapterSlots.set(ch.chapterId, slot);
      // Motor de carga horaria: un capítulo de práctica no tiene content (Libro), presentación ni audiolibro.
      const contentKey = ch.keys.content;
      if (contentKey) tasks.push(async () => { slot.content = await validatedText(L, byItem, contentKey, 'dynamic_content_md'); });
      tasks.push(async () => { slot.experience = json(await validatedText(L, byItem, ch.keys.experience, 'dynamic_experience_json'), ch.keys.experience); });
      if (ch.keys.presentation) tasks.push(async () => { slot.presentation = await loadPresentation(ch); });
      if (ch.keys.video) {
        tasks.push(async () => { slot.video = await loadVideo(ch); });
        tasks.push(async () => {
          slot.videoInteractions = json(
            await validatedText(L, byItem, ch.keys.videoInteractions as string, 'dynamic_video_interactions_json'),
            ch.keys.videoInteractions as string,
          );
        });
      }
      if (ch.keys.activity) {
        const activityKey = ch.keys.activity;
        if (ch.activityVariant === 'h5p') {
          tasks.push(async () => { slot.activityPayload = json(await validatedText(L, byItem, activityKey, 'dynamic_h5p_params_json'), activityKey); });
        } else {
          tasks.push(async () => { slot.scormHtml = await validatedText(L, byItem, activityKey, 'dynamic_scorm_html'); });
          tasks.push(async () => { slot.scormManifest = await validatedText(L, byItem, activityKey, 'dynamic_scorm_manifest'); });
        }
      }
      const audioKey = ch.keys.audiobookChapter;
      if (audioKey) tasks.push(async () => { slot.audio = await audio(audioKey); });
    }
  }
  if (plan.keys.finalExam) {
    const finalKey = plan.keys.finalExam;
    tasks.push(async () => { finalExamSource = await loadExam(finalKey); });
  }
  tasks.push(async () => { audioWelcome = await audio(plan.keys.audioWelcome); });

  await runOrderedWithLimit(tasks, PACKAGING_V3_DOWNLOAD_CONCURRENCY);

  // Armado en el orden del plan (mismo orden de inserción que antes).
  const moduleIntros = new Map<string, unknown>();
  const examGift = new Map<string, string>();
  const examBanks = new Map<string, ExamBankV1>();
  const examSources = new Map<string, ExamSource>();
  const contentMd = new Map<string, string>();
  const experiences = new Map<string, unknown>();
  const presentations = new Map<string, { pdf: Buffer; cover: Buffer; mock?: boolean }>();
  const videos = new Map<string, { youtubeId: string; durationSec: number }>();
  const videoInteractions = new Map<string, unknown>();
  const activities = new Map<string, ActivityContentV3>();
  const audiobookChapters = new Map<string, Buffer>();
  // r19: manifiesto validado por capítulo (output_summary del item) para el piso de 25 min del audiolibro.
  // null = audio real SIN manifiesto (curso existente, anterior a r19): el piso se omite con aviso y el
  // re-empaque NUNCA re-narra ni llama a un proveedor. Los capítulos simulados no entran al mapa.
  const audiobookManifests = new Map<string, any>();
  for (const m of plan.modules) {
    moduleIntros.set(m.moduleId, moduleIntroSlots.get(m.moduleId));
    if (m.keys.exam) {
      const src = examSlots.get(m.moduleId) as ExamSource;
      examSources.set(m.moduleId, src);
      if (src.kind === 'gift') examGift.set(m.moduleId, src.gift);
      else examBanks.set(m.moduleId, src.bank);
    }
    for (const ch of m.chapters) {
      const slot = chapterSlots.get(ch.chapterId) as ChapterSlots;
      if (ch.keys.content) contentMd.set(ch.chapterId, slot.content as string);
      experiences.set(ch.chapterId, slot.experience);
      if (ch.keys.presentation) {
        const pres = slot.presentation as PresentationSlot;
        warnings.push(...pres.warnings);
        presentations.set(ch.chapterId, pres.value);
      }
      if (ch.keys.video) {
        videos.set(ch.chapterId, slot.video as { youtubeId: string; durationSec: number });
        videoInteractions.set(ch.chapterId, slot.videoInteractions);
      }
      if (ch.keys.activity) {
        if (ch.activityVariant === 'h5p') {
          activities.set(ch.chapterId, { variant: 'h5p', payload: slot.activityPayload });
        } else {
          activities.set(ch.chapterId, { variant: 'scorm', html: slot.scormHtml as string, manifestXml: slot.scormManifest as string });
        }
      }
      if (ch.keys.audiobookChapter) {
        audiobookChapters.set(ch.chapterId, slot.audio as Buffer);
        if (!mockProviderItems.includes(ch.keys.audiobookChapter)) {
          const man = byItem.get(ch.keys.audiobookChapter)?.outputSummary?.audiobookManifest;
          audiobookManifests.set(ch.chapterId, man && typeof man === 'object' ? man : null);
        }
      }
    }
  }
  // EV6 P2: un banco se re-valida con el Markdown de sus capítulos (evidencia) antes de empaquetar; falla fuerte.
  // Fix 1 (C2): contra SU plan congelado + pertenencia (un reorden del Blueprint reusa el banco sin costo;
  // un cambio de pertenencia ya regeneró el examen por invalidación).
  const finalSrc = finalExamSource as ExamSource | null;
  const banksToCheck: Array<{ key: string; scope: 'module' | 'final'; bank: ExamBankV1; chapters: Array<{ id: string; moduleId: string }> }> = [];
  for (const m of plan.modules) {
    const src = examSources.get(m.moduleId);
    // Motor de carga horaria: los capítulos de práctica no entran a los exámenes (mismo plan que el claim).
    if (src?.kind === 'bank') banksToCheck.push({ key: m.keys.exam as string, scope: 'module', bank: src.bank, chapters: m.chapters.filter((c) => c.kind !== 'practice').map((c) => ({ id: c.chapterId, moduleId: m.moduleId })) });
  }
  if (finalSrc?.kind === 'bank') {
    banksToCheck.push({ key: plan.keys.finalExam as string, scope: 'final', bank: finalSrc.bank, chapters: plan.modules.flatMap((m) => m.chapters.filter((c) => c.kind !== 'practice').map((c) => ({ id: c.chapterId, moduleId: m.moduleId }))) });
  }
  for (const b of banksToCheck) {
    const r = validateExamBank(b.bank, { scope: b.scope, chapters: b.chapters, chapterMd: contentMd, planSource: 'frozen', evidenceRules: 'asAccepted' });
    if (!r.ok) {
      const codes = [...new Set(r.errors.map((e) => e.code))].sort();
      throw new Error(`${EXAM_BANK_INVALID}: ${b.key} [${codes.join(', ')}] ${r.errors.slice(0, 5).map((e) => `${e.path} ${e.code}: ${e.message}`).join(' | ')}`);
    }
  }

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
      finalExamGift: finalSrc && finalSrc.kind === 'gift' ? finalSrc.gift : null,
      ...(examBanks.size ? { examBanks } : {}),
      ...(finalSrc && finalSrc.kind === 'bank' ? { finalExamBank: finalSrc.bank } : {}),
      audioWelcome: audioWelcome as Buffer,
      audiobookChapters,
      audiobookManifests,
    },
    exams: { modules: examSources, final: finalSrc },
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
   * EV6 T5: videos del Manifest cuya generación vigente NO es real (vista previa): se omiten del
   * paquete (no están en `byItem` ni en `sourceArtifactIds`). Orden del Manifest.
   */
  pendingVideos: PendingVideoV3[];
  /**
   * F1: avisos de perfiles para el resumen del paquete —
   * `presentation_profile_defaulted`, `course_without_grades`,
   * `assessment_weights_normalized:…`.
   */
  profileWarnings: string[];
  /** r19 (L3): marca del Libro Guía (logo candidato + nombre) que el worker pasa al builder. */
  libroBrand: LibroBrandV3;
}

export interface PendingVideoV3 {
  itemKey: string;
  chapterId: string;
  videoInteractionsKey: string;
}

/**
 * EV6 T5: ¿el video vigente del item es real? La verdad por item es `output_summary.mode` que
 * escribe el worker al completarlo (`'real'` | `'mock'`). Sin ese dato (items anteriores) decide
 * el modo congelado del run: un run real sigue exigiendo su video (y el parser del artifact
 * sigue rechazando fuerte un cuerpo simulado); un run mock lo deja pendiente. Nunca se presenta
 * como real un video que no se sabe real.
 */
export function isRealVideoOutput(outputSummary: Record<string, any> | null | undefined, runVideoMode: unknown): boolean {
  const mode = outputSummary?.mode;
  if (mode === 'real') return true;
  if (mode === 'mock') return false;
  return runVideoMode === 'real';
}

/**
 * EV6 T5: separa los videos pendientes (vista previa) de un run v3 resuelto. Devuelve la lista
 * (orden del Manifest) y un `byItem` SIN esos videos ni sus interacciones: lo que el paquete
 * realmente contiene. Pura.
 */
export function splitPendingVideosV3(
  manifest: GenerationManifestV1,
  byItem: Map<string, ResolvedItemV3>,
  runVideoMode: unknown,
  opts: {
    videoUpgrade?: boolean;
    runId?: string;
    /** Fix round 1 (m-6): keys de video de los upgrades del run (solo esas pueden quedar pendientes en un run real). */
    upgradedKeys?: ReadonlySet<string>;
    /** Fix round 1 (m-6): modo para items sin `mode` = el ORIGINAL del run (default: runVideoMode). */
    fallbackMode?: unknown;
  } = {},
): { pendingVideos: PendingVideoV3[]; byItem: Map<string, ResolvedItemV3> } {
  const pendingVideos: PendingVideoV3[] = [];
  const inconsistent: string[] = [];
  for (const it of manifest.items) {
    if (it.type !== 'video') continue;
    const r = byItem.get(it.key);
    if (!r) continue; // resolveRunArtifactsV3 ya exigió todos los items
    const chapterIdOf = String(it.chapterId ?? it.key.slice('video:'.length));
    if (isRealVideoOutput(r.outputSummary, opts.fallbackMode !== undefined ? opts.fallbackMode : runVideoMode)) {
      // Fix round 1 (I-1) / round 3 (I-4): un video REAL de un upgrade cuyas preguntas NO se
      // construyeron con ESA generación del video (regla única de procedencia, video-upgrade.ts) NO
      // se empaqueta con esas preguntas: queda pendiente, nunca un H5P incoherente.
      const vRunId = r.artifacts[0]?.itemRunId;
      const inter = byItem.get(`video_interactions:${chapterIdOf}`);
      const fromUpgrade = r.outputSummary?.regeneration?.reason === 'video_upgrade';
      if (!fromUpgrade || !inter ||
        questionsBelongToVideo({ id: String(vRunId), finishedAt: r.finishedAt }, { status: 'completed', outputSummary: inter.outputSummary, finishedAt: inter.finishedAt })) continue;
    }
    // Ruling 6 (B2): run real + item de vista previa solo es «pendiente» si un upgrade lo incluyó.
    if (runVideoMode === 'real' && (!opts.videoUpgrade || (opts.upgradedKeys && !opts.upgradedKeys.has(it.key)))) {
      inconsistent.push(it.key);
      continue;
    }
    const chapterId = String(it.chapterId ?? it.key.slice('video:'.length));
    pendingVideos.push({ itemKey: it.key, chapterId, videoInteractionsKey: `video_interactions:${chapterId}` });
  }
  if (inconsistent.length) throw new VideoModeInconsistentError(inconsistent, opts.runId);
  if (!pendingVideos.length) return { pendingVideos, byItem };
  const drop = new Set(pendingVideos.flatMap((p) => [p.itemKey, p.videoInteractionsKey]));
  return { pendingVideos, byItem: new Map([...byItem].filter(([k]) => !drop.has(k))) };
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
  const resolvedAll = await resolveRunArtifactsV3(q, runId, manifest.manifest);
  // EV6 T5: los videos de vista previa quedan fuera del paquete (nunca un video simulado como real).
  const { pendingVideos, byItem } = splitPendingVideosV3(manifest.manifest, resolvedAll, run.input_payload?.videoMode, {
    videoUpgrade: !!videoUpgradeOf(run.input_payload),
    runId,
    upgradedKeys: upgradedVideoKeysOf(run.input_payload),
    fallbackMode: fallbackVideoModeOf(run.input_payload),
  });
  const omittedVideoKeys = pendingVideos.map((p) => p.itemKey);
  assertRunArtifactsPackageable(run, byItem);
  const pendingKeys = new Set(omittedVideoKeys);
  const videoKeys = manifest.manifest.items.filter((i) => i.type === 'video' && !pendingKeys.has(i.key)).map((i) => i.key);
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
  const itemCounts = assessmentItemCountsForPackage(manifest.manifest, omittedVideoKeys);
  const resolved = resolveAssessment(profiles.assessment, {
    hasFinalExam: manifest.manifest.features?.finalExam === true,
    activityEngine: manifest.manifest.features?.activityEngine,
    itemCounts,
  });
  // Doble control (G6 M5): tras normalizar ninguna categoría ponderada puede quedar vacía.
  assertCategoriesPopulated(resolved, itemCounts);
  const sourceArtifactIds = sortedArtifactIdsV3(byItem);
  // r19 (L3): el logo resuelto (y el nombre) entran en la clave: cambiar el logo de la cuenta re-empaqueta.
  const libroBrand = await loadLibroBrandV3(q, courseId, run.owner_id ?? null);
  const brandPrint = libroBrandFingerprintV3(libroBrand);
  const sourceIdsHash = packageReuseHashV3({
    builderVersion: DYNAMIC_MBZ_BUILDER_VERSION_V3,
    manifestSha256: manifest.sha256,
    sourceArtifactIds,
    themeSha256: profiles.themeSha256,
    assessmentProfileSha256: profiles.assessmentSha256,
    h5pProfileVersion,
    vcRendererVersion: VC_RENDERER_VERSION,
    moodleVersion,
    omittedVideoKeys,
    libroBrandSha256: brandPrint.sha256,
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
    profileWarnings: [...profileWarningsV3(profiles.theme, resolved), ...libroBrand.warnings, ...brandPrint.warnings],
    pendingVideos,
    libroBrand,
  };
}
