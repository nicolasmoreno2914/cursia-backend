/**
 * r107 B1 · Taller de cursos — identificación PURA de un .mbz: ¿de qué curso de Cursia es, con qué builder se armó y de
 * qué familia de formato? Sin base ni red: el servicio le pasa el «catálogo» ya filtrado por dueño / institución.
 *
 * Orden (el primero que responde gana; siempre se guarda método y confianza):
 *   a. marca `cursia_meta.json` dentro del paquete (ningún builder la escribe todavía: ver B1-report §cursia_meta);
 *      → exacta, si el curso es del mismo dueño / institución;
 *   b. huella: sha256 del paquete == checksum de un artifact .mbz del catálogo (`mbz_final` / `dynamic_mbz`) → exacta;
 *   b2. marca implícita del builder v3: `<name>cursia-v3-<courseId>.mbz</name>` en moodle_backup.xml (la escribe el
 *      builder v3 desde siempre) → exacta solo si ese curso es del dueño Y el título coincide; si no, suma a la heurística;
 *   c. heurística: título (`original_course_fullname`) + estructura (actividades) + tamaño contra el catálogo →
 *      candidatos con puntaje; identifica solo con confianza alta y sin empate (queda `needsConfirmation`);
 *   d. nada → `courseId = null`: se trabaja solo con el paquete (no es un error).
 *
 * Regla dura: NUNCA cruza cuentas. El catálogo ya viene filtrado, y además cada entrada se vuelve a filtrar acá contra
 * el alcance (dueño / institución): un curso ajeno no aparece ni como candidato ni en las notas.
 */
import { MbzPackage } from './mbz-reader';
import { tagInner } from './xml-scan';
// Inversa exacta de `xmlEsc` de los builders (& < > " — sin apóstrofes): la de «Diseño visual», sin duplicarla.
import { xmlUnescape } from '../visual-design/preview-extract';

export type WorkshopFamily = 'v1-legacy' | 'v1-legacy-hvp' | 'v2-dynamic' | 'moodle-reexport' | 'prototype';
export const WORKSHOP_FAMILIES: readonly WorkshopFamily[] = Object.freeze(['v1-legacy', 'v1-legacy-hvp', 'v2-dynamic', 'moodle-reexport', 'prototype']) as readonly WorkshopFamily[];

/** Línea de builder inferida del paquete (la versión exacta solo sale de cursia_meta o del artifact que coincide). */
export type BuilderLine = 'v3' | 'dynamic-v1v2' | 'legacy-v1' | 'moodle-reexport' | 'unknown';

export interface CursiaMeta {
  schema: number;
  courseId: number | null;
  builderVersion: string | null;
}

/** Lo que se lee del paquete (solo moodle_backup.xml, users.xml y la marca; nunca se extrae nada más). */
export interface PackageFacts {
  container: 'zip' | 'tar.gz';
  entryCount: number;
  title: string | null;
  shortname: string | null;
  backupName: string | null;
  backupId: string | null;
  moodleRelease: string | null;
  backupRelease: string | null;
  originalWwwroot: string | null;
  /** modulename → cantidad de actividades (moodle_backup.xml). */
  modules: Record<string, number>;
  activities: number;
  sections: number;
  /** Mismo criterio que scripts/r107/survey-corpus.js: nombre de archivo de backup de Moodle, o users.xml con usuarios. */
  moodleReexport: boolean;
  cursiaMeta: CursiaMeta | null;
  /** Id de curso de la marca implícita del builder v3 (`cursia-v3-<id>.mbz`), o null. */
  v3NameCourseId: number | null;
}

export class PackageFactsError extends Error {
  constructor(readonly code: 'missing_moodle_backup' | 'invalid_moodle_backup', message: string) {
    super(message);
    this.name = 'PackageFactsError';
  }
}

const XML_MAX_BYTES = 64 * 1024 * 1024;
export const CURSIA_META_ENTRY = 'cursia_meta.json';

function tagText(xml: string, name: string): string | null {
  const m = new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml);
  return m ? xmlUnescape(m[1]).trim() : null;
}

/** Mismo criterio que survey-corpus.js (`moodleReexport`): nombre del backup de Moodle. */
export function isMoodleBackupFilename(filename: string | null | undefined): boolean {
  return /copia_de_seguridad-moodle2|backup-moodle2/.test(String(filename ?? '').split(/[\\/]/).pop() ?? '');
}

export function parseCursiaMeta(raw: string | null): CursiaMeta | null {
  if (!raw) return null;
  try {
    const j = JSON.parse(raw);
    if (!j || typeof j !== 'object') return null;
    const id = Number(j.courseId);
    return {
      schema: Number.isInteger(j.schema) ? j.schema : 1,
      courseId: Number.isSafeInteger(id) && id > 0 ? id : null,
      builderVersion: typeof j.builderVersion === 'string' && /^[0-9A-Za-z.+-]{1,40}$/.test(j.builderVersion) ? j.builderVersion : null,
    };
  } catch {
    return null;
  }
}

/** Lee los hechos del paquete. Falla (PackageFactsError) solo si no hay un moodle_backup.xml utilizable. */
export async function readPackageFacts(pkg: MbzPackage, filename: string | null): Promise<PackageFacts> {
  const mb = await pkg.readText('moodle_backup.xml', { maxBytes: XML_MAX_BYTES });
  if (mb === null) throw new PackageFactsError('missing_moodle_backup', 'El paquete no tiene moodle_backup.xml: no es una copia de seguridad de un curso de Moodle.');
  if (!/<moodle_backup>/.test(mb) || !/<information>/.test(mb)) throw new PackageFactsError('invalid_moodle_backup', 'El moodle_backup.xml del paquete no tiene la forma de una copia de Moodle.');
  const modules: Record<string, number> = {};
  for (const m of mb.matchAll(/<modulename>([^<]+)<\/modulename>/g)) modules[m[1]] = (modules[m[1]] || 0) + 1;
  const activities = (mb.match(/<activity>/g) || []).length;
  const sectionsBlock = tagInner(mb, 'sections') ?? '';
  const sections = (sectionsBlock.match(/<section>/g) || []).length;
  const backupName = tagText(mb, 'name');
  const backupId = /backup_id="([^"]{1,200})"/.exec(mb)?.[1] ?? null;
  let moodleReexport = isMoodleBackupFilename(filename);
  if (!moodleReexport && pkg.has('users.xml')) {
    const users = await pkg.readText('users.xml', { maxBytes: XML_MAX_BYTES });
    moodleReexport = !!users && /<user id=/.test(users);
  }
  const metaRaw = pkg.has(CURSIA_META_ENTRY) ? await pkg.readText(CURSIA_META_ENTRY, { maxBytes: 64 * 1024 }) : null;
  const v3 = /^cursia-v3-(\d{1,12})(?:-parte-\d+-de-\d+)?\.mbz$/.exec(backupName ?? '');
  const v3Id = v3 ? Number(v3[1]) : null;
  return {
    container: pkg.container,
    entryCount: pkg.entries.length,
    title: tagText(mb, 'original_course_fullname'),
    shortname: tagText(mb, 'original_course_shortname'),
    backupName,
    backupId,
    moodleRelease: tagText(mb, 'moodle_release'),
    backupRelease: tagText(mb, 'backup_release'),
    originalWwwroot: tagText(mb, 'original_wwwroot'),
    modules,
    activities,
    sections,
    moodleReexport,
    cursiaMeta: parseCursiaMeta(metaRaw),
    v3NameCourseId: v3Id && Number.isSafeInteger(v3Id) && v3Id > 0 ? v3Id : null,
  };
}

/** Familia de formato — MISMA regla que `familyOf` de scripts/r107/build-corpus.js (el check lo compara contra el corpus). */
export function familyOf(f: Pick<PackageFacts, 'modules' | 'moodleReexport'>): WorkshopFamily {
  if (f.moodleReexport) return 'moodle-reexport';
  const m = f.modules || {};
  if (m.h5pactivity || m.book) return 'v2-dynamic';
  if (m.scorm && m.label && m.quiz) return m.hvp ? 'v1-legacy-hvp' : 'v1-legacy';
  return 'prototype';
}

/** Línea de builder por las señas que cada builder deja en moodle_backup.xml (ver B1-report §builder). */
export function builderLineOf(f: Pick<PackageFacts, 'backupName' | 'backupId' | 'moodleReexport'>): BuilderLine {
  if (f.moodleReexport) return 'moodle-reexport';
  if (/^cursia-v3-\d/.test(f.backupName ?? '') || /^cursiav3\d/.test(f.backupId ?? '')) return 'v3';
  if (/^ccdyn\d+$/.test(f.backupId ?? '')) return 'dynamic-v1v2';
  if (/^cc\d+$/.test(f.backupId ?? '')) return 'legacy-v1';
  return 'unknown';
}

// ─── Catálogo e identificación ──────────────────────────────────────────────

export interface CatalogPackage {
  artifactId: string;
  type: string;
  sha256: string | null;
  sizeBytes: number | null;
  builderVersion: string | null;
  activityCount: number | null;
}

export interface CatalogCourse {
  courseId: number;
  title: string;
  ownerId: string | null;
  institutionId: string | null;
  packages: CatalogPackage[];
}

/** Alcance de la sesión: el dueño, y su institución si la sesión pertenece a una. */
export interface IdentifyScope {
  ownerId: string;
  institutionId: string | null;
}

export type IdentifyMethod = 'cursia_meta' | 'package_hash' | 'v3_name_marker' | 'heuristic' | 'none';
export type IdentifyConfidence = 'exact' | 'high' | 'medium' | 'low' | 'none';

export interface IdentifyCandidate {
  courseId: number;
  title: string;
  score: number;
  confidence: Exclude<IdentifyConfidence, 'exact' | 'none'>;
  reasons: string[];
}

export interface IdentificationResult {
  method: IdentifyMethod;
  confidence: IdentifyConfidence;
  courseId: number | null;
  /** Artifact del catálogo cuyo checksum coincide (método package_hash). */
  matchedArtifactId: string | null;
  /** true si la identificación es heurística: la UI debe pedir confirmación antes de usar la fuente del curso. */
  needsConfirmation: boolean;
  candidates: IdentifyCandidate[];
  family: WorkshopFamily;
  builder: { line: BuilderLine; version: string | null; source: 'cursia_meta' | 'artifact' | 'package' | 'none' };
  notes: string[];
}

export interface IdentifyInput {
  facts: PackageFacts;
  sha1: string;
  sha256: string;
  sizeBytes: number;
  scope: IdentifyScope;
  catalog: readonly CatalogCourse[];
  /** Fix P2-7: el catálogo de la HEURÍSTICA se recortó (las coincidencias exactas se buscan aparte, sin límite). */
  catalogTruncated?: boolean;
}

const lc = (s: string | null | undefined) => String(s ?? '').trim().toLowerCase();

/**
 * Fix P1-2: el alcance es UNO solo, igual que la autorización del resto de la app en enforce:
 *  - sesión de una institución X → SOLO cursos de X (ni los personales del dueño ni los de otra institución suya: un
 *    miembro de X que lee la sesión nunca ve títulos / ids de fuera de X);
 *  - sesión sin institución → SOLO cursos del dueño (lo que el dueño ya ve).
 */
export function inScope(c: Pick<CatalogCourse, 'ownerId' | 'institutionId'>, scope: IdentifyScope): boolean {
  if (scope.institutionId) return !!c.institutionId && lc(c.institutionId) === lc(scope.institutionId);
  return !!c.ownerId && lc(c.ownerId) === lc(scope.ownerId);
}

/** Título comparable: sin tildes, minúsculas, sin prefijos entre corchetes, solo letras/números con un espacio. */
export function normalizeTitle(s: string | null | undefined): string {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function tokenJaccard(a: string, b: string): number {
  const A = new Set(a.split(' ').filter((t) => t.length > 2));
  const B = new Set(b.split(' ').filter((t) => t.length > 2));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

const HEURISTIC = Object.freeze({
  titleExact: 0.6,
  titleTokens: 0.5, // × Jaccard (solo con Jaccard ≥ 0.5)
  titleTokensMin: 0.5,
  activitiesExact: 0.25,
  activitiesNear: 0.1, // ±10 %
  sizeExact: 0.15,
  v3NameMarker: 0.3,
  /** Fix P2-2: cursia_meta sin corroborar = candidato medio; con la estructura llega a 0,75 (< alta): nunca identifica sola. */
  cursiaMetaUnconfirmed: 0.5,
  high: 0.85,
  medium: 0.6,
  low: 0.35,
  /** Para identificar con la heurística: confianza alta y el segundo a esta distancia o más. */
  margin: 0.2,
  maxCandidates: 5,
});
export const IDENTIFY_HEURISTIC = HEURISTIC;

function confidenceOf(score: number): IdentifyCandidate['confidence'] | null {
  if (score >= HEURISTIC.high) return 'high';
  if (score >= HEURISTIC.medium) return 'medium';
  if (score >= HEURISTIC.low) return 'low';
  return null;
}

export function identifyPackage(input: IdentifyInput): IdentificationResult {
  const { facts, scope } = input;
  const sha256 = lc(input.sha256);
  const catalog = input.catalog.filter((c) => inScope(c, scope)); // defensa en profundidad: nunca otra cuenta
  const byId = new Map(catalog.map((c) => [c.courseId, c]));
  const family = familyOf(facts);
  const line = builderLineOf(facts);
  const notes: string[] = [];
  const base = { family, notes, candidates: [] as IdentifyCandidate[], matchedArtifactId: null as string | null, needsConfirmation: false };
  const builderFromPackage = { line, version: null as string | null, source: (line === 'unknown' ? 'none' : 'package') as IdentificationResult['builder']['source'] };
  const titleN = normalizeTitle(facts.title);

  if (input.catalogTruncated) notes.push('Tu cuenta tiene muchos cursos: los parecidos se buscaron entre los más recientes (las coincidencias exactas, en todos).');

  // a. cursia_meta — fix P2-2: hoy ningún builder la escribe, así que es una DECLARACIÓN del paquete, no una prueba. Es
  //    exacta solo si se corrobora: el curso está en el alcance, el título coincide y la estructura no la contradice.
  //    Sin corroborar, solo suma a la heurística (y su versión de builder no se usa).
  const metaCourse = facts.cursiaMeta && facts.cursiaMeta.courseId !== null ? byId.get(facts.cursiaMeta.courseId) ?? null : null;
  if (facts.cursiaMeta) {
    const meta = facts.cursiaMeta;
    const acts = metaCourse ? metaCourse.packages.map((p) => p.activityCount).filter((n): n is number => typeof n === 'number' && n > 0) : [];
    const structureOk = !acts.length || facts.activities <= 0 || acts.some((n) => Math.abs(n - facts.activities) <= Math.max(1, Math.round(n * 0.1)));
    if (metaCourse && titleN && normalizeTitle(metaCourse.title) === titleN && structureOk) {
      const builder = meta.builderVersion ? { line, version: meta.builderVersion, source: 'cursia_meta' as const } : builderFromPackage;
      return { ...base, method: 'cursia_meta', confidence: 'exact', courseId: metaCourse.courseId, builder };
    }
    if (!metaCourse) notes.push('El paquete trae la marca de Cursia, pero su curso no está en tu cuenta: se identifica por otras señas.');
  }

  // b. huella del paquete (sha256 del artifact registrado por el servidor)
  if (/^[0-9a-f]{64}$/.test(sha256)) {
    for (const c of catalog) {
      const p = c.packages.find((x) => lc(x.sha256) === sha256);
      if (p) {
        const builder = p.builderVersion
          ? { line, version: p.builderVersion, source: 'artifact' as const }
          : builderFromPackage;
        return { ...base, method: 'package_hash', confidence: 'exact', courseId: c.courseId, matchedArtifactId: p.artifactId, builder };
      }
    }
  }

  // b2. marca implícita del builder v3 (id del curso en el nombre del backup), confirmada por el título
  const markerCourse = facts.v3NameCourseId !== null ? byId.get(facts.v3NameCourseId) ?? null : null;
  if (markerCourse && titleN && normalizeTitle(markerCourse.title) === titleN) {
    return { ...base, method: 'v3_name_marker', confidence: 'exact', courseId: markerCourse.courseId, builder: builderFromPackage };
  }

  // c. heurística
  const scored: IdentifyCandidate[] = [];
  for (const c of catalog) {
    let score = 0;
    const reasons: string[] = [];
    const ct = normalizeTitle(c.title);
    if (titleN && ct && ct === titleN) {
      score += HEURISTIC.titleExact;
      reasons.push('mismo título');
    } else if (titleN && ct) {
      const j = tokenJaccard(titleN, ct);
      if (j >= HEURISTIC.titleTokensMin) {
        score += HEURISTIC.titleTokens * j;
        reasons.push(`título parecido (${Math.round(j * 100)} %)`);
      }
    }
    const acts = c.packages.map((p) => p.activityCount).filter((n): n is number => typeof n === 'number' && n > 0);
    if (facts.activities > 0 && acts.includes(facts.activities)) {
      score += HEURISTIC.activitiesExact;
      reasons.push(`misma cantidad de actividades (${facts.activities})`);
    } else if (facts.activities > 0 && acts.some((n) => Math.abs(n - facts.activities) <= Math.max(1, Math.round(n * 0.1)))) {
      score += HEURISTIC.activitiesNear;
      reasons.push('cantidad de actividades parecida');
    }
    if (input.sizeBytes > 0 && c.packages.some((p) => Number(p.sizeBytes) === input.sizeBytes)) {
      score += HEURISTIC.sizeExact;
      reasons.push('mismo tamaño que un paquete del curso');
    }
    if (metaCourse && metaCourse.courseId === c.courseId) {
      score += HEURISTIC.cursiaMetaUnconfirmed;
      reasons.push('el paquete declara este curso (marca cursia_meta) pero el título o la estructura no coinciden');
    }
    if (markerCourse && markerCourse.courseId === c.courseId) {
      score += HEURISTIC.v3NameMarker;
      reasons.push('el paquete nombra este curso (marca del builder v3), con otro título');
    }
    score = Math.round(Math.min(1, score) * 1000) / 1000;
    const conf = confidenceOf(score);
    if (conf) scored.push({ courseId: c.courseId, title: c.title, score, confidence: conf, reasons });
  }
  scored.sort((a, b) => b.score - a.score || a.courseId - b.courseId);
  const candidates = scored.slice(0, HEURISTIC.maxCandidates);
  const top = candidates[0];
  if (top && top.confidence === 'high' && (!candidates[1] || top.score - candidates[1].score >= HEURISTIC.margin)) {
    return { ...base, candidates, method: 'heuristic', confidence: 'high', courseId: top.courseId, needsConfirmation: true, builder: builderFromPackage };
  }
  if (candidates.length) {
    notes.push('Hay cursos parecidos en tu cuenta, pero ninguno coincide con seguridad: elige cuál es, o trabaja solo con el paquete.');
    return { ...base, candidates, method: 'heuristic', confidence: top.confidence, courseId: null, needsConfirmation: true, builder: builderFromPackage };
  }

  // d. nada
  notes.push('No encontramos este curso en tu cuenta de Cursia: se trabaja solo con el paquete.');
  return { ...base, method: 'none', confidence: 'none', courseId: null, builder: builderFromPackage };
}

/** Versión de builder que se guarda en `workshop_sessions.builder_version`: la exacta si se conoce; si no, la línea. */
export function builderVersionColumn(r: Pick<IdentificationResult, 'builder'>): string | null {
  if (r.builder.version) return r.builder.version;
  return r.builder.line === 'unknown' ? null : r.builder.line;
}
