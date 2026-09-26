// Cursia V2.1 / R7-core — preflight de librerías H5P (HD-V21-15, fail loud).
//
// Compara las librerías que exige el perfil contra las instaladas en un sitio
// Moodle (tabla mdl_h5p_libraries; ver scripts/moodle/h5p-installed-libraries.php).
// Compatible = mismo major.minor y patch instalado >= patch del perfil.
// Pura: sin DB, sin reloj.
import { H5pLibraryRef, H5pProfile } from './profile-generator';
import { compareH5pRefs, h5pLibraryDirName } from './profile-generator';

export interface H5pInstalledLibrary {
  machineName: string;
  majorVersion: number;
  minorVersion: number;
  patchVersion: number;
}

export interface H5pPreflightIncompatible {
  required: H5pLibraryRef;
  installedPatchVersion: number;
}

export interface H5pPreflightResult {
  ok: boolean;
  required: H5pLibraryRef[];
  missing: H5pLibraryRef[];
  incompatible: H5pPreflightIncompatible[];
  satisfied: H5pLibraryRef[];
}

export interface H5pPreflightOptions {
  /**
   * 'full' (default): runtime + editor — lo que instala el Cursia H5P Library
   * Pack; sin las librerías de editor el docente no puede editar el H5P.
   * 'runtime': solo lo necesario para reproducir y calificar.
   */
  scope?: 'full' | 'runtime';
}

function requiredLibraries(profile: H5pProfile, scope: 'full' | 'runtime'): H5pLibraryRef[] {
  if (scope === 'full') return profile.libraries.map((r) => ({ ...r }));
  const map = new Map<string, H5pLibraryRef>();
  for (const c of Object.values(profile.closureByMain)) {
    for (const r of c.runtime) map.set(h5pLibraryDirName(r), { ...r });
  }
  return [...map.values()].sort(compareH5pRefs);
}

function assertInstalledShape(installed: unknown): H5pInstalledLibrary[] {
  if (!Array.isArray(installed)) throw new Error('H5P_PREFLIGHT_BAD_INPUT: installed debe ser un array');
  return installed.map((x: any, i) => {
    if (
      !x ||
      typeof x.machineName !== 'string' ||
      ![x.majorVersion, x.minorVersion, x.patchVersion].every((n) => Number.isInteger(Number(n)))
    ) {
      throw new Error(`H5P_PREFLIGHT_BAD_INPUT: installed[${i}] inválido`);
    }
    return {
      machineName: x.machineName,
      majorVersion: Number(x.majorVersion),
      minorVersion: Number(x.minorVersion),
      patchVersion: Number(x.patchVersion),
    };
  });
}

export function h5pPreflight(
  profile: H5pProfile,
  installed: H5pInstalledLibrary[],
  options: H5pPreflightOptions = {},
): H5pPreflightResult {
  const scope = options.scope || 'full';
  const required = requiredLibraries(profile, scope);
  // Si un sitio tuviera varias filas del mismo major.minor, vale el patch más alto.
  const bestPatch = new Map<string, number>();
  for (const lib of assertInstalledShape(installed)) {
    const k = h5pLibraryDirName(lib);
    bestPatch.set(k, Math.max(bestPatch.get(k) ?? -1, lib.patchVersion));
  }
  const missing: H5pLibraryRef[] = [];
  const incompatible: H5pPreflightIncompatible[] = [];
  const satisfied: H5pLibraryRef[] = [];
  for (const req of required) {
    const patch = bestPatch.get(h5pLibraryDirName(req));
    if (patch === undefined) missing.push(req);
    else if (patch < req.patchVersion) incompatible.push({ required: req, installedPatchVersion: patch });
    else satisfied.push(req);
  }
  return { ok: missing.length === 0 && incompatible.length === 0, required, missing, incompatible, satisfied };
}

function fmt(r: H5pLibraryRef): string {
  return `${r.machineName}-${r.majorVersion}.${r.minorVersion}.${r.patchVersion}`;
}

/** Igual que h5pPreflight pero lanza `H5P_PREFLIGHT_FAILED: missing=[…] incompatible=[…]` si no pasa. */
export function assertH5pPreflight(
  profile: H5pProfile,
  installed: H5pInstalledLibrary[],
  options: H5pPreflightOptions = {},
): H5pPreflightResult {
  const r = h5pPreflight(profile, installed, options);
  if (!r.ok) {
    const missing = r.missing.map(fmt).join(', ');
    const incompatible = r.incompatible
      .map((x) => `${fmt(x.required)} (instalada .${x.installedPatchVersion})`)
      .join(', ');
    throw new Error(`H5P_PREFLIGHT_FAILED: missing=[${missing}] incompatible=[${incompatible}]`);
  }
  return r;
}
