/**
 * r107 B11 · Plan de la Fase 4: `add_chapter` / `add_module`. Igual que una regeneración de B10 (etapa de estimado →
 * aprobación con tope ≥ Σ cotas → producción por la compuerta → prueba en seco con el motor), pero el ítem muestra el
 * capítulo nuevo (título, objetivo, posición), sus piezas, el costo por PIEZA y proveedor, el tope mínimo, la estructura
 * antes / después (capítulos y numeración) y los avisos D7 (audiolibro y examen final no lo cubren: se ofrecen como
 * pedidos aparte, nunca se encadenan solos).
 */
import { createHash } from 'crypto';
import { WorkshopCourse } from '../course-model';
import { applyPatchPlan, PATCH_ENGINE_VERSION } from '../patch/engine';
import { chapterPieces, pagesNeeded, templateOf } from '../patch/op-add-chapter';
import { PatchError, PatchOperation } from '../patch/types';
import { ADD_CHAPTER_FAMILIES, AddChapterOp, AddModuleOp, ChapterPiece, ProducedChapter, ProducedModule, V3_ADD_CHAPTER_UNAVAILABLE } from '../regenerate/chapter-types';
import { ChapterEstimate, ChapterSpec, discardPieces, discardPolicy, retryCostOf, estimateChapter, estimateUnitExam, produceChapter, produceUnitExam, syntheticChapter, syntheticUnitExam, totals } from '../regenerate/chapter';
import type { PaidCallGate, RegenProviders } from '../regenerate/ports';
import { RegenError, RegenExternal } from '../regenerate/types';
import type { BuildCtx, PlannedCall, PreparedItem } from './builder';
import { ZERO_MEM, estimateAiCall, estimateLater, memOf } from './cost';
import { requiresItemConfirm, riskOf } from './risk';
import { InterpretedRequest, MisalignmentWarning, PlanItemView } from './types';

const wid = (...xs: unknown[]) => createHash('sha1').update(JSON.stringify(xs)).digest('hex').slice(0, 16);
const PIECE_ES: Record<string, string> = { presentation: 'presentación de Gamma', text: 'texto del capítulo', video: 'video interactivo', cta: '«🎯 Practicar»', game: 'juego SCORM', libro: 'capítulo del Libro Guía', video_page: 'página del video', game_page: 'descripción del juego', exam: 'examen de la unidad', exam_page: 'página del examen' };

export interface ChapterPlan {
  op: AddChapterOp | AddModuleOp;
  specs: ChapterSpec[];
  pieces: ChapterPiece[];
  exam: { withInfo: boolean; chapterTitles: string[] } | null;
  /** Estructura antes / después (capítulos y numeración). */
  structure: { before: Array<{ number: number; title: string; module: number | null }>; after: Array<{ number: number; title: string; module: number | null; isNew: boolean }> };
  notes: string[];
}

/** Destino + molde + piezas, SIN gastar. `unavailable` = motivo visible (v3, sin Libro HTML, molde inválido…). */
export async function resolveChapterPlan(ctx: BuildCtx, req: InterpretedRequest): Promise<ChapterPlan | { unavailable: string }> {
  const plan = await resolveChapterPlanShape(ctx, req);
  if ('unavailable' in plan) return plan;
  // P1-1: PRUEBA EN SECO del motor con un capítulo SINTÉTICO de forma válida (sin red, sin IA) ANTES de estimar o de
  // pagar: todas las precondiciones del motor (Libro con «Capítulo N:», índice, secuencia, plantillas, archivos del molde,
  // condiciones de acceso, sco, banco del examen) se descubren acá. Si el motor lo rechaza → no disponible, USD 0.
  const fail = await engineDryRun(ctx, plan);
  if (fail) return { unavailable: `No se puede agregar ${req.operation === 'add_module' ? 'el módulo' : 'el capítulo'} a este paquete: ${fail.replace(/\.?$/, '.')} No se llamó a ningún proveedor.` };
  return plan;
}

/** null = el motor acepta un producido de la forma prevista; si no, su motivo. */
export async function engineDryRun(ctx: BuildCtx, plan: ChapterPlan): Promise<string | null> {
  const produced = plan.op.op === 'add_chapter'
    ? syntheticChapter(plan.specs[0])
    : { kind: 'module' as const, moduleNumber: plan.op.moduleNumber, title: (plan.op as AddModuleOp).title, chapters: plan.specs.map(syntheticChapter), exam: plan.exam ? syntheticUnitExam(plan.exam.withInfo) : null };
  const r = await applyPatchPlan({ original: ctx.original, filename: ctx.filename, operations: [{ ...plan.op, produced } as PatchOperation], baseline: ctx.baseline });
  if (r.ok) return null;
  return `${r.failure?.message ?? 'el motor lo rechaza'}${r.diagnosis?.introduced?.length ? ` (${r.diagnosis.introduced.slice(0, 3).map((x) => x.title).join(' · ')})` : ''}`;
}

async function resolveChapterPlanShape(ctx: BuildCtx, req: InterpretedRequest): Promise<ChapterPlan | { unavailable: string }> {
  const c = ctx.course;
  if (!(ADD_CHAPTER_FAMILIES as readonly string[]).includes(ctx.family)) return { unavailable: ctx.family === 'v2-dynamic' ? V3_ADD_CHAPTER_UNAVAILABLE : `Agregar ${req.operation === 'add_module' ? 'módulos' : 'capítulos'} no está disponible en este formato de curso (${ctx.family}).` };
  const libro = c.libro.find((l) => l.format === 'html');
  if (!libro) return { unavailable: 'El curso no tiene Libro Guía HTML en el paquete: no se agrega un capítulo que el Libro no tendría.' };
  const d = req.details;
  const chs = d.newChapters ?? [];
  if (!chs.length) return { unavailable: 'Falta el título del capítulo nuevo.' };
  const omit = (d.omit ?? []).filter((x) => x === 'video' || x === 'presentation');
  const before = c.chapters.map((x) => ({ number: x.number, title: x.title ?? `Capítulo ${x.number}`, module: x.moduleNumber }));
  try {
    if (req.operation === 'add_chapter') {
      if (req.target?.kind !== 'module') return { unavailable: 'destino inválido' };
      const M = req.target.moduleNumber;
      const mod = c.modules.find((m) => m.number === M)!;
      const position = d.position ?? (mod.chapterNumbers.length ? Math.max(...mod.chapterNumbers) + 1 : 1);
      // Molde: el capítulo del MISMO módulo más cercano (misma paleta y mismas plantillas del builder).
      const sameMod = c.chapters.filter((x) => x.moduleNumber === M).map((x) => x.number).sort((a, b) => Math.abs(a - (position - 1)) - Math.abs(b - (position - 1)) || a - b);
      if (!sameMod.length) return { unavailable: `El módulo ${M} no tiene capítulos que sirvan de molde.` };
      const t = templateOf(c, sameMod[0]);
      const pieces = chapterPieces(t, omit);
      const pages = await pagesNeeded({ readText: async () => '' }, pieces, omit);
      const spec: ChapterSpec = { chapterNumber: position, title: chs[0].title, objective: chs[0].objective, moduleNumber: M, moduleTitle: mod.title ?? `Módulo ${M}`, pieces: pieces.map((p) => p.piece), pages };
      const op: AddChapterOp = { op: 'add_chapter', moduleNumber: M, position, title: chs[0].title, objective: chs[0].objective, templateChapter: t.number, expect: { templateModuleIds: t.activities.map((a) => a.moduleId) }, ...(omit.length ? { omit } : {}) };
      const after = [...before.filter((x) => x.number < position).map((x) => ({ ...x, isNew: false })), { number: position, title: chs[0].title, module: M, isNew: true }, ...before.filter((x) => x.number >= position).map((x) => ({ ...x, number: x.number + 1, isNew: false }))];
      return { op, specs: [spec], pieces: spec.pieces, exam: null, structure: { before, after }, notes: notesOf(t.number, t.title, pieces.map((p) => p.piece), omit) };
    }
    if (req.operation === 'add_module') {
      const last = [...c.modules].sort((a, b) => b.number - a.number)[0];
      if (!last) return { unavailable: 'El curso no tiene módulos.' };
      const M = last.number + 1;
      const L = Math.max(...c.chapters.map((x) => x.number));
      const t = templateOf(c, L);
      const pieces = chapterPieces(t, omit);
      const pages = await pagesNeeded({ readText: async () => '' }, pieces, omit);
      const title = d.moduleTitle ?? `Módulo ${M}`;
      const specs: ChapterSpec[] = chs.map((ch, i) => ({ chapterNumber: L + 1 + i, title: ch.title, objective: ch.objective, moduleNumber: M, moduleTitle: title, pieces: pieces.map((p) => p.piece), pages }));
      const ex = c.activities.find((a) => a.kind === 'exam' && a.unit === last.number && !a.missingFolder) ?? null;
      const info = ex ? c.activities.some((a) => a.kind === 'exam_info' && a.unit === last.number && a.sectionId === ex.sectionId) : false;
      const op: AddModuleOp = { op: 'add_module', moduleNumber: M, title, chapters: chs, templateChapter: t.number, templateExamModuleId: ex?.moduleId ?? null, expect: { templateModuleIds: t.activities.map((a) => a.moduleId) }, ...(omit.length ? { omit } : {}) };
      const after = [...before.map((x) => ({ ...x, isNew: false })), ...specs.map((s) => ({ number: s.chapterNumber, title: s.title, module: M, isNew: true }))];
      return { op, specs, pieces: specs[0].pieces, exam: ex ? { withInfo: info, chapterTitles: chs.map((x) => x.title) } : null, structure: { before, after }, notes: [...notesOf(t.number, t.title, pieces.map((p) => p.piece), omit), ex ? `Lleva su examen de unidad (como «${ex.title}»), con las preguntas del generador de exámenes.` : 'El formato del curso no tiene examen por unidad.'] };
    }
  } catch (e) {
    if (e instanceof PatchError) return { unavailable: e.message };
    throw e;
  }
  return { unavailable: 'Operación fuera del catálogo.' };
}

function notesOf(tn: number, tt: string, pieces: ChapterPiece[], omit: string[]): string[] {
  return [
    `Patrón del capítulo (el del builder de este curso, tomado del capítulo ${tn} «${tt}»): ${pieces.map((p) => PIECE_ES[p] ?? p).join(' → ')}, más su capítulo en el Libro Guía.`,
    ...(omit.length ? [`Sin ${omit.map((x) => PIECE_ES[x]).join(' ni ')}, como pediste.`] : []),
  ];
}

/** Estimado por pieza y proveedor (sin gastar). */
export function chapterPlanEstimate(ctx: BuildCtx, plan: ChapterPlan): ChapterEstimate {
  const db = ctx.regenDb ?? null;
  const pieces = plan.specs.flatMap((s) => estimateChapter(s, ctx.course, ctx.pricing, db).pieces.map((p) => ({ ...p, piece: plan.specs.length > 1 ? `cap${s.chapterNumber}:${p.piece}` : p.piece })));
  if (plan.exam) pieces.push(...estimateUnitExam({ moduleNumber: plan.op.moduleNumber, moduleTitle: (plan.op as AddModuleOp).title, chapterTitles: plan.exam.chapterTitles, course: ctx.course, db, withInfo: plan.exam.withInfo }, ctx.pricing));
  return totals(pieces);
}

/** D7: el audiolibro y el examen final no cubren lo nuevo → se AVISA y se ofrece como pedido aparte (con su costo). */
export function chapterWarnings(ctx: BuildCtx, plan: ChapterPlan): MisalignmentWarning[] {
  const c: WorkshopCourse = ctx.course;
  const out: MisalignmentWarning[] = [];
  const nums = plan.specs.map((s) => s.chapterNumber);
  const which = nums.length === 1 ? `el capítulo ${nums[0]} nuevo` : `los capítulos ${nums.join(', ')} nuevos`;
  const ab = c.activities.find((a) => a.kind === 'audiobook' && !a.missingFolder);
  if (ab) out.push({
    id: wid('add_chapter_audiobook', ab.moduleId, nums), kind: 'references', activity: { moduleId: ab.moduleId, title: ab.title, modname: ab.modname, chapterNumber: null }, questionId: null,
    message: `El audiolibro del curso no incluye ${which}. No se rehace solo: si lo quieres completo, agrégalo como pedido aparte («Rehacer el audio»).`,
    terms: [], suggestedOperation: 'regenerate_audio', estimate: memOf(estimateLater('regenerate_audio', { audioTarget: 'audiobook' } as any, c, ctx.pricing)),
  });
  const fin = c.activities.find((a) => a.exam?.final && !a.missingFolder);
  if (fin) out.push({
    id: wid('add_chapter_final_exam', fin.moduleId, nums), kind: 'references', activity: { moduleId: fin.moduleId, title: fin.title, modname: fin.modname, chapterNumber: null }, questionId: null,
    message: `«${fin.title}» no tiene preguntas de ${which}. No se agregan solas: pídelas aparte («Agregar pregunta de examen»).`,
    terms: [], suggestedOperation: 'exam_question_add', estimate: memOf(estimateAiCall('content_question', { promptChars: 3000 }, ctx.pricing)),
  });
  if (plan.op.op === 'add_chapter') {
    const later = c.chapters.filter((x) => x.number >= (plan.op as AddChapterOp).position).map((x) => x.number);
    if (later.length) out.push({
      id: wid('add_chapter_renumber', later), kind: 'engine', activity: null, questionId: null,
      message: `Los capítulos ${later.join(', ')} pasan a ser ${later.map((n) => n + 1).join(', ')}: se renumeran sus nombres, el botón «Practicar», el índice y los títulos del Libro y el resumen del módulo. Lo que escribió la IA dentro de páginas, juegos y videos no se reescribe.`,
      terms: [], suggestedOperation: null, estimate: null,
    });
  }
  return out;
}

/** Ítem en etapa de ESTIMADO (sin contenido, sin gasto). */
export async function chapterEstimateView(ctx: BuildCtx, req: InterpretedRequest, opts: { fromFinding?: boolean } = {}): Promise<PlanItemView | { unavailable: string }> {
  const plan = await resolveChapterPlan(ctx, req);
  if ('unavailable' in plan) return plan;
  let est: ChapterEstimate;
  try { est = chapterPlanEstimate(ctx, plan); } catch (e) { return { unavailable: `No se puede estimar el costo (${e instanceof Error ? e.message.slice(0, 200) : String(e)}). No se llama a ningún proveedor.` }; }
  const call = plannedCallOf(plan, est);
  const warnings = chapterWarnings(ctx, plan);
  const risk = riskOf({ operation: req.operation!, target: req.target, changes: [], misalignment: warnings, fromFinding: !!opts.fromFinding });
  const s0 = plan.specs[0];
  const what = req.operation === 'add_module' ? `Agregar el módulo ${plan.op.moduleNumber} «${(plan.op as AddModuleOp).title}» con ${plan.specs.length} capítulo(s)` : `Agregar el capítulo ${s0.chapterNumber} «${s0.title}» en el módulo ${s0.moduleNumber}`;
  const view: PlanItemView = {
    operation: req.operation!, params: null, available: true, requiresItemConfirm: true,
    summary: `${what}: se produce con los proveedores cuando apruebes su costo (tope mínimo USD ${Number(est.totalBoundUsd).toFixed(2)}).`,
    changes: [], files: [], entries: { added: [], removed: [], modified: [] }, risk,
    cost: { spentUsd: '0', apply: ZERO_MEM, contentEstimate: { min: est.min, expected: est.expectedUsd, max: est.max } as any, basis: `estimado ANTES de producir, por pieza y proveedor (${est.basis}); nada corre sin tu aprobación y su tope · ${est.pieces.map((p) => `${PIECE_ES[p.piece.replace(/^cap\d+:/, '')] ?? p.piece}${/^cap\d+:/.test(p.piece) ? ` (${p.piece.split(':')[0]})` : ''} ≈ USD ${Number(p.expectedUsd).toFixed(2)} (máx. USD ${Number(p.boundUsd).toFixed(2)})`).join(' · ')}` },
    misalignment: warnings, dryRun: null, generated: false, plannedCall: call,
  };
  (view as any).chapter = chapterViewOf(plan);
  view.requiresItemConfirm = requiresItemConfirm(view.risk) || true;
  return view;
}

function chapterViewOf(plan: ChapterPlan) {
  return {
    chapters: plan.specs.map((s) => ({ number: s.chapterNumber, title: s.title, objective: s.objective, module: s.moduleNumber })),
    module: plan.op.op === 'add_module' ? { number: plan.op.moduleNumber, title: (plan.op as AddModuleOp).title } : null,
    pieces: plan.pieces, omitted: plan.op.omit ?? [], exam: !!plan.exam, structure: plan.structure, notes: plan.notes,
  };
}

/** Forma compatible con la aprobación de B5/B10 (`plannedCall.regen` con proveedores y Σ cotas). */
export function plannedCallOf(plan: ChapterPlan, est: ChapterEstimate): PlannedCall {
  return {
    model: 'claude-sonnet-4-6', kind: 'regenerate' as any, promptChars: 0, maxTokens: 0, size: { promptChars: 0 }, expectedUsd: est.expectedUsd, boundUsd: est.pieces[0]?.boundUsd ?? '0',
    regen: { op: plan.op.op, totalBoundUsd: est.totalBoundUsd, providers: est.providers, calls: est.calls, min: est.min, max: est.max, basis: est.basis, pieces: est.pieces, before: { chapters: plan.structure.before.length }, notes: plan.notes, target: { op: plan.op.op, moduleNumber: plan.op.moduleNumber }, templateModuleIds: [...plan.op.expect.templateModuleIds] },
  } as unknown as PlannedCall;
}

export interface PreparedChapterItem extends PreparedItem { produced: ProducedChapter | ProducedModule | null; failure?: { code: string; retryable: boolean } | null }

/** Produce (por la compuerta) → operación del motor → PRUEBA EN SECO sobre el original → vista con antes / después. */
export async function prepareChapterItem(ctx: BuildCtx, req: InterpretedRequest, deps: { providers: RegenProviders; gate: PaidCallGate; spent: () => string; ext?: RegenExternal }, opts: { fromFinding?: boolean } = {}): Promise<PreparedChapterItem> {
  const fail = (status: PreparedItem['status'], reason: string, code: string, retryable: boolean): PreparedChapterItem => ({ status, reason, view: null, spentUsd: deps.spent(), calls: 0, produced: null, failure: { code, retryable } });
  const plan = await resolveChapterPlan(ctx, req);
  if ('unavailable' in plan) return fail('unavailable', plan.unavailable, 'unavailable', false);
  const db = ctx.regenDb ?? null;
  let produced: ProducedChapter | ProducedModule;
  try {
    const chapters: ProducedChapter[] = [];
    for (const s of plan.specs) chapters.push(await produceChapter({ spec: s, course: ctx.course, providers: deps.providers, gate: deps.gate, pricing: ctx.pricing, db, ext: deps.ext }));
    if (plan.op.op === 'add_chapter') produced = chapters[0];
    else {
      const exam = plan.exam ? await produceUnitExam({ moduleNumber: plan.op.moduleNumber, moduleTitle: plan.op.title, chapterTitles: plan.exam.chapterTitles, course: ctx.course, providers: deps.providers, gate: deps.gate, pricing: ctx.pricing, db, ext: deps.ext, withInfo: plan.exam.withInfo }) : null;
      produced = { kind: 'module', moduleNumber: plan.op.moduleNumber, title: plan.op.title, chapters, exam };
    }
  } catch (e) {
    if (!(e instanceof RegenError)) throw e;
    if (e.code === 'unavailable') return fail('unavailable', e.message, e.code, false);
    if (['cap_reached', 'call_ambiguous', 'not_sent', 'provider_rejected', 'provider_not_ready', 'over_bound'].includes(e.code)) throw e;
    return fail('failed', `El capítulo nuevo no se produjo completo: ${e.message} Lo gastado queda registrado (y lo ya producido se reusa al reintentar); no se aplica nada.`, e.code, true);
  }
  const op = { ...plan.op, produced } as PatchOperation;
  const r = await applyPatchPlan({ original: ctx.original, filename: ctx.filename, operations: [op], baseline: ctx.baseline });
  if (!r.ok) {
    const why = `${r.failure?.message ?? 'falla del motor'}${r.diagnosis?.introduced?.length ? ` (${r.diagnosis.introduced.slice(0, 3).map((x) => `${x.title} [${x.signature.split('|')[1] ?? ''}]`).join(' · ')})` : ''}`;
    // Ronda 2 (P2-B): el contenido REAL no entró (hallazgos nuevos / invariante): la pieza culpable (o todas las de texto,
    // si no se sabe cuál) se DESCARTA de lo pagado guardado; el reintento la rehace en vez de reusar lo mismo.
    // Ronda 3 (P2-F): solo una falla de CONTENIDO (hallazgos nuevos o un invariante de contenido de la lista) descarta
    // piezas. Otra falla del motor es determinista: no se descarta nada y el motivo dice que reintentar no la arregla.
    const policy = discardPolicy(r.failure?.code, why);
    if (!policy.contentFailure) {
      return fail('failed', `El motor de parches no puede insertar el capítulo: ${why}. Esta falla no depende del contenido generado: reintentar no la arregla (y no se vuelve a cobrar nada; lo ya pagado queda guardado). No se aplica nada.`, r.failure?.code ?? 'engine', false);
    }
    let retry = '';
    if (deps.ext && policy.pieces.length) {
      const pieces = policy.pieces;
      const nums = plan.specs.map((s) => s.chapterNumber);
      const alsoExam = pieces.length > 1 && plan.op.op === 'add_module';
      const next = discardPieces(deps.ext.prior, nums, pieces, alsoExam);
      Object.assign(deps.ext.prior, next);
      await deps.ext.onPaid(next);
      const cost = retryCostOf(chapterPlanEstimate(ctx, plan), pieces, alsoExam);
      retry = ` El reintento rehace ${cost.pieces.map((p) => PIECE_ES[p] ?? p).join(', ')} (≈ USD ${cost.expectedUsd.toFixed(2)}, máx. USD ${cost.boundUsd.toFixed(2)}); lo demás ya pagado se reusa.`;
    }
    return fail('failed', `El motor de parches no puede insertar el capítulo: ${why}. No se aplica nada; lo gastado queda registrado.${retry}`, r.failure?.code ?? 'engine', true);
  }
  const rep = r.operations[0];
  const warnings = [...chapterWarnings(ctx, plan), ...rep.misalignment.filter((m) => !/audiolibro|examen final|pasan a ser/i.test(m)).map((m, i) => ({ id: wid('chapter_engine', i, m), kind: 'engine' as const, activity: null, questionId: null, message: m, terms: [], suggestedOperation: null, estimate: null }))];
  const params = { ...plan.op, summary: { chapters: plan.specs.map((s) => ({ number: s.chapterNumber, title: s.title })), pieces: plan.pieces, ids: rep.idsAssigned } };
  const view: PlanItemView = {
    operation: req.operation!, params: params as PatchOperation, available: true,
    summary: rep.summary, changes: rep.fields,
    files: rep.files.map((f) => ({ filename: f.filename, before: f.before.contenthash, after: f.after.contenthash })),
    entries: { added: rep.entriesAdded, removed: rep.entriesRemoved, modified: rep.entriesModified },
    risk: riskOf({ operation: req.operation!, target: req.target, changes: rep.fields, misalignment: warnings, fromFinding: !!opts.fromFinding, params: params as PatchOperation }),
    cost: { spentUsd: deps.spent(), apply: ZERO_MEM, contentEstimate: null, basis: 'producido con los proveedores al aprobar su costo: aplicar no vuelve a gastar' },
    misalignment: warnings,
    dryRun: { ok: true, failure: null, resolved: r.diagnosis?.resolved.length ?? 0, removed: r.diagnosis?.removed.length ?? 0, engineVersion: PATCH_ENGINE_VERSION },
    generated: true, requiresItemConfirm: true,
  };
  (view as any).chapter = { ...chapterViewOf(plan), notes: [...plan.notes, ...rep.notes] };
  return { status: 'resolved', reason: null, view, spentUsd: deps.spent(), calls: 0, produced };
}
