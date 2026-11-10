/**
 * r107 B5 · Contenido NUEVO de las operaciones baratas (D5: el plan muestra el antes y el después REALES, así que el
 * contenido se genera al armar el plan, no al aplicar): `edit_html`, `edit_libro_section`, `exam_question_*`.
 *
 * Contexto mínimo para la IA: el campo actual + el pedido + el texto del capítulo si hace falta (nunca el paquete).
 * Validación de la salida ANTES del motor (que vuelve a validar al aplicar):
 *   - HTML: sin <script>/<style>/<link>/<meta>/<object>/<embed>/<form>, sin <iframe> nuevos, sin atributos on…=, sin
 *     `javascript:`; tokens $@…@$ SOLO los que ya estaban en el campo (exactos, y nunca uno de los «prohibidos» que el
 *     arreglo quiere quitar); @@PLUGINFILE@@ solo de los archivos que el campo ya usaba (o los permitidos por el
 *     arreglo); no vacío; largo acotado.
 *   - Libro: un cuerpo por capítulo pedido, sin título, sin <html>/<head>/<body>, sin tokens ni <script>.
 *   - Preguntas: reglas del banco de B4 (opción múltiple: 3–5 opciones, EXACTAMENTE una correcta, sin repetidas, sin
 *     «todas / ninguna de las anteriores», la correcta no delatada por larga; V/F: enunciado + valor), sin tokens.
 *
 * Puro.
 */
import { plainText } from '../course-model';
import type { NewQuestion } from '../patch/types';

const TOKEN_RE = /\$@[A-Z0-9_]+(?:\*[0-9]+)*@\$/g;
const PLUGINFILE_RE = /@@PLUGINFILE@@\/([^"'\s<>)?#]+)/g;
const FORBIDDEN_TAGS = /<\s*(script|style|link|meta|base|object|embed|form|applet)\b/i;
const BLOCKS_RE = /<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const TAGS_RE = /<\s*(?:link|meta|base|object|embed|form|applet)\b[^>]*>/gi;

export function tokensIn(html: string): string[] {
  return [...String(html).matchAll(TOKEN_RE)].map((m) => m[0]);
}
function pluginfilesIn(html: string): string[] {
  return [...String(html).matchAll(PLUGINFILE_RE)].map((m) => { try { return decodeURIComponent(m[1]); } catch { return m[1]; } });
}
const iframes = (h: string) => [...String(h).matchAll(/<iframe\b[^>]*>/gi)].map((m) => m[0]);

export interface HtmlRules {
  forbiddenTokens?: string[];
  allowFiles?: string[];
}

/** Problemas del HTML nuevo de un campo (vacío = sirve). */
export function htmlProblems(newHtml: unknown, oldHtml: string, rules: HtmlRules = {}): string[] {
  if (typeof newHtml !== 'string') return ['la salida no trae «html»'];
  const p: string[] = [];
  if (!plainText(newHtml, 40).trim() && !/<img\b/i.test(newHtml)) p.push('el HTML nuevo está vacío');
  // Bloques <style>/<script> (y etiquetas sueltas link/meta/…) que YA estaban EXACTOS en el campo se conservan (los v3
  // traen su <style>, que Moodle mantiene sin forceclean); uno nuevo o cambiado no pasa (misma regla que el motor B4).
  const oldBlocks = new Set([...oldHtml.matchAll(BLOCKS_RE)].map((x) => x[0]));
  const oldTags = new Set([...oldHtml.matchAll(TAGS_RE)].map((x) => x[0]));
  const rest = newHtml.replace(BLOCKS_RE, (b) => (oldBlocks.has(b) ? '' : b)).replace(TAGS_RE, (t) => (oldTags.has(t) && !/^<\s*(script|style)\b/i.test(t) ? '' : t));
  const m = FORBIDDEN_TAGS.exec(rest);
  if (m) p.push(`trae <${m[1].toLowerCase()}> nuevo (Moodle lo elimina o es inseguro: los estilos van en style="…")`);
  const oldFrames = new Set(iframes(oldHtml));
  if (iframes(newHtml).some((f) => !oldFrames.has(f))) p.push('trae un <iframe> que no estaba');
  if (/\son[a-z]+\s*=/i.test(newHtml)) p.push('trae atributos on…= (código)');
  if (/javascript\s*:/i.test(newHtml)) p.push('trae un enlace javascript:');
  const old = new Set(tokensIn(oldHtml));
  const forbidden = new Set(rules.forbiddenTokens ?? []);
  for (const t of tokensIn(newHtml)) {
    if (forbidden.has(t)) p.push(`vuelve a traer el enlace roto ${t}`);
    else if (!old.has(t)) p.push(`trae un enlace interno inventado ${t} (solo se pueden copiar los que ya estaban)`);
  }
  // Un `$@` que no forma un token completo de los de antes: token roto o inventado.
  const stripped = newHtml.replace(TOKEN_RE, '');
  if (/\$@/.test(stripped)) p.push('trae un enlace interno $@… incompleto o inventado');
  const okFiles = new Set([...pluginfilesIn(oldHtml), ...(rules.allowFiles ?? [])]);
  for (const f of pluginfilesIn(newHtml)) if (!okFiles.has(f)) p.push(`usa el archivo «${f}», que la actividad no tiene`);
  if (newHtml.length > Math.max(20_000, oldHtml.length * 4)) p.push('el HTML nuevo es demasiado largo');
  return [...new Set(p)];
}

/** Problemas de los capítulos nuevos del Libro. */
export function libroProblems(raw: unknown, wanted: number[]): { chapters: Array<{ number: number; html: string }>; problems: string[] } {
  const p: string[] = [];
  const out: Array<{ number: number; html: string }> = [];
  const list = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as { chapters?: unknown }).chapters : null;
  if (!Array.isArray(list)) return { chapters: [], problems: ['la salida no trae «chapters»'] };
  if (raw && Object.keys(raw as object).some((k) => k !== 'chapters')) p.push('la salida trae claves desconocidas');
  const seen = new Set<number>();
  for (const c of list) {
    const n = c && typeof c === 'object' ? (c as { number?: unknown }).number : null;
    const html = c && typeof c === 'object' ? (c as { html?: unknown }).html : null;
    if (!Number.isInteger(n) || !wanted.includes(n as number)) { p.push(`capítulo ${String(n)} no pedido`); continue; }
    if (seen.has(n as number)) { p.push(`capítulo ${n} repetido`); continue; }
    seen.add(n as number);
    if (typeof html !== 'string' || !plainText(html, 40).trim()) { p.push(`capítulo ${n} vacío`); continue; }
    if (/\$@/.test(html)) p.push(`capítulo ${n} trae un enlace $@…@$ (dentro de un archivo Moodle no lo resuelve)`);
    if (FORBIDDEN_TAGS.test(html)) p.push(`capítulo ${n} trae <script>/<style> u otra etiqueta no permitida`);
    if (/\son[a-z]+\s*=/i.test(html) || /javascript\s*:/i.test(html)) p.push(`capítulo ${n} trae código`);
    if (/<\/?(html|head|body)\b/i.test(html)) p.push(`capítulo ${n} trae <html>/<head>/<body>: va solo el cuerpo`);
    if (/^\s*<h[1-3]\b[^>]*>\s*Cap[ií]tulo\s+\d+/i.test(html)) p.push(`capítulo ${n} empieza con su título: va solo el cuerpo`);
    out.push({ number: n as number, html });
  }
  for (const w of wanted) if (!seen.has(w)) p.push(`falta el capítulo ${w}`);
  return { chapters: out, problems: [...new Set(p)] };
}

const ALL_OR_NONE = /\b(todas|ninguna)\s+(las\s+)?(anteriores|opciones\s+anteriores)\b|\btodas\s+son\s+correctas\b/i;
const norm = (s: string) => plainText(s, 400).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

/** Pregunta nueva validada con las reglas del banco (B4) → NewQuestion, o los problemas. */
export function questionFrom(raw: unknown): { question: NewQuestion | null; problems: string[] } {
  const p: string[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { question: null, problems: ['la salida no es un objeto'] };
  const r = raw as Record<string, unknown>;
  for (const k of Object.keys(r)) if (!['qtype', 'text', 'answers', 'correct', 'generalFeedback'].includes(k)) p.push(`clave desconocida «${k}»`);
  const text = typeof r.text === 'string' ? r.text.trim() : '';
  if (!plainText(text, 40).trim()) p.push('el enunciado está vacío');
  const all = [text, ...(Array.isArray(r.answers) ? r.answers.map((a: any) => `${a?.html ?? ''} ${a?.feedback ?? ''}`) : []), String(r.generalFeedback ?? '')].join(' ');
  if (/\$@/.test(all)) p.push('trae un enlace $@…@$ (las preguntas no llevan enlaces internos)');
  if (FORBIDDEN_TAGS.test(all) || /\son[a-z]+\s*=/i.test(all) || /javascript\s*:/i.test(all)) p.push('trae <script>/<style> o código');
  const gf = typeof r.generalFeedback === 'string' && r.generalFeedback.trim() ? r.generalFeedback.trim() : undefined;
  if (r.qtype === 'truefalse') {
    if (typeof r.correct !== 'boolean') p.push('verdadero/falso sin «correct»');
    if (p.length) return { question: null, problems: p };
    return { question: { qtype: 'truefalse', text, correct: r.correct as boolean, ...(gf ? { generalFeedback: gf } : {}) }, problems: [] };
  }
  if (r.qtype !== 'multichoice') return { question: null, problems: [...p, `tipo de pregunta «${String(r.qtype)}» no soportado`] };
  const answers = Array.isArray(r.answers) ? r.answers : [];
  if (answers.length < 3 || answers.length > 5) p.push(`opción múltiple con ${answers.length} opciones (se piden 3 a 5)`);
  const clean: Array<{ html: string; fraction: number; feedback?: string }> = [];
  const seen = new Set<string>();
  let correct = 0;
  for (const a of answers) {
    const html = a && typeof a.html === 'string' ? a.html.trim() : '';
    if (!plainText(html, 40).trim()) { p.push('una opción está vacía'); continue; }
    if (typeof a.correct !== 'boolean') { p.push('una opción no dice si es correcta'); continue; }
    const k = norm(html);
    if (seen.has(k)) p.push('hay opciones repetidas');
    seen.add(k);
    if (ALL_OR_NONE.test(plainText(html, 200))) p.push('usa «todas / ninguna de las anteriores»');
    if (a.correct) correct++;
    clean.push({ html, fraction: a.correct ? 1 : 0, ...(typeof a.feedback === 'string' && a.feedback.trim() ? { feedback: a.feedback.trim() } : {}) });
  }
  if (correct !== 1) p.push(`tiene ${correct} respuestas correctas (debe ser exactamente una)`);
  if (correct === 1 && clean.length >= 3) {
    const len = (h: string) => plainText(h, 400).length;
    const right = clean.find((x) => x.fraction === 1)!;
    const longestWrong = Math.max(...clean.filter((x) => x.fraction !== 1).map((x) => len(x.html)));
    if (len(right.html) > Math.max(longestWrong * 1.5, longestWrong + 25)) p.push('la respuesta correcta se delata por ser mucho más larga que las demás');
  }
  if (p.length) return { question: null, problems: [...new Set(p)] };
  return { question: { qtype: 'multichoice', text, single: true, answers: clean, ...(gf ? { generalFeedback: gf } : {}) }, problems: [] };
}

/** Texto de una pregunta existente para el prompt (enunciado + opciones con su marca). */
export function questionText(q: { html: string; qtype: string; answers: Array<{ html: string; fraction: number | null }> }): string {
  return [`Enunciado: ${plainText(q.html, 600)}`, `Tipo: ${q.qtype}`, ...q.answers.map((a) => `- ${(a.fraction ?? 0) > 0 ? '[correcta] ' : ''}${plainText(a.html, 200)}`)].join('\n');
}
