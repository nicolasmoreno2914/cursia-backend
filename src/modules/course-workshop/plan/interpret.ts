/**
 * r107 B5 · Interpretación de pedidos: valida la salida de la IA con un esquema ESTRICTO y RESUELVE cada pedido contra el
 * inventario de ESTA sesión (D6: lo que no resuelve a un destino único o a un cambio concreto queda `needs_answer` con
 * 1–3 preguntas; el servidor nunca elige por el docente).
 *
 *  - Esquema (parseInterpretation): claves conocidas y nada más, operación del catálogo cerrado, `quote` LITERAL del
 *    pedido (si la IA «cita» algo que el docente no escribió, la salida no sirve), tipos y largos. Una salida que no
 *    cumple → InterpretationOutputError (el llamador reintenta UNA vez y, si no, la entrada queda `failed` con el motivo).
 *  - Resolución (resolveRequest): cada id contra el inventario; un id que no existe en el paquete NUNCA pasa (pregunta);
 *    un destino «por capítulo» con varias candidatas → pregunta cerrada con las candidatas; sin instrucción concreta →
 *    pregunta abierta.
 *  - Respuestas (answerRequest): las preguntas del servidor se resuelven sin IA (cada opción trae su destino); las de la
 *    IA, o una respuesta escrita, vuelven a la IA (solo ese pedido).
 *
 * Puro.
 */
import { WorkshopActivity, WorkshopCourse, plainText } from '../course-model';
import { activityLabel, activityOf, chapterRoleActivities, chapterTextCandidates, editableField } from './summary';
import {
  AI_OPERATION_VALUES, ClarifyAnswer, ClarifyOption, ClarifyQuestion, InterpretedRequest, LATER_OPERATIONS, PLAN_LIMITS, RequestDetails, RequestOperation, ResolvedTarget,
} from './types';

export class InterpretationOutputError extends Error {
  constructor(readonly problems: string[]) {
    super(`WORKSHOP_INTERPRETATION_INVALID: ${problems.slice(0, 6).join('; ')}`);
  }
}

/** Pedido tal como lo devuelve la IA (ya validado por el esquema). */
export interface RawAiRequest {
  quote: string;
  operation: (typeof AI_OPERATION_VALUES)[number];
  instruction: string;
  target: RawTarget | null;
  colors: Array<{ from: string; to: string }>;
  chapters: number | null;
  reason: string | null;
  questions: Array<{ text: string; options: Array<{ id: string; label: string; target: RawTarget | null }> }>;
  /** Fix round 1 (P2-3): fragmentos LITERALES del pedido que justifican el destino y el cambio. */
  targetEvidence?: string | null;
  changeEvidence?: string | null;
}
export interface RawTarget { moduleId?: number; field?: string; chapterNumber?: number; chapters?: number[]; questionId?: number; quizModuleId?: number; moduleNumber?: number }

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const REQ_KEYS = new Set(['quote', 'operation', 'instruction', 'target', 'colors', 'chapters', 'reason', 'questions', 'targetEvidence', 'changeEvidence']);
const TARGET_KEYS = new Set(['moduleId', 'field', 'chapterNumber', 'chapters', 'questionId', 'quizModuleId', 'moduleNumber']);
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** Texto normalizado para comparar citas (minúsculas, espacios colapsados, comillas tipográficas unificadas). */
export function normalizeQuote(s: string): string {
  return String(s).normalize('NFC').replace(/[“”«»„]/g, '"').replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim().toLowerCase();
}

function targetOf(v: unknown, where: string, problems: string[]): RawTarget | null {
  if (v === undefined || v === null) return null;
  if (!isObj(v)) { problems.push(`${where}: target no es un objeto`); return null; }
  const out: RawTarget = {};
  for (const [k, x] of Object.entries(v)) {
    if (!TARGET_KEYS.has(k)) { problems.push(`${where}: clave desconocida en target «${k}»`); continue; }
    if (k === 'field') { if (typeof x !== 'string' || !/^[a-z0-9_:]{1,40}$/i.test(x)) problems.push(`${where}: field inválido`); else out.field = x; continue; }
    if (k === 'chapters') {
      if (!Array.isArray(x) || x.length > 60 || !x.every((n) => Number.isInteger(n) && n >= 1 && n <= 999)) problems.push(`${where}: chapters inválido`);
      else out.chapters = [...new Set(x as number[])];
      continue;
    }
    if (!Number.isInteger(x) || (x as number) < 0 || (x as number) > 2 ** 31) { problems.push(`${where}: ${k} no es un entero válido`); continue; }
    (out as Record<string, number>)[k] = x as number;
  }
  return out;
}

const str = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : null);

/**
 * Esquema estricto de la salida de la herramienta. `requestText` = el pedido del docente (las citas tienen que estar).
 * `single`: re-interpretación de un pedido (exactamente uno).
 */
export function parseInterpretation(raw: unknown, requestText: string, opts: { single?: boolean; evidenceText?: string } = {}): RawAiRequest[] {
  const problems: string[] = [];
  if (!isObj(raw)) throw new InterpretationOutputError(['la salida no es un objeto']);
  for (const k of Object.keys(raw)) if (k !== 'requests') problems.push(`clave desconocida «${k}»`);
  const list = raw.requests;
  if (!Array.isArray(list)) throw new InterpretationOutputError(['falta la lista «requests»', ...problems]);
  if (list.length > PLAN_LIMITS.requestsPerIntake) problems.push(`demasiados pedidos (${list.length}; máximo ${PLAN_LIMITS.requestsPerIntake})`);
  if (opts.single && list.length !== 1) problems.push(`se esperaba exactamente un pedido (llegaron ${list.length})`);
  const text = normalizeQuote(requestText);
  const evText = normalizeQuote(opts.evidenceText ?? requestText);
  const out: RawAiRequest[] = [];
  list.forEach((r, i) => {
    const where = `pedido ${i + 1}`;
    if (!isObj(r)) { problems.push(`${where}: no es un objeto`); return; }
    for (const k of Object.keys(r)) if (!REQ_KEYS.has(k)) problems.push(`${where}: clave desconocida «${k}»`);
    const quote = str(r.quote, 2000);
    if (!quote) problems.push(`${where}: falta «quote»`);
    else if (!text.includes(normalizeQuote(quote))) problems.push(`${where}: «quote» no es un fragmento literal del pedido`);
    const op = r.operation;
    if (typeof op !== 'string' || !(AI_OPERATION_VALUES as readonly string[]).includes(op)) problems.push(`${where}: operación fuera del catálogo «${String(op).slice(0, 40)}»`);
    const instruction = typeof r.instruction === 'string' && r.instruction.length <= 1000 ? r.instruction.trim() : null;
    if (instruction === null) problems.push(`${where}: «instruction» falta o es demasiado larga`);
    const target = targetOf(r.target, where, problems);
    const colors: Array<{ from: string; to: string }> = [];
    if (r.colors !== undefined) {
      if (!Array.isArray(r.colors) || r.colors.length > 12) problems.push(`${where}: colors inválido`);
      else for (const c of r.colors) {
        if (!isObj(c) || Object.keys(c).some((k) => k !== 'from' && k !== 'to') || typeof c.from !== 'string' || typeof c.to !== 'string' || !HEX.test(c.from) || !HEX.test(c.to)) problems.push(`${where}: color inválido (se espera #hex → #hex)`);
        else colors.push({ from: c.from.toUpperCase(), to: c.to.toUpperCase() });
      }
    }
    let chapters: number | null = null;
    if (r.chapters !== undefined) { if (!Number.isInteger(r.chapters) || (r.chapters as number) < 1 || (r.chapters as number) > 20) problems.push(`${where}: chapters inválido`); else chapters = r.chapters as number; }
    const reason = r.reason === undefined ? null : str(r.reason, 500);
    if (r.reason !== undefined && reason === null) problems.push(`${where}: reason inválido`);
    const questions: RawAiRequest['questions'] = [];
    if (r.questions !== undefined) {
      if (!Array.isArray(r.questions) || r.questions.length > PLAN_LIMITS.questionsMax) problems.push(`${where}: questions inválido (máximo ${PLAN_LIMITS.questionsMax})`);
      else r.questions.forEach((q, qi) => {
        if (!isObj(q) || Object.keys(q).some((k) => k !== 'text' && k !== 'options')) { problems.push(`${where}: pregunta ${qi + 1} inválida`); return; }
        const qt = str(q.text, 300);
        if (!qt) { problems.push(`${where}: pregunta ${qi + 1} sin texto`); return; }
        const opts2: RawAiRequest['questions'][number]['options'] = [];
        const ids = new Set<string>();
        if (q.options !== undefined) {
          if (!Array.isArray(q.options) || q.options.length > PLAN_LIMITS.optionsMax) { problems.push(`${where}: opciones inválidas`); return; }
          for (const o of q.options) {
            if (!isObj(o) || Object.keys(o).some((k) => !['id', 'label', 'target'].includes(k))) { problems.push(`${where}: opción inválida`); continue; }
            const id = typeof o.id === 'string' && /^[a-z0-9_-]{1,20}$/i.test(o.id) ? o.id : null;
            const label = str(o.label, 200);
            if (!id || !label || ids.has(id)) { problems.push(`${where}: opción sin id único o sin texto`); continue; }
            ids.add(id);
            opts2.push({ id, label, target: targetOf(o.target, `${where} opción ${id}`, problems) });
          }
        }
        questions.push({ text: qt, options: opts2 });
      });
    }
    // Evidencia (P2-3): opcional en el esquema (si falta, el servidor PREGUNTA), pero si viene tiene que ser literal.
    const evid = (k: 'targetEvidence' | 'changeEvidence'): string | null => {
      if (r[k] === undefined || r[k] === null) return null;
      const v = str(r[k], 400);
      if (!v) { problems.push(`${where}: ${k} inválido`); return null; }
      if (!evText.includes(normalizeQuote(v))) { problems.push(`${where}: «${k}» no es un fragmento literal del pedido`); return null; }
      return v;
    };
    const targetEvidence = evid('targetEvidence');
    const changeEvidence = evid('changeEvidence');
    if (op === 'necesita_respuesta' && !questions.length && !reason) problems.push(`${where}: necesita_respuesta sin preguntas`);
    if (op === 'fuera_de_alcance' && !reason) problems.push(`${where}: fuera_de_alcance sin motivo`);
    out.push({ quote: quote ?? '', operation: op as RawAiRequest['operation'], instruction: instruction ?? '', target, colors, chapters, reason, questions, targetEvidence, changeEvidence });
  });
  if (problems.length) throw new InterpretationOutputError(problems);
  return out;
}

// ─── Resolución contra el inventario ────────────────────────────────────────

const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const isLater = (op: string): op is (typeof LATER_OPERATIONS)[number] => (LATER_OPERATIONS as readonly string[]).includes(op);
/** Operaciones que cambian contenido y necesitan saber QUÉ cambiar. */
const NEEDS_INSTRUCTION = new Set(['edit_html', 'edit_libro_section', 'exam_question_replace', 'exam_question_add']);

function optionsFrom(list: Array<{ label: string; resolves: ClarifyOption['resolves'] }>): ClarifyOption[] {
  return list.slice(0, PLAN_LIMITS.optionsMax).map((o, i) => ({ id: `o${i + 1}`, label: short(o.label, 200), resolves: o.resolves }));
}
function targetQuestion(text: string, opts: Array<{ label: string; resolves: ClarifyOption['resolves'] }>): ClarifyQuestion {
  const tooMany = opts.length > PLAN_LIMITS.optionsMax;
  return { id: 'target', text, options: tooMany ? [] : optionsFrom(opts), allowText: true, origin: 'server', purpose: 'target' };
}
const instructionQuestion = (text: string): ClarifyQuestion => ({ id: 'instruction', text, options: [], allowText: true, origin: 'server', purpose: 'instruction' });

function base(r: RawAiRequest, op: RequestOperation | null): InterpretedRequest {
  return { quote: r.quote, instruction: r.instruction, operation: op, status: 'needs_answer', target: null, rawTarget: (r.target as Record<string, unknown>) ?? null, details: {}, questions: [], reason: null };
}

function examsOf(course: WorkshopCourse): WorkshopActivity[] {
  return course.activities.filter((a) => a.modname === 'quiz' && a.exam && !a.missingFolder);
}
function examOption(a: WorkshopActivity) { return { label: `${a.title}`, resolves: { quizModuleId: a.moduleId } }; }
function textOption(a: WorkshopActivity) { return { label: activityLabel(a), resolves: { moduleId: a.moduleId } }; }

export interface ResolveOptions {
  /** El destino lo eligió el docente (respuesta a una pregunta del servidor) o un hallazgo / aviso: no pide evidencia. */
  trustedTarget?: boolean;
  /** El cambio lo escribió el docente o viene de un hallazgo: no pide evidencia. */
  trustedChange?: boolean;
}

/** Resuelve UN pedido de la IA contra el inventario. Nunca lanza. */
export function resolveRequest(r: RawAiRequest, course: WorkshopCourse, opts: ResolveOptions = {}): InterpretedRequest {
  const op = r.operation;
  if (op === 'fuera_de_alcance') return { ...base(r, null), status: 'out_of_scope', reason: r.reason ?? 'No es un cambio que el Taller haga.' };
  if (op === 'necesita_respuesta') {
    const qs: ClarifyQuestion[] = r.questions.map((q, i) => ({
      id: `ia${i + 1}`, text: q.text, allowText: true, origin: 'ai', purpose: 'other',
      options: q.options.map((o) => ({ id: o.id, label: o.label, resolves: validResolves(o.target, course) })),
    }));
    return { ...base(r, null), status: 'needs_answer', questions: qs.length ? qs : [instructionQuestion('¿Qué cambio exacto quieres y en qué actividad?')], reason: r.reason ?? 'El pedido no dice con certeza qué cambiar o dónde.' };
  }
  const operation = op as RequestOperation;
  const out = base(r, operation);
  const t = r.target ?? {};
  const needs = (q: ClarifyQuestion, reason: string): InterpretedRequest => ({ ...out, status: 'needs_answer', questions: [q], reason });
  const missingIdReason = 'No encontré esa actividad en este curso.';

  const res = resolveTarget(operation, t, r, course);
  if ('unavailable' in res) return { ...out, status: 'unavailable', reason: res.unavailable };
  const qs: ClarifyQuestion[] = [];
  const reasons: string[] = [];
  if ('question' in res) { qs.push(res.question); reasons.push(res.reason ?? missingIdReason); }
  // D6 en el servidor (fix round 1, P2-3): el destino que eligió la IA tiene que estar JUSTIFICADO por el texto del
  // docente (evidencia literal que nombra la actividad); si no, se pregunta con las candidatas.
  else if (!opts.trustedTarget) {
    const why = targetUnjustified(res.target, r.targetEvidence ?? null, course, operation);
    if (why) { qs.push(targetQuestion(why.question, why.options)); reasons.push(why.reason); }
  }
  // El cambio: instrucción concreta Y evidencia literal concreta en el pedido («mejora el capítulo 3» no lo es).
  if (NEEDS_INSTRUCTION.has(operation) && !opts.trustedChange) {
    const vague = plainText(r.instruction, 40).length < 8 ? 'El pedido no dice qué cambiar exactamente.' : changeVague(r.changeEvidence ?? null);
    if (vague) { qs.push(instructionQuestion('¿Qué cambio concreto quieres hacer? (por ejemplo: «cambiar el año 1990 por 1992»)')); reasons.push(vague); }
  }
  if (qs.length) {
    const keep = 'target' in res && !qs.some((q) => q.purpose === 'target') ? res.target : null;
    return { ...out, status: 'needs_answer', target: keep, details: keep && 'target' in res ? res.details ?? {} : {}, questions: qs.slice(0, PLAN_LIMITS.questionsMax), reason: reasons.join(' ') };
  }
  return { ...out, status: isLater(operation) ? 'phase_later' : 'resolved', target: (res as { target: ResolvedTarget }).target, details: (res as { details?: RequestDetails }).details ?? {} };
}

type TargetResult = { target: ResolvedTarget; details?: RequestDetails } | { question: ClarifyQuestion; reason?: string } | { unavailable: string };

function validResolves(t: RawTarget | null, course: WorkshopCourse): ClarifyOption['resolves'] {
  if (!t) return null;
  const out: NonNullable<ClarifyOption['resolves']> = {};
  if (t.moduleId !== undefined && activityOf(course, t.moduleId)) out.moduleId = t.moduleId;
  if (t.quizModuleId !== undefined && activityOf(course, t.quizModuleId)?.modname === 'quiz') out.quizModuleId = t.quizModuleId;
  if (t.chapterNumber !== undefined && course.chapters.some((c) => c.number === t.chapterNumber)) out.chapterNumber = t.chapterNumber;
  if (t.moduleNumber !== undefined && course.modules.some((m) => m.number === t.moduleNumber)) out.moduleNumber = t.moduleNumber;
  if (t.questionId !== undefined && examsOf(course).some((a) => a.exam!.questions.some((q) => q.id === t.questionId))) out.questionId = t.questionId;
  if (t.field !== undefined) out.field = t.field;
  return Object.keys(out).length ? out : null;
}

function resolveTarget(op: RequestOperation, t: RawTarget, r: RawAiRequest, course: WorkshopCourse): TargetResult {
  const chOf = (a: WorkshopActivity) => (a.placement.scope === 'chapter' ? a.placement.chapterNumber : null);
  const chapterExists = (n: unknown) => typeof n === 'number' && course.chapters.some((c) => c.number === n);
  switch (op) {
    case 'edit_html': {
      if (t.moduleId !== undefined) {
        const a = activityOf(course, t.moduleId);
        if (!a || a.missingFolder) return { question: targetQuestion('No encontré esa actividad en este curso. ¿Cuál quieres cambiar?', allTextOptions(course, t.chapterNumber)), reason: 'El destino que se nombró no existe en este paquete.' };
        const field = editableField(a, t.field);
        if (!field) return { question: targetQuestion(`«${short(a.title, 60)}» no tiene texto editable. ¿Qué actividad quieres cambiar?`, allTextOptions(course, chOf(a) ?? undefined)), reason: 'La actividad nombrada no tiene un campo de texto.' };
        return { target: { kind: 'html', moduleId: a.moduleId, field, title: a.title, chapterNumber: chOf(a) } };
      }
      if (t.chapterNumber !== undefined) {
        if (!chapterExists(t.chapterNumber)) return { question: targetQuestion(`El curso no tiene capítulo ${t.chapterNumber}. ¿Qué actividad quieres cambiar?`, allTextOptions(course)), reason: 'El capítulo nombrado no existe.' };
        const cands = chapterTextCandidates(course, t.chapterNumber);
        if (cands.length === 1) { const a = cands[0]; return { target: { kind: 'html', moduleId: a.moduleId, field: editableField(a)!, title: a.title, chapterNumber: t.chapterNumber } }; }
        return { question: targetQuestion(`¿En qué actividad del capítulo ${t.chapterNumber}?`, cands.map(textOption)), reason: `El capítulo ${t.chapterNumber} tiene ${cands.length} actividades de texto.` };
      }
      return { question: targetQuestion('¿En qué actividad quieres hacer el cambio?', allTextOptions(course)), reason: 'El pedido no dice en qué actividad.' };
    }
    case 'edit_libro_section': {
      const libros = course.activities.filter((a) => (a.kind === 'libro') && !a.missingFolder);
      const a = t.moduleId !== undefined ? activityOf(course, t.moduleId) : libros.length === 1 ? libros[0] : null;
      if (!libros.length) return { unavailable: 'Este curso no tiene Libro Guía en el paquete.' };
      if (!a || a.kind !== 'libro') return { question: targetQuestion('¿Qué Libro Guía?', libros.map((l) => ({ label: l.title, resolves: { moduleId: l.moduleId } }))), reason: 'El destino no es el Libro Guía.' };
      const fmt = course.libro.find((l) => l.moduleId === a.moduleId)?.format;
      if (fmt === 'pdf') return { unavailable: 'El Libro Guía de este curso es un PDF: editarlo exige su fuente por capítulo, que llega con la aplicación de arreglos (B6). Mientras tanto se puede cambiar el texto del capítulo en el curso.' };
      if (fmt === 'book') return { unavailable: 'El Libro de este curso es un libro en línea: pide el cambio sobre el capítulo (texto de la actividad), no sobre el Libro.' };
      const chapters = (t.chapters ?? (t.chapterNumber !== undefined ? [t.chapterNumber] : [])).filter((n) => chapterExists(n));
      if (!chapters.length) return { question: targetQuestion('¿Qué capítulo del Libro Guía?', course.chapters.map((c) => ({ label: `Capítulo ${c.number}${c.title ? `: ${c.title}` : ''}`, resolves: { moduleId: a.moduleId, chapterNumber: c.number } }))), reason: 'El pedido no dice qué capítulo del Libro.' };
      return { target: { kind: 'libro', moduleId: a.moduleId, chapters: chapters.sort((x, y) => x - y), title: a.title, recompose: false } };
    }
    case 'exam_question_replace': case 'exam_question_remove': {
      const exams = examsOf(course);
      const quizId = t.quizModuleId ?? (activityOf(course, t.moduleId)?.modname === 'quiz' ? t.moduleId : undefined);
      if (t.questionId !== undefined) {
        const holder = exams.find((a) => (quizId === undefined || a.moduleId === quizId) && a.exam!.questions.some((q) => q.id === t.questionId));
        if (holder) {
          const q = holder.exam!.questions.find((x) => x.id === t.questionId)!;
          if (q.qtype !== 'multichoice' && q.qtype !== 'truefalse') return { unavailable: `La pregunta es de tipo «${q.qtype}»: el Taller edita preguntas de opción múltiple y verdadero/falso.` };
          return { target: { kind: 'question', quizModuleId: holder.moduleId, questionId: q.id, title: `${holder.title} — «${short(plainText(q.html, 80), 80)}»`, chapterNumber: q.chapterNumber } };
        }
      }
      const quiz = quizId !== undefined ? exams.find((a) => a.moduleId === quizId) : undefined;
      if (quiz) {
        const qs = quiz.exam!.questions.filter((q) => q.qtype === 'multichoice' || q.qtype === 'truefalse');
        return { question: targetQuestion(`¿Qué pregunta de «${short(quiz.title, 60)}»?`, qs.map((q) => ({ label: short(plainText(q.html, 140), 140), resolves: { quizModuleId: quiz.moduleId, questionId: q.id } }))), reason: 'El pedido no dice qué pregunta.' };
      }
      if (!exams.length) return { unavailable: 'Este curso no tiene exámenes.' };
      return { question: targetQuestion('¿De qué examen es la pregunta?', exams.map(examOption)), reason: 'El pedido no dice qué examen ni qué pregunta.' };
    }
    case 'exam_question_add': {
      const exams = examsOf(course);
      if (!exams.length) return { unavailable: 'Este curso no tiene exámenes.' };
      const quizId = t.quizModuleId ?? (activityOf(course, t.moduleId)?.modname === 'quiz' ? t.moduleId : undefined);
      let quiz = quizId !== undefined ? exams.find((a) => a.moduleId === quizId) : undefined;
      if (!quiz && quizId === undefined) {
        const unit = t.moduleNumber ?? (t.chapterNumber !== undefined ? course.chapters.find((c) => c.number === t.chapterNumber)?.moduleNumber ?? undefined : undefined);
        const cand = unit !== undefined ? exams.filter((a) => !a.exam!.final && a.exam!.unit === unit) : [];
        if (cand.length === 1) quiz = cand[0];
      }
      if (!quiz) return { question: targetQuestion('¿A qué examen agrego la pregunta?', exams.map(examOption)), reason: 'El pedido no dice a qué examen.' };
      return { target: { kind: 'exam', quizModuleId: quiz.moduleId, title: quiz.title } };
    }
    case 'remove_activity': {
      // Una actividad listada sin carpeta (hallazgo T01) SÍ se puede quitar: es justamente su arreglo.
      const a = t.moduleId !== undefined ? activityOf(course, t.moduleId) : null;
      if (!a) {
        const opts = t.chapterNumber !== undefined && chapterExists(t.chapterNumber)
          ? course.chapters.find((c) => c.number === t.chapterNumber)!.activities.map((m) => activityOf(course, m)).filter((x): x is WorkshopActivity => !!x).map(textOption)
          : [];
        return { question: targetQuestion('¿Qué actividad quieres quitar?', opts), reason: t.moduleId !== undefined ? 'El destino que se nombró no existe en este paquete.' : 'El pedido no dice qué actividad quitar.' };
      }
      return { target: { kind: 'activity', moduleId: a.moduleId, title: a.title, chapterNumber: chOf(a) } };
    }
    case 'brand_replace': {
      if (!r.colors.length) return { unavailable: 'Para cambiar el logo hay que subir la imagen nueva: esa entrada llega con la pantalla del Taller (B7). Los colores sí se pueden pedir acá (de #hex a #hex).' };
      return { target: { kind: 'course', title: 'Marca del curso (colores)' }, details: { colors: r.colors } };
    }
    case 'regenerate_scorm': case 'regenerate_video': case 'regenerate_gamma': {
      const role = op === 'regenerate_scorm' ? 'game' : op === 'regenerate_video' ? 'video' : 'presentation';
      const what = role === 'game' ? 'juego' : role === 'video' ? 'video' : 'presentación';
      if (t.moduleId !== undefined) {
        const a = activityOf(course, t.moduleId);
        if (a && a.role === role) return { target: { kind: 'activity', moduleId: a.moduleId, title: a.title, chapterNumber: chOf(a) } };
        return { question: targetQuestion(`¿Qué ${what} quieres rehacer?`, allRoleOptions(course, role)), reason: a ? `«${short(a.title, 60)}» no es un ${what}.` : 'El destino que se nombró no existe en este paquete.' };
      }
      if (t.chapterNumber !== undefined && chapterExists(t.chapterNumber)) {
        const c = chapterRoleActivities(course, t.chapterNumber, role);
        if (c.length === 1) return { target: { kind: 'activity', moduleId: c[0].moduleId, title: c[0].title, chapterNumber: t.chapterNumber } };
        if (!c.length) return { unavailable: `El capítulo ${t.chapterNumber} no tiene ${what} en el paquete.` };
        return { question: targetQuestion(`¿Qué ${what} del capítulo ${t.chapterNumber}?`, c.map(textOption)), reason: `El capítulo ${t.chapterNumber} tiene ${c.length}.` };
      }
      return { question: targetQuestion(`¿Qué ${what} quieres rehacer?`, allRoleOptions(course, role)), reason: 'El pedido no dice cuál.' };
    }
    case 'regenerate_audio': {
      const audios = course.activities.filter((a) => (a.kind === 'audiobook' || a.kind === 'welcome_audio') && !a.missingFolder);
      const a = t.moduleId !== undefined ? activityOf(course, t.moduleId) : audios.length === 1 ? audios[0] : null;
      if (!audios.length) return { unavailable: 'Este curso no tiene audios en el paquete.' };
      if (!a || !(a.kind === 'audiobook' || a.kind === 'welcome_audio')) return { question: targetQuestion('¿Qué audio quieres rehacer?', audios.map((x) => ({ label: x.title, resolves: { moduleId: x.moduleId } }))), reason: 'El pedido no dice qué audio.' };
      return { target: { kind: 'activity', moduleId: a.moduleId, title: a.title, chapterNumber: null }, details: { audioTarget: a.kind === 'welcome_audio' ? 'welcome' : 'audiobook' } };
    }
    case 'add_chapter': {
      const mod = t.moduleNumber !== undefined ? course.modules.find((m) => m.number === t.moduleNumber) : course.modules.length === 1 ? course.modules[0] : undefined;
      if (!mod) return { question: targetQuestion('¿En qué módulo va el capítulo nuevo?', course.modules.map((m) => ({ label: `Módulo ${m.number}${m.title ? `: ${m.title}` : ''}`, resolves: { moduleNumber: m.number } }))), reason: 'El pedido no dice en qué módulo.' };
      return { target: { kind: 'module', moduleNumber: mod.number, title: `Módulo ${mod.number}${mod.title ? `: ${mod.title}` : ''}` }, details: { chapters: r.chapters ?? 1 } };
    }
    case 'add_module': {
      const per = course.modules.length ? Math.max(1, Math.round(course.chapters.length / course.modules.length)) : 2;
      return { target: { kind: 'course', title: 'Módulo nuevo' }, details: { chapters: r.chapters ?? per } };
    }
    default:
      return { unavailable: 'Operación fuera del catálogo.' };
  }
}

function allTextOptions(course: WorkshopCourse, chapter?: number) {
  const list = chapter !== undefined ? chapterTextCandidates(course, chapter) : course.chapters.flatMap((c) => chapterTextCandidates(course, c.number));
  return list.map(textOption);
}
function allRoleOptions(course: WorkshopCourse, role: 'game' | 'video' | 'presentation') {
  return course.chapters.flatMap((c) => chapterRoleActivities(course, c.number, role)).map(textOption);
}


// ─── D6: evidencia del destino y del cambio (fix round 1, P2-3) ─────────────

const fold = (x: string) => String(x).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
/** Palabras que no identifican una actividad ni un cambio (genéricas del curso, artículos, verbos de acción). */
const GENERIC = new Set(['capitulo', 'modulo', 'unidad', 'curso', 'actividad', 'actividades', 'texto', 'contenido', 'parte', 'seccion', 'leccion', 'tema', 'cosa', 'cosas', 'todo', 'todos', 'toda', 'todas', 'algo',
  'para', 'porque', 'sobre', 'entre', 'desde', 'hasta', 'como', 'esta', 'este', 'esto', 'estos', 'estas', 'donde', 'cuando', 'tambien', 'luego', 'despues', 'antes', 'aqui', 'alli', 'mucho', 'poco', 'mas', 'menos', 'favor',
  'interactivo', 'interactiva', 'presentacion', 'video', 'juego', 'examen', 'pregunta', 'libro', 'guia']);
const ACTION = new Set(['cambia', 'cambiar', 'cambien', 'quita', 'quitar', 'saca', 'sacar', 'agrega', 'agregar', 'anade', 'anadir', 'pon', 'poner', 'haz', 'hacer', 'corrige', 'corregir', 'reemplaza', 'reemplazar', 'escribe', 'escribir', 'rehace', 'rehacer', 'elimina', 'eliminar', 'borra', 'borrar']);
/** Verbos que no dicen QUÉ cambiar («mejora el capítulo 3»). */
const VAGUE = new Set(['mejora', 'mejorar', 'mejoren', 'arregla', 'arreglar', 'revisa', 'revisar', 'optimiza', 'optimizar', 'pule', 'pulir', 'perfecciona', 'perfeccionar', 'ajusta', 'ajustar', 'actualiza', 'actualizar', 'renueva', 'renovar']);
const words = (x: string) => fold(x).match(/[a-zñ]{4,}/g) ?? [];
/** Quita las referencias de ubicación («capítulo 3», «módulo 2», «pregunta 4»): no son el dato del cambio. */
const stripRefs = (x: string) => fold(x).replace(/\b(capitulo|cap|modulo|unidad|pregunta|seccion|leccion)\.?\s*\d+/g, ' ');

/**
 * Regla del CAMBIO concreto: la evidencia literal existe y trae un dato citado («…» / "…"), un número que no sea una
 * referencia de ubicación, ≥ 2 palabras de contenido, o 1 palabra de contenido con un verbo que no sea vago
 * («corrige la ortografía» sí; «mejora la redacción» o «mejora el capítulo 3» no). null = concreto.
 */
export function changeVague(evidence: string | null): string | null {
  if (!evidence) return 'El pedido no muestra qué cambiar (la interpretación no citó el cambio en el texto del docente).';
  if (/[«"“].{1,}?[»"”]/.test(evidence)) return null;
  const s = stripRefs(evidence);
  if (/\d/.test(s)) return null;
  const ws = words(s);
  const content = ws.filter((w) => !GENERIC.has(w) && !ACTION.has(w) && !VAGUE.has(w));
  const vagueVerb = ws.some((w) => VAGUE.has(w));
  if (content.length >= 2 || (content.length === 1 && !vagueVerb)) return null;
  return `«${evidence.slice(0, 80)}» no dice qué cambiar exactamente.`;
}

const ROLE_WORDS: Record<string, string[]> = {
  video: ['video'], game: ['juego', 'scorm', 'practica'], presentation: ['presentacion', 'gamma', 'diapositiva'], cta: ['boton'],
  welcome: ['bienvenida'], closing: ['cierre'], libro: ['libro'], audiobook: ['audiolibro'], welcome_audio: ['audio'], forum: ['foro'],
};

/**
 * Regla del DESTINO justificado: la evidencia literal nombra la actividad — por una palabra de su título (o del
 * enunciado de la pregunta), o por su rol / clase cuando es la ÚNICA de ese rol en su capítulo (si la evidencia nombra
 * el capítulo) o en el curso, o es la única actividad de texto del capítulo que nombra. null = justificado.
 */
function targetUnjustified(t: ResolvedTarget, evidence: string | null, course: WorkshopCourse, op: RequestOperation): { question: string; options: Array<{ label: string; resolves: ClarifyOption['resolves'] }>; reason: string } | null {
  if (t.kind === 'course' || t.kind === 'module') return null; // colores / agregar: no hay actividad que elegir
  const ev = fold(evidence ?? '');
  const evWords = new Set(words(ev).filter((w) => !GENERIC.has(w) && !ACTION.has(w) && !VAGUE.has(w)));
  const chapterNamed = (n: number | null) => n !== null && new RegExp(`\\b(capitulo|cap)\\.?\\s*${n}\\b`).test(ev);
  const cleanT = (title: string) => fold(title).replace(/[^a-z0-9ñ ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const evClean = cleanT(ev);
  // El título COMPLETO citado, o una palabra propia (no genérica) de él.
  const titleHit = (title: string) => (cleanT(title).length >= 6 && evClean.includes(cleanT(title))) || words(title).some((w) => !GENERIC.has(w) && evWords.has(w));
  const optionsFor = (): Array<{ label: string; resolves: ClarifyOption['resolves'] }> => {
    if (t.kind === 'question') {
      const quiz = activityOf(course, t.quizModuleId);
      return (quiz?.exam?.questions ?? []).filter((q) => q.qtype === 'multichoice' || q.qtype === 'truefalse').map((q) => ({ label: short(plainText(q.html, 140), 140), resolves: { quizModuleId: t.quizModuleId, questionId: q.id } }));
    }
    const a = 'moduleId' in t && t.moduleId !== null ? activityOf(course, t.moduleId) : null;
    if (!a) return [];
    const ch = a.placement.scope === 'chapter' ? a.placement.chapterNumber : null;
    const same = course.activities.filter((x) => !x.missingFolder && (ch !== null ? x.placement.scope === 'chapter' && x.placement.chapterNumber === ch : x.placement.scope !== 'chapter') && (x.role ?? x.kind) === (a.role ?? a.kind));
    const pool = op === 'edit_html' && ch !== null ? chapterTextCandidates(course, ch) : same;
    return (pool.length ? pool : [a]).map((x) => textOption(x));
  };
  const ask = (reason: string) => ({ question: '¿A qué actividad te refieres exactamente?', options: optionsFor(), reason });
  if (!evidence) return ask('La interpretación eligió una actividad sin citar dónde la nombra el pedido: no se elige por el docente.');
  if (t.kind === 'question') {
    const quiz = activityOf(course, t.quizModuleId);
    const q = quiz?.exam?.questions.find((x) => x.id === t.questionId);
    const stem = q ? words(plainText(q.html, 400)).filter((w) => !GENERIC.has(w)) : [];
    if (stem.some((w) => evWords.has(w))) return null;
    if ((quiz?.exam?.questions.length ?? 0) === 1) return null;
    return ask(`«${short(evidence, 60)}» no nombra esa pregunta del examen.`);
  }
  if (t.kind === 'exam') {
    const quiz = activityOf(course, t.quizModuleId);
    const exams = course.activities.filter((a) => a.modname === 'quiz' && a.exam);
    if (exams.length === 1 || (quiz && titleHit(quiz.title))) return null;
    const unit = quiz?.exam?.unit ?? null;
    if (unit !== null && new RegExp(`\\b(unidad|modulo)\\s*${unit}\\b`).test(ev) && /examen|evaluacion/.test(ev)) return null;
    if (quiz?.exam?.final && /final/.test(ev)) return null;
    return ask(`«${short(evidence, 60)}» no dice a qué examen.`);
  }
  if (t.kind === 'libro') {
    if (!/libro/.test(ev)) return ask(`«${short(evidence, 60)}» no nombra el Libro Guía.`);
    if (t.recompose || t.chapters.every((n) => chapterNamed(n))) return null;
    return ask(`«${short(evidence, 60)}» no dice qué capítulo del Libro.`);
  }
  const a = t.moduleId !== null ? activityOf(course, t.moduleId) : null;
  if (!a) return null;
  if (titleHit(a.title)) return null;
  const ch = a.placement.scope === 'chapter' ? a.placement.chapterNumber : null;
  const roleKey = String(a.role ?? a.kind);
  const roleNamed = (ROLE_WORDS[roleKey] ?? []).some((w) => ev.includes(w));
  const scope = course.activities.filter((x) => !x.missingFolder && (ch !== null ? x.placement.scope === 'chapter' && x.placement.chapterNumber === ch : true));
  const uniqueRole = scope.filter((x) => String(x.role ?? x.kind) === roleKey).length === 1;
  if (roleNamed && uniqueRole && (ch === null || chapterNamed(ch) || course.activities.filter((x) => String(x.role ?? x.kind) === roleKey).length === 1)) return null;
  if (op === 'edit_html' && ch !== null && chapterNamed(ch) && chapterTextCandidates(course, ch).length === 1) return null;
  return ask(`«${short(evidence, 60)}» no nombra con certeza «${short(a.title, 60)}».`);
}

// ─── Respuestas ─────────────────────────────────────────────────────────────

export class AnswerError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

/**
 * Aplica las respuestas del docente a un pedido `needs_answer`.
 *  - Todas las preguntas del SERVIDOR con opción elegida (o la instrucción escrita): se resuelve acá, sin IA.
 *  - Si alguna es de la IA o se respondió con texto a una pregunta de destino: `reinterpret` con las preguntas y
 *    respuestas (la IA vuelve a interpretar SOLO ese pedido).
 */
/** Valida las respuestas contra las preguntas del pedido (lanza AnswerError con código). */
export function checkAnswers(req: Pick<InterpretedRequest, 'status' | 'questions'>, answers: ClarifyAnswer[]): Array<{ question: string; answer: string; q: ClarifyQuestion; option: ClarifyOption | null; text: string | null }> {
  if (req.status !== 'needs_answer') throw new AnswerError('WORKSHOP_REQUEST_NOT_WAITING', 'Este pedido no está esperando respuestas.');
  if (!Array.isArray(answers) || !answers.length) throw new AnswerError('WORKSHOP_ANSWERS_INVALID', 'Faltan las respuestas.');
  const byId = new Map(req.questions.map((q) => [q.id, q]));
  const qa: Array<{ question: string; answer: string; q: ClarifyQuestion; option: ClarifyOption | null; text: string | null }> = [];
  for (const a of answers) {
    const q = a && typeof a.questionId === 'string' ? byId.get(a.questionId) : undefined;
    if (!q) throw new AnswerError('WORKSHOP_ANSWERS_INVALID', 'Una respuesta no corresponde a ninguna pregunta de este pedido.');
    if (qa.some((x) => x.q.id === q.id)) throw new AnswerError('WORKSHOP_ANSWERS_INVALID', 'Una pregunta viene respondida dos veces.');
    const option = a.optionId ? q.options.find((o) => o.id === a.optionId) ?? null : null;
    if (a.optionId && !option) throw new AnswerError('WORKSHOP_ANSWERS_INVALID', 'La opción elegida no existe.');
    const text = typeof a.text === 'string' && a.text.trim() ? a.text.trim() : null;
    if (text && text.length > PLAN_LIMITS.answerTextMaxChars) throw new AnswerError('WORKSHOP_ANSWERS_INVALID', `La respuesta es demasiado larga (máximo ${PLAN_LIMITS.answerTextMaxChars} caracteres).`);
    if (!option && !text) throw new AnswerError('WORKSHOP_ANSWERS_INVALID', 'Elige una opción o escribe la respuesta.');
    if (text && !q.allowText) throw new AnswerError('WORKSHOP_ANSWERS_INVALID', 'Esta pregunta solo acepta una de las opciones.');
    qa.push({ question: q.text, answer: option ? option.label + (text ? ` — ${text}` : '') : text!, q, option, text });
  }
  if (qa.length !== req.questions.length) throw new AnswerError('WORKSHOP_ANSWERS_INVALID', 'Responde todas las preguntas del pedido.');
  return qa;
}

export function answerRequest(req: InterpretedRequest, answers: ClarifyAnswer[], course: WorkshopCourse): { resolved: InterpretedRequest } | { reinterpret: Array<{ question: string; answer: string }> } {
  const qa = checkAnswers(req, answers);
  const deterministic = req.operation !== null && qa.every((x) => x.q.origin === 'server' && ((x.q.purpose === 'target' && x.option && x.option.resolves && !x.text) || (x.q.purpose === 'instruction' && x.text)));
  if (!deterministic) return { reinterpret: qa.map(({ question, answer }) => ({ question, answer })) };
  let rawTarget: RawTarget = { ...((req.rawTarget as RawTarget) ?? {}) };
  let instruction = req.instruction;
  for (const x of qa) {
    if (x.q.purpose === 'target') {
      // El destino elegido REEMPLAZA lo que se había nombrado (que no existía o era ambiguo).
      const rs = x.option!.resolves!;
      rawTarget = { ...(rawTarget.chapters && req.operation === 'edit_libro_section' ? { chapters: rawTarget.chapters } : {}), ...rs } as RawTarget;
      if (req.operation === 'edit_libro_section' && rs.chapterNumber !== undefined) rawTarget.chapters = [rs.chapterNumber];
    } else instruction = x.text!;
  }
  // Destino resuelto con el que ya se había resuelto (solo faltaba la instrucción).
  if (req.target && !qa.some((x) => x.q.purpose === 'target')) rawTarget = { ...rawTargetOf(req.target), ...rawTarget };
  const raw: RawAiRequest = { quote: req.quote, operation: req.operation as RawAiRequest['operation'], instruction, target: rawTarget, colors: req.details.colors ?? [], chapters: req.details.chapters ?? null, reason: null, questions: [] };
  // El docente eligió el destino o escribió el cambio (o ya estaban justificados: si no, habría otra pregunta pendiente).
  const next = resolveRequest(raw, course, { trustedTarget: true, trustedChange: true });
  return { resolved: { ...next, details: { ...req.details, ...next.details } } };
}

export function rawTargetOf(t: ResolvedTarget): RawTarget {
  switch (t.kind) {
    case 'html': return { moduleId: t.moduleId, field: t.field };
    case 'libro': return { moduleId: t.moduleId, chapters: t.chapters };
    case 'question': return { quizModuleId: t.quizModuleId, questionId: t.questionId };
    case 'exam': return { quizModuleId: t.quizModuleId };
    case 'activity': return { moduleId: t.moduleId };
    case 'module': return { moduleNumber: t.moduleNumber };
    default: return {};
  }
}
