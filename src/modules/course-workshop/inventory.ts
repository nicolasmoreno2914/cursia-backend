/**
 * r107 B2 · Taller de cursos — inventario de un paquete (diseño §4 «inventory») y fuente recuperada de la base (B2 §3).
 * Puro: el servicio le pasa el paquete abierto y, si el curso se identificó, las filas de artifacts / estructura que
 * leyó de la base. Nunca descarga nada de la fuente: solo engancha referencias (id + tipo + cómo se enganchó).
 */
import { MbzPackage } from './mbz-reader';
import { WorkshopFamily } from './identify';
import { WorkshopActivity, WorkshopCourse, WorkshopSourceRef, buildWorkshopCourse, readRawCourse, stableStringify } from './course-model';
import { adapterFor } from './adapters';

export interface InventoryMeta {
  family: WorkshopFamily;
  builderLine: string;
  builderVersion?: string | null;
}

/** Inventario completo (con HTML) de un paquete. Nunca lanza por piezas faltantes del paquete: las deja en `issues`. */
export async function buildInventory(pkg: MbzPackage, meta: InventoryMeta): Promise<WorkshopCourse> {
  const raw = await readRawCourse(pkg, meta);
  return buildWorkshopCourse(raw, adapterFor(meta.family));
}

// ─── Fuente del generador (artifacts de la base) ────────────────────────────

/**
 * Tipos de artifact que son FUENTE de algo del paquete. Lista sacada de lo que suben el generador legacy
 * (content/h5p/gamma snapshots, audios) y el dinámico (`dynamic_*` de contenido, examen, video, juego, aplicación).
 */
export const WORKSHOP_SOURCE_TYPES: readonly string[] = Object.freeze([
  'content_snapshot', 'h5p_snapshot', 'gamma_snapshot', 'audio_welcome', 'audiobook',
  'dynamic_content_md', 'dynamic_context_summary_json', 'dynamic_presentation', 'dynamic_video', 'dynamic_video_interactions_json',
  'dynamic_scorm_html', 'dynamic_scorm_manifest', 'dynamic_h5p_params_json', 'dynamic_experience_json', 'dynamic_application_json',
  'dynamic_guided_practice_json', 'dynamic_exam_bank_json', 'dynamic_exam_gift', 'dynamic_module_intro_json', 'dynamic_module_intro_md',
  'dynamic_course_intro_json', 'dynamic_course_intro_md', 'dynamic_audio_mp3',
]);

export interface SourceArtifactRow {
  id: string;
  type: string;
  chapterId: string | null;
  moduleId: string | null;
  itemKey: string | null;
  createdAt: string | null;
}
export interface SourceStructure {
  /** course_chapters del curso: uuid → número global (orden módulo, capítulo) y módulo. */
  chapters: Array<{ id: string; number: number; moduleId: string }>;
  modules: Array<{ id: string; number: number }>;
}

/** Qué tipo de fuente alimenta qué actividades de un capítulo (por rol / clase). */
const CHAPTER_TARGETS: Readonly<Record<string, (a: WorkshopActivity) => boolean>> = Object.freeze({
  dynamic_content_md: (a) => a.role === 'text',
  dynamic_context_summary_json: () => false,
  dynamic_presentation: (a) => a.role === 'presentation',
  dynamic_video: (a) => a.role === 'video',
  dynamic_video_interactions_json: (a) => a.role === 'video',
  dynamic_scorm_html: (a) => a.role === 'game' && a.modname === 'scorm',
  dynamic_scorm_manifest: (a) => a.role === 'game' && a.modname === 'scorm',
  dynamic_h5p_params_json: (a) => a.role === 'game' && a.modname === 'h5pactivity',
  dynamic_experience_json: (a) => a.role === 'game',
  dynamic_application_json: (a) => a.role === 'activity' && /^application/.test(String(a.kind)),
  dynamic_guided_practice_json: (a) => a.role === 'activity' && a.kind === 'guided_practice',
  dynamic_audio_mp3: (a) => a.role === 'audio',
});
const EXAM_TYPES = new Set(['dynamic_exam_bank_json', 'dynamic_exam_gift']);

/**
 * Engancha la fuente: la fila más reciente de cada (tipo, capítulo, módulo, item) — `rows` vienen de la base ordenadas
 * por fecha descendente. Capítulo: por uuid del builder (exacto) o por número global (posición). Módulo / examen: por
 * uuid o por número; examen final por la clave del item. Snapshots del curso (legacy): al capítulo y a sus
 * actividades con la clave del archivo de F (`libro_capN.md`…). Devuelve un curso nuevo (no muta el de entrada).
 */
export function attachSources(course: WorkshopCourse, input: { courseId: number; rows: SourceArtifactRow[]; structure: SourceStructure | null } | { courseId: number; error: string }): WorkshopCourse {
  const c: WorkshopCourse = JSON.parse(stableStringify(course));
  if ('error' in input) {
    c.sourceLookup = { status: 'error', courseId: input.courseId, artifacts: 0, detail: input.error };
    return c;
  }
  const seen = new Set<string>();
  const latest: SourceArtifactRow[] = [];
  for (const r of input.rows) {
    if (!WORKSHOP_SOURCE_TYPES.includes(r.type)) continue;
    const k = `${r.type}|${r.chapterId ?? ''}|${r.moduleId ?? ''}|${r.itemKey ?? ''}`;
    if (seen.has(k)) continue;
    seen.add(k);
    latest.push(r);
  }
  const byMid = new Map(c.activities.map((a) => [a.moduleId, a]));
  const push = (target: { source: WorkshopSourceRef[] | null }, ref: WorkshopSourceRef) => {
    target.source = target.source ?? [];
    if (!target.source.some((s) => s.artifactId === ref.artifactId && s.entryHint === ref.entryHint)) target.source.push(ref);
  };
  const ref = (r: SourceArtifactRow, scope: WorkshopSourceRef['scope'], matchedBy: WorkshopSourceRef['matchedBy'], entryHint: string | null = null): WorkshopSourceRef => ({
    artifactId: r.id, type: r.type, scope, matchedBy, itemKey: r.itemKey, entryHint, createdAt: r.createdAt,
  });
  const chByUuid = new Map(c.chapters.filter((ch) => ch.builderUuid).map((ch) => [ch.builderUuid as string, ch]));
  const chByNum = new Map(c.chapters.map((ch) => [ch.number, ch]));
  const structCh = new Map((input.structure?.chapters ?? []).map((s) => [s.id, s]));
  const structMod = new Map((input.structure?.modules ?? []).map((s) => [s.id, s]));
  const modByUuid = new Map(c.modules.filter((m) => m.builderUuid).map((m) => [m.builderUuid as string, m]));
  let attached = 0;

  for (const r of latest) {
    // Capítulo.
    if (r.chapterId) {
      let ch = chByUuid.get(r.chapterId) ?? null;
      let by: WorkshopSourceRef['matchedBy'] = 'chapter_uuid';
      if (!ch) {
        const s = structCh.get(r.chapterId);
        ch = s ? chByNum.get(s.number) ?? null : null;
        by = 'chapter_position';
      }
      if (!ch) continue;
      const x = ref(r, 'chapter', by);
      push(ch, x);
      const want = CHAPTER_TARGETS[r.type];
      if (want) for (const mid of ch.activities) { const a = byMid.get(mid); if (a && want(a)) push(a, x); }
      attached++;
      continue;
    }
    // Examen final (clave del item).
    if (EXAM_TYPES.has(r.type) && /final/i.test(r.itemKey ?? '')) {
      const finals = c.activities.filter((a) => a.kind === 'final_exam');
      for (const a of finals) push(a, ref(r, 'module', 'item_key'));
      if (finals.length) attached++;
      continue;
    }
    // Módulo.
    if (r.moduleId) {
      let mnum: number | null = modByUuid.get(r.moduleId)?.number ?? null;
      let by: WorkshopSourceRef['matchedBy'] = 'module_uuid';
      if (mnum === null) { mnum = structMod.get(r.moduleId)?.number ?? null; by = 'module_position'; }
      if (mnum === null) continue;
      const kinds = EXAM_TYPES.has(r.type) ? ['exam'] : /module_intro/.test(r.type) ? ['module_intro'] : [];
      const targets = c.activities.filter((a) => kinds.includes(String(a.kind)) && a.unit === mnum);
      for (const a of targets) push(a, ref(r, 'module', by));
      if (targets.length) attached++;
      continue;
    }
    // Curso entero.
    const courseLevel: Array<[(a: WorkshopActivity) => boolean, (a: WorkshopActivity) => string | null]> = [];
    if (r.type === 'content_snapshot') {
      for (const ch of c.chapters) push(ch, ref(r, 'course', 'course', `libro_cap${ch.number}.md`));
      courseLevel.push([(a) => a.kind === 'libro', () => 'libro_guia_completo.html']);
      courseLevel.push([(a) => a.role === 'text' && a.placement.chapterNumber !== null, (a) => `cap${a.placement.chapterNumber}_video_interactivo.html`]);
      courseLevel.push([(a) => a.role === 'game' && a.modname === 'scorm' && a.placement.chapterNumber !== null, (a) => `scorm_cap${a.placement.chapterNumber}_index.html`]);
      courseLevel.push([(a) => a.kind === 'exam' && a.unit !== null, (a) => `examen_unidad${a.unit}.gift`]);
      courseLevel.push([(a) => a.kind === 'final_exam', () => 'examen_final.gift']);
    } else if (r.type === 'h5p_snapshot') courseLevel.push([(a) => a.role === 'video', () => null]);
    else if (r.type === 'gamma_snapshot') courseLevel.push([(a) => a.role === 'presentation', () => null]);
    else if (r.type === 'audio_welcome') courseLevel.push([(a) => a.kind === 'welcome_audio', () => null]);
    else if (r.type === 'audiobook') courseLevel.push([(a) => a.kind === 'audiobook', () => null]);
    else if (/^dynamic_course_intro/.test(r.type)) courseLevel.push([(a) => a.kind === 'welcome' || a.kind === 'competencies', () => null]);
    let any = false;
    for (const [match, hint] of courseLevel) for (const a of c.activities) if (match(a)) { push(a, ref(r, 'course', 'course', hint(a))); any = true; }
    if (any || r.type === 'content_snapshot') attached++;
  }
  c.sourceLookup = {
    status: attached ? 'found' : 'none',
    courseId: input.courseId,
    artifacts: attached,
    detail: attached ? null : 'el curso identificado no tiene fuente guardada que corresponda a este paquete',
  };
  return c;
}

// ─── Persistencia ───────────────────────────────────────────────────────────

/** Tope del inventario persistido en `workshop_sessions.inventory` (jsonb). */
export const INVENTORY_PERSIST_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Forma PERSISTIDA del inventario: todo el modelo, salvo el texto de cada campo HTML (queda su entrada, sha1, largo y
 * archivos referenciados). Decisión B2 (ver B2-report §2): el HTML ya está en el original verificado y el inventario se
 * reconstruye igual (determinista, ~0,1–2 s); guardar el HTML duplicaría hasta decenas de MB por sesión en una fila.
 * Las preguntas de los exámenes sí van completas (son el insumo de B5 y pesan poco).
 */
export function persistableInventory(course: WorkshopCourse): WorkshopCourse & { htmlOmitted: true } {
  const c: WorkshopCourse = JSON.parse(stableStringify(course));
  for (const a of c.activities) for (const h of a.html) (h as { html: string }).html = '';
  return { ...c, htmlOmitted: true };
}
