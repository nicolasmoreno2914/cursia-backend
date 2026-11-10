/**
 * r107 B4 fix round 1 · PRUEBA EN SECO de los arreglos que sugiere el diagnóstico B3 (decisión del controlador): cada
 * `suggestedFix` de la Fase 2 se corre con el motor de parches sobre el MISMO paquete, sin contenido nuevo (lo
 * estructural: ¿la sección quedaría vacía?, ¿otra actividad depende de esta?, ¿el Libro tiene la forma que el motor sabe
 * editar?, ¿el examen trae datos de usuarios?…). Si no aplica, el hallazgo ofrece `edit_html` (cuando tiene sentido:
 * la actividad tiene un campo HTML) o null, siempre con el motivo. Nada se escribe: cada prueba usa una capa propia.
 * Determinista (mismo paquete → mismo resultado).
 */
import { MbzPackage } from '../mbz-reader';
import { WorkshopFamily } from '../identify';
import { RawCourse, WorkshopActivity, WorkshopCourse, tokenContextOf } from '../course-model';
import type { Finding, FixPrecheck, SuggestedFix } from '../diagnosis/finding';
import { PatchState, sha1Of } from './container';
import { IdAllocator } from './ids';
import { OpContext, blobPath } from './op-context';
import { applyRemoveActivity } from './op-remove';
import { applyExamRemove, examUserDataProblem } from './op-exam';
import { editToken, locateField } from './html-edit';
import { libroStructure, recomposeLibro } from './op-libro';
import { PatchError, emptyReport } from './types';

const PHASE2 = new Set(['edit_html', 'edit_libro_section', 'exam_question_replace', 'exam_question_add', 'exam_question_remove', 'brand_replace', 'remove_activity']);
/** Fallas que dicen que la operación NO aplica a este paquete (las demás son de contenido: las resuelve B5). */
const STRUCTURAL = new Set(['unsupported', 'unavailable', 'invariant', 'target_not_found', 'stale_target']);

export interface PrecheckInput { pkg: MbzPackage; packageBytes: Buffer; family: WorkshopFamily; course: WorkshopCourse; raw: RawCourse }

/**
 * Por qué una operación estructural no aplica (null = aplica). Fix round 2 (N3): NUNCA modifica `fix.params`; lo que
 * haya que agregar a los parámetros (p. ej. `mode: 'replace'`) va en `extra`, que el llamador aplica a una COPIA.
 */
async function why(fix: SuggestedFix, base: PatchState, inp: PrecheckInput, extra: Record<string, unknown>): Promise<string | null> {
  const p = fix.params as Record<string, any>;
  const act = (mid: unknown): WorkshopActivity | undefined => inp.course.activities.find((a) => a.moduleId === mid);
  const ctxOf = (): OpContext => {
    const state = base.fork();
    let alloc: IdAllocator | null = null;
    return { state, inv: inp.course, raw: inp.raw, tokenCtx: tokenContextOf(inp.raw), family: inp.family, report: emptyReport(0, fix.operation as any), ids: async () => (alloc ||= await IdAllocator.scan(state)) };
  };
  const run = async (fn: () => Promise<unknown>): Promise<string | null> => {
    try { await fn(); return null; } catch (e) {
      if (e instanceof PatchError) return STRUCTURAL.has(e.code) ? e.message : null;
      return `prueba en seco: ${e instanceof Error ? e.message : String(e)}`;
    }
  };
  switch (fix.operation) {
    case 'remove_activity': {
      const c = ctxOf();
      return run(() => applyRemoveActivity(c, { op: 'remove_activity', moduleId: p.moduleId }));
    }
    case 'exam_question_remove': {
      const c = ctxOf();
      return run(() => applyExamRemove(c, { op: 'exam_question_remove', quizModuleId: p.quizModuleId, questionId: p.questionId }));
    }
    case 'exam_question_replace': case 'exam_question_add': {
      const a = act(p.quizModuleId);
      if (!a || a.modname !== 'quiz' || !a.exam) return 'el examen no está en el paquete';
      if (p.questionId !== undefined && !a.exam.questions.some((q) => q.id === p.questionId)) return `la pregunta ${p.questionId} no es de este examen`;
      return examUserDataProblem({ state: base }, a.dir);
    }
    case 'edit_html': {
      const a = typeof p.moduleId === 'number' ? act(p.moduleId) : undefined;
      const fields = a ? a.html : typeof p.sectionId === 'number' ? inp.course.sections.find((s) => s.id === p.sectionId)?.html ?? [] : inp.course.courseSummary.html;
      if (!fields.length || (a && a.missingFolder)) return 'el destino no tiene un campo HTML que editar';
      const f = fields.find((h) => h.field === (p.field ?? fields[0].field));
      if (!f) return `el campo ${p.field} no existe`;
      if (p.token && !p.replaceWith) {
        const loc = await locateField(base.fork(), f).catch(() => null);
        if (!loc) return 'el campo no coincide con el paquete';
        try { editToken(loc.raw, p.token, 'unlink'); } catch (e) {
          // No se puede solo quitar el enlace: sigue siendo arreglable reescribiendo el campo (sin el token).
          if (e instanceof PatchError) { extra.mode = 'replace'; extra.reason = e.message; }
        }
      }
      return null;
    }
    case 'edit_libro_section': {
      const a = act(p.moduleId);
      if (!a || (a.kind !== 'libro' && a.kind !== 'libro_mobile')) return 'el Libro Guía no está en el paquete';
      if (a.modname === 'book') return 'el Libro en línea (mod_book) se edita por capítulo con edit_html';
      let html: string | null = null;
      if (a.modname === 'page') html = a.html.find((h) => h.field === 'content')?.html ?? null;
      else if (a.modname === 'resource') {
        const main = a.files.filter((x) => x.filearea === 'content' && x.filename !== '.');
        const lf = main.find((x) => /\.html?$/i.test(x.filename)) ?? main.find((x) => /\.pdf$/i.test(x.filename)) ?? main[0];
        if (!lf) return 'el recurso del Libro no trae archivo';
        if (/\.pdf$/i.test(lf.filename) || lf.mimetype === 'application/pdf') return 'el Libro Guía es un PDF: regenerarlo exige su fuente por capítulo (no disponible en esta fase)';
        if (!/\.html?$/i.test(lf.filename)) return `el Libro es «${lf.filename}»: solo se edita HTML`;
        if (!base.has(blobPath(lf.contenthash))) return 'el archivo del Libro no viene en el paquete';
        const buf = await base.read(blobPath(lf.contenthash));
        if (sha1Of(buf) !== lf.contenthash) return 'el archivo del Libro está dañado (su sha1 no coincide)';
        html = buf.toString('utf8');
      } else return `Libro en ${a.modname}: no soportado`;
      if (html === null) return 'el Libro no tiene contenido';
      const intact = /<\/html>\s*$/i.test(html);
      if (!intact) return null; // cortado: se recompone con la fuente (eso lo decide B5 / B6)
      if (!libroStructure(html).chapters.length) return 'el Libro no tiene títulos «Capítulo N: …» del builder: el motor no puede ubicar sus capítulos';
      const chapters: number[] = Array.isArray(p.chapters) ? p.chapters : [];
      if (chapters.length) {
        const titleOf = (n: number) => inp.course.chapters.find((c) => c.number === n)?.title ?? `Capítulo ${n}`;
        const moduleOf = (n: number) => inp.course.chapters.find((c) => c.number === n)?.moduleNumber ?? null;
        return run(async () => recomposeLibro(html as string, { op: 'edit_libro_section', moduleId: a.moduleId, chapters: chapters.map((n) => ({ number: n, html: '<p>prueba</p>', title: titleOf(n) })) }, titleOf, inp.course.chapters.map((c) => c.number), moduleOf));
      }
      return null;
    }
    default:
      return null;
  }
}

/** Arreglo alternativo cuando el sugerido no aplica: reescribir el HTML de la actividad, si tiene. */
function fallbackFor(f: Finding, inp: PrecheckInput, reason: string): SuggestedFix | null {
  const mid = f.scope.activity?.moduleId ?? (f.suggestedFix?.params as any)?.moduleId;
  const a = inp.course.activities.find((x) => x.moduleId === mid);
  if (!a || a.missingFolder || f.suggestedFix?.operation === 'edit_html') return null;
  const h = a.html.find((x) => x.field === 'content' && x.html.trim()) ?? a.html.find((x) => x.field === 'intro');
  if (!h || !['label', 'page'].includes(a.modname)) return null;
  return { operation: 'edit_html', params: { moduleId: a.moduleId, field: h.field, entry: h.entry, reason: `no se puede ${f.suggestedFix?.operation === 'remove_activity' ? 'quitar' : 'aplicar el arreglo sugerido'}: ${reason}` } };
}

/** Prueba en seco los arreglos de Fase 2 de cada hallazgo (los modifica en su lugar). */
export async function prevalidateFixes(findings: Finding[], inp: PrecheckInput): Promise<void> {
  // Se abre solo si hay algo que probar (en tar.gz carga todas las entradas).
  let base: PatchState | null = null;
  // Fix round 2 (N3): el memo guarda el resultado COMPLETO (motivo + lo que se agrega a los parámetros) por la clave de
  // los parámetros tal como vinieron; cada hallazgo recibe su propia copia.
  const memo = new Map<string, { reason: string | null; extra: Record<string, unknown> }>();
  for (const f of findings) {
    const fx = f.suggestedFix;
    if (!fx) { f.fixPrecheck = null; continue; }
    if (!PHASE2.has(fx.operation)) { f.fixPrecheck = { status: 'not_checked', reason: 'operación de otra fase (regenerar): el motor de la Fase 2 no la puede probar', original: null } as FixPrecheck; continue; }
    const key = JSON.stringify([fx.operation, fx.params]);
    let res = memo.get(key);
    if (res === undefined) {
      base ||= await PatchState.create(inp.pkg, inp.packageBytes);
      const extra: Record<string, unknown> = {};
      const reason = await why({ operation: fx.operation, params: JSON.parse(JSON.stringify(fx.params)) }, base, inp, extra);
      res = { reason, extra };
      memo.set(key, res);
    }
    const reason = res.reason;
    if (reason === null) {
      const params = { ...JSON.parse(JSON.stringify(fx.params)), ...res.extra };
      f.suggestedFix = { operation: fx.operation, params };
      f.fixPrecheck = { status: 'ok', reason: (params as any).reason ?? null, original: null };
      continue;
    }
    const alt = fallbackFor(f, inp, reason);
    f.fixPrecheck = { status: alt ? 'fallback' : 'unavailable', reason, original: fx };
    f.suggestedFix = alt;
  }
}
