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
  /**
   * EV6 H5P v2 — solo en perfiles derivados (v2): perfil base que el sitio ya
   * tiene (preflight de v1) y, por librería principal NUEVA, la "delta" =
   * clausura full − librerías del base. Esas carpetas viajan dentro del `.h5p`
   * (buildBundledH5p). Ausente en v1 (su JSON no cambia).
   */
  baseProfileId?: string;
  deltaByMain?: Record<string, H5pLibraryRef[]>;
}

/** Especificación (congelada) de un perfil: principales certificadas + sub-contenidos que inserta Cursia. */
export interface H5pProfileSpec {
  profileId: string;
  version: number;
  mainLibraries: ReadonlyArray<H5pDependencyRef>;
  contentLibrariesByMain: Readonly<Record<string, ReadonlyArray<H5pDependencyRef>>>;
  /** Perfil base (solo perfiles derivados): las principales que NO están en el base llevan `deltaByMain`. */
  base?: H5pProfileSpec;
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

export const CURSIA_H5P_PROFILE_SPEC_V1: H5pProfileSpec = Object.freeze({
  profileId: CURSIA_H5P_PROFILE_ID_V1,
  version: 1,
  mainLibraries: CURSIA_H5P_MAIN_LIBRARIES_V1,
  contentLibrariesByMain: CURSIA_H5P_CONTENT_LIBRARIES_V1,
});

// ── EV6 H5P v2 (rulings 2026-10-01: Branching Scenario 1.10 pineado, Dialog Cards 1.9) ──

export const CURSIA_H5P_PROFILE_ID_V2 = 'CURSIA_H5P_PROFILE_V2';

/** Principales NUEVAS de v2 (además de las 7 de v1, que no cambian). */
export const CURSIA_H5P_NEW_MAIN_LIBRARIES_V2: ReadonlyArray<H5pDependencyRef> = Object.freeze([
  { machineName: 'H5P.BranchingScenario', majorVersion: 1, minorVersion: 10 },
  { machineName: 'H5P.Dialogcards', majorVersion: 1, minorVersion: 9 },
]);

export const CURSIA_H5P_PROFILE_SPEC_V2: H5pProfileSpec = Object.freeze({
  profileId: CURSIA_H5P_PROFILE_ID_V2,
  version: 2,
  mainLibraries: Object.freeze([...CURSIA_H5P_MAIN_LIBRARIES_V1, ...CURSIA_H5P_NEW_MAIN_LIBRARIES_V2]),
  contentLibrariesByMain: Object.freeze({
    ...CURSIA_H5P_CONTENT_LIBRARIES_V1,
    // Nodo 0 (situación) = AdvancedText; decisiones = BranchingQuestion. Nada más (sin CP/IV/Image dentro del caso).
    'H5P.BranchingScenario': Object.freeze([
      { machineName: 'H5P.BranchingQuestion', majorVersion: 1, minorVersion: 0 },
      { machineName: 'H5P.AdvancedText', majorVersion: 1, minorVersion: 1 },
    ]),
    'H5P.Dialogcards': Object.freeze([]),
  }),
  base: CURSIA_H5P_PROFILE_SPEC_V1,
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

/**
 * Calcula el perfil completo. Pura y determinística. Sin `spec` = CURSIA_H5P_PROFILE_V1
 * (salida byte-idéntica a la de siempre). Con un spec derivado (v2) agrega
 * `baseProfileId` y `deltaByMain` (clausura full de cada principal nueva − librerías del base).
 */
export function computeH5pProfile(libraryJsons: Record<string, H5pLibraryJson>, spec: H5pProfileSpec = CURSIA_H5P_PROFILE_SPEC_V1): H5pProfile {
  const mainLibraries: Record<string, H5pLibraryRef> = {};
  const contentLibrariesByMain: Record<string, H5pDependencyRef[]> = {};
  const closureByMain: Record<string, H5pMainClosure> = {};
  const union = new Map<string, H5pLibraryRef>();
  const listName = spec.profileId === CURSIA_H5P_PROFILE_ID_V1 ? 'CURSIA_H5P_MAIN_LIBRARIES_V1' : `${spec.profileId}.mainLibraries`;

  for (const main of spec.mainLibraries) {
    const lib = getLib(libraryJsons, main, listName);
    mainLibraries[main.machineName] = toRef(lib);
    const contentLibs = (spec.contentLibrariesByMain[main.machineName] || []).map((d) => ({ ...d }));
    contentLibrariesByMain[main.machineName] = contentLibs;
    const roots = [main, ...contentLibs];
    const runtime = closure(libraryJsons, roots, false);
    const full = closure(libraryJsons, roots, true);
    closureByMain[main.machineName] = { runtime, full };
    for (const r of full) union.set(h5pLibraryDirName(r), r);
  }

  const profile: H5pProfile = {
    profileId: spec.profileId,
    version: spec.version,
    mainLibraries,
    contentLibrariesByMain,
    libraries: [...union.values()].sort(compareH5pRefs),
    closureByMain,
  };
  if (!spec.base) return profile;

  const base = computeH5pProfile(libraryJsons, spec.base);
  const baseDirs = new Map(base.libraries.map((r) => [h5pLibraryDirName(r), r]));
  for (const r of profile.libraries) {
    const b = baseDirs.get(h5pLibraryDirName(r));
    if (b && b.patchVersion !== r.patchVersion) {
      throw new Error(`H5P_PROFILE_BASE_MISMATCH: ${h5pLibraryDirName(r)} patch ${r.patchVersion} ≠ ${b.patchVersion} del perfil base`);
    }
  }
  for (const k of Object.keys(base.mainLibraries)) {
    if (!profile.mainLibraries[k]) throw new Error(`H5P_PROFILE_BASE_MISMATCH: ${spec.profileId} no incluye la principal ${k} del perfil base`);
  }
  const deltaByMain: Record<string, H5pLibraryRef[]> = {};
  for (const main of spec.mainLibraries) {
    if (base.mainLibraries[main.machineName]) continue;
    deltaByMain[main.machineName] = closureByMain[main.machineName].full.filter((r) => !baseDirs.has(h5pLibraryDirName(r)));
  }
  return { ...profile, baseProfileId: base.profileId, deltaByMain };
}

/** Serialización canónica del perfil (la que se guarda en el JSON committed). */
export function serializeH5pProfile(profile: H5pProfile): string {
  return JSON.stringify(profile, null, 2) + '\n';
}
