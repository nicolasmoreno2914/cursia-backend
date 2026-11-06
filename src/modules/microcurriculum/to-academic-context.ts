import { createHash } from 'crypto';
import {
  ACADEMIC_LIMITS, AcademicContextV1, BloomLevel, Field, Provenance, emptyAcademicContext, missingField, normalizeAcademicContext,
} from '../academic-context/academic-context';
import { outcomeDomainOf } from '../academic-context/bloom';
import type { EducationLevel } from '../pedagogy/vocabulary';
import { requestedSplit, resolveTotalHours } from './answers';
import { BloomEs, HourKind, InstitutionType, McOrigin, MicrocurriculumAnswers, MicrocurriculumV1, ProvenanceField, terminologyForIdentification } from './microcurriculum.types';

/**
 * r81 · Puente microcurrículo → contexto académico del curso (AcademicContextV1), mapeo PURO para «Crear curso con
 * este microcurrículo» (spec §4.1): sin extracción ni IA. Lo que escribió el docente queda `provided`; lo que redactó
 * Cursia, `inferred` con basis `cursia-microcurriculum`. El documento sintético D1 es el propio microcurrículo (su
 * huella), para que el contexto diga de dónde viene. El resultado pasa `validateAcademicContextShape` (se normaliza al
 * final: si no pasara, lanza ACADEMIC_CONTEXT_INVALID — nunca un contexto roto en silencio).
 */

export const MICROCURRICULUM_BASIS = 'cursia-microcurriculum';
export const MICROCURRICULUM_EXTRACTOR = { id: 'cursia-microcurriculum', version: 1 } as const;

const BLOOM_MAP: Record<BloomEs, BloomLevel> = { recordar: 'remember', comprender: 'understand', aplicar: 'apply', analizar: 'analyze', evaluar: 'evaluate', crear: 'create' };
// r101 · `otro` no tiene un nivel educativo deducible: null (el contexto lo deja sin nivel, como antes con un tipo desconocido).
const LEVEL_MAP: Record<InstitutionType, EducationLevel | null> = { universidad: 'university', tecnica: 'technical', etdh: 'technical', colegio: 'secondary', corporativa: 'professional', otro: null };

const clip = (s: string, max: number) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
};
/** Horas con dos decimales EXACTOS en binario (la validación de forma compara n·100 con su redondeo): si no, a 0,25 h. */
const hrs = (n: number) => {
  const r = Math.round(n * 100) / 100;
  return Math.round(r * 100) === r * 100 ? r : Math.round(r * 4) / 4;
};

function prov(origin: McOrigin | undefined): Provenance {
  return origin === 'docente' ? { status: 'provided', sources: [] } : { status: 'inferred', sources: [], basis: MICROCURRICULUM_BASIS };
}
function field<T>(value: T | null | undefined, origin: McOrigin | undefined): Field<T> {
  if (value === null || value === undefined || (typeof value === 'string' && !value.trim()) || (Array.isArray(value) && !value.length)) return missingField<T>();
  return { value, ...prov(origin) } as Field<T>;
}

export function toAcademicContext(mc: MicrocurriculumV1, answers: MicrocurriculumAnswers): AcademicContextV1 {
  const P = (f: ProvenanceField) => mc.provenance?.[f];
  const ctx = emptyAcademicContext();
  const json = JSON.stringify(mc);
  const bytes = Buffer.byteLength(json, 'utf8');
  ctx.documents = [{
    id: 'D1',
    name: clip(`Microcurrículo · ${mc.identification.courseName}`, ACADEMIC_LIMITS.name),
    mediaType: 'text/markdown',
    sha256: createHash('sha256').update(json).digest('hex'),
    bytes: Math.max(1, bytes),
    pages: null,
    characters: json.length,
    extractor: { ...MICROCURRICULUM_EXTRACTOR },
  }];

  const id = mc.identification;
  const t = terminologyForIdentification(id);
  ctx.identity = {
    subjectName: field(clip(id.courseName, ACADEMIC_LIMITS.title), 'docente'),
    program: field(id.program ? clip(id.program, ACADEMIC_LIMITS.title) : null, 'docente'),
    educationLevel: field({ text: clip([t.institutionLabel, id.term].filter(Boolean).join(' · '), ACADEMIC_LIMITS.title), level: LEVEL_MAP[id.institutionType] ?? null }, 'docente'),
    generalObjective: field(clip(mc.generalObjective, ACADEMIC_LIMITS.text), P('generalObjective')),
    description: field(clip(mc.description, ACADEMIC_LIMITS.text), P('description')),
  };
  ctx.learner = {
    profile: field(clip(mc.learnerProfile, ACADEMIC_LIMITS.text), P('learnerProfile')),
    priorKnowledge: field(mc.priorKnowledge ? [clip(mc.priorKnowledge, ACADEMIC_LIMITS.text)] : null, P('priorKnowledge')),
  };

  const outcomeIds = new Set<string>();
  ctx.outcomes = mc.outcomes.slice(0, ACADEMIC_LIMITS.outcomes).map((o) => {
    const level = BLOOM_MAP[o.bloom] ?? null;
    outcomeIds.add(o.id);
    return { id: o.id, text: clip(o.text, ACADEMIC_LIMITS.outcomeText), level, domain: outcomeDomainOf(level), ...prov(P('outcomes')) };
  });
  ctx.competencies = mc.competencies.slice(0, ACADEMIC_LIMITS.competencies).map((c) => {
    outcomeIds.add(c.id);
    return { id: c.id, text: clip(c.text, ACADEMIC_LIMITS.outcomeText), ...prov(P('competencies')) };
  });
  const refs = (xs: string[]) => [...new Set(xs.filter((x) => outcomeIds.has(x)))].slice(0, ACADEMIC_LIMITS.outcomeIdsPerItem);
  ctx.units = mc.units.slice(0, ACADEMIC_LIMITS.units).map((u) => ({
    id: u.id,
    title: clip(u.title, ACADEMIC_LIMITS.title),
    hours: hrs(u.hours.contact + u.hours.practice + u.hours.autonomous),
    outcomeIds: refs(u.outcomeIds),
    contents: u.contents.slice(0, ACADEMIC_LIMITS.contentsPerUnit).map((c, j) => ({ id: `${u.id}.${j + 1}`, text: clip(c, ACADEMIC_LIMITS.text), outcomeIds: [], ...prov(P('units')) })),
    ...prov(P('units')),
  }));

  const total = resolveTotalHours(answers.time) ?? mc.totalHours;
  const time = answers.time || {};
  const split = requestedSplit(answers.time);
  const LABEL: Record<HourKind, string> = { contact: 'Trabajo con el docente', practice: 'Práctica', autonomous: 'Trabajo autónomo' };
  ctx.hours = {
    total: field(hrs(total), 'docente'),
    weekly: field(time.mode === 'weekly' && typeof time.hoursPerWeek === 'number' ? time.hoursPerWeek : null, 'docente'),
    weeks: field(typeof time.weeks === 'number' && time.mode === 'weekly' ? time.weeks : null, 'docente'),
    credits: field(time.mode === 'credits' && typeof time.credits === 'number' ? time.credits : null, 'docente'),
    components: (['contact', 'practice', 'autonomous'] as HourKind[])
      .map((k) => ({ k, h: hrs(mc.units.reduce((a, u) => a + u.hours[k], 0)) }))
      .filter((x) => x.h > 0)
      .map((x, i) => ({ id: `H${i + 1}`, label: LABEL[x.k], kind: x.k, hours: x.h, ...prov(split[x.k] !== undefined ? 'docente' : 'cursia') })),
  };
  ctx.evaluation = mc.evaluation.slice(0, ACADEMIC_LIMITS.evaluation).map((e, i) => ({
    id: `EV${i + 1}`,
    instrument: clip(e.evidence ? `${e.name}: ${e.evidence}` : e.name, ACADEMIC_LIMITS.text),
    weightPct: e.percent >= 0 && e.percent <= 100 ? e.percent : null,
    outcomeIds: refs(e.outcomeIds),
    ...prov(P('evaluation')),
  }));
  ctx.bibliography = mc.bibliography.slice(0, ACADEMIC_LIMITS.bibliography).map((b, i) => ({
    id: `B${i + 1}`, text: clip(b.text, ACADEMIC_LIMITS.text), ...prov(b.origin === 'docente' ? 'docente' : 'cursia'),
  }));
  const strategies = mc.methodology.strategies.length ? ` Estrategias: ${mc.methodology.strategies.join(', ')}.` : '';
  ctx.methodology = field(clip(`${mc.methodology.text}${strategies}`, ACADEMIC_LIMITS.text), P('methodology'));
  const constraints = [answers.methodology?.institutionalEvaluation, time.calendar].filter((x): x is string => !!x).map((x) => clip(x, ACADEMIC_LIMITS.text)).slice(0, ACADEMIC_LIMITS.listItems);
  ctx.constraints = field(constraints.length ? constraints : null, 'docente');
  const extra = [answers.references?.notes, answers.learners?.context, answers.learners?.specialNeeds].filter((x): x is string => !!x).map((x) => clip(x, ACADEMIC_LIMITS.text));
  ctx.additionalInfo = field(extra.length ? extra : null, 'docente');
  return normalizeAcademicContext(ctx);
}
