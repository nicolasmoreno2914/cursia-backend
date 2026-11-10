/**
 * r107 B10 · `regenerate_gamma` — rehace la presentación del capítulo con el camino EXISTENTE de Gamma
 * (`gammaGenerationBody`: el cuerpo probado de gamma-worker, `textOptions.language: 'es-419'`, tema del curso, export
 * PDF), espera la generación, mide las diapositivas del PDF (`pdfPageCount`) y rasteriza la portada (página 1 con
 * pdftoppm, como el builder actual). Un envío de resultado desconocido queda AMBIGUO (nunca se reenvía solo).
 */
import type { DryRunPricing } from '../../pedagogy/dry-run';
import { gammaGenerationBody } from '../../../workers/provider-real/real-providers';
import { pdfPageCount, pngDimensions } from '../../../package/presentation';
import { PaidCallGate, RegenProviders, classifySubmission, gammaBoundUsd, gammaChargeInputOf, gammaMeasuredUsd } from './ports';
import { ProducedRegen, RegenError, RegenTarget } from './types';

type GammaTarget = Extract<RegenTarget, { op: 'regenerate_gamma' }>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function produceGamma(a: { target: GammaTarget; providers: RegenProviders; gate: PaidCallGate; pricing: DryRunPricing; chapterMd: string }): Promise<ProducedRegen> {
  const t = a.target;
  const P = a.providers;
  if (!P.config.gammaThemeId) throw new RegenError('provider_not_ready', 'Falta el tema de Gamma del curso en la configuración del servidor: no se envió nada a Gamma.');
  if (!(await P.media.rasterizer.available())) throw new RegenError('provider_not_ready', 'El servidor no tiene pdftoppm para la portada obligatoria de la presentación: no se envió nada a Gamma (sin gasto).');
  const body = gammaGenerationBody({ chapterTitle: t.chapterTitle, contentMarkdown: a.chapterMd, themeId: P.config.gammaThemeId });
  if ((body.textOptions as any)?.language !== 'es-419') throw new RegenError('internal', 'El cuerpo de Gamma no fija el idioma es-419.');
  const ticket = await a.gate.begin({ provider: 'gamma', kind: 'gamma:generate', boundUsd: gammaBoundUsd(a.pricing), attempt: 1 });
  let id: string;
  try {
    id = await P.gamma.createGeneration(body);
  } catch (err) {
    throw await ticket.failed(err, classifySubmission(err));
  }
  await ticket.accepted(id);
  const t0 = Date.now();
  let st;
  for (;;) {
    try {
      st = await P.gamma.getGeneration(id);
    } catch (err) {
      throw await ticket.failed(err, 'ambiguous');
    }
    if (st.status === 'completed' || st.status === 'failed') break;
    if (Date.now() - t0 > P.poll.timeoutMs) throw await ticket.failed(new Error(`la generación ${id} de Gamma no terminó en ${Math.round(P.poll.timeoutMs / 1000)} s`), 'ambiguous');
    await sleep(P.poll.intervalMs);
  }
  const credits = typeof st.creditsDeducted === 'number' && Number.isFinite(st.creditsDeducted) && st.creditsDeducted >= 0 ? st.creditsDeducted : null;
  await ticket.charged({ costUsd: gammaMeasuredUsd(a.pricing, credits ?? 0), charge: gammaChargeInputOf(a.gate.charge, ticket.id, { generationId: id, credits, failed: st.status === 'failed' }), externalId: id });
  if (st.status === 'failed') throw new RegenError('invalid_result', `Gamma no pudo generar la presentación (${st.error ?? 'sin detalle'}). No se reenvía sola.`);
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
