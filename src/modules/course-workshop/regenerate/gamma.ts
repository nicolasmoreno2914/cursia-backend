/**
 * r107 B10 · `regenerate_gamma` — rehace la presentación del capítulo con el camino EXISTENTE de Gamma
 * (`gammaGenerationBody`: el cuerpo probado de gamma-worker, `textOptions.language: 'es-419'`, tema del curso, export
 * PDF), espera la generación, mide las diapositivas del PDF (`pdfPageCount`) y rasteriza la portada (página 1 con
 * pdftoppm, como el builder actual). Un envío de resultado desconocido queda AMBIGUO (nunca se reenvía solo).
 */
import type { DryRunPricing } from '../../pedagogy/dry-run';
import { gammaGenerationBody } from '../../../workers/provider-real/real-providers';
import { pdfPageCount, pngDimensions } from '../../../package/presentation';
import type { GammaGenerationStatus } from '../../../workers/provider-real/provider-clients';
import { gammaFinal, pollUntilFinal, settleGammaGeneration } from './async-wait';
import { PaidCallGate, RegenProviders, classifySubmission, gammaBound } from './ports';
import { ProducedRegen, RegenDeferred, RegenError, RegenExternal, RegenPrior, RegenTarget, inlineExternal } from './types';

type GammaTarget = Extract<RegenTarget, { op: 'regenerate_gamma' }>;

export async function produceGamma(a: { target: GammaTarget; providers: RegenProviders; gate: PaidCallGate; pricing: DryRunPricing; chapterMd: string; ext?: RegenExternal }): Promise<ProducedRegen> {
  const t = a.target;
  const P = a.providers;
  if (!P.config.gammaThemeId) throw new RegenError('provider_not_ready', 'Falta el tema de Gamma del curso en la configuración del servidor: no se envió nada a Gamma.');
  if (!(await P.media.rasterizer.available())) throw new RegenError('provider_not_ready', 'El servidor no tiene pdftoppm para la portada obligatoria de la presentación: no se envió nada a Gamma (sin gasto).');
  const body = gammaGenerationBody({ chapterTitle: t.chapterTitle, contentMarkdown: a.chapterMd, themeId: P.config.gammaThemeId });
  if ((body.textOptions as any)?.language !== 'es-419') throw new RegenError('internal', 'El cuerpo de Gamma no fija el idioma es-419.');
  // P1-2b: cota por lo pedido (numCards × créditos máx./tarjeta × precio; margen mayor si el precio no está verificado).
  const numCards = Number((body as any).numCards) > 0 ? Number((body as any).numCards) : 10;
  const bound = gammaBound(a.pricing, numCards);
  const ext = a.ext ?? inlineExternal();
  const prior: RegenPrior = { ...ext.prior };
  let id: string;
  let st: GammaGenerationStatus;
  if (prior.gamma?.generationId && prior.gamma.charged) {
    // P2-3: la generación YA pagada se reusa (consulta gratuita); si falló la rasterización, solo se reintenta eso.
    id = prior.gamma.generationId;
    try {
      st = await pollUntilFinal({ fetch: () => P.gamma.getGeneration(id), isFinal: gammaFinal, intervalMs: P.poll.intervalMs, deadlineAt: Date.now() + P.poll.timeoutMs, what: `la generación ${id} de Gamma` });
    } catch (e) {
      throw new RegenError('invalid_result', `No se pudo consultar la generación ya pagada ${id}: ${e instanceof Error ? e.message : String(e)}. No se regenera.`);
    }
    if (st.status !== 'completed') throw new RegenError('invalid_result', `La generación ya pagada ${id} no está lista (${st.status}). No se regenera sola.`);
  } else if (prior.gamma?.generationId) {
    throw new RegenDeferred({ provider: 'gamma', externalId: prior.gamma.generationId, callId: prior.gamma.callId ?? '', boundUsd: bound.boundUsd, kind: 'generate' });
  } else {
    const ticket = await a.gate.begin({ provider: 'gamma', kind: 'generate', boundUsd: bound.boundUsd, attempt: 1 });
    try {
      id = await P.gamma.createGeneration(body);
    } catch (err) {
      throw await ticket.failed(err, classifySubmission(err));
    }
    await ticket.accepted(id);
    prior.gamma = { generationId: id, charged: false, callId: ticket.id, approvalId: a.gate.charge.approvalId };
    await ext.onPaid({ ...prior });
    if (ext.mode === 'defer') throw new RegenDeferred({ provider: 'gamma', externalId: id, callId: ticket.id, boundUsd: bound.boundUsd, kind: 'generate' });
    try {
      st = await pollUntilFinal({ fetch: () => P.gamma.getGeneration(id), isFinal: gammaFinal, intervalMs: P.poll.intervalMs, deadlineAt: Date.now() + P.poll.timeoutMs, what: `la generación ${id} de Gamma` });
    } catch (e) {
      throw await ticket.failed(e, 'ambiguous');
    }
    await settleGammaGeneration({ ticket, st, generationId: id, boundUsd: bound.boundUsd, pricing: a.pricing, charge: a.gate.charge });
    prior.gamma = { ...prior.gamma, charged: true };
    await ext.onPaid({ ...prior });
  }
  if (!st.exportUrl) throw new RegenError('invalid_result', `La generación ${id} terminó sin el PDF.`);
  let pdf: Buffer;
  try { pdf = await P.gamma.download(st.exportUrl); } catch (e) { throw new RegenError('invalid_result', `No se pudo descargar el PDF de Gamma: ${e instanceof Error ? e.message : String(e)}.`); }
  let slides: number;
  try { slides = pdfPageCount(pdf); } catch (e) { throw new RegenError('invalid_result', `El PDF de Gamma no es válido: ${e instanceof Error ? e.message : String(e)}.`); }
  if (slides < 2) throw new RegenError('invalid_result', `La presentación nueva tiene ${slides} diapositiva(s).`);
  let cover: Buffer;
  let dims: { width: number; height: number };
  try {
    cover = await P.media.rasterizer.firstPagePng(pdf);
    dims = pngDimensions(cover);
  } catch (e) {
    throw new RegenError('invalid_result', `No se pudo rasterizar la portada de la presentación: ${e instanceof Error ? e.message : String(e)}.`);
  }
  return { kind: 'presentation', moduleId: t.moduleId, chapterNumber: t.chapterNumber, pdf, cover, slideCount: slides, width: dims.width, height: dims.height, language: 'es-419', generationId: id };
}
