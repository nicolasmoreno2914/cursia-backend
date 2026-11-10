/**
 * Entrada COMPLETA del builder v3 (`BuildDynamicMbzV3Input`) de un run: la composición que hacía `processV3PackageJob`
 * del `dynamic-package-worker`, extraída SIN cambio de comportamiento (r107 B10) para que el Taller de cursos pueda
 * reconstruir la misma entrada desde la base (Libro v3 en PDF) sin duplicarla. El worker la usa tal cual.
 *
 *   prepareV3Package (artifacts del run, perfiles, marca, referencias) + Blueprint v2 congelado
 *     → plan v3 → tema → contenidos cargados → archivos de práctica subidos → entrada del builder.
 */
import type { QueryExecutor } from './artifact-resolver';
import { ContentLoadersV3, PreparedV3Package, loadContentsV3, loadPracticeFilesV3 } from './packaging-v3';
import { buildPackagingPlanV3 } from './packaging-plan-v3';
import { resolveTheme } from '../theme-engine';
import type { BlueprintSnapshotV2 } from '../course-blueprints/blueprint-snapshot';
import type { BuildDynamicMbzV3Input } from '../../package/dynamic-mbz-builder-v3';

/**
 * r58 (I3): horas que la bienvenida muestra como «definidas por la institución»: las horas objetivo congeladas en el
 * Blueprint (perfil del curso o documento). Sin objetivo → null (la bienvenida no muestra duración; nunca se inventa).
 */
export function packageDeclaredHours(snapshot: BlueprintSnapshotV2): number | null {
  const t = snapshot?.course?.targetHours;
  return typeof t === 'number' && Number.isFinite(t) && t > 0 ? t : null;
}

/**
 * Review r1 (M-5): origen de las horas objetivo. `document` solo si el Blueprint lo congeló explícitamente
 * (`course.targetHoursSource = 'document'`); hoy el lock no lo congela (decisión #9 pendiente) → null = redacción neutra
 * «Duración estimada del curso: X h.» (el objetivo puede venir del perfil, de una propuesta de Cursia o del documento).
 */
export function packageDeclaredHoursSource(snapshot: BlueprintSnapshotV2): 'document' | null {
  return packageDeclaredHours(snapshot) !== null && (snapshot?.course as Record<string, unknown> | undefined)?.['targetHoursSource'] === 'document' ? 'document' : null;
}

export interface ComposeV3Input {
  q: QueryExecutor;
  loaders: ContentLoadersV3;
  ownerId: string;
  prepared: PreparedV3Package;
  manifest: { id: number; manifest: BuildDynamicMbzV3Input['manifest'] };
  snapshot: BlueprintSnapshotV2;
  moodleRequested: string | undefined;
  /** Paquete QA (vista previa): aviso en la bienvenida. */
  qa: boolean;
  /** Reloj del .mbz (segundos UNIX). */
  ts: number;
}

export interface ComposedV3 {
  buildInput: BuildDynamicMbzV3Input;
  plan: ReturnType<typeof buildPackagingPlanV3>;
  loaded: Awaited<ReturnType<typeof loadContentsV3>>;
  pendingVideoChapterIds: string[];
  omittedVideoKeys: string[];
}

export async function composeV3BuildInput(a: ComposeV3Input): Promise<ComposedV3> {
  const { prepared, manifest, snapshot } = a;
  const pendingVideoChapterIds = prepared.pendingVideos.map((p) => p.chapterId);
  const omittedVideoKeys = prepared.pendingVideos.map((p) => p.itemKey);
  const plan = buildPackagingPlanV3(manifest.manifest, snapshot, { manifestId: manifest.id, omitVideoChapterIds: pendingVideoChapterIds });
  const theme = resolveTheme(prepared.profiles.theme.input);
  const loaded = await loadContentsV3(a.loaders, plan, prepared.byItem, prepared.run, { familyId: theme.familyId, mode: theme.mode });
  // T5 (r57): archivos de trabajo SUBIDOS del perfil (los de tabla los genera el builder). Sin ellos, la entrada de siempre.
  const practiceFiles = await loadPracticeFilesV3(a.q, a.loaders, a.ownerId, prepared.profiles.assessment);
  if (practiceFiles.size) loaded.contents.practiceFiles = practiceFiles;
  const buildInput: BuildDynamicMbzV3Input = {
    manifest: manifest.manifest,
    blueprint: snapshot,
    manifestId: manifest.id,
    assessmentProfile: prepared.profiles.assessment,
    presentation: prepared.profiles.theme.input,
    contents: loaded.contents,
    ts: a.ts,
    moodleVersion: a.moodleRequested,
    pendingVideoChapterIds,
    // r19 (L3): logo de la cuenta (o ninguno → Cursia) y nombre de la institución para el Libro Guía en PDF.
    // fix round 3: candidatos en orden (brand_profile → user_settings); el builder usa el primero que valida.
    libroBrand: {
      logo: prepared.libroBrand?.candidates ?? prepared.libroBrand?.logo ?? null,
      name: prepared.libroBrand?.name ?? null,
      // r76 «Diseño visual»: marca de agua y logo en la bienvenida (solo si el perfil se aparta de lo de siempre).
      ...(prepared.libroBrand?.watermark === false ? { watermark: false } : {}),
      ...(prepared.libroBrand?.showInCourse === true ? { showInCourse: true } : {}),
    },
    libroReferences: prepared.libroReferences ?? null,
    // r58 (I3) fix: horas objetivo congeladas en el Blueprint → «Duración estimada: X h (definida por la institución)» en
    // la bienvenida y «Carga horaria declarada» en la Guía del docente. Antes nunca se pasaban (facts.hours = null siempre).
    hours: packageDeclaredHours(snapshot),
    // Review r1 (M-5): «(definida por la institución)» solo si el Blueprint congeló que las horas vienen del documento.
    hoursSource: packageDeclaredHoursSource(snapshot),
    // EV6 DoD: paquete QA → aviso visible en la bienvenida + nombre del curso «[QA — vista previa, no entregable]».
    ...(a.qa ? { qaPreviewNotice: true } : {}),
  };
  return { buildInput, plan, loaded, pendingVideoChapterIds, omittedVideoKeys };
}
