/**
 * r107 B3 · Taller de cursos — checks técnicos T01–T12 (diseño §5). Cada check es una función PURA `(ctx) → Finding[]`
 * sobre el contexto ya leído (context.ts), con id estable y aplicabilidad declarada: por FAMILIA (tabla
 * `CHECK_FAMILY_APPLICABILITY`, para el informe) y por PAQUETE (`applies(ctx)`: un check que no aplica lo dice con el
 * motivo; nunca se silencia).
 *
 * Reglas de severidad (finding.ts): error = se rompe o no se ve para el estudiante; warning = funciona pero falta algo o
 * fallará en otro Moodle; info = dato que no cambia el semáforo.
 *
 * Un defecto, un hallazgo: los checks que leen el CONTENIDO de un archivo solo leen blobs verificados (presentes y con
 * su sha1); un blob faltante o alterado es T02 y no se vuelve a reportar como «Libro truncado» o «audio ilegible».
 */
import { WorkshopFamily } from '../identify';
import { WorkshopActivity, WorkshopToken, plainText } from '../course-model';
import { EXAM_OPTION_FORBIDDEN_RE, normalizeExamText } from '../../course-shell/exam-bank';
import { VIDEO_MC_LONGEST_MAX_SHARE, videoMcLengthBias } from '../../quality/answer-length-bias';
import { DiagnosisContext, blobVerified } from './context';
import { CheckId, Finding, FindingActivityRef, FindingInput, FindingScope, SuggestedFix, makeFinding } from './finding';

export interface CheckDef {
  id: CheckId;
  /** Qué revisa (español, para el informe). */
  title: string;
  /** null = aplica a este paquete; string = por qué no aplica. */
  applies(ctx: DiagnosisContext): string | null;
  run(ctx: DiagnosisContext): Finding[];
}

// ─── Utilidades ─────────────────────────────────────────────────────────────

const CHAPTER_MIN_AUDIOBOOK_FULL = 9;
/** Audiolibro de un curso completo (≥ 9 capítulos): ≥ 25 min (diseño §5 T08). Más chico: 2,5 min por capítulo. */
export const AUDIOBOOK_FULL_MIN_SECONDS = 25 * 60;
export const AUDIOBOOK_PER_CHAPTER_MIN_SECONDS = 150;

const short = (s: string | null | undefined, max = 70): string => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
export const actRef = (a: WorkshopActivity): FindingActivityRef => ({ moduleId: a.moduleId, dir: a.dir, modname: a.modname, title: a.title || '' });

function moduleOfChapter(ctx: DiagnosisContext, n: number | null): number | null {
  if (n === null) return null;
  return ctx.course.chapters.find((c) => c.number === n)?.moduleNumber ?? null;
}
export function scopeOf(ctx: DiagnosisContext, a: WorkshopActivity | null): FindingScope {
  if (!a) return { level: 'course', chapterNumber: null, moduleNumber: null, activity: null };
  const ch = a.placement.scope === 'chapter' ? a.placement.chapterNumber : null;
  return { level: 'activity', chapterNumber: ch, moduleNumber: moduleOfChapter(ctx, ch) ?? a.unit ?? null, activity: actRef(a) };
}
const courseScope = (): FindingScope => ({ level: 'course', chapterNumber: null, moduleNumber: null, activity: null });

/** «“Bienvenida” del capítulo 3» / «“Bienvenida”». */
function where(a: WorkshopActivity | null): string {
  if (!a) return 'del curso';
  const t = short(a.title || kindEs(a.modname), 60);
  const ch = a.placement.scope === 'chapter' && a.placement.chapterNumber !== null ? ` del capítulo ${a.placement.chapterNumber}` : '';
  return `«${t}»${ch}`;
}
/** Nombre legible del tipo de actividad (Moodle). */
const KIND_ES: Record<string, string> = {
  label: 'etiqueta', page: 'página', resource: 'archivo', scorm: 'juego SCORM', quiz: 'examen', hvp: 'video interactivo', h5pactivity: 'actividad H5P',
  forum: 'foro', book: 'libro', url: 'enlace', assign: 'tarea', folder: 'carpeta', section: 'sección', course: 'curso',
};
const kindEs = (m: string | null | undefined): string => KIND_ES[String(m ?? '')] ?? String(m ?? 'actividad');

const isAudioFile = (name: string, mime: string | null): boolean => /\.(mp3|m4a|ogg|oga|wav|aac)$/i.test(name) || /^audio\//.test(mime ?? '');

/** Operación sugerida para REGENERAR lo que una actividad es (por su rol / clase), o null si no hay arreglo automático. */
function regenerateFixFor(a: WorkshopActivity | null): SuggestedFix | null {
  if (!a) return null;
  const ch = a.placement.scope === 'chapter' ? a.placement.chapterNumber : null;
  if (a.role === 'game' && a.modname === 'scorm') return { operation: 'regenerate_scorm', params: { moduleId: a.moduleId, chapterNumber: ch } };
  if (a.role === 'video') return { operation: 'regenerate_video', params: { moduleId: a.moduleId, chapterNumber: ch } };
  if (a.role === 'presentation') return { operation: 'regenerate_gamma', params: { moduleId: a.moduleId, chapterNumber: ch } };
  if (a.kind === 'audiobook' || a.role === 'audio') return { operation: 'regenerate_audio', params: { target: 'audiobook', moduleId: a.moduleId } };
  if (a.kind === 'welcome_audio') return { operation: 'regenerate_audio', params: { target: 'welcome', moduleId: a.moduleId } };
  if (a.kind === 'libro') return { operation: 'edit_libro_section', params: { moduleId: a.moduleId, section: 'all' } };
  return null;
}

/** Texto visible del enlace que usa `token` en el HTML (para nombrar el botón), o null. */
function linkTextOf(html: string, token: string): string | null {
  const esc = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`<a\\b[^>]*href=["'][^"']*${esc}[^"']*["'][^>]*>([\\s\\S]*?)</a>`, 'i').exec(html);
  const t = m ? plainText(m[1], 80) : '';
  return t || null;
}

const f = (i: FindingInput): Finding => makeFinding(i);

// ─── T01 · el paquete abre y lista lo que trae ───────────────────────────────

function t01(ctx: DiagnosisContext): Finding[] {
  const out: Finding[] = [];
  const c = ctx.course;
  if (!c.activities.length) {
    out.push(f({ check: 'T01', code: 'no_activities', severity: 'error', scope: courseScope(),
      title: 'El paquete no trae ninguna actividad: al restaurarlo, el curso queda vacío.',
      detail: 'moodle_backup.xml no lista ninguna <activity>.', evidence: { entry: 'moodle_backup.xml' } }));
  }
  for (const i of c.issues) {
    const a = ctx.actByDir.get(i.target) ?? null;
    switch (i.code) {
      case 'listed_missing_folder':
        out.push(f({ check: 'T01', code: 'listed_missing_folder', severity: 'error', scope: scopeOf(ctx, a),
          title: `La actividad ${where(a)} está en el índice del curso pero no viene en el paquete: Moodle no la puede restaurar.`,
          detail: `${i.target}: ${i.detail}`, evidence: { entry: 'moodle_backup.xml', excerpt: i.target },
          suggestedFix: a ? { operation: 'remove_activity', params: { moduleId: a.moduleId } } : null }));
        break;
      case 'xml_unreadable':
        out.push(f({ check: 'T01', code: 'xml_unreadable', severity: 'error', scope: scopeOf(ctx, a),
          title: `A la actividad ${a ? where(a) : i.target} le falta una parte del paquete: no se restaura completa.`,
          detail: `${i.target}: ${i.detail}`, evidence: { entry: i.target },
          suggestedFix: a ? regenerateFixFor(a) ?? { operation: 'remove_activity', params: { moduleId: a.moduleId } } : null }));
        break;
      case 'section_missing':
        out.push(f({ check: 'T01', code: 'section_missing', severity: 'error', scope: courseScope(),
          title: 'Falta una sección del curso dentro del paquete: sus actividades quedan fuera de lugar al restaurar.',
          detail: `${i.target}: ${i.detail}`, evidence: { entry: i.target } }));
        break;
      case 'files_xml_missing':
        out.push(f({ check: 'T01', code: 'files_xml_missing', severity: 'error', scope: courseScope(),
          title: 'El paquete no trae el índice de archivos: imágenes, audios y documentos no se restauran.',
          detail: i.detail, evidence: { entry: 'files.xml' } }));
        break;
      case 'questions_xml_unreadable':
        out.push(f({ check: 'T01', code: 'questions_unreadable', severity: 'error', scope: courseScope(),
          title: 'Las preguntas de los exámenes no se pueden leer: los exámenes se restaurarían vacíos.',
          detail: i.detail, evidence: { entry: 'questions.xml' } }));
        break;
      case 'unlisted_folder':
        out.push(f({ check: 'T01', code: 'unlisted_folder', severity: 'warning', scope: courseScope(),
          title: 'El paquete trae una actividad que el índice del curso no nombra: Moodle la ignora al restaurar.',
          detail: `${i.target}: ${i.detail}`, evidence: { entry: i.target },
          key: i.target }));
        break;
      case 'not_in_sequence':
      case 'sequence_unknown_module':
        out.push(f({ check: 'T01', code: i.code, severity: 'warning', scope: scopeOf(ctx, a),
          title: i.code === 'not_in_sequence'
            ? `La actividad ${where(a)} no está en el orden de ninguna sección: Moodle la puede mostrar al final o fuera de lugar.`
            : 'Una sección del curso nombra una actividad que el paquete no trae.',
          detail: `${i.target}: ${i.detail}`, evidence: { entry: i.target }, key: i.target }));
        break;
      default:
        break; // duplicate_moduleid / moduleid_mismatch → T03
    }
  }
  return out;
}

// ─── T02 · archivos: cada archivo con su contenido y su huella ───────────────

function t02(ctx: DiagnosisContext): Finding[] {
  const out: Finding[] = [];
  for (const { file, owner } of ctx.files) {
    if (file.filename === '.' || !file.contenthash) continue;
    const b = ctx.blobs.get(file.contenthash);
    const ev = { entry: file.blobEntry || 'files.xml', file: { fileId: file.fileId, component: file.component, filearea: file.filearea, filename: file.filename, contenthash: file.contenthash } };
    const fix = regenerateFixFor(owner);
    if (!/^[0-9a-f]{40}$/.test(file.contenthash)) {
      out.push(f({ check: 'T02', code: 'bad_contenthash', severity: 'error', scope: scopeOf(ctx, owner),
        title: `El archivo «${short(file.filename)}» de ${where(owner)} tiene una huella inválida: Moodle no lo encuentra al restaurar.`,
        detail: `files.xml file ${file.fileId}: contenthash «${file.contenthash}» no es un sha1`, evidence: ev, suggestedFix: fix }));
      continue;
    }
    if (!b || !b.present) {
      out.push(f({ check: 'T02', code: 'blob_missing', severity: 'error', scope: scopeOf(ctx, owner),
        title: `Falta el archivo «${short(file.filename)}» de ${where(owner)}: no se verá al restaurar el curso.`,
        detail: `files.xml file ${file.fileId} (${file.component}/${file.filearea}${file.filepath}${file.filename}) declara ${file.blobEntry}, que no está en el paquete`,
        evidence: ev, suggestedFix: fix }));
      continue;
    }
    if (b.unread) {
      out.push(f({ check: 'T02', code: 'blob_unverified', severity: 'warning', scope: scopeOf(ctx, owner),
        title: `No se pudo comprobar el archivo «${short(file.filename)}» de ${where(owner)}.`,
        detail: `${file.blobEntry}: ${b.unread}`, evidence: ev }));
      continue;
    }
    if (b.sha1 !== file.contenthash) {
      out.push(f({ check: 'T02', code: 'blob_altered', severity: 'error', scope: scopeOf(ctx, owner),
        title: `El archivo «${short(file.filename)}» de ${where(owner)} está dañado (su contenido no coincide con su huella): Moodle lo puede rechazar o mostrar mal.`,
        detail: `${file.blobEntry}: sha1 real ${b.sha1} ≠ contenthash ${file.contenthash}`, evidence: ev, suggestedFix: fix }));
      continue;
    }
    if (file.filesize !== b.size) {
      out.push(f({ check: 'T02', code: 'filesize_mismatch', severity: 'warning', scope: scopeOf(ctx, owner),
        title: `El tamaño declarado del archivo «${short(file.filename)}» de ${where(owner)} no coincide con el real.`,
        detail: `files.xml file ${file.fileId}: filesize ${file.filesize} ≠ ${b.size} bytes`, evidence: ev }));
    }
  }
  if (ctx.undeclaredBlobs.length) {
    out.push(f({ check: 'T02', code: 'undeclared_blobs', severity: 'info', scope: courseScope(),
      title: `El paquete trae ${ctx.undeclaredBlobs.length} archivo(s) que ninguna actividad usa (ocupan espacio, no se ven).`,
      detail: `entradas de files/ sin <file> en files.xml: ${ctx.undeclaredBlobs.slice(0, 5).join(', ')}${ctx.undeclaredBlobs.length > 5 ? '…' : ''}`,
      evidence: { entry: ctx.undeclaredBlobs[0] } }));
  }
  if (ctx.malformedBlobPaths.length) {
    out.push(f({ check: 'T02', code: 'malformed_blob_path', severity: 'info', scope: courseScope(),
      title: `El paquete trae ${ctx.malformedBlobPaths.length} archivo(s) guardados fuera de lugar (Moodle no los usa).`,
      detail: `entradas de files/ con ruta distinta de files/<sha1[:2]>/<sha1>: ${ctx.malformedBlobPaths.slice(0, 5).join(', ')}`,
      evidence: { entry: ctx.malformedBlobPaths[0] } }));
  }
  return out;
}

// ─── T03 · ids únicos ────────────────────────────────────────────────────────

function t03(ctx: DiagnosisContext): Finding[] {
  const out: Finding[] = [];
  for (const i of ctx.course.issues) {
    if (i.code !== 'duplicate_moduleid' && i.code !== 'moduleid_mismatch') continue;
    const a = ctx.actByDir.get(i.target) ?? null;
    out.push(f({ check: 'T03', code: i.code, severity: 'error', scope: scopeOf(ctx, a),
      title: `La actividad ${where(a)} tiene un identificador repetido o contradictorio: Moodle puede mezclarla con otra o no restaurarla.`,
      detail: `${i.target}: ${i.detail}`, evidence: { entry: a ? `${a.dir}/module.xml` : i.target } }));
  }
  const dupOf = <T,>(xs: T[]) => [...new Set(xs.filter((x, i) => xs.indexOf(x) !== i))];
  const acts = ctx.course.activities.filter((a) => a.contextId !== null && !a.missingFolder);
  for (const cid of dupOf(acts.map((a) => a.contextId as number))) {
    const same = acts.filter((a) => a.contextId === cid);
    const a = same[same.length - 1];
    out.push(f({ check: 'T03', code: 'duplicate_contextid', severity: 'error', scope: scopeOf(ctx, a),
      title: `La actividad ${where(a)} comparte su contexto con otra: sus archivos se pueden mezclar al restaurar.`,
      detail: `contextid ${cid} en ${same.map((x) => x.dir).join(', ')}`, evidence: { entry: `${a.dir}/${a.modname}.xml` } }));
  }
  const ids = ctx.files.map((x) => x.file.fileId);
  for (const id of dupOf(ids)) {
    out.push(f({ check: 'T03', code: 'duplicate_file_id', severity: 'error', scope: courseScope(),
      title: 'Dos archivos del curso tienen el mismo identificador: uno de los dos se pierde al restaurar.',
      detail: `files.xml: file id ${id} repetido`, evidence: { entry: 'files.xml' }, key: String(id) }));
  }
  const secIds = ctx.course.sections.map((s) => s.id).filter((x) => x >= 0);
  for (const id of dupOf(secIds)) {
    out.push(f({ check: 'T03', code: 'duplicate_section_id', severity: 'error', scope: courseScope(),
      title: 'Dos secciones del curso tienen el mismo identificador: Moodle puede juntar sus actividades.',
      detail: `section id ${id} repetido`, evidence: { entry: 'moodle_backup.xml' }, key: String(id) }));
  }
  return out;
}

// ─── T04 · tokens de Moodle y enlaces ────────────────────────────────────────

const LIBRO_BUTTON = /libro\s+gu[ií]a/i;

function tokenFinding(ctx: DiagnosisContext, owner: WorkshopActivity | null, t: WorkshopToken, html: string, sectionId: number | null): Finding | null {
  const link = linkTextOf(html, t.token);
  const button = link ? `El botón «${short(link, 50)}»` : 'Un enlace';
  const loc = owner ? `de ${where(owner)}` : sectionId !== null ? 'de la presentación de una sección' : 'de la descripción del curso';
  const target = t.targetModuleId !== null ? ctx.actByMid.get(t.targetModuleId) ?? null : null;
  const base = { scope: scopeOf(ctx, owner), evidence: { entry: t.entry, excerpt: link ? `${link} → ${t.token}` : t.token, token: t.token }, key: `${t.field}|${t.rawByteOffsets[0] ?? ''}` };
  const editParams = (replaceWith: string | null) => ({ moduleId: owner?.moduleId ?? null, sectionId, field: t.field, entry: t.entry, token: t.token, replaceWith });
  if (t.status === 'orphan' || t.status === 'wrong_type') {
    // El Libro Guía: el bug histórico del botón «Descargar Libro Guía» → label (changelog #6 de CLAUDE.md).
    const libro = ctx.course.activities.find((a) => a.kind === 'libro' && a.modname === 'resource');
    const isLibro = t.kind === 'RESOURCEVIEWBYID' && (LIBRO_BUTTON.test(link ?? '') || owner?.kind === 'libro_info' || LIBRO_BUTTON.test(plainText(html, 2000)));
    if (isLibro) {
      return f({ ...base, check: 'T04', code: `token_${t.status}`, severity: 'error',
        title: `${button} ${loc} no abre el Libro Guía${t.status === 'wrong_type' && target ? ` (lleva a ${kindEs(target.modname)} «${short(target.title, 40)}»)` : ''}.`,
        detail: `${t.entry} (${t.field}): ${t.token} — ${t.status === 'orphan' ? 'no existe ninguna actividad con ese id' : `exige ${t.expected}, el id ${t.targetId} es ${t.actual}`}`,
        suggestedFix: { operation: 'edit_html', params: editParams(libro ? `$@RESOURCEVIEWBYID*${libro.moduleId}@$` : null) } });
    }
    return f({ ...base, check: 'T04', code: `token_${t.status}`, severity: 'error',
      title: t.status === 'orphan'
        ? `${button} ${loc} lleva a una actividad que no existe en el curso: al restaurar no abre nada.`
        : `${button} ${loc} lleva a ${target ? `${kindEs(target.modname)} «${short(target.title, 40)}»` : 'otra cosa'} en vez de ${kindEs(t.expected)}: al restaurar falla o abre lo que no es.`,
      detail: `${t.entry} (${t.field}): ${t.token} — ${t.status === 'orphan' ? 'no existe ninguna actividad con ese id' : `exige ${t.expected}, el id ${t.targetId} es ${t.actual}`}`,
      suggestedFix: { operation: 'edit_html', params: editParams(null) } });
  }
  if (t.status === 'malformed') {
    return f({ ...base, check: 'T04', code: 'token_malformed', severity: 'error',
      title: `${button} ${loc} tiene la dirección rota: Moodle la deja como texto y no abre nada.`,
      detail: `${t.entry} (${t.field}): token sin cerrar «${t.token}${t.context ? ` …${t.context}` : ''}» (p. ej. el bug de \`$&\` en String.replace)`,
      suggestedFix: { operation: 'edit_html', params: editParams(null) } });
  }
  if (t.status === 'external') {
    return f({ ...base, check: 'T04', code: 'token_external', severity: 'warning',
      title: `${button} ${loc} es un enlace a otro curso del sitio original: no funcionará al restaurar en otro Moodle.`,
      detail: `${t.entry} (${t.field}): ${t.token} apunta al curso ${t.targetId}; el curso de este backup es ${ctx.course.course.originalCourseId}. Moodle no mapea ids de otros cursos al restaurar.`,
      suggestedFix: { operation: 'edit_html', params: editParams(null) } });
  }
  if (t.anchor && t.anchor.status === 'orphan') {
    return f({ ...base, check: 'T04', code: 'anchor_orphan', severity: 'warning',
      title: `${button} ${loc} lleva a una parte del curso que no existe en el paquete.`,
      detail: `${t.entry} (${t.field}): ${t.token}#${t.anchor.type}-${t.anchor.id} — no hay ${t.anchor.type === 'module' ? 'actividad' : 'sección'} ${t.anchor.id}`,
      suggestedFix: { operation: 'edit_html', params: editParams(null) } });
  }
  return null;
}

/** true si el paquete TIENE Libro Guía (con Libro, el botón muerto de la tarjeta sí es un hallazgo de T04). */
const hasLibroActivity = (ctx: DiagnosisContext): boolean => ctx.course.activities.some((a) => a.kind === 'libro' && !a.missingFolder);

const DEAD_LINK = /<a\b[^>]*\bhref\s*=\s*(["'])\s*(#?|javascript:[^"']*)\s*\1[^>]*>([\s\S]*?)<\/a>/gi;

function t04(ctx: DiagnosisContext): Finding[] {
  const out: Finding[] = [];
  const seen = new Set<string>();
  const htmlOf = (fields: Array<{ field: string; html: string }>, field: string) => fields.find((h) => h.field === field)?.html ?? '';
  for (const a of ctx.course.activities) {
    const fields = [...a.html];
    for (const t of a.tokens) {
      // Una pregunta compartida aporta sus tokens a cada examen: se reporta una vez (en el primero).
      const k = `${t.entry}|${t.field}|${t.token}|${t.rawByteOffsets.join(',')}`;
      if (t.entry === 'questions.xml' && seen.has(k)) continue;
      seen.add(k);
      const x = tokenFinding(ctx, a, t, htmlOf(fields, t.field), null);
      if (x) out.push(x);
    }
    // Enlaces muertos (href="#", vacío, javascript:): un token saneado o inventado — el botón no hace nada.
    for (const h of a.html) {
      for (const m of h.html.matchAll(DEAD_LINK)) {
        const text = plainText(m[3], 60);
        // El botón del Libro Guía en la tarjeta del Libro, cuando el paquete NO trae el Libro: es T07 (libro_missing).
        if (a.kind === 'libro_info' && LIBRO_BUTTON.test(text) && !hasLibroActivity(ctx)) continue;
        out.push(f({ check: 'T04', code: 'dead_link', severity: 'warning', scope: scopeOf(ctx, a),
          title: `${text ? `El botón «${short(text, 50)}»` : 'Un enlace'} de ${where(a)} no lleva a ningún lado.`,
          detail: `${h.entry} (${h.field}): href=${m[1]}${m[2]}${m[1]} — destino que el builder no pudo resolver (saneado a #) o enlace inventado`,
          evidence: { entry: h.entry, excerpt: m[0].slice(0, 160) }, key: `${h.field}|${m.index ?? 0}`,
          suggestedFix: { operation: 'edit_html', params: { moduleId: a.moduleId, field: h.field, entry: h.entry, deadLinkIndex: m.index ?? 0, replaceWith: null } } }));
      }
    }
  }
  for (const s of ctx.course.sections) {
    for (const t of s.tokens) { const x = tokenFinding(ctx, null, t, s.html.find((h) => h.field === t.field)?.html ?? '', s.id); if (x) out.push(x); }
  }
  for (const t of ctx.course.courseSummary.tokens) { const x = tokenFinding(ctx, null, t, ctx.course.courseSummary.html.find((h) => h.field === t.field)?.html ?? '', null); if (x) out.push(x); }
  return out;
}

// ─── T05 · nada «⚠️ Pendiente» ni actividades vacías ─────────────────────────

/** El marcador que dejan los builders cuando algo no se generó. Con el emoji: «pendiente de la recta» no cuenta. */
export const PENDING_MARK = /⚠️?\s*Pendiente\b/;
const MEDIA_TAG = /<(img|iframe|audio|video|embed|object|svg|picture|canvas)\b/i;

function t05(ctx: DiagnosisContext): Finding[] {
  const out: Finding[] = [];
  for (const a of ctx.course.activities) {
    if (a.missingFolder) continue;
    if (a.pending) {
      out.push(f({ check: 'T05', code: 'pending_activity', severity: 'error', scope: scopeOf(ctx, a),
        title: `La actividad ${where(a)} quedó sin generar: el estudiante ve el aviso «⚠️ Pendiente».`,
        detail: `${a.dir}: placeholder «⚠️ Pendiente: ${a.pending}» (${a.evidence})`, evidence: { entry: `${a.dir}/${a.modname}.xml`, excerpt: a.title },
        suggestedFix: regenerateFixFor(a) ?? { operation: 'edit_html', params: { moduleId: a.moduleId, field: 'intro' } } }));
      continue;
    }
    const pend = a.html.find((h) => PENDING_MARK.test(h.html));
    if (pend) {
      const at = pend.html.search(PENDING_MARK);
      out.push(f({ check: 'T05', code: 'pending_mark', severity: 'error', scope: scopeOf(ctx, a),
        title: `${where(a).replace(/^«/, 'En «')} se ve el aviso «⚠️ Pendiente»: una parte del contenido no se generó.`,
        detail: `${pend.entry} (${pend.field}): marcador «⚠️ Pendiente» en el HTML`, evidence: { entry: pend.entry, excerpt: plainText(pend.html.slice(Math.max(0, at - 20), at + 140), 160) },
        suggestedFix: regenerateFixFor(a) ?? { operation: 'edit_html', params: { moduleId: a.moduleId, field: pend.field, entry: pend.entry } } }));
      continue;
    }
    if (a.modname === 'label' || a.modname === 'page') {
      const visible = a.html.some((h) => plainText(h.html, 50).length > 0 || MEDIA_TAG.test(h.html));
      // V1: la página del video con solo la marca `<!-- HVP:N -->` (16-mbz-patch.js nunca insertó el video).
      const hvpMark = !visible ? a.html.map((h) => /<!--\s*HVP:(\d+)\s*-->/.exec(h.html)).find((m) => m) : null;
      if (hvpMark) {
        out.push(f({ check: 'T05', code: 'video_not_embedded', severity: 'warning', scope: scopeOf(ctx, a),
          title: `La página del video ${where(a)} quedó sin el video: solo tiene la marca del lugar donde iba (se ve en blanco).`,
          detail: `${a.dir}: el HTML es solo «${hvpMark[0]}» — el video interactivo del capítulo ${hvpMark[1]} nunca se insertó`,
          evidence: { entry: `${a.dir}/${a.modname}.xml`, excerpt: hvpMark[0] },
          suggestedFix: { operation: 'regenerate_video', params: { chapterNumber: a.placement.scope === 'chapter' ? a.placement.chapterNumber : Number(hvpMark[1]), labelModuleId: a.moduleId } } }));
      } else if (!visible) {
        out.push(f({ check: 'T05', code: 'empty_activity', severity: 'warning', scope: scopeOf(ctx, a),
          title: `La ${kindEs(a.modname)} ${where(a)} está vacía: en el curso se ve un espacio en blanco.`,
          detail: `${a.dir}: ${a.html.map((h) => `${h.field} ${h.length} car.`).join(', ') || 'sin campos HTML'} sin texto ni medios`,
          evidence: { entry: `${a.dir}/${a.modname}.xml` }, suggestedFix: { operation: 'remove_activity', params: { moduleId: a.moduleId } } }));
      }
    }
    if (a.modname === 'resource' && !a.files.some((x) => x.filearea === 'content' && x.filename !== '.')) {
      out.push(f({ check: 'T05', code: 'empty_resource', severity: 'error', scope: scopeOf(ctx, a),
        title: `El archivo ${where(a)} no trae ningún documento: al abrirlo no hay nada.`,
        detail: `${a.dir}: mod_resource sin archivos en el área content`, evidence: { entry: `${a.dir}/resource.xml` },
        suggestedFix: regenerateFixFor(a) ?? { operation: 'remove_activity', params: { moduleId: a.moduleId } } }));
    }
  }
  return out;
}

// ─── T06 · juegos SCORM ──────────────────────────────────────────────────────

function t06(ctx: DiagnosisContext): Finding[] {
  const out: Finding[] = [];
  for (const a of ctx.course.activities.filter((x) => x.modname === 'scorm' && !x.missingFolder)) {
    const sc = ctx.scorm.get(a.moduleId);
    const fix: SuggestedFix = { operation: 'regenerate_scorm', params: { moduleId: a.moduleId, chapterNumber: a.placement.scope === 'chapter' ? a.placement.chapterNumber : null } };
    const ev = (name: string | null) => {
      const file = name && sc?.fileOf.get(name);
      return { entry: file ? file.blobEntry : `${a.dir}/scorm.xml`, file: file ? { fileId: file.fileId, component: file.component, filearea: file.filearea, filename: file.filename, contenthash: file.contenthash } : null };
    };
    // Archivos dañados o faltantes del SCORM ya son T02: acá solo lo que se puede leer.
    const contentFiles = a.files.filter((x) => x.filearea === 'content' && x.filename !== '.');
    if (contentFiles.some((x) => !blobVerified(ctx, x.contenthash)) || (!contentFiles.length && a.files.some((x) => x.filearea === 'package' && x.filename !== '.' && !blobVerified(ctx, x.contenthash)))) continue;
    if (!sc || sc.source === 'none') {
      out.push(f({ check: 'T06', code: 'scorm_empty', severity: 'error', scope: scopeOf(ctx, a),
        title: `El juego ${where(a)} no trae sus archivos: al abrirlo no carga nada.`,
        detail: `${a.dir}: sin área content ni paquete (package)`, evidence: ev(null), suggestedFix: fix }));
      continue;
    }
    if (sc.problem && !sc.manifest) {
      out.push(f({ check: 'T06', code: 'scorm_unreadable', severity: 'error', scope: scopeOf(ctx, a),
        title: `El juego ${where(a)} no se puede abrir (su paquete está dañado).`,
        detail: `${a.dir}: ${sc.problem}`, evidence: ev(null), suggestedFix: fix }));
      continue;
    }
    if (!sc.manifest) {
      out.push(f({ check: 'T06', code: 'scorm_no_manifest', severity: 'error', scope: scopeOf(ctx, a),
        title: `Al juego ${where(a)} le falta su archivo de configuración: Moodle no lo puede iniciar.`,
        detail: `${a.dir} (${sc.source}): sin imsmanifest.xml en la raíz`, evidence: ev(null), suggestedFix: fix }));
      continue;
    }
    const href = /<resource\b[^>]*\bhref\s*=\s*"([^"]+)"/i.exec(sc.manifest)?.[1] ?? null;
    if (!/<manifest\b/i.test(sc.manifest) || !href) {
      out.push(f({ check: 'T06', code: 'scorm_bad_manifest', severity: 'error', scope: scopeOf(ctx, a),
        title: `El archivo de configuración del juego ${where(a)} está incompleto: Moodle no sabe qué abrir.`,
        detail: `${a.dir}: imsmanifest.xml sin <manifest> o sin <resource href>`, evidence: { ...ev('imsmanifest.xml'), excerpt: sc.manifest.slice(0, 160) }, suggestedFix: fix }));
      continue;
    }
    const launch = decodeURIComponent(href.split(/[?#]/)[0]).replace(/^\.?\//, '');
    if (!sc.files.includes(launch)) {
      out.push(f({ check: 'T06', code: 'scorm_launch_missing', severity: 'error', scope: scopeOf(ctx, a),
        title: `El juego ${where(a)} no trae la página con la que empieza: al abrirlo da error.`,
        detail: `${a.dir}: imsmanifest.xml lanza «${launch}», que no está en el SCORM (${sc.files.slice(0, 6).join(', ')})`, evidence: ev('imsmanifest.xml'), suggestedFix: fix }));
      continue;
    }
    const pendingIn = [...sc.html.entries()].find(([, h]) => PENDING_MARK.test(h));
    if (pendingIn) {
      const at = pendingIn[1].search(PENDING_MARK);
      out.push(f({ check: 'T06', code: 'scorm_pending', severity: 'error', scope: scopeOf(ctx, a),
        title: `El juego ${where(a)} quedó sin generar: muestra el aviso «⚠️ Pendiente» en lugar del juego.`,
        detail: `${a.dir}: «⚠️ Pendiente» en ${pendingIn[0]}`, evidence: { ...ev(pendingIn[0]), excerpt: plainText(pendingIn[1].slice(at, at + 200), 160) }, suggestedFix: fix }));
      continue;
    }
    const html = sc.html.get(launch);
    if (html !== undefined) {
      const hasJs = /<script\b/i.test(html) || sc.files.some((x) => /\.js$/i.test(x));
      if (!hasJs) {
        out.push(f({ check: 'T06', code: 'scorm_no_js', severity: 'error', scope: scopeOf(ctx, a),
          title: `El juego ${where(a)} no trae su lógica (programa): se ve la pantalla pero no se puede jugar.`,
          detail: `${a.dir}: ${launch} sin <script> y sin archivos .js`, evidence: ev(launch), suggestedFix: fix }));
      } else if (/<\/html>/i.test(html) && /\S/.test(html.slice(html.toLowerCase().lastIndexOf('</html>') + 7).replace(/<script\b[\s\S]*?<\/script>/gi, ''))) {
        // Texto DESPUÉS de </html> (restos de la generación: ``` y el manifiesto pegados): el navegador lo muestra al final.
        const tailTxt = html.slice(html.toLowerCase().lastIndexOf('</html>') + 7);
        out.push(f({ check: 'T06', code: 'scorm_trailing_text', severity: 'warning', scope: scopeOf(ctx, a),
          title: `El juego ${where(a)} muestra texto sobrante al final de la pantalla (restos de cuando se generó).`,
          detail: `${a.dir}: ${launch} tiene ${tailTxt.trim().length} caracteres después de </html>`, evidence: { ...ev(launch), excerpt: tailTxt.trim().slice(0, 120) }, suggestedFix: fix }));
      } else if (!/<\/html>/i.test(html)) {
        // Sin `</html>` en NINGÚN lugar (un <script> agregado DESPUÉS de </html> por un parche no es un corte).
        out.push(f({ check: 'T06', code: 'scorm_truncated', severity: 'error', scope: scopeOf(ctx, a),
          title: `El juego ${where(a)} está cortado (su página no termina): puede no cargar o quedarse a la mitad.`,
          detail: `${a.dir}: ${launch} no tiene </html> (la generación se cortó)`, evidence: { ...ev(launch), excerpt: html.slice(-120) }, suggestedFix: fix }));
      }
    }
  }
  return out;
}

// ─── T07 · Libro Guía completo ───────────────────────────────────────────────

/** Números de capítulo que el Libro nombra en sus títulos (h1–h3): «Capítulo 3», «Cap 3», «Capitulo 3». */
export function libroChapterNumbers(html: string): Set<number> {
  const out = new Set<number>();
  for (const m of html.matchAll(/<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1>/gi)) {
    const t = plainText(m[2], 200);
    const c = /^\s*(?:\d+(?:\.\d+)*\s*[.)-]?\s*)?Cap(?:[ií]tulo|\.)?\s*(\d{1,3})\b/i.exec(t);
    if (c) out.add(Number(c[1]));
  }
  return out;
}

function t07(ctx: DiagnosisContext): Finding[] {
  const out: Finding[] = [];
  const libros = ctx.course.activities.filter((a) => a.kind === 'libro' && !a.missingFolder);
  const chapters = ctx.course.chapters.map((c) => c.number);
  if (!libros.length) {
    // Una tarjeta / botón del Libro Guía sin Libro Guía en el paquete (changelog #6: el botón quedaba muerto).
    const card = ctx.course.activities.find((a) => a.kind === 'libro_info' || a.kind === 'libro_mobile');
    if (card && card.kind === 'libro_info') {
      const dead = card.html.some((h) => [...h.html.matchAll(DEAD_LINK)].some((m) => LIBRO_BUTTON.test(plainText(m[3], 60))));
      out.push(f({ check: 'T07', code: 'libro_missing', severity: 'warning', scope: scopeOf(ctx, card),
        title: `El curso anuncia el Libro Guía en ${where(card)}, pero el paquete no trae el Libro Guía${dead ? ': su botón de descarga no lleva a ningún lado' : ''}.`,
        detail: `${card.dir}: kind libro_info sin ninguna actividad libro (resource / page) en el paquete${dead ? '; el botón del Libro tiene href="#" (changelog #6 de CLAUDE.md)' : ''}`, evidence: { entry: `${card.dir}/${card.modname}.xml`, excerpt: plainText(card.html[0]?.html ?? '', 160) },
        suggestedFix: { operation: 'edit_libro_section', params: { section: 'all', create: true } } }));
    }
    return out;
  }
  for (const a of libros) {
    const fix: SuggestedFix = { operation: 'edit_libro_section', params: { moduleId: a.moduleId, section: 'all' } };
    if (a.modname === 'resource') {
      const main = a.files.filter((x) => x.filearea === 'content' && x.filename !== '.');
      const lf = main.find((x) => /\.html?$/i.test(x.filename)) ?? main.find((x) => /\.pdf$/i.test(x.filename)) ?? main[0];
      if (!lf || !blobVerified(ctx, lf.contenthash)) continue; // sin archivo → T05; faltante / dañado → T02
      const evFile = { fileId: lf.fileId, component: lf.component, filearea: lf.filearea, filename: lf.filename, contenthash: lf.contenthash };
      const b = ctx.blobs.get(lf.contenthash)!;
      if (/\.pdf$/i.test(lf.filename) || lf.mimetype === 'application/pdf') {
        const okHead = !!b.head && b.head.subarray(0, 5).toString('latin1') === '%PDF-';
        const okTail = !!b.tail && /%%EOF\s*$/.test(b.tail.subarray(-32).toString('latin1'));
        if (!okHead || !okTail) {
          out.push(f({ check: 'T07', code: 'libro_pdf_truncated', severity: 'error', scope: scopeOf(ctx, a),
            title: 'El PDF del Libro Guía está cortado o dañado: no abre o se ve incompleto.',
            detail: `${lf.blobEntry} (${lf.filename}): ${!okHead ? 'no empieza en %PDF-' : 'no cierra en %%EOF (truncado)'}`, evidence: { entry: lf.blobEntry, file: evFile }, suggestedFix: null }));
        }
        continue;
      }
      if (!/\.html?$/i.test(lf.filename)) continue;
      const html = ctx.texts.get(lf.contenthash);
      if (html === undefined) continue;
      if (!/<\/html>\s*$/i.test(html)) {
        out.push(f({ check: 'T07', code: 'libro_truncated', severity: 'error', scope: scopeOf(ctx, a),
          title: 'El Libro Guía está cortado: el documento termina a la mitad y le faltan capítulos.',
          detail: `${lf.blobEntry} (${lf.filename}): ${html.length} caracteres, no cierra en </html> (capítulos nombrados: ${[...libroChapterNumbers(html)].join(', ') || 'ninguno'})`,
          evidence: { entry: lf.blobEntry, file: evFile, excerpt: html.slice(-120) }, suggestedFix: fix }));
        continue;
      }
      out.push(...libroChapterFindings(ctx, a, html, chapters, { entry: lf.blobEntry, file: evFile }, fix));
    } else if (a.modname === 'page') {
      const h = a.html.find((x) => x.field === 'content');
      if (h) out.push(...libroChapterFindings(ctx, a, h.html, chapters, { entry: h.entry }, fix));
    } else if (a.modname === 'book') {
      for (const h of a.html.filter((x) => x.field.startsWith('chapter:'))) {
        if (!plainText(h.html, 20)) {
          out.push(f({ check: 'T07', code: 'libro_book_empty_chapter', severity: 'warning', scope: scopeOf(ctx, a),
            title: 'Un capítulo del Libro Guía en línea está vacío.', detail: `${h.entry} (${h.field}): sin texto`, evidence: { entry: h.entry }, key: h.field, suggestedFix: fix }));
        }
      }
    }
  }
  return out;
}

function libroChapterFindings(ctx: DiagnosisContext, a: WorkshopActivity, html: string, chapters: number[], ev: { entry: string; file?: Finding['evidence']['file'] }, fix: SuggestedFix): Finding[] {
  if (!chapters.length) return [];
  const named = libroChapterNumbers(html);
  if (!named.size) {
    return [f({ check: 'T07', code: 'libro_chapters_unverified', severity: 'info', scope: scopeOf(ctx, a),
      title: 'No se pudo comprobar que el Libro Guía tenga todos los capítulos (no los titula como «Capítulo N»).',
      detail: `${ev.entry}: ningún título h1–h3 «Capítulo N»`, evidence: ev })];
  }
  const missing = chapters.filter((n) => !named.has(n));
  if (!missing.length) return [];
  return [f({ check: 'T07', code: 'libro_missing_chapters', severity: 'error', scope: scopeOf(ctx, a),
    title: `Al Libro Guía le ${missing.length === 1 ? 'falta el capítulo' : 'faltan los capítulos'} ${missing.join(', ')}.`,
    detail: `${ev.entry}: capítulos del curso ${chapters.join(', ')}; el Libro titula ${[...named].sort((x, y) => x - y).join(', ')}`,
    evidence: { ...ev, excerpt: `faltan: ${missing.join(', ')}` }, suggestedFix: { operation: 'edit_libro_section', params: { moduleId: a.moduleId, section: 'chapters', chapters: missing } } })];
}

// ─── T08 · audio (bienvenida y audiolibro) ───────────────────────────────────

const fmtMin = (s: number): string => {
  const m = Math.floor(s / 60);
  const r = Math.round(s % 60);
  return r ? `${m} min ${r} s` : `${m} min`;
};

function t08(ctx: DiagnosisContext): Finding[] {
  const out: Finding[] = [];
  const chapters = ctx.course.chapters.length;
  for (const a of ctx.course.activities.filter((x) => (x.kind === 'audiobook' || x.kind === 'welcome_audio' || x.role === 'audio') && !x.missingFolder)) {
    const book = a.kind === 'audiobook' || a.role === 'audio';
    const fix: SuggestedFix = { operation: 'regenerate_audio', params: { target: book ? 'audiobook' : 'welcome', moduleId: a.moduleId } };
    const audio = a.files.filter((x) => x.filename !== '.' && isAudioFile(x.filename, x.mimetype));
    const html = a.html.map((h) => h.html).join('\n');
    if (!audio.length) {
      if (/<audio\b[^>]*\bsrc\s*=\s*"https?:\/\//i.test(html) || /<source\b[^>]*\bsrc\s*=\s*"https?:\/\//i.test(html)) {
        out.push(f({ check: 'T08', code: 'audio_online', severity: 'info', scope: scopeOf(ctx, a),
          title: `El audio de ${where(a)} se reproduce desde internet (no viene dentro del paquete): no se puede comprobar sin conexión.`,
          detail: `${a.dir}: <audio src="https://…"> sin archivo en el paquete`, evidence: { entry: `${a.dir}/${a.modname}.xml` } }));
      } else if (/Parte\s+\d+\s+de\s+\d+/i.test(plainText(html, 4000))) {
        out.push(f({ check: 'T08', code: 'audio_parts', severity: 'info', scope: scopeOf(ctx, a),
          title: `El audiolibro de ${where(a)} se entrega en partes aparte: este paquete no trae el audio.`,
          detail: `${a.dir}: el label nombra «Parte N de M» y no lleva archivo de audio`, evidence: { entry: `${a.dir}/${a.modname}.xml` } }));
      } else {
        out.push(f({ check: 'T08', code: 'audio_missing', severity: 'error', scope: scopeOf(ctx, a),
          title: `${book ? 'El audiolibro' : 'El audio de bienvenida'} (${where(a)}) no trae su archivo de sonido: el reproductor queda vacío.`,
          detail: `${a.dir}: ninguna entrada de audio en files.xml para esta actividad${/#audio-removed/.test(html) ? ' (el reproductor apunta a «#audio-removed»: el audio se quitó del paquete)' : /<source\b[^>]*\bsrc\s*=\s*""/i.test(html) ? ' (el reproductor tiene src vacío)' : ''}`, evidence: { entry: `${a.dir}/${a.modname}.xml` }, suggestedFix: fix }));
      }
      continue;
    }
    // El reproductor tiene que apuntar a SU archivo (`@@PLUGINFILE@@/<nombre>`): un <source src="#audio"> no suena.
    // También `$@PLUGINFILEBYCONTEXT*ctx@$/mod_page/content/0/<nombre>` (re-export) y nombres con %-escapes / NFD.
    const nfc = (x: string) => { try { return decodeURIComponent(x).normalize('NFC'); } catch { return x.normalize('NFC'); } };
    const srcs = [...html.matchAll(/<(?:audio|source)\b[^>]*\bsrc\s*=\s*"([^"]*)"/gi)].map((m) => nfc(m[1].split(/[?#]/)[0]).split('/').pop() as string);
    const names = new Set([...a.html.flatMap((h) => h.pluginfiles.map((p) => nfc(p).split('/').pop() as string)), ...srcs]);
    const linked = audio.some((x) => names.has(x.filename.normalize('NFC')));
    if (!linked && /<(audio|source)\b/i.test(html)) {
      const src = /<(?:audio|source)\b[^>]*\bsrc\s*=\s*"([^"]*)"/i.exec(html)?.[1] ?? '';
      out.push(f({ check: 'T08', code: 'audio_not_linked', severity: 'error', scope: scopeOf(ctx, a),
        title: `El reproductor de ${where(a)} no apunta a su audio: el archivo viene en el paquete pero no suena.`,
        detail: `${a.dir}: reproductor con src «${short(src, 60)}»; el audio «${audio.map((x) => x.filename).join(', ')}» no está referenciado con @@PLUGINFILE@@`,
        evidence: { entry: `${a.dir}/${a.modname}.xml`, excerpt: src }, suggestedFix: { operation: 'edit_html', params: { moduleId: a.moduleId, field: 'intro', relinkAudio: audio[0].filename } } }));
      continue;
    }
    let total = 0;
    let measured = true;
    let kbps: number | null = null;
    let channels: number | null = null;
    let broken = false;
    for (const x of audio) {
      if (!blobVerified(ctx, x.contenthash)) { measured = false; broken = true; continue; } // T02
      const b = ctx.blobs.get(x.contenthash)!;
      const evFile = { fileId: x.fileId, component: x.component, filearea: x.filearea, filename: x.filename, contenthash: x.contenthash };
      if (!b.mp3) { measured = false; continue; } // m4a / ogg: no se mide (no es un error)
      if (!b.mp3.ok && b.head && b.head.length >= 12 && b.head.toString('latin1', 4, 8) === 'ftyp') {
        // Un MP4 / M4A con nombre y tipo de MP3: suena en muchos navegadores, pero Moodle lo sirve como audio/mpeg.
        measured = false;
        out.push(f({ check: 'T08', code: 'audio_wrong_format', severity: 'warning', scope: scopeOf(ctx, a),
          title: `El audio «${short(x.filename)}» de ${where(a)} es en realidad un archivo M4A con nombre de MP3: algunos navegadores no lo reproducen.`,
          detail: `${x.blobEntry}: contenedor MP4 (ftyp «${b.head.toString('latin1', 8, 12)}»), declarado ${x.mimetype ?? 'sin tipo'} — no se mide su duración`, evidence: { entry: x.blobEntry, file: evFile }, suggestedFix: fix }));
        continue;
      }
      if (!b.mp3.ok) {
        broken = true;
        out.push(f({ check: 'T08', code: 'audio_unreadable', severity: 'error', scope: scopeOf(ctx, a),
          title: `El audio «${short(x.filename)}» de ${where(a)} está dañado: no se puede reproducir.`,
          detail: `${x.blobEntry}: ${b.mp3.problem}`, evidence: { entry: x.blobEntry, file: evFile }, suggestedFix: fix }));
        continue;
      }
      if (b.mp3.truncated) {
        broken = true;
        out.push(f({ check: 'T08', code: 'audio_truncated', severity: 'error', scope: scopeOf(ctx, a),
          title: `El audio «${short(x.filename)}» de ${where(a)} está cortado: se termina antes de lo que dice durar.`,
          detail: `${x.blobEntry}: el encabezado declara ${fmtMin(b.mp3.durationSeconds ?? 0)} pero los bytes alcanzan para mucho menos (${b.mp3.bitrateKbps} kbps medios)`, evidence: { entry: x.blobEntry, file: evFile }, suggestedFix: fix }));
        continue;
      }
      total += b.mp3.durationSeconds ?? 0;
      kbps = b.mp3.bitrateKbps;
      channels = b.mp3.channels;
    }
    if (!book || broken || !measured) continue;
    const min = chapters >= CHAPTER_MIN_AUDIOBOOK_FULL ? AUDIOBOOK_FULL_MIN_SECONDS : chapters * AUDIOBOOK_PER_CHAPTER_MIN_SECONDS;
    if (chapters > 0 && total < min) {
      out.push(f({ check: 'T08', code: 'audiobook_short', severity: 'warning', scope: scopeOf(ctx, a),
        title: `El audiolibro dura ${fmtMin(total)} para ${chapters} capítulo(s): es muy corto, parece que le faltan capítulos.`,
        detail: `${a.dir}: ${audio.length} archivo(s), ${Math.round(total)} s medidos (encabezado del MP3); mínimo esperado ${Math.round(min)} s (${chapters >= CHAPTER_MIN_AUDIOBOOK_FULL ? '≥ 25 min en un curso completo' : '2,5 min por capítulo'})`,
        evidence: { entry: audio[0].blobEntry }, suggestedFix: fix }));
    } else {
      out.push(f({ check: 'T08', code: 'audiobook_info', severity: 'info', scope: scopeOf(ctx, a),
        title: `Audiolibro: ${fmtMin(total)}${kbps ? `, ${kbps} kbps ${channels === 1 ? 'mono' : 'estéreo'}` : ''}.`,
        detail: `${a.dir}: ${audio.length} archivo(s); ${kbps === 64 && channels === 1 ? 'pasó por el transcode del backend (64 kbps mono)' : kbps === 128 ? '128 kbps: generado sin el transcode del backend (audio local)' : 'bitrate del encabezado'}`,
        evidence: { entry: audio[0].blobEntry } }));
    }
  }
  return out;
}

// ─── T09 · videos y actividades H5P ──────────────────────────────────────────

interface McFound { path: string; answers: Array<{ text: string; correct: boolean }>; type: string | null; question: string }

/** Todas las opciones múltiples (H5P.MultiChoice) de un contenido H5P, en cualquier profundidad. */
export function h5pMultiChoices(node: unknown, path = '$', out: McFound[] = []): McFound[] {
  if (Array.isArray(node)) { node.forEach((x, i) => h5pMultiChoices(x, `${path}[${i}]`, out)); return out; }
  if (!node || typeof node !== 'object') return out;
  const o = node as Record<string, any>;
  if (typeof o.library === 'string' && /^H5P\.MultiChoice\b/.test(o.library) && o.params && Array.isArray(o.params.answers)) {
    out.push({
      path,
      answers: o.params.answers.filter((x: unknown) => x && typeof x === 'object').map((x: any) => ({ text: plainText(String(x.text ?? ''), 300), correct: x.correct === true })),
      type: typeof o.params.behaviour?.type === 'string' ? o.params.behaviour.type : null,
      question: plainText(String(o.params.question ?? ''), 200),
    });
  }
  for (const [k, v] of Object.entries(o)) if (v && typeof v === 'object') h5pMultiChoices(v, `${path}.${k}`, out);
  return out;
}

function videoFilesOf(content: unknown): Array<{ path: string; mime: string | null }> {
  const files = (content as any)?.interactiveVideo?.video?.files;
  return Array.isArray(files) ? files.filter((x: any) => x && typeof x.path === 'string').map((x: any) => ({ path: String(x.path), mime: typeof x.mime === 'string' ? x.mime : null })) : [];
}
const validUrl = (s: string): boolean => {
  try { const u = new URL(s); return (u.protocol === 'https:' || u.protocol === 'http:') && !!u.hostname && u.hostname.includes('.'); } catch { return false; }
};

function t09(ctx: DiagnosisContext): Finding[] {
  const out: Finding[] = [];
  const videoDocs: unknown[] = [];
  const h5pActs = ctx.course.activities.filter((a) => !a.missingFolder && (a.modname === 'hvp' || a.modname === 'h5pactivity' || (a.modname === 'url' && a.role === 'video')));
  for (const a of h5pActs) {
    const isVideo = a.role === 'video' || a.modname === 'hvp';
    const fix: SuggestedFix | null = isVideo ? { operation: 'regenerate_video', params: { moduleId: a.moduleId, chapterNumber: a.placement.scope === 'chapter' ? a.placement.chapterNumber : null } } : regenerateFixFor(a);
    if (a.modname === 'url') {
      const u = (a.html.find((h) => h.field === 'externalurl')?.html ?? '').trim();
      if (u && !validUrl(u)) {
        out.push(f({ check: 'T09', code: 'video_link_invalid', severity: 'error', scope: scopeOf(ctx, a),
          title: `El enlace del video ${where(a)} no es una dirección válida: no abre el video.`, detail: `${a.dir}: externalurl «${short(u, 120)}»`, evidence: { entry: `${a.dir}/url.xml`, excerpt: u }, suggestedFix: fix }));
      }
      continue;
    }
    let content: unknown = null;
    let hasFile: (rel: string) => boolean = () => false;
    let entry = `${a.dir}/${a.modname}.xml`;
    if (a.modname === 'hvp') {
      const h = ctx.hvp.get(a.moduleId);
      if (!h || h.problem) {
        out.push(f({ check: 'T09', code: 'h5p_unreadable', severity: 'error', scope: scopeOf(ctx, a),
          title: `El video ${where(a)} no se puede leer: al abrirlo no carga.`, detail: `${entry}: ${h?.problem ?? 'sin hvp.xml'}`, evidence: { entry }, suggestedFix: fix }));
        continue;
      }
      content = h.json;
      const names = new Set(a.files.filter((x) => x.filename !== '.').map((x) => `${(x.filepath || '/').replace(/^\//, '')}${x.filename}`));
      const base = new Set(a.files.map((x) => x.filename));
      hasFile = (rel) => names.has(rel) || base.has(rel.split('/').pop() as string);
    } else {
      const pkgFile = a.files.find((x) => x.filearea === 'package' && x.filename !== '.');
      if (!pkgFile) {
        out.push(f({ check: 'T09', code: 'h5p_package_missing', severity: 'error', scope: scopeOf(ctx, a),
          title: `La actividad ${where(a)} no trae su contenido H5P: al abrirla no hay nada.`, detail: `${a.dir}: sin archivo en el área package`, evidence: { entry }, suggestedFix: fix }));
        continue;
      }
      if (!blobVerified(ctx, pkgFile.contenthash)) continue; // T02
      entry = pkgFile.blobEntry;
      const h = ctx.h5p.get(a.moduleId);
      if (!h || h.problem || h.contentProblem) {
        out.push(f({ check: 'T09', code: 'h5p_unreadable', severity: 'error', scope: scopeOf(ctx, a),
          title: `La actividad H5P ${where(a)} está dañada: al abrirla no carga.`, detail: `${entry} (${pkgFile.filename}): ${h?.problem ?? h?.contentProblem ?? 'no se pudo abrir'}`,
          evidence: { entry, file: { fileId: pkgFile.fileId, component: pkgFile.component, filearea: pkgFile.filearea, filename: pkgFile.filename, contenthash: pkgFile.contenthash } }, suggestedFix: fix }));
        continue;
      }
      content = h.content;
      const names = new Set(h.entries);
      hasFile = (rel) => names.has(`content/${rel}`);
    }
    if (isVideo) {
      const vids = videoFilesOf(content);
      if (!vids.length) {
        out.push(f({ check: 'T09', code: 'video_missing', severity: 'error', scope: scopeOf(ctx, a),
          title: `El video interactivo ${where(a)} no tiene video: se ven las preguntas pero no hay nada que mirar.`,
          detail: `${entry}: interactiveVideo.video.files vacío`, evidence: { entry }, suggestedFix: fix }));
      } else {
        for (const v of vids) {
          if (/^[a-z][a-z0-9+.-]*:/i.test(v.path)) {
            if (!validUrl(v.path)) {
              out.push(f({ check: 'T09', code: 'video_link_invalid', severity: 'error', scope: scopeOf(ctx, a),
                title: `El enlace del video ${where(a)} no es una dirección válida: el video no carga.`, detail: `${entry}: video «${short(v.path, 120)}»`, evidence: { entry, excerpt: v.path }, suggestedFix: fix, key: v.path }));
            }
          } else if (!hasFile(v.path.replace(/^\.?\//, ''))) {
            out.push(f({ check: 'T09', code: 'video_file_missing', severity: 'error', scope: scopeOf(ctx, a),
              title: `Falta el archivo de video de ${where(a)}: el video no carga.`, detail: `${entry}: el contenido pide «${short(v.path, 120)}», que no viene en el paquete`, evidence: { entry, excerpt: v.path }, suggestedFix: fix, key: v.path }));
          }
        }
      }
    }
    const mcs = h5pMultiChoices(content);
    for (const q of mcs) {
      const right = q.answers.filter((x) => x.correct).length;
      if (right === 0 || (q.type === 'single' && right > 1)) {
        out.push(f({ check: 'T09', code: right === 0 ? 'h5p_question_no_correct' : 'h5p_question_many_correct', severity: 'error', scope: scopeOf(ctx, a),
          title: right === 0
            ? `Una pregunta de ${where(a)} no tiene ninguna respuesta correcta: nadie la puede acertar.`
            : `Una pregunta de ${where(a)} tiene ${right} respuestas correctas pero solo deja elegir una.`,
          detail: `${entry} ${q.path}: ${q.answers.length} opciones, ${right} correctas (behaviour.type ${q.type ?? '—'})`, evidence: { entry, excerpt: q.question }, suggestedFix: fix, key: q.path }));
      }
    }
    if (isVideo) videoDocs.push({ checkpoints: mcs.map((q) => ({ kind: 'multichoice', answers: q.answers })) });
  }
  // Regla del banco (quality/answer-length-bias): en los videos del curso la correcta no puede ser la más larga en > 30 %.
  // `info` en el diagnóstico TÉCNICO: el video funciona; es calidad pedagógica (Q03, B8, la juzga como aviso).
  const bias = videoMcLengthBias(videoDocs);
  if (bias.biased) {
    out.push(f({ check: 'T09', code: 'video_mc_length_bias', severity: 'info', scope: courseScope(),
      title: `En las preguntas de los videos, la respuesta correcta es casi siempre la más larga (${bias.correctLongest} de ${bias.mc}): se puede adivinar sin saber.`,
      detail: `videoMcLengthBias: ${bias.correctLongest}/${bias.mc} = ${Math.round(bias.share * 100)} % > ${Math.round(VIDEO_MC_LONGEST_MAX_SHARE * 100)} %, z ${bias.z} (esperado por azar ${bias.expected})`,
      evidence: { entry: null } }));
  }
  return out;
}

// ─── T10 · exámenes ──────────────────────────────────────────────────────────

const ANSWERABLE = new Set(['multichoice', 'truefalse', 'shortanswer', 'numerical', 'match', 'ddwtos', 'gapselect', 'multianswer', 'calculated', 'calculatedsimple']);

function t10(ctx: DiagnosisContext): Finding[] {
  const out: Finding[] = [];
  const seen = new Set<number>();
  for (const a of ctx.course.activities.filter((x) => x.modname === 'quiz' && !x.missingFolder)) {
    const ex = a.exam;
    const answerable = (ex?.questions ?? []).filter((q) => ANSWERABLE.has(q.qtype));
    if (!ex || ex.slots === 0 || (!answerable.length && !(ex.questions ?? []).some((q) => q.qtype === 'random'))) {
      out.push(f({ check: 'T10', code: 'exam_empty', severity: 'error', scope: scopeOf(ctx, a),
        title: `El examen ${where(a)} no tiene preguntas: el estudiante no puede rendirlo.`,
        detail: `${a.dir}: ${ex?.slots ?? 0} ranura(s), ${ex?.questions.length ?? 0} pregunta(s) en el banco`, evidence: { entry: `${a.dir}/quiz.xml` },
        suggestedFix: { operation: 'exam_question_add', params: { quizModuleId: a.moduleId } } }));
      continue;
    }
    const docs: Array<{ kind: string; answers: Array<{ text: string; correct: boolean }> }> = [];
    for (const q of ex.questions) {
      const qFix = (op: 'exam_question_replace' | 'exam_question_remove' = 'exam_question_replace'): SuggestedFix => ({ operation: op, params: { quizModuleId: a.moduleId, questionId: q.id } });
      const ev = { entry: 'questions.xml', questionId: q.id, excerpt: plainText(q.html, 160) };
      const first = !seen.has(q.id);
      seen.add(q.id);
      const qname = short(plainText(q.html, 200) || q.name, 70);
      if (q.qtype === 'multichoice') {
        const pos = q.answers.filter((x) => (x.fraction ?? 0) > 0);
        const full = q.answers.filter((x) => (x.fraction ?? 0) >= 0.9999);
        const single = ctx.mcSingle.get(q.id) ?? (full.length <= 1);
        const text = (x: { html: string }) => plainText(x.html, 300);
        if (single && full.length === 1 && pos.length === 1) docs.push({ kind: 'multichoice', answers: q.answers.map((x) => ({ text: text(x), correct: (x.fraction ?? 0) >= 0.9999 })) });
        if (!first) continue;
        if (!pos.length) {
          out.push(f({ check: 'T10', code: 'mc_no_correct', severity: 'error', scope: scopeOf(ctx, a),
            title: `La pregunta «${qname}» de ${where(a)} no tiene ninguna respuesta correcta: nadie la puede acertar.`,
            detail: `questions.xml pregunta ${q.id} (multichoice, ${single ? 'una respuesta' : 'varias respuestas'}): ${q.answers.length} opciones, todas con fracción ≤ 0`, evidence: ev, suggestedFix: qFix() }));
        } else if (single && full.length > 1) {
          const dupes = full.length - new Set(full.map((x) => normalizeExamText(text(x)))).size;
          out.push(f({ check: 'T10', code: 'mc_many_correct', severity: 'error', scope: scopeOf(ctx, a),
            title: dupes
              ? `La pregunta «${qname}» de ${where(a)} muestra la misma respuesta correcta repetida (${full.length} opciones correctas, ${dupes + 1} iguales).`
              : `La pregunta «${qname}» de ${where(a)} tiene ${full.length} respuestas correctas pero solo deja elegir una.`,
            detail: `questions.xml pregunta ${q.id}: single=1 con ${full.length} opciones al 100 %${dupes ? ` (${dupes} repetidas: típico de una pregunta de completar convertida a opción múltiple)` : ''}`, evidence: ev, suggestedFix: qFix() }));
        } else if (single && !full.length) {
          out.push(f({ check: 'T10', code: 'mc_no_full_credit', severity: 'error', scope: scopeOf(ctx, a),
            title: `La pregunta «${qname}» de ${where(a)} no tiene ninguna respuesta que valga el puntaje completo.`,
            detail: `questions.xml pregunta ${q.id}: single=1 y la mejor fracción es ${Math.max(...pos.map((x) => x.fraction ?? 0))}`, evidence: ev, suggestedFix: qFix() }));
        } else if (!single) {
          const sum = pos.reduce((s, x) => s + (x.fraction ?? 0), 0);
          if (Math.abs(sum - 1) > 0.01) {
            out.push(f({ check: 'T10', code: 'mc_fraction_sum', severity: 'error', scope: scopeOf(ctx, a),
              title: `En la pregunta «${qname}» de ${where(a)} los puntajes de las respuestas correctas no suman el 100 %: no se puede obtener la nota completa (o se pasa).`,
              detail: `questions.xml pregunta ${q.id}: varias respuestas, fracciones positivas suman ${Math.round(sum * 1000) / 1000}`, evidence: ev, suggestedFix: qFix() }));
          }
        }
        for (const x of q.answers) {
          if (EXAM_OPTION_FORBIDDEN_RE.test(normalizeExamText(text(x)))) {
            out.push(f({ check: 'T10', code: 'mc_forbidden_option', severity: 'warning', scope: scopeOf(ctx, a),
              title: `La pregunta «${qname}» de ${where(a)} tiene una opción del tipo «todas / ninguna de las anteriores»: Moodle mezcla las opciones y deja de tener sentido.`,
              detail: `questions.xml pregunta ${q.id}, respuesta ${x.id}: «${short(text(x), 80)}» (EXAM_OPTION_FORBIDDEN_RE)`, evidence: ev, suggestedFix: qFix(), key: String(x.id) }));
          }
        }
      } else if (q.qtype === 'truefalse') {
        if (!first) continue;
        const full = q.answers.filter((x) => (x.fraction ?? 0) >= 0.9999);
        if (full.length !== 1) {
          out.push(f({ check: 'T10', code: 'tf_no_correct', severity: 'error', scope: scopeOf(ctx, a),
            title: `La pregunta de verdadero o falso «${qname}» de ${where(a)} no tiene marcada cuál es la respuesta correcta.`,
            detail: `questions.xml pregunta ${q.id} (truefalse): ${full.length} respuestas al 100 %`, evidence: ev, suggestedFix: qFix() }));
        }
      } else if (q.qtype === 'shortanswer' || q.qtype === 'numerical') {
        if (!first) continue;
        if (!q.answers.some((x) => (x.fraction ?? 0) >= 0.9999)) {
          out.push(f({ check: 'T10', code: 'open_no_correct', severity: 'warning', scope: scopeOf(ctx, a),
            title: `La pregunta «${qname}» de ${where(a)} no tiene ninguna respuesta aceptada como correcta.`,
            detail: `questions.xml pregunta ${q.id} (${q.qtype}): ninguna respuesta al 100 %`, evidence: ev, suggestedFix: qFix() }));
        }
      } else if (q.qtype === 'match') {
        if (!first) continue;
        const pairs = q.matches.filter((m) => plainText(m.html, 20) && m.answer.trim());
        if (pairs.length < 2) {
          out.push(f({ check: 'T10', code: 'match_incomplete', severity: 'error', scope: scopeOf(ctx, a),
            title: `La pregunta de emparejar «${qname}» de ${where(a)} tiene menos de dos parejas: Moodle no la puede mostrar.`,
            detail: `questions.xml pregunta ${q.id} (match): ${pairs.length} pareja(s) completas`, evidence: ev, suggestedFix: qFix() }));
        }
      }
    }
    // Regla del banco (quality/answer-length-bias, mismo umbral que EXAM_BANK_LENGTH_BIAS): por examen. `info` en el
    // diagnóstico TÉCNICO (el examen funciona; adivinable es calidad: Q03 en B8).
    const bias = videoMcLengthBias([{ checkpoints: docs }]);
    if (bias.biased) {
      out.push(f({ check: 'T10', code: 'exam_length_bias', severity: 'info', scope: scopeOf(ctx, a),
        title: `En ${where(a)} la respuesta correcta es casi siempre la más larga (${bias.correctLongest} de ${bias.mc} preguntas): se puede adivinar sin saber.`,
        detail: `videoMcLengthBias sobre las opción múltiple de una respuesta: ${bias.correctLongest}/${bias.mc} = ${Math.round(bias.share * 100)} % > 30 %, z ${bias.z}`,
        evidence: { entry: 'questions.xml' }, suggestedFix: { operation: 'exam_question_replace', params: { quizModuleId: a.moduleId, reason: 'length_bias' } } }));
    }
  }
  return out;
}

// ─── Registro ───────────────────────────────────────────────────────────────

const has = (ctx: DiagnosisContext, p: (a: WorkshopActivity) => boolean) => ctx.course.activities.some((a) => !a.missingFolder && p(a));

export const TECHNICAL_CHECKS: readonly CheckDef[] = Object.freeze([
  { id: 'T01', title: 'El paquete abre y lista actividades que existen', applies: () => null, run: t01 },
  { id: 'T02', title: 'Cada archivo tiene su contenido y su huella (sha1) coincide', applies: (c) => (c.files.some((x) => x.file.filename !== '.') || c.undeclaredBlobs.length ? null : 'el paquete no trae archivos'), run: t02 },
  { id: 'T03', title: 'Identificadores únicos (actividades, contextos, archivos, secciones)', applies: () => null, run: t03 },
  { id: 'T04', title: 'Los enlaces internos de Moodle ($@…@$) llevan a una actividad del tipo correcto', applies: () => null, run: t04 },
  { id: 'T05', title: 'Ningún «⚠️ Pendiente» ni actividad vacía', applies: () => null, run: t05 },
  { id: 'T06', title: 'Juegos SCORM completos (configuración, página de inicio, lógica)', applies: (c) => (has(c, (a) => a.modname === 'scorm') ? null : 'el curso no tiene juegos SCORM'), run: t06 },
  { id: 'T07', title: 'Libro Guía completo (cierra, todos los capítulos)', applies: (c) => (has(c, (a) => a.kind === 'libro' || a.kind === 'libro_info') ? null : 'el curso no tiene Libro Guía'), run: t07 },
  { id: 'T08', title: 'Audio de bienvenida y audiolibro (archivo, duración, bitrate)', applies: (c) => (has(c, (a) => a.kind === 'audiobook' || a.kind === 'welcome_audio' || a.role === 'audio') ? null : 'el curso no tiene audio'), run: t08 },
  { id: 'T09', title: 'Videos y actividades H5P (video o enlace, preguntas con respuesta correcta)', applies: (c) => (has(c, (a) => a.modname === 'hvp' || a.modname === 'h5pactivity' || (a.modname === 'url' && a.role === 'video')) ? null : 'el curso no tiene videos ni actividades H5P'), run: t09 },
  { id: 'T10', title: 'Exámenes (preguntas con respuesta correcta, puntajes, reglas del banco)', applies: (c) => (has(c, (a) => a.modname === 'quiz') ? null : 'el curso no tiene exámenes'), run: t10 },
]) as readonly CheckDef[];

/** Tabla de aplicabilidad POR FAMILIA (informe). `true` = aplica (si el paquete tiene lo que el check revisa). */
export const CHECK_FAMILY_APPLICABILITY: Readonly<Record<CheckId, Readonly<Record<WorkshopFamily, true | string>>>> = Object.freeze({
  T01: { 'v1-legacy': true, 'v1-legacy-hvp': true, 'v2-dynamic': true, 'moodle-reexport': true, prototype: true },
  T02: { 'v1-legacy': true, 'v1-legacy-hvp': true, 'v2-dynamic': true, 'moodle-reexport': true, prototype: true },
  T03: { 'v1-legacy': true, 'v1-legacy-hvp': true, 'v2-dynamic': true, 'moodle-reexport': true, prototype: true },
  T04: { 'v1-legacy': true, 'v1-legacy-hvp': true, 'v2-dynamic': true, 'moodle-reexport': true, prototype: true },
  T05: { 'v1-legacy': true, 'v1-legacy-hvp': true, 'v2-dynamic': true, 'moodle-reexport': true, prototype: true },
  T06: { 'v1-legacy': true, 'v1-legacy-hvp': true, 'v2-dynamic': true, 'moodle-reexport': true, prototype: true },
  T07: { 'v1-legacy': true, 'v1-legacy-hvp': true, 'v2-dynamic': true, 'moodle-reexport': true, prototype: true },
  T08: { 'v1-legacy': true, 'v1-legacy-hvp': true, 'v2-dynamic': true, 'moodle-reexport': true, prototype: true },
  T09: { 'v1-legacy': 'V1 sin H5P (salvo que el paquete traiga alguno)', 'v1-legacy-hvp': true, 'v2-dynamic': true, 'moodle-reexport': true, prototype: true },
  T10: { 'v1-legacy': true, 'v1-legacy-hvp': true, 'v2-dynamic': true, 'moodle-reexport': true, prototype: true },
  T11: { 'v1-legacy': 'el validador v3 solo entiende paquetes del builder v3', 'v1-legacy-hvp': 'el validador v3 solo entiende paquetes del builder v3', 'v2-dynamic': true, 'moodle-reexport': 'un re-export de Moodle ya no es el paquete del builder', prototype: 'el validador v3 solo entiende paquetes del builder v3' },
  T12: { 'v1-legacy': 'disponible en B6 / bajo demanda', 'v1-legacy-hvp': 'disponible en B6 / bajo demanda', 'v2-dynamic': 'disponible en B6 / bajo demanda', 'moodle-reexport': 'disponible en B6 / bajo demanda', prototype: 'disponible en B6 / bajo demanda' },
});
