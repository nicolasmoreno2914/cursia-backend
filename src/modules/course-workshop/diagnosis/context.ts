/**
 * r107 B3 · Taller de cursos — contexto del diagnóstico técnico. Toda la LECTURA del paquete pasa acá (asíncrona, una
 * vez); los checks T01–T12 son después funciones PURAS `(ctx) → Finding[]` sobre este contexto (checks.ts).
 *
 * Qué se lee:
 *   - inventario completo CON HTML (B2: readRawCourse + adaptador de la familia, determinista);
 *   - TODOS los blobs que declara files.xml (y los de files/ que nadie declara): sha1 real, tamaño, cabeza / cola (para
 *     reconocer PDF / HTML / zip sin guardarlos), metadatos del MP3 (mp3-meta.ts, sin decodificar). Un blob se lee UNA
 *     vez aunque lo compartan varios archivos y se suelta enseguida: en memoria quedan solo los textos que algún check
 *     necesita entero (Libro Guía HTML, manifiesto y HTML de arranque de cada SCORM) y el contenido de cada .h5p
 *     (h5p.json + content/content.json, abiertos con el MISMO lector seguro del paquete: es un zip ajeno más);
 *   - hvp.xml de cada video V1 (json_content) y el `<single>` de cada opción múltiple de questions.xml;
 *   - el validador v3 del builder (T11), solo para paquetes del builder v3: con expectativas si las hay, si no la parte
 *     que no depende de ellas (`validateMbzV3Structure`).
 * Nada se escribe a disco ni se ejecuta. El presupuesto de lectura del lector (1 GB por paquete) se respeta: si se
 * agota, los blobs que faltan quedan «sin verificar» (T02 lo avisa), nunca «bien».
 */
import { createHash } from 'crypto';
import { MbzPackage, isMbzReaderError, openMbz } from '../mbz-reader';
import { WorkshopFamily } from '../identify';
import { RawCourse, WorkshopActivity, WorkshopCourse, WorkshopFile, buildWorkshopCourse, readRawCourse } from '../course-model';
import { adapterFor } from '../adapters';
import { xmlUnescape } from '../../visual-design/preview-extract';
import { allBlocks, tagInner } from '../xml-scan';
import { MbzV3Issue, MbzV3ValidationExpectations, validateMbzV3, validateMbzV3Structure } from '../../../package/v3/mbz-validator-v3';
import { Mp3Meta, mp3Meta } from './mp3-meta';

export interface DiagnosisInput {
  pkg: MbzPackage;
  /** Bytes del paquete (el validador v3 lo abre con su propio unzip). */
  packageBytes: Buffer;
  family: WorkshopFamily;
  builderLine: string;
  builderVersion: string | null;
  /** Expectativas del builder (facts + perfil) si la base las tiene; null = el validador corre sin ellas. */
  expectations?: MbzV3ValidationExpectations | null;
  /** Por qué no hay expectativas (se muestra en el informe). */
  expectationsReason?: string | null;
}

export interface BlobFact {
  hash: string;
  entry: string;
  present: boolean;
  /** sha1 real de los bytes (null si no se leyó). */
  sha1: string | null;
  size: number | null;
  /** Primeros 8 KB / últimos 1 KB (para reconocer el formato sin guardar el archivo). */
  head: Buffer | null;
  tail: Buffer | null;
  mp3: Mp3Meta | null;
  /** No se pudo leer (presupuesto agotado / entrada ilegible): sin verificar. */
  unread: string | null;
}

export interface CtxFile {
  contextId: number | null;
  file: WorkshopFile;
  owner: WorkshopActivity | null;
}

export interface H5pPackage {
  mainLibrary: string | null;
  /** content/content.json parseado (null si falta o no es JSON). */
  content: unknown;
  contentProblem: string | null;
  entries: string[];
  problem: string | null;
}

export interface ScormContent {
  /** De dónde salió: el área `content` extraída del paquete o el zip del área `package`. */
  source: 'content' | 'package' | 'none';
  manifest: string | null;
  /** Nombres de archivo disponibles (relativos a la raíz del SCORM). */
  files: string[];
  /** HTML por nombre (solo .html/.htm, hasta 4 MB c/u). */
  html: Map<string, string>;
  /** Archivo de files.xml de cada nombre (área content). */
  fileOf: Map<string, WorkshopFile>;
  problem: string | null;
  /** Páginas que lanzan los sco de scorm.xml (lo que Moodle restaura en scorm_scoes y abre). */
  scoLaunches?: string[];
}

export interface ValidatorRun {
  mode: 'with_expectations' | 'without_expectations' | 'not_applicable';
  reason: string | null;
  issues: MbzV3Issue[];
  error: string | null;
}

export interface DiagnosisContext {
  family: WorkshopFamily;
  builderLine: string;
  builderVersion: string | null;
  container: 'zip' | 'tar.gz';
  course: WorkshopCourse;
  raw: RawCourse;
  files: CtxFile[];
  blobs: Map<string, BlobFact>;
  /** Entradas bajo files/ que files.xml no declara. */
  undeclaredBlobs: string[];
  /** Entradas bajo files/ con ruta que no es `files/<sha1[:2]>/<sha1>`. */
  malformedBlobPaths: string[];
  /** Textos completos de blobs (por hash) que algún check necesita: Libro Guía HTML. */
  texts: Map<string, string>;
  scorm: Map<number, ScormContent>;
  h5p: Map<number, H5pPackage>;
  /** json_content de cada hvp (moduleId → objeto | { problem }). */
  hvp: Map<number, { json: unknown; problem: string | null }>;
  /** `<single>` de cada pregunta multichoice de questions.xml. */
  mcSingle: Map<number, boolean>;
  /** Contenido crudo (escapado) de cada campo HTML, por `${entry}|${field}` (fix round 1, P2-6). */
  rawFields: Map<string, string>;
  validator: ValidatorRun;
  actByMid: Map<number, WorkshopActivity>;
  actByDir: Map<string, WorkshopActivity>;
  actByIdnumber: Map<string, WorkshopActivity>;
}

const HEAD = 8 * 1024;
const TAIL = 1024;
const TEXT_MAX = 64 * 1024 * 1024;
const SCORM_HTML_MAX = 4 * 1024 * 1024;
/** tar.gz: cada lectura descomprime el flujo entero → los blobs se leen por tandas de hasta este tamaño. */
const TAR_BATCH_BYTES = 128 * 1024 * 1024;

const sha1 = (b: Buffer): string => createHash('sha1').update(b).digest('hex');
const tagOf = (xml: string, name: string): string | null => tagInner(xml, name);

/** Abre un zip ANIDADO (.h5p / paquete SCORM) con el lector seguro del Taller; nunca lanza. */
async function openNested(buf: Buffer): Promise<{ pkg: MbzPackage | null; problem: string | null }> {
  try {
    return { pkg: await openMbz(buf, { maxPackageBytes: 300 * 1024 * 1024, maxReadBytes: 256 * 1024 * 1024 }), problem: null };
  } catch (err) {
    return { pkg: null, problem: isMbzReaderError(err) ? err.message : 'el archivo comprimido no se puede abrir' };
  }
}

async function readH5p(buf: Buffer): Promise<H5pPackage> {
  const { pkg, problem } = await openNested(buf);
  if (!pkg) return { mainLibrary: null, content: null, contentProblem: null, entries: [], problem };
  const out: H5pPackage = { mainLibrary: null, content: null, contentProblem: null, entries: pkg.entries.map((e) => e.name), problem: null };
  try {
    const hj = await pkg.readText('h5p.json', { maxBytes: 4 * 1024 * 1024 });
    if (hj === null) out.problem = 'el paquete H5P no tiene h5p.json';
    else out.mainLibrary = String((JSON.parse(hj) as { mainLibrary?: unknown }).mainLibrary ?? '') || null;
  } catch {
    out.problem = 'h5p.json no es JSON válido';
  }
  try {
    const cj = await pkg.readText('content/content.json', { maxBytes: 32 * 1024 * 1024 });
    if (cj === null) out.contentProblem = 'el paquete H5P no tiene content/content.json';
    else out.content = JSON.parse(cj);
  } catch {
    out.contentProblem = 'content/content.json no es JSON válido';
  }
  return out;
}

/** Manifiesto + HTML de un SCORM empaquetado como zip (cuando el área `content` no viene extraída). */
async function readScormZip(buf: Buffer): Promise<ScormContent> {
  const { pkg, problem } = await openNested(buf);
  const empty: ScormContent = { source: 'package', manifest: null, files: [], html: new Map(), fileOf: new Map(), problem };
  if (!pkg) return empty;
  const files = pkg.entries.map((e) => e.name);
  const out: ScormContent = { ...empty, files };
  try {
    out.manifest = await pkg.readText('imsmanifest.xml', { maxBytes: 4 * 1024 * 1024 });
    for (const e of pkg.entries.filter((x) => /\.html?$/i.test(x.name) && x.size <= SCORM_HTML_MAX)) out.html.set(e.name, (await pkg.readEntry(e.name)).toString('utf8'));
  } catch (err) {
    out.problem = isMbzReaderError(err) ? err.message : 'el paquete SCORM no se puede leer';
  }
  return out;
}

/** Arma el contexto (toda la lectura). Nunca lanza por el contenido del paquete: lo deja como datos para los checks. */
export async function buildDiagnosisContext(input: DiagnosisInput): Promise<DiagnosisContext> {
  const { pkg } = input;
  // Fix round 1 (P1-1): el validador (JSZip sobre TODO el paquete) corre PRIMERO y suelta su estructura antes de armar
  // el inventario con HTML y la pasada por los blobs: los dos picos de memoria ya no se suman.
  // ── T11: validador v3 del builder ──
  let validator: ValidatorRun;
  if (input.builderLine !== 'v3') {
    validator = { mode: 'not_applicable', reason: 'el validador v3 solo entiende paquetes del builder v3', issues: [], error: null };
  } else if (pkg.container !== 'zip') {
    validator = { mode: 'not_applicable', reason: 'el paquete no es un zip (el builder v3 siempre arma zip)', issues: [], error: null };
  } else {
    const withExp = !!input.expectations;
    try {
      const r = withExp ? await validateMbzV3(input.packageBytes, input.expectations as MbzV3ValidationExpectations) : await validateMbzV3Structure(input.packageBytes);
      validator = { mode: withExp ? 'with_expectations' : 'without_expectations', reason: withExp ? null : (input.expectationsReason ?? 'no hay expectativas del builder para este paquete'), issues: r.issues, error: null };
    } catch (err) {
      validator = { mode: withExp ? 'with_expectations' : 'without_expectations', reason: null, issues: [], error: err instanceof Error ? err.message.slice(0, 300) : String(err) };
    }
  }

  const raw = await readRawCourse(pkg, { family: input.family, builderLine: input.builderLine, builderVersion: input.builderVersion });
  const course = buildWorkshopCourse(raw, adapterFor(input.family));
  const actByMid = new Map(course.activities.map((a) => [a.moduleId, a]));
  const actByDir = new Map(course.activities.map((a) => [a.dir, a]));
  const actByIdnumber = new Map(course.activities.filter((a) => a.idnumber).map((a) => [a.idnumber as string, a]));
  // Dueño de cada archivo: la actividad de su contexto (con moduleid repetido, la PRIMERA listada).
  const actByCtx = new Map<number, WorkshopActivity>();
  for (const a of course.activities) if (a.contextId !== null && !actByCtx.has(a.contextId)) actByCtx.set(a.contextId, a);
  const files: CtxFile[] = raw.allFiles.map(({ contextId, file }) => ({ contextId, file, owner: contextId !== null ? actByCtx.get(contextId) ?? null : null }));

  // ── Qué blobs hace falta guardar enteros ──
  const libroHashes = new Set<string>();
  const scormContentHashes = new Set<string>();
  const scormPackageByMid = new Map<number, WorkshopFile>();
  const h5pPackageByMid = new Map<number, WorkshopFile>();
  for (const a of course.activities) {
    if (a.kind === 'libro') for (const f of a.files) if (f.filearea === 'content' && /\.html?$/i.test(f.filename)) libroHashes.add(f.contenthash);
    if (a.modname === 'scorm') {
      for (const f of a.files) if (f.filearea === 'content' && (/\.html?$/i.test(f.filename) || f.filename === 'imsmanifest.xml')) scormContentHashes.add(f.contenthash);
      const p = a.files.find((f) => f.filearea === 'package' && f.filename !== '.');
      if (p) scormPackageByMid.set(a.moduleId, p);
    }
    if (a.modname === 'h5pactivity') {
      const p = a.files.find((f) => f.filearea === 'package' && f.filename !== '.');
      if (p) h5pPackageByMid.set(a.moduleId, p);
    }
  }
  const scormZipHashes = new Set<string>();
  for (const [mid, f] of scormPackageByMid) {
    const a = actByMid.get(mid)!;
    if (!a.files.some((x) => x.filearea === 'content' && x.filename !== '.')) scormZipHashes.add(f.contenthash);
  }
  const h5pHashes = new Set([...h5pPackageByMid.values()].map((f) => f.contenthash));
  const mp3Hashes = new Set(files.filter((x) => /\.mp3$/i.test(x.file.filename) || x.file.mimetype === 'audio/mpeg' || x.file.mimetype === 'audio/mp3').map((x) => x.file.contenthash));

  // ── Una pasada por todos los blobs ──
  const blobs = new Map<string, BlobFact>();
  const texts = new Map<string, string>();
  const nested = new Map<string, Buffer>();
  const declared = new Map<string, string>();
  for (const { file } of files) if (file.filename !== '.' && /^[0-9a-f]{40}$/.test(file.contenthash)) declared.set(file.contenthash, file.blobEntry);
  const allHashes = new Set(files.map((x) => x.file.contenthash));
  const undeclaredBlobs: string[] = [];
  const malformedBlobPaths: string[] = [];
  for (const e of pkg.entries) {
    if (!e.name.startsWith('files/')) continue;
    const m = /^files\/([0-9a-f]{2})\/([0-9a-f]{40})$/.exec(e.name);
    if (!m || m[2].slice(0, 2) !== m[1]) malformedBlobPaths.push(e.name);
    // Las entradas «.» (carpetas) también declaran su blob (el vacío, da39a3…): no es un sobrante.
    else if (!allHashes.has(m[2])) undeclaredBlobs.push(e.name);
  }
  const want: Array<{ hash: string; entry: string }> = [];
  for (const [hash, entry] of [...declared.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (!pkg.has(entry)) blobs.set(hash, { hash, entry, present: false, sha1: null, size: null, head: null, tail: null, mp3: null, unread: null });
    else want.push({ hash, entry });
  }
  const take = (hash: string, entry: string, b: Buffer) => {
    blobs.set(hash, {
      hash, entry, present: true, sha1: sha1(b), size: b.length,
      head: Buffer.from(b.subarray(0, HEAD)), tail: Buffer.from(b.subarray(Math.max(0, b.length - TAIL))),
      mp3: mp3Hashes.has(hash) ? mp3Meta(b) : null, unread: null,
    });
    if ((libroHashes.has(hash) || scormContentHashes.has(hash)) && b.length <= TEXT_MAX) texts.set(hash, b.toString('utf8'));
    if (h5pHashes.has(hash) || scormZipHashes.has(hash)) nested.set(hash, b);
  };
  // Fix round 1 (P1-1): cada .h5p / zip de SCORM se abre APENAS se leyó y se suelta (antes quedaban todos en memoria
  // hasta el final de la pasada). Solo se guarda lo extraído (h5p.json + content.json / manifiesto + HTML).
  const nestedH5p = new Map<string, H5pPackage>();
  const nestedScorm = new Map<string, ScormContent>();
  const drainNested = async () => {
    for (const [hash, b] of nested) {
      if (sha1(b) === hash) {
        if (h5pHashes.has(hash)) nestedH5p.set(hash, await readH5p(b));
        if (scormZipHashes.has(hash)) nestedScorm.set(hash, await readScormZip(b));
      }
      nested.delete(hash);
    }
  };
  let budgetProblem: string | null = null;
  const markUnread = (rest: Array<{ hash: string; entry: string }>, why: string) => {
    for (const w of rest) if (!blobs.has(w.hash)) blobs.set(w.hash, { hash: w.hash, entry: w.entry, present: true, sha1: null, size: null, head: null, tail: null, mp3: null, unread: why });
  };
  if (pkg.container === 'zip') {
    for (let i = 0; i < want.length; i++) {
      const w = want[i];
      try {
        take(w.hash, w.entry, await pkg.readEntry(w.entry));
        if (nested.size) await drainNested();
      } catch (err) {
        const why = isMbzReaderError(err) ? err.message : 'no se pudo leer';
        if (isMbzReaderError(err) && err.code === 'read_budget_exceeded') { budgetProblem = why; markUnread(want.slice(i), why); break; }
        markUnread([w], why);
      }
    }
  } else {
    let batch: typeof want = [];
    let bytes = 0;
    const flush = async () => {
      if (!batch.length || budgetProblem) return;
      try {
        const got = await pkg.readEntries(batch.map((w) => w.entry));
        for (const w of batch) { const b = got.get(w.entry); if (b) take(w.hash, w.entry, b); else markUnread([w], 'no se pudo leer'); }
        got.clear();
        await drainNested();
      } catch (err) {
        const why = isMbzReaderError(err) ? err.message : 'no se pudo leer';
        if (isMbzReaderError(err) && err.code === 'read_budget_exceeded') budgetProblem = why;
        markUnread(batch, why);
      }
      batch = [];
      bytes = 0;
    };
    for (const w of want) {
      const sz = pkg.entry(w.entry)?.size ?? 0;
      if (batch.length && bytes + sz > TAR_BATCH_BYTES) await flush();
      if (budgetProblem) { markUnread([w], budgetProblem); continue; }
      batch.push(w);
      bytes += sz;
    }
    await flush();
  }
  const verified = (hash: string): boolean => { const b = blobs.get(hash); return !!b && b.present && b.sha1 === hash; };

  // ── SCORM: manifiesto + HTML de arranque (área content; si no viene extraída, el zip del área package) ──
  const scorm = new Map<number, ScormContent>();
  for (const a of course.activities.filter((x) => x.modname === 'scorm' && !x.missingFolder)) {
    const content = a.files.filter((f) => f.filearea === 'content' && f.filename !== '.');
    if (content.length) {
      const rel = (f: WorkshopFile) => `${(f.filepath || '/').replace(/^\//, '')}${f.filename}`;
      const sc: ScormContent = { source: 'content', manifest: null, files: content.map(rel), html: new Map(), fileOf: new Map(content.map((f) => [rel(f), f])), problem: null, scoLaunches: [] };
      const man = content.find((f) => rel(f) === 'imsmanifest.xml');
      if (man && verified(man.contenthash)) sc.manifest = texts.get(man.contenthash) ?? null;
      for (const f of content) if (/\.html?$/i.test(f.filename) && verified(f.contenthash) && texts.has(f.contenthash)) sc.html.set(rel(f), texts.get(f.contenthash) as string);
      scorm.set(a.moduleId, sc);
    } else {
      const p = scormPackageByMid.get(a.moduleId);
      if (p && nestedScorm.has(p.contenthash) && verified(p.contenthash)) scorm.set(a.moduleId, { ...(nestedScorm.get(p.contenthash) as ScormContent) });
      else scorm.set(a.moduleId, { source: p ? 'package' : 'none', manifest: null, files: [], html: new Map(), fileOf: new Map(), problem: p ? null : 'sin archivos', scoLaunches: [] });
    }
    // Fix round 1 (P2-1): lo que Moodle RESTAURA y lanza es scorm.xml <scoes><sco><launch> (scorm_scoes), no el manifiesto.
    const sx = await pkg.readText(`${a.dir}/scorm.xml`, { maxBytes: TEXT_MAX }).catch(() => null);
    const sc = scorm.get(a.moduleId) as ScormContent;
    sc.scoLaunches = sx ? allBlocks(sx, /<sco id="\d+">/, '</sco>')
      .map((m) => ({ launch: xmlUnescape(tagOf(m.inner, 'launch') ?? '').trim(), type: (tagOf(m.inner, 'scormtype') ?? '').trim() }))
      .filter((x) => x.launch && (x.type === 'sco' || x.type === 'asset' || x.type === ''))
      .map((x) => x.launch) : [];
  }
  // ── H5P (h5pactivity): h5p.json + content.json de cada paquete verificado ──
  const h5p = new Map<number, H5pPackage>();
  const h5pByHash = new Map<string, H5pPackage>();
  for (const [mid, f] of h5pPackageByMid) {
    if (!verified(f.contenthash) || !nestedH5p.has(f.contenthash)) continue;
    if (!h5pByHash.has(f.contenthash)) h5pByHash.set(f.contenthash, nestedH5p.get(f.contenthash) as H5pPackage);
    h5p.set(mid, h5pByHash.get(f.contenthash) as H5pPackage);
  }
  nested.clear();
  nestedH5p.clear();
  nestedScorm.clear();
  // Solo quedan los textos del Libro Guía (los del SCORM ya se copiaron a su mapa).
  for (const h of [...texts.keys()]) if (!libroHashes.has(h)) texts.delete(h);

  // ── hvp (V1): json_content de hvp.xml ──
  const hvp = new Map<number, { json: unknown; problem: string | null }>();
  for (const a of course.activities.filter((x) => x.modname === 'hvp' && !x.missingFolder)) {
    const xml = await pkg.readText(`${a.dir}/hvp.xml`, { maxBytes: TEXT_MAX }).catch(() => null);
    const raw = xml ? tagOf(xml, 'json_content') : null;
    if (raw === null) { hvp.set(a.moduleId, { json: null, problem: 'el video no trae su contenido (json_content)' }); continue; }
    try {
      hvp.set(a.moduleId, { json: JSON.parse(xmlUnescape(raw)), problem: null });
    } catch {
      hvp.set(a.moduleId, { json: null, problem: 'el contenido del video (json_content) no es JSON válido' });
    }
  }

  // ── Fix round 1 (P2-6): contenido CRUDO (escapado, como está en el paquete) de cada campo HTML de las actividades,
  // por (entrada, campo): los arreglos sugeridos llevan desplazamientos en BYTES de esos campos (los que parchea B4).
  const rawFields = new Map<string, string>();
  const byEntry = new Map<string, Array<{ field: string; off: number; len: number }>>();
  for (const a of course.activities) for (const h of a.html) {
    if (!byEntry.has(h.entry)) byEntry.set(h.entry, []);
    byEntry.get(h.entry)!.push({ field: h.field, off: h.rawOffset, len: h.rawBytes });
  }
  for (const [entry, fs] of byEntry) {
    const b = await pkg.readEntry(entry, { maxBytes: TEXT_MAX }).catch(() => null);
    if (!b) continue;
    for (const x of fs) rawFields.set(`${entry}|${x.field}`, b.subarray(x.off, x.off + x.len).toString('utf8'));
  }

  // ── `<single>` de las opciones múltiples ──
  const mcSingle = new Map<number, boolean>();
  if (course.exams.length && pkg.has('questions.xml')) {
    const qx = await pkg.readText('questions.xml', { maxBytes: TEXT_MAX }).catch(() => null);
    if (qx) for (const m of allBlocks(qx, /<question id="(\d+)">/, '</question>')) {
      const s = /<single>\s*(\d)\s*<\/single>/.exec(m.inner);
      if (s) mcSingle.set(Number(m.open![1]), s[1] !== '0');
    }
  }

  return {
    family: input.family, builderLine: input.builderLine, builderVersion: input.builderVersion, container: pkg.container,
    course, raw, files, blobs, undeclaredBlobs: undeclaredBlobs.sort(), malformedBlobPaths: malformedBlobPaths.sort(), texts, scorm, h5p, hvp, mcSingle, rawFields, validator,
    actByMid, actByDir, actByIdnumber,
  };
}

/** Blob presente y con el sha1 de su nombre: los checks de contenido solo leen blobs verificados (lo demás es T02). */
export function blobVerified(ctx: DiagnosisContext, hash: string): boolean {
  const b = ctx.blobs.get(hash);
  return !!b && b.present && b.sha1 === hash;
}
