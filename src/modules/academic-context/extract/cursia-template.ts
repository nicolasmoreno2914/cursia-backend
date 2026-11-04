import { microcurriculumTemplateLabels } from '../../microcurriculum/pdf-template-labels';
import type { SourceLine } from './text-sources';

/**
 * r86 · PDF de microcurrículo generado por Cursia SIN copia adjunta (descargado antes de r86). Todo es determinista y
 * solo se aplica si el texto trae la FIRMA de la plantilla (la línea de portada «Preparado con Cursia · Microcurrículo»
 * y ≥ 3 títulos de sección numerados de la plantilla, en orden): un documento que no es de Cursia no cambia.
 *
 *   - Los títulos numerados («5 | Resultados de aprendizaje») pasan a ser encabezados (cierran la sección anterior).
 *   - Se quitan los encabezados de tabla de la plantilla («Id | … | Verbo · Bloom | Criterio») y el pie «Página x de y».
 *   - En la tabla de resultados solo cuenta la columna del resultado (no «verbo · Bloom» ni el criterio pegados).
 *   - `isCursiaTemplateLabel` descarta candidatos a resultado que son exactamente un rótulo de la plantilla.
 */

const L = microcurriculumTemplateLabels();
const norm = (s: string) => s.normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
const SECTIONS = new Set(L.sections.map(norm));
const COLUMNS = new Set(L.columns.map(norm));
const ROWS = new Set(L.rows.map(norm));
const ALL = new Set([...L.sections, ...L.columns, ...L.rows, ...L.subheadings, ...L.fixed, L.signature].map(norm));
const OUTCOME_SECTIONS = new Set(['resultados de aprendizaje', 'desempeños']);
const COLUMN_LIST = [...COLUMNS];
const FIXED = new Set(L.fixed.map(norm));
const COVER = new Set(['DOCENTE', 'FECHA', 'INTENSIDAD', 'CÓDIGO']);
const PAGE_RE = /^página \d{1,4} de \d{1,4}$/;
const ID_RE = /^[A-Z]{1,3}\d{1,3}$/;

/** «5 | Resultados de aprendizaje» (fila) o «3 Perfil del estudiante y prerrequisitos» (línea): número + título. */
function sectionOf(l: SourceLine): { n: number; title: string } | null {
  if (l.cells && l.cells.length === 2 && /^\d{1,2}$/.test(l.cells[0].trim()) && SECTIONS.has(norm(l.cells[1]))) return { n: Number(l.cells[0]), title: l.cells[1].trim() };
  if (!l.cells) {
    const m = /^(\d{1,2})\s+(.+)$/.exec(l.text.trim());
    if (m && SECTIONS.has(norm(m[2]))) return { n: Number(m[1]), title: m[2].trim() };
  }
  return null;
}

export function isCursiaMicrocurriculumText(lines: SourceLine[]): boolean {
  if (!lines.some((l) => norm(l.text) === norm(L.signature))) return false;
  let last = 0;
  let hits = 0;
  for (const l of lines) {
    const s = sectionOf(l);
    if (s && s.n > last) { last = s.n; hits++; }
  }
  return hits >= 3;
}

/** Líneas de un PDF de Cursia reescritas para el extractor de siempre (ver arriba). Solo con la firma de la plantilla. */
export function normalizeCursiaTemplateLines(lines: SourceLine[]): SourceLine[] {
  const out: SourceLine[] = [];
  let inOutcomes = false;
  let inUnits = false;
  let unitRow: SourceLine | null = null;
  let inHours = false;
  let inEvaluation = false;
  let headerTail: string[] | null = null;
  let justification = false;
  for (const l of lines) {
    const s = sectionOf(l);
    if (s) {
      inOutcomes = OUTCOME_SECTIONS.has(norm(s.title));
      inUnits = norm(s.title) === 'unidades temáticas';
      inHours = norm(s.title) === 'distribución de horas';
      inEvaluation = norm(s.title) === 'evaluación';
      unitRow = null;
      out.push({ text: `${s.n}. ${s.title}`, page: l.page, line: l.line, heading: true });
      continue;
    }
    const cells = l.cells ? l.cells.map((c) => c.trim()) : null;
    if (norm(l.text) === norm(L.signature)) continue;
    // Ficha de la portada (DOCENTE | …, FECHA | …): repite la identificación.
    if (cells && cells.length === 2 && COVER.has(cells[0])) continue;
    // Encabezado de tabla (un rótulo largo puede partirse: «Resultados de» / «aprendizaje» en la línea siguiente).
    if (cells && cells.length >= 2 && cells.every((c) => COLUMNS.has(norm(c)) || (norm(c).length >= 3 && COLUMN_LIST.some((x) => x.startsWith(norm(c)))))) {
      headerTail = cells.filter((c) => !COLUMNS.has(norm(c))).map(norm);
      continue;
    }
    const tail = headerTail;
    headerTail = null;
    if (tail && !cells && tail.some((t) => COLUMN_LIST.includes(`${t} ${norm(l.text)}`))) continue;
    if (!cells && FIXED.has(norm(l.text))) continue; // «Sin bibliografía registrada.», notas fijas
    if (inEvaluation && /^total\b/i.test(cells ? cells[0] : l.text.trim())) continue; // fila Total de la evaluación
    if (cells && PAGE_RE.test(norm(cells[cells.length - 1]))) continue; // pie «curso | Página x de y»
    if (!cells && /página \d{1,4} de \d{1,4}$/.test(norm(l.text))) continue;
    // «Justificación» (subtítulo de «Descripción y justificación») sigue a la descripción, rotulada (no es otra descripción).
    if (!cells && norm(l.text) === 'justificación') { justification = true; continue; }
    if (justification && !cells) { justification = false; out.push({ ...l, text: `(Justificación) ${l.text}` }); continue; }
    justification = false;
    if (inHours) {
      // Tabla Unidad | Docente | Práctica | Autónomo | Total: las horas por unidad ya vienen en cada unidad; la fila Total da
      // los componentes del curso (el total del curso es el de la identificación).
      if (cells && cells.length === 5 && norm(cells[0]) === 'total') {
        const [, d, pr, a] = cells;
        const parts: [string, string][] = [['Horas con docente', d], ['Horas prácticas', pr], ['Horas autónomas', a]];
        for (const [k, v] of parts) if (/^\d{1,4}(?:,\d{1,2})?$/.test(v) && v !== '0') out.push({ text: `${k}: ${v}`, page: l.page, line: l.line });
      }
      continue;
    }
    if (inUnits) {
      // Bloque de unidad: «U1 · título | 27 h», «Contenidos | • a • b», «Resultados | RA1, RA2», «Horas (D / P / A) | …»…
      // → la fila «Unidad 1: título | 27 h | RA1, RA2» y un tema por línea (el lector de contenidos de siempre).
      const head = cells && cells.length >= 2 && cells.length <= 3 ? { t: cells.slice(0, -1).join(' ').replace(/^U\s+(\d)/, 'U$1'), h: cells[cells.length - 1] } : (() => { const m = /^(U\d{1,2} · .+?)\s+(\d{1,4}(?:,\d{1,2})? h)$/.exec(l.text.trim()); return m ? { t: m[1], h: m[2] } : null; })();
      const hm = head ? /^U(\d{1,2}) · (.+)$/.exec(head.t) : null;
      if (head && hm && /^\d{1,4}(?:,\d{1,2})? h$/.test(head.h)) {
        unitRow = { text: `Unidad ${hm[1]}: ${hm[2]} ${head.h}`, page: l.page, line: l.line, cells: [`Unidad ${hm[1]}: ${hm[2]}`, head.h.replace(/ h$/, '')] };
        out.push(unitRow);
        continue;
      }
      const label = cells && cells.length === 2 ? norm(cells[0]) : null;
      const value = cells && cells.length === 2 ? cells[1] : null;
      const inlineContents = !cells && /^contenidos\s+•/i.test(l.text.trim()) ? l.text.trim().replace(/^contenidos\s+/i, '') : null;
      if (label === 'contenidos' || inlineContents !== null) {
        for (const part of String(inlineContents ?? value).split('•').map((x) => x.trim()).filter(Boolean)) out.push({ text: `• ${part}`, page: l.page, line: l.line });
        continue;
      }
      if (label && OUTCOME_SECTIONS.has(label)) {
        if (unitRow && unitRow.cells && value && value !== '-') { unitRow.cells.push(value); unitRow.text = `${unitRow.text} ${value}`; }
        continue;
      }
      if (label && ROWS.has(label)) continue; // horas D/P/A, semanas, estrategia, actividad principal
    }
    if (inOutcomes && cells) {
      // Tabla Id | resultado | verbo · Bloom | criterio: la fila de un resultado y sus filas de continuación (celdas
      // partidas) se reducen a la columna del resultado.
      if (ID_RE.test(cells[0]) && cells.length >= 2) {
        out.push({ text: `${cells[0]} ${cells[1]}`, page: l.page, line: l.line });
        continue;
      }
      out.push({ text: cells[0], page: l.page, line: l.line });
      continue;
    }
    out.push(l);
  }
  return out;
}

/**
 * ¿El candidato a resultado es un rótulo de la plantilla? Exactamente un rótulo («Verbo · Bloom», «Criterio»), un título
 * numerado («6 — Competencias») o una fila rótulo — valor de la plantilla («Horas (D / P / A) — 2,5 / 2,5 / 2,5»).
 */
export function isCursiaTemplateLabel(text: string): boolean {
  const t = norm(text);
  if (!t) return false;
  if (ALL.has(t)) return true;
  const m = /^(\d{1,2})\s*(?:—|-|–|\.)?\s*(.+)$/.exec(t);
  if (m && SECTIONS.has(m[2])) return true;
  const kv = /^(.+?)\s+—\s+(.*)$/.exec(t);
  if (kv && ROWS.has(kv[1])) return true;
  if (PAGE_RE.test(t) || / — página \d{1,4} de \d{1,4}$/.test(t)) return true;
  return false;
}

/** Nombre del curso según la ficha de identificación del PDF («Nombre del curso | …»). */
export function cursiaCourseNameOf(lines: SourceLine[]): string | null {
  for (const l of lines) {
    if (l.cells && l.cells.length === 2 && norm(l.cells[0]) === 'nombre del curso' && l.cells[1].trim()) return l.cells[1].trim();
  }
  return null;
}

const fold = (s: string) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '');

/**
 * r86 · Entre los microcurrículos del docente (ya acotados a su cuenta), el que corresponde a un PDF de Cursia sin copia
 * adjunta: mismo nombre de curso Y ≥ 90 % de sus resultados y unidades presentes en el texto del PDF (un microcurrículo
 * editado después de descargar el PDF no coincide). Dos candidatos igual de buenos y distintos → ninguno (ambiguo).
 */
export function pickCursiaMicrocurriculum<T extends { id: string; document: any }>(rows: T[], hint: { courseName: string; text: string }): T | null {
  const name = fold(hint.courseName);
  const hay = fold(hint.text);
  if (!name || !hay) return null;
  const scored: { row: T; score: number }[] = [];
  for (const r of rows) {
    const d = r.document;
    if (!d || !d.identification || fold(d.identification.courseName) !== name) continue;
    const probes = [
      ...(Array.isArray(d.outcomes) ? d.outcomes.map((o: any) => fold(o && o.text).slice(0, 30)) : []),
      ...(Array.isArray(d.units) ? d.units.map((u: any) => fold(u && u.title).slice(0, 30)) : []),
    ].filter((p: string) => p.length >= 6);
    if (!probes.length) continue;
    const score = probes.filter((p: string) => hay.includes(p)).length / probes.length;
    if (score >= 0.9) scored.push({ row: r, score });
  }
  if (!scored.length) return null;
  scored.sort((a, b) => b.score - a.score);
  const best = scored.filter((x) => x.score === scored[0].score);
  const same = best.every((x) => JSON.stringify(x.row.document) === JSON.stringify(best[0].row.document));
  return same ? best[0].row : null;
}
