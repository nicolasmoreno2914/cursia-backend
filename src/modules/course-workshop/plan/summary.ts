/**
 * r107 B5 · Resumen del inventario que ve la IA al interpretar un pedido: títulos, capítulos, roles e ids — NUNCA el
 * paquete ni el HTML de las actividades (solo un extracto corto del enunciado de cada pregunta, para poder nombrarla).
 * Y las utilidades para resolver destinos contra el inventario (candidatos por capítulo / rol, texto del capítulo).
 *
 * Puro.
 */
import { WorkshopActivity, WorkshopCourse, plainText } from '../course-model';

const short = (s: string | null | undefined, n: number): string => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

export const SUMMARY_QUESTIONS_PER_EXAM = 40;

/** Rol legible de una actividad (para el resumen y para los textos al docente). */
export function roleEs(a: Pick<WorkshopActivity, 'role' | 'kind' | 'modname'>): string {
  const byRole: Record<string, string> = { presentation: 'presentación (Gamma)', text: 'texto', video: 'video', cta: 'botón para practicar', game: 'juego (SCORM)', activity: 'actividad', audio: 'audio', unknown: 'sin clasificar' };
  if (a.role) return byRole[a.role] ?? a.role;
  const byKind: Record<string, string> = { welcome: 'bienvenida', libro: 'Libro Guía', libro_info: 'tarjeta del Libro Guía', audiobook: 'audiolibro', welcome_audio: 'audio de bienvenida', exam: 'examen', final_exam: 'examen final', forum: 'foro', closing: 'cierre' };
  return byKind[String(a.kind)] ?? `${a.modname}${a.kind && a.kind !== 'unknown' ? ` · ${a.kind}` : ''}`;
}

/** Resumen compacto (JSON) del curso para el prompt de interpretación. */
export function inventorySummary(course: WorkshopCourse): string {
  const act = (mid: number) => course.activities.find((a) => a.moduleId === mid);
  const line = (a: WorkshopActivity) => ({
    moduleId: a.moduleId,
    tipo: a.modname,
    rol: roleEs(a),
    titulo: short(a.title, 90),
    campos: a.html.map((h) => h.field).filter((f) => f !== 'externalurl').slice(0, 4),
  });
  const out = {
    curso: { titulo: course.course.title, familia: course.family },
    modulos: course.modules.map((m) => ({ numero: m.number, titulo: m.title, capitulos: m.chapterNumbers, examenes: m.examModuleIds })),
    capitulos: course.chapters.map((c) => ({
      numero: c.number,
      titulo: c.title,
      modulo: c.moduleNumber,
      actividades: c.activities.map((mid) => act(mid)).filter((a): a is WorkshopActivity => !!a).map(line),
    })),
    fueraDeCapitulos: course.courseActivities.map((mid) => act(mid)).filter((a): a is WorkshopActivity => !!a && a.modname !== 'quiz').map(line),
    examenes: course.activities.filter((a) => a.modname === 'quiz' && a.exam).map((a) => ({
      moduleId: a.moduleId,
      titulo: short(a.title, 90),
      unidad: a.exam!.unit,
      final: a.exam!.final,
      preguntas: a.exam!.questions.filter((q) => q.qtype === 'multichoice' || q.qtype === 'truefalse').slice(0, SUMMARY_QUESTIONS_PER_EXAM)
        .map((q) => ({ questionId: q.id, tipo: q.qtype, capitulo: q.chapterNumber, enunciado: short(plainText(q.html, 200), 110) })),
      totalPreguntas: a.exam!.questions.length,
    })),
    libro: course.libro.map((l) => ({ moduleId: l.moduleId, formato: l.format })),
  };
  return JSON.stringify(out);
}

export function activityOf(course: WorkshopCourse, mid: unknown): WorkshopActivity | null {
  return typeof mid === 'number' ? course.activities.find((a) => a.moduleId === mid) ?? null : null;
}

/** Actividades de texto editables (label / page) de un capítulo. */
export function chapterTextCandidates(course: WorkshopCourse, chapter: number): WorkshopActivity[] {
  const c = course.chapters.find((x) => x.number === chapter);
  if (!c) return [];
  return c.activities.map((mid) => activityOf(course, mid)).filter((a): a is WorkshopActivity => !!a && !a.missingFolder
    && (a.modname === 'label' || a.modname === 'page') && a.role !== 'cta' && a.html.some((h) => h.field === 'intro' || h.field === 'content'));
}

/** Campo HTML editable de una actividad (page → content; si no, intro). */
export function editableField(a: WorkshopActivity, wanted?: unknown): string | null {
  const fields = a.html.filter((h) => h.field !== 'externalurl');
  if (typeof wanted === 'string' && wanted) return fields.some((h) => h.field === wanted) ? wanted : null;
  if (a.modname === 'page' && fields.some((h) => h.field === 'content')) return 'content';
  if (fields.some((h) => h.field === 'intro')) return 'intro';
  return fields[0]?.field ?? null;
}

/** Actividad del capítulo con un rol dado (para regenerar). */
export function chapterRoleActivities(course: WorkshopCourse, chapter: number, role: 'game' | 'video' | 'presentation' | 'audio'): WorkshopActivity[] {
  const c = course.chapters.find((x) => x.number === chapter);
  if (!c) return [];
  return (c.roles[role] ?? []).map((mid) => activityOf(course, mid)).filter((a): a is WorkshopActivity => !!a);
}

/** Texto plano del capítulo (sus actividades de texto), acotado: contexto mínimo para la generación de contenido. */
export function chapterPlainText(course: WorkshopCourse, chapter: number | null, max: number): string {
  if (chapter === null) return '';
  const c = course.chapters.find((x) => x.number === chapter);
  if (!c) return '';
  const parts: string[] = [];
  for (const mid of c.roles.text ?? []) {
    const a = activityOf(course, mid);
    for (const h of a?.html ?? []) if (h.field !== 'externalurl') parts.push(plainText(h.html, max));
  }
  const t = parts.join('\n').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Título legible de una actividad para el docente («Etiqueta “Bienvenida” — capítulo 2»). */
export function activityLabel(a: WorkshopActivity): string {
  const ch = a.placement.scope === 'chapter' && a.placement.chapterNumber !== null ? ` (capítulo ${a.placement.chapterNumber})` : '';
  return `${roleEs(a)} «${short(a.title, 60)}»${ch}`;
}
