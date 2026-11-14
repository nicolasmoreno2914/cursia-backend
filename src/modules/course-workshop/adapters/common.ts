/**
 * r107 B2 · Taller de cursos — piezas compartidas por los adaptadores de familia: secciones, reglas por TÍTULO de los
 * builders V1 (`09-mbz.js` / `mbz-builder.service.ts`, nombres de `friendlyName()`), reglas por CLAVE del builder
 * dinámico (idnumber `cvN:…`, `dynamic-mbz-builder*.ts`) y reglas por CONTENIDO (re-export de Moodle, donde Moodle
 * reescribe el nombre de los labels). Cada regla devuelve la evidencia que la decidió; si ninguna aplica, el
 * adaptador marca `unknown` con el motivo (nunca adivina en silencio).
 */
import { ChapterRole, Classified, ClassifyInput, CourseKind, RawSection, SectionInfo } from '../course-model';
import { firstBlock, stripTags } from '../xml-scan';

const N = (s: string | undefined): number | null => (s === undefined ? null : Number(s));
const clean = (s: string | undefined): string | null => {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t ? t : null;
};

// ─── Secciones ──────────────────────────────────────────────────────────────

/**
 * Qué es cada sección, por su nombre (todas las familias):
 *   V1 (09-mbz.js / mbz-builder):  «Bienvenida e Introducción» · «Ruta de Aprendizaje y Libro Guía» ·
 *                                  «Módulo N — <nombre>» · «Cierre y Examen Final»
 *   dinámico v1/v2:                «Bienvenida» · «Ruta de aprendizaje y Libro Guía» · «Módulo N — <nombre>» · «Cierre del curso»
 *   v3:                            «Módulo N · Capítulo M: <título>» · «Módulo N · Evaluación» · «Evaluación final» · «Cierre del curso»
 *   re-export (editado en Moodle): «Unidad N» · «Bienvenido(s) al Curso …» · «Ruta de Aprendizaje y Recursos» · «… Examen Final …»
 */
export function sectionInfoOf(s: RawSection): SectionInfo {
  const name = (s.name || s.title || '').replace(/\s+/g, ' ').trim();
  let m = /^M[óo]dulo (\d{1,2}) · Cap[íi]tulo (\d{1,3}): (.+)$/.exec(name);
  if (m) return { kind: 'chapter', module: N(m[1]), chapter: N(m[2]), chapterTitle: clean(m[3]), moduleTitle: null };
  m = /^M[óo]dulo (\d{1,2}) · Evaluaci[óo]n$/.exec(name);
  if (m) return { kind: 'exam', module: N(m[1]), chapter: null, chapterTitle: null, moduleTitle: null };
  m = /^M[óo]dulo (\d{1,2})\s*[—–-]\s*(.*)$/.exec(name);
  if (m) return { kind: 'module', module: N(m[1]), chapter: null, chapterTitle: null, moduleTitle: clean(m[2]) };
  m = /^Unidad (\d{1,2})\b\s*[—–:-]?\s*(.*)$/i.exec(name);
  if (m) return { kind: 'module', module: N(m[1]), chapter: null, chapterTitle: null, moduleTitle: clean(m[2]) };
  if (/^Evaluaci[óo]n final$/i.test(name)) return { kind: 'final', module: null, chapter: null, chapterTitle: null, moduleTitle: null };
  if (/examen final/i.test(name)) return { kind: 'final', module: null, chapter: null, chapterTitle: null, moduleTitle: null };
  if (/^Cierre del curso$/i.test(name)) return { kind: 'closing', module: null, chapter: null, chapterTitle: null, moduleTitle: null };
  if (/^Bienvenid/i.test(name) || s.number === 0) return { kind: 'welcome', module: null, chapter: null, chapterTitle: null, moduleTitle: null };
  if (/^Ruta de aprendizaje/i.test(name)) return { kind: 'route', module: null, chapter: null, chapterTitle: null, moduleTitle: null };
  return { kind: 'other', module: null, chapter: null, chapterTitle: null, moduleTitle: null };
}

// ─── Resultado ──────────────────────────────────────────────────────────────

export const chapterOf = (role: ChapterRole, kind: string, chapter: number | null, evidence: string, extra: Partial<Classified> = {}): Classified => ({
  scope: 'chapter', role, kind, chapter, evidence, ...extra,
});
export const courseOf = (kind: CourseKind, evidence: string, extra: Partial<Classified> = {}): Classified => ({ scope: 'course', kind, evidence, ...extra });
export const unknownOf = (reason: string, evidence = 'sin regla'): Classified => ({ scope: 'course', kind: 'unknown', evidence, unknownReason: reason });

// ─── Reglas del builder dinámico (idnumber `cvN:…`) ─────────────────────────

/** Clave de capítulo del builder dinámico → rol y clase. Fuente: idnumbers de dynamic-mbz-builder*.ts (corpus B0). */
export const DYNAMIC_CHAPTER_KEYS: Readonly<Record<string, { role: ChapterRole; kind: string }>> = Object.freeze({
  presentation: { role: 'presentation', kind: 'presentation' },
  opening: { role: 'text', kind: 'opening' },
  deepening: { role: 'text', kind: 'deepening' },
  video_primer: { role: 'text', kind: 'video_primer' },
  synthesis: { role: 'text', kind: 'synthesis' },
  closing: { role: 'text', kind: 'closing' },
  activity_instruction: { role: 'cta', kind: 'activity_instruction' },
  application_instruction: { role: 'cta', kind: 'application_instruction' },
  self_check: { role: 'cta', kind: 'self_check' },
  video: { role: 'video', kind: 'video' },
  activity: { role: 'game', kind: 'practice' },
  review_cards: { role: 'game', kind: 'review_cards' },
  guided_practice: { role: 'activity', kind: 'guided_practice' },
  application: { role: 'activity', kind: 'application' },
  application_solution: { role: 'activity', kind: 'application_solution' },
  audio: { role: 'audio', kind: 'audio' },
});

/** Clave de curso del builder dinámico (`cvN:shell:<k>` y las de módulo / examen) → clase. */
const DYNAMIC_SHELL: Readonly<Record<string, CourseKind>> = Object.freeze({
  welcome: 'welcome', audio_welcome: 'welcome_audio', competencies: 'competencies', methodology: 'methodology', start: 'course_start',
  route: 'route', route_start: 'route_start', libro: 'libro', libro_card: 'libro_info', libro_html: 'libro_mobile', audiobook: 'audiobook',
  closing: 'closing', certificate_teacher: 'certificate', teacher_guide: 'teacher_guide', forum: 'forum',
});

/** Texto del primer <hN> de un HTML (sin etiquetas, entidades HTML básicas decodificadas). */
export function firstHeadingText(html: string, tagName: 'h2' | 'h3'): string | null {
  const b = firstBlock(html, new RegExp(`<${tagName}\\b[^<>]*>`, 'i'), new RegExp(`</${tagName}>`, 'i'));
  if (!b) return null;
  const t = stripTags(b.inner).replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&amp;/g, '&');
  return clean(t);
}

const chapterNumberInTitle = (t: string): number | null => {
  const m = /(?:^|·\s*)Cap[íi]tulo (\d{1,3})(?:\s*[·:]|$)/.exec(t) ?? /\bdel cap[íi]tulo (\d{1,3})\b/i.exec(t);
  return m ? Number(m[1]) : null;
};
const chapterTitleInTitle = (t: string): string | null => clean(/·\s*Cap[íi]tulo \d{1,3}:\s*(.+)$/.exec(t)?.[1]);
const unitInTitle = (t: string): number | null => {
  const m = /\bm[óo]dulo (\d{1,2})\b/i.exec(t);
  return m ? Number(m[1]) : null;
};

/**
 * Regla por clave del builder dinámico. `null` si la actividad no tiene clave `cvN:`. El número de capítulo sale del
 * título («Capítulo N · …», «… · Capítulo N: …», «… del capítulo N»); la unidad de un examen, del título o de la sección.
 */
export function classifyByDynamicKey(i: ClassifyInput): Classified | null {
  const id = i.a.idnumber ?? '';
  const m = /^cv\d+:([a-z_]+)(?::([0-9a-f-]{36}))?(?::(.+))?$/.exec(id);
  if (!m) return null;
  const [, k, uuid, rest] = m;
  const t = i.a.title || i.a.name || '';
  const ev = `clave del builder «${id.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/, '<uuid>')}»`;
  if (k === 'ch') {
    const key = (rest ?? '').split(':')[0];
    const def = DYNAMIC_CHAPTER_KEYS[key];
    const n = chapterNumberInTitle(t);
    const title = chapterTitleInTitle(t);
    const extra: Partial<Classified> = { chapterUuid: uuid ?? null, placementBy: n !== null ? 'number' : 'builder_key', ...(title ? { chapterTitle: { text: title, priority: 5 } } : {}) };
    if (key === 'resource') return chapterOf('activity', 'practice_resource', n, ev, extra);
    if (!def) return { ...chapterOf('unknown', 'unknown', n, ev, extra), unknownReason: `clave de capítulo «${key}» que este Taller no conoce` };
    return chapterOf(def.role, def.kind, n, ev, extra);
  }
  const unit = unitInTitle(t) ?? i.sectionInfo?.module ?? null;
  switch (k) {
    case 'shell': {
      const kind = DYNAMIC_SHELL[rest ?? ''];
      return kind ? courseOf(kind, ev) : unknownOf(`clave de curso «shell:${rest}» que este Taller no conoce`, ev);
    }
    // Los dos builders dinámicos escriben el título del módulo como el primer <h2> del label de presentación del módulo
    // (dynamic-mbz-builder.ts moduleIntroLabelHtml; course-shell/shell.ts moduleIntroLabel → heading('h2', module.title)).
    case 'module_intro': return courseOf('module_intro', ev, { unit, moduleUuid: uuid ?? null, moduleTitle: firstHeadingText(i.a.html.find((h) => h.field === 'intro')?.html ?? '', 'h2') });
    case 'module_next': return courseOf('module_next', ev, { unit, moduleUuid: uuid ?? null });
    case 'exam_info': return courseOf('exam_info', ev, { unit, moduleUuid: uuid ?? null });
    case 'exam': return courseOf('exam', ev, { unit, moduleUuid: uuid ?? null, moduleTitle: clean(/^Evaluación del módulo \d{1,2}: (.+)$/.exec(t)?.[1]) });
    case 'exam_explanations': return courseOf('exam_answers', ev, { unit, moduleUuid: uuid ?? null });
    case 'final_exam': return courseOf('final_exam', ev);
    case 'final_exam_info': return courseOf('final_exam_info', ev);
    case 'final_exam_next': return courseOf('exam_next', ev);
    case 'final_exam_explanations': return courseOf('exam_answers', ev);
    default: return unknownOf(`clave «${k}» que este Taller no conoce`, ev);
  }
}

/**
 * Reglas por TÍTULO del builder dinámico (actividades sin clave: editadas a mano o builders previos a la clave).
 * Labels «Capítulo N · <parte>»; actividades «<tipo> · Capítulo N: <título>»; páginas «Solucionario docente · …».
 */
const DYNAMIC_LABEL_PARTS: Readonly<Record<string, { role: ChapterRole; kind: string }>> = Object.freeze({
  'Presentación': DYNAMIC_CHAPTER_KEYS.presentation, 'Apertura': DYNAMIC_CHAPTER_KEYS.opening, 'Profundización': DYNAMIC_CHAPTER_KEYS.deepening,
  'Práctica guiada': DYNAMIC_CHAPTER_KEYS.deepening, 'Antes del video': DYNAMIC_CHAPTER_KEYS.video_primer, 'Síntesis': DYNAMIC_CHAPTER_KEYS.synthesis,
  'Cierre': DYNAMIC_CHAPTER_KEYS.closing, 'Práctica': DYNAMIC_CHAPTER_KEYS.activity_instruction,
  'Actividad de Aplicación': DYNAMIC_CHAPTER_KEYS.application_instruction, 'Comprueba lo aprendido': DYNAMIC_CHAPTER_KEYS.self_check,
});

export function classifyByDynamicTitle(i: ClassifyInput): Classified | null {
  const t = (i.a.title || i.a.name || '').replace(/\s+/g, ' ').trim();
  const mod = i.a.modname;
  let m: RegExpExecArray | null;
  if (mod === 'label' && (m = /^Cap[íi]tulo (\d{1,3}) · (.+)$/.exec(t))) {
    const def = DYNAMIC_LABEL_PARTS[m[2]];
    const ev = `título «Capítulo N · ${m[2]}»`;
    return def ? chapterOf(def.role, def.kind, Number(m[1]), ev) : { ...chapterOf('unknown', 'unknown', Number(m[1]), ev), unknownReason: `parte de capítulo «${m[2]}» que este Taller no conoce` };
  }
  const n = chapterNumberInTitle(t);
  const title = chapterTitleInTitle(t);
  const ex: Partial<Classified> = title ? { chapterTitle: { text: title, priority: 4 } } : {};
  if ((mod === 'h5pactivity' || mod === 'hvp') && /^Video interactivo · Cap[íi]tulo \d/.test(t)) return chapterOf('video', 'video', n, 'título «Video interactivo · Capítulo N»', ex);
  if ((mod === 'h5pactivity' || mod === 'scorm') && /^Actividad práctica · Cap[íi]tulo \d/.test(t)) return chapterOf('game', 'practice', n, 'título «Actividad práctica · Capítulo N»', ex);
  if (mod === 'h5pactivity' && /^Repaso · Cap[íi]tulo \d/.test(t)) return chapterOf('game', 'review_cards', n, 'título «Repaso · Capítulo N»', ex);
  if ((mod === 'page' || mod === 'assign') && /^Actividad de Aplicación · Cap[íi]tulo \d/.test(t)) return chapterOf('activity', 'application', n, 'título «Actividad de Aplicación · Capítulo N»', ex);
  if (mod === 'page' && /^Solucionario docente · /.test(t) && n !== null) return chapterOf('activity', 'application_solution', n, 'título «Solucionario docente · … capítulo N»');
  if (mod === 'page' && /^Ejercicios guiados — /.test(t)) return chapterOf('activity', 'guided_practice', null, 'título «Ejercicios guiados — …» (capítulo por su sección)');
  if (mod === 'label' && (m = /^M[óo]dulo (\d{1,2}): (presentación|evaluación|siguiente paso)$/.exec(t))) {
    return courseOf(m[2] === 'presentación' ? 'module_intro' : m[2] === 'evaluación' ? 'exam_info' : 'module_next', `título «Módulo N: ${m[2]}»`, { unit: Number(m[1]) });
  }
  if (mod === 'quiz' && (m = /^Evaluación del módulo (\d{1,2})\b(?::\s*(.+))?/.exec(t))) return courseOf('exam', 'título «Evaluación del módulo N»', { unit: Number(m[1]), moduleTitle: clean(m[2]) });
  if (mod === 'quiz' && /^Evaluación final$/.test(t)) return courseOf('final_exam', 'título «Evaluación final»');
  if (mod === 'page' && (m = /^Respuestas explicadas — Evaluación del módulo (\d{1,2})\b/.exec(t))) return courseOf('exam_answers', 'título «Respuestas explicadas — Evaluación del módulo N»', { unit: Number(m[1]) });
  if (mod === 'page' && /^Respuestas explicadas — Evaluación final$/.test(t)) return courseOf('exam_answers', 'título «Respuestas explicadas — Evaluación final»');
  const simple: Array<[RegExp, string | null, CourseKind]> = [
    [/^Bienvenida$/, 'label', 'welcome'], [/^Audio de bienvenida$/, 'label', 'welcome_audio'], [/^Qué aprenderás$/, 'label', 'competencies'],
    [/^Metodología$/, 'label', 'methodology'], [/^Comenzar el curso$/, 'label', 'course_start'], [/^Ruta de aprendizaje$/, 'label', 'route'],
    [/^Libro Guía$/, 'label', 'libro_info'], [/^Audiolibro$/, 'label', 'audiobook'], [/^Comenzar con el primer capítulo$/, 'label', 'route_start'],
    [/^Evaluación final$/, 'label', 'final_exam_info'], [/^Evaluación final: siguiente paso$/, 'label', 'exam_next'], [/^Cierre del curso$/, 'label', 'closing'],
    [/^Para docentes: activar el certificado$/, 'label', 'certificate'], [/^Guía del docente/, 'page', 'teacher_guide'],
    [/Libro Guía · lectura en el celular$/, 'book', 'libro_mobile'], [/^\S*\s*Libro Guía$/, 'resource', 'libro'],
  ];
  for (const [re, md, kind] of simple) if ((md === null || md === mod) && re.test(t)) return courseOf(kind, `título «${t}»`);
  if (mod === 'forum') return courseOf('forum', 'foro del curso');
  return null;
}

// ─── Reglas de los builders V1 (09-mbz.js / mbz-builder.service.ts) ─────────

/** Placeholder «⚠️ Pendiente: <archivo>» → qué faltó, por el nombre de archivo de F (09-mbz.js `secFiles`). */
export function classifyV1File(fn: string): Omit<Classified, 'evidence'> | null {
  let m: RegExpExecArray | null;
  if ((m = /^scorm_cap(\d+)_index\.html$/.exec(fn))) return { scope: 'chapter', role: 'game', kind: 'game', chapter: Number(m[1]) };
  if ((m = /^cap(\d+)_video_interactivo\.html$/.exec(fn))) return { scope: 'chapter', role: 'text', kind: 'chapter_page', chapter: Number(m[1]) };
  if ((m = /^cap(\d+)_presentacion_gamma\.html$/.exec(fn))) return { scope: 'chapter', role: 'presentation', kind: 'presentation', chapter: Number(m[1]) };
  if ((m = /^cap(\d+)_descripcion_actividad\.html$/.exec(fn))) return { scope: 'chapter', role: 'cta', kind: 'game_description', chapter: Number(m[1]) };
  if ((m = /^examen_unidad(\d+)_descripcion\.html$/.exec(fn))) return { scope: 'course', kind: 'exam_info', unit: Number(m[1]) };
  if (fn === 'examen_final_descripcion.html') return { scope: 'course', kind: 'final_exam_info' };
  const shell: Record<string, CourseKind> = {
    'seccion0_bienvenida.html': 'welcome', 'seccion0_audio_bienvenida.html': 'welcome_audio', 'seccion0_introduccion.html': 'competencies',
    'seccion0_metodologia.html': 'methodology', 'seccion1_ruta_aprendizaje.html': 'route', 'seccion1_libro_guia.html': 'libro_info', 'seccion1_audiolibro.html': 'audiobook',
  };
  return shell[fn] ? { scope: 'course', kind: shell[fn] } : null;
}

/**
 * Reglas por título de los builders V1 (nombres de `friendlyName()` en 08-downloads.js / mbz-builder.service.ts y de
 * las actividades que arma `exportMBZ`). El emoji inicial es opcional (algunos builders lo omiten).
 *   📊 Presentación Cap N — T        → presentation (Gamma)
 *   ▶️ Cap. N — Video: T             → text (página del capítulo `capN_video_interactivo.html`; un label, NO el H5P)
 *   📖 Capítulo N — T                → text (introducción del video interactivo, builder con H5P)
 *   🎥/🎬 Video Interactivo Cap N — T → video (hvp)
 *   🎯 Practicar — Cap N             → cta
 *   🎮 Cap. N — Actividad Gamificada → cta (descripción del juego)
 *   🎮 Actividad Interactiva Cap N — T → game (scorm)
 *   ⚠️ Pendiente: <archivo>          → lo que ese archivo iba a ser, marcado `pending`
 *   Variantes vistas en el censo (fix round 1): hvp «▶️ Cap. N — Video: T» → video (16-mbz-patch.js renombra el
 *   video al título del label); scorm «🎮 Actividad Cap N — T» / «🎮 Juego Cap. N — T» / «SCORM Cap N» → game; label
 *   «🎮 Juego Cap. N» → cta; url «🎬 Video del capítulo N — T» → video (builder 5B.1 con video externo); label
 *   «ℹ️ Evaluación del módulo N» → exam_info; quiz «📝 Evaluación del módulo N — T» → exam; «📘 Tarjeta Libro Guía» →
 *   libro_info; resource «📘 Libro Guía» / page «📖 Libro Guía Completo» → libro; nombres cortos del prototipo
 *   (`S0 Intro`, `S1 Ruta`, `Ef Desc`…) → por su archivo de origen.
 *   Nombres de respaldo de friendlyName (`Cap5 Video Interactivo`, `Seccion1 Audiolibro`…) → por el archivo de origen.
 */
export function classifyByV1Title(i: ClassifyInput): Classified | null {
  const t = (i.a.title || i.a.name || '').replace(/\s+/g, ' ').trim();
  const mod = i.a.modname;
  let m: RegExpExecArray | null;
  if ((m = /^⚠️?\s*Pendiente:\s*(\S+)/.exec(t))) {
    const f = classifyV1File(m[1]);
    const ev = `placeholder «⚠️ Pendiente: ${m[1]}»`;
    return f ? { ...f, evidence: ev, pending: m[1] } as Classified : { ...unknownOf(`placeholder de un archivo que este Taller no conoce (${m[1]})`, ev), pending: m[1] };
  }
  // Respaldo de friendlyName: el nombre de archivo con «_» → « » y mayúsculas.
  if ((m = /^(Cap\d+ (?:Video Interactivo|Presentacion Gamma|Descripcion Actividad)|Seccion[01] [A-Za-z ]+|Examen (?:Unidad\d+|Final) Descripcion)$/.exec(t))) {
    const fn = m[1].toLowerCase().replace(/ /g, '_') + '.html';
    const f = classifyV1File(fn);
    if (f) return { ...f, evidence: `nombre de respaldo de friendlyName («${t}» ← ${fn})` } as Classified;
  }
  if (mod === 'hvp' && (m = /^(?:▶️?\s*)?Cap\. (\d{1,3}) — Video:\s*(.*)$/.exec(t))) return chapterOf('video', 'video', Number(m[1]), 'título «▶️ Cap. N — Video: …» (hvp)', titleHint(m[2], 1));
  if (mod === 'scorm' && (m = /^(?:🎮\s*)?(?:Actividad|Juego) Cap\.? (\d{1,3})(?:\s+—\s+(.*))?$/.exec(t))) return chapterOf('game', 'game', Number(m[1]), 'título «🎮 Actividad / Juego Cap N»', titleHint(m[2], 2));
  if (mod === 'scorm' && (m = /^SCORM Cap (\d{1,3})$/.exec(t))) return chapterOf('game', 'game', Number(m[1]), 'título «SCORM Cap N»');
  if (mod === 'label' && (m = /^(?:🎮\s*)?Juego Cap\.? (\d{1,3})\b/.exec(t))) return chapterOf('cta', 'game_description', Number(m[1]), 'título «🎮 Juego Cap. N» (label)');
  if (mod === 'url' && (m = /^(?:🎬\s*)?Video del cap[íi]tulo (\d{1,3})(?:\s+—\s+(.*))?$/.exec(t))) return chapterOf('video', 'video_url', Number(m[1]), 'título «🎬 Video del capítulo N» (url)', titleHint(m[2], 2));
  if (mod === 'label' && (m = /^(?:ℹ️?\s*)?Evaluación del módulo (\d{1,2})\b/.exec(t))) return courseOf('exam_info', 'título «ℹ️ Evaluación del módulo N»', { unit: Number(m[1]) });
  if (mod === 'quiz' && (m = /^(?:📝\s*)?Evaluación del módulo (\d{1,2})\b(?:\s*[—:-]\s*(.+))?/.exec(t))) return courseOf('exam', 'título «📝 Evaluación del módulo N — …»', { unit: Number(m[1]), moduleTitle: clean(m[2]) });
  if (mod === 'label' && /^(?:📘\s*)?Tarjeta Libro Gu[íi]a$/.test(t)) return courseOf('libro_info', 'título «📘 Tarjeta Libro Guía»');
  if (mod === 'resource' && /^(?:📘\s*)?Libro Gu[íi]a$/.test(t)) return courseOf('libro', 'título «📘 Libro Guía»');
  if (mod === 'page' && /Libro Gu[íi]a Completo$/.test(t)) return courseOf('libro', 'título «📖 Libro Guía Completo» (page)');
  const short: Record<string, string> = { 'S0 Intro': 'seccion0_introduccion.html', 'S0 Bienvenida': 'seccion0_bienvenida.html', 'S0 Bien': 'seccion0_bienvenida.html', 'S0 Audio': 'seccion0_audio_bienvenida.html', 'S0 Metodologia': 'seccion0_metodologia.html', 'S1 Ruta': 'seccion1_ruta_aprendizaje.html', 'S1 Libro': 'seccion1_libro_guia.html', 'S1 Audiolibro': 'seccion1_audiolibro.html', 'Ef Desc': 'examen_final_descripcion.html' };
  if ((mod === 'page' || mod === 'label') && short[t]) {
    const f = classifyV1File(short[t]);
    if (f) return { ...f, evidence: `nombre corto del prototipo («${t}» ← ${short[t]})` } as Classified;
  }
  if ((mod === 'page' || mod === 'label') && (m = /^Eu(\d) Desc$/.exec(t))) return courseOf('exam_info', `nombre corto del prototipo («${t}» ← examen_unidad${m[1]}_descripcion.html)`, { unit: Number(m[1]) });
  if (mod === 'label' && (m = /^(?:📊\s*)?Presentación Cap (\d{1,3})(?:\s+—\s+(.*))?$/.exec(t))) return chapterOf('presentation', 'presentation', Number(m[1]), 'título «📊 Presentación Cap N»', titleHint(m[2], 2));
  if ((mod === 'label' || mod === 'page') && (m = /^(?:▶️?\s*)?Cap\. (\d{1,3}) — Video:\s*(.*)$/.exec(t))) return chapterOf('text', 'chapter_page', Number(m[1]), 'título «▶️ Cap. N — Video: …» (página del capítulo)', titleHint(m[2], 3));
  if (mod === 'label' && (m = /^(?:📖\s*)?Cap[íi]tulo (\d{1,3})(?:\s+—\s+(.*))?$/.exec(t))) return chapterOf('text', 'video_intro', Number(m[1]), 'título «📖 Capítulo N — …» (introducción del video)', titleHint(m[2], 4));
  if (mod === 'hvp' && (m = /Video Interactivo Cap (\d{1,3})(?:\s+—\s+(.*))?$/.exec(t))) return chapterOf('video', 'video', Number(m[1]), 'título «🎥 Video Interactivo Cap N»', titleHint(m[2], 1));
  // Prototipos de prueba: «Video Cap N: T» (label) y páginas «CapN Video» / «CN Video» (archivo capN_video_interactivo).
  if ((mod === 'label' || mod === 'page') && (m = /^Video Cap (\d{1,3}):\s*(.*)$/.exec(t))) return chapterOf('text', 'chapter_page', Number(m[1]), 'título «Video Cap N: …» (prototipo)', titleHint(m[2], 2));
  if ((mod === 'label' || mod === 'page') && (m = /^C(?:ap)?(\d{1,3}) Video$/.exec(t))) return chapterOf('text', 'chapter_page', Number(m[1]), `nombre corto del prototipo («${t}» ← cap${m[1]}_video_interactivo.html)`);
  if (mod === 'label' && (m = /^(?:🎯\s*)?Practicar — Cap (\d{1,3})\b/.exec(t))) return chapterOf('cta', 'practice_cta', Number(m[1]), 'título «🎯 Practicar — Cap N»');
  if ((mod === 'label' || mod === 'page') && (m = /^(?:🎮\s*)?Cap\. (\d{1,3}) — Actividad Gamificada/.exec(t))) return chapterOf('cta', 'game_description', Number(m[1]), 'título «🎮 Cap. N — Actividad Gamificada»');
  if (mod === 'scorm' && (m = /Actividad Interactiva Cap (\d{1,3})(?:\s+—\s+(.*))?$/.exec(t))) return chapterOf('game', 'game', Number(m[1]), 'título «🎮 Actividad Interactiva Cap N»', titleHint(m[2], 2));
  // Curso.
  if (mod === 'quiz' && (m = /Examen Unidad (\d{1,2})\b/.exec(t))) return courseOf('exam', 'título «📝 Examen Unidad N»', { unit: Number(m[1]) });
  if (mod === 'quiz' && /Examen Final/.test(t)) return courseOf('final_exam', 'título «📝 Examen Final»');
  if (mod === 'label' && (m = /^(?:🎮\s*)?Actividad Interactiva Cap (\d{1,3})$/.exec(t))) return chapterOf('cta', 'game_description', Number(m[1]), 'título «Actividad Interactiva Cap N» (label del prototipo)');
  if (mod === 'label' && (m = /^(?:ℹ️?\s*Información:\s*|📝\s*)?Examen Unidad (\d{1,2})\b/.exec(t))) return courseOf('exam_info', 'título «ℹ️ Información: Examen Unidad N»', { unit: Number(m[1]) });
  if (mod === 'label' && /^(?:ℹ️?\s*Información:\s*|🏆\s*|Cierre y )?Examen Final/.test(t)) return courseOf('final_exam_info', 'título «ℹ️ Información: Examen Final»');
  if (mod === 'resource' && /Libro Gu[íi]a Completo/.test(t)) return courseOf('libro', 'título «📚 Libro Guía Completo»');
  const simple: Array<[RegExp, CourseKind]> = [
    [/Bienvenida al Curso$/, 'welcome'], [/Audio de Bienvenida$/, 'welcome_audio'], [/¿?Qu[ée] Aprender[áa]s\??$/, 'competencies'],
    [/Metodolog[íi]a del Curso$/, 'methodology'], [/Ruta de Aprendizaje$/, 'route'], [/Libro Gu[íi]a del Curso$/, 'libro_info'],
    [/Audiolibro del Curso$/, 'audiobook'],
  ];
  for (const [re, kind] of simple) if ((mod === 'label' || mod === 'page') && re.test(t)) return courseOf(kind, `título «${t}»`);
  if (mod === 'forum') return courseOf('forum', 'foro del curso');
  return null;
}

function titleHint(t: string | undefined, priority: number): Partial<Classified> {
  const c = clean(t);
  return c ? { chapterTitle: { text: c, priority } } : {};
}

// ─── Reglas por contenido (labels sin nombre útil: re-export de Moodle) ─────

/**
 * Moodle, al restaurar y volver a exportar, reescribe el `<name>` de cada label con el comienzo de su texto (o
 * «labelNNN»): el título deja de servir y lo único estable es el HTML que escribió el builder. Reglas sobre el texto
 * plano del label (comienzo del contenido de las plantillas de 09-mbz.js), en este orden:
 *   «MÓDULO M · CAPÍTULO N» / «CAPÍTULO N» / «CAP N» al comienzo          → text del capítulo N
 *   «🎮 Actividad Interactiva · Capítulo N»                               → cta (descripción del juego) del capítulo N
 *   «✅ Evaluación de Unidad … Unidad N»                                   → exam_info de la unidad N
 *   «Examen Final» / «Evaluación final» al comienzo                        → final_exam_info
 *   sección 0: «CampusCloud · Curso en línea» → welcome; con <audio> o «Audio de Bienvenida» → welcome_audio;
 *     «¿Qué Aprenderás?» → competencies; «Metodología» / «¿Cómo funciona…» → methodology; «Introducción al Curso» /
 *     «Estrategia y Duración» → course_info
 *   sección 1: «Ruta de Aprendizaje» → route; «Tu Guía Completa» / «libro guía» → libro_info; «Audiolibro» → audiobook
 */
export function classifyByContent(i: ClassifyInput): Classified | null {
  if (i.a.modname !== 'label') return null;
  // Variante de plantilla con prefijo «🗺️ Sección N · …»: se mira lo que sigue.
  // y con el número decorativo de la tarjeta adelante («04 🎮 Actividad…»).
  const p = i.plain.replace(/^(?:\S{1,3}\s+)?Secci[óo]n \d{1,2}\s*·\s*/i, '').replace(/^\d{1,2}\s+(?=\S{1,3}\s)/, '');
  const html = i.a.html.find((h) => h.field === 'intro')?.html ?? '';
  let m: RegExpExecArray | null;
  // Fix round 2 (P1-1): la tarjeta de la presentación Gamma también empieza con «Capítulo N» (el distintivo antes del
  // <h2>: mbz-builder.service.ts gammaLabelHtml, 31-course-production.js _cpBuildGammaLabelHtml) — se reconoce PRIMERO por
  // su plantilla: «Presentación del capítulo», enlace a gamma.app, o 📊 + «diapositivas».
  if (/Presentaci[óo]n del cap[íi]tulo/i.test(p) || /gamma\.app\//i.test(html) || (/📊/.test(p) && /diapositivas/i.test(p))) {
    const n = /\bCap[íi]tulo\s+(\d{1,3})\b/i.exec(p.slice(0, 160));
    return n
      ? chapterOf('presentation', 'presentation', Number(n[1]), 'contenido de la tarjeta de presentación («Presentación del capítulo» / gamma.app / diapositivas)')
      : unknownOf('tarjeta de presentación sin número de capítulo al comienzo', 'contenido de la tarjeta de presentación');
  }
  if ((m = /^(?:\S{1,3}\s+)?(?:M[ÓO]DULO\s+\d{1,2}\s*[·•—–-]\s*)?CAP(?:[ÍI]TULO)?\.?\s+(\d{1,3})\b/i.exec(p))) {
    // La página del capítulo (capN_video_interactivo.html) trae su firma: instrucciones del video / el video embebido.
    if (/Instrucciones|video|📺|<iframe|H5P/i.test(html)) return chapterOf('text', 'chapter_page', Number(m[1]), `contenido «${p.slice(0, m[0].length)}…» + firma de la página del capítulo`);
    return unknownOf(`empieza con «${p.slice(0, m[0].length)}» pero no tiene la firma de la página del capítulo (instrucciones / video)`, 'contenido «CAPÍTULO N»');
  }
  const title = (i.a.title || i.a.name || '').replace(/\s+/g, ' ').trim();
  if ((m = /^🎮\s*Actividad Interactiva\s*[·:]?\s*Cap[íi]tulo\s+(\d{1,3})\b/i.exec(title))) return chapterOf('cta', 'game_description', Number(m[1]), 'título «🎮 Actividad Interactiva Capítulo N: …»');
  // Juego escrito por el docente con el capítulo entre paréntesis («🧠 MarketingLand: … (Capítulo 8)»): solo con emoji o
  // vocabulario de JUEGO (fix round 2, P2-6) — «📌 Nota: repasa … (Capítulo 3)» no es una descripción de juego.
  const game = /^(\S{1,3})\s+([^:]{2,60}):.*\(Cap[íi]tulo (\d{1,3})\)/.exec(p.slice(0, 200));
  if (game && (/^(?:🎮|🧩|🧠|🕹️?|🎲|🃏|🏆|🎯)$/u.test(game[1]) || /juego|videojuego|quiz|trivia|reto|desaf[íi]o|clasificador|pasapalabra|ruleta|land\b/i.test(game[2]))) {
    return chapterOf('cta', 'game_description', Number(game[3]), 'contenido «<juego>: … (Capítulo N)»');
  }
  if ((m = /^🎮\s*Actividad Interactiva\s*[·:]?\s*Cap[íi]tulo\s+(\d{1,3})\b/i.exec(p))) return chapterOf('cta', 'game_description', Number(m[1]), 'contenido «🎮 Actividad Interactiva · Capítulo N»');
  if ((m = /^(?:🎯\s*)?Practicar\b.*?\bCap(?:[íi]tulo)?\.?\s+(\d{1,3})\b/i.exec(p.slice(0, 80)))) return chapterOf('cta', 'practice_cta', Number(m[1]), 'contenido «🎯 Practicar … Cap N»');
  if (/^✅\s*Evaluaci[óo]n de Unidad/i.test(p)) {
    const u = /\bUnidad\s+(\d{1,2})\b/i.exec(p.slice(0, 200));
    return courseOf('exam_info', 'contenido «✅ Evaluación de Unidad»', { unit: u ? Number(u[1]) : null });
  }
  if (/^(?:\S{1,3}\s+)?(?:Examen Final|EVALUACI[ÓO]N FINAL)/i.test(p)) return courseOf('final_exam_info', 'contenido «Examen Final»');
  const sec = i.sectionInfo?.kind;
  if (sec === 'welcome') {
    if (/^(?:\S{1,3}\s+)?CampusCloud · Curso en l[íi]nea/i.test(p)) return courseOf('welcome', 'contenido «CampusCloud · Curso en línea» (sección 0)');
    if (/<audio\b/i.test(html) || /Audio de Bienvenida/i.test(p.slice(0, 60))) return courseOf('welcome_audio', 'contenido con <audio> (sección 0)');
    if (/^(?:\S{1,3}\s+)?¿Qu[ée] Aprender[áa]s\?/i.test(p)) return courseOf('competencies', 'contenido «¿Qué Aprenderás?» (sección 0)');
    if (/^(?:\S{1,3}\s+)?(?:Metodolog[íi]a|¿?C[óo]mo funciona)/i.test(p)) return courseOf('methodology', 'contenido «Metodología» (sección 0)');
    if (/^(?:\S{1,3}\s+)?(?:Introducci[óo]n al Curso|Objetivos del curso|Estrategia (?:metodol[óo]gica )?y Duraci[óo]n)/i.test(p)) return courseOf('course_info', 'contenido «Introducción / Estrategia» (sección 0)');
  }
  if (sec === 'route') {
    if (/^(?:\S{1,3}\s+)?Ruta de Aprendizaje/i.test(p)) return courseOf('route', 'contenido «Ruta de Aprendizaje» (sección 1)');
    if (/^(?:\S{1,3}\s+)?Tu Gu[íi]a Completa|^(?:\S{1,3}\s+)?Libro gu[íi]a/i.test(p)) return courseOf('libro_info', 'contenido «Tu Guía Completa» (sección 1)');
    if (/^(?:\S{1,3}\s+)?Audiolibro/i.test(p)) return courseOf('audiobook', 'contenido «Audiolibro» (sección 1)');
  }
  return null;
}

/**
 * Títulos que Moodle deja en las actividades NO label de un re-export (las edita el docente en Moodle): hvp
 * «Capítulo N: T» → video; scorm «Actividad Interactiva Capítulo N» → game; quiz «Examen [Final] Unidad N» → exam;
 * «Examen Final …» → final_exam; resource «Libro Guia» → libro; page «Audio de Bienvenida…» / «Audiolibro…».
 */
export function classifyByReexportTitle(i: ClassifyInput): Classified | null {
  const t = (i.a.title || i.a.name || '').replace(/\s+/g, ' ').trim();
  const mod = i.a.modname;
  let m: RegExpExecArray | null;
  if (mod === 'hvp' && (m = /^Cap[íi]tulo (\d{1,3}):\s*(.*)$/.exec(t))) return chapterOf('video', 'video', Number(m[1]), 'título «Capítulo N: …» (hvp)', titleHint(m[2], 3));
  if (mod === 'scorm' && (m = /Actividad Interactiva Cap(?:[íi]tulo|\.)?\s*(\d{1,3})\b/i.exec(t))) return chapterOf('game', 'game', Number(m[1]), 'título «Actividad Interactiva Capítulo N»');
  if (mod === 'quiz' && (m = /^Examen (?:Final )?Unidad (\d{1,2})\b/.exec(t))) return courseOf('exam', `título «${t}»`, { unit: Number(m[1]) });
  if (mod === 'quiz' && /^Examen Final/.test(t)) return courseOf('final_exam', `título «${t}»`);
  if (mod === 'resource' && /Libro Gu[íi]a/i.test(t)) return courseOf('libro', `título «${t}»`);
  if ((mod === 'page' || mod === 'resource') && /^Audio de (?:Bienvenida|Introducci[óo]n)/i.test(t)) return courseOf('welcome_audio', `título «${t}»`);
  if ((mod === 'page' || mod === 'resource') && /^Audio ?libro/i.test(t)) return courseOf('audiobook', `título «${t}»`);
  // Libro Guía partido a mano por unidad («📘 Capítulos 1, 2 y 3…», «📘 Libro Unidad 2: …»).
  if (mod === 'resource' && /^📘\s*(?:Libro|Cap[íi]tulos)\b/.test(t)) return courseOf('libro', `título «${t}» (Libro Guía por partes)`);
  if (mod === 'label' && i.sectionInfo?.kind === 'welcome' && /^Bienvenid[ao]\b/i.test(t)) return courseOf('welcome', `título «${t}» (sección 0)`);
  // Moodle deja vacío el nombre de algunas actividades: el comienzo de su descripción (intro) dice qué son.
  if (!t || mod === 'hvp') {
    const p = i.plain.replace(/^\d{1,2}\s+/, '');
    if (mod === 'hvp' && (m = /^(?:\S{1,3}\s+)?Cap[íi]tulo (\d{1,3}):\s*(.*)$/.exec(p))) return chapterOf('video', 'video', Number(m[1]), 'descripción «🎬 Capítulo N: …» (hvp)', titleHint(m[2].slice(0, 120), 1));
    if (mod === 'scorm' && (m = /^(?:\S{1,3}\s+)?Actividad Interactiva\s*[·:]?\s*Cap[íi]tulo\s+(\d{1,3})\b/i.exec(p))) return chapterOf('game', 'game', Number(m[1]), 'descripción «🎮 Actividad Interactiva · Capítulo N» (scorm sin nombre)');
    if (mod === 'quiz' && (m = /^(?:\S{1,3}\s+)?Examen (?:Final )?Unidad (\d{1,2})\b/.exec(p))) return courseOf('exam', 'descripción «📝 Examen Unidad N» (quiz sin nombre)', { unit: Number(m[1]) });
    if (mod === 'quiz' && /^(?:\S{1,3}\s+)?Examen Final/.test(p)) return courseOf('final_exam', 'descripción «Examen Final» (quiz sin nombre)');
  }
  if (mod === 'forum') return courseOf('forum', 'foro del curso');
  return null;
}

/** Ninguna regla: rol o clase desconocidos, con el motivo visible. */
export function noRule(i: ClassifyInput, family: string): Classified {
  const t = (i.a.title || i.a.name || '').trim();
  return unknownOf(`ninguna regla de la familia ${family} reconoce un ${i.a.modname} titulado «${t.slice(0, 80)}»${i.plain ? ` que empieza con «${i.plain.slice(0, 60)}»` : ''}`);
}
