// Cursia V2.1 / R7-core — CURSIA_H5P_PROFILE_V1: versiones exactas certificadas
// de las librerías H5P que usan los builders de Cursia, más su clausura de
// dependencias. El JSON se genera con `scripts/generate-h5p-profile.js <libsDir>`
// (nunca a mano) y se versiona junto al código.
import * as profileJson from './cursia-h5p-profile.v1.json';
import * as profileV2Json from './cursia-h5p-profile.v2.json';
import * as profileV3Json from './cursia-h5p-profile.v3.json';
import {
  H5pDependencyRef,
  H5pLibraryRef,
  H5pProfile,
  h5pLibraryDirName,
  h5pLibraryString,
} from './profile-generator';

/** Versión del perfil H5P; entra en la derivación de cada `subContentId`. */
export const h5pProfileVersion = 1;

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object') {
    Object.freeze(o);
    for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v);
  }
  return o;
}

function stripModuleDefault(raw: any): H5pProfile {
  // `import * as` de un JSON puede traer una propiedad `default` sintética.
  // EV6 H5P v2: baseProfileId/deltaByMain solo existen en perfiles derivados (v1 queda igual).
  const { profileId, version, mainLibraries, contentLibrariesByMain, libraries, closureByMain, baseProfileId, deltaByMain } = raw;
  return JSON.parse(
    JSON.stringify({ profileId, version, mainLibraries, contentLibrariesByMain, libraries, closureByMain, baseProfileId, deltaByMain }),
  );
}

export const CURSIA_H5P_PROFILE_V1: H5pProfile = deepFreeze(stripModuleDefault(profileJson));

if (CURSIA_H5P_PROFILE_V1.version !== h5pProfileVersion || CURSIA_H5P_PROFILE_V1.profileId !== 'CURSIA_H5P_PROFILE_V1') {
  throw new Error('H5P_PROFILE_CORRUPT: cursia-h5p-profile.v1.json no corresponde a CURSIA_H5P_PROFILE_V1');
}

/**
 * EV6 H5P v2 — CURSIA_H5P_PROFILE_V2 = v1 ∪ Branching Scenario 1.10 + Dialog Cards 1.9
 * (`cursia-h5p-profile.v2.json`, generado con `scripts/generate-h5p-profile.js <libsDir> --profile v2`).
 * Los tipos nuevos derivan sus subContentId con `h5pProfileVersionV2` (`#p2`); los tipos de v1
 * siguen con `h5pProfileVersion` = 1 (bytes idénticos).
 */
export const h5pProfileVersionV2 = 2;

export const CURSIA_H5P_PROFILE_V2: H5pProfile = deepFreeze(stripModuleDefault(profileV2Json));

if (
  CURSIA_H5P_PROFILE_V2.version !== h5pProfileVersionV2 ||
  CURSIA_H5P_PROFILE_V2.profileId !== 'CURSIA_H5P_PROFILE_V2' ||
  CURSIA_H5P_PROFILE_V2.baseProfileId !== CURSIA_H5P_PROFILE_V1.profileId ||
  !CURSIA_H5P_PROFILE_V2.deltaByMain
) {
  throw new Error('H5P_PROFILE_CORRUPT: cursia-h5p-profile.v2.json no corresponde a CURSIA_H5P_PROFILE_V2');
}

/**
 * UX #5 (r18) — CURSIA_H5P_PROFILE_V3 = v2 con H5P.QuestionSet 1.21 (navegación «Siguiente ›» /
 * «Anterior» compatible con el tema de H5P.Question 1.5; en 1.20 era un botón vacío). Base v1: el
 * `.h5p` de QuestionSet lleva su delta (la carpeta H5P.QuestionSet-1.21), igual que BS y DC.
 * Es el perfil de los paquetes NUEVOS del builder v3. Los subContentId no cambian (v1 / `#p2`).
 */
export const h5pProfileVersionV3 = 3;

export const CURSIA_H5P_PROFILE_V3: H5pProfile = deepFreeze(stripModuleDefault(profileV3Json));

if (
  CURSIA_H5P_PROFILE_V3.version !== h5pProfileVersionV3 ||
  CURSIA_H5P_PROFILE_V3.profileId !== 'CURSIA_H5P_PROFILE_V3' ||
  CURSIA_H5P_PROFILE_V3.baseProfileId !== CURSIA_H5P_PROFILE_V1.profileId ||
  !CURSIA_H5P_PROFILE_V3.deltaByMain
) {
  throw new Error('H5P_PROFILE_CORRUPT: cursia-h5p-profile.v3.json no corresponde a CURSIA_H5P_PROFILE_V3');
}

/** Principales cuyo `.h5p` lleva sus librerías delta adentro (buildBundledH5p). */
export function profileBundledMainLibraries(profile: H5pProfile): string[] {
  return Object.keys(profile.deltaByMain || {}).sort();
}

/** Carpetas delta (`Machine-maj.min`) de una principal nueva; falla fuerte si la principal no es bundled. */
export function profileDeltaDirs(profile: H5pProfile, machineName: string): string[] {
  const d = profile.deltaByMain && profile.deltaByMain[machineName];
  if (!d) throw new Error(`H5P_PROFILE_NOT_BUNDLED_MAIN: ${machineName} no tiene delta en ${profile.profileId}`);
  return d.map(h5pLibraryDirName).sort();
}

/** Referencia exacta (con patch) de una librería principal del perfil. Falla fuerte si no existe. */
export function profileMainLibrary(profile: H5pProfile, machineName: string): H5pLibraryRef {
  const ref = profile.mainLibraries[machineName];
  if (!ref) throw new Error(`H5P_PROFILE_UNKNOWN_MAIN_LIBRARY: ${machineName} no está en ${profile.profileId}`);
  return ref;
}

/** "H5P.MultiChoice 1.16" — forma usada en el campo `library` de los sub-contenidos. */
export function profileLibraryString(profile: H5pProfile, machineName: string): string {
  return h5pLibraryString(profileMainLibrary(profile, machineName));
}

/** Dependencias de runtime (preloaded + dynamic + sub-contenidos) de una librería principal. */
export function profileRuntimeDependencies(profile: H5pProfile, machineName: string): H5pLibraryRef[] {
  profileMainLibrary(profile, machineName);
  return profile.closureByMain[machineName].runtime.map((r) => ({ ...r }));
}

/** Clausura completa (runtime + editor) de una librería principal. */
export function profileFullDependencies(profile: H5pProfile, machineName: string): H5pLibraryRef[] {
  profileMainLibrary(profile, machineName);
  return profile.closureByMain[machineName].full.map((r) => ({ ...r }));
}

export type { H5pDependencyRef, H5pLibraryRef, H5pProfile };
export { h5pLibraryDirName, h5pLibraryString };
