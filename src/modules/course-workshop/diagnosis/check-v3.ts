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
import { Finding, SEVERITY_RANK, Severity, makeFinding } from './finding';
import { humanName, scopeOf } from './checks';

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
  [...groups.values()].map((g) => ({ ...g[0], message: g.map((x) => x.message).join(' · ') })).forEach((i) => {
    let activity: WorkshopActivity | null = null;
    let fileId: number | null = null;
    const fm = /^file (\d+)$/.exec(i.where);
    if (fm) {
      fileId = Number(fm[1]);
      activity = ctx.files.find((x) => x.file.fileId === fileId)?.owner ?? null;
    } else {
      activity = ctx.actByDir.get(i.where) ?? ctx.actByIdnumber.get(i.where.split('#')[0]) ?? null;
    }
    const related = relatedModuleIds(i).filter((x) => ctx.actByMid.has(x));
    const finding = makeFinding({
      check: 'T11', code: i.code.toLowerCase(), severity: validatorSeverity(i, withFacts), scope: scopeOf(ctx, activity),
      title: `${TITLES[i.code] ?? 'El paquete no cumple una regla del builder.'}${activity ? ` («${humanName(activity)}»)` : ''}`,
      detail: `mbz-validator-v3${withFacts ? '' : ' (sin expectativas)'} ${i.code} @ ${i.where}: ${i.message}`,
      evidence: { entry: activity ? `${activity.dir}/${activity.modname}.xml` : i.where, excerpt: i.message },
      // r107 B4 fix round 1: sin el ordinal del ítem (un ítem nuevo en otro lugar del paquete corría los ids de todos
      // los siguientes): código + ubicación ya son únicos por grupo.
      key: `${i.where}|${i.message}`,
    });
    out.push({ finding, issue: i, activity, related, fileId });
  });
  return out;
}

/**
 * Fix round 1 (P1-2): moduleids que el mensaje nombra SOLO por patrones explícitos («moduleid repetido N», «el módulo N»,
 * «backup N», y la diferencia entre las dos listas de un «sequence A ≠ actividades de la sección B»); nunca cualquier
 * número que casualmente coincida con un moduleid.
 */
export function relatedModuleIds(i: MbzV3Issue): number[] {
  const out = new Set<number>();
  for (const m of i.message.matchAll(/\b(?:moduleid repetido|el módulo|backup)\s+(\d{1,9})\b/g)) out.add(Number(m[1]));
  const seq = /sequence ([\d,]*) ≠ actividades de la sección ([\d,]*)/.exec(i.message);
  if (seq) {
    const a = new Set(seq[1].split(',').filter(Boolean).map(Number));
    const b = new Set(seq[2].split(',').filter(Boolean).map(Number));
    for (const x of a) if (!b.has(x)) out.add(x);
    for (const x of b) if (!a.has(x)) out.add(x);
  }
  return [...out];
}

/**
 * Qué hallazgos de T01–T10 describen LO MISMO que cada código del validador (familia de defecto). Un ítem del
 * validador solo se adjunta a un hallazgo de su familia; CLEAN_SAFE, H5P_LIBRARIES y lo que dependa de facts no tienen
 * equivalente y siempre quedan como hallazgo T11 propio.
 */
export const VALIDATOR_FAMILY: Readonly<Record<string, readonly string[]>> = Object.freeze({
  FILES_INTEGRITY: ['T02.blob_missing', 'T02.blob_altered', 'T02.filesize_mismatch', 'T02.bad_contenthash', 'T02.undeclared_blobs', 'T02.malformed_blob_path', 'T01.listed_missing_folder'],
  TOKEN_INVALID: ['T04.token_orphan', 'T04.token_wrong_type', 'T04.token_malformed', 'T04.token_external', 'T04.anchor_orphan', 'T04.dead_link', 'T04.token_unverifiable'],
  STRUCTURE: ['T01.listed_missing_folder', 'T01.xml_unreadable', 'T01.section_missing', 'T01.not_in_sequence', 'T01.sequence_unknown_module', 'T03.moduleid_mismatch', 'T03.duplicate_moduleid', 'T03.duplicate_contextid'],
  LIBRO: ['T07.libro_pdf_truncated', 'T07.libro_truncated', 'T07.libro_missing_chapters', 'T02.blob_missing', 'T02.blob_altered'],
  LIBRO_HTML: ['T07.libro_book_empty_chapter'],
  AUDIO_DURATION: ['T02.blob_missing', 'T02.blob_altered', 'T08.audio_missing', 'T08.audio_unreadable', 'T08.audio_truncated', 'T08.audio_not_linked', 'T08.audiobook_short'],
  H5P_FILES: ['T09.h5p_package_missing', 'T09.h5p_unreadable', 'T02.blob_missing', 'T02.blob_altered'],
});

/**
 * Une el validador con T01–T10 sin ESCONDER nada (fix round 1, P1-2): cada ítem se adjunta solo a un hallazgo de SU
 * familia (VALIDATOR_FAMILY) sobre el mismo archivo (`file N`) o la misma actividad (la de `where`, o una que el mensaje
 * nombra explícitamente); el receptor queda con la severidad MÁXIMA de los dos. Si no hay receptor de su familia, el
 * ítem queda como hallazgo T11 propio. Devuelve esos hallazgos sueltos; muta `findings` (corroboración + severidad).
 */
/** Hallazgos cuya severidad es una decisión del producto: el validador los corrobora sin subirlos. */
export const NO_ESCALATE: ReadonlySet<string> = new Set(['T04.token_external']);

export function foldValidator(items: ValidatorItem[], findings: Finding[]): Finding[] {
  const alone: Finding[] = [];
  for (const it of items) {
    const fam = VALIDATOR_FAMILY[it.issue.code] ?? [];
    const same = (x: Finding) => fam.includes(`${x.check}.${x.code}`);
    let host: Finding | undefined;
    if (fam.length) {
      if (it.fileId !== null) host = findings.find((x) => same(x) && x.evidence.file?.fileId === it.fileId);
      if (!host && it.activity) host = findings.find((x) => same(x) && x.scope.activity?.moduleId === it.activity!.moduleId);
      if (!host && it.related.length) host = findings.find((x) => same(x) && !!x.scope.activity && it.related.includes(x.scope.activity.moduleId));
    }
    if (!host) { alone.push(it.finding); continue; }
    host.corroboratedBy.push({ source: 'mbz-validator-v3', code: it.issue.code, where: it.issue.where, message: it.issue.message });
    // Fix round 2 (N3): un enlace a OTRO curso del sitio es aviso por decisión (brief): el TOKEN_INVALID del validador
    // («no apunta al curso del backup») lo corrobora pero no lo sube a error.
    if (NO_ESCALATE.has(`${host.check}.${host.code}`)) continue;
    if (SEVERITY_RANK[it.finding.severity] > SEVERITY_RANK[host.severity]) host.severity = it.finding.severity;
  }
  return alone;
}
