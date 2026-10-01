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
import { CURSIA_H5P_PROFILE_V1, profileDeltaDirs, profileMainLibrary, profileRuntimeDependencies } from './profile';
import { H5P_BUNDLE_LICENSE_NOTICE_FILE, H5pLibrarySource } from './library-store';
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
  /**
   * EV6 H5P v2 — librerías de sub-contenido EXTRA (del perfil, sin dependencias
   * propias) que el contenido usa además de la clausura de runtime de la
   * principal. Hoy: `H5P.Text 1.1` en las pausas de reflexión del IV avanzado.
   * Ausente ⇒ h5p.json idéntico al de siempre.
   */
  extraDependencies?: H5pDependencyRef[];
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
export function buildH5pJson(input: {
  mainLibrary: string;
  title: string;
  language: 'es';
  profile?: H5pProfile;
  extraDependencies?: H5pDependencyRef[];
}): H5pJson {
  const profile = input.profile || CURSIA_H5P_PROFILE_V1;
  if (input.language !== 'es') throw new Error(`H5P_PACKAGE_INVALID: language debe ser "es" (recibido ${input.language})`);
  if (typeof input.title !== 'string' || !input.title.trim()) throw new Error('H5P_PACKAGE_INVALID: title vacío');
  const mainRef = profileMainLibrary(profile, input.mainLibrary);
  const runtime = profileRuntimeDependencies(profile, input.mainLibrary);
  if (input.extraDependencies && input.extraDependencies.length) {
    const have = new Set(runtime.map(h5pLibraryDirName));
    const inProfile = new Map(profile.libraries.map((r) => [h5pLibraryDirName(r), r]));
    for (const e of input.extraDependencies) {
      const k = h5pLibraryDirName(e);
      const ref = inProfile.get(k);
      if (!ref) throw new Error(`H5P_PACKAGE_INVALID: dependencia extra ${k} fuera de ${profile.profileId}`);
      if (!have.has(k)) {
        runtime.push({ ...ref });
        have.add(k);
      }
    }
  }
  return {
    title: input.title.trim(),
    language: 'es',
    mainLibrary: input.mainLibrary,
    embedTypes: ['iframe'],
    license: 'U',
    defaultLanguage: 'es',
    preloadedDependencies: depsWithMainFirst(mainRef, runtime),
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

export interface BundledH5pInput extends ContentOnlyH5pInput {
  /** Perfil derivado con `deltaByMain` (CURSIA_H5P_PROFILE_V2). Obligatorio. */
  profile: H5pProfile;
  /** Store de librerías (openH5pLibraryStore). Nada se descarga. */
  libraryStore: H5pLibrarySource;
}

/**
 * EV6 H5P v2 — `.h5p` con "delta bundling": h5p.json + content/content.json +
 * EXACTAMENTE las carpetas de `profile.deltaByMain[mainLibrary]` (clausura full
 * de la principal − librerías de v1, que el preflight ya exige en el sitio).
 * Un admin/manager que restaura instala esas librerías al primer uso (prueba H5P2,
 * curso 1007). Cada carpeta lleva además `LICENSE.txt` (aviso MIT del store) si el store lo da. Bytes determinísticos. Falla fuerte con
 * H5P_PACKAGE_MISSING_LIBRARY_FILES si falta cualquier archivo del store.
 */
export async function buildBundledH5p(input: BundledH5pInput): Promise<Buffer> {
  if (!input || typeof input.content !== 'object' || input.content === null) {
    throw new Error('H5P_PACKAGE_INVALID: content debe ser un objeto');
  }
  const profile = input.profile;
  if (!profile || !profile.deltaByMain) throw new Error('H5P_PACKAGE_INVALID: buildBundledH5p exige un perfil con deltaByMain (CURSIA_H5P_PROFILE_V2)');
  if (!input.libraryStore || input.libraryStore.profileId !== profile.profileId) {
    throw new Error(`H5P_PACKAGE_INVALID: el store de librerías no corresponde a ${profile.profileId}`);
  }
  const dirs = profileDeltaDirs(profile, input.mainLibrary);
  const h5pJson = buildH5pJson(input);
  assertContentLibrariesDeclared(input.content, h5pJson);
  assertH5pSubContentIds(input.mainLibrary, input.content);
  const entries: Array<[string, Buffer | string]> = [
    ['h5p.json', JSON.stringify(h5pJson)],
    ['content/content.json', JSON.stringify(input.content)],
  ];
  const missing: string[] = [];
  for (const d of dirs) {
    const files = input.libraryStore.libraryFiles(d);
    if (!files || !files['library.json']) {
      missing.push(d);
      continue;
    }
    for (const rel of Object.keys(files).sort()) entries.push([`${d}/${rel}`, files[rel]]);
    // EV6 H5P v2 (H2, m-8): aviso MIT dentro de la carpeta (Moodle 4.5 lo acepta: .txt está en el
    // whitelist de librerías; validado con api::is_valid_package como autor administrador).
    const notice = input.libraryStore.licenseNotice ? input.libraryStore.licenseNotice(d) : null;
    if (notice !== null) entries.push([`${d}/${H5P_BUNDLE_LICENSE_NOTICE_FILE}`, notice]);
  }
  if (missing.length) throw new Error(`H5P_PACKAGE_MISSING_LIBRARY_FILES: ${missing.join(', ')}`);
  return zipDeterministic(entries);
}

export function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}
