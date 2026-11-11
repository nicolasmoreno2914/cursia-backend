/**
 * r107 B4 · Taller de cursos — MOTOR DE PARCHES determinista (diseño §2 reglas 3–5, §4 «Motor de parches»).
 *
 *   applyPatchPlan({ original, operations })
 *     1. abre el ORIGINAL con el lector seguro de B1 (nunca lo modifica: todo cambio va a una capa aparte);
 *     2. aplica las operaciones EN ORDEN; antes de cada una rearma el inventario de B2 sobre el estado actual (con
 *        HTML), así cada operación ve lo que dejaron las anteriores y verifica sus bytes antes de escribir;
 *     3. si una operación falla, el plan entero falla con el motivo y la operación (todo o nada: no hay paquete parcial);
 *     4. escribe el paquete nuevo en el MISMO contenedor (zip → zip con las entradas no tocadas copiadas comprimidas tal
 *        cual; tar.gz → tar.gz), lo vuelve a abrir con el lector seguro y verifica que lo no tocado quedó idéntico;
 *     5. corre el diagnóstico técnico B3 sobre el original y sobre el resultado: ningún hallazgo NUEVO de severidad
 *        `error` o `warning` (los que desaparecen se informan como resueltos). Si aparece uno, el plan falla.
 *   Devuelve el paquete + un INFORME DE CAMBIOS por operación (antes/después de cada campo, archivos, ids asignados,
 *   avisos de desalineación) que B5 muestra en el plan.
 *
 * Puro: sin base, sin red, sin IA, sin escribir a disco.
 */
import { MbzPackage, isMbzReaderError, openMbz } from '../mbz-reader';
import { WorkshopFamily, builderLineOf, familyOf, readPackageFacts } from '../identify';
import { WorkshopCourse, buildWorkshopCourse, readRawCourse, tokenContextOf } from '../course-model';
import { adapterFor } from '../adapters';
import { DIAGNOSIS_CODE_VERSION, DiagnosisReport, runTechnicalDiagnosis } from '../diagnosis/diagnose';
import { Finding } from '../diagnosis/finding';
import { PatchState, sha1Of } from './container';
import { IdAllocator } from './ids';
import { OpContext } from './op-context';
import { applyEditHtml } from './op-edit-html';
import { applyEditLibroSection } from './op-libro';
import { applyExamAdd, applyExamRemove, applyExamReplace } from './op-exam';
import { applyBrandReplace } from './op-brand';
import { applyRemoveActivity } from './op-remove';
import { applyRegenerate } from './op-regenerate';
import { applyAddChapter, chapterPieces, templateOf } from './op-add-chapter';
import { applyAddModule } from './op-add-module';
import { DiagnosisDelta, OperationReport, PATCH_OPERATIONS, PatchError, PatchFailure, PatchOperation, PatchResult, emptyReport } from './types';

export const PATCH_ENGINE_VERSION = 'b11-r0';

export interface PatchInput {
  /** Bytes del paquete ORIGINAL verificado (B2 `loadVerifiedOriginal`). No se modifican. */
  original: Buffer;
  filename?: string | null;
  /** Inventario de B2 del original (persistido, puede venir sin HTML): se verifica que sea de ESTE paquete. */
  inventory?: WorkshopCourse | null;
  operations: PatchOperation[];
  /**
   * Diagnóstico B3 del original ya calculado (B6 lo tiene guardado): se usa como «antes» SOLO si es de estos mismos
   * bytes (`originalSha1`) y de la versión actual del diagnóstico; si no, se recalcula.
   */
  baseline?: { originalSha1: string; report: DiagnosisReport } | null;
}

/** Firma gruesa de un hallazgo (sin posiciones): para mostrar y para agrupar. */
export function findingSignature(f: Finding): string {
  const file = f.evidence.file ? `${f.evidence.file.component}/${f.evidence.file.filearea}/${f.evidence.file.filename}` : '';
  const where = f.scope.activity ? f.scope.activity.dir : `${f.scope.level}:${f.scope.chapterNumber ?? ''}`;
  return [f.check, f.code, f.severity, where, f.evidence.questionId ?? '', f.evidence.token ?? '', file].join('|');
}

/** Lo que tocó el plan: entradas (modificadas, agregadas, quitadas), archivos de files.xml cambiados y actividades quitadas. */
export interface PlanTouch { entries: Set<string>; files: Set<string>; removedDirs: Set<string> }
export function planTouch(reports: OperationReport[]): PlanTouch {
  const entries = new Set<string>();
  const files = new Set<string>();
  const removedDirs = new Set<string>();
  for (const r of reports) {
    for (const e of [...r.entriesModified, ...r.entriesAdded, ...r.entriesRemoved]) entries.add(e);
    for (const fc of r.files) files.add(`${fc.component}/${fc.filearea}/${fc.filename}`);
    for (const e of r.entriesRemoved) { const m = /^(activities\/[^/]+)\/(module|[a-z]+)\.xml$/.exec(e); if (m && m[2] === 'module') removedDirs.add(m[1]); }
  }
  return { entries, files, removedDirs };
}

/**
 * Fix round 1 (P2-6): identidad de UNA ocurrencia. Donde el plan no tocó nada, el id exacto del hallazgo de B3 (incluye
 * la entrada, el campo y la posición). Donde sí tocó (la entrada, o el archivo del blob), las posiciones cambian
 * legítimamente: se usa la firma + el fragmento de evidencia (el enlace muerto, la ruta H5P…), así cambiar un defecto
 * por otro del mismo código en la misma actividad cuenta como uno resuelto y uno NUEVO.
 */
export function occurrenceKey(f: Finding, t: PlanTouch): string {
  const fileKey = f.evidence.file ? `${f.evidence.file.component}/${f.evidence.file.filearea}/${f.evidence.file.filename}` : null;
  const blob = !!f.evidence.entry && /^files\/[0-9a-f]{2}\/[0-9a-f]{40}$/.test(f.evidence.entry);
  const touched = (f.evidence.entry && t.entries.has(f.evidence.entry)) || (fileKey && t.files.has(fileKey))
    || (f.evidence.entry === null && !!f.scope.activity && [...t.entries].some((e) => e.startsWith(`${f.scope.activity!.dir}/`)))
    || (blob && !!fileKey && t.files.has(fileKey));
  if (!touched) return `id:${f.id}`;
  const entry = blob ? `file:${fileKey ?? ''}` : (f.evidence.entry ?? '');
  return ['occ', findingSignature(f), entry, defectKey(f)].join('|');
}

/**
 * Fix round 2 (N1): lo que identifica al DEFECTO, no su presentación. El fragmento de evidencia de un hallazgo sobre una
 * etiqueta (`<a href="#" style="…">Texto</a>`) trae atributos de estilo que una operación puede cambiar sin tocar el
 * defecto (brand_replace cambia un color del style de un botón muerto): se quitan `style`, `class` y `on*`, y en un
 * enlace muerto se usa su campo + destino + texto visible (título y detalle del hallazgo, que no llevan estilos).
 */
export function defectKey(f: Finding): string {
  // Enlace muerto: campo + destino (detalle hasta el «—») + texto del botón (el primer «…» del título; el resto del título
  // nombra la actividad por el comienzo de su texto, que una edición puede cambiar).
  if (f.code === 'dead_link') return `${f.detail.replace(/\s+—[\s\S]*$/, '')}|${/^El botón «([^»]*)»/.exec(f.title)?.[1] ?? ''}`;
  const ex = f.evidence.excerpt ?? '';
  if (!/<[a-zA-Z]/.test(ex)) return ex;
  return ex.replace(/\s(?:style|class|on[a-z]+)\s*=\s*(?:"[^"]*"?|'[^']*'?|[^\s>]*)/gi, '').replace(/\s+/g, ' ').trim();
}

/** Compara dos diagnósticos por ocurrencia (solo error / warning). */
export function diagnosisDelta(before: Finding[], after: Finding[], counts: { before: DiagnosisDelta['before']; after: DiagnosisDelta['after'] }, touch: PlanTouch = { entries: new Set(), files: new Set(), removedDirs: new Set() }): DiagnosisDelta {
  const visible = (fs: Finding[]) => fs.filter((x) => x.severity === 'error' || x.severity === 'warning');
  const removed: DiagnosisDelta['removed'] = [];
  const bag = (fs: Finding[], side: 'before' | 'after') => {
    const m = new Map<string, Finding[]>();
    for (const x of visible(fs)) {
      if (side === 'before' && x.scope.activity && touch.removedDirs.has(x.scope.activity.dir)) { removed.push({ signature: findingSignature(x), title: x.title, severity: x.severity }); continue; }
      const k = occurrenceKey(x, touch);
      m.set(k, [...(m.get(k) ?? []), x]);
    }
    return m;
  };
  const b = bag(before, 'before');
  const a = bag(after, 'after');
  const resolved: DiagnosisDelta['resolved'] = [];
  const introduced: DiagnosisDelta['introduced'] = [];
  for (const [k, xs] of b) { const n = (a.get(k) ?? []).length; for (const x of xs.slice(n)) resolved.push({ signature: findingSignature(x), title: x.title, severity: x.severity }); }
  for (const [k, xs] of a) { const n = (b.get(k) ?? []).length; for (const x of xs.slice(n)) introduced.push({ signature: findingSignature(x), title: x.title, severity: x.severity }); }
  return { before: counts.before, after: counts.after, resolved, introduced, removed };
}

/**
 * Ronda 4 (M1): Moodle arma la secuencia restaurada de cada sección en el ORDEN de `<activities>` de moodle_backup.xml.
 * Devuelve las secciones (por id) cuyo orden en moodle_backup.xml (filtrado por `<sectionid>`) no es su `<sequence>`.
 */
export async function sectionOrderMismatches(pkg: MbzPackage): Promise<Set<number>> {
  const out = new Set<number>();
  const mb = await pkg.readText('moodle_backup.xml');
  if (!mb) return out;
  const acts = [...mb.matchAll(/<activity>\s*<moduleid>(\d+)<\/moduleid>\s*<sectionid>(\d+)<\/sectionid>/g)].map((m) => [Number(m[1]), Number(m[2])] as const);
  const secs = [...mb.matchAll(/<section>\s*<sectionid>(\d+)<\/sectionid>[\s\S]*?<directory>([^<]*)<\/directory>/g)].map((m) => [Number(m[1]), m[2]] as const);
  for (const [id, dir] of secs) {
    const sx = await pkg.readText(`${dir}/section.xml`);
    if (!sx) continue;
    const want = (/<sequence>([^<]*)<\/sequence>/.exec(sx)?.[1] ?? '').split(',').filter(Boolean).map(Number);
    const got = acts.filter((a) => a[1] === id).map((a) => a[0]);
    if (want.join(',') !== got.join(',')) out.add(id);
  }
  return out;
}

function checkInventory(given: WorkshopCourse, actual: WorkshopCourse): string | null {
  const key = (c: WorkshopCourse) => c.activities.map((a) => `${a.moduleId}:${a.dir}:${a.html.map((h) => `${h.field}=${h.rawSha1}`).join(',')}`).join('|');
  return key(given) === key(actual) ? null : 'el inventario recibido no corresponde a este paquete (actividades o campos distintos)';
}

async function runOp(ctx: OpContext, op: PatchOperation): Promise<void> {
  switch (op.op) {
    case 'edit_html': return applyEditHtml(ctx, op);
    case 'edit_libro_section': return applyEditLibroSection(ctx, op);
    case 'exam_question_replace': return applyExamReplace(ctx, op);
    case 'exam_question_add': return applyExamAdd(ctx, op);
    case 'exam_question_remove': return applyExamRemove(ctx, op);
    case 'brand_replace': return applyBrandReplace(ctx, op);
    case 'remove_activity': return applyRemoveActivity(ctx, op);
    case 'regenerate_scorm': case 'regenerate_video': case 'regenerate_gamma': case 'regenerate_audio': return applyRegenerate(ctx, op);
    case 'add_chapter': return applyAddChapter(ctx, op);
    case 'add_module': return applyAddModule(ctx, op);
    default: throw new PatchError('invalid_params', `Operación fuera del catálogo de esta fase: «${(op as { op?: string }).op}».`);
  }
}

export async function applyPatchPlan(input: PatchInput): Promise<PatchResult> {
  const reports: OperationReport[] = [];
  const fail = (f: PatchFailure, container: 'zip' | 'tar.gz' = 'zip'): PatchResult => ({ ok: false, package: null, container, sha1: null, operations: reports, diagnosis: null, preservedEntries: 0, failure: f });
  const originalSha1 = sha1Of(input.original);
  let pkg: MbzPackage;
  let family: WorkshopFamily;
  let builderLine: string;
  try {
    pkg = await openMbz(input.original);
    const facts = await readPackageFacts(pkg, input.filename ?? null);
    family = familyOf(facts);
    builderLine = builderLineOf(facts);
  } catch (e) {
    return fail({ opIndex: null, op: null, code: 'package_unreadable', message: isMbzReaderError(e) || e instanceof Error ? e.message : String(e) });
  }
  if (!Array.isArray(input.operations) || !input.operations.length) return fail({ opIndex: null, op: null, code: 'invalid_params', message: 'El plan no tiene operaciones.' }, pkg.container);
  const meta = { family, builderLine };
  const state = await PatchState.create(pkg, input.original);

  for (let i = 0; i < input.operations.length; i++) {
    const op = input.operations[i];
    const name = op && typeof op === 'object' ? String((op as { op?: string }).op) : String(op);
    if (!(PATCH_OPERATIONS as readonly string[]).includes(name)) return fail({ opIndex: i, op: name, code: 'invalid_params', message: `Operación fuera del catálogo de esta fase: «${name}».` }, pkg.container);
    const report = emptyReport(i, op.op);
    try {
      const raw = await readRawCourse(state.asPackage(), meta);
      const inv = buildWorkshopCourse(raw, adapterFor(family));
      if (i === 0 && input.inventory) {
        const why = checkInventory(input.inventory, inv);
        if (why) return fail({ opIndex: null, op: null, code: 'inventory_mismatch', message: why }, pkg.container);
      }
      let alloc: IdAllocator | null = null;
      const ctx: OpContext = { state, inv, raw, tokenCtx: tokenContextOf(raw), family, report, ids: async () => (alloc ||= await IdAllocator.scan(state)) };
      await runOp(ctx, op);
      for (const k of ['entriesAdded', 'entriesRemoved', 'entriesModified'] as const) report[k] = [...new Set(report[k])].sort();
      reports.push(report);
    } catch (e) {
      if (e instanceof PatchError) return fail({ opIndex: i, op: name, code: e.code, message: e.message }, pkg.container);
      return fail({ opIndex: i, op: name, code: 'invariant', message: `Error interno al aplicar la operación: ${e instanceof Error ? e.message : String(e)}` }, pkg.container);
    }
  }

  // Escritura + relectura + lo no tocado idéntico.
  // tar.gz: `.ARCHIVE_INDEX` regenerado para el conjunto final de entradas (fix round 1, P2-1).
  if (await state.finalize()) { const last = reports[reports.length - 1]; if (!last.entriesModified.includes('.ARCHIVE_INDEX')) last.entriesModified.push('.ARCHIVE_INDEX'); last.notes.push('tar.gz: .ARCHIVE_INDEX regenerado (lista y cuenta de entradas del paquete nuevo)'); }
  const touched = await state.touched();
  let bytes: Buffer; let preserved: number;
  try {
    ({ bytes, preserved } = await state.serialize());
  } catch (e) {
    return fail({ opIndex: null, op: null, code: 'unsupported', message: `No se puede escribir el paquete nuevo: ${e instanceof Error ? e.message : String(e)}` }, pkg.container);
  }
  if (sha1Of(input.original) !== originalSha1) return fail({ opIndex: null, op: null, code: 'invariant', message: 'El original cambió durante la aplicación (no debería pasar nunca).' }, pkg.container);
  let out: MbzPackage;
  try {
    out = await openMbz(bytes);
  } catch (e) {
    return fail({ opIndex: null, op: null, code: 'invariant', message: `El paquete nuevo no abre: ${e instanceof Error ? e.message : String(e)}` }, pkg.container);
  }
  if (out.container !== pkg.container) return fail({ opIndex: null, op: null, code: 'invariant', message: `El contenedor cambió (${pkg.container} → ${out.container}).` }, pkg.container);
  const expected = new Set(state.names());
  const got = new Set(out.entries.map((e) => e.name));
  if (expected.size !== got.size || [...expected].some((n) => !got.has(n))) return fail({ opIndex: null, op: null, code: 'invariant', message: 'El paquete nuevo no tiene exactamente las entradas esperadas.' }, pkg.container);
  const changedSet = new Set([...touched.modified, ...touched.added]);
  for (const e of pkg.entries) {
    if (changedSet.has(e.name) || touched.removed.includes(e.name)) continue;
    if (out.entry(e.name)?.size !== e.size) return fail({ opIndex: null, op: null, code: 'invariant', message: `La entrada no tocada ${e.name} cambió de tamaño.` }, pkg.container);
  }

  // Ronda 4 (M1): para CUALQUIER operación, ninguna sección queda con <activities> en otro orden que su <sequence>
  // (un original que ya no lo cumplía cuenta como delta: no empeorar, no fallar por lo que ya traía).
  try {
    const before = await sectionOrderMismatches(await openMbz(input.original));
    const after = await sectionOrderMismatches(out);
    const worse = [...after].filter((x) => !before.has(x));
    if (worse.length) return fail({ opIndex: null, op: null, code: 'invariant', message: `El orden de las actividades de moodle_backup.xml no coincide con la secuencia de la sección ${worse.join(', ')} (Moodle las restauraría en otro orden).` }, pkg.container);
  } catch (e) {
    return fail({ opIndex: null, op: null, code: 'invariant', message: `No se pudo verificar el orden de las actividades: ${e instanceof Error ? e.message : String(e)}` }, pkg.container);
  }

  // Diagnóstico B3 antes / después.
  let delta: DiagnosisDelta;
  try {
    const bl = input.baseline;
    const before = bl && bl.originalSha1 === originalSha1 && bl.report?.codeVersion === DIAGNOSIS_CODE_VERSION && bl.report.family === family
      ? bl.report
      : await runTechnicalDiagnosis({ pkg: await openMbz(input.original), packageBytes: input.original, family, builderLine, builderVersion: null }, { prevalidateFixes: false });
    const after = await runTechnicalDiagnosis({ pkg: out, packageBytes: bytes, family, builderLine, builderVersion: null }, { prevalidateFixes: false });
    delta = diagnosisDelta(before.findings, after.findings, { before: before.counts.total, after: after.counts.total }, planTouch(reports));
  } catch (e) {
    return fail({ opIndex: null, op: null, code: 'invariant', message: `El diagnóstico del resultado falló: ${e instanceof Error ? e.message : String(e)}` }, pkg.container);
  }
  if (delta.introduced.length) {
    const r = fail({ opIndex: null, op: null, code: 'new_findings', message: `El resultado tiene ${delta.introduced.length} hallazgo(s) nuevo(s): ${delta.introduced.slice(0, 3).map((x) => `[${x.severity}] ${x.title}`).join(' · ')}` }, pkg.container);
    r.diagnosis = delta;
    return r;
  }
  // r107 B11: agregar capítulo / módulo — los conteos de capítulos y actividades suben EXACTO lo agregado (ni más ni menos).
  // P2-3: lo esperado sale de los PARÁMETROS (piezas del molde × capítulos + examen), no de lo que la operación dice que
  // hizo; P1-2b: las actividades que el plan quita (y los capítulos que quedan vacíos) se descuentan.
  const adds = input.operations.filter((o) => o.op === 'add_chapter' || o.op === 'add_module');
  if (adds.length) {
    try {
      const invOf = async (p: MbzPackage) => buildWorkshopCourse(await readRawCourse(p, meta), adapterFor(family));
      const b = await invOf(await openMbz(input.original));
      const a = await invOf(await openMbz(bytes));
      let wantCh = 0; let wantAct = 0;
      for (const o of adds as any[]) {
        const per = chapterPieces(templateOf(b, o.templateChapter, o.expect?.templateModuleIds), o.omit ?? []).length;
        if (o.op === 'add_chapter') { wantCh += 1; wantAct += per; continue; }
        const n = Array.isArray(o.chapters) ? o.chapters.length : 0;
        wantCh += n; wantAct += per * n;
        if (o.templateExamModuleId !== null && o.templateExamModuleId !== undefined) {
          const ex = b.activities.find((x) => x.moduleId === o.templateExamModuleId);
          wantAct += 1 + (ex && b.activities.some((x) => x.kind === 'exam_info' && x.unit === ex.unit && x.sectionId === ex.sectionId) ? 1 : 0);
        }
      }
      const removed = new Set(input.operations.filter((o) => o.op === 'remove_activity').map((o) => (o as any).moduleId as number));
      wantAct -= [...removed].filter((m) => b.activities.some((x) => x.moduleId === m)).length;
      wantCh -= b.chapters.filter((c) => c.activities.length && c.activities.every((m) => removed.has(m))).length;
      const dCh = a.chapters.length - b.chapters.length;
      const dAct = a.activities.length - b.activities.length;
      if (dCh !== wantCh || dAct !== wantAct) return fail({ opIndex: null, op: null, code: 'invariant', message: `El paquete nuevo tiene ${dCh} capítulo(s) y ${dAct} actividad(es) de diferencia; el plan pide ${wantCh} y ${wantAct}.` }, pkg.container);
    } catch (e) {
      return fail({ opIndex: null, op: null, code: 'invariant', message: `No se pudieron contar los capítulos del resultado: ${e instanceof Error ? e.message : String(e)}` }, pkg.container);
    }
  }
  return { ok: true, package: bytes, container: pkg.container, sha1: sha1Of(bytes), operations: reports, diagnosis: delta, preservedEntries: preserved, failure: null };
}
