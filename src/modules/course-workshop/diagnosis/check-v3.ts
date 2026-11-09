/**
 * r107 B3 · Taller de cursos — T11: el validador del builder v3 (`mbz-validator-v3.ts`) sobre el paquete, REUSADO tal
 * cual (no una copia de sus reglas):
 *   - con expectativas (facts + perfil del builder) cuando el curso está identificado y la base las tiene: el validador
 *     completo, el mismo que aprueba un paquete antes de entregarlo;
 *   - sin expectativas (`validateMbzV3Structure`): solo las reglas que leen los bytes.
 * Cada hallazgo del validador se ubica en su actividad (idnumber `cv3:…`, carpeta, `file N`) y, si un check T01–T10 ya
 * reportó ESA actividad / ESE archivo, se le adjunta como corroboración (`corroboratedBy`) en lugar de duplicarlo: un
 * defecto, un hallazgo. Lo que el validador ve y T01–T10 no, queda como hallazgo propio de T11.
 */
import { WorkshopActivity } from '../course-model';
import { MbzV3Issue } from '../../../package/v3/mbz-validator-v3';
import { DiagnosisContext } from './context';
import { Finding, Severity, makeFinding } from './finding';
import { scopeOf } from './checks';

export interface ValidatorItem {
  finding: Finding;
  issue: MbzV3Issue;
  /** Actividad donde el validador lo ubicó (o null: curso / paquete). */
  activity: WorkshopActivity | null;
  /** Otras actividades que el mensaje nombra (moduleids del paquete). */
  related: number[];
  fileId: number | null;
}

/** Severidad de cada código del validador en el Taller (sin facts, lo dudoso baja a aviso). */
export function validatorSeverity(i: MbzV3Issue, withFacts: boolean): Severity {
  switch (i.code) {
    case 'CLEAN_SAFE': return 'info';
    case 'TOKEN_INVALID': return /enlace muerto/.test(i.message) ? 'warning' : 'error';
    case 'H5P_PARTIAL_LIBRARY_CLOSURE': return 'error';
    case 'H5P_LIBRARIES': return /no es content-only|fuera del perfil|≠ perfil/.test(i.message) ? 'warning' : 'error';
    case 'H5P_FILES': return /falta la entrada package|content\/content\.json/.test(i.message) ? 'error' : 'warning';
    case 'LIBRO_CTA': return 'warning';
    case 'FILES_INTEGRITY': return /huérfano|ruta mal formada/.test(i.message) ? 'info' : 'error';
    default: return withFacts ? 'error' : 'warning';
  }
}

const TITLES: Record<string, string> = {
  FILES_INTEGRITY: 'Un archivo del curso no está donde el paquete dice (o sobra).',
  STRUCTURE: 'La estructura del paquete no es la que arma el builder.',
  TOKEN_INVALID: 'Un enlace interno no lleva a donde debe.',
  CLEAN_SAFE: 'Un texto no cumple el estilo seguro de Cursia (tamaño de letra, contraste o color).',
  H5P_FILES: 'Una actividad H5P no trae su contenido como lo espera Moodle.',
  H5P_LIBRARIES: 'Una actividad H5P trae piezas de programa propias en vez de usar las del sitio.',
  H5P_PARTIAL_LIBRARY_CLOSURE: 'Una actividad H5P trae piezas de programa incompletas: Moodle puede quedarse colgado al restaurarla.',
  LIBRO: 'El Libro Guía no está completo.',
  LIBRO_CTA: 'El botón del Libro Guía no es el que arma el builder.',
};

/** Hallazgos del validador v3 ubicados en el paquete (puro). */
export function validatorItems(ctx: DiagnosisContext): ValidatorItem[] {
  const v = ctx.validator;
  if (v.mode === 'not_applicable') return [];
  if (v.error) {
    const finding = makeFinding({ check: 'T11', code: 'validator_failed', severity: 'warning', scope: scopeOf(ctx, null),
      title: 'La revisión completa del builder no se pudo correr sobre este paquete.',
      detail: `validateMbzV3${v.mode === 'with_expectations' ? '' : 'Structure'}: ${v.error}`, evidence: { entry: null } });
    return [{ finding, issue: { code: 'VALIDATOR_FAILED', where: 'package', message: v.error }, activity: null, related: [], fileId: null }];
  }
  const withFacts = v.mode === 'with_expectations';
  const out: ValidatorItem[] = [];
  // Varios mensajes del MISMO código sobre la MISMA ubicación (p. ej. dos reglas H5P_FILES de un video) = un hallazgo.
  const groups = new Map<string, MbzV3Issue[]>();
  for (const i of v.issues) {
    const k = `${i.code}|${i.where}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(i);
  }
  [...groups.values()].map((g) => ({ ...g[0], message: g.map((x) => x.message).join(' · ') })).forEach((i, n) => {
    let activity: WorkshopActivity | null = null;
    let fileId: number | null = null;
    const fm = /^file (\d+)$/.exec(i.where);
    if (fm) {
      fileId = Number(fm[1]);
      activity = ctx.files.find((x) => x.file.fileId === fileId)?.owner ?? null;
    } else {
      activity = ctx.actByDir.get(i.where) ?? ctx.actByIdnumber.get(i.where.split('#')[0]) ?? null;
    }
    const related = [...new Set([...`${i.where} ${i.message}`.matchAll(/\b(\d{2,9})\b/g)].map((m) => Number(m[1])).filter((x) => ctx.actByMid.has(x)))];
    const finding = makeFinding({
      check: 'T11', code: i.code.toLowerCase(), severity: validatorSeverity(i, withFacts), scope: scopeOf(ctx, activity),
      title: `${TITLES[i.code] ?? 'El paquete no cumple una regla del builder.'}${activity ? ` (${activity.title ? `«${activity.title.slice(0, 60)}»` : activity.dir})` : ''}`,
      detail: `mbz-validator-v3${withFacts ? '' : ' (sin expectativas)'} ${i.code} @ ${i.where}: ${i.message}`,
      evidence: { entry: activity ? `${activity.dir}/${activity.modname}.xml` : i.where, excerpt: i.message },
      key: `${n}|${i.where}|${i.message}`,
    });
    out.push({ finding, issue: i, activity, related, fileId });
  });
  return out;
}

/**
 * Une el validador con T01–T10: cada ítem se adjunta al hallazgo existente del MISMO archivo (`file N`) o de la MISMA
 * actividad (la que nombra `where`, o alguna que nombra el mensaje); si no hay ninguno, queda como hallazgo T11.
 * Devuelve los hallazgos T11 que quedan solos. Muta `findings` (agrega corroboraciones).
 */
export function foldValidator(items: ValidatorItem[], findings: Finding[]): Finding[] {
  const alone: Finding[] = [];
  for (const it of items) {
    const corr = { source: 'mbz-validator-v3' as const, code: it.issue.code, where: it.issue.where, message: it.issue.message };
    let host: Finding | undefined;
    if (it.fileId !== null) host = findings.find((x) => x.evidence.file?.fileId === it.fileId);
    if (!host && it.activity) host = findings.find((x) => x.scope.activity?.moduleId === it.activity!.moduleId);
    if (!host && it.related.length) host = findings.find((x) => x.scope.activity && it.related.includes(x.scope.activity.moduleId));
    if (host) host.corroboratedBy.push(corr);
    else alone.push(it.finding);
  }
  return alone;
}
