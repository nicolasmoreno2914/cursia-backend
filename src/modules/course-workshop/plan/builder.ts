/**
 * r107 B5 · Arma el PLAN: por pedido resuelto → contenido nuevo (IA, si hace falta) → operación del motor con sus
 * parámetros resueltos → PRUEBA EN SECO con el motor de B4 sobre el original (el plan solo ofrece lo que el motor puede
 * aplicar) → antes / después del informe de cambios, riesgo, costo, avisos de desalineación.
 *
 * La IA entra solo por `AiInvoke` (el servicio pone la compuerta de saldo, el ledger y el cliente; las pruebas, uno
 * simulado). Reintento de contenido: UNA vez, con la lista de problemas (validación propia o rechazo del motor por
 * contenido inválido / hallazgos nuevos); si tampoco sirve, el pedido queda `failed` con el motivo visible.
 *
 * Puro (sin base ni red): abre el original en memoria, nunca lo modifica.
 */
import { MbzPackage, openMbz } from '../mbz-reader';
import { WorkshopFamily, builderLineOf, familyOf, readPackageFacts } from '../identify';
import { WorkshopActivity, WorkshopCourse, WorkshopHtmlField, plainText } from '../course-model';
import { buildInventory } from '../inventory';
import { DiagnosisReport, runTechnicalDiagnosis } from '../diagnosis/diagnose';
import { applyPatchPlan, PATCH_ENGINE_VERSION } from '../patch/engine';
import { libroHeadingTitle, libroStructure } from '../patch/op-libro';
import type { FieldChange, NewQuestion, PatchOperation, PatchResult } from '../patch/types';
import { xmlUnescape } from '../../visual-design/preview-extract';
import type { DryRunPricing } from '../../pedagogy/dry-run';
import type { WorkshopAiResult, WorkshopTool } from './ai';
import { WORKSHOP_INTERPRET_MAX_TOKENS, WORKSHOP_QUESTION_MAX_TOKENS, htmlMaxTokens, libroMaxTokens } from './ai';
import { AiCallKind, WorkshopPricing, ZERO_MEM, estimateAiCall, estimateLater, memOf, modelOf, priceMeasured, sumUsd } from './cost';
import { llmCallUpperBoundUsage } from '../../finops/llm-usage-ingest';
import { decideRunSpend } from '../../finops/run-spend-guard';
import { parseSafetyCapFactor, readSafetyCapFactor, safetyCapOf } from '../../finops/safety-cap';
import { htmlProblems, libroProblems, questionFrom, questionText } from './content';
import { InterpretationOutputError, answerRequest, parseInterpretation, resolveRequest } from './interpret';
import { SearchDoc, misalignmentWarnings, searchDocs } from './misalignment';
import {
  CONTENT_SYSTEM, INTERPRET_SYSTEM, htmlTool, htmlUser, interpretTool, interpretUser, libroTool, libroUser, questionTool, questionUser, reinterpretUser,
} from './prompts';
import { requiresItemConfirm, riskOf } from './risk';
import { activityLabel, activityOf, chapterPlainText, inventorySummary } from './summary';
import { ClarifyAnswer, InterpretedRequest, MisalignmentWarning, PLAN_LIMITS, PlanItemView, RequestOperation } from './types';
import { isPaidOperation, isRegenOperation, ProducedRegen, RegenError, RegenExternal, RegenerateOp } from '../regenerate/types';
import { isChapterOperation } from '../regenerate/chapter-types';
import { chapterEstimateView, prepareChapterItem } from './chapter-item';
import type { PaidCallGate, RegenProviders } from '../regenerate/ports';
import type { RegenDbSources } from '../regenerate/sources';
import type { RegenPlannedCall } from '../regenerate/estimate';
import { OP_ES, beforeFacts, produceRegen, regenEstimate, resolveRegen } from '../regenerate/produce';
import { producedSummary } from '../regenerate/bundle';
import { createHash } from 'crypto';
import { LibroV3Source, regenerateLibroV3Pdf } from '../apply/libro-v3';
import { buildDynamicMbzV3 } from '../../../package/dynamic-mbz-builder-v3';
import { libroMdProblems } from './content';
import { libroMdTool, libroMdUser } from './prompts';

// ─── IA ────────────────────────────────────────────────────────────────────

export interface AiCall {
  purpose: 'interpret' | 'content' | 'quality' | 'question';
  kind: AiCallKind;
  system: string;
  user: string;
  tool: WorkshopTool;
  maxTokens: number;
  /** Tamaño de lo que se manda (para el estimado y la compuerta de saldo). */
  size: { promptChars: number; outputChars?: number; chapters?: number };
  /** 1 = principal, 2 = reintento por validación. */
  attempt: number;
}
/** Llamada a la IA con compuerta de saldo + ledger (servicio) o simulada (pruebas). Devuelve lo medido y su costo. */
export type AiInvoke = (call: AiCall) => Promise<{ result: WorkshopAiResult; costUsd: string }>;

/** Error de IA que corta el proceso con motivo visible (sin saldo, proveedor caído, kill switch). */
export class AiUnavailableError extends Error {
  constructor(readonly code: string, message: string, readonly extra: Record<string, unknown> = {}) { super(message); }
}

// ─── Contexto ──────────────────────────────────────────────────────────────

export interface BuildCtx {
  original: Buffer;
  filename: string | null;
  pkg: MbzPackage;
  course: WorkshopCourse;
  family: WorkshopFamily;
  builderLine: string;
  pricing: WorkshopPricing;
  baseline: { originalSha1: string; report: DiagnosisReport } | null;
  docs: SearchDoc[] | null;
  originalSha1: string;
  /** r107 B10: fuente de la base para rehacer actividades (curso identificado) y el modelo de voz fijado por Cursia. */
  regenDb?: RegenDbSources | null;
  /** Carga perezosa de `regenDb` (el servicio la pone: solo se consulta la base si hay algo que rehacer). */
  regenDbLoader?: (() => Promise<RegenDbSources | null>) | null;
  ttsModel?: string;
  /** r107 B10 · Libro v3 (PDF): la entrada del builder del curso (perezosa; la resuelve el servidor). */
  libroV3Loader?: (() => Promise<LibroV3Source | { unavailable: string }>) | null;
  libroV3?: LibroV3Source | { unavailable: string };
}

async function libroV3Of(ctx: BuildCtx): Promise<LibroV3Source | { unavailable: string }> {
  if (ctx.libroV3 === undefined) ctx.libroV3 = ctx.libroV3Loader ? await ctx.libroV3Loader() : { unavailable: 'El Libro Guía es un PDF y la fuente del curso (el texto de cada capítulo con el que se armó) no está disponible en este proceso.' };
  return ctx.libroV3;
}

/** Fuente de la base para rehacer (perezosa y cacheada en el contexto). */
export async function regenDbOf(ctx: BuildCtx): Promise<RegenDbSources | null> {
  if (ctx.regenDb === undefined && ctx.regenDbLoader) ctx.regenDb = await ctx.regenDbLoader();
  return ctx.regenDb ?? null;
}

export async function openBuildCtx(original: Buffer, opts: { filename?: string | null; originalSha1: string; pricing: WorkshopPricing; baseline?: { originalSha1: string; report: DiagnosisReport } | null }): Promise<BuildCtx> {
  const pkg = await openMbz(original);
  const facts = await readPackageFacts(pkg, opts.filename ?? null);
  const family = familyOf(facts);
  const builderLine = builderLineOf(facts);
  const course = await buildInventory(pkg, { family, builderLine });
  return { original, filename: opts.filename ?? null, pkg, course, family, builderLine, pricing: opts.pricing, baseline: opts.baseline ?? null, docs: null, originalSha1: opts.originalSha1 };
}

async function baselineOf(ctx: BuildCtx) {
  if (!ctx.baseline) {
    const report = await runTechnicalDiagnosis({ pkg: ctx.pkg, packageBytes: ctx.original, family: ctx.family, builderLine: ctx.builderLine, builderVersion: null }, { prevalidateFixes: false });
    ctx.baseline = { originalSha1: ctx.originalSha1, report };
  }
  return ctx.baseline;
}
async function read(ctx: BuildCtx, entry: string): Promise<Buffer | null> {
  return ctx.pkg.has(entry) ? ctx.pkg.readEntry(entry) : null;
}
async function docsOf(ctx: BuildCtx): Promise<SearchDoc[]> {
  if (!ctx.docs) ctx.docs = await searchDocs(ctx.course, (e) => read(ctx, e));
  return ctx.docs;
}

export async function dryRun(ctx: BuildCtx, operations: PatchOperation[]): Promise<PatchResult> {
  return applyPatchPlan({ original: ctx.original, filename: ctx.filename, operations, baseline: await baselineOf(ctx) });
}

// ─── Interpretación ────────────────────────────────────────────────────────

export interface InterpretOutcome {
  ok: boolean;
  requests: InterpretedRequest[];
  /** Motivo visible si no sirvió (tras el reintento). */
  reason: string | null;
  problems: string[];
  spentUsd: string;
  calls: number;
}

async function interpretLoop(ctx: BuildCtx, ai: AiInvoke, make: (retry: string[] | null) => string, quoteSource: string, single: boolean, evidenceText?: string): Promise<InterpretOutcome> {
  let spent = '0';
  let calls = 0;
  let problems: string[] = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    const user = make(attempt === 2 ? problems : null);
    const { result, costUsd } = await ai({ purpose: 'interpret', kind: 'interpret', system: INTERPRET_SYSTEM, user, tool: interpretTool(), maxTokens: WORKSHOP_INTERPRET_MAX_TOKENS, size: { promptChars: user.length + INTERPRET_SYSTEM.length }, attempt });
    calls++;
    spent = sumUsd(spent, costUsd);
    if (result.stopReason === 'max_tokens' || result.input === null || result.input === undefined) {
      problems = [result.stopReason === 'max_tokens' ? 'la respuesta se cortó por longitud' : 'el modelo no usó la herramienta'];
      continue;
    }
    try {
      const raw = parseInterpretation(result.input, quoteSource, { single, evidenceText });
      return { ok: true, requests: raw.map((r) => resolveRequest(r, ctx.course, { requestText: evidenceText ?? quoteSource })), reason: null, problems: [], spentUsd: spent, calls };
    } catch (e) {
      if (!(e instanceof InterpretationOutputError)) throw e;
      problems = e.problems;
    }
  }
  return { ok: false, requests: [], reason: `La IA no devolvió una interpretación válida del pedido (${problems.slice(0, 3).join('; ')}). No se creó ningún pedido; vuelve a enviarlo con otras palabras.`, problems, spentUsd: spent, calls };
}

const retryNote = (problems: string[] | null) => (problems && problems.length ? `\n\nTu respuesta anterior no sirvió por esto: ${problems.slice(0, 8).join('; ')}. Corrígelo.` : '');

/** Texto del docente → pedidos estructurados (validados y resueltos contra el inventario). */
export async function interpretText(ctx: BuildCtx, text: string, ai: AiInvoke): Promise<InterpretOutcome> {
  const inventory = inventorySummary(ctx.course);
  return interpretLoop(ctx, ai, (retry) => interpretUser({ requestText: text, inventory }) + retryNote(retry), text, false);
}

/** Respuestas del docente a un pedido `needs_answer`: sin IA si las preguntas eran del servidor; si no, re-interpreta SOLO ese pedido. */
export async function answerAndResolve(ctx: BuildCtx, req: InterpretedRequest, answers: ClarifyAnswer[], ai: AiInvoke): Promise<InterpretOutcome> {
  const a = answerRequest(req, answers, ctx.course);
  if ('resolved' in a) return { ok: true, requests: [a.resolved], reason: null, problems: [], spentUsd: '0', calls: 0 };
  const inventory = inventorySummary(ctx.course);
  const previous = { operation: req.operation, instruction: req.instruction, target: req.rawTarget, questions: req.questions.map((q) => q.text) };
  // La evidencia del destino / cambio puede venir de las RESPUESTAS del docente (fix round 1, P2-3).
  const evidenceText = [req.quote, ...a.reinterpret.map((x) => x.answer)].join('\n');
  const out = await interpretLoop(ctx, ai, (retry) => reinterpretUser({ quote: req.quote, previous, qa: a.reinterpret, inventory }) + retryNote(retry), req.quote, true, evidenceText);
  if (out.ok) out.requests = out.requests.map((r) => ({ ...r, details: { ...req.details, ...r.details } }));
  return out;
}

// ─── Ítem del plan ─────────────────────────────────────────────────────────

export interface PreparedItem {
  status: 'resolved' | 'phase_later' | 'unavailable' | 'failed';
  reason: string | null;
  view: PlanItemView | null;
  spentUsd: string;
  calls: number;
}

function htmlFieldOf(course: WorkshopCourse, t: { moduleId: number | null; sectionId?: number | null; field: string }): { field: WorkshopHtmlField; activity: WorkshopActivity | null } | null {
  if (t.moduleId !== null && t.moduleId !== undefined) {
    const a = activityOf(course, t.moduleId);
    const f = a?.html.find((h) => h.field === t.field);
    return a && f ? { field: f, activity: a } : null;
  }
  const s = course.sections.find((x) => x.id === t.sectionId);
  const f = s?.html.find((h) => h.field === (t.field || 'summary')) ?? s?.html[0];
  return f ? { field: f, activity: null } : null;
}

/** Libro HTML del paquete (el archivo principal del recurso o el contenido de la página). */
async function libroHtmlOf(ctx: BuildCtx, a: WorkshopActivity): Promise<string | null> {
  if (a.modname === 'page') return a.html.find((h) => h.field === 'content')?.html ?? null;
  const main = a.files.filter((x) => x.filearea === 'content' && x.filename !== '.');
  const f = main.find((x) => /\.html?$/i.test(x.filename));
  if (!f || !f.blobPresent) return null;
  const b = await read(ctx, f.blobEntry);
  return b ? b.toString('utf8') : null;
}

const retryable = (code: string | undefined) => code === 'invalid_content' || code === 'new_findings';
const unavailableCode = (code: string | undefined) => code === 'unsupported' || code === 'unavailable' || code === 'target_not_found';

interface Candidate { op: PatchOperation; changes?: FieldChange[]; before: string; after: string; contentEstimate: ReturnType<typeof memOf> | null; notes?: string[] }

/**
 * Pedido resuelto (o de fase posterior) → ítem del plan. Nunca lanza salvo AiUnavailableError (sin saldo / IA caída:
 * el servicio corta el proceso entero con el motivo visible).
 */
export async function prepareItem(ctx: BuildCtx, req: InterpretedRequest, ai: AiInvoke, opts: { fromFinding?: boolean } = {}): Promise<PreparedItem> {
  if (req.status === 'phase_later' && req.operation) {
    const est = estimateLater(req.operation, req.details, ctx.course, ctx.pricing);
    const view: PlanItemView = {
      operation: req.operation, params: null, available: false,
      summary: `${laterEs(req.operation)} — ${req.target ? req.target.title : 'curso'} (todavía no disponible en el Taller: llega en una fase posterior).`,
      changes: [], files: [], entries: { added: [], removed: [], modified: [] },
      risk: riskOf({ operation: req.operation, target: req.target, changes: [], misalignment: [], fromFinding: !!opts.fromFinding }),
      cost: { spentUsd: '0', apply: memOf(est), contentEstimate: null, basis: `estimator ${est.estimatorVersion} · ${est.usageModelVersion} · ${ctx.pricing.source}: lo que costaría rehacerlo` },
      misalignment: [], dryRun: null, generated: true, requiresItemConfirm: false,
    };
    view.requiresItemConfirm = requiresItemConfirm(view.risk);
    return { status: 'phase_later', reason: 'Disponible en una fase posterior del Taller.', view, spentUsd: '0', calls: 0 };
  }
  if (req.status !== 'resolved' || !req.operation || !req.target) return { status: req.status === 'needs_answer' ? 'failed' : (req.status as PreparedItem['status']), reason: req.reason, view: null, spentUsd: '0', calls: 0 };
  // r107 B10: rehacer una actividad se PRODUCE con su aprobación y tope (prepareRegenItem), nunca por este camino.
  if (isPaidOperation(req.operation)) return { status: 'failed', reason: 'Rehacer una actividad o agregar un capítulo se produce con su aprobación y su tope (etapa de estimado), no al armar el plan.', view: null, spentUsd: '0', calls: 0 };

  let spent = '0';
  let calls = 0;
  const callAi = async (c: AiCall) => { const r = await ai(c); calls++; spent = sumUsd(spent, r.costUsd); return r.result; };
  let problems: string[] = [];
  let lastFailure: { code: string; message: string } | null = null;
  const needsAi = needsContent(req);
  for (let attempt = 1; attempt <= (needsAi ? 2 : 1); attempt++) {
    let cand: Candidate | { problems: string[] } | { unavailable: string };
    try {
      cand = await candidateFor(ctx, req, callAi, attempt, attempt === 2 ? problems : null);
    } catch (e) {
      if (e instanceof AiUnavailableError) throw e;
      return { status: 'failed', reason: `No se pudo preparar el cambio: ${e instanceof Error ? e.message : String(e)}`, view: null, spentUsd: spent, calls };
    }
    if ('unavailable' in cand) return { status: 'unavailable', reason: cand.unavailable, view: null, spentUsd: spent, calls };
    if ('problems' in cand) { problems = cand.problems; lastFailure = { code: 'invalid_content', message: problems.join('; ') }; continue; }
    const res = await dryRun(ctx, [cand.op]);
    if (!res.ok) {
      lastFailure = res.failure ? { code: res.failure.code, message: res.failure.message } : { code: 'invariant', message: 'el motor rechazó el cambio' };
      if (needsAi && retryable(res.failure?.code)) { problems = [`el motor de parches rechazó el contenido: ${lastFailure.message}`]; continue; }
      const st = unavailableCode(res.failure?.code) ? 'unavailable' : 'failed';
      return { status: st, reason: `El motor de parches no puede aplicar este cambio a este paquete: ${lastFailure.message}`, view: null, spentUsd: spent, calls };
    }
    const rep = res.operations[0];
    const changes = cand.changes ?? rep.fields;
    const warnings = await warningsFor(ctx, req, cand, [...(cand.notes ?? []), ...rep.misalignment]);
    const view: PlanItemView = {
      operation: req.operation,
      params: cand.op,
      available: true,
      summary: rep.summary || summaryOf(req),
      changes,
      files: rep.files.map((f) => ({ filename: f.filename, before: f.before.contenthash, after: f.after.contenthash })),
      entries: { added: rep.entriesAdded, removed: rep.entriesRemoved, modified: rep.entriesModified },
      risk: riskOf({ operation: req.operation, target: req.target, changes, misalignment: warnings, fromFinding: !!opts.fromFinding, params: cand.op }),
      cost: { spentUsd: spent, apply: ZERO_MEM, contentEstimate: cand.contentEstimate, basis: needsAi ? 'contenido generado al armar el plan: aplicar no vuelve a usar IA' : 'cambio estructural: no usa IA' },
      misalignment: warnings,
      dryRun: { ok: true, failure: null, resolved: res.diagnosis?.resolved.length ?? 0, removed: res.diagnosis?.removed.length ?? 0, engineVersion: PATCH_ENGINE_VERSION },
      generated: true,
      requiresItemConfirm: false,
    };
    view.requiresItemConfirm = requiresItemConfirm(view.risk);
    return { status: 'resolved', reason: null, view, spentUsd: spent, calls };
  }
  return { status: 'failed', reason: `La IA no produjo un contenido válido tras el reintento (${(lastFailure?.message ?? problems.join('; ')).slice(0, 400)}). No se agregó al plan.`, view: null, spentUsd: spent, calls };
}

function laterEs(op: RequestOperation): string {
  return ({ regenerate_scorm: 'Rehacer el juego', regenerate_video: 'Rehacer el video', regenerate_gamma: 'Rehacer la presentación', regenerate_audio: 'Rehacer el audio', add_chapter: 'Agregar capítulo', add_module: 'Agregar módulo' } as Record<string, string>)[op] ?? op;
}
function summaryOf(req: InterpretedRequest): string {
  return `${req.operation} — ${req.target?.title ?? ''}`;
}

function needsContent(req: InterpretedRequest): boolean {
  // r107 B10: rehacer una actividad siempre necesita proveedores pagos (se produce con aprobación y tope).
  if (isPaidOperation(req.operation)) return true;
  switch (req.operation) {
    case 'edit_html': return !req.details.fixedChange && !req.details.deadLink;
    case 'edit_libro_section': case 'exam_question_replace': case 'exam_question_add': return true;
    default: return false;
  }
}

async function candidateFor(ctx: BuildCtx, req: InterpretedRequest, callAi: (c: AiCall) => Promise<WorkshopAiResult>, attempt: number, retry: string[] | null): Promise<Candidate | { problems: string[] } | { unavailable: string }> {
  const t = req.target!;
  const note = retryNote(retry);
  const toolInput = (r: WorkshopAiResult): unknown | { problems: string[] } => (r.stopReason === 'max_tokens' ? { problems: ['la respuesta se cortó por longitud'] } : r.input === null || r.input === undefined ? { problems: ['el modelo no usó la herramienta'] } : r.input);
  const isProblems = (x: unknown): x is { problems: string[] } => !!x && typeof x === 'object' && Array.isArray((x as { problems?: unknown }).problems) && Object.keys(x as object).length === 1;
  switch (req.operation) {
    case 'edit_html': {
      if (t.kind !== 'html') return { unavailable: 'destino inválido' };
      const loc = htmlFieldOf(ctx.course, t);
      if (!loc) return { unavailable: 'El campo ya no está en el paquete.' };
      const target = t.moduleId !== null ? { moduleId: t.moduleId, field: t.field } : { sectionId: t.sectionId as number, field: 'summary' as const };
      const expect = req.details.expectRawSha1 ?? loc.field.rawSha1;
      if (req.details.fixedChange) return { op: { op: 'edit_html', target, expectRawSha1: expect, change: req.details.fixedChange }, before: plainText(loc.field.html, 100_000), after: '', contentEstimate: null };
      if (req.details.deadLink) {
        const d = req.details.deadLink;
        const b = await read(ctx, d.entry);
        if (!b) return { unavailable: 'El campo ya no está en el paquete.' };
        const rawLink = b.subarray(d.fieldRawOffset + d.rawByteOffset, d.fieldRawOffset + d.rawByteOffset + d.rawBytes).toString('utf8');
        const text = xmlUnescape(rawLink).replace(/<[^>]+>/g, '');
        return { op: { op: 'edit_html', target, expectRawSha1: expect, change: { kind: 'range', rawByteOffset: d.rawByteOffset, rawBytes: d.rawBytes, html: text } }, before: '', after: '', contentEstimate: null };
      }
      const where = loc.activity ? activityLabel(loc.activity) : 'presentación de una sección';
      const chapterText = chapterPlainText(ctx.course, t.chapterNumber, PLAN_LIMITS.chapterContextChars);
      const user = htmlUser({ instruction: req.instruction, quote: req.quote, currentHtml: loc.field.html, where, chapterText, forbiddenTokens: req.details.forbiddenTokens ?? [] }) + note;
      const size = { promptChars: user.length + CONTENT_SYSTEM.length, outputChars: loc.field.html.length };
      const est = memOf(estimateAiCall('content_html', size, ctx.pricing));
      const r = await callAi({ purpose: 'content', kind: 'content_html', system: CONTENT_SYSTEM, user, tool: htmlTool(), maxTokens: htmlMaxTokens(loc.field.html.length), size, attempt });
      const input = toolInput(r);
      if (isProblems(input)) return input;
      const keys = input && typeof input === 'object' ? Object.keys(input as object) : [];
      const html = (input as { html?: unknown }).html;
      const p = [...(keys.some((k) => k !== 'html') ? ['la salida trae claves desconocidas'] : []), ...htmlProblems(html, loc.field.html, { forbiddenTokens: req.details.forbiddenTokens, allowFiles: req.details.allowFiles })];
      if (p.length) return { problems: p };
      return { op: { op: 'edit_html', target, expectRawSha1: expect, change: { kind: 'replace', html: html as string } }, before: plainText(loc.field.html, 100_000), after: plainText(html as string, 100_000), contentEstimate: est };
    }
    case 'edit_libro_section': {
      if (t.kind !== 'libro') return { unavailable: 'destino inválido' };
      if (t.pdf) return candidateLibroV3(ctx, req, callAi, attempt, retry);
      const a = activityOf(ctx.course, t.moduleId);
      if (!a) return { unavailable: 'El Libro Guía ya no está en el paquete.' };
      const html = await libroHtmlOf(ctx, a);
      if (html === null) return { unavailable: 'El Libro Guía no es un HTML que el Taller pueda editar (o no viene en el paquete).' };
      const st = libroStructure(html);
      const complete = new Map(st.chapters.filter((c) => c.complete).map((c) => [c.number, c]));
      const intact = /<\/html>\s*$/i.test(html);
      // Libro cortado: hay que dar TODOS los capítulos que el corte se llevó (los del curso que no quedaron completos).
      let numbers = t.chapters;
      if (t.recompose || !intact) numbers = [...new Set([...t.chapters, ...ctx.course.chapters.map((c) => c.number).filter((n) => !complete.has(n))])].sort((x, y) => x - y);
      if (!numbers.length) return { unavailable: 'El Libro Guía ya tiene todos sus capítulos completos: no hay nada que recomponer.' };
      const titleOf = (n: number) => ctx.course.chapters.find((c) => c.number === n)?.title ?? `Capítulo ${n}`;
      const chapters: Array<{ number: number; title: string; currentHtml: string | null; context: string }> = [];
      for (const n of numbers) {
        const c = complete.get(n);
        const src = ctx.course.chapters.find((x) => x.number === n);
        // Fuente DENTRO del paquete (builders viejos: libro_guia/libro_capN.md): el mejor contexto para reescribirlo.
        let md = '';
        for (const e of src?.packageSources ?? []) if (/\.md$/i.test(e)) { const b = await read(ctx, e); if (b) md += `${b.toString('utf8')}\n`; }
        const context = [md, chapterPlainText(ctx.course, n, PLAN_LIMITS.chapterContextChars)].filter(Boolean).join('\n').slice(0, PLAN_LIMITS.chapterContextChars) || (src?.title ?? '');
        chapters.push({ number: n, title: titleOf(n), currentHtml: c ? html.slice(c.headEnd, c.bodyEnd) : null, context });
      }
      const user = libroUser({ instruction: req.instruction, quote: req.quote, chapters }) + note;
      const size = { promptChars: user.length + CONTENT_SYSTEM.length, chapters: chapters.length };
      const est = memOf(estimateAiCall('content_libro', size, ctx.pricing));
      const r = await callAi({ purpose: 'content', kind: 'content_libro', system: CONTENT_SYSTEM, user, tool: libroTool(), maxTokens: libroMaxTokens(chapters.length), size, attempt });
      const input = toolInput(r);
      if (isProblems(input)) return input;
      const v = libroProblems(input, numbers);
      if (v.problems.length) return { problems: v.problems };
      const byN = new Map(v.chapters.map((c) => [c.number, c.html]));
      const front = intact ? null : frontFor(ctx, html, st);
      const op: PatchOperation = { op: 'edit_libro_section', moduleId: a.moduleId, chapters: numbers.map((n) => ({ number: n, html: byN.get(n)!, ...(complete.has(n) ? { expectTitle: libroHeadingTitle(html, complete.get(n)!) } : { title: titleOf(n) }) })), ...(front ? { front: front.front } : {}) };
      const changes: FieldChange[] = numbers.map((n) => ({ entry: a.dir, field: `libro:capitulo ${n}`, moduleId: a.moduleId, sectionId: null, before: chapters.find((c) => c.number === n)!.currentHtml ?? '', after: byN.get(n)!, beforeRawSha1: '', afterRawSha1: '' }));
      return { op, changes, before: chapters.map((c) => plainText(c.currentHtml ?? '', 100_000)).join('\n'), after: v.chapters.map((c) => plainText(c.html, 100_000)).join('\n'), contentEstimate: est, notes: front ? [front.note] : [] };
    }
    case 'exam_question_replace': case 'exam_question_add': {
      const quizId = t.kind === 'question' ? t.quizModuleId : t.kind === 'exam' ? t.quizModuleId : null;
      const quiz = activityOf(ctx.course, quizId);
      if (!quiz || !quiz.exam) return { unavailable: 'El examen ya no está en el paquete.' };
      const q = t.kind === 'question' ? quiz.exam.questions.find((x) => x.id === t.questionId) ?? null : null;
      if (t.kind === 'question' && !q) return { unavailable: 'La pregunta ya no está en el examen.' };
      const chapter = q?.chapterNumber ?? null;
      const user = questionUser({ instruction: req.instruction, quote: req.quote, exam: quiz.title, current: q ? questionText(q) : null, chapterText: chapterPlainText(ctx.course, chapter, PLAN_LIMITS.chapterContextChars) }) + note;
      const size = { promptChars: user.length + CONTENT_SYSTEM.length };
      const est = memOf(estimateAiCall('content_question', size, ctx.pricing));
      const r = await callAi({ purpose: 'content', kind: 'content_question', system: CONTENT_SYSTEM, user, tool: questionTool(), maxTokens: WORKSHOP_QUESTION_MAX_TOKENS, size, attempt });
      const input = toolInput(r);
      if (isProblems(input)) return input;
      const v = questionFrom(input);
      if (!v.question) return { problems: v.problems };
      const after = questionPlain(v.question);
      if (req.operation === 'exam_question_replace') {
        return { op: { op: 'exam_question_replace', quizModuleId: quiz.moduleId, questionId: q!.id, question: v.question }, before: q ? plainText(questionText(q), 10_000) : '', after, contentEstimate: est };
      }
      const cats = [...new Set(quiz.exam.questions.filter((x) => x.qtype !== 'random' && x.categoryId !== null).map((x) => x.categoryId as number))];
      const random = quiz.exam.questions.some((x) => x.qtype === 'random');
      const categoryId = random ? (cats.length === 1 ? cats[0] : undefined) : undefined;
      return { op: { op: 'exam_question_add', quizModuleId: quiz.moduleId, question: v.question, ...(categoryId !== undefined ? { categoryId } : {}) }, changes: [{ entry: 'questions.xml', field: 'pregunta nueva', moduleId: quiz.moduleId, sectionId: null, before: '', after: v.question.text, beforeRawSha1: '', afterRawSha1: '' }], before: '', after, contentEstimate: est };
    }
    case 'exam_question_remove': {
      if (t.kind !== 'question') return { unavailable: 'destino inválido' };
      return { op: { op: 'exam_question_remove', quizModuleId: t.quizModuleId, questionId: t.questionId }, before: '', after: '', contentEstimate: null };
    }
    case 'brand_replace': {
      const colors = Object.fromEntries((req.details.colors ?? []).map((c) => [c.from, c.to]));
      if (!Object.keys(colors).length) return { unavailable: 'Faltan los colores (de #hex a #hex).' };
      return { op: { op: 'brand_replace', colors }, before: '', after: '', contentEstimate: null };
    }
    case 'remove_activity': {
      if (t.kind !== 'activity') return { unavailable: 'destino inválido' };
      return { op: { op: 'remove_activity', moduleId: t.moduleId }, before: '', after: '', contentEstimate: null };
    }
    default:
      return { unavailable: 'Operación fuera del catálogo de esta fase.' };
  }
}

/**
 * r107 B10 · Libro v3 (PDF): la IA reescribe el MARKDOWN del capítulo (la fuente del curso); el PDF lo arma el builder
 * existente con esa fuente — solo si con la fuente sin cambios reproduce byte a byte el PDF del original (regla de B6).
 */
async function candidateLibroV3(ctx: BuildCtx, req: InterpretedRequest, callAi: (c: AiCall) => Promise<WorkshopAiResult>, attempt: number, retry: string[] | null): Promise<Candidate | { problems: string[] } | { unavailable: string }> {
  const t = req.target as Extract<InterpretedRequest['target'], { kind: 'libro' }>;
  const a = activityOf(ctx.course, t.moduleId);
  if (!a) return { unavailable: 'El Libro Guía ya no está en el paquete.' };
  const src = await libroV3Of(ctx);
  if ('unavailable' in src) return { unavailable: src.unavailable };
  const numbers = [...t.chapters];
  const current = new Map<number, string>();
  for (const n of numbers) {
    const id = src.chapterIdByNumber.get(n);
    const md = id ? src.buildInput.contents.contentMd.get(id) : undefined;
    if (typeof md !== 'string') return { unavailable: `El capítulo ${n} no está en la fuente del curso (¿capítulo de práctica?).` };
    current.set(n, md);
  }
  const titleOf = (n: number) => ctx.course.chapters.find((c) => c.number === n)?.title ?? `Capítulo ${n}`;
  const user = libroMdUser({ instruction: req.instruction, quote: req.quote, chapters: numbers.map((n) => ({ number: n, title: titleOf(n), md: current.get(n) as string })) }) + retryNote(retry);
  const size = { promptChars: user.length + CONTENT_SYSTEM.length, chapters: numbers.length };
  const est = memOf(estimateAiCall('content_libro', size, ctx.pricing));
  const r = await callAi({ purpose: 'content', kind: 'content_libro', system: CONTENT_SYSTEM, user, tool: libroMdTool(), maxTokens: libroMaxTokens(numbers.length), size, attempt });
  if (r.stopReason === 'max_tokens') return { problems: ['la respuesta se cortó por longitud'] };
  if (r.input === null || r.input === undefined) return { problems: ['el modelo no usó la herramienta'] };
  const v = libroMdProblems(r.input, numbers, current);
  if (v.problems.length) return { problems: v.problems };
  const regen = await regenerateLibroV3Pdf(ctx.original, src, v.chapters, (i) => buildDynamicMbzV3(i));
  if (regen.ok !== true) {
    const f = regen as { code: string; reason: string };
    return f.code === 'build_failed' ? { problems: [`el builder no pudo armar el Libro con ese texto: ${f.reason}`] } : { unavailable: f.reason };
  }
  const op: PatchOperation = { op: 'edit_libro_section', moduleId: a.moduleId, chapters: numbers.map((n) => ({ number: n, html: '' })), libroV3: { chapters: v.chapters }, pdf: { base64: regen.pdf.toString('base64'), previousSha1: regen.previousSha1 } };
  const byN = new Map(v.chapters.map((c) => [c.number, c.md]));
  const changes: FieldChange[] = numbers.map((n) => ({ entry: a.dir, field: `libro:capitulo ${n}`, moduleId: a.moduleId, sectionId: null, before: current.get(n) as string, after: byN.get(n) as string, beforeRawSha1: '', afterRawSha1: '' }));
  return { op, changes, before: numbers.map((n) => current.get(n)).join('\n'), after: v.chapters.map((c) => c.md).join('\n'), contentEstimate: est, notes: [`El Libro Guía en PDF se arma de nuevo con el builder (capítulo(s) ${numbers.join(', ')}); el Libro en línea (mod_book) no cambia solo.`] };
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Libro cortado ANTES del primer capítulo (el caso del bug #7: el corte cae en la imagen base64 de la portada): el motor
 * no recompone sin portada (`front`). Se conserva el <head> original si llegó completo (estilos) y se rehace una portada
 * SIMPLE con el título del curso — visible como aviso en el plan (no es la portada original: sin el logo).
 */
function frontFor(ctx: BuildCtx, html: string, st: ReturnType<typeof libroStructure>): { front: { headHtml: string; coverHtml: string }; note: string } | null {
  const first = st.chapters[0];
  const head = first ? html.slice(0, first.blockStart) : html;
  if (first && /<\/head\s*>/i.test(head) && /<body\b[^>]*>/i.test(head)) return null;
  const title = ctx.course.course.title ?? 'Curso';
  const origHead = /<head\b[^>]*>([\s\S]*?)<\/head\s*>/i.exec(html)?.[1];
  const headHtml = origHead && !/<script\b/i.test(origHead) ? origHead : `<meta charset="utf-8"><title>${esc(title)} — Libro Guía</title>`;
  const coverHtml = `<div style="text-align:center;padding:48px 16px"><h1>Libro Guía</h1><h2>${esc(title)}</h2></div>`;
  return { front: { headHtml, coverHtml }, note: 'La portada original del Libro Guía se perdió en el corte: se rehace una portada simple con el título del curso (sin el logo ni el índice originales). Revísala antes de aplicar.' };
}

function questionPlain(q: NewQuestion): string {
  return q.qtype === 'multichoice' ? [plainText(q.text, 2000), ...q.answers.map((a) => plainText(a.html, 500))].join('\n') : plainText(q.text, 2000);
}

async function warningsFor(ctx: BuildCtx, req: InterpretedRequest, cand: Candidate, engineNotes: string[]): Promise<MisalignmentWarning[]> {
  const ws = misalignmentWarnings({ course: ctx.course, operation: req.operation!, target: req.target!, before: cand.before, after: cand.after, docs: await docsOf(ctx), engineNotes });
  // Costo de cada aviso como pedido aparte (estimator): contenido nuevo de la actividad, o rehacerla.
  for (const w of ws) {
    if (!w.suggestedOperation || !w.activity) continue;
    if (w.suggestedOperation === 'edit_html') {
      const a = activityOf(ctx.course, w.activity.moduleId);
      const len = a?.html.reduce((s, h) => s + h.html.length, 0) ?? 2000;
      w.estimate = memOf(estimateAiCall('content_html', { promptChars: len + 3000, outputChars: len }, ctx.pricing));
    } else if (w.suggestedOperation === 'exam_question_replace') w.estimate = memOf(estimateAiCall('content_question', { promptChars: 3000 }, ctx.pricing));
    else if (w.suggestedOperation === 'edit_libro_section') w.estimate = memOf(estimateAiCall('content_libro', { promptChars: 12_000, chapters: 1 }, ctx.pricing));
    else w.estimate = memOf(estimateLater(w.suggestedOperation, w.suggestedOperation === 'regenerate_audio' ? { audioTarget: activityOf(ctx.course, w.activity.moduleId)?.kind === 'welcome_audio' ? 'welcome' : 'audiobook' } : {}, ctx.course, ctx.pricing));
  }
  return ws;
}

// ─── Estimado ANTES de gastar (ronda de decisiones: la IA solo corre con una aprobación y su tope) ─────────────

/** Una llamada planeada: su estimado (estimator) y su COTA (entrada completa + max_tokens de salida, como el proxy). */
export interface PlannedCall { model: string; kind: AiCallKind; promptChars: number; maxTokens: number; size: AiCall['size']; expectedUsd: string; boundUsd: string }

class EstimateOnly extends Error { constructor(readonly call: AiCall) { super('estimate-only'); } }

export function plannedCallOf(call: Pick<AiCall, 'kind' | 'size' | 'maxTokens'>, pricing: WorkshopPricing): PlannedCall {
  return { model: modelOf(pricing), kind: call.kind, promptChars: call.size.promptChars, maxTokens: call.maxTokens, size: call.size, expectedUsd: estimateAiCall(call.kind, call.size, pricing).totals.expected, boundUsd: callBoundUsd(call.size.promptChars, call.maxTokens, pricing) };
}

/** Lo que costaría interpretar este texto (la primera llamada; el reintento por validación lo cubre el margen). */
export function estimateInterpretation(ctx: Pick<BuildCtx, 'course' | 'pricing'>, text: string): PlannedCall {
  const user = interpretUser({ requestText: text, inventory: inventorySummary(ctx.course) });
  return plannedCallOf({ kind: 'interpret', size: { promptChars: user.length + INTERPRET_SYSTEM.length }, maxTokens: WORKSHOP_INTERPRET_MAX_TOKENS }, ctx.pricing);
}
export function estimateReinterpretation(ctx: Pick<BuildCtx, 'course' | 'pricing'>, req: InterpretedRequest, answersChars: number): PlannedCall {
  const promptChars = inventorySummary(ctx.course).length + req.quote.length + answersChars + 2_000 + INTERPRET_SYSTEM.length;
  return plannedCallOf({ kind: 'interpret', size: { promptChars }, maxTokens: WORKSHOP_INTERPRET_MAX_TOKENS }, ctx.pricing);
}

/**
 * ¿Este pedido necesita IA para su contenido? Si sí, la llamada EXACTA que se haría (el mismo prompt que armaría
 * `prepareItem`, sin llamar a nadie) con su estimado y su cota. null = no necesita IA (estructural).
 */
export async function estimateContent(ctx: BuildCtx, req: InterpretedRequest): Promise<PlannedCall | null | { unavailable: string }> {
  if (req.status !== 'resolved' || !needsContent(req)) return null;
  if (isRegenOperation(req.operation)) return estimateRegenItem(ctx, req);
  // r107 B11: agregar capítulo / módulo — la vista del estimado se arma acá (necesita el molde del paquete).
  if (isChapterOperation(req.operation)) {
    // P2-1: la MISMA fuente de la base que la producción (mismos prompts → misma cota).
    await regenDbOf(ctx);
    const v = await chapterEstimateView(ctx, req);
    if ('unavailable' in v) return v;
    CHAPTER_VIEWS.set(v.plannedCall as PlannedCall, v);
    return v.plannedCall as PlannedCall;
  }
  try {
    const r = await candidateFor(ctx, req, async (c) => { throw new EstimateOnly(c); }, 1, null);
    if ('unavailable' in r) return { unavailable: r.unavailable };
    return null;
  } catch (e) {
    if (e instanceof EstimateOnly) return plannedCallOf(e.call, ctx.pricing);
    throw e;
  }
}
export { needsContent };

/** Vista del ítem en etapa de ESTIMADO: sin contenido generado, con lo que costaría generarlo (D8). */
/** r107 B11: vistas de estimado de agregar capítulo / módulo (las arma `estimateContent`). */
const CHAPTER_VIEWS = new WeakMap<PlannedCall, PlanItemView>();

export function estimateItemView(ctx: Pick<BuildCtx, 'pricing'> & Partial<Pick<BuildCtx, 'course'>>, req: InterpretedRequest, call: PlannedCall, opts: { fromFinding?: boolean } = {}): PlanItemView {
  const cv = CHAPTER_VIEWS.get(call);
  if (cv) return cv;
  if ((call as unknown as RegenPlannedCall).kind === 'regenerate') return regenEstimateView(ctx as BuildCtx, req, call as unknown as RegenPlannedCall, opts);
  const est = memOf(estimateAiCall(call.kind, call.size, ctx.pricing));
  const risk = riskOf({ operation: req.operation!, target: req.target, changes: [], misalignment: [], fromFinding: !!opts.fromFinding });
  return {
    operation: req.operation!, params: null, available: true, requiresItemConfirm: requiresItemConfirm(risk),
    summary: `${summaryOf(req)} — el contenido nuevo se genera cuando apruebes su costo.`,
    changes: [], files: [], entries: { added: [], removed: [], modified: [] },
    risk,
    cost: { spentUsd: '0', apply: ZERO_MEM, contentEstimate: est, basis: 'estimado ANTES de generar (estimator de FinOps); la IA corre solo con tu aprobación y su tope' },
    misalignment: [], dryRun: null, generated: false, plannedCall: call,
  };
}

/** Cota USD de una llamada: entrada completa como escritura de caché (lo más caro) + max_tokens de salida. */
export function callBoundUsd(promptChars: number, maxTokens: number, pricing: WorkshopPricing): string {
  const u = llmCallUpperBoundUsage(promptChars, maxTokens);
  // Fix round 1 (P2-1): con el modelo REAL del Taller; sin precio → ModelUnpricedError (no se llama).
  return priceMeasured({ cache_creation_input_tokens: u.cache_write_tokens, output_tokens: u.output_tokens }, modelOf(pricing), pricing);
}

/**
 * Tope propuesto para aprobar = estimado + margen: el mayor entre (a) el tope de seguridad de FinOps (esperado ×
 * factor) y (b) la suma de las COTAS de las llamadas principales (el tope tiene que alcanzar al menos para hacerlas).
 * Redondeado hacia arriba al centavo.
 */
export function proposedCapOf(calls: PlannedCall[], capFactor?: number): { expectedUsd: string; boundUsd: string; proposedCapUsd: string } {
  const expected = sumUsd('0', ...calls.map((c) => c.expectedUsd));
  // r107 B10: una regeneración tiene varias llamadas principales (salas, trozos de voz…): cuenta la suma de sus cotas.
  const bound = sumUsd('0', ...calls.map((c) => (c as unknown as RegenPlannedCall).regen?.totalBoundUsd ?? c.boundUsd));
  const safety = Number(safetyCapOf(expected, parseSafetyCapFactor(capFactor ?? readSafetyCapFactor())));
  const cap = Math.ceil(Math.max(safety, Number(bound)) * 100 - 1e-9) / 100;
  return { expectedUsd: expected, boundUsd: bound, proposedCapUsd: cap.toFixed(2) };
}

/**
 * Guarda del tope aprobado ANTES de cada llamada (regla 1 de run-spend-guard: gastado + cota de esta llamada ≤
 * autorizado). Lo que no entra NO se llama: se corta limpio con el motivo visible.
 */
export function capDecision(spentUsd: string, call: Pick<AiCall, 'size' | 'maxTokens'>, capUsd: string, pricing: WorkshopPricing) {
  const bound = Number(callBoundUsd(call.size.promptChars, call.maxTokens, pricing));
  return decideRunSpend({ authorizedBudget: Number(capUsd), runSpent: Number(spentUsd), nextCost: bound, itemSpent: null, itemExpected: null, itemEstimatedMax: null, runExpected: null, progressExpected: null });
}

/** Prueba en seco del plan COMBINADO (todas las operaciones disponibles, en orden): el plan entero tiene que aplicar. */
export async function combinedDryRun(ctx: BuildCtx, ops: PatchOperation[]): Promise<{ ok: boolean; failure: { opIndex: number | null; code: string; message: string } | null; resolved: number; operations: number }> {
  if (!ops.length) return { ok: true, failure: null, resolved: 0, operations: 0 };
  const r = await dryRun(ctx, ops);
  return { ok: r.ok, failure: r.failure ? { opIndex: r.failure.opIndex, code: r.failure.code, message: r.failure.message } : null, resolved: r.diagnosis?.resolved.length ?? 0, operations: ops.length };
}


// ─── r107 B10 · Fase 3: rehacer una actividad (proveedores pagos, con aprobación y tope) ────────────────────────────

const regenReader = (ctx: BuildCtx) => (e: string) => read(ctx, e);
const wid = (...xs: unknown[]) => createHash('sha1').update(JSON.stringify(xs)).digest('hex').slice(0, 16);

/** Estimado por proveedor ANTES de producir (sin gastar): destino + fuente + estimator. */
async function estimateRegenItem(ctx: BuildCtx, req: InterpretedRequest): Promise<PlannedCall | { unavailable: string }> {
  const t = req.target;
  if (!t || t.kind !== 'activity') return { unavailable: 'destino inválido' };
  const db = await regenDbOf(ctx);
  const res = await resolveRegen({ course: ctx.course, read: regenReader(ctx), op: req.operation as any, moduleId: t.moduleId, instruction: req.instruction, audioTarget: req.details.audioTarget ?? null, db });
  if ('unavailable' in res) return res;
  let call: RegenPlannedCall;
  try {
    call = regenEstimate(res, ctx.course, ctx.pricing, ctx.ttsModel ?? 'gpt-4o-mini-tts-2025-03-20', db);
  } catch (e) {
    return { unavailable: `No se puede estimar el costo (${e instanceof Error ? e.message.slice(0, 200) : String(e)}). No se llama a ningún proveedor.` };
  }
  (call.regen as any).before = beforeFacts(res.target);
  // P1-2b: el plan dice cuándo la cota de un proveedor usa un margen mayor por un precio no verificado.
  (call.regen as any).notes = [...res.notes, ...call.regen.providers.map((l) => l.note).filter((n): n is string => !!n)];
  (call.regen as any).target = { op: res.target.op, moduleId: res.target.moduleId, title: res.target.title };
  return call as unknown as PlannedCall;
}

/**
 * D7: al rehacer el VIDEO, el examen y el Libro del capítulo pueden quedar desalineados con el guion nuevo: se AVISA
 * (con su costo como pedido aparte); nunca se agregan solos.
 */
export function regenWarnings(ctx: Pick<BuildCtx, 'course' | 'pricing'>, op: RequestOperation, moduleId: number): MisalignmentWarning[] {
  const out: MisalignmentWarning[] = [];
  const a = activityOf(ctx.course, moduleId);
  const ch = a && a.placement.scope === 'chapter' ? a.placement.chapterNumber : null;
  if (op !== 'regenerate_video' || ch === null) return out;
  const libro = ctx.course.activities.find((x) => x.kind === 'libro' && !x.missingFolder) ?? null;
  if (libro) {
    out.push({
      id: wid('regen_video_libro', moduleId, libro.moduleId), kind: 'same_chapter',
      activity: { moduleId: libro.moduleId, title: libro.title, modname: libro.modname, chapterNumber: ch }, questionId: null,
      message: `El video nuevo del capítulo ${ch} tiene otro guion: el capítulo ${ch} del Libro Guía puede quedar desalineado con lo que dice el video. No se cambia solo: agrégalo como un pedido aparte si hace falta.`,
      terms: [], suggestedOperation: ctx.course.libro.find((l) => l.moduleId === libro.moduleId)?.format === 'html' ? 'edit_libro_section' : null,
      estimate: memOf(estimateAiCall('content_libro', { promptChars: 12_000, chapters: 1 }, ctx.pricing as WorkshopPricing)),
    });
  }
  const exams = ctx.course.activities.filter((x) => x.exam && !x.missingFolder);
  let n = 0;
  for (const ex of exams) {
    for (const q of ex.exam!.questions) {
      if (q.chapterNumber !== ch || n >= 5) continue;
      n++;
      out.push({
        id: wid('regen_video_exam', moduleId, ex.moduleId, q.id), kind: 'same_chapter',
        activity: { moduleId: ex.moduleId, title: ex.title, modname: ex.modname, chapterNumber: ch }, questionId: q.id,
        message: `La pregunta «${plainText(q.html, 80)}» de «${ex.title}» evalúa el capítulo ${ch}: puede quedar desalineada con el video nuevo. No se cambia sola.`,
        terms: [], suggestedOperation: 'exam_question_replace', estimate: memOf(estimateAiCall('content_question', { promptChars: 3000 }, ctx.pricing as WorkshopPricing)),
      });
    }
  }
  if (exams.length && !n) {
    const ex = exams[0];
    out.push({
      id: wid('regen_video_exam_any', moduleId, ex.moduleId), kind: 'same_chapter',
      activity: { moduleId: ex.moduleId, title: ex.title, modname: ex.modname, chapterNumber: ch }, questionId: null,
      message: `Los exámenes del curso pueden evaluar lo que decía el video anterior del capítulo ${ch}: revísalos. No se cambian solos.`,
      terms: [], suggestedOperation: null, estimate: null,
    });
  }
  return out;
}

function regenEstimateView(ctx: BuildCtx, req: InterpretedRequest, call: RegenPlannedCall, opts: { fromFinding?: boolean }): PlanItemView {
  const risk = riskOf({ operation: req.operation!, target: req.target, changes: [], misalignment: [], fromFinding: !!opts.fromFinding });
  const t = (call.regen as any).target as { title: string; moduleId: number } | undefined;
  const providers = call.regen.providers.map((l) => `${l.provider} ${l.calls} llamada(s) ≈ USD ${Number(l.expectedUsd).toFixed(2)} (máx. USD ${Number(l.boundUsd).toFixed(2)}): ${l.what}`);
  return {
    operation: req.operation!, params: null, available: true, requiresItemConfirm: requiresItemConfirm(risk),
    summary: `${OP_ES[req.operation as keyof typeof OP_ES] ?? req.operation} — ${t?.title ?? req.target?.title ?? ''}: se produce con los proveedores cuando apruebes su costo.`,
    changes: [], files: [], entries: { added: [], removed: [], modified: [] }, risk,
    cost: { spentUsd: '0', apply: ZERO_MEM, contentEstimate: { min: call.regen.min, expected: call.expectedUsd, max: call.regen.max }, basis: `estimado ANTES de producir, por proveedor (${call.regen.basis}); nada corre sin tu aprobación y su tope · ${providers.join(' · ')}` },
    misalignment: ctx.course && t ? regenWarnings(ctx, req.operation!, t.moduleId) : [],
    dryRun: null, generated: false, plannedCall: call as unknown as PlannedCall,
  };
}

export interface PreparedRegenItem extends PreparedItem {
  /** El resultado producido (en memoria): el servicio lo sube como artifact y guarda su referencia en `params.result`. */
  produced: ProducedRegen | null;
  /** Motivo de una falla: `retry` = puede volver a aprobarse (tope, proveedor, resultado inválido); `final` = no se puede. */
  failure?: { code: string; retryable: boolean } | null;
}

/**
 * Produce (por la compuerta de la aprobación) → resultado validado → operación del motor → PRUEBA EN SECO sobre el
 * original → vista con antes/después verificable. Una falla nunca deja un ítem «listo» a medias.
 */
export async function prepareRegenItem(ctx: BuildCtx, req: InterpretedRequest, deps: { providers: RegenProviders; gate: PaidCallGate; spent: () => string; ext?: RegenExternal }, opts: { fromFinding?: boolean } = {}): Promise<PreparedRegenItem> {
  // r107 B11: agregar capítulo / módulo (misma compuerta, mismo resultado guardado, misma prueba en seco).
  if (isChapterOperation(req.operation)) { await regenDbOf(ctx); return prepareChapterItem(ctx, req, deps, opts) as unknown as PreparedRegenItem; }
  const t = req.target;
  const fail = (status: PreparedItem['status'], reason: string, code: string, retryable: boolean): PreparedRegenItem => ({ status, reason, view: null, spentUsd: deps.spent(), calls: 0, produced: null, failure: { code, retryable } });
  if (!t || t.kind !== 'activity' || !isRegenOperation(req.operation)) return fail('unavailable', 'destino inválido', 'unavailable', false);
  const res = await resolveRegen({ course: ctx.course, read: regenReader(ctx), op: req.operation, moduleId: t.moduleId, instruction: req.instruction, audioTarget: req.details.audioTarget ?? null, db: await regenDbOf(ctx) });
  if ('unavailable' in res) return fail('unavailable', res.unavailable, 'unavailable', false);
  let produced: ProducedRegen;
  try {
    produced = await produceRegen({ res, course: ctx.course, read: regenReader(ctx), providers: deps.providers, gate: deps.gate, pricing: ctx.pricing, db: await regenDbOf(ctx), ext: deps.ext });
  } catch (e) {
    if (!(e instanceof RegenError)) throw e;
    if (e.code === 'unavailable') return fail('unavailable', e.message, e.code, false);
    // tope / ambiguo / no enviado / proveedor sin configurar → el servicio corta la aprobación con el motivo.
    if (e.code === 'cap_reached' || e.code === 'call_ambiguous' || e.code === 'not_sent' || e.code === 'provider_rejected' || e.code === 'provider_not_ready' || e.code === 'over_bound') throw e;
    return fail('failed', `La regeneración no produjo un resultado válido: ${e.message} Lo gastado queda registrado; no se aplica nada.`, e.code, true);
  }
  const summary = { ...beforeFacts(res.target), before: beforeFacts(res.target), after: producedSummary(produced), ...(res.target.op === 'regenerate_audio' ? { chapters: res.target.chapters } : {}), ...(res.target.op === 'regenerate_video' ? { youtubeIdBefore: res.target.youtubeIdBefore, questionsBefore: res.target.questionsBefore } : {}) };
  const op: RegenerateOp = { op: req.operation, moduleId: t.moduleId, expect: res.expect, summary, produced };
  const r = await dryRun(ctx, [op as PatchOperation]);
  if (!r.ok) {
    return fail('failed', `El motor de parches no puede insertar el resultado: ${r.failure?.message ?? 'falla del motor'}${r.diagnosis?.introduced?.length ? ` (${r.diagnosis.introduced.slice(0, 3).map((x) => x.title).join(' · ')})` : ''}. No se aplica nada; lo gastado queda registrado.`, r.failure?.code ?? 'engine', true);
  }
  const rep = r.operations[0];
  const warnings = [...regenWarnings(ctx, req.operation, t.moduleId), ...rep.misalignment.map((m, i) => ({ id: wid('regen_engine', t.moduleId, i, m), kind: 'engine' as const, activity: null, questionId: null, message: m, terms: [], suggestedOperation: null, estimate: null }))];
  const params: RegenerateOp = { op: req.operation, moduleId: t.moduleId, expect: res.expect, summary };
  const view: PlanItemView = {
    operation: req.operation, params: params as PatchOperation, available: true,
    summary: rep.summary || `${OP_ES[req.operation]} — ${t.title}`,
    changes: rep.fields,
    files: rep.files.map((f) => ({ filename: f.filename, before: f.before.contenthash, after: f.after.contenthash })),
    entries: { added: rep.entriesAdded, removed: rep.entriesRemoved, modified: rep.entriesModified },
    risk: riskOf({ operation: req.operation, target: req.target, changes: rep.fields, misalignment: warnings, fromFinding: !!opts.fromFinding, params: params as PatchOperation }),
    cost: { spentUsd: deps.spent(), apply: ZERO_MEM, contentEstimate: null, basis: 'producido con los proveedores al aprobar su costo: aplicar no vuelve a gastar' },
    misalignment: warnings,
    dryRun: { ok: true, failure: null, resolved: r.diagnosis?.resolved.length ?? 0, removed: r.diagnosis?.removed.length ?? 0, engineVersion: PATCH_ENGINE_VERSION },
    generated: true, requiresItemConfirm: false,
  };
  (view as any).regen = { before: summary.before, after: summary.after, notes: [...res.notes, ...rep.notes] };
  view.requiresItemConfirm = requiresItemConfirm(view.risk);
  return { status: 'resolved', reason: null, view, spentUsd: deps.spent(), calls: 0, produced };
}
