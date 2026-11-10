/**
 * r107 B8 · Orquestación PURA del diagnóstico de calidad y de las preguntas puntuales (el servicio pone la base, la
 * memoria compartida, las aprobaciones de gasto de B5 y el cliente de IA; las pruebas, uno simulado).
 *
 *   preparar  (sin IA, USD 0): textos del curso → reglas deterministas Q01–Q05 (con su arreglo sugerido probado en seco
 *             con el motor de B4) → evidencia de cada capítulo → la llamada EXACTA que se haría por capítulo con su
 *             estimado y su cota (estimator de FinOps: el estimado es la llamada real, mismo prompt y mismo max_tokens).
 *   revisar   (IA, con aprobación y tope): por capítulo aprobado, UNA llamada con su evidencia; la salida se verifica
 *             contra la evidencia enviada (citas literales); un reintento solo si la FORMA no sirve.
 *   preguntar (IA, con aprobación y tope): evidencia recuperada sin IA → UNA llamada → citas verificadas.
 */
import { WorkshopCourse } from '../course-model';
import { DiagnosisContext } from '../diagnosis/context';
import { Finding, SEVERITY_RANK } from '../diagnosis/finding';
import { Light, SeverityCounts, countOf, lightOf } from '../diagnosis/diagnose';
import { prevalidateFixes } from '../patch/precheck';
import { MbzPackage } from '../mbz-reader';
import { AiCall, AiInvoke, PlannedCall, plannedCallOf } from '../plan/builder';
import { WorkshopPricing, sumUsd } from '../plan/cost';
import { ChapterPacket, QUALITY_SYSTEM, ReviewOutcome, WORKSHOP_QUALITY_MAX_TOKENS, chapterPacket, parseReview, qualityTool, qualityUser } from './ai-review';
import { ASK_SYSTEM, AskAnswer, AskPassage, WORKSHOP_ASK_MAX_TOKENS, askShapeProblems, askTool, askUser, noEvidenceAnswer, verifyAnswer } from './ask';
import { deterministicQuality } from './deterministic';
import { qualityDocs } from './docs';
import { QUALITY_CHECK_IDS, QUALITY_CHECK_TITLES, QualityCheckId, QualityDoc, QualityFinding } from './types';

// ─── Preparar ──────────────────────────────────────────────────────────────

export interface QualityPrepared {
  docs: QualityDoc[];
  findings: QualityFinding[];
  checks: ReturnType<typeof deterministicQuality>['checks'];
  packets: ChapterPacket[];
  /** La llamada exacta por capítulo (null = el capítulo no tiene texto que revisar). */
  calls: Array<{ chapterNumber: number; call: PlannedCall | null; promptChars: number; reason: string | null }>;
}

/** La llamada que se hace para revisar un capítulo (el estimado se calcula sobre ESTA). */
export function reviewCall(courseTitle: string | null, p: ChapterPacket, attempt = 1, problems: string[] = []): AiCall {
  let user = qualityUser(courseTitle, p);
  if (attempt > 1 && problems.length) user += `\n\nTu respuesta anterior no sirvió por esto: ${problems.join('; ')}. Corrígelo.`;
  return { purpose: 'quality', kind: 'quality_review', system: QUALITY_SYSTEM, user, tool: qualityTool(), maxTokens: WORKSHOP_QUALITY_MAX_TOKENS, size: { promptChars: user.length + QUALITY_SYSTEM.length }, attempt };
}

/** `pricing` null = el modelo del Taller no tiene precio: no se ofrece la revisión con IA (motivo visible), lo determinista sí corre. */
export async function prepareQuality(ctx: DiagnosisContext, pkg: MbzPackage, packageBytes: Buffer, pricing: WorkshopPricing | null, unpricedReason: string | null = null): Promise<QualityPrepared> {
  const docs = qualityDocs(ctx);
  const det = deterministicQuality(ctx, docs);
  // El arreglo sugerido de cada hallazgo se prueba en seco con el motor de B4 (igual que los hallazgos técnicos).
  await prevalidateFixes(det.findings as unknown as Finding[], { pkg, packageBytes, family: ctx.family, course: ctx.course, raw: ctx.raw });
  const packets = ctx.course.chapters.map((c) => chapterPacket(ctx, docs, c.number));
  const calls = packets.map((p) => {
    if (!p.docs.length) return { chapterNumber: p.chapterNumber, call: null, promptChars: 0, reason: 'el capítulo no tiene texto que revisar' };
    const c = reviewCall(ctx.course.course.title, p);
    if (!pricing) return { chapterNumber: p.chapterNumber, call: null, promptChars: c.size.promptChars, reason: unpricedReason ?? 'la revisión con IA no está disponible (sin precio para el modelo)' };
    return { chapterNumber: p.chapterNumber, call: plannedCallOf(c, pricing), promptChars: c.size.promptChars, reason: null };
  });
  return { docs, findings: sortQuality(det.findings, ctx.course), checks: det.checks, packets, calls };
}

// ─── Revisar un capítulo ───────────────────────────────────────────────────

export interface ChapterReview { outcome: ReviewOutcome; calls: number; spentUsd: string }

export async function reviewChapter(ctx: DiagnosisContext, docs: QualityDoc[], p: ChapterPacket, ai: AiInvoke): Promise<ChapterReview> {
  let spent = '0';
  let calls = 0;
  let problems: string[] = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    const { result, costUsd } = await ai(reviewCall(ctx.course.course.title, p, attempt, problems));
    calls++;
    spent = sumUsd(spent, costUsd);
    const out = result.input === null ? { ok: false, problems: ['no usó la herramienta'], accepted: [], rejected: [] } : parseReview(ctx, docs, p, result.input, result.stopReason);
    if (out.ok) return { outcome: out, calls, spentUsd: spent };
    problems = out.problems;
    if (attempt === 2) return { outcome: out, calls, spentUsd: spent };
  }
  throw new Error('inalcanzable');
}

/** Prueba en seco los arreglos de hallazgos de la IA (mismo motor que los deterministas). */
export async function precheckFindings(ctx: DiagnosisContext, pkg: MbzPackage, packageBytes: Buffer, fs: QualityFinding[]): Promise<void> {
  await prevalidateFixes(fs as unknown as Finding[], { pkg, packageBytes, family: ctx.family, course: ctx.course, raw: ctx.raw });
}

// ─── Preguntar ─────────────────────────────────────────────────────────────

export function askCall(courseTitle: string | null, question: string, passages: AskPassage[], attempt = 1, problems: string[] = []): AiCall {
  let user = askUser(courseTitle, question, passages);
  if (attempt > 1 && problems.length) user += `\n\nTu respuesta anterior no sirvió por esto: ${problems.join('; ')}. Corrígelo.`;
  return { purpose: 'question', kind: 'question_answer', system: ASK_SYSTEM, user, tool: askTool(), maxTokens: WORKSHOP_ASK_MAX_TOKENS, size: { promptChars: user.length + ASK_SYSTEM.length }, attempt };
}

export async function answerQuestion(courseTitle: string | null, question: string, passages: AskPassage[], ai: AiInvoke): Promise<{ answer: AskAnswer; calls: number; spentUsd: string }> {
  if (!passages.length) return { answer: noEvidenceAnswer(null), calls: 0, spentUsd: '0' };
  let spent = '0';
  let calls = 0;
  let problems: string[] = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    const { result, costUsd } = await ai(askCall(courseTitle, question, passages, attempt, problems));
    calls++;
    spent = sumUsd(spent, costUsd);
    problems = result.input === null ? ['no usó la herramienta'] : askShapeProblems(result.input, result.stopReason);
    if (!problems.length) return { answer: verifyAnswer(result.input, passages), calls, spentUsd: spent };
  }
  return { answer: noEvidenceAnswer({ reason: `la respuesta del modelo no tenía la forma pedida (${problems.join('; ')})`, invalidCitations: 0 }), calls, spentUsd: spent };
}

// ─── Informe ───────────────────────────────────────────────────────────────

export function sortQuality(fs: QualityFinding[], course: WorkshopCourse): QualityFinding[] {
  const order = new Map(course.activities.map((a, i) => [a.moduleId, i]));
  return [...fs].sort((a, b) =>
    (a.check < b.check ? -1 : a.check > b.check ? 1 : 0)
    || SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]
    || (a.scope.chapterNumber ?? 1e9) - (b.scope.chapterNumber ?? 1e9)
    || (a.scope.activity ? order.get(a.scope.activity.moduleId) ?? 1e9 : -1) - (b.scope.activity ? order.get(b.scope.activity.moduleId) ?? 1e9 : -1)
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export interface QualityLights {
  course: Light;
  chapters: Array<{ number: number; title: string | null; light: Light; counts: SeverityCounts }>;
  activities: Array<{ moduleId: number; light: Light; counts: SeverityCounts }>;
  byCheck: Record<QualityCheckId, SeverityCounts>;
  total: SeverityCounts;
}

/** Semáforo de calidad con las MISMAS reglas que el técnico (rojo = error, amarillo = aviso, info no cuenta). */
export function qualityLights(fs: QualityFinding[], course: WorkshopCourse): QualityLights {
  const F = fs as unknown as Finding[];
  const mids = [...new Set(fs.map((x) => x.scope.activity?.moduleId).filter((x): x is number => typeof x === 'number'))];
  return {
    course: lightOf(F),
    chapters: course.chapters.map((c) => { const x = F.filter((f) => f.scope.chapterNumber === c.number); return { number: c.number, title: c.title, light: lightOf(x), counts: countOf(x) }; }),
    activities: mids.map((m) => { const x = F.filter((f) => f.scope.activity?.moduleId === m); return { moduleId: m, light: lightOf(x), counts: countOf(x) }; }),
    byCheck: Object.fromEntries(QUALITY_CHECK_IDS.map((q) => [q, countOf(F.filter((f) => (f as any).check === q))])) as Record<QualityCheckId, SeverityCounts>,
    total: countOf(F),
  };
}

export { QUALITY_CHECK_TITLES };
