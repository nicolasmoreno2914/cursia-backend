// EV6 H5P v2 — store versionado de librerías H5P (assets/h5p-libs/v2).
//
// Las carpetas delta de CURSIA_H5P_PROFILE_V2 (librerías que el sitio con v1 no
// tiene) viven en el repo, con `manifest.json` (sha256 por archivo, versión
// upstream, licencia, repo) y `LICENSES.md`. `buildBundledH5p` las copia dentro
// del `.h5p`. Nada se descarga en build ni en runtime: si falta un archivo o su
// sha256 no coincide, falla fuerte (H5P_PACKAGE_MISSING_LIBRARY_FILES).
//
// Se sincroniza con `scripts/sync-h5p-library-store-v2.js <libsDir>`.
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { H5pProfile, serializeH5pProfile } from './profile-generator';

/** `<repo>/assets/h5p-libs/v2` (igual desde src/ con ts-node que desde dist/). */
export const H5P_LIBRARY_STORE_V2_DIR = path.resolve(__dirname, '../../../assets/h5p-libs/v2');

export interface H5pLibraryStoreFile {
  path: string;
  bytes: number;
  sha256: string;
}

export interface H5pLibraryStoreEntry {
  dir: string;
  machineName: string;
  majorVersion: number;
  minorVersion: number;
  patchVersion: number;
  upstreamVersion: string;
  author: string | null;
  licence: string;
  licenceSource: string;
  repoUrl: string;
  libraryJsonLicense: string | null;
  localLicenceFile: string | null;
  copyrightHolder: string;
  fileCount: number;
  totalBytes: number;
  files: H5pLibraryStoreFile[];
}

export interface H5pLibraryStoreManifest {
  storeVersion: number;
  profileId: string;
  baseProfileId: string;
  profileSha256: string;
  source: string;
  provenance: string;
  deltaByMain: Record<string, string[]>;
  libraries: H5pLibraryStoreEntry[];
}

/** Lo que necesita buildBundledH5p: archivos de una carpeta de librería (ruta relativa → bytes) o null si no está. */
export interface H5pLibrarySource {
  readonly profileId: string;
  libraryFiles(dir: string): Record<string, Buffer> | null;
}

const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

/**
 * Abre el store y verifica que el manifest corresponda al perfil (sha del JSON
 * canónico). Los archivos se leen y verifican (sha256) al pedir cada librería;
 * el resultado se memoiza por carpeta.
 */
export function openH5pLibraryStore(profile: H5pProfile, dir: string = H5P_LIBRARY_STORE_V2_DIR): H5pLibrarySource & { manifest: H5pLibraryStoreManifest } {
  const mp = path.join(dir, 'manifest.json');
  if (!fs.existsSync(mp)) throw new Error(`H5P_PACKAGE_MISSING_LIBRARY_FILES: no existe ${mp}`);
  const manifest = JSON.parse(fs.readFileSync(mp, 'utf8')) as H5pLibraryStoreManifest;
  if (manifest.profileId !== profile.profileId) {
    throw new Error(`H5P_STORE_PROFILE_MISMATCH: el store es de ${manifest.profileId}, se pidió ${profile.profileId}`);
  }
  const want = sha256(Buffer.from(serializeH5pProfile(profile), 'utf8'));
  if (manifest.profileSha256 !== want) {
    throw new Error(`H5P_STORE_PROFILE_MISMATCH: manifest.profileSha256 ${manifest.profileSha256} ≠ ${want} (regenera el store)`);
  }
  const byDir = new Map(manifest.libraries.map((l) => [l.dir, l]));
  const memo = new Map<string, Record<string, Buffer>>();
  return {
    profileId: manifest.profileId,
    manifest,
    libraryFiles(libDir: string): Record<string, Buffer> | null {
      const hit = memo.get(libDir);
      if (hit) return hit;
      const entry = byDir.get(libDir);
      if (!entry) return null;
      if (!fs.existsSync(path.join(dir, libDir))) throw new Error(`H5P_PACKAGE_MISSING_LIBRARY_FILES: ${libDir}/ (carpeta faltante)`);
      const out: Record<string, Buffer> = {};
      const bad: string[] = [];
      for (const f of entry.files) {
        const fp = path.join(dir, libDir, f.path);
        if (!fs.existsSync(fp)) {
          bad.push(`${libDir}/${f.path} (falta)`);
          continue;
        }
        const buf = fs.readFileSync(fp);
        if (buf.length !== f.bytes || sha256(buf) !== f.sha256) bad.push(`${libDir}/${f.path} (sha256 distinto)`);
        else out[f.path] = buf;
      }
      if (bad.length) throw new Error(`H5P_PACKAGE_MISSING_LIBRARY_FILES: ${bad.slice(0, 10).join(', ')}${bad.length > 10 ? ` (+${bad.length - 10})` : ''}`);
      memo.set(libDir, out);
      return out;
    },
  };
}
