// Cursia V2.1 / R7-core — CURSIA_H5P_PROFILE_V1: versiones exactas certificadas
// de las librerías H5P que usan los builders de Cursia, más su clausura de
// dependencias. El JSON se genera con `scripts/generate-h5p-profile.js <libsDir>`
// (nunca a mano) y se versiona junto al código.
import * as profileJson from './cursia-h5p-profile.v1.json';
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
  const { profileId, version, mainLibraries, contentLibrariesByMain, libraries, closureByMain } = raw;
  return JSON.parse(
    JSON.stringify({ profileId, version, mainLibraries, contentLibrariesByMain, libraries, closureByMain }),
  );
}

export const CURSIA_H5P_PROFILE_V1: H5pProfile = deepFreeze(stripModuleDefault(profileJson));

if (CURSIA_H5P_PROFILE_V1.version !== h5pProfileVersion || CURSIA_H5P_PROFILE_V1.profileId !== 'CURSIA_H5P_PROFILE_V1') {
  throw new Error('H5P_PROFILE_CORRUPT: cursia-h5p-profile.v1.json no corresponde a CURSIA_H5P_PROFILE_V1');
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
