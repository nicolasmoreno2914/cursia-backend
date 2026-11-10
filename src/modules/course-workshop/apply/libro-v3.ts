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
import type { DataSource } from 'typeorm';
import type { ArtifactsService } from '../../artifacts/artifacts.service';
import type { GenerationManifestsService } from '../../generation-manifests/generation-manifests.service';
import type { CourseBlueprintsService } from '../../course-blueprints/course-blueprints.service';
import type { BlueprintSnapshotV2 } from '../../course-blueprints/blueprint-snapshot';
import { artifactsServiceLoadersV3, prepareV3Package } from '../../dynamic-packaging/packaging-v3';
import { composeV3BuildInput } from '../../dynamic-packaging/compose-v3-build-input';
import { DEFAULT_DYNAMIC_MOODLE_VERSION } from '../../dynamic-packaging/packaging-reuse-key';

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

/** Sin dependencias de la base (pruebas / proceso sin los servicios del generador): no disponible, con motivo. */
export const SERVER_LIBRO_V3_RESOLVER: LibroV3SourceResolver = {
  async resolve() {
    return { unavailable: 'El Libro Guía en PDF (builder v3) no se puede regenerar en este proceso: faltan los servicios del generador para reconstruir la entrada completa del builder del curso.' };
  },
};

/** Servicios del generador que necesita el resolvedor (los mismos que usa el dynamic-package-worker). */
export interface LibroV3ResolverDeps {
  dataSource: Pick<DataSource, 'query'>;
  artifacts: ArtifactsService;
  manifests: Pick<GenerationManifestsService, 'getById'>;
  blueprints: Pick<CourseBlueprintsService, 'getByNumberAnySchema'>;
}

/**
 * r107 B10 · resolvedor del SERVIDOR: reconstruye la entrada COMPLETA del builder v3 del curso identificado con la MISMA
 * composición que el empaquetado (`prepareV3Package` + `composeV3BuildInput`, compartida con el dynamic-package-worker):
 *   1. el paquete se identificó por su HUELLA EXACTA (`identification.result.matchedArtifactId`, un `dynamic_mbz` final);
 *   2. ese artifact, su job de empaquetado (runId, Manifest, Blueprint) y el curso son del MISMO dueño y están en el
 *      alcance de la sesión (institución o dueño, como B2);
 *   3. la entrada se arma tal cual la armó el worker; el reloj (`ts`) lo pone `regenerateLibroV3Pdf` desde el original.
 * La compuerta de reproducción de `regenerateLibroV3Pdf` (mismo PDF byte a byte) decide si la fuente sirve: una
 * reconstrucción imperfecta nunca entrega un Libro distinto.
 */
export function serverLibroV3Resolver(d: LibroV3ResolverDeps): LibroV3SourceResolver {
  return {
    async resolve(session) {
      const no = (why: string) => ({ unavailable: `El Libro Guía en PDF no se puede regenerar: ${why}` });
      if (!session.identifiedCourseId) return no('el paquete no está asociado a un curso de Cursia.');
      const [ses] = await d.dataSource.query(`select identification from public.workshop_sessions where id = $1`, [session.id]);
      const ident = ses?.identification && typeof ses.identification === 'object' ? ses.identification : {};
      const artId = ident?.result?.matchedArtifactId;
      if (typeof artId !== 'string' || !artId) return no('el paquete no se identificó por su huella exacta con un paquete de Cursia (se necesita la fuente con la que se armó).');
      const [art] = await d.dataSource.query(`select id::text as id, owner_id::text as owner_id, job_id::text as job_id, type, metadata from public.artifacts where id::text = $1`, [artId]);
      if (!art || art.type !== 'dynamic_mbz') return no('el paquete identificado no es un paquete v3 del generador.');
      const [course] = await d.dataSource.query(`select id, owner_id::text as owner_id, institution_id::text as institution_id from public.courses where id = $1`, [session.identifiedCourseId]);
      if (!course) return no('el curso ya no existe.');
      const inScope = session.institutionId ? String(course.institution_id ?? '').toLowerCase() === session.institutionId.toLowerCase() : String(course.owner_id).toLowerCase() === session.ownerId.toLowerCase();
      if (!inScope || String(art.owner_id).toLowerCase() !== String(course.owner_id).toLowerCase()) return no('el paquete identificado no es de este curso o de esta cuenta.');
      const [job] = art.job_id ? await d.dataSource.query(`select id::text as id, owner_id::text as owner_id, course_id, input_payload from public.production_jobs where id::text = $1`, [art.job_id]) : [];
      const payload = job ? (typeof job.input_payload === 'string' ? JSON.parse(job.input_payload) : job.input_payload ?? {}) : null;
      if (!job || !payload?.runId || !Number.isInteger(Number(payload.manifestId)) || !Number.isInteger(Number(payload.blueprintNumber))) return no('no se encontró el empaquetado que armó este paquete.');
      if (String(job.owner_id).toLowerCase() !== String(course.owner_id).toLowerCase()) return no('el empaquetado es de otra cuenta.');
      if (payload.packageKind && payload.packageKind !== 'final') return no('el paquete es una vista previa (QA), no el final.');
      const courseId = Number(job.course_id);
      const manifest = await d.manifests.getById(courseId, job.owner_id, Number(payload.blueprintNumber), Number(payload.manifestId));
      if (manifest.id !== Number(payload.manifestId) || manifest.manifest?.rulesVersion !== 3) return no('el Manifest del curso no es el del paquete (v3).');
      const meta = art.metadata && typeof art.metadata === 'object' ? art.metadata : {};
      const moodleResolved = typeof meta.moodleVersion === 'string' && meta.moodleVersion ? meta.moodleVersion : DEFAULT_DYNAMIC_MOODLE_VERSION;
      const q = { query: d.dataSource.query.bind(d.dataSource) };
      const prepared = await prepareV3Package(q, payload.runId, manifest, courseId, moodleResolved);
      const bp = await d.blueprints.getByNumberAnySchema(courseId, job.owner_id, Number(payload.blueprintNumber));
      if (bp.schemaVersion !== 2) return no('el Blueprint del curso no es v2.');
      const composed = await composeV3BuildInput({
        q, loaders: artifactsServiceLoadersV3(d.artifacts, job.owner_id), ownerId: job.owner_id, prepared, manifest, snapshot: bp.snapshot as BlueprintSnapshotV2,
        moodleRequested: moodleResolved === DEFAULT_DYNAMIC_MOODLE_VERSION ? undefined : moodleResolved, qa: false, ts: 1,
      });
      const chapterIdByNumber = new Map<number, string>();
      for (const m of composed.plan.modules) for (const ch of m.chapters) if (ch.kind !== 'practice') chapterIdByNumber.set(ch.chapterNumber, ch.chapterId);
      return { buildInput: composed.buildInput, chapterIdByNumber };
    },
  };
}

/** `<backup_date>` del paquete (el `ts` con que lo armó el builder v3). */
export async function backupTsOf(pkgBytes: Buffer): Promise<number | null> {
  const pkg = await openMbz(pkgBytes);
  if (!pkg.has('moodle_backup.xml')) return null;
  const x = (await pkg.readEntry('moodle_backup.xml')).toString('utf8');
  const v = Number(/<backup_date>(\d+)<\/backup_date>/.exec(x)?.[1]);
  return Number.isInteger(v) && v > 0 ? v : null;
}

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
  srcIn: LibroV3Source,
  chapters: Array<{ number: number; md: string }>,
  build: (i: BuildDynamicMbzV3Input) => Promise<{ mbz: Buffer }>,
): Promise<LibroV3Regenerated> {
  let src = srcIn;
  const cur = await libroPdfOf(original);
  if (!cur) return { ok: false, code: 'no_pdf', reason: 'El paquete no trae el Libro Guía en PDF.' };
  for (const c of chapters) {
    if (!src.chapterIdByNumber.has(c.number)) return { ok: false, code: 'chapter_unknown', reason: `El capítulo ${c.number} no está en la fuente del curso.` };
    if (typeof c.md !== 'string' || !c.md.trim()) return { ok: false, code: 'chapter_unknown', reason: `El capítulo ${c.number} llegó sin texto.` };
  }
  // r107 B10: el reloj del .mbz (`ts`) es el del original (`<backup_date>`): con él el builder reproduce su PDF.
  const ts = await backupTsOf(original);
  if (ts) src = { ...src, buildInput: { ...src.buildInput, ts } };
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

/**
 * El resolvedor que corresponde a este proceso: el del servidor si están los servicios del generador (Manifests y
 * Blueprints), si no el de «no disponible». Perezoso: los servicios se buscan al resolver, no al construir.
 */
export function libroV3ResolverOf(dataSource: Pick<DataSource, 'query'>, artifacts: ArtifactsService, moduleRef?: { get: (t: any, o?: any) => any } | null): LibroV3SourceResolver {
  let manifests: Pick<GenerationManifestsService, 'getById'> | null = null;
  let blueprints: Pick<CourseBlueprintsService, 'getByNumberAnySchema'> | null = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { GenerationManifestsService: GM } = require('../../generation-manifests/generation-manifests.service');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { CourseBlueprintsService: CB } = require('../../course-blueprints/course-blueprints.service');
    manifests = moduleRef?.get(GM, { strict: false }) ?? null;
    blueprints = moduleRef?.get(CB, { strict: false }) ?? null;
  } catch { manifests = null; blueprints = null; }
  if (!manifests || !blueprints) return SERVER_LIBRO_V3_RESOLVER;
  return serverLibroV3Resolver({ dataSource, artifacts, manifests, blueprints });
}
