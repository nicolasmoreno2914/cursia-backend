// r60 (D1/D2) — compatibilidad REAL de un paquete v3 con cada versión de Moodle.
//
// El `.mbz` se escribe en formato de backup 4.1 (moodle_release/backup_version de MOODLE_VERSIONS): eso solo dice
// desde qué versión se puede RESTAURAR, no desde cuál FUNCIONA. Dos cosas del contenido suben ese piso:
//
//   D1 — H5P. Moodle instala una librería H5P solo si su `coreApi` (library.json) ≤ la API del núcleo H5P que trae
//        (h5plib: 4.1 = 1.24, 4.2 = 1.26, 4.3/4.4 = 1.27, 4.5 = 1.28); si no, «api-version-unsupported» y la
//        actividad muestra «Missing required library». Las librerías del Cursia H5P Library Pack (v1/v2/v3) piden
//        1.28 (JoubelUI 1.3.45, Question 1.5.53, Components 1.0.97, QuestionSet 1.21.13 —el único patch de 1.21—…):
//        un paquete con H5P funciona solo en Moodle ≥ 4.5. La tabla sale de cursia-h5p-core-api.json (generada).
//   D2 — Tokens de restauración. `$@COURSESECTIONBYID*n@$` solo tiene regla de decodificación desde Moodle 4.4
//        (restore_course_task); en 4.1–4.3 queda literal en el href. `$@COURSEVIEWBYID*c@$` existe en todas.
//
// El paquete DECLARA su Moodle mínimo (summary.moodleCompatibility / expectations.moodleMinimum) y el validador lo
// recalcula desde los bytes: un paquete nunca declara compatibilidad con una versión en la que no funciona.
import * as JSZip from 'jszip';
import * as coreApiJson from '../h5p/cursia-h5p-core-api.json';

/** Versiones de Moodle que Cursia conoce (las que tienen entorno de prueba local). */
export const MOODLE_COMPAT_VERSIONS = ['4.1', '4.2', '4.3', '4.4', '4.5'] as const;
export type MoodleCompatVersion = (typeof MOODLE_COMPAT_VERSIONS)[number];

/** API del núcleo H5P que trae cada versión de Moodle (h5p/h5plib/vNNN de la rama). */
export const MOODLE_H5P_CORE_API: Readonly<Record<MoodleCompatVersion, string>> = Object.freeze({
  '4.1': '1.24',
  '4.2': '1.26',
  '4.3': '1.27',
  '4.4': '1.27',
  '4.5': '1.28',
});

/** Primera versión de Moodle con regla de decodificación para cada token `$@X*id@$` que no está en todas. */
export const MOODLE_TOKEN_MIN_VERSION: Readonly<Record<string, MoodleCompatVersion>> = Object.freeze({
  COURSESECTIONBYID: '4.4',
});

/** Primera versión desde la que `$@COURSESECTIONBYID*n@$` funciona (antes: COURSEVIEWBYID + `&section=n`). */
export const MOODLE_SECTION_TOKEN_MIN_VERSION: MoodleCompatVersion = MOODLE_TOKEN_MIN_VERSION.COURSESECTIONBYID;

const CORE_API: Readonly<Record<string, { patch: number; coreApi: string | null }>> = Object.freeze(
  JSON.parse(JSON.stringify((coreApiJson as any).libraries ?? (coreApiJson as any).default?.libraries ?? {})),
);

function vparse(v: string): [number, number] {
  const m = /^(\d+)\.(\d+)$/.exec(v);
  if (!m) throw new Error(`MOODLE_COMPAT_BAD_VERSION: ${v}`);
  return [Number(m[1]), Number(m[2])];
}

/** <0, 0, >0 como a-b para versiones «x.y». */
export function compareMajorMinor(a: string, b: string): number {
  const [a1, a2] = vparse(a);
  const [b1, b2] = vparse(b);
  return a1 !== b1 ? a1 - b1 : a2 - b2;
}

export function maxMajorMinor(vs: ReadonlyArray<string>): string | null {
  let best: string | null = null;
  for (const v of vs) if (best === null || compareMajorMinor(v, best) > 0) best = v;
  return best;
}

/** coreApi que exige una librería «Machine major.minor» del pack Cursia (null = sin requisito). Desconocida → throw. */
export function h5pLibraryCoreApi(key: string): string | null {
  const r = CORE_API[key];
  if (!r) throw new Error(`MOODLE_COMPAT_UNKNOWN_H5P_LIBRARY: ${key} no está en cursia-h5p-core-api.json`);
  return r.coreApi;
}

/** Moodle más antiguo cuya API H5P ≥ `coreApi` (null si ninguna versión conocida la alcanza). */
export function minimumMoodleForH5pCoreApi(coreApi: string | null): MoodleCompatVersion | null {
  if (coreApi === null) return MOODLE_COMPAT_VERSIONS[0];
  for (const v of MOODLE_COMPAT_VERSIONS) if (compareMajorMinor(MOODLE_H5P_CORE_API[v], coreApi) >= 0) return v;
  return null;
}

export interface MoodleCompatibility {
  /** Formato del backup (moodle_release del .mbz): versión mínima para RESTAURAR. */
  backupFormat: string;
  /** Versión mínima en la que el curso FUNCIONA completo (restaura, H5P instalable, enlaces resueltos). */
  minimumMoodle: string;
  /** API del núcleo H5P que exigen las librerías del paquete (null = el paquete no tiene H5P). */
  h5pCoreApi: string | null;
  /** Forma de los botones a secciones: token de 4.4+ o `COURSEVIEWBYID` + `&section=n` (todas las versiones). */
  sectionLinks: 'COURSESECTIONBYID' | 'COURSEVIEWBYID_SECTION' | 'none';
  /** Por qué el mínimo es ese (para la entrega y el informe). */
  reasons: string[];
}

/**
 * Requisito de Moodle de un conjunto de librerías H5P («Machine major.minor», las del h5p.json de cada paquete).
 * Fail loud si una librería no está en la tabla o si ninguna versión conocida de Moodle la soporta.
 */
export function h5pRequirement(libraryKeys: Iterable<string>): { coreApi: string | null; minimumMoodle: MoodleCompatVersion; worst: string[] } {
  const keys = Array.from(new Set(libraryKeys)).sort();
  if (!keys.length) return { coreApi: null, minimumMoodle: MOODLE_COMPAT_VERSIONS[0], worst: [] };
  const apis = keys.map((k) => ({ k, api: h5pLibraryCoreApi(k) }));
  const coreApi = maxMajorMinor(apis.map((x) => x.api).filter((x): x is string => x !== null));
  const minimumMoodle = minimumMoodleForH5pCoreApi(coreApi);
  if (!minimumMoodle) throw new Error(`MOODLE_COMPAT_H5P_UNSUPPORTED: coreApi ${coreApi} > la de Moodle ${MOODLE_COMPAT_VERSIONS[MOODLE_COMPAT_VERSIONS.length - 1]}`);
  return { coreApi, minimumMoodle, worst: apis.filter((x) => x.api !== null && x.api === coreApi).map((x) => x.k) };
}

/** Versión mínima que exige cada token `$@X*…@$` de un HTML (los que funcionan en todas no aparecen). */
export function tokenRequirements(html: string): Array<{ token: string; minimumMoodle: MoodleCompatVersion }> {
  const out: Array<{ token: string; minimumMoodle: MoodleCompatVersion }> = [];
  for (const m of html.matchAll(/\$@([A-Z0-9_]+)(?:\*\d+)?@\$/g)) {
    const v = MOODLE_TOKEN_MIN_VERSION[m[1]];
    if (v) out.push({ token: m[0], minimumMoodle: v });
  }
  return out;
}

/** true si los botones a secciones pueden usar `$@COURSESECTIONBYID*n@$` (el paquete ya exige ≥ 4.4). */
export function sectionTokenSupported(minimumMoodle: string): boolean {
  return compareMajorMinor(minimumMoodle, MOODLE_SECTION_TOKEN_MIN_VERSION) >= 0;
}

/**
 * Enlace a la sección `n` que Moodle resuelve desde 4.1: `$@COURSEVIEWBYID*curso@$&amp;section=n` → (restore)
 * `/course/view.php?id=<nuevo>&section=n` (4.1–4.3 muestran esa sección; 4.4+ redirigen a section.php).
 * El `&` va como `&amp;` porque es el valor de un atributo href en HTML.
 */
export function legacySectionHref(courseBackupId: number, sectionNum: number): string {
  return `$@COURSEVIEWBYID*${courseBackupId}@$&amp;section=${sectionNum}`;
}

/** Reescribe cada `$@COURSESECTIONBYID*n@$` a la forma de 4.1+. */
export function rewriteSectionTokensLegacy(html: string, courseBackupId: number): string {
  return html.replace(/\$@COURSESECTIONBYID\*(\d+)@\$/g, (_m, n: string) => legacySectionHref(courseBackupId, Number(n)));
}

/** Números de sección enlazados por un HTML en cualquiera de las dos formas (para la navegación del validador). */
export function sectionLinkTargets(html: string, courseBackupId: number): number[] {
  const out: Array<{ at: number; n: number }> = [];
  for (const m of html.matchAll(/\$@COURSESECTIONBYID\*(\d+)@\$/g)) out.push({ at: m.index ?? 0, n: Number(m[1]) });
  const legacy = new RegExp(`\\$@COURSEVIEWBYID\\*${courseBackupId}@\\$&(?:amp;)?section=(\\d+)`, 'g');
  for (const m of html.matchAll(legacy)) out.push({ at: m.index ?? 0, n: Number(m[1]) });
  return out.sort((a, b) => a.at - b.at).map((x) => x.n);
}

/** Compatibilidad final: el mínimo es el mayor entre el formato del backup, el H5P y los tokens. */
export function moodleCompatibilityOf(p: {
  backupFormat: string;
  h5pLibraryKeys: Iterable<string>;
  html: Iterable<string>;
  sectionLinks: MoodleCompatibility['sectionLinks'];
}): MoodleCompatibility {
  const reasons: string[] = [];
  const h = h5pRequirement(p.h5pLibraryKeys);
  const cands: string[] = [p.backupFormat];
  if (h.coreApi !== null) {
    cands.push(h.minimumMoodle);
    reasons.push(`h5p_core_api:${h.coreApi}→moodle_${h.minimumMoodle}`);
  }
  const toks = new Map<string, string>();
  for (const s of p.html) for (const t of tokenRequirements(s)) toks.set(t.token.replace(/\*\d+@\$$/, '@$'), t.minimumMoodle);
  for (const [t, v] of toks) {
    cands.push(v);
    reasons.push(`token:${t}→moodle_${v}`);
  }
  const minimumMoodle = maxMajorMinor(cands) as string;
  if (!reasons.length) reasons.push(`backup_format:${p.backupFormat}`);
  return { backupFormat: p.backupFormat, minimumMoodle, h5pCoreApi: h.coreApi, sectionLinks: p.sectionLinks, reasons };
}

/**
 * Librerías («Machine major.minor») que Moodle tiene que tener instaladas para desplegar estos .h5p: la principal y
 * las preloadedDependencies de cada h5p.json (lo que Moodle mira al desplegar un paquete solo-contenido).
 */
export async function h5pPackageLibraryKeys(packages: ReadonlyArray<Buffer>): Promise<string[]> {
  const keys = new Set<string>();
  for (const buf of packages) {
    const zip = await JSZip.loadAsync(buf);
    const f = zip.file('h5p.json');
    if (!f) throw new Error('MOODLE_COMPAT_H5P_JSON_MISSING: .h5p sin h5p.json');
    const j = JSON.parse((await f.async('string')).replace(/^\uFEFF/, ''));
    for (const d of [...(Array.isArray(j.preloadedDependencies) ? j.preloadedDependencies : [])]) {
      keys.add(`${d.machineName} ${d.majorVersion}.${d.minorVersion}`);
    }
    // Carpetas de librería dentro del .h5p (paquetes ≤ 3.13.0): también cuentan.
    for (const name of Object.keys(zip.files)) {
      const m = /^([A-Za-z0-9._-]+)-(\d+)\.(\d+)\/library\.json$/.exec(name);
      if (m) keys.add(`${m[1]} ${m[2]}.${m[3]}`);
    }
  }
  return Array.from(keys).sort();
}
