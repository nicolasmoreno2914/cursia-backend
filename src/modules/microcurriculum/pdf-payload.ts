import { createHash } from 'crypto';
import { normalizeAnswers } from './answers';
import {
  BLOOM, INSTITUTION_TYPES, MODALITIES, MicrocurriculumAnswers, MicrocurriculumV1, PROVENANCE_FIELDS,
} from './microcurriculum.types';

/**
 * r86 · Copia legible por máquina del microcurrículo dentro del PDF que genera Cursia («Crear microcurrículo»).
 *
 * El PDF lleva un ARCHIVO ADJUNTO (EmbeddedFile, nombre `cursia-microcurriculum.json`, AFRelationship /Data) con
 * `{ schema, microcurriculumId, sha256, json }`; `json` es el texto exacto de `{ document, answers }` y `sha256` su huella.
 * Al importar ese PDF («Importar microcurrículo»), Cursia lee esta copia en vez de interpretar el texto del PDF (sin
 * pérdidas, USD 0). Una copia inválida o alterada se ignora y el PDF se lee como cualquier otro (nunca falla la importación).
 *
 * `answers` lleva SOLO lo que usa el puente `toAcademicContext` (horas, calendario, evaluación institucional, notas y
 * contexto del grupo); nunca `learners.specialNeeds` (puede ser sensible y el PDF no lo muestra).
 */

export const MC_PDF_SCHEMA = 'cursia-microcurriculum/1';
export const MC_PDF_ATTACHMENT = 'cursia-microcurriculum.json';
/** Tope del adjunto (un microcurrículo real pesa decenas de KB). */
export const MC_PDF_MAX_BYTES = 1024 * 1024;

export interface McPdfEmbedded {
  mc: MicrocurriculumV1;
  answers: MicrocurriculumAnswers;
  microcurriculumId: string | null;
}

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

/** Respuestas que viajan en el PDF: solo las que consume `toAcademicContext`. */
export function embeddableAnswers(answers: MicrocurriculumAnswers): MicrocurriculumAnswers {
  const a = answers || {};
  const out: MicrocurriculumAnswers = {};
  if (a.time) out.time = a.time;
  if (a.methodology?.institutionalEvaluation) out.methodology = { institutionalEvaluation: a.methodology.institutionalEvaluation };
  if (a.references?.notes) out.references = { notes: a.references.notes };
  if (a.learners?.context) out.learners = { context: a.learners.context };
  return out;
}

export function buildMicrocurriculumPdfPayload(mc: MicrocurriculumV1, answers: MicrocurriculumAnswers, microcurriculumId: string | null): Buffer {
  const json = JSON.stringify({ document: mc, answers: embeddableAnswers(answers) });
  return Buffer.from(JSON.stringify({ schema: MC_PDF_SCHEMA, microcurriculumId: microcurriculumId || null, sha256: sha(json), json }), 'utf8');
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const strOrNull = (v: unknown) => v === null || isStr(v);
const strArr = (v: unknown) => Array.isArray(v) && v.every(isStr);

/** Forma estricta de MicrocurriculumV1 (tipos de cada campo). Vacío = válido. */
export function microcurriculumShapeProblems(raw: unknown): string[] {
  const p: string[] = [];
  if (!isObj(raw)) return ['el documento no es un objeto'];
  if (raw.version !== 1) p.push('version');
  const id = raw.identification;
  if (!isObj(id) || !isStr(id.courseName) || !id.courseName.trim() || !(INSTITUTION_TYPES as readonly unknown[]).includes(id.institutionType)
    || !strOrNull(id.program) || !strOrNull(id.term) || !strOrNull(id.code) || !strOrNull(id.area)
    || !(id.modality === null || (MODALITIES as readonly unknown[]).includes(id.modality))) p.push('identification');
  for (const k of ['description', 'justification', 'learnerProfile', 'priorKnowledge', 'generalObjective']) if (!isStr(raw[k])) p.push(k);
  for (const k of ['specificObjectives', 'resources', 'repairs']) if (!strArr(raw[k])) p.push(k);
  if (!isNum(raw.totalHours)) p.push('totalHours');
  if (!Array.isArray(raw.outcomes) || !raw.outcomes.every((o) => isObj(o) && isStr(o.id) && isStr(o.text) && isStr(o.verb)
    && (BLOOM as readonly unknown[]).includes(o.bloom) && isStr(o.condition) && isStr(o.criterion))) p.push('outcomes');
  if (!Array.isArray(raw.competencies) || !raw.competencies.every((c) => isObj(c) && isStr(c.id) && isStr(c.text))) p.push('competencies');
  if (!Array.isArray(raw.units) || !raw.units.every((u) => isObj(u) && isStr(u.id) && isStr(u.title) && strArr(u.contents) && strArr(u.outcomeIds)
    && isObj(u.hours) && isNum(u.hours.contact) && isNum(u.hours.practice) && isNum(u.hours.autonomous)
    && (u.weeks === null || (isObj(u.weeks) && isNum(u.weeks.from) && isNum(u.weeks.to))) && isStr(u.strategy) && isStr(u.mainActivity))) p.push('units');
  if (!isObj(raw.methodology) || !isStr(raw.methodology.text) || !strArr(raw.methodology.strategies)) p.push('methodology');
  if (!Array.isArray(raw.evaluation) || !raw.evaluation.every((e) => isObj(e) && isStr(e.name) && isNum(e.percent) && strArr(e.outcomeIds)
    && (e.week === null || isNum(e.week)) && isStr(e.evidence))) p.push('evaluation');
  if (!Array.isArray(raw.bibliography) || !raw.bibliography.every((b) => isObj(b) && isStr(b.text) && (b.origin === 'docente' || b.origin === 'sugerida'))) p.push('bibliography');
  const pv = raw.provenance;
  if (!isObj(pv) || !PROVENANCE_FIELDS.every((f) => pv[f] === 'docente' || pv[f] === 'cursia')) p.push('provenance');
  return p;
}

/** Bytes del adjunto → documento, o null si no es una copia válida (esquema, tamaño, huella o forma). Nunca lanza. */
export function parseMicrocurriculumPdfPayload(bytes: Uint8Array | Buffer): McPdfEmbedded | null {
  try {
    if (!bytes || !bytes.length || bytes.length > MC_PDF_MAX_BYTES) return null;
    const env = JSON.parse(Buffer.from(bytes).toString('utf8'));
    if (!isObj(env) || env.schema !== MC_PDF_SCHEMA || !isStr(env.json) || !isStr(env.sha256)) return null;
    if (sha(env.json) !== env.sha256) return null;
    const data = JSON.parse(env.json);
    if (!isObj(data) || microcurriculumShapeProblems(data.document).length) return null;
    const id = isStr(env.microcurriculumId) && /^[0-9a-f-]{8,64}$/i.test(env.microcurriculumId) ? env.microcurriculumId : null;
    return { mc: data.document as unknown as MicrocurriculumV1, answers: normalizeAnswers(isObj(data.answers) ? data.answers : {}), microcurriculumId: id };
  } catch {
    return null;
  }
}

/** Lee el adjunto de un PDF (pdf.js, sin decodificar páginas). null si no lo trae o no es válido. Nunca lanza. */
export async function readMicrocurriculumPdfPayload(pdf: Buffer): Promise<McPdfEmbedded | null> {
  if (!pdf || pdf.length < 5 || pdf.subarray(0, 5).toString('latin1') !== '%PDF-') return null;
  let parser: any = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { PDFParse } = require('pdf-parse');
    parser = new PDFParse({ data: new Uint8Array(pdf) });
    const doc = await parser.load();
    const att = await doc.getAttachments();
    if (!att || typeof att !== 'object') return null;
    const entry = (Object.values(att) as any[]).find((a) => a && a.filename === MC_PDF_ATTACHMENT);
    if (!entry || !entry.content) return null;
    return parseMicrocurriculumPdfPayload(entry.content as Uint8Array);
  } catch {
    return null;
  } finally {
    if (parser) await parser.destroy().catch(() => undefined);
  }
}
