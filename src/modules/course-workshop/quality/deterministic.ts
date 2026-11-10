/**
 * r107 B8 · Diagnóstico de CALIDAD — la parte DETERMINISTA (gratis, sin IA, siempre corre sobre todo el curso).
 * Reutiliza las reglas que Cursia ya aplica al generar, en vez de prompts nuevos:
 *   Q01  idioma: `language-qa` (voseo, «vosotros», regionalismos: la MISMA tabla del generador) + texto en inglés (palabras
 *        funcionales del inglés por oración; nuevo: language-qa no lo tenía). La ortografía la revisa la IA (Q01 de ai-review).
 *   Q02  dato distinto DENTRO del capítulo entre Libro Guía / video / texto / examen (misma cifra con su unidad, mismas
 *        palabras alrededor) — la generalización de E3 NUMERIC_WINDOW_CONFLICT de `quality/course-quality-checks` a
 *        cualquier magnitud con unidad.
 *   Q03  `quality/answer-length-bias` (mismo umbral y misma prueba que la regla del banco: > 30 % «correcta la más larga»
 *        con z > 1,96, ≥ 10 preguntas) por examen y en los videos — lo que B3 dejó como `info` (T10/T09) acá es un AVISO —,
 *        más «todas / ninguna de las anteriores» (regla del banco) y verdadero/falso siempre con la misma respuesta.
 *   Q04  dato que se contradice ENTRE capítulos: `windowMentions` + `numericWindowConflicts` (E3, plazos en horas) tal cual,
 *        y la misma idea para otras magnitudes con unidad.
 *   Q05  cobertura: cada capítulo tiene un examen que lo evalúa (categoría «Capítulo N» del banco, o el examen de su unidad).
 * Nada se corrige solo: cada hallazgo dice qué y dónde, con su cita literal, y si hay una operación del catálogo que lo
 * arregla (`suggestedFix`, probado después con el motor de B4).
 *
 * Puro.
 */
import { createHash } from 'crypto';
import { WorkshopActivity, plainText } from '../course-model';
import { DiagnosisContext } from '../diagnosis/context';
import { h5pMultiChoices, humanName, scopeOf } from '../diagnosis/checks';
import type { FindingScope, SuggestedFix } from '../diagnosis/finding';
import { excerptOf } from '../diagnosis/finding';
import { lqaIsLanguageCourse, lqaMarkdownFindings } from '../../language-qa/language-qa';
import { videoMcLengthBias } from '../../quality/answer-length-bias';
import { windowMentions } from '../../quality/course-quality-checks';
import { contentWords } from '../../quality/quality-battery';
import type { QualityCheckId, QualityDoc, QualityFinding, QualityQuote } from './types';

// ─── Armado de hallazgos ───────────────────────────────────────────────────

export interface QualityFindingInput {
  check: QualityCheckId;
  code: string;
  severity: 'error' | 'warning' | 'info';
  scope: FindingScope;
  title: string;
  detail: string;
  quotes: QualityQuote[];
  entry?: string | null;
  questionId?: number | null;
  suggestedFix?: SuggestedFix | null;
  source: 'deterministic' | 'ai';
  key?: string;
}

/** Hallazgo de calidad con id estable `Q03.exam_length_bias.<12 hex>` (mismo paquete → mismo id). */
export function makeQualityFinding(i: QualityFindingInput): QualityFinding {
  const k = [i.check, i.code, i.source, i.scope.level, i.scope.chapterNumber ?? '', i.scope.activity?.dir ?? '', i.questionId ?? '', i.key ?? ''].join('|');
  const h = createHash('sha1').update(k).digest('hex').slice(0, 12);
  const q = i.quotes[0];
  return {
    id: `${i.check}.${i.code}.${h}`,
    check: i.check,
    code: i.code,
    severity: i.severity,
    scope: i.scope,
    title: i.title,
    detail: i.detail,
    evidence: { entry: i.entry ?? null, excerpt: excerptOf(q ? q.text : null), file: null, questionId: i.questionId ?? q?.questionId ?? null, token: null },
    suggestedFix: i.suggestedFix ?? null,
    corroboratedBy: [],
    fixPrecheck: null,
    origin: 'quality',
    source: i.source,
    quotes: i.quotes.map((x) => ({ ...x, text: x.text.length > 300 ? `${x.text.slice(0, 299)}…` : x.text })),
  };
}

export const quoteOf = (d: QualityDoc, text: string, docId: string | null = null): QualityQuote => ({
  docId, moduleId: d.moduleId, questionId: d.questionId, chapterNumber: d.chapterNumber, what: d.what, activityTitle: d.activityTitle, text,
});

/** «el video «X» del capítulo 3» / «una pregunta del examen «Evaluación…»». */
export function whereOf(d: QualityDoc): string {
  const ch = d.chapterNumber !== null && d.role !== 'exam' ? ` del capítulo ${d.chapterNumber}` : '';
  return `${d.what} «${d.activityTitle}»${ch}`;
}
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Alcance del hallazgo: la actividad del texto, con el capítulo del texto si la actividad es del curso (Libro / examen). */
export function scopeOfDoc(ctx: DiagnosisContext, d: QualityDoc): FindingScope {
  const a = ctx.actByMid.get(d.moduleId) ?? null;
  const s = scopeOf(ctx, a);
  return s.chapterNumber === null && d.chapterNumber !== null ? { ...s, chapterNumber: d.chapterNumber, moduleNumber: s.moduleNumber ?? d.moduleNumber } : s;
}

/**
 * Operación del catálogo que arregla un texto (o null). `instruction` viaja en los parámetros: «Arreglar esto» de B5 la
 * usa como la instrucción del pedido (el contenido nuevo lo genera la IA con su aprobación, como cualquier pedido).
 */
export function fixForDoc(ctx: DiagnosisContext, d: QualityDoc, instruction: string): SuggestedFix | null {
  const a = ctx.actByMid.get(d.moduleId);
  if (!a) return null;
  const ch = a.placement.scope === 'chapter' ? a.placement.chapterNumber : d.chapterNumber;
  if (d.role === 'exam' && d.questionId !== null) return { operation: 'exam_question_replace', params: { quizModuleId: d.moduleId, questionId: d.questionId, instruction } };
  if (d.role === 'libro') {
    if (a.modname === 'resource' && d.chapterNumber !== null && d.key.startsWith('l')) return { operation: 'edit_libro_section', params: { moduleId: d.moduleId, chapters: [d.chapterNumber], instruction } };
    if (a.modname === 'book' && d.field) return { operation: 'edit_html', params: { moduleId: d.moduleId, field: d.field, instruction } };
    return null;
  }
  if (d.role === 'video') return { operation: 'regenerate_video', params: { moduleId: d.moduleId, chapterNumber: ch } };
  if (d.role === 'game') return a.modname === 'scorm' ? { operation: 'regenerate_scorm', params: { moduleId: d.moduleId, chapterNumber: ch } } : null;
  if (d.field && (a.modname === 'label' || a.modname === 'page')) return { operation: 'edit_html', params: { moduleId: d.moduleId, field: d.field, instruction } };
  return null;
}

// ─── Q01 · idioma ──────────────────────────────────────────────────────────

const EN_WORDS = new Set(['the', 'and', 'of', 'to', 'is', 'are', 'with', 'for', 'this', 'that', 'you', 'your', 'will', 'be', 'on', 'by', 'from', 'it',
  'as', 'or', 'an', 'in', 'at', 'can', 'should', 'must', 'have', 'has', 'which', 'these', 'those', 'not', 'we', 'our', 'they', 'their', 'was',
  'were', 'if', 'when', 'what', 'how', 'all', 'more', 'into', 'about', 'between', 'each', 'its', 'than', 'then', 'there', 'do', 'does', 'any']);
const ES_WORDS = new Set(['de', 'la', 'el', 'que', 'y', 'en', 'los', 'las', 'del', 'se', 'por', 'con', 'para', 'una', 'un', 'es', 'al', 'lo', 'como',
  'más', 'mas', 'su', 'sus', 'son', 'está', 'esta', 'este', 'o', 'si', 'le', 'tu', 'tus', 'puedes', 'debes', 'pero', 'cuando', 'muy']);
/** Bibliografía, enlaces y citas: el inglés ahí es legítimo (títulos de obras). */
const REFERENCE_LIKE = /\(\s*(?:1[5-9]|20)\d{2}[a-z]?\s*\)|\bdoi\b|https?:|www\.|\bet al\b|\bISBN\b|\bpp?\.\s*\d/i;

/** Oraciones en inglés de un texto (heurística conservadora: ≥ 6 palabras, ≥ 3 funcionales del inglés y casi ninguna del español). */
export function englishSentences(text: string): string[] {
  const out: string[] = [];
  for (const s of String(text).split(/(?<=[.!?;:])\s+|\n+/)) {
    if (REFERENCE_LIKE.test(s)) continue;
    const words = (s.toLowerCase().match(/[a-záéíóúñü']+/g) ?? []);
    if (words.length < 6) continue;
    const en = words.filter((w) => EN_WORDS.has(w)).length;
    const es = words.filter((w) => ES_WORDS.has(w)).length;
    if (en >= 3 && en / words.length >= 0.2 && es <= Math.max(1, Math.floor(words.length * 0.08))) out.push(s.trim());
  }
  return out;
}

function q01(ctx: DiagnosisContext, docs: QualityDoc[]): QualityFinding[] {
  const out: QualityFinding[] = [];
  for (const d of docs) {
    const scope = scopeOfDoc(ctx, d);
    const en = englishSentences(d.text);
    if (en.length) {
      const quote = en[0].length > 300 ? en[0].slice(0, 300) : en[0];
      out.push(makeQualityFinding({
        check: 'Q01', code: 'other_language', severity: 'warning', scope, source: 'deterministic', questionId: d.questionId, key: d.key,
        title: `${cap(whereOf(d))} tiene texto en inglés: el curso va en español.`,
        detail: `${d.key}: ${en.length} oración(es) en inglés (palabras funcionales del inglés por oración); primera: «${excerptOf(en[0], 120)}»`,
        quotes: [quoteOf(d, quote)],
        suggestedFix: fixForDoc(ctx, d, `Traducir al español latinoamericano neutro (con tuteo) el texto que está en inglés («${excerptOf(en[0], 120)}») y dejar el resto igual.`),
      }));
    }
    const hits = lqaMarkdownFindings(d.text, 6) as Array<{ code: string; term: string; region: string; hint: string | null; text: string }>;
    const byCode = new Map<string, typeof hits>();
    for (const h of hits) byCode.set(h.code, [...(byCode.get(h.code) ?? []), h]);
    for (const [code, hs] of byCode) {
      const terms = [...new Set(hs.map((h) => h.term))].slice(0, 3);
      const what = code === 'VOSEO' ? `usa voseo (${terms.map((t) => `«${t}»`).join(', ')})` : code === 'VOSOTROS' ? `usa español de España (${terms.map((t) => `«${t}»`).join(', ')})` : `usa regionalismos (${terms.map((t) => `«${t}»`).join(', ')})`;
      const fixes = hs.map((h) => `«${h.term}» → ${h.hint ?? 'término neutro'}`).slice(0, 4).join('; ');
      out.push(makeQualityFinding({
        check: 'Q01', code: code.toLowerCase(), severity: 'warning', scope, source: 'deterministic', questionId: d.questionId, key: d.key,
        title: `${cap(whereOf(d))} ${what}: el curso va en español latinoamericano neutro, con tuteo.`,
        detail: `${d.key}: language-qa ${code} — ${fixes}`,
        quotes: [quoteOf(d, hs[0].text)],
        suggestedFix: fixForDoc(ctx, d, `Cambiar a español latinoamericano neutro con tuteo: ${fixes}. El resto queda igual.`),
      }));
    }
  }
  return out;
}

// ─── Q03 · preguntas adivinables ───────────────────────────────────────────

const ALL_NONE_RE = /^\s*(?:todas|ninguna)\s+(?:de\s+)?(?:las\s+)?(?:anteriores|opciones\s+anteriores|respuestas\s+anteriores)\b|^\s*todas\s+las\s+opciones\s+son\s+correctas\b|^\s*(?:all|none)\s+of\s+the\s+above\b/i;

function q03(ctx: DiagnosisContext, docs: QualityDoc[]): QualityFinding[] {
  const out: QualityFinding[] = [];
  const qdoc = new Map(docs.filter((d) => d.role === 'exam' && d.questionId !== null).map((d) => [d.questionId as number, d]));
  for (const a of ctx.course.activities.filter((x) => x.exam && !x.missingFolder)) {
    const exam = a.exam!;
    const mcs: Array<{ id: number; longest: boolean; answers: Array<{ text: string; correct: boolean }> }> = [];
    const tf: Array<{ id: number; value: boolean }> = [];
    for (const q of exam.questions) {
      if (q.qtype === 'multichoice') {
        const answers = q.answers.map((x) => ({ text: plainText(x.html, 1_000), correct: (x.fraction ?? 0) >= 0.9999 }));
        const right = answers.filter((x) => x.correct);
        const wrong = q.answers.filter((x) => (x.fraction ?? 0) <= 0);
        if (right.length === 1 && wrong.length >= 1) {
          const len = (s: string) => s.replace(/\s+/g, ' ').trim().length;
          mcs.push({ id: q.id, answers, longest: len(right[0].text) > Math.max(...answers.filter((x) => !x.correct).map((x) => len(x.text))) });
        }
        const bad = answers.find((x) => ALL_NONE_RE.test(x.text));
        const d = qdoc.get(q.id);
        if (bad && d) {
          out.push(makeQualityFinding({
            check: 'Q03', code: 'all_none_option', severity: 'warning', scope: scopeOfDoc(ctx, d), source: 'deterministic', questionId: q.id, key: `q${q.id}`, entry: 'questions.xml',
            title: `Una pregunta del examen «${humanName(a)}» tiene la opción «${excerptOf(bad.text, 60)}»: suele delatar la respuesta y el banco de Cursia no la permite.`,
            detail: `questions.xml pregunta ${q.id}: opción «${excerptOf(bad.text, 80)}» (regla del banco: sin «todas / ninguna de las anteriores»)`,
            quotes: [quoteOf(d, bad.text)],
            suggestedFix: { operation: 'exam_question_replace', params: { quizModuleId: a.moduleId, questionId: q.id, instruction: 'Reescribir la pregunta sin la opción «todas / ninguna de las anteriores»: opciones concretas, una sola correcta y de largo parecido.' } },
          }));
        }
      } else if (q.qtype === 'truefalse') {
        const t = q.answers.find((x) => (x.fraction ?? 0) >= 0.9999);
        if (t) tf.push({ id: q.id, value: /verdader|true|cierto/i.test(plainText(t.html, 40)) });
      }
    }
    const bias = videoMcLengthBias([{ checkpoints: mcs.map((m) => ({ kind: 'multichoice', answers: m.answers })) }]);
    if (bias.biased) {
      const ids = mcs.filter((m) => m.longest).map((m) => m.id);
      const first = qdoc.get(ids[0]);
      out.push(makeQualityFinding({
        check: 'Q03', code: 'exam_length_bias', severity: 'warning', scope: scopeOf(ctx, a), source: 'deterministic', entry: 'questions.xml', key: `quiz${a.moduleId}`,
        title: `En el examen «${humanName(a)}» la respuesta correcta es casi siempre la más larga (${bias.correctLongest} de ${bias.mc} preguntas): se puede adivinar sin saber.`,
        detail: `answer-length-bias (regla del banco): ${bias.correctLongest}/${bias.mc} = ${Math.round(bias.share * 100)} % > 30 %, z ${bias.z} (esperado por azar ${bias.expected}); preguntas con la correcta más larga: ${ids.slice(0, 30).join(', ')}${ids.length > 30 ? '…' : ''}`,
        quotes: first ? [quoteOf(first, first.text)] : [],
        suggestedFix: ids.length ? { operation: 'exam_question_replace', params: { quizModuleId: a.moduleId, questionId: ids[0], instruction: 'Reescribir las opciones para que la correcta NO sea la más larga: las incorrectas tan largas y detalladas como la correcta (las demás preguntas marcadas en el detalle necesitan lo mismo).' } } : null,
      }));
    }
    if (tf.length >= 8 && tf.every((x) => x.value === tf[0].value)) {
      const first = qdoc.get(tf[0].id);
      out.push(makeQualityFinding({
        check: 'Q03', code: 'truefalse_same_answer', severity: 'warning', scope: scopeOf(ctx, a), source: 'deterministic', entry: 'questions.xml', key: `quiz${a.moduleId}`,
        title: `En el examen «${humanName(a)}» las ${tf.length} preguntas de verdadero o falso tienen la misma respuesta («${tf[0].value ? 'verdadero' : 'falso'}»): se aprueban sin leer.`,
        detail: `questions.xml: ${tf.length} preguntas truefalse, todas ${tf[0].value ? 'verdaderas' : 'falsas'} (${tf.map((x) => x.id).slice(0, 20).join(', ')})`,
        quotes: first ? [quoteOf(first, first.text)] : [],
        suggestedFix: { operation: 'exam_question_replace', params: { quizModuleId: a.moduleId, questionId: tf[0].id, instruction: `Reescribir la afirmación para que la respuesta correcta sea «${tf[0].value ? 'falso' : 'verdadero'}», sobre el mismo tema.` } },
      }));
    }
  }
  // Videos del curso: la misma regla sobre todas sus preguntas de opción múltiple.
  const videoDocs: unknown[] = [];
  let worst: { a: WorkshopActivity; n: number } | null = null;
  for (const a of ctx.course.activities.filter((x) => !x.missingFolder && (x.role === 'video' || x.modname === 'hvp'))) {
    const content = a.modname === 'hvp' ? ctx.hvp.get(a.moduleId)?.json : ctx.h5p.get(a.moduleId)?.content;
    if (!content) continue;
    const mcs = h5pMultiChoices(content);
    videoDocs.push({ checkpoints: mcs.map((q) => ({ kind: 'multichoice', answers: q.answers })) });
    const n = mcs.filter((q) => { const r = q.answers.filter((x) => x.correct); const w = q.answers.filter((x) => !x.correct); return r.length === 1 && w.length && r[0].text.trim().length > Math.max(...w.map((x) => x.text.trim().length)); }).length;
    if (n && (!worst || n > worst.n)) worst = { a, n };
  }
  const vb = videoMcLengthBias(videoDocs);
  if (vb.biased) {
    out.push(makeQualityFinding({
      check: 'Q03', code: 'video_length_bias', severity: 'warning', scope: worst ? scopeOf(ctx, worst.a) : { level: 'course', chapterNumber: null, moduleNumber: null, activity: null }, source: 'deterministic', key: 'videos',
      title: `En las preguntas de los videos, la respuesta correcta es casi siempre la más larga (${vb.correctLongest} de ${vb.mc}): se puede adivinar sin saber.`,
      detail: `answer-length-bias sobre los videos del curso: ${vb.correctLongest}/${vb.mc} = ${Math.round(vb.share * 100)} % > 30 %, z ${vb.z}${worst ? `; el que más: ${worst.a.dir} (${worst.n})` : ''}`,
      quotes: [],
      suggestedFix: worst ? { operation: 'regenerate_video', params: { moduleId: worst.a.moduleId, chapterNumber: worst.a.placement.scope === 'chapter' ? worst.a.placement.chapterNumber : null } } : null,
    }));
  }
  return out;
}

// ─── Q02 / Q04 · cifras que no coinciden ───────────────────────────────────

/** Magnitudes con unidad (además de los plazos, que van por `windowMentions`): clase + factor a la unidad base. */
const UNITS: ReadonlyArray<[RegExp, string, number, string]> = [
  [/^km\/h$|^kilometros por hora$/, 'speed', 1, 'km/h'],
  [/^m\/s$/, 'speed', 3.6, 'km/h'],
  [/^km$|^kilometros?$/, 'length', 1000, 'm'],
  [/^m$|^metros?$/, 'length', 1, 'm'],
  [/^cm$|^centimetros?$/, 'length', 0.01, 'm'],
  [/^mm$|^milimetros?$/, 'length', 0.001, 'm'],
  [/^kg$|^kilos?$|^kilogramos?$/, 'mass', 1000, 'g'],
  [/^g$|^gramos?$/, 'mass', 1, 'g'],
  [/^mg$|^miligramos?$/, 'mass', 0.001, 'g'],
  [/^l$|^litros?$/, 'volume', 1000, 'ml'],
  [/^ml$|^mililitros?$/, 'volume', 1, 'ml'],
  [/^°c$|^ºc$|^grados(?: centigrados| celsius)?$/, 'temperature', 1, '°C'],
  [/^%$|^por ciento$/, 'percent', 1, '%'],
  [/^v$|^voltios?$/, 'voltage', 1, 'V'],
  [/^w$|^vatios?$|^watts?$/, 'power', 1, 'W'],
  [/^psi$/, 'pressure', 1, 'psi'],
  [/^mmhg$/, 'pressure_mmhg', 1, 'mmHg'],
  [/^db$|^decibeles$|^decibelios$/, 'sound', 1, 'dB'],
];
const UNIT_SRC = '(km/h|kilometros por hora|m/s|kilometros?|km|metros?|m|centimetros?|cm|milimetros?|mm|kilogramos?|kilos?|kg|gramos?|g|miligramos?|mg|litros?|l|mililitros?|ml|°c|ºc|grados(?: centigrados| celsius)?|%|por ciento|voltios?|v|vatios?|watts?|w|psi|mmhg|decibeles|decibelios|db)';
const QTY_RE = new RegExp(`(?<![\\w.,])(\\d{1,3}(?:\\.\\d{3})+|\\d+(?:[.,]\\d+)?)\\s?${UNIT_SRC}(?![\\p{L}\\d])`, 'gu');
const foldTxt = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const UNIT_WORDS = new Set(['kilometros', 'metros', 'centimetros', 'milimetros', 'kilogramos', 'kilos', 'gramos', 'miligramos', 'litros', 'mililitros', 'grados', 'centigrados', 'celsius', 'ciento', 'voltios', 'vatios', 'watts', 'decibeles', 'decibelios', 'hora', 'horas']);
const stem5 = (w: string) => (w.length > 5 ? w.slice(0, 5) : w);

export interface QuantityMention {
  doc: QualityDoc; cls: string; value: number; unit: string; raw: string; sentence: string; anchors: string[];
  /** Las 2 palabras de contenido más cercanas ANTES de la cifra (de qué es el dato) y las 2 de después. */
  before: string[]; after: string[];
}

function parseNum(s: string): number {
  if (/^\d{1,3}(?:\.\d{3})+$/.test(s)) return Number(s.replace(/\./g, ''));
  return Number(s.replace(',', '.'));
}

/** Palabras de contenido (raíz de 5 letras) de un texto plegado, sin cifras ni unidades. */
const stemsOf = (s: string): string[] => contentWords(s).filter((w) => !UNIT_WORDS.has(w) && !/^\d/.test(w) && w !== 'aprox' && w !== 'aproximadamente').map(stem5);

function mentionOf(d: QualityDoc, line: string, f: string, idx: number, raw: string, cls: string, value: number, unit: string): QuantityMention | null {
  // Duraciones o cifras aproximadas («~105 min», «aprox. 60 %») y encabezados de ubicación («Capítulo 2 de 9») son
  // datos de la estructura del curso, no del contenido: cambian de un capítulo a otro a propósito.
  const pre = f.slice(Math.max(0, idx - 12), idx);
  if (/[~≈]\s*$|aprox\.?\s*$|aproximadamente\s*$|alrededor de\s*$/.test(pre)) return null;
  if (/cap[ií]tulo\s+\d+\s+de\s+\d+/i.test(line) || /^\s*(?:m[oó]dulo|unidad)\s+\d+\b/i.test(line)) return null;
  const before = stemsOf(f.slice(0, idx)).slice(-2);
  const after = stemsOf(f.slice(idx + raw.length)).slice(0, 2);
  const ws = stemsOf(f);
  const anchors = new Set<string>();
  for (let i = 0; i + 1 < ws.length; i++) if (ws[i] !== ws[i + 1]) anchors.add(`${ws[i]} ${ws[i + 1]}`);
  if (anchors.size < 2) return null;
  return { doc: d, cls, value, unit, raw, sentence: line.trim(), anchors: [...anchors], before, after };
}

/** Menciones de una magnitud con unidad: UNA por oración y clase (si una oración trae varias, ya está matizada). */
export function quantityMentions(d: QualityDoc): QuantityMention[] {
  const out: QuantityMention[] = [];
  for (const line of d.text.split(/(?<=[.!?;])\s+|\n+/)) {
    const f = foldTxt(line);
    QTY_RE.lastIndex = 0;
    const found: Array<{ cls: string; value: number; unit: string; raw: string; idx: number }> = [];
    let m: RegExpExecArray | null;
    while ((m = QTY_RE.exec(f))) {
      const u = UNITS.find(([re]) => re.test(m![2]));
      if (!u) continue;
      const v = parseNum(m[1]);
      if (!Number.isFinite(v)) continue;
      found.push({ cls: u[1], value: Math.round(v * u[2] * 1000) / 1000, unit: u[3], raw: m[0], idx: m.index });
    }
    for (const cls of new Set(found.map((x) => x.cls))) {
      const xs = found.filter((x) => x.cls === cls);
      if (xs.length !== 1) continue;
      const mm = mentionOf(d, line, f, xs[0].idx, xs[0].raw, cls, xs[0].value, xs[0].unit);
      if (mm) out.push(mm);
    }
    // Plazos: la extracción de E3 (`windowMentions`, valores en horas) tal cual; el emparejamiento es el de abajo.
    for (const w of windowMentions(line, { scope: d.key, section: d.key })) {
      const idx = f.indexOf(w.raw);
      if (idx < 0) continue;
      const mm = mentionOf(d, line, f, idx, w.raw, 'time', w.maxHours, 'h');
      if (mm) out.push(mm);
    }
  }
  return out;
}

/**
 * ¿Hablan del MISMO dato? La cifra va con las mismas palabras: las 2 más cercanas antes de ella iguales (o, si antes no
 * hay 2, las 2 de después), y al menos 2 pares de palabras de la oración en común. «Comunicación · 20 %» y «Análisis del
 * caso · 40 %» (dos criterios de una rúbrica) NO son el mismo dato; «la velocidad máxima en zona escolar es 30 km/h» y
 * «… zona escolar es de 50 km/h», sí.
 */
export function sameQuantity(a: QuantityMention, b: QuantityMention): boolean {
  if (a.cls !== b.cls || a.value === b.value) return false;
  const eqArr = (x: string[], y: string[]) => x.length === 2 && y.length === 2 && x[0] === y[0] && x[1] === y[1];
  const subject = a.before.length >= 2 && b.before.length >= 2 ? eqArr(a.before, b.before) : eqArr(a.after, b.after);
  if (!subject) return false;
  return a.anchors.filter((x) => b.anchors.includes(x)).length >= 2;
}

const fmtVal = (m: QuantityMention) => (m.cls === 'time' ? `«${m.raw}»` : `${String(m.value).replace('.', ',')} ${m.unit}`);
/** Orden de preferencia de qué lado se ARREGLA en el capítulo: el Libro es la referencia, se ajusta lo demás. */
const ROLE_RANK: Record<string, number> = { libro: 0, text: 1, other: 2, exam: 3, video: 4, game: 5 };

function numericConflicts(ctx: DiagnosisContext, docs: QualityDoc[]): QualityFinding[] {
  const out: QualityFinding[] = [];
  const mentions = docs.filter((d) => d.chapterNumber !== null).flatMap(quantityMentions);
  const order = new Map(docs.map((d, i) => [d.key, i]));
  const seen = new Set<string>();
  for (let i = 0; i < mentions.length; i++) {
    for (let j = i + 1; j < mentions.length; j++) {
      const a = mentions[i];
      const b = mentions[j];
      if (a.doc.key === b.doc.key || !sameQuantity(a, b)) continue;
      const sameChapter = a.doc.chapterNumber === b.doc.chapterNumber;
      const pairKey = [a.doc.key, b.doc.key].sort().join('|') + `|${a.cls}`;
      if (seen.has(pairKey)) continue;
      seen.add(pairKey);
      const shared = a.anchors.filter((x) => b.anchors.includes(x));
      if (sameChapter) {
        if (a.doc.role === b.doc.role && a.doc.role !== 'exam') continue; // dos textos del mismo tipo: Q02 es Libro ↔ video ↔ examen
        const [ref, target] = (ROLE_RANK[a.doc.role] ?? 9) <= (ROLE_RANK[b.doc.role] ?? 9) ? [a, b] : [b, a];
        out.push(makeQualityFinding({
          check: 'Q02', code: 'chapter_data_mismatch', severity: 'warning', scope: scopeOfDoc(ctx, target.doc), source: 'deterministic', questionId: target.doc.questionId, key: pairKey,
          title: `En el capítulo ${a.doc.chapterNumber}, ${whereOf(target.doc)} dice ${fmtVal(target)} y ${whereOf(ref.doc)} dice ${fmtVal(ref)} para lo mismo: revisa cuál es el correcto.`,
          detail: `${target.doc.key} «${excerptOf(target.raw, 40)}» ≠ ${ref.doc.key} «${excerptOf(ref.raw, 40)}» (${target.cls}; palabras en común: ${shared.slice(0, 3).join(', ')})`,
          quotes: [quoteOf(target.doc, target.sentence), quoteOf(ref.doc, ref.sentence)],
          suggestedFix: fixForDoc(ctx, target.doc, `Revisar el dato «${target.raw}»: ${ref.doc.what} del mismo capítulo dice «${ref.raw}» («${excerptOf(ref.sentence, 140)}»). Dejarlo igual al dato correcto sin cambiar el resto.`),
        }));
      } else {
        const [first, second] = (order.get(a.doc.key) ?? 0) <= (order.get(b.doc.key) ?? 0) ? [a, b] : [b, a];
        out.push(makeQualityFinding({
          check: 'Q04', code: first.cls === 'time' ? 'cross_chapter_time_conflict' : 'cross_chapter_data_conflict', severity: 'warning', scope: scopeOfDoc(ctx, second.doc), source: 'deterministic', questionId: second.doc.questionId, key: pairKey,
          title: `El mismo dato no coincide entre capítulos: ${whereOf(first.doc)} dice ${fmtVal(first)} y ${whereOf(second.doc)} dice ${fmtVal(second)}. Revisa cuál es el correcto.`,
          detail: `${first.doc.key} «${excerptOf(first.raw, 40)}» vs ${second.doc.key} «${excerptOf(second.raw, 40)}» (${first.cls}${first.cls === 'time' ? ', plazos en horas por windowMentions (E3)' : ''}; palabras en común: ${shared.slice(0, 3).join(', ')}). Sin arreglo automático: solo el docente sabe cuál es el correcto (pídelo en «Pedir arreglos» con el dato bueno).`,
          quotes: [quoteOf(second.doc, second.sentence), quoteOf(first.doc, first.sentence)],
          suggestedFix: null,
        }));
      }
    }
  }
  return out;
}

// ─── Q05 · cobertura ───────────────────────────────────────────────────────

function q05(ctx: DiagnosisContext): QualityFinding[] {
  const out: QualityFinding[] = [];
  const exams = ctx.course.activities.filter((a) => a.exam && !a.missingFolder);
  if (!ctx.course.chapters.length) return out;
  if (!exams.length) {
    out.push(makeQualityFinding({
      check: 'Q05', code: 'no_exams', severity: 'info', scope: { level: 'course', chapterNumber: null, moduleNumber: null, activity: null }, source: 'deterministic',
      title: 'El curso no tiene exámenes: ningún capítulo se evalúa con un examen. Si el curso es así a propósito, no hace falta hacer nada.',
      detail: `${ctx.course.chapters.length} capítulos, 0 actividades quiz`, quotes: [],
    }));
    return out;
  }
  const declares = (a: WorkshopActivity) => a.exam!.questions.some((q) => q.chapterNumber !== null);
  for (const c of ctx.course.chapters) {
    const moduleExams = exams.filter((a) => !a.exam!.final && a.exam!.unit !== null && a.exam!.unit === c.moduleNumber);
    const finals = exams.filter((a) => a.exam!.final);
    const covers = (a: WorkshopActivity) => (declares(a) ? a.exam!.questions.some((q) => q.chapterNumber === c.number) : !a.exam!.final ? a.exam!.unit === c.moduleNumber : !moduleExams.length);
    // Exámenes sin unidad conocida ni capítulos declarados (builders viejos): no se puede saber qué cubren → no se acusa.
    const unknown = exams.filter((a) => !a.exam!.final && a.exam!.unit === null && !declares(a));
    // Capítulo sin módulo conocido y ningún banco con capítulos: no se puede saber qué examen lo cubre → no se acusa.
    if (c.moduleNumber === null && !exams.some(declares)) continue;
    // Capítulo de PRÁCTICA del generador («Práctica integradora…», «Práctica de casos…»): se evalúa con su actividad
    // práctica / de aplicación, no con preguntas del examen (diseño del curso, no un defecto).
    if (/^\s*pr[aá]ctica\b/i.test(c.title ?? '') && (c.roles.activity.length || c.roles.game.length)) continue;
    if (exams.some(covers) || unknown.length) continue;
    const target = moduleExams[0] ?? finals[0] ?? null;
    const title = c.title ? `«${c.title}»` : '';
    out.push(makeQualityFinding({
      check: 'Q05', code: 'chapter_not_assessed', severity: 'warning', scope: { level: 'chapter', chapterNumber: c.number, moduleNumber: c.moduleNumber, activity: null }, source: 'deterministic', key: `cap${c.number}`,
      title: `Ningún examen evalúa el capítulo ${c.number} ${title}: lo que se aprende ahí no se comprueba.`.replace(/\s+:/, ':'),
      detail: `capítulo ${c.number} (módulo ${c.moduleNumber ?? '—'}): ${moduleExams.length ? `el examen de su módulo (${moduleExams.map((a) => a.dir).join(', ')}) no tiene preguntas de la categoría «Capítulo ${c.number}»` : 'su módulo no tiene examen'}${finals.length ? `; el examen final ${finals.some(declares) ? 'tampoco lo incluye' : 'no declara capítulos'}` : ''}`,
      quotes: [],
      suggestedFix: target ? { operation: 'exam_question_add', params: { quizModuleId: target.moduleId, instruction: `Escribir una pregunta de opción múltiple sobre el capítulo ${c.number}${c.title ? ` («${c.title}»)` : ''}: una sola correcta, opciones de largo parecido.` } } : null,
    }));
  }
  return out;
}

// ─── Ejecutor ──────────────────────────────────────────────────────────────

export interface DeterministicQualityResult {
  findings: QualityFinding[];
  checks: Array<{ check: QualityCheckId; status: 'ran' | 'not_applicable'; reason: string | null }>;
}

export function deterministicQuality(ctx: DiagnosisContext, docs: QualityDoc[]): DeterministicQualityResult {
  const languageCourse = lqaIsLanguageCourse({ nombre: ctx.course.course.title ?? '' });
  const findings: QualityFinding[] = [
    ...(languageCourse ? [] : q01(ctx, docs)),
    ...numericConflicts(ctx, docs),
    ...q03(ctx, docs),
    ...q05(ctx),
  ];
  const seen = new Set<string>();
  const unique = findings.filter((x) => (seen.has(x.id) ? false : (seen.add(x.id), true)));
  return {
    findings: unique,
    checks: [
      { check: 'Q01', status: languageCourse ? 'not_applicable' : 'ran', reason: languageCourse ? 'curso de idiomas o de lengua: el otro idioma es parte del contenido' : null },
      { check: 'Q02', status: 'ran', reason: null },
      { check: 'Q03', status: ctx.course.exams.length || ctx.course.activities.some((a) => a.role === 'video') ? 'ran' : 'not_applicable', reason: ctx.course.exams.length || ctx.course.activities.some((a) => a.role === 'video') ? null : 'el curso no tiene exámenes ni videos con preguntas' },
      { check: 'Q04', status: ctx.course.chapters.length > 1 ? 'ran' : 'not_applicable', reason: ctx.course.chapters.length > 1 ? null : 'el curso tiene un solo capítulo' },
      { check: 'Q05', status: ctx.course.chapters.length ? 'ran' : 'not_applicable', reason: ctx.course.chapters.length ? null : 'el paquete no tiene capítulos reconocibles' },
    ],
  };
}
