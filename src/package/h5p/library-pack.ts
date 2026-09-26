// Cursia V2.1 / R7-core — Cursia H5P Library Pack (HD-V21-15).
//
// Un `.h5p` autocontenido por librería principal del perfil (runtime + editor),
// con un contenido mínimo y neutro en español. Un admin lo sube UNA vez por
// sitio; después los paquetes solo-contenido de Cursia despliegan aunque quien
// restaure sea un docente (R0: un docente no puede instalar librerías).
//
// Los binarios del pack son salida de build (no se versionan). Ver
// `scripts/build-h5p-library-pack.js` y `README-library-pack.md`.
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { CURSIA_H5P_PROFILE_V1, h5pProfileVersion } from './profile';
import { H5pLibraryRef, H5pProfile, h5pLibraryDirName } from './profile-generator';
import { buildSelfContainedH5p, sha256Hex } from './package';
import { H5pBuiltContent, buildChoiceSubContent } from './types/common';
import { buildQuestionSet } from './types/question-set';
import { buildSingleChoiceSet } from './types/single-choice-set';
import { buildDragText } from './types/drag-text';
import { buildBlanks } from './types/blanks';
import { buildInteractiveVideo } from './types/interactive-video';

const PACK_ITEM_KEY = 'cursia-h5p-library-pack';
/** Video público y neutro (Big Buck Bunny, Blender Foundation, CC-BY) solo para el contenido de instalación. */
const PACK_SAMPLE_YOUTUBE_ID = 'aqz-KE-bpKQ';

/** Contenido mínimo y neutro para el paquete de instalación de `mainLibrary`. Puro. */
export function libraryPackSampleContent(mainLibrary: string): H5pBuiltContent {
  const title = 'Cursia: instalación de tipos de contenido H5P';
  const mc = {
    kind: 'multichoice' as const,
    question: '¿Este paquete instala los tipos de contenido H5P de Cursia?',
    answers: [
      { text: 'Sí', correct: true },
      { text: 'No', correct: false },
      { text: 'No lo sé', correct: false },
    ],
  };
  const tf = { kind: 'truefalse' as const, question: 'Este contenido es solo de instalación.', correct: true };
  switch (mainLibrary) {
    case 'H5P.QuestionSet':
      return buildQuestionSet({ itemKey: PACK_ITEM_KEY, title, questions: [mc, tf], passPercentage: 70 });
    case 'H5P.SingleChoiceSet':
      return buildSingleChoiceSet({
        itemKey: PACK_ITEM_KEY,
        title,
        passPercentage: 70,
        questions: [
          { question: '¿Este contenido es de instalación?', answers: [{ text: 'Sí', correct: true }, { text: 'No', correct: false }] },
          { question: '¿Se sube una sola vez por sitio?', answers: [{ text: 'Sí', correct: true }, { text: 'No', correct: false }] },
        ],
      });
    case 'H5P.DragText':
      return buildDragText({
        itemKey: PACK_ITEM_KEY,
        title,
        taskDescription: 'Arrastra las palabras al lugar correcto.',
        text: 'Un *administrador* instala este paquete una sola *vez* por sitio.',
      });
    case 'H5P.Blanks':
      return buildBlanks({
        itemKey: PACK_ITEM_KEY,
        title,
        text: 'Completa las frases.',
        questions: ['Este paquete lo instala un *administrador/admin*.', 'Se instala una sola *vez*.'],
      });
    case 'H5P.InteractiveVideo':
      return buildInteractiveVideo({
        itemKey: PACK_ITEM_KEY,
        title,
        youtubeId: PACK_SAMPLE_YOUTUBE_ID,
        durationSec: 596,
        interactions: [
          { ...mc, atSec: 30 },
          { ...tf, atSec: 60 },
          { ...mc, atSec: 90, question: '¿Hace falta instalarlo de nuevo en cada curso?', answers: [
            { text: 'No', correct: true }, { text: 'Sí', correct: false }, { text: 'Solo a veces', correct: false },
          ] },
        ],
      });
    case 'H5P.MultiChoice':
    case 'H5P.TrueFalse': {
      const sub = buildChoiceSubContent(mainLibrary === 'H5P.MultiChoice' ? mc : tf, PACK_ITEM_KEY, 0, title);
      return { mainLibrary, title, content: sub.params, subContentIds: [], maxScore: 1 };
    }
    default:
      throw new Error(`H5P_PACK_UNKNOWN_MAIN_LIBRARY: ${mainLibrary}`);
  }
}

function listFilesSorted(root: string, rel = ''): string[] {
  const out: string[] = [];
  for (const name of fs.readdirSync(path.join(root, rel)).sort()) {
    if (name.startsWith('.')) continue; // .DS_Store y similares nunca van al paquete
    const r = rel ? `${rel}/${name}` : name;
    const st = fs.statSync(path.join(root, r));
    if (st.isDirectory()) out.push(...listFilesSorted(root, r));
    else if (st.isFile()) out.push(r);
  }
  return out;
}

/** sha256 de una carpeta de librería: sobre las líneas ordenadas "ruta\0sha256(archivo)". */
export function libraryFolderHash(files: Record<string, Buffer>): string {
  const h = createHash('sha256');
  for (const p of Object.keys(files).sort()) h.update(`${p}\0${sha256Hex(files[p])}\n`);
  return h.digest('hex');
}

export interface LibraryPackManifestEntry {
  file: string;
  mainLibrary: H5pLibraryRef;
  bytes: number;
  sha256: string;
  libraries: string[];
}

export interface LibraryPackManifest {
  packId: string;
  profileId: string;
  h5pProfileVersion: number;
  packages: LibraryPackManifestEntry[];
  libraries: Array<H5pLibraryRef & { folderSha256: string; files: number }>;
}

export function libraryPackFileName(ref: H5pLibraryRef): string {
  return `cursia-h5p-pack-v${h5pProfileVersion}-${ref.machineName}-${ref.majorVersion}.${ref.minorVersion}.${ref.patchVersion}.h5p`;
}

/**
 * Construye el pack en `outDir` desde una carpeta de librerías (`<libsDir>/<Machine-maj.min>/…`).
 * Falla fuerte si falta una librería o si su patch no es exactamente el del perfil.
 */
export async function buildCursiaH5pLibraryPack(opts: {
  libsDir: string;
  outDir: string;
  profile?: H5pProfile;
}): Promise<LibraryPackManifest> {
  const profile = opts.profile || CURSIA_H5P_PROFILE_V1;
  const libFiles: Record<string, Record<string, Buffer>> = {};
  const libraries: LibraryPackManifest['libraries'] = [];
  for (const ref of profile.libraries) {
    const dir = h5pLibraryDirName(ref);
    const abs = path.join(opts.libsDir, dir);
    if (!fs.existsSync(path.join(abs, 'library.json'))) throw new Error(`H5P_PACK_MISSING_LIBRARY: ${dir} en ${opts.libsDir}`);
    const lj = JSON.parse(fs.readFileSync(path.join(abs, 'library.json'), 'utf8'));
    if (lj.patchVersion !== ref.patchVersion) {
      throw new Error(`H5P_PACK_PATCH_MISMATCH: ${dir} tiene .${lj.patchVersion}, el perfil exige .${ref.patchVersion}`);
    }
    const files: Record<string, Buffer> = {};
    for (const r of listFilesSorted(abs)) files[r] = fs.readFileSync(path.join(abs, r));
    libFiles[dir] = files;
    libraries.push({ ...ref, folderSha256: libraryFolderHash(files), files: Object.keys(files).length });
  }

  fs.mkdirSync(opts.outDir, { recursive: true });
  const packages: LibraryPackManifestEntry[] = [];
  for (const machineName of Object.keys(profile.mainLibraries).sort()) {
    const mainRef = profile.mainLibraries[machineName];
    const sample = libraryPackSampleContent(machineName);
    const libraryFiles: Record<string, Buffer> = {};
    const dirs = profile.closureByMain[machineName].full.map(h5pLibraryDirName);
    for (const dir of dirs) {
      for (const [r, data] of Object.entries(libFiles[dir])) libraryFiles[`${dir}/${r}`] = data;
    }
    const buf = await buildSelfContainedH5p({
      mainLibrary: machineName,
      content: sample.content,
      title: sample.title,
      language: 'es',
      profile,
      libraryFiles,
    });
    const file = libraryPackFileName(mainRef);
    fs.writeFileSync(path.join(opts.outDir, file), buf);
    packages.push({ file, mainLibrary: { ...mainRef }, bytes: buf.length, sha256: sha256Hex(buf), libraries: dirs });
  }

  const manifest: LibraryPackManifest = {
    packId: `CURSIA_H5P_LIBRARY_PACK_V${h5pProfileVersion}`,
    profileId: profile.profileId,
    h5pProfileVersion,
    packages,
    libraries,
  };
  fs.writeFileSync(path.join(opts.outDir, 'cursia-h5p-library-pack.manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}
