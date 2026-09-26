// Cursia V2.1 / R7-core — cálculo PURO del perfil de librerías H5P certificado.
//
// Entrada: el contenido de cada `library.json` de una carpeta de librerías H5P
// (indexado por el nombre de carpeta `Machine-maj.min`). Salida: el objeto de
// perfil que se serializa a `cursia-h5p-profile.v1.json` (committed).
//
// Sin I/O, sin reloj, sin aleatoriedad: la misma entrada produce exactamente el
// mismo perfil (orden de claves y de arrays incluidos). El script
// `scripts/generate-h5p-profile.js <libsDir>` es quien lee los archivos.

export interface H5pDependencyRef {
  machineName: string;
  majorVersion: number;
  minorVersion: number;
}

export interface H5pLibraryRef extends H5pDependencyRef {
  patchVersion: number;
}

export interface H5pLibraryJson extends H5pLibraryRef {
  preloadedDependencies?: H5pDependencyRef[];
  dynamicDependencies?: H5pDependencyRef[];
  editorDependencies?: H5pDependencyRef[];
  [key: string]: unknown;
}

export interface H5pMainClosure {
  /** Librerías que el reproductor necesita (preloaded + dynamic, recursivo). */
  runtime: H5pLibraryRef[];
  /** runtime + editor (editorDependencies de cualquier librería alcanzada, recursivo). */
  full: H5pLibraryRef[];
}

export interface H5pProfile {
  profileId: string;
  version: number;
  mainLibraries: Record<string, H5pLibraryRef>;
  /** Sub-contenidos que Cursia inserta dentro de cada librería principal. */
  contentLibrariesByMain: Record<string, H5pDependencyRef[]>;
  libraries: H5pLibraryRef[];
  closureByMain: Record<string, H5pMainClosure>;
}

export const CURSIA_H5P_PROFILE_ID_V1 = 'CURSIA_H5P_PROFILE_V1';

/** Librerías principales certificadas (major.minor). El patch sale de la carpeta de librerías. */
export const CURSIA_H5P_MAIN_LIBRARIES_V1: ReadonlyArray<H5pDependencyRef> = Object.freeze([
  { machineName: 'H5P.InteractiveVideo', majorVersion: 1, minorVersion: 27 },
  { machineName: 'H5P.QuestionSet', majorVersion: 1, minorVersion: 20 },
  { machineName: 'H5P.MultiChoice', majorVersion: 1, minorVersion: 16 },
  { machineName: 'H5P.TrueFalse', majorVersion: 1, minorVersion: 8 },
  { machineName: 'H5P.SingleChoiceSet', majorVersion: 1, minorVersion: 11 },
  { machineName: 'H5P.DragText', majorVersion: 1, minorVersion: 10 },
  { machineName: 'H5P.Blanks', majorVersion: 1, minorVersion: 14 },
]);

const MC: H5pDependencyRef = { machineName: 'H5P.MultiChoice', majorVersion: 1, minorVersion: 16 };
const TF: H5pDependencyRef = { machineName: 'H5P.TrueFalse', majorVersion: 1, minorVersion: 8 };

/**
 * Sub-contenidos (campos `library` de semantics) que los builders de Cursia
 * insertan. `library.json` no los declara (son dinámicos según el contenido),
 * así que el perfil los agrega explícitamente como raíces de la clausura.
 */
export const CURSIA_H5P_CONTENT_LIBRARIES_V1: Readonly<Record<string, ReadonlyArray<H5pDependencyRef>>> = Object.freeze({
  'H5P.InteractiveVideo': [MC, TF],
  'H5P.QuestionSet': [MC, TF],
  'H5P.MultiChoice': [],
  'H5P.TrueFalse': [],
  'H5P.SingleChoiceSet': [],
  'H5P.DragText': [],
  'H5P.Blanks': [],
});

export function h5pLibraryDirName(ref: H5pDependencyRef): string {
  return `${ref.machineName}-${ref.majorVersion}.${ref.minorVersion}`;
}

export function h5pLibraryString(ref: H5pDependencyRef): string {
  return `${ref.machineName} ${ref.majorVersion}.${ref.minorVersion}`;
}

export function compareH5pRefs(a: H5pDependencyRef, b: H5pDependencyRef): number {
  if (a.machineName !== b.machineName) return a.machineName < b.machineName ? -1 : 1;
  if (a.majorVersion !== b.majorVersion) return a.majorVersion - b.majorVersion;
  return a.minorVersion - b.minorVersion;
}

function toRef(lib: H5pLibraryJson): H5pLibraryRef {
  return {
    machineName: lib.machineName,
    majorVersion: lib.majorVersion,
    minorVersion: lib.minorVersion,
    patchVersion: lib.patchVersion,
  };
}

function getLib(libraryJsons: Record<string, H5pLibraryJson>, dep: H5pDependencyRef, from: string): H5pLibraryJson {
  const dir = h5pLibraryDirName(dep);
  const lib = libraryJsons[dir];
  if (!lib) {
    throw new Error(`H5P_PROFILE_MISSING_LIBRARY: ${dir} (requerida por ${from})`);
  }
  if (
    lib.machineName !== dep.machineName ||
    lib.majorVersion !== dep.majorVersion ||
    lib.minorVersion !== dep.minorVersion ||
    !Number.isInteger(lib.patchVersion)
  ) {
    throw new Error(`H5P_PROFILE_BAD_LIBRARY_JSON: ${dir} no coincide con su library.json`);
  }
  return lib;
}

function closure(
  libraryJsons: Record<string, H5pLibraryJson>,
  roots: ReadonlyArray<H5pDependencyRef>,
  includeEditor: boolean,
): H5pLibraryRef[] {
  const seen = new Map<string, H5pLibraryRef>();
  const queue: Array<{ dep: H5pDependencyRef; from: string }> = roots.map((dep) => ({ dep, from: 'raíz del perfil' }));
  while (queue.length) {
    const { dep, from } = queue.shift();
    const dir = h5pLibraryDirName(dep);
    if (seen.has(dir)) continue;
    const lib = getLib(libraryJsons, dep, from);
    seen.set(dir, toRef(lib));
    const edges: H5pDependencyRef[] = [
      ...(lib.preloadedDependencies || []),
      ...(lib.dynamicDependencies || []),
      ...(includeEditor ? lib.editorDependencies || [] : []),
    ];
    for (const e of edges) queue.push({ dep: e, from: dir });
  }
  return [...seen.values()].sort(compareH5pRefs);
}

/** Calcula el perfil completo. Pura y determinística. */
export function computeH5pProfile(libraryJsons: Record<string, H5pLibraryJson>): H5pProfile {
  const mainLibraries: Record<string, H5pLibraryRef> = {};
  const contentLibrariesByMain: Record<string, H5pDependencyRef[]> = {};
  const closureByMain: Record<string, H5pMainClosure> = {};
  const union = new Map<string, H5pLibraryRef>();

  for (const main of CURSIA_H5P_MAIN_LIBRARIES_V1) {
    const lib = getLib(libraryJsons, main, 'CURSIA_H5P_MAIN_LIBRARIES_V1');
    mainLibraries[main.machineName] = toRef(lib);
    const contentLibs = (CURSIA_H5P_CONTENT_LIBRARIES_V1[main.machineName] || []).map((d) => ({ ...d }));
    contentLibrariesByMain[main.machineName] = contentLibs;
    const roots = [main, ...contentLibs];
    const runtime = closure(libraryJsons, roots, false);
    const full = closure(libraryJsons, roots, true);
    closureByMain[main.machineName] = { runtime, full };
    for (const r of full) union.set(h5pLibraryDirName(r), r);
  }

  return {
    profileId: CURSIA_H5P_PROFILE_ID_V1,
    version: 1,
    mainLibraries,
    contentLibrariesByMain,
    libraries: [...union.values()].sort(compareH5pRefs),
    closureByMain,
  };
}

/** Serialización canónica del perfil (la que se guarda en el JSON committed). */
export function serializeH5pProfile(profile: H5pProfile): string {
  return JSON.stringify(profile, null, 2) + '\n';
}
