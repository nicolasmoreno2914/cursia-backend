/**
 * r58 (I2) · Chequeos DETERMINÍSTICOS nuevos del informe de calidad (E1–E3). Baratos (léxicos, sin IA, USD 0) y sobre
 * artifacts ya generados. Ninguno reescribe contenido ni decide qué valor es el correcto: señalan candidatos.
 *
 *   E1 COUNT_CLAIM_MISMATCH            «Los siete conceptos:» seguido de una lista de 6 (o un componente con 6 tarjetas) → MINOR.
 *   E3 NUMERIC_WINDOW_CONFLICT         el mismo término con plazos distintos entre capítulos / exámenes («hasta 120 horas» vs
 *                                      «72 h»; unidades normalizadas a horas) → MAJOR needs_human_review, nunca se autocorrige.
 *   E3 DANGLING_BACK_REFERENCE         «vuelve a la pregunta del inicio» sin pregunta en la apertura → MINOR needs_human_review.
 *   E3 PREMATURE_COURSE_CLOSURE        «has recorrido todo el curso» antes del último capítulo → MINOR needs_human_review.
 *   E3 BRIDGE_DUPLICATE_DROPPED        el puente repetía el cierre y el ensamblador lo omitió (reparación silenciosa, ahora
 *                                      reportada) → INFO.
 *   E2 ASSESSMENT_MEMORY_FOR_PRACTICAL resultado / capítulo de desempeño (tipo de aprendizaje práctico o Bloom ≥ aplicar) cuya
 *                                      evaluación es solo de memoria (preguntas del banco recordar/comprender, sin Actividad de
 *                                      Aplicación ni caso ramificado) → MAJOR needs_human_review. El nivel de cada pregunta lo
 *                                      DECLARA la IA: es un proxy (una persona confirma).
 *   E3 ACTIVITY_LENGTH_DISPROPORTIONATE minutos declarados de la Actividad de Aplicación muy por encima del trabajo que contiene
 *                                      (palabras de consignas por minuto), con su peso en el capítulo según el registro de horas → MINOR.
 *   I4 PRACTICE_FILE_*                 la Actividad de Aplicación nombra un archivo que no está adjunto (MAJOR) / habla de un
 *                                      archivo adjunto sin que el capítulo tenga ninguno (MINOR) / un archivo adjunto que el
 *                                      texto nunca nombra (INFO: la página lo enlaza igual).
 */
import { bloomLevelOf } from '../academic-context/bloom';
import { bridgeRepeatsClosing } from '../course-shell/chapter-assembler';
import { QualityFindingV2, finding } from './quality-finding';
import { contentWords, normText } from './quality-battery';

export const COURSE_QUALITY_CHECKS_VERSION = 'course-quality-checks@1';

// ─── Entrada ───────────────────────────────────────────────────────────────

export interface QualityCourseChapter {
  chapterId: string;
  moduleId: string;
  number: number;
  title: string;
  objective: string | null;
  kind?: 'practice';
  outcomeIds?: string[];
  learningType?: { type: string; level: string | null } | null;
  applicationMinutes?: number;
  guidedPracticeMinutes?: number;
  activityType?: string | null;
  hasNextChapter: boolean;
}

export interface QualityCheckInput {
  chapters: QualityCourseChapter[]; // orden del curso
  outcomes: Array<{ id: string; text: string; level: string | null; domain: 'know' | 'do' }>;
  contentMd: ReadonlyMap<string, string>;
  experiences: ReadonlyMap<string, unknown>;
  videoInteractions: ReadonlyMap<string, unknown>;
  applications: ReadonlyMap<string, unknown>;
  guidedPractices: ReadonlyMap<string, unknown>;
  /** itemKey → banco (módulo o final). */
  examBanks: ReadonlyArray<{ itemKey: string; scope: 'module' | 'final'; moduleId: string | null; questions: ReadonlyArray<any> }>;
  /** Exámenes en GIFT (sin niveles declarados): solo para decir «no medido». */
  giftExamKeys: string[];
  /** Archivos de trabajo resueltos (filename, título, capítulo, relación). */
  practiceResources: ReadonlyArray<{ id: string; chapterId: string; title: string; filename: string; relation: string }>;
  /** Líneas del registro de horas (facts.hoursReport.lines), si existen. */
  hourLines?: ReadonlyArray<{ resource: string; chapterId: string | null; minutes: number; basis: string }> | null;
}

// ─── Utilidades de texto ───────────────────────────────────────────────────

const fold = (s: string): string => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Todos los textos de un documento JSON (sin claves técnicas). */
export function stringsOf(v: unknown, skip: ReadonlySet<string> = TECH_KEYS): string[] {
  if (typeof v === 'string') return [v];
  if (Array.isArray(v)) return v.flatMap((x) => stringsOf(x, skip));
  if (v && typeof v === 'object') return Object.entries(v as Record<string, unknown>).filter(([k]) => !skip.has(k)).flatMap(([, x]) => stringsOf(x, skip));
  return [];
}
const TECH_KEYS: ReadonlySet<string> = new Set(['type', 'kind', 'id', 'chapterId', 'moduleId', 'variant', 'icon', 'genre', 'difficulty', 'level', 'videoItemKey', 'schemaVersion', 'vcSchemaVersion', 'quality', 'next', 'correct']);

function sentences(text: string): string[] {
  return String(text ?? '').split(/(?<=[.!?;])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
}

export const NUMBER_WORDS: Readonly<Record<string, number>> = Object.freeze({
  dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10, once: 11, doce: 12, trece: 13, catorce: 14, quince: 15,
  veinte: 20, treinta: 30, cuarenta: 40, cincuenta: 50, sesenta: 60, setenta: 70, ochenta: 80, noventa: 90, cien: 100, ciento: 100,
});
const NUMWORD_RE = Object.keys(NUMBER_WORDS).join('|');
const numValue = (s: string): number | null => {
  const f = fold(s);
  if (f in NUMBER_WORDS) return NUMBER_WORDS[f];
  const n = Number(f.replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};

// ─── E1 · número escrito vs lista ──────────────────────────────────────────

/** «(los|las|estos…)? siete conceptos» al final de una línea con «:» o en un encabezado. */
const COUNT_CLAIM_RE = new RegExp(`(?:^|[^a-z0-9])(${NUMWORD_RE}|[2-9]|1[0-2])\\s+([a-zñ]{3,}(?:s|es))\\b`, 'i');
const LIST_ITEM_RE = /^\s*(?:[-*•]|\d{1,2}[.)])\s+\S/;
const HEADING_RE = /^(#{1,6})\s+(.*)$/;

function countClaim(line: string): { n: number; noun: string; raw: string } | null {
  const m = COUNT_CLAIM_RE.exec(fold(line));
  if (!m) return null;
  const n = numValue(m[1]);
  if (n === null || n < 2 || n > 15) return null;
  // Palabras que no cuentan elementos de una lista («dos veces», «tres años», «cinco minutos»).
  if (/^(veces|anos|meses|semanas|dias|horas|minutos|segundos|siglos|decadas|personas|puntos|por|millones|miles|partes|lados)$/.test(m[2])) return null;
  return { n, noun: m[2], raw: m[0].trim() };
}

/** Markdown: línea con la cifra que termina en «:» + lista que sigue, o encabezado + sub-encabezados / lista directa. */
export function countClaimsInMarkdown(md: string): Array<{ claimed: number; found: number; evidence: string }> {
  const lines = String(md ?? '').split('\n');
  const out: Array<{ claimed: number; found: number; evidence: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const h = HEADING_RE.exec(line);
    const c = countClaim(h ? h[2] : line);
    if (!c) continue;
    if (h) {
      const level = h[1].length;
      let sub = 0;
      let list = 0;
      let j = i + 1;
      let sawSub = false;
      for (; j < lines.length; j++) {
        const hh = HEADING_RE.exec(lines[j]);
        if (hh) {
          if (hh[1].length <= level) break;
          if (hh[1].length === level + 1) { sub++; sawSub = true; }
          continue;
        }
        if (!sawSub && LIST_ITEM_RE.test(lines[j])) list++;
      }
      const found = sub >= 2 ? sub : list >= 2 ? list : 0;
      if (found && found !== c.n) out.push({ claimed: c.n, found, evidence: `${line.trim()} → ${found} ${sub >= 2 ? 'subsecciones' : 'elementos en la lista'}` });
      continue;
    }
    if (!/:\s*$/.test(line.trim())) continue;
    let found = 0;
    for (let j = i + 1; j < lines.length; j++) {
      if (!lines[j].trim()) {
        // Una línea en blanco entre elementos no corta la lista (T1: el Libro pone blancos entre elementos).
        const next = lines.slice(j + 1).find((x) => x.trim());
        if (next && LIST_ITEM_RE.test(next)) continue;
        break;
      }
      if (LIST_ITEM_RE.test(lines[j])) found++;
      else if (found) break;
      else break;
    }
    if (found >= 2 && found !== c.n) out.push({ claimed: c.n, found, evidence: `${line.trim()} → ${found} elementos en la lista` });
  }
  return out;
}

const CLAIM_FIELDS = ['title', 'heading', 'intro', 'lead', 'label', 'question', 'prompt'];

/** JSON (experiencia): un objeto cuyo título / introducción dice «N cosas» y trae UNA lista con otra cantidad. */
export function countClaimsInDoc(doc: unknown): Array<{ claimed: number; found: number; evidence: string; page: string }> {
  const out: Array<{ claimed: number; found: number; evidence: string; page: string }> = [];
  const walk = (v: unknown, path: string) => {
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${path}[${i}]`)); return; }
    if (!v || typeof v !== 'object') return;
    const o = v as Record<string, unknown>;
    const arrays = Object.entries(o).filter(([, x]) => Array.isArray(x) && (x as unknown[]).length >= 2);
    if (arrays.length === 1) {
      for (const f of CLAIM_FIELDS) {
        const t = o[f];
        if (typeof t !== 'string') continue;
        const c = countClaim(t);
        const found = (arrays[0][1] as unknown[]).length;
        if (c && found !== c.n) { out.push({ claimed: c.n, found, evidence: `${t} → ${found} elementos`, page: `${path}.${arrays[0][0]}` }); break; }
      }
    }
    for (const [k, x] of Object.entries(o)) walk(x, path ? `${path}.${k}` : k);
  };
  walk(doc, '');
  return out;
}

// ─── E3 · ventanas numéricas entre partes ──────────────────────────────────

const UNIT_HOURS: ReadonlyArray<[RegExp, number, string]> = [
  [/^(horas?|h|hrs?)$/, 1, 'h'],
  [/^(dias?)$/, 24, 'días'],
  [/^(semanas?)$/, 168, 'semanas'],
  [/^(meses|mes)$/, 720, 'meses'],
  [/^(minutos?|min)$/, 1 / 60, 'min'],
  [/^(anos?)$/, 8760, 'años'],
];
const VALUE = `(\\d+(?:[.,]\\d+)?|${NUMWORD_RE})`;
const UNIT = '(horas?|h|hrs?|dias?|semanas?|meses|mes|minutos?|min|anos?)';
/** «entre 72 y 120 horas» | «72 a 120 h» | «72–120 h» | «120 horas». Sobre texto plegado (sin tildes). */
const WINDOW_RE = new RegExp(`(?:entre\\s+${VALUE}\\s+y\\s+|${VALUE}\\s*(?:-|–|a)\\s*)?${VALUE}\\s*${UNIT}\\b`, 'g');

export interface WindowMention {
  scope: string; // capítulo o examen (agrupa por parte del curso)
  chapterId?: string;
  moduleId?: string;
  section: string;
  itemKey?: string;
  page?: string;
  /** Cota superior de la ventana en horas (el valor que se compara). */
  maxHours: number;
  raw: string;
  sentence: string;
  anchors: string[];
}

const UNIT_WORDS = new Set(['hora', 'horas', 'dias', 'semana', 'semanas', 'meses', 'minuto', 'minutos', 'anos', 'entre', 'hasta', 'maximo', 'dentro', 'primeras', 'plazo', 'despues', 'antes', 'menos', 'luego', 'durante', 'cada', 'tiempo', 'periodo']);
const stem5 = (w: string) => (w.length > 5 ? w.slice(0, 5) : w);

/** Anclas = pares de palabras de contenido consecutivas de la oración (raíces de 5 letras), sin palabras de tiempo. */
function anchorsOf(sentence: string): string[] {
  const ws = contentWords(sentence).filter((w) => !UNIT_WORDS.has(w) && !(w in NUMBER_WORDS) && !/^\d/.test(w)).map(stem5);
  const out = new Set<string>();
  for (let i = 0; i + 1 < ws.length; i++) if (ws[i] !== ws[i + 1]) out.add(`${ws[i]} ${ws[i + 1]}`);
  return [...out];
}

export function windowMentions(text: string, loc: Omit<WindowMention, 'maxHours' | 'raw' | 'sentence' | 'anchors'>): WindowMention[] {
  const out: WindowMention[] = [];
  for (const s of sentences(text)) {
    const f = fold(s);
    WINDOW_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    const vals: Array<{ maxHours: number; raw: string }> = [];
    while ((m = WINDOW_RE.exec(f))) {
      const unit = UNIT_HOURS.find(([re]) => re.test(m![4]));
      if (!unit) continue;
      const hi = numValue(m[3]);
      const lo = m[1] ?? m[2];
      const loV = lo ? numValue(lo) : null;
      if (hi === null || hi <= 0) continue;
      const max = Math.max(hi, loV ?? 0) * unit[1];
      vals.push({ maxHours: Math.round(max * 1000) / 1000, raw: m[0].trim() });
    }
    if (vals.length !== 1) continue; // varias cifras en la misma oración: ya está matizada (no se compara)
    const anchors = anchorsOf(s);
    if (!anchors.length) continue;
    out.push({ ...loc, ...vals[0], sentence: s, anchors });
  }
  return out;
}

/** Grupos por ancla con valores distintos en ≥ 2 partes del curso. Un hallazgo por conjunto de menciones. */
export function numericWindowConflicts(mentions: WindowMention[]): Array<{ anchor: string; mentions: WindowMention[] }> {
  const byAnchor = new Map<string, WindowMention[]>();
  for (const m of mentions) for (const a of m.anchors) byAnchor.set(a, [...(byAnchor.get(a) ?? []), m]);
  const seen = new Set<string>();
  const out: Array<{ anchor: string; mentions: WindowMention[] }> = [];
  for (const [anchor, ms] of [...byAnchor.entries()].sort((a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : 1))) {
    const scopes = new Set(ms.map((m) => m.scope));
    const values = new Set(ms.map((m) => m.maxHours));
    if (scopes.size < 2 || values.size < 2) continue;
    // Debe haber valores distintos ENTRE partes distintas (no solo dentro de una misma).
    const cross = ms.some((a) => ms.some((b) => a.scope !== b.scope && a.maxHours !== b.maxHours));
    if (!cross) continue;
    const key = ms.map((m) => `${m.scope}|${m.sentence}`).sort().join('§');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ anchor, mentions: ms });
  }
  return out;
}

/** Valores comparados, siempre en horas (la cita original va al lado en la evidencia). */
const fmtHours = (h: number): string => `${String(Math.round(h * 100) / 100).replace('.', ',')} h`;

// ─── E3 · referencias hacia atrás y cierre prematuro ───────────────────────

const BACK_REF_RE = /\b(?:vuelve|volvamos|regresa|regresemos|retoma|retomemos|recuerda|piensa de nuevo en)\s+(?:a\s+|en\s+)?(?:la|el)\s+(pregunta|caso|situacion|escena|historia|reto|dilema)\s+(?:del inicio|inicial|de la apertura|del comienzo|con (?:la|el) que (?:empezamos|comenzamos|abrimos|iniciamos)(?: (?:el|este) capitulo)?)/;
const BACK_REF_RE2 = /\bcomo (?:vimos|viste|planteamos|preguntamos) (?:al inicio|en la apertura|al comienzo)\b/;
const PREMATURE_RE = /\b(?:has|hemos) (?:recorrido|completado|terminado|concluido|finalizado) (?:todo )?(?:el|este) (?:curso|camino del curso|recorrido del curso)\b|\b(?:has llegado|llegaste|hemos llegado) al final del curso\b|\bcon (?:esto|este capitulo) (?:terminas|concluyes|cierras|finalizas|completas) (?:el|este) curso\b|\bfelicitaciones por (?:terminar|completar|finalizar) (?:el|este) curso\b/;

function openingText(exp: unknown): { text: string; types: string[] } {
  const mv = (exp as { movements?: Record<string, unknown> } | null)?.movements;
  const op = mv && Array.isArray(mv.opening) ? (mv.opening as unknown[]) : [];
  return { text: stringsOf(op).join(' '), types: op.map((c) => String((c as { type?: unknown })?.type ?? '')) };
}

// ─── E2 · evaluación de memoria para competencia práctica ──────────────────

export const PRACTICAL_LEARNING_TYPES: readonly string[] = Object.freeze(['procedimental', 'protocolo', 'decision_caso', 'comunicacion']);
const HIGH_BLOOM = new Set(['apply', 'analyze', 'evaluate', 'create']);
const APPLIED_EXAM_LEVELS = new Set(['aplicar', 'analizar']);
const APPLIED_ACTIVITY_TYPES = new Set(['branchingscenario']);

// ─── Archivos de trabajo ───────────────────────────────────────────────────

const FILE_TOKEN_RE = /\b([\p{L}\p{N}][\p{L}\p{N}_-]{0,80}\.(?:xlsx|xls|docx|doc|pdf|csv|pptx|odt|ods|odp|txt|zip|png|jpg|jpeg))\b/giu;
const ATTACHED_MENTION_RE = /\b(?:archivo|plantilla|hoja de calculo|documento|formato)\s+(?:adjunt[oa]|que (?:se )?adjunta|descargable|de trabajo)\b/;

// ─── Ejecutor ──────────────────────────────────────────────────────────────

export function runCourseQualityChecks(inp: QualityCheckInput): QualityFindingV2[] {
  const out: QualityFindingV2[] = [];
  const R = (id: string) => ({ id, version: COURSE_QUALITY_CHECKS_VERSION });
  const chapters = inp.chapters;
  const lastChapterId = chapters.length ? chapters[chapters.length - 1].chapterId : null;

  // E1 · cifras escritas vs listas.
  for (const ch of chapters) {
    for (const c of countClaimsInMarkdown(inp.contentMd.get(ch.chapterId) ?? '')) {
      out.push(finding({ code: 'COUNT_CLAIM_MISMATCH', layer: 'E1', location: { chapterId: ch.chapterId, moduleId: ch.moduleId, section: 'libro' }, evidence: c.evidence,
        rule: R('E1.count_claim'), cause: `el texto anuncia ${c.claimed} y la lista trae ${c.found}`, recommendation: 'corregir la cifra o completar la lista', kind: 'deterministic' }));
    }
    const exp = inp.experiences.get(ch.chapterId);
    if (exp) {
      for (const c of countClaimsInDoc(exp)) {
        out.push(finding({ code: 'COUNT_CLAIM_MISMATCH', layer: 'E1', location: { chapterId: ch.chapterId, moduleId: ch.moduleId, section: 'experience', page: c.page }, evidence: c.evidence,
          rule: R('E1.count_claim'), cause: `el texto anuncia ${c.claimed} y el componente trae ${c.found}`, recommendation: 'corregir la cifra o el componente', kind: 'deterministic' }));
      }
    }
  }

  // E3 · ventanas numéricas.
  const mentions: WindowMention[] = [];
  for (const ch of chapters) {
    const base = { scope: `ch:${ch.chapterId}`, chapterId: ch.chapterId, moduleId: ch.moduleId };
    mentions.push(...windowMentions(inp.contentMd.get(ch.chapterId) ?? '', { ...base, section: 'libro' }));
    const exp = inp.experiences.get(ch.chapterId);
    if (exp) mentions.push(...windowMentions(stringsOf(exp).join('\n'), { ...base, section: 'experience' }));
    const vi = inp.videoInteractions.get(ch.chapterId);
    if (vi) mentions.push(...windowMentions(stringsOf(vi).join('\n'), { ...base, section: 'video_interactions' }));
    const aa = inp.applications.get(ch.chapterId);
    if (aa) mentions.push(...windowMentions(stringsOf(aa).join('\n'), { ...base, section: 'application' }));
    const gp = inp.guidedPractices.get(ch.chapterId);
    if (gp) mentions.push(...windowMentions(stringsOf(gp).join('\n'), { ...base, section: 'guided_practice' }));
  }
  for (const b of inp.examBanks) {
    for (const q of b.questions) {
      // Un V/F FALSO afirma algo incorrecto a propósito: su enunciado no se compara (sí su explicación).
      const parts = [q?.type === 'truefalse' && q?.answer !== true ? null : q?.stem, q?.explanation, q?.type === 'multichoice' ? q?.correct?.text : null].filter((x) => typeof x === 'string');
      mentions.push(...windowMentions(parts.join('\n'), { scope: `exam:${b.itemKey}`, chapterId: q?.chapterId, moduleId: b.moduleId ?? undefined, section: b.scope === 'final' ? 'final_exam' : 'exam', itemKey: b.itemKey, page: typeof q?.id === 'string' ? `questions[${q.id}]` : undefined }));
    }
  }
  for (const g of numericWindowConflicts(mentions).slice(0, 15)) {
    const vals = [...new Set(g.mentions.map((m) => m.maxHours))].sort((a, b) => a - b);
    const ex = g.mentions.slice(0, 4).map((m) => `[${m.section}${m.chapterId ? ` ${chapterNumber(chapters, m.chapterId)}` : ''}] «${m.raw}»`).join(' · ');
    const first = g.mentions[0];
    out.push(finding({ code: 'NUMERIC_WINDOW_CONFLICT', layer: 'E3', location: { chapterId: first.chapterId, moduleId: first.moduleId, section: first.section, itemKey: first.itemKey, page: first.page },
      evidence: `«${g.anchor}»: ${vals.map(fmtHours).join(' vs ')} — ${ex}`, rule: R('E3.numeric_window'),
      cause: 'el mismo término aparece con plazos o cantidades distintas en partes distintas del curso (puede ser legítimo: casos distintos)',
      recommendation: 'una persona experta confirma qué valor es correcto en cada contexto; nunca se corrige solo', kind: 'needs_human_review' }));
  }

  // E3 · referencias hacia atrás sin apertura que las respalde + cierre prematuro + puente repetido.
  for (const ch of chapters) {
    const exp = inp.experiences.get(ch.chapterId) as { movements?: Record<string, unknown>; bridge_to_next?: string } | undefined;
    const op = openingText(exp);
    const parts: Array<[string, string]> = [['libro', inp.contentMd.get(ch.chapterId) ?? '']];
    if (exp?.movements) for (const [mv, comps] of Object.entries(exp.movements)) if (mv !== 'opening') parts.push([`experience.${mv}`, stringsOf(comps).join('\n')]);
    for (const [section, text] of parts) {
      for (const s of sentences(text)) {
        const f = fold(s);
        const m = BACK_REF_RE.exec(f) || BACK_REF_RE2.exec(f);
        if (m) {
          const noun = m[1] ?? 'pregunta';
          const backed = exp
            ? noun === 'pregunta' ? op.text.includes('?') : op.text.trim().length > 0 && (op.types.some((t) => /case|scenario|story|hook|question/.test(t)) || fold(op.text).includes(noun))
            : true; // sin experiencia no hay apertura medible: no se señala
          if (!backed) {
            out.push(finding({ code: 'DANGLING_BACK_REFERENCE', layer: 'E3', location: { chapterId: ch.chapterId, moduleId: ch.moduleId, section }, evidence: s,
              rule: R('E3.back_reference'), cause: `el texto remite a ${noun === 'pregunta' ? 'una pregunta' : `un(a) ${noun}`} del inicio que la apertura del capítulo no tiene`,
              recommendation: 'agregar el elemento a la apertura o quitar la remisión', kind: 'needs_human_review' }));
          }
        }
        if (ch.chapterId !== lastChapterId && PREMATURE_RE.test(f)) {
          out.push(finding({ code: 'PREMATURE_COURSE_CLOSURE', layer: 'E3', location: { chapterId: ch.chapterId, moduleId: ch.moduleId, section }, evidence: s,
            rule: R('E3.premature_closure'), cause: 'texto de cierre del curso en un capítulo que no es el último', recommendation: 'reescribir como cierre del capítulo', kind: 'needs_human_review' }));
        }
      }
    }
    if (exp && ch.hasNextChapter && typeof exp.bridge_to_next === 'string' && Array.isArray(exp.movements?.closing) && bridgeRepeatsClosing(exp.bridge_to_next, exp.movements!.closing as unknown[])) {
      out.push(finding({ code: 'BRIDGE_DUPLICATE_DROPPED', layer: 'E3', location: { chapterId: ch.chapterId, moduleId: ch.moduleId, section: 'experience', page: 'bridge_to_next' }, evidence: exp.bridge_to_next,
        rule: { id: 'bridgeRepeatsClosing', version: 'chapter-assembler@T1-r57' }, cause: 'el puente al siguiente capítulo repetía el cierre',
        recommendation: 'ninguna: el puente se omitió al ensamblar (reparación registrada)', kind: 'deterministic' }));
    }
  }

  // E2 · evaluación de memoria para una competencia práctica.
  out.push(...alignmentFindings(inp));

  // E3 · duración desproporcionada: minutos declarados de la Actividad de Aplicación vs el trabajo que contiene, con su peso
  // en el capítulo según el registro de horas (un hallazgo por capítulo).
  const chMinutes = new Map<string, number>();
  for (const l of inp.hourLines ?? []) if (l.chapterId) chMinutes.set(l.chapterId, (chMinutes.get(l.chapterId) ?? 0) + l.minutes);
  for (const ch of chapters) {
    const aa = inp.applications.get(ch.chapterId);
    if (!aa || typeof ch.applicationMinutes !== 'number' || ch.applicationMinutes <= 0) continue;
    const words = wordsOf(stringsOf(aa, new Set([...TECH_KEYS, 'solution', 'minutesBySection'])).join(' '));
    const perMin = words / ch.applicationMinutes;
    if (perMin >= ACTIVITY_MIN_WORDS_PER_MINUTE) continue;
    const total = chMinutes.get(ch.chapterId) ?? 0;
    const share = total > 0 ? ` (${Math.round((ch.applicationMinutes / total) * 100)} % de los ${Math.round(total)} min del capítulo en el registro de horas)` : '';
    out.push(finding({ code: 'ACTIVITY_LENGTH_DISPROPORTIONATE', layer: 'E3', location: { chapterId: ch.chapterId, moduleId: ch.moduleId, section: 'application', itemKey: `application_activity:${ch.chapterId}` },
      evidence: `${ch.applicationMinutes} min declarados${share} para ${words} palabras de consignas (${perMin.toFixed(1).replace('.', ',')} palabras/min < ${ACTIVITY_MIN_WORDS_PER_MINUTE})`,
      rule: R('E3.activity_length.words_per_minute'), cause: 'el nivel de minutos (declarado, no medido) de la actividad no está respaldado por el trabajo que pide',
      recommendation: 'bajar el nivel de minutos o ampliar la actividad (una persona calibra)', kind: 'deterministic' }));
  }

  // I4 · archivos de trabajo nombrados por la Actividad de Aplicación.
  out.push(...practiceFileReferenceFindings(inp));
  return out;
}

/** Palabras de consignas por minuto declarado por debajo de las cuales la actividad se señala (proxy; calibración pendiente). */
export const ACTIVITY_MIN_WORDS_PER_MINUTE = 4;

function wordsOf(s: string): number {
  return normText(s).split(' ').filter(Boolean).length;
}
function chapterNumber(chs: QualityCourseChapter[], id: string): string {
  const c = chs.find((x) => x.chapterId === id);
  return c ? `cap. ${c.number}` : id;
}

/** Nivel de un capítulo: el del tipo de aprendizaje congelado o el Bloom de su objetivo. */
function chapterIsPractical(ch: QualityCourseChapter): { practical: boolean; why: string } {
  const lt = ch.learningType?.type ?? null;
  const level = ch.learningType?.level ?? (ch.objective ? bloomLevelOf(ch.objective) : null);
  if (lt && PRACTICAL_LEARNING_TYPES.includes(lt)) return { practical: true, why: `tipo de aprendizaje «${lt}»` };
  if (level && HIGH_BLOOM.has(level)) return { practical: true, why: `objetivo de nivel «${level}» (Bloom)` };
  return { practical: false, why: '' };
}

function alignmentFindings(inp: QualityCheckInput): QualityFindingV2[] {
  const out: QualityFindingV2[] = [];
  const R = { id: 'E2.memory_for_practical', version: COURSE_QUALITY_CHECKS_VERSION };
  const qsByChapter = new Map<string, Array<{ level: string; itemKey: string }>>();
  for (const b of inp.examBanks) for (const q of b.questions) if (q && typeof q.chapterId === 'string') qsByChapter.set(q.chapterId, [...(qsByChapter.get(q.chapterId) ?? []), { level: String(q.level ?? ''), itemKey: b.itemKey }]);
  const content = inp.chapters.filter((c) => c.kind !== 'practice');
  const evidenceFor = (chs: QualityCourseChapter[]) => {
    const qs = chs.flatMap((c) => qsByChapter.get(c.chapterId) ?? []);
    // Las AA de los capítulos de práctica del módulo también evalúan el desempeño de sus capítulos de contenido.
    const mods = new Set(chs.map((c) => c.moduleId));
    const practiceAA = inp.chapters.filter((c) => c.kind === 'practice' && mods.has(c.moduleId) && inp.applications.has(c.chapterId));
    const aa = chs.filter((c) => inp.applications.has(c.chapterId)).length + practiceAA.length;
    const applied = chs.filter((c) => c.activityType && APPLIED_ACTIVITY_TYPES.has(c.activityType)).length;
    return { qs, applied: qs.filter((q) => APPLIED_EXAM_LEVELS.has(q.level)).length, aa, appliedActivities: applied };
  };
  const levels = (qs: Array<{ level: string }>) => {
    const m = new Map<string, number>();
    for (const q of qs) m.set(q.level || '—', (m.get(q.level || '—') ?? 0) + 1);
    return [...m.entries()].map(([k, n]) => `${k} ${n}`).join(', ');
  };
  const doOutcomes = inp.outcomes.filter((o) => o.domain === 'do' || (o.level && HIGH_BLOOM.has(o.level)));
  if (doOutcomes.length) {
    for (const o of doOutcomes) {
      const chs = content.filter((c) => (c.outcomeIds ?? []).includes(o.id));
      if (!chs.length) continue;
      const e = evidenceFor(chs);
      if (!e.qs.length) continue;
      if (e.applied === 0 && e.aa === 0 && e.appliedActivities === 0) {
        out.push(finding({ code: 'ASSESSMENT_MEMORY_FOR_PRACTICAL', layer: 'E2', location: { chapterId: chs[0].chapterId, moduleId: chs[0].moduleId, section: 'exam' },
          evidence: `${o.id} «${o.text}» (saber hacer): ${e.qs.length} preguntas del examen (${levels(e.qs)}), sin Actividad de Aplicación ni caso ramificado`,
          rule: R, cause: 'evaluación de memoria para una competencia práctica (niveles declarados por la IA en cada pregunta)',
          recommendation: 'agregar una Actividad de Aplicación o preguntas de aplicación/análisis; una persona confirma el nivel real', kind: 'needs_human_review' }));
      }
    }
    return out;
  }
  // Sin resultados académicos: por capítulo práctico.
  const flagged: Array<{ ch: QualityCourseChapter; why: string; e: ReturnType<typeof evidenceFor> }> = [];
  let practical = 0;
  for (const ch of content) {
    const p = chapterIsPractical(ch);
    if (!p.practical) continue;
    practical++;
    const e = evidenceFor([ch]);
    if (!e.qs.length) continue;
    if (e.applied === 0 && e.aa === 0 && e.appliedActivities === 0) flagged.push({ ch, why: p.why, e });
  }
  for (const x of flagged) {
    out.push(finding({ code: 'ASSESSMENT_MEMORY_FOR_PRACTICAL', layer: 'E2', location: { chapterId: x.ch.chapterId, moduleId: x.ch.moduleId, section: 'exam' },
      evidence: `cap. ${x.ch.number} «${x.ch.title}» (${x.why}): ${x.e.qs.length} preguntas del examen (${levels(x.e.qs)}), sin Actividad de Aplicación ni caso ramificado`,
      rule: R, cause: 'evaluación de memoria para una competencia práctica (niveles declarados por la IA en cada pregunta)',
      recommendation: 'agregar una Actividad de Aplicación o preguntas de aplicación/análisis; una persona confirma el nivel real', kind: 'needs_human_review' }));
  }
  if (practical && !inp.examBanks.length && inp.giftExamKeys.length) {
    out.push(finding({ code: 'ALIGNMENT_NOT_MEASURED', layer: 'E2', location: { section: 'exam' }, evidence: `${inp.giftExamKeys.length} examen(es) en GIFT sin nivel cognitivo declarado`,
      rule: R, cause: 'los exámenes GIFT no declaran nivel por pregunta', recommendation: 'revisar a mano el nivel de las preguntas de los capítulos prácticos', kind: 'needs_human_review', measured: false }));
  }
  return out;
}

function practiceFileReferenceFindings(inp: QualityCheckInput): QualityFindingV2[] {
  const out: QualityFindingV2[] = [];
  const R = { id: 'I4.practice_file_reference', version: COURSE_QUALITY_CHECKS_VERSION };
  for (const ch of inp.chapters) {
    const aa = inp.applications.get(ch.chapterId);
    if (!aa) continue;
    const text = stringsOf(aa, new Set([...TECH_KEYS, 'solution'])).join('\n');
    const files = inp.practiceResources.filter((r) => r.chapterId === ch.chapterId);
    const names = new Set(files.map((f) => f.filename.toLowerCase()));
    const loc = { chapterId: ch.chapterId, moduleId: ch.moduleId, section: 'application', itemKey: `application_activity:${ch.chapterId}` };
    const seen = new Set<string>();
    for (const m of text.matchAll(FILE_TOKEN_RE)) {
      const fn = m[1].toLowerCase();
      if (names.has(fn) || seen.has(fn)) continue;
      seen.add(fn);
      out.push(finding({ code: 'PRACTICE_FILE_REFERENCE_UNKNOWN', layer: 'E1', location: loc, evidence: `la actividad nombra «${m[1]}»; adjuntos del capítulo: ${files.length ? files.map((f) => f.filename).join(', ') : 'ninguno'}`,
        rule: R, cause: 'la actividad remite a un archivo que el estudiante no va a encontrar', recommendation: 'adjuntar ese archivo en el perfil o regenerar la actividad con los archivos reales', kind: 'needs_human_review' }));
    }
    if (!files.length && ATTACHED_MENTION_RE.test(fold(text))) {
      out.push(finding({ code: 'PRACTICE_FILE_MENTION_WITHOUT_FILE', layer: 'E1', location: loc, evidence: excerptAround(fold(text), ATTACHED_MENTION_RE),
        rule: R, cause: 'la actividad habla de un archivo adjunto y el capítulo no tiene archivos de trabajo', recommendation: 'adjuntar el archivo o ajustar la consigna', kind: 'needs_human_review' }));
    }
    const ftext = fold(text);
    for (const f of files.filter((x) => x.relation === 'application')) {
      const stemName = fold(f.filename.replace(/\.[a-z0-9]+$/i, ''));
      if (ftext.includes(fold(f.filename)) || (stemName.length >= 4 && ftext.includes(stemName)) || (f.title.length >= 4 && ftext.includes(fold(f.title)))) continue;
      out.push(finding({ code: 'PRACTICE_FILE_NOT_REFERENCED', layer: 'E1', location: loc, evidence: `«${f.title}» (${f.filename}) no aparece en el texto de la actividad`,
        rule: R, cause: 'el archivo se adjunta pero la consigna no lo nombra', recommendation: 'ninguna obligatoria: la página de la actividad lo enlaza en «Archivos de trabajo»', kind: 'deterministic' }));
    }
  }
  return out;
}

function excerptAround(text: string, re: RegExp): string {
  const m = re.exec(text);
  if (!m) return '';
  const i = Math.max(0, m.index - 60);
  return text.slice(i, m.index + m[0].length + 60);
}
