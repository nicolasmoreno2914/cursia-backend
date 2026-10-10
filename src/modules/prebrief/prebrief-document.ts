import { createHash } from 'crypto';
import type { PrebriefModel, PrebriefOrigin } from './prebrief-model';

/**
 * Prebrief pedagógico · DOCUMENTO (texto ya redactado, en bloques). Puro y determinista: plantillas en español neutro,
 * sin IA. La interfaz (frontend 56) y el PDF (prebrief-pdf.ts) son renderizadores SIN lógica de este documento: lo que
 * se lee en pantalla y lo que se lee en el PDF es el mismo texto, bloque por bloque (lo prueba check-prebrief.js).
 *
 * El estado (borrador, listo, aprobado…) y la aprobación NO son parte del documento: van aparte (PrebriefDocumentMeta),
 * así el contenido de una versión es idéntico en el PDF «para aprobación» y en el «aprobado».
 */

export const PREBRIEF_DOCUMENT_VERSION = 1 as const;

export const ORIGIN_LABEL: Record<PrebriefOrigin, string> = {
  requirement: 'Requisito del documento',
  document: 'Del documento',
  institution: 'Decisión de la institución',
  format: 'Configuración seleccionada',
  cursia: 'Recomendado por Cursia',
  exception: 'Excepción al documento',
};

export interface DocOrigin { key: PrebriefOrigin; label: string }
export interface DocEvidence { quote: string; page: number | null }

export type DocBlock =
  | { t: 'figures'; items: { value: string; label: string }[] }
  | { t: 'subheading'; text: string }
  | { t: 'paragraph'; text: string; origin?: DocOrigin; evidence?: DocEvidence; muted?: boolean }
  | { t: 'kv'; rows: { label: string; value: string; origin?: DocOrigin; evidence?: DocEvidence }[] }
  | { t: 'list'; items: { text: string; origin?: DocOrigin; note?: string }[] }
  | { t: 'outcomes'; items: { id: string; text: string; origin: DocOrigin; note: string; evidence?: DocEvidence }[] }
  | { t: 'modules'; origin: DocOrigin; modules: { title: string; hours: string; exam: boolean; chapters: { n: number; title: string; hours: string; tags: string[]; practice: boolean }[] }[]; footnote: string }
  | { t: 'matrix'; rowHeader: string; columns: string[]; rows: { label: string; cells: boolean[] }[]; empty: string }
  | { t: 'requirements'; items: { status: 'met' | 'exception' | 'not_verifiable' | 'conflict'; statusLabel: string; text: string; note?: string; evidence?: DocEvidence }[] }
  | { t: 'exceptions'; items: { rows: { label: string; value: string; strong?: boolean }[] }[] }
  | { t: 'callout'; tone: 'info' | 'warn'; text: string }
  | { t: 'legend'; title: string; items: { key: PrebriefOrigin; label: string; text: string }[] };

export interface DocSection {
  id: string;
  /** Número visible («1», «2»…; vacío en «El curso en una mirada» y el anexo). */
  n: string;
  title: string;
  blocks: DocBlock[];
}

export interface PrebriefDocument {
  prebriefDocumentVersion: typeof PREBRIEF_DOCUMENT_VERSION;
  cover: { kicker: string; title: string; subtitle: string[] };
  sections: DocSection[];
}

const o = (k: PrebriefOrigin): DocOrigin => ({ key: k, label: ORIGIN_LABEL[k] });
const n1 = (n: number) => String(Math.round(Number(n) * 10) / 10).replace('.', ',');
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const hoursText = (n: number) => `${n1(n)} ${Number(n) === 1 ? 'hora' : 'horas'}`;
const join = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} y ${xs[xs.length - 1]}`);
/** LOOP 9.1 (A2): «estructura 4 × 5 (20 capítulos)» → «Estructura de 4 módulos × 5 capítulos (20 capítulos)» (solo al mostrar). */
const reqDisplay = (t: string) => {
  const x = /^estructura (\d+) × (\d+) \((\d+) capítulos\)$/i.exec(t);
  const y = /^estructura ((?:\d+, )+\d+) \((\d+) capítulos\)$/i.exec(t);
  const out = x ? `estructura de ${x[1]} ${x[1] === '1' ? 'módulo' : 'módulos'} × ${x[2]} ${x[2] === '1' ? 'capítulo' : 'capítulos'} (${x[3]} capítulos)`
    : y ? `estructura de ${y[1].split(', ').length} módulos con ${y[1].replace(/, (\d+)$/, ' y $1')} capítulos (${y[2]} capítulos)` : t;
  return out.charAt(0).toUpperCase() + out.slice(1);
};
const chaptersText = (ns: number[]) => (ns.length === 1 ? `capítulo ${ns[0]}` : `capítulos ${join(ns.map(String))}`);

export const ORIGIN_LEGEND: { key: PrebriefOrigin; text: string }[] = [
  { key: 'requirement', text: 'lo exige el documento institucional y el diseño lo cumple.' },
  { key: 'document', text: 'dato tomado del documento institucional.' },
  { key: 'institution', text: 'lo definió o confirmó la institución.' },
  { key: 'format', text: 'proviene del formato de curso seleccionado.' },
  { key: 'cursia', text: 'propuesta de Cursia a partir de la información disponible.' },
  { key: 'exception', text: 'la institución decidió apartarse de un requisito del documento (con su motivo).' },
];

export function buildPrebriefDocument(m: PrebriefModel): PrebriefDocument {
  const sections: DocSection[] = [];
  const S = m.structure;
  const R = m.resources;
  const reqC = m.requirements.counts;
  // LOOP 9.1 (A2): el N×M que lee el cliente es de capítulos de contenido; la práctica se nombra aparte (como en el formato).
  const contentPer = S.modules.map((md) => md.chapters.filter((c) => c.kind !== 'practice').length);
  const sameContent = contentPer.length > 0 && contentPer.every((n) => n === contentPer[0]);
  // Misma redacción que la excepción («…, más 1 capítulo de práctica por módulo»).
  const practicePer = S.modules.map((md) => md.chapters.filter((c) => c.kind === 'practice').length);
  const practiceText = !S.totals.practiceChapters ? ''
    : practicePer.every((n) => n === practicePer[0]) ? `, más ${plural(practicePer[0], 'capítulo de práctica', 'capítulos de práctica')} por módulo`
      : `, más ${plural(S.totals.practiceChapters, 'capítulo de práctica', 'capítulos de práctica')}`;
  const organization = sameContent
    ? `${plural(S.totals.modules, 'módulo', 'módulos')} × ${plural(contentPer[0], 'capítulo de contenido', 'capítulos de contenido')}${practiceText}`
    : `${plural(S.totals.modules, 'módulo', 'módulos')} · ${plural(S.totals.contentChapters, 'capítulo de contenido', 'capítulos de contenido')}${practiceText}`;

  // ── El curso en una mirada ──
  const figures: { value: string; label: string }[] = [];
  // Las horas DEL DISEÑO (lo que se produce); el formato o la meta, como referencia en la etiqueta.
  figures.push({ value: `${n1(S.totals.hours)} h`, label: m.duration.format ? `de trabajo del estudiante · ${m.duration.format.value} (${m.duration.format.hoursMin}–${m.duration.format.hoursMax} h)` : 'de trabajo del estudiante' });
  figures.push(sameContent
    ? { value: `${S.totals.modules} × ${contentPer[0]}`, label: 'módulos × capítulos de contenido' }
    : { value: `${S.totals.modules} · ${S.totals.contentChapters}`, label: 'módulos · capítulos de contenido' });
  figures.push({ value: String(m.goals.outcomes.length), label: m.goals.outcomes.length === 1 ? 'resultado de aprendizaje' : 'resultados de aprendizaje' });
  if (reqC.total) figures.push({ value: `${reqC.met} de ${reqC.total}`, label: 'requisitos del documento cumplidos' });
  else figures.push({ value: String(R.moduleExams + (R.finalExam ? 1 : 0)), label: 'evaluaciones' });
  const glance: DocBlock[] = [{ t: 'figures', items: figures }];
  const who = m.learner.description ? m.learner.description.value : null;
  const summaryParts: string[] = [];
  summaryParts.push(`Curso virtual de ${hoursText(S.totals.hours)} de trabajo del estudiante, organizado en ${organization}.`);
  if (who) summaryParts.push(`Está dirigido a: ${who.replace(/\.$/, '')}.`);
  if (m.pedagogy.approach) summaryParts.push(`Enfoque pedagógico: ${m.pedagogy.approach.value.toLowerCase()}.`);
  glance.push({ t: 'paragraph', text: summaryParts.join(' ') });
  // LOOP 9.2 (capacidades): lo que Cursia no cubre con su capacidad actual se dice aparte de las decisiones de la institución.
  const capEx = m.exceptions.filter((e) => e.capability);
  const ownEx = m.exceptions.length - capEx.length;
  if (capEx.length) glance.push({ t: 'callout', tone: 'warn', text: `Requiere su atención: ${plural(capEx.length, 'requisito', 'requisitos')} del documento que Cursia no cubre con su capacidad actual${capEx.every((e) => e.reason) ? ', aceptados por la institución como excepción' : '; para aprobar, la institución debe aceptar la diferencia'} (sección 12).` });
  if (ownEx) glance.push({ t: 'callout', tone: 'warn', text: `Requiere su atención: ${plural(ownEx, 'excepción', 'excepciones')} al documento institucional (sección 12).` });
  glance.push({ t: 'legend', title: 'Cómo leer el origen de cada dato', items: ORIGIN_LEGEND.map((x) => ({ key: x.key, label: ORIGIN_LABEL[x.key], text: x.text })) });
  sections.push({ id: 'glance', n: '', title: 'El curso en una mirada', blocks: glance });

  // ── 1. Información general ──
  const info: { label: string; value: string; origin?: DocOrigin; evidence?: DocEvidence }[] = [{ label: 'Nombre del curso', value: m.course.title }];
  if (m.course.program) info.push({ label: 'Programa', value: m.course.program.value, origin: o(m.course.program.origin), evidence: m.course.program.evidence });
  if (m.course.institution) info.push({ label: 'Institución', value: m.course.institution });
  info.push({ label: 'Modalidad', value: m.course.modality.value, origin: o(m.course.modality.origin) });
  if (m.duration.targetHours) info.push({ label: 'Duración', value: `${hoursText(m.duration.targetHours.value)} de trabajo del estudiante (meta del diseño)`, origin: o(m.duration.targetHours.origin) });
  if (m.duration.format) info.push({ label: 'Formato', value: `${m.duration.format.value}: ${m.duration.format.modules} módulos × ${m.duration.format.chaptersPerModule} capítulos de contenido · ${m.duration.format.hoursMin}–${m.duration.format.hoursMax} horas`, origin: o('format') });
  if (m.duration.credits) info.push({ label: 'Créditos', value: n1(m.duration.credits.value), origin: o(m.duration.credits.origin) });
  info.push({ label: 'Idioma', value: 'Español' });
  sections.push({ id: 'general', n: '1', title: 'Información general', blocks: [{ t: 'kv', rows: info }] });

  // ── 2. Público objetivo ──
  const pub: DocBlock[] = [];
  if (m.learner.description) pub.push({ t: 'paragraph', text: m.learner.description.value, origin: o(m.learner.description.origin) });
  else pub.push({ t: 'paragraph', text: 'La institución no describió todavía el perfil del estudiante.', muted: true });
  const pubRows: { label: string; value: string; origin?: DocOrigin }[] = [];
  if (m.course.level) pubRows.push({ label: 'Nivel', value: m.course.level.value, origin: o(m.course.level.origin) });
  if (m.learner.priorKnowledge) pubRows.push({ label: 'Conocimientos previos', value: m.learner.priorKnowledge.value, origin: o(m.learner.priorKnowledge.origin) });
  if (m.learner.prerequisites) {
    const k = m.learner.prerequisites.kind;
    pubRows.push({ label: k === 'recommended' ? 'Conocimientos previos que recomienda el documento' : k === 'none' ? 'Conocimientos previos según el documento' : 'Conocimientos previos que pide el documento', value: m.learner.prerequisites.value, origin: o(m.learner.prerequisites.origin) });
  }
  if (pubRows.length) pub.push({ t: 'kv', rows: pubRows });
  sections.push({ id: 'audience', n: '2', title: 'Público objetivo', blocks: pub });

  // ── 3. Objetivo general ──
  const obj = m.goals.generalObjective;
  sections.push({ id: 'objective', n: '3', title: 'Objetivo general', blocks: obj
    ? [{ t: 'paragraph', text: obj.value, origin: o(obj.origin), evidence: obj.evidence }, ...(obj.label !== 'Objetivo general' ? [{ t: 'paragraph' as const, text: 'El documento no define un objetivo general: se presenta el propósito del curso indicado por la institución.', muted: true }] : [])]
    : [{ t: 'paragraph', text: 'El documento no define un objetivo general; el curso se orienta por sus resultados de aprendizaje.', muted: true }] });

  // ── 4. Resultados de aprendizaje y competencias ──
  const examOf = (id: string) => {
    const xs: string[] = m.evaluation.moduleExams.filter((e) => e.outcomeIds.includes(id)).map((e) => `evaluación del módulo ${e.module}`);
    if (m.evaluation.applicationActivities.some((a) => a.outcomeIds.includes(id))) xs.push('Actividad de Aplicación');
    if (m.evaluation.finalExam) xs.push('evaluación final');
    return xs;
  };
  const outBlocks: DocBlock[] = [];
  if (m.goals.outcomes.length) {
    outBlocks.push({ t: 'outcomes', items: m.goals.outcomes.map((x) => {
      const ev = examOf(x.id);
      const note = [x.chapters.length ? `Se desarrolla en: ${chaptersText(x.chapters)}` : 'Sin capítulo asignado', ev.length ? `Se evidencia en: ${join(ev)}` : ''].filter(Boolean).join(' · ');
      return { id: x.id, text: x.text, origin: o(x.origin), note, evidence: x.evidence };
    }) });
  } else outBlocks.push({ t: 'paragraph', text: 'El curso todavía no tiene resultados de aprendizaje.', muted: true });
  if (m.goals.competencies.length) outBlocks.push({ t: 'list', items: m.goals.competencies.map((c) => ({ text: `${c.id}. ${c.text}`, origin: o(c.origin) })) });
  sections.push({ id: 'outcomes', n: '4', title: m.goals.competencies.length ? 'Resultados de aprendizaje y competencias' : 'Resultados de aprendizaje', blocks: outBlocks });

  // ── 5. Enfoque pedagógico ──
  const ap = m.pedagogy.approach;
  sections.push({ id: 'approach', n: '5', title: 'Enfoque pedagógico', blocks: ap
    ? [{ t: 'paragraph', text: ap.value, origin: o(ap.origin) }, ...(ap.summary ? [{ t: 'paragraph' as const, text: ap.summary }] : [])]
    : [{ t: 'paragraph', text: 'Sin enfoque pedagógico definido.', muted: true }] });

  // ── 6. Metodología ──
  const met: DocBlock[] = [{ t: 'paragraph', text: 'Cada capítulo combina una presentación del tema, un texto de estudio, actividades interactivas con retroalimentación y, cuando el diseño lo indica, un video con preguntas y una Actividad de Aplicación.' }];
  if (m.pedagogy.cycle.length) met.push({ t: 'list', items: m.pedagogy.cycle.map((t) => ({ text: t })) });
  if (m.pedagogy.methodologyFromDocument) met.push({ t: 'paragraph', text: `Metodología indicada por el documento: ${m.pedagogy.methodologyFromDocument.value}`, origin: o(m.pedagogy.methodologyFromDocument.origin), evidence: m.pedagogy.methodologyFromDocument.evidence });
  sections.push({ id: 'methodology', n: '6', title: 'Metodología', blocks: met });

  // ── 7. Duración y estructura ──
  const st: DocBlock[] = [];
  const durRows: { label: string; value: string; origin?: DocOrigin }[] = [];
  if (m.duration.targetHours) durRows.push({ label: 'Meta de horas', value: hoursText(m.duration.targetHours.value), origin: o(m.duration.targetHours.origin) });
  durRows.push({ label: 'Horas del diseño', value: `${hoursText(S.totals.hours)} de trabajo del estudiante (estimadas)` });
  durRows.push({ label: 'Organización', value: organization, origin: o(S.origin) });
  // Fase 2/3: la forma elegida y quién la eligió; los contenidos del documento que quedaron en el diseño.
  if (S.selected) durRows.push({ label: 'Diseño seleccionado', value: `${organization} · ${S.selected.label}` });
  if (S.contents) durRows.push({ label: 'Contenidos del documento', value: S.contents.covered === S.contents.total ? `Los ${S.contents.total} contenidos del documento están en el diseño, cada uno en un capítulo.` : `${S.contents.covered} de ${S.contents.total} contenidos del documento están en el diseño.` });
  st.push({ t: 'kv', rows: durRows });
  st.push({ t: 'modules', origin: o(S.origin), footnote: m.duration.format ? `Las prácticas y las Actividades de Aplicación no cuentan dentro del ${m.duration.format.value} (${m.duration.format.modules} × ${m.duration.format.chaptersPerModule}).` : 'Horas de trabajo del estudiante estimadas por Cursia para cada capítulo.',
    modules: S.modules.map((md) => ({
      title: `Módulo ${md.n} · ${md.title}`, hours: `${n1(md.hours)} h`, exam: md.exam,
      chapters: md.chapters.map((c) => ({
        n: c.n, title: c.title + (c.proposed ? ' (propuesto)' : ''), hours: `${n1(c.hours)} h`, practice: c.kind === 'practice',
        tags: [c.kind === 'practice' ? 'Práctica' : '', c.video ? 'Video' : '', c.activity ? 'Actividad' : '', c.applicationMinutes ? `Aplicación ${c.applicationMinutes} min` : ''].filter(Boolean),
      })),
    })) });
  sections.push({ id: 'structure', n: '7', title: 'Duración y estructura', blocks: st });

  // ── 8. Estrategia de evaluación ──
  const ev: DocBlock[] = [];
  const evList: { text: string; note?: string }[] = [];
  for (const e of m.evaluation.moduleExams) evList.push({ text: `Evaluación del módulo ${e.module}: ${e.title}`, note: e.outcomeIds.length ? `Resultados: ${e.outcomeIds.join(', ')}` : undefined });
  if (m.evaluation.finalExam) evList.push({ text: 'Evaluación final integradora', note: m.goals.outcomes.length ? `Resultados: ${m.goals.outcomes.map((x) => x.id).join(', ')}` : undefined });
  for (const a of m.evaluation.applicationActivities) evList.push({ text: `Actividad de Aplicación del capítulo ${a.chapter} (${a.minutes} min): ${a.title}`, note: 'Evidencia de desempeño; el solucionario queda solo para docentes.' });
  ev.push({ t: 'subheading', text: 'Evaluaciones del curso' });
  if (m.evaluation.passingGrade !== null) ev.push({ t: 'paragraph', text: `Nota mínima de aprobación del curso: ${n1(m.evaluation.passingGrade)} sobre 100.`, origin: o('institution') });
  ev.push(evList.length ? { t: 'list', items: evList } : { t: 'paragraph', text: 'El diseño no incluye evaluaciones.', muted: true });
  ev.push({ t: 'subheading', text: 'Relación entre resultados y evaluaciones' });
  const cols: string[] = [...m.evaluation.moduleExams.map((e) => (m.evaluation.moduleExams.length > 6 ? `M${e.module}` : `Ev. M${e.module}`)), ...(m.evaluation.applicationActivities.length ? [m.evaluation.moduleExams.length > 6 ? 'Apl.' : 'Aplicación'] : []), ...(m.evaluation.finalExam ? ['Final'] : [])];
  ev.push({ t: 'matrix', rowHeader: 'Resultado', columns: cols, empty: 'Sin resultados de aprendizaje para relacionar con la evaluación.',
    rows: cols.length ? m.goals.outcomes.map((x) => ({ label: x.id, cells: [
      ...m.evaluation.moduleExams.map((e) => e.outcomeIds.includes(x.id)),
      ...(m.evaluation.applicationActivities.length ? [m.evaluation.applicationActivities.some((a) => a.outcomeIds.includes(x.id))] : []),
      ...(m.evaluation.finalExam ? [true] : []),
    ] })) : [] });
  if (m.evaluation.fromDocument.length) ev.push({ t: 'subheading', text: 'Evaluaciones indicadas por el documento' });
  if (m.evaluation.fromDocument.length) ev.push({ t: 'list', items: m.evaluation.fromDocument.map((e) => ({ text: `${e.text}${e.weightPct !== null ? ` (${n1(e.weightPct)} %)` : ''}`, origin: o(e.origin), note: e.outcomeIds.length ? `Resultados: ${e.outcomeIds.join(', ')}` : undefined })) });
  sections.push({ id: 'evaluation', n: '8', title: 'Estrategia de evaluación', blocks: ev });

  // ── 9. Recursos previstos ──
  const res: { text: string; note?: string }[] = [];
  // LOOP 9.1 (A3): todo lo de esta sección está PREVISTO por el diseño; nada se produjo todavía (se produce después de aprobar).
  if (R.presentations) res.push({ text: plural(R.presentations, 'presentación prevista', 'presentaciones previstas'), note: 'Una por capítulo de contenido, para introducir el tema.' });
  if (R.videos) res.push({ text: plural(R.videos, 'video educativo previsto', 'videos educativos previstos'), note: 'Con preguntas integradas para comprobar la comprensión.' });
  if (R.interactiveActivities) res.push({ text: plural(R.interactiveActivities, 'actividad interactiva prevista', 'actividades interactivas previstas'), note: 'Práctica con retroalimentación inmediata.' });
  if (R.applicationActivities) res.push({ text: plural(R.applicationActivities, 'Actividad de Aplicación prevista', 'Actividades de Aplicación previstas'), note: 'Casos o talleres con solucionario solo para docentes.' });
  if (R.audiobookChapters) res.push({ text: `Audiolibro previsto (${plural(R.audiobookChapters, 'capítulo', 'capítulos')})`, note: 'Versión en audio de los contenidos.' });
  if (R.welcomeAudio) res.push({ text: 'Mensaje de bienvenida en audio' });
  if (R.guideBook) res.push({ text: 'Libro Guía del curso', note: 'Documento descargable con todos los contenidos.' });
  sections.push({ id: 'resources', n: '9', title: 'Recursos previstos', blocks: res.length
    ? [{ t: 'paragraph', text: 'Estos son los recursos que el diseño prevé para el curso. Todavía no existen: se elaboran en la etapa de producción, después de aprobar esta propuesta.' }, { t: 'list', items: res }]
    : [{ t: 'paragraph', text: 'Sin recursos previstos.', muted: true }] });

  // ── 10. Requisitos institucionales ──
  const STATUS: Record<string, string> = { met: 'Cumple', exception: 'Excepción', not_verifiable: 'No verificable', conflict: 'Conflicto' };
  const exOf = new Map(m.exceptions.map((e) => [e.requirementKey, e] as [string, (typeof m.exceptions)[number]]));
  const statusLabelOf = (i: { key: string; status: string; doubtful?: true }) => {
    if (i.doubtful) return 'Por confirmar';
    const e = i.status === 'exception' ? exOf.get(i.key) : undefined;
    if (e && e.capability) return e.reason ? 'Excepción aceptada' : 'No cubierto';
    return STATUS[i.status];
  };
  const capReq = m.requirements.items.filter((i) => i.status === 'exception' && exOf.get(i.key)?.capability);
  /** «Cursia contempla 1 video por capítulo…» → «1 video por capítulo…» (va bajo el rótulo «Propuesta de Cursia»). */
  const proposalText = (t: string) => { const x = String(t || '').replace(/^Cursia (contempla|produce|diseña) /, ''); return x ? x.charAt(0).toUpperCase() + x.slice(1) : '—'; };
  const toConfirm = m.requirements.items.filter((i) => i.doubtful).length;
  // LOOP 9.1 QA: la decisión aplicada es la MISMA que en la sección 12 (p. ej. «Cursia produce un video por capítulo»).
  const appliedOf = new Map(m.exceptions.map((e) => [e.requirementKey, e.appliedText] as [string, string]));
  const notVerif = reqC.notVerifiable - toConfirm;
  const rq: DocBlock[] = [];
  if (!m.requirements.hasDocument) rq.push({ t: 'paragraph', text: 'Este curso no tiene un documento institucional de referencia.', muted: true });
  else if (!m.requirements.items.length) rq.push({ t: 'paragraph', text: `El documento (${m.requirements.documentNames.join(', ')}) no establece requisitos de diseño que Cursia deba cumplir.`, muted: true });
  else {
    const ownExc = reqC.exceptions - capReq.length;
    const capAccepted = capReq.filter((i) => exOf.get(i.key)!.reason).length;
    const capText = capReq.length ? `; ${capReq.length} no ${capReq.length === 1 ? 'lo cubre' : 'los cubre'} Cursia con su capacidad actual${capAccepted === capReq.length ? ` (la institución ${capReq.length === 1 ? 'aceptó la diferencia' : 'aceptó las diferencias'})` : ' (la institución debe aceptar la diferencia para aprobar)'}` : '';
    rq.push({ t: 'paragraph', text: `${reqC.met} de ${reqC.total} requisitos del documento se cumplen${capText}${ownExc ? `; ${plural(ownExc, 'tiene', 'tienen')} una excepción decidida por la institución` : ''}${notVerif ? `; ${notVerif} no ${notVerif === 1 ? 'es verificable' : 'son verificables'} automáticamente` : ''}${toConfirm ? `; ${toConfirm} ${toConfirm === 1 ? 'queda' : 'quedan'} por confirmar` : ''}.` });
    rq.push({ t: 'requirements', items: m.requirements.items.map((i) => ({
      status: i.status, statusLabel: statusLabelOf(i), text: reqDisplay(i.text),
      note: i.status === 'exception' && exOf.get(i.key)?.capability
        ? `Propuesta de Cursia: ${proposalText(appliedOf.get(i.key) || '')}. ${exOf.get(i.key)!.reason ? 'La institución aceptó la diferencia (ver sección 12).' : 'Para aprobar, la institución debe aceptar la diferencia (ver sección 12).'}`
        : i.status === 'exception' ? `Decisión aplicada: ${appliedOf.get(i.key) || i.actual || '—'} (ver sección 12).` : i.status === 'not_verifiable' ? (i.doubtful && i.detail ? i.detail : 'Cursia no puede comprobarlo automáticamente; se incorpora como orientación del diseño.') : i.status === 'conflict' ? `El diseño tiene ${i.actual || '—'}.` : undefined,
      evidence: i.evidence || undefined,
    })) });
  }
  for (const a of m.requirements.alternatives) if (a.selected) rq.push({ t: 'paragraph', text: `El documento ofrece alternativas (${a.options.join(', ')}); la institución eligió: ${a.selected}.`, origin: o('institution') });
  sections.push({ id: 'requirements', n: '10', title: 'Requisitos institucionales y cumplimiento', blocks: rq });

  // ── 11. Decisiones de la institución ──
  sections.push({ id: 'decisions', n: '11', title: 'Decisiones de la institución', blocks: [m.decisions.length
    ? { t: 'kv', rows: m.decisions.map((d) => ({ label: d.label, value: d.value, origin: o(d.origin) })) }
    : { t: 'paragraph', text: 'La institución adoptó la propuesta de Cursia sin cambios.', muted: true }] });

  // ── 12. Excepciones ──
  sections.push({ id: 'exceptions', n: '12', title: 'Excepciones al documento', blocks: [m.exceptions.length
    ? { t: 'exceptions', items: m.exceptions.map((e) => ({ rows: [
      { label: 'Requisito original', value: reqDisplay(e.requirementText) },
      { label: e.capability ? 'Propuesta de Cursia' : 'Decisión aplicada', value: e.capability ? proposalText(e.appliedText) : e.appliedText },
      { label: 'Tipo', value: e.capability ? (e.reason ? 'Requisito no cubierto por Cursia · excepción aceptada' : 'Requisito no cubierto por Cursia (capacidad actual)') : 'Excepción al requisito del documento' },
      { label: e.capability ? 'Aceptación de la institución' : 'Motivo', value: e.reason || (e.capability ? 'Pendiente: sin aceptación no se puede aprobar' : 'Motivo pendiente'), strong: true },
      { label: 'Responsable', value: e.by || '—' },
      { label: 'Fecha', value: e.at ? formatDateEs(e.at) : '—' },
    ] })) }
    : { t: 'paragraph', text: 'Ninguna. El diseño no se aparta de los requisitos del documento.', muted: true }] });

  // ── 13. Observaciones ──
  sections.push({ id: 'observations', n: '13', title: 'Observaciones', blocks: [m.observations.length
    ? { t: 'list', items: m.observations.map((x) => ({ text: x.text })) }
    : { t: 'paragraph', text: 'Sin observaciones.', muted: true }] });

  // ── 14. Aprobación (el bloque de estado lo agrega cada renderizador con la metadata de la versión) ──
  sections.push({ id: 'approval', n: '14', title: 'Aprobación', blocks: [
    { t: 'paragraph', text: 'Al aprobar, la institución confirma el diseño pedagógico de esta versión: público, resultados de aprendizaje, estructura, horas, estrategia de evaluación y recursos previstos. El contenido se produce después y puede revisarse en el aula virtual.' },
    { t: 'list', items: [{ text: 'Próximo paso 1: producción del curso sobre este diseño aprobado.' }, { text: 'Próximo paso 2: revisión del curso en el aula virtual.' }, { text: 'Próximo paso 3: ajustes de contenido, si se requieren.' }] },
  ] });

  // ── Anexo: trazabilidad ──
  const ann: { label: string; value: string; origin?: DocOrigin }[] = [];
  if (m.requirements.documentNames.length) ann.push({ label: 'Documentos de referencia', value: m.requirements.documentNames.join(', ') });
  const evid: { text: string; note?: string }[] = [];
  for (const x of m.goals.outcomes) if (x.evidence) evid.push({ text: `${x.id}: «${x.evidence.quote}»`, note: x.evidence.page ? `Página ${x.evidence.page}` : undefined });
  for (const i of m.requirements.items) if (i.evidence) evid.push({ text: `${reqDisplay(i.text)}: «${i.evidence.quote}»`, note: i.evidence.page ? `Página ${i.evidence.page}` : undefined });
  const annex: DocBlock[] = [];
  if (ann.length) annex.push({ t: 'kv', rows: ann });
  annex.push(evid.length ? { t: 'list', items: evid } : { t: 'paragraph', text: 'Sin citas del documento.', muted: true });
  sections.push({ id: 'annex', n: 'A', title: 'Anexo: trazabilidad', blocks: annex });

  const subtitle = [m.course.program ? m.course.program.value : '', m.course.institution || ''].filter(Boolean);
  return { prebriefDocumentVersion: PREBRIEF_DOCUMENT_VERSION, cover: { kicker: 'Propuesta de diseño pedagógico', title: m.course.title, subtitle }, sections };
}

/** Todo el texto visible del documento, en orden (paridad interfaz/PDF y Language QA). */
export function documentTexts(d: PrebriefDocument): string[] {
  const out: string[] = [d.cover.kicker, d.cover.title, ...d.cover.subtitle];
  for (const s of d.sections) {
    if (s.n) out.push(s.n);
    out.push(s.title);
    for (const b of s.blocks) {
      switch (b.t) {
        case 'figures': for (const i of b.items) out.push(i.value, i.label); break;
        case 'subheading': out.push(b.text); break;
        case 'paragraph': out.push(b.text); if (b.origin) out.push(b.origin.label); break;
        case 'kv': for (const r of b.rows) { out.push(r.label, r.value); if (r.origin) out.push(r.origin.label); } break;
        case 'list': for (const i of b.items) { out.push(i.text); if (i.note) out.push(i.note); if (i.origin) out.push(i.origin.label); } break;
        case 'outcomes': for (const i of b.items) out.push(i.id, i.text, i.origin.label, i.note); break;
        case 'modules':
          for (const md of b.modules) {
            out.push(md.title, md.hours);
            for (const c of md.chapters) out.push(`${c.n}. ${c.title}`, c.hours, ...c.tags);
            if (md.exam) out.push('Evaluación del módulo');
          }
          out.push(b.footnote);
          break;
        case 'matrix': if (b.rows.length) { out.push(b.rowHeader, ...b.columns); for (const r of b.rows) out.push(r.label); } else out.push(b.empty); break;
        case 'requirements': for (const i of b.items) { out.push(i.statusLabel, i.text); if (i.note) out.push(i.note); } break;
        case 'exceptions': for (const e of b.items) for (const r of e.rows) out.push(r.label, r.value); break;
        case 'callout': out.push(b.text); break;
        case 'legend': out.push(b.title); for (const i of b.items) out.push(i.label, i.text); break;
      }
    }
  }
  return out.filter((t) => typeof t === 'string' && t.trim() !== '');
}

function sortKeysDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeysDeep);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) { const x = (v as Record<string, unknown>)[k]; if (x !== undefined) out[k] = sortKeysDeep(x); }
    return out;
  }
  return v;
}
export function documentSha(d: PrebriefDocument): string {
  return createHash('sha256').update(JSON.stringify(sortKeysDeep(d))).digest('hex');
}

/** Estado de una versión para los renderizadores (no es parte del documento). */
export type PrebriefStatus = 'draft' | 'ready' | 'changes_requested' | 'approved' | 'invalidated';
export const STATUS_LABEL: Record<PrebriefStatus, string> = {
  draft: 'Borrador',
  ready: 'Listo para aprobación',
  changes_requested: 'Cambios solicitados',
  approved: 'Aprobado',
  invalidated: 'Invalidado',
};
export interface PrebriefDocumentMeta {
  status: PrebriefStatus;
  version: number | null;
  /** ISO de la preparación (o null en borrador). */
  date: string | null;
  fingerprint: string;
  approval: { name: string; role: string; at: string; email: string | null } | null;
  /** Solo invalidada: por qué dejó de valer. */
  invalidationReason?: 'design_changed' | 'superseded' | 'withdrawn' | null;
}

/** «13 de octubre de 2026, 10:42 (UTC-5)» — siempre la misma hora en la interfaz y en el PDF (la arma el servidor). */
export function formatDateEs(iso: string, withTime = false): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  const b = new Date(d.getTime() - 5 * 3600 * 1000); // UTC-5 (Colombia, Perú, Ecuador; sin horario de verano)
  const date = `${b.getUTCDate()} de ${MONTHS[b.getUTCMonth()]} de ${b.getUTCFullYear()}`;
  if (!withTime) return date;
  return `${date}, ${String(b.getUTCHours()).padStart(2, '0')}:${String(b.getUTCMinutes()).padStart(2, '0')} (UTC-5)`;
}

export const SIGNATURE_NOTE = 'Aprobación registrada en Cursia (no es una firma electrónica).';

/** Textos del bloque de estado/aprobación: los MISMOS en la interfaz y en el PDF (el primero es el título). */
export function approvalStateTexts(meta: PrebriefDocumentMeta): string[] {
  const v = meta.version !== null ? `Versión ${meta.version}` : 'Borrador sin versión';
  const code = `Código de verificación ${meta.fingerprint.slice(0, 8)}`;
  const approvedBy = meta.approval ? [`Aprobado por: ${meta.approval.name}`, `Cargo: ${meta.approval.role}`, `Fecha: ${formatDateEs(meta.approval.at, true)}`] : [];
  if (meta.status === 'approved' && meta.approval) return ['APROBADO', ...approvedBy, `${v} · ${code}`, SIGNATURE_NOTE];
  if (meta.status === 'ready') return ['PENDIENTE DE APROBACIÓN', `${v} · ${code}`, 'La aprobación la registra en Cursia el responsable del curso.'];
  if (meta.status === 'changes_requested') return ['CAMBIOS SOLICITADOS', `${v} · ${code}`, 'Esta versión no se aprobó: se prepara una nueva versión con los ajustes.'];
  if (meta.status === 'invalidated') {
    const why = meta.invalidationReason === 'superseded' ? 'Fue reemplazada por una versión posterior.'
      : meta.invalidationReason === 'withdrawn' ? 'Fue retirada antes de aprobarse.' : 'El diseño cambió después de esta versión.';
    return ['VERSIÓN INVALIDADA · NO VIGENTE', `${v} · ${code}`, why, ...(meta.approval ? [`Había sido aprobada por ${meta.approval.name} (${meta.approval.role}) el ${formatDateEs(meta.approval.at, true)}.`] : [])];
  }
  return ['BORRADOR · NO APROBABLE', 'Vista previa: todavía no es una versión para aprobar.'];
}
