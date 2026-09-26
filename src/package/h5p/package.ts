// Cursia V2.1 / R7-core — empaquetado `.h5p` determinístico (HD-V21-15).
//
// - `buildContentOnlyH5p`: h5p.json + content/content.json (KB). Despliega en un
//   sitio que ya tiene las librerías (Cursia H5P Library Pack). R0 lo probó con
//   autor docente y admin.
// - `buildSelfContainedH5p`: además incluye las carpetas de librerías (runtime +
//   editor; R0: sin editorDependencies el validador rechaza el paquete). Solo lo
//   usa el Library Pack.
//
// Bytes determinísticos: entradas ordenadas, fecha fija, sin carpetas implícitas,
// DEFLATE nivel 9. La misma entrada ⇒ el mismo sha256.
import * as JSZip from 'jszip';
import { createHash } from 'crypto';
import { isUuid } from './ids';
import { CURSIA_H5P_PROFILE_V1, profileMainLibrary, profileRuntimeDependencies } from './profile';
import { H5pDependencyRef, H5pLibraryRef, H5pProfile, compareH5pRefs, h5pLibraryDirName } from './profile-generator';

/** Fecha fija de todas las entradas del zip (UTC; JSZip escribe la hora DOS en UTC). */
export const H5P_ZIP_FIXED_DATE = new Date(Date.UTC(2026, 0, 1, 0, 0, 0));

export interface ContentOnlyH5pInput {
  mainLibrary: string;
  content: Record<string, unknown>;
  title: string;
  language: 'es';
  /** Perfil a usar (default CURSIA_H5P_PROFILE_V1). */
  profile?: H5pProfile;
}

export interface H5pJson {
  title: string;
  language: string;
  mainLibrary: string;
  embedTypes: string[];
  license: string;
  defaultLanguage: string;
  preloadedDependencies: H5pDependencyRef[];
}

function depsWithMainFirst(mainRef: H5pLibraryRef, deps: H5pLibraryRef[]): H5pDependencyRef[] {
  const strip = (r: H5pDependencyRef): H5pDependencyRef => ({
    machineName: r.machineName,
    majorVersion: r.majorVersion,
    minorVersion: r.minorVersion,
  });
  const mainKey = h5pLibraryDirName(mainRef);
  return [strip(mainRef), ...[...deps].sort(compareH5pRefs).filter((d) => h5pLibraryDirName(d) !== mainKey).map(strip)];
}

/** h5p.json: preloadedDependencies = librería principal + su clausura de runtime del perfil. */
export function buildH5pJson(input: { mainLibrary: string; title: string; language: 'es'; profile?: H5pProfile }): H5pJson {
  const profile = input.profile || CURSIA_H5P_PROFILE_V1;
  if (input.language !== 'es') throw new Error(`H5P_PACKAGE_INVALID: language debe ser "es" (recibido ${input.language})`);
  if (typeof input.title !== 'string' || !input.title.trim()) throw new Error('H5P_PACKAGE_INVALID: title vacío');
  const mainRef = profileMainLibrary(profile, input.mainLibrary);
  return {
    title: input.title.trim(),
    language: 'es',
    mainLibrary: input.mainLibrary,
    embedTypes: ['iframe'],
    license: 'U',
    defaultLanguage: 'es',
    preloadedDependencies: depsWithMainFirst(mainRef, profileRuntimeDependencies(profile, input.mainLibrary)),
  };
}

/** Verifica que todo `"library": "X a.b"` del contenido esté declarado en h5p.json. */
function assertContentLibrariesDeclared(content: unknown, h5pJson: H5pJson): void {
  const declared = new Set(h5pJson.preloadedDependencies.map((d) => `${d.machineName} ${d.majorVersion}.${d.minorVersion}`));
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      if (typeof o.library === 'string' && !declared.has(o.library)) {
        throw new Error(`H5P_PACKAGE_UNDECLARED_LIBRARY: ${o.library} no está en la clausura de ${h5pJson.mainLibrary}`);
      }
      Object.values(o).forEach(walk);
    }
  };
  walk(content);
}

/**
 * Grupos `isSubContent` (sin clave `library`) por librería principal, como ruta
 * de primer nivel del content. El check puro verifica contra semantics.json que
 * la tabla está completa para las 7 librerías del perfil.
 */
export const H5P_SUBCONTENT_GROUP_PATHS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'H5P.SingleChoiceSet': Object.freeze(['choices']),
});

/**
 * Todo sub-contenido (objeto con `library` o elemento de un grupo isSubContent)
 * debe llevar un subContentId UUID en minúsculas, único en el paquete. Sin él,
 * mod_h5pactivity abre un intento por respuesta hija (R0, review G4 C1).
 */
export function assertH5pSubContentIds(mainLibrary: string, content: unknown): string[] {
  const ids: string[] = [];
  const bad: string[] = [];
  const take = (v: unknown, p: string): void => {
    if (!isUuid(v)) bad.push(`${p}: subContentId ausente o no UUID (${JSON.stringify(v)})`);
    else if (ids.includes(v as string)) bad.push(`${p}: subContentId duplicado ${String(v)}`);
    else ids.push(v as string);
  };
  const walk = (v: unknown, p: string): void => {
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${p}[${i}]`));
    else if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      if (typeof o.library === 'string') take(o.subContentId, p || '$');
      for (const [k, x] of Object.entries(o)) walk(x, p ? `${p}.${k}` : k);
    }
  };
  walk(content, '');
  const c = (content || {}) as Record<string, unknown>;
  for (const gp of H5P_SUBCONTENT_GROUP_PATHS[mainLibrary] || []) {
    const list = c[gp];
    if (!Array.isArray(list)) continue;
    list.forEach((item, i) => take(item && (item as Record<string, unknown>).subContentId, `${gp}[${i}]`));
  }
  if (bad.length) throw new Error(`H5P_PACKAGE_SUBCONTENT_ID: ${bad.join('; ')}`);
  return ids;
}

async function zipDeterministic(entries: Array<[string, Buffer | string]>): Promise<Buffer> {
  const zip = new JSZip();
  const sorted = [...entries].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i][0] === sorted[i - 1][0]) throw new Error(`H5P_PACKAGE_DUPLICATE_ENTRY: ${sorted[i][0]}`);
  }
  for (const [name, data] of sorted) {
    zip.file(name, data, { date: H5P_ZIP_FIXED_DATE, createFolders: false, binary: typeof data !== 'string' });
  }
  return zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 },
    platform: 'DOS',
    streamFiles: false,
  });
}

/** `.h5p` solo contenido (sin librerías). Bytes determinísticos. */
export async function buildContentOnlyH5p(input: ContentOnlyH5pInput): Promise<Buffer> {
  if (!input || typeof input.content !== 'object' || input.content === null) {
    throw new Error('H5P_PACKAGE_INVALID: content debe ser un objeto');
  }
  const h5pJson = buildH5pJson(input);
  assertContentLibrariesDeclared(input.content, h5pJson);
  assertH5pSubContentIds(input.mainLibrary, input.content);
  return zipDeterministic([
    ['h5p.json', JSON.stringify(h5pJson)],
    ['content/content.json', JSON.stringify(input.content)],
  ]);
}

export interface SelfContainedH5pInput extends ContentOnlyH5pInput {
  /**
   * Archivos de librerías, ruta relativa dentro del zip (`H5P.X-1.2/...`) → bytes.
   * Deben cubrir exactamente la clausura `full` (runtime + editor) del perfil.
   */
  libraryFiles: Record<string, Buffer>;
}

/** `.h5p` autocontenido (runtime + editor). Usado por el Cursia H5P Library Pack. */
export async function buildSelfContainedH5p(input: SelfContainedH5pInput): Promise<Buffer> {
  const profile = input.profile || CURSIA_H5P_PROFILE_V1;
  const h5pJson = buildH5pJson(input);
  assertContentLibrariesDeclared(input.content, h5pJson);
  assertH5pSubContentIds(input.mainLibrary, input.content);
  const needed = new Set(profile.closureByMain[input.mainLibrary].full.map(h5pLibraryDirName));
  const present = new Set<string>();
  const entries: Array<[string, Buffer | string]> = [
    ['h5p.json', JSON.stringify(h5pJson)],
    ['content/content.json', JSON.stringify(input.content)],
  ];
  for (const [p, data] of Object.entries(input.libraryFiles)) {
    const top = p.split('/')[0];
    if (!needed.has(top)) throw new Error(`H5P_PACKAGE_UNEXPECTED_LIBRARY_FILE: ${p}`);
    present.add(top);
    entries.push([p, data]);
  }
  const missing = [...needed].filter((d) => !present.has(d));
  if (missing.length) throw new Error(`H5P_PACKAGE_MISSING_LIBRARY_FILES: ${missing.sort().join(', ')}`);
  return zipDeterministic(entries);
}

export function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}
