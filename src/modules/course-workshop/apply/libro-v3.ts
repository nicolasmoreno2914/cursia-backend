/**
 * r107 B6 · Taller de cursos — Libro v3 (PDF): regenerarlo con el BUILDER EXISTENTE aplicando el cambio del plan.
 *
 * El PDF del Libro v3 lo arma `renderLibroPdfV3` dentro de `buildDynamicMbzV3` con mucho más que el markdown por
 * capítulo: tema, introducciones del curso y de cada módulo, prácticas guiadas, logo y nombre de la institución,
 * referencias del programa, la clave del documento (sha del plan) y la reparación de vocabulario interno. Por eso la
 * regla es de SEGURIDAD, no de confianza:
 *   1. con la entrada del builder que se reconstruyó para el curso, SIN cambios, el builder tiene que REPRODUCIR byte a
 *      byte el PDF que trae el original; si no, la fuente no es la de este paquete → `unavailable` con el motivo
 *      (nunca un Libro distinto del que el docente tiene, ni uno a medias);
 *   2. recién entonces se arma con el markdown nuevo de los capítulos pedidos y se toma SOLO el PDF (el resto del
 *      paquete nuevo lo hace el motor de parches sobre el original: `edit_libro_section` con `pdf`).
 * La IA nunca escribe el PDF: el markdown del capítulo llega por las aprobaciones de B5; renderizar no gasta.
 *
 * Fuente: `LibroV3SourceResolver` (la entrada del builder del curso identificado, verificando dueño y alcance como
 * B2). En este bloque el resolvedor del servidor NO reconstruye todavía esa entrada desde la base (ver B6-report,
 * riesgos): responde `unavailable` y el ítem sigue como hoy. Lo puro de acá está probado con la entrada real del motor
 * de la simulación comercial (check-r107-apply --ci, A12).
 */
import { createHash } from 'crypto';
import { openMbz } from '../mbz-reader';
import { builderLineOf, familyOf, readPackageFacts } from '../identify';
import { buildInventory } from '../inventory';
import type { BuildDynamicMbzV3Input } from '../../../package/dynamic-mbz-builder-v3';

const sha1 = (b: Buffer) => createHash('sha1').update(b).digest('hex');

export interface LibroV3Source {
  /** Entrada COMPLETA del builder v3 del curso (la misma con la que se armó el paquete original). */
  buildInput: BuildDynamicMbzV3Input;
  /** Número de capítulo del curso → chapterId del builder (clave de `contents.contentMd`). */
  chapterIdByNumber: Map<number, string>;
}

export interface LibroV3SourceResolver {
  resolve(session: { id: string; ownerId: string; institutionId: string | null; identifiedCourseId: number | null }): Promise<LibroV3Source | { unavailable: string }>;
}

/** Resolvedor del servidor en B6: todavía no reconstruye la entrada del builder desde la base (motivo visible). */
export const SERVER_LIBRO_V3_RESOLVER: LibroV3SourceResolver = {
  async resolve() {
    return { unavailable: 'El Libro Guía en PDF (builder v3) todavía no se puede regenerar en este entorno: hace falta reconstruir la entrada completa del builder del curso (tema, introducciones, logo, referencias), no solo el texto de los capítulos.' };
  },
};

/** PDF del Libro (recurso `libro`) dentro de un paquete: sha1 + bytes. null si el paquete no trae un Libro en PDF. */
export async function libroPdfOf(pkgBytes: Buffer): Promise<{ sha1: string; bytes: Buffer; moduleId: number } | null> {
  const pkg = await openMbz(pkgBytes);
  const facts = await readPackageFacts(pkg, null);
  const inv = await buildInventory(pkg, { family: familyOf(facts), builderLine: builderLineOf(facts) });
  const a = inv.activities.find((x) => x.kind === 'libro' && x.modname === 'resource');
  const f = a?.files.find((x) => x.filearea === 'content' && /\.pdf$/i.test(x.filename));
  if (!a || !f) return null;
  const entry = `files/${f.contenthash.slice(0, 2)}/${f.contenthash}`;
  if (!pkg.has(entry)) return null;
  const bytes = await pkg.readEntry(entry);
  return { sha1: sha1(bytes), bytes, moduleId: a.moduleId };
}

export type LibroV3Regenerated =
  | { ok: true; pdf: Buffer; sha1: string; previousSha1: string; moduleId: number; chapters: number[] }
  | { ok: false; code: 'no_pdf' | 'not_reproducible' | 'chapter_unknown' | 'build_failed'; reason: string };

/**
 * Regla 1 + 2 de arriba. `build` = `buildDynamicMbzV3` (inyectable en pruebas). No toca el original.
 */
export async function regenerateLibroV3Pdf(
  original: Buffer,
  src: LibroV3Source,
  chapters: Array<{ number: number; md: string }>,
  build: (i: BuildDynamicMbzV3Input) => Promise<{ mbz: Buffer }>,
): Promise<LibroV3Regenerated> {
  const cur = await libroPdfOf(original);
  if (!cur) return { ok: false, code: 'no_pdf', reason: 'El paquete no trae el Libro Guía en PDF.' };
  for (const c of chapters) {
    if (!src.chapterIdByNumber.has(c.number)) return { ok: false, code: 'chapter_unknown', reason: `El capítulo ${c.number} no está en la fuente del curso.` };
    if (typeof c.md !== 'string' || !c.md.trim()) return { ok: false, code: 'chapter_unknown', reason: `El capítulo ${c.number} llegó sin texto.` };
  }
  let same: { mbz: Buffer };
  try {
    same = await build(src.buildInput);
  } catch (e) {
    return { ok: false, code: 'build_failed', reason: `El builder no pudo rearmar el curso con su fuente: ${e instanceof Error ? e.message.slice(0, 300) : String(e)}` };
  }
  const rep = await libroPdfOf(same.mbz);
  if (!rep || rep.sha1 !== cur.sha1) {
    return { ok: false, code: 'not_reproducible', reason: 'Con la fuente guardada el builder no reproduce exactamente el Libro de este paquete (otro tema, otro logo o una versión anterior del texto): no se regenera para no entregar un Libro distinto del que tienes.' };
  }
  const contentMd = new Map(src.buildInput.contents.contentMd);
  for (const c of chapters) contentMd.set(src.chapterIdByNumber.get(c.number) as string, c.md);
  let next: { mbz: Buffer };
  try {
    next = await build({ ...src.buildInput, contents: { ...src.buildInput.contents, contentMd } });
  } catch (e) {
    return { ok: false, code: 'build_failed', reason: `El builder no pudo armar el Libro con el texto nuevo: ${e instanceof Error ? e.message.slice(0, 300) : String(e)}` };
  }
  const out = await libroPdfOf(next.mbz);
  if (!out) return { ok: false, code: 'build_failed', reason: 'El builder no produjo el Libro en PDF.' };
  return { ok: true, pdf: out.bytes, sha1: out.sha1, previousSha1: cur.sha1, moduleId: cur.moduleId, chapters: chapters.map((c) => c.number) };
}
