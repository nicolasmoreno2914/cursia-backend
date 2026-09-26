// Cursia V2.1 / R8 — actividad de video interactivo (H5P.InteractiveVideo en
// mod_h5pactivity core) a partir del plan determinístico + `video_interactions`.
import { createHash } from 'crypto';
import { buildContentOnlyH5p } from '../package';
import { buildInteractiveVideo } from '../types/interactive-video';
import { VideoCheckpoint, planInteractionCheckpoints, videoPlanDurationSec } from './plan';
import { VideoInteractionsDoc, checkpointToChoiceInput, validateVideoInteractionsDoc } from './interactions-doc';

export interface BuildVideoActivityInput {
  /** item_key del video (`video:<ch>`); también semilla de los subContentId UUID. */
  itemKey: string;
  title: string;
  youtubeId: string;
  /** Duración REAL del video (artifact de Videogen), no la del LLM. */
  durationSec: number;
  interactionsDoc: VideoInteractionsDoc | unknown;
}

export interface VideoActivityBuild {
  /** `.h5p` solo contenido (bytes determinísticos). */
  h5p: Buffer;
  interactionCount: number;
  maxScore: number;
  subContentIds: string[];
  checkpoints: VideoCheckpoint[];
  sha1: string;
  sha256: string;
}

/**
 * Valida el documento del LLM contra el plan (misma duración, mismo itemKey) y
 * construye el `.h5p` con R7 `buildInteractiveVideo`. Falla fuerte ante cualquier desvío.
 */
export async function buildVideoActivity(input: BuildVideoActivityInput): Promise<VideoActivityBuild> {
  if (!input || typeof input !== 'object') throw new Error('VIDEO_ACTIVITY_INVALID: input debe ser un objeto');
  const durationSec = videoPlanDurationSec(input.durationSec);
  // Primero el plan de la duración REAL: un video corto falla con VIDEO_TOO_SHORT_FOR_INTERACTIONS
  // antes de mirar el documento del LLM.
  planInteractionCheckpoints(durationSec);
  const plan = validateVideoInteractionsDoc(input.interactionsDoc, { videoItemKey: input.itemKey, durationSec });
  const doc = input.interactionsDoc as VideoInteractionsDoc;
  const built = buildInteractiveVideo({
    itemKey: input.itemKey,
    title: input.title,
    youtubeId: input.youtubeId,
    durationSec,
    interactions: doc.checkpoints.map((c, i) => ({ ...checkpointToChoiceInput(c), atSec: plan[i].atSec })),
  });
  if (built.maxScore !== plan.length || built.subContentIds.length !== plan.length) {
    throw new Error(`VIDEO_ACTIVITY_INVARIANT: maxScore ${built.maxScore} / subContentIds ${built.subContentIds.length} ≠ ${plan.length}`);
  }
  const h5p = await buildContentOnlyH5p({ mainLibrary: built.mainLibrary, content: built.content, title: built.title, language: 'es' });
  return {
    h5p,
    interactionCount: plan.length,
    maxScore: built.maxScore,
    subContentIds: built.subContentIds,
    checkpoints: plan,
    sha1: createHash('sha1').update(h5p).digest('hex'),
    sha256: createHash('sha256').update(h5p).digest('hex'),
  };
}

// ── Archivos en el MBZ ────────────────────────────────────────────────────

export const H5P_PACKAGE_MIMETYPE = 'application/zip.h5p';

export interface H5pActivityFileEntry {
  component: 'mod_h5pactivity';
  filearea: 'package' | 'intro';
  itemid: 0;
  filepath: '/';
  filename: string;
  /** SHA-1 hex (contenthash del filepool de Moodle). */
  contenthash: string;
  filesize: number;
  mimetype: string;
  /** Ruta del blob dentro del .mbz: files/<hash[0..2]>/<hash>. */
  blobPath: string;
}

/**
 * Las DOS entradas de files.xml que necesita un video inline (R12 las emite):
 * el mismo `.h5p` (mismo hash, un solo blob) en `package` (el reproductor de
 * view.php) y en `intro` (el iframe embed.php del intro). Ambas en el contexto
 * del módulo. El blob se escribe una sola vez en files/<hh>/<hash>.
 */
export function videoActivityFileEntries(input: { packageFilename: string; h5p: Buffer }): [H5pActivityFileEntry, H5pActivityFileEntry] {
  if (!input || !Buffer.isBuffer(input.h5p) || input.h5p.length === 0) {
    throw new Error('VIDEO_ACTIVITY_FILES_INVALID: h5p debe ser un Buffer no vacío');
  }
  if (typeof input.packageFilename !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,120}\.h5p$/.test(input.packageFilename)) {
    throw new Error(`VIDEO_ACTIVITY_FILES_INVALID: packageFilename ${JSON.stringify(input.packageFilename)}`);
  }
  const contenthash = createHash('sha1').update(input.h5p).digest('hex');
  const base = {
    component: 'mod_h5pactivity' as const,
    itemid: 0 as const,
    filepath: '/' as const,
    filename: input.packageFilename,
    contenthash,
    filesize: input.h5p.length,
    mimetype: H5P_PACKAGE_MIMETYPE,
    blobPath: `files/${contenthash.slice(0, 2)}/${contenthash}`,
  };
  return [
    { ...base, filearea: 'package' },
    { ...base, filearea: 'intro' },
  ];
}

/** Ajustes Moodle de la actividad de video (§K, R0): nota 0–100, aprobación 70, completion por nota aprobatoria. */
export const VIDEO_ACTIVITY_MOODLE_SETTINGS = Object.freeze({
  /**
   * Máscara de DESHABILITADOS de H5PCore (FRAME 1 | DOWNLOAD 2 | EMBED 4 | COPYRIGHT 8) = 15:
   * sin barra de acciones, sin "Reuse"/descarga ni "Embed" (§K.3 "sin descarga"). Es lo que guarda
   * el formulario de Moodle con las casillas desmarcadas. OJO: 0 significa "mostrar todo".
   */
  displayoptions: 15,
  grade: 100,
  gradepass: 70,
  grademethod: 1,
  enabletracking: 1,
  reviewmode: 1,
  completion: 2,
  completiongradeitemnumber: 0,
  completionpassgrade: 1,
  showdescription: 1,
});
