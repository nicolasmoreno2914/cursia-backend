/**
 * r107 B10 · `regenerate_video` — rehace el video interactivo del capítulo con el Video Engine EXISTENTE:
 *   1. antes de pagar nada: YouTube conectado (la entrega de v3 y de los V1 con hvp es por YouTube) y fuente del capítulo;
 *   2. render en Videogen con el texto del capítulo (Videogen escribe el GUION por escenas: lo verificable del «después»);
 *      un envío o un render de resultado desconocido queda AMBIGUO y nunca se reenvía solo (regla de provider-reconcile);
 *   3. publicación en YouTube (no listado);
 *   4. preguntas interactivas NUEVAS desde el guion nuevo con el generador existente (`_dynRunVideoInteractions`:
 *      `dynVideoInteractionsPrompt`, validación del documento y su reintento dirigido), ancladas a las escenas reales;
 *   5. el `.h5p` lo arma el builder (`buildVideoActivity`, R8); en un hvp (V1) se usa su `content.json` como
 *      `json_content`. Un video sin preguntas no se entrega.
 */
import JSZip = require('jszip');
import type { DryRunPricing } from '../../pedagogy/dry-run';
import type { WorkshopCourse } from '../course-model';
import { buildVideoActivity, videoScenesFromVideogen } from '../../../package/h5p/interactive-video';
import { durationFromVideogenStatus, parseMp4DurationSec } from '../../../workers/video-duration';
import { VideogenBatchJob, isJobCompleted } from '../../../video-engine/videogen.service';
import { pollUntilFinal, settleVideogenJob, videogenFinal } from './async-wait';
import { cleanAudioText } from '../../../workers/provider-real/audio-scripts';
import { workshopExecutor } from './executor';
import { PaidCallGate, RegenProviders, classifySubmission, paidCall, videogenBound } from './ports';
import { courseContextOf } from './scorm';
import type { RegenDbSources } from './sources';
import { ProducedRegen, RegenDeferred, RegenError, RegenExternal, RegenPrior, RegenTarget, inlineExternal } from './types';

type VideoTarget = Extract<RegenTarget, { op: 'regenerate_video' }>;

/** Preguntas de un contenido H5P.InteractiveVideo y cuántas tienen EXACTAMENTE una respuesta correcta. */
export function videoQuestionStats(content: any): { questions: number; singleCorrect: number } {
  const xs = Array.isArray(content?.interactiveVideo?.assets?.interactions) ? content.interactiveVideo.assets.interactions : [];
  let q = 0;
  let ok = 0;
  for (const it of xs) {
    const lib = String(it?.action?.library ?? '');
    if (!/^H5P\.(MultiChoice|TrueFalse|SingleChoiceSet)\b/.test(lib)) continue;
    q++;
    if (/^H5P\.TrueFalse\b/.test(lib)) { ok++; continue; }
    const ans = Array.isArray(it?.action?.params?.answers) ? it.action.params.answers : [];
    if (ans.filter((x: any) => x?.correct === true).length === 1) ok++;
  }
  return { questions: q, singleCorrect: ok };
}

export async function produceVideo(a: { target: VideoTarget; course: WorkshopCourse; providers: RegenProviders; gate: PaidCallGate; pricing: DryRunPricing; db: RegenDbSources | null; chapterMd: string; ext?: RegenExternal }): Promise<ProducedRegen> {
  const t = a.target;
  const P = a.providers;
  const notReady = await P.youtube.ready();
  if (notReady) throw new RegenError('provider_not_ready', `${notReady} No se pagó ningún render.`);
  if (P.config.missing.some((m) => /VIDEOGEN/.test(m))) throw new RegenError('provider_not_ready', `Falta la configuración del Video Engine (${P.config.missing.filter((m) => /VIDEOGEN/.test(m)).join(', ')}): no se pagó nada.`);
  const chapterId = a.course.chapters.find((c) => c.number === t.chapterNumber)?.builderUuid ?? `workshop-${t.moduleId}`;

  // ── 2. render (envío → aceptado → espera → costo medido). P2-3: un render YA pagado se reusa, nunca se re-renderiza ──
  const ext = a.ext ?? inlineExternal();
  const prior: RegenPrior = { ...ext.prior };
  const words = a.chapterMd.split(/\s+/).filter(Boolean).length;
  const bound = videogenBound(a.pricing, words);
  let jobId: string;
  let job: VideogenBatchJob;
  if (prior.videogen?.jobId && prior.videogen.charged) {
    jobId = prior.videogen.jobId;
    // Consulta gratuita del render ya pagado (sin reenviar ni cobrar).
    try {
      job = await pollUntilFinal({ fetch: () => P.videogen.status(jobId), isFinal: videogenFinal, intervalMs: P.poll.intervalMs, deadlineAt: Date.now() + P.poll.timeoutMs, what: `el render ${jobId}` });
    } catch (e) {
      throw new RegenError('invalid_result', `No se pudo consultar el render ya pagado ${jobId}: ${e instanceof Error ? e.message : String(e)}. No se re-renderiza.`);
    }
    if (!isJobCompleted(job.status)) throw new RegenError('invalid_result', `El render ya pagado ${jobId} no está listo (${job.status}). No se re-renderiza.`);
  } else if (prior.videogen?.jobId) {
    // Aceptado pero sin liquidar: la espera es del trabajo aparte (nunca un segundo envío).
    throw new RegenDeferred({ provider: 'videogen', externalId: prior.videogen.jobId, callId: prior.videogen.callId ?? '', boundUsd: bound.boundUsd, kind: 'render' });
  } else {
    const ticket = await a.gate.begin({ provider: 'videogen', kind: 'render', boundUsd: bound.boundUsd, attempt: 1 });
    try {
      ({ jobId } = await P.videogen.create({
        title: t.chapterTitle, content_txt: cleanAudioText(a.chapterMd), chapter_number: t.chapterNumber,
        client_reference_id: `workshop:${a.gate.charge.approvalId}:${t.moduleId}`,
        tts_voice: P.config.ttsVoice, external_metadata: { tts_model: P.config.ttsModel, source: 'course_workshop' },
      }));
    } catch (err) {
      // El envío inicial falló: sin respuesta → ambiguo; rechazo documentado → sin cobro.
      throw await ticket.failed(err, classifySubmission(err));
    }
    await ticket.accepted(jobId);
    prior.videogen = { jobId, charged: false, callId: ticket.id, approvalId: a.gate.charge.approvalId };
    await ext.onPaid({ ...prior });
    if (ext.mode === 'defer') throw new RegenDeferred({ provider: 'videogen', externalId: jobId, callId: ticket.id, boundUsd: bound.boundUsd, kind: 'render' });
    try {
      job = await pollUntilFinal({ fetch: () => P.videogen.status(jobId), isFinal: videogenFinal, intervalMs: P.poll.intervalMs, deadlineAt: Date.now() + P.poll.timeoutMs, what: `el render ${jobId}` });
    } catch (e) {
      // Solo el plazo TOTAL vencido sin estado final es ambiguo (los errores de consulta se reintentaron).
      throw await ticket.failed(e, 'ambiguous');
    }
    await settleVideogenJob({ ticket, job, jobId, boundUsd: bound.boundUsd, providers: P, charge: a.gate.charge });
    prior.videogen = { ...prior.videogen, charged: true };
    await ext.onPaid({ ...prior });
  }
  if (!job.download_url) throw new RegenError('invalid_result', `Videogen terminó el render ${jobId} sin la URL del video.`);
  let durationSec = durationFromVideogenStatus(job);
  if (durationSec === null) {
    try { durationSec = parseMp4DurationSec(await P.videogen.download(job.download_url)); } catch { durationSec = null; }
  }
  if (durationSec === null) throw new RegenError('invalid_result', `No se pudo medir la duración del video ${jobId}: no se arman preguntas a ciegas.`);
  const sc = videoScenesFromVideogen(job.scenes);
  const scenes = sc.ok ? sc.scenes : null;
  const script = scenes ? scenes.map((s) => s.narration).join('\n') : '';

  // ── 3. YouTube (USD 0: cuota de la cuenta) ──
  // P2-3: el video ya publicado se reusa (nunca un video huérfano ni una segunda subida).
  let up: { videoId: string };
  if (prior.youtube?.videoId) {
    up = { videoId: prior.youtube.videoId };
  } else {
    up = await paidCall(a.gate, { provider: 'youtube', kind: 'upload', boundUsd: '0', attempt: 1 },
      () => P.youtube.upload({ videoUrl: job.download_url as string, title: t.chapterTitle }), classifySubmission,
      (r) => ({ costUsd: '0', charge: null, externalId: r.videoId }));
    if (!/^[A-Za-z0-9_-]{11}$/.test(up.videoId)) throw new RegenError('invalid_result', 'YouTube devolvió un id de video inválido.');
    prior.youtube = { videoId: up.videoId };
    await ext.onPaid({ ...prior });
  }

  // ── 4. preguntas desde el guion nuevo (generador existente) ──
  const ex = workshopExecutor({ providers: P, gate: a.gate, pricing: a.pricing, what: 'video_interactions', texts: new Map([['ws-md', a.chapterMd]]), ownerId: a.gate.charge.payer });
  const ctx = ex.sandbox.ctx;
  const plan = ctx.dynPlanVideoCheckpoints(durationSec, scenes ?? undefined);
  // H5P v2: si el video actual tenía pausas de reflexión, el nuevo también (mismo plan determinístico que el servidor).
  const reflection = t.advanced ? ctx.dynPlanReflectionPauses(durationSec, plan.checkpoints) : null;
  const item = {
    rulesVersion: 3, type: 'video_interactions', itemKey: `video_interactions:${chapterId}`, itemRunId: null, dependsOn: [`video:${chapterId}`], chapterId, chapterNumber: t.chapterNumber, generation: 1,
    claimPayload: { durationSec, checkpoints: plan.checkpoints, timelineSource: plan.timelineSource, ...(scenes ? { videoScenes: scenes } : {}), ...(reflection ? { videoInteractionsSchemaVersion: 2, reflectionPlan: reflection } : {}) },
    dependencyArtifacts: [{ type: 'dynamic_content_md', artifactId: 'ws-md', itemKey: `content:${chapterId}` }],
    blueprint: { chapter: { id: chapterId, title: t.chapterTitle } },
    context: { courseContext: courseContextOf(a.course, a.db) },
  };
  const res = await ctx._dynRunVideoInteractions(JSON.parse(JSON.stringify(item))).catch((e: any) => ({ ok: false, error: e?.msg ?? e?.message ?? String(e) }));
  if (ex.stop) throw ex.stop;
  if (!res || !res.ok) throw new RegenError('invalid_result', `Las preguntas del video nuevo no pasaron la validación del generador: ${String(res?.error ?? 'sin detalle').slice(0, 300)}.`);
  let doc: any;
  try { doc = JSON.parse((res.artifacts || []).find((x: any) => x.type === 'dynamic_video_interactions_json').content); } catch { throw new RegenError('invalid_result', 'Las preguntas del video nuevo no traen su documento.'); }

  // ── 5. el paquete del video (builder existente) ──
  let built;
  try {
    built = await buildVideoActivity({ itemKey: `video:${chapterId}`, title: t.chapterTitle, youtubeId: up.videoId, durationSec, interactionsDoc: doc, ...(scenes ? { videoScenes: scenes } : {}), ...(t.advanced ? { ivAdvanced: true } : {}) });
  } catch (e) {
    throw new RegenError('invalid_result', `El builder no pudo armar el video interactivo: ${e instanceof Error ? e.message.slice(0, 300) : String(e)}.`);
  }
  const z = await JSZip.loadAsync(built.h5p);
  const content = JSON.parse(await z.file('content/content.json')!.async('string'));
  const st = videoQuestionStats(content);
  if (st.questions < 1 || st.singleCorrect !== st.questions) throw new RegenError('invalid_result', `El video nuevo tiene ${st.questions} pregunta(s), ${st.singleCorrect} con exactamente una correcta: no se entrega.`);
  return {
    kind: 'video', moduleId: t.moduleId, chapterNumber: t.chapterNumber, container: t.container, youtubeId: up.videoId, durationSec, interactions: st.questions,
    h5p: t.container === 'h5pactivity' ? built.h5p : null, hvpJson: t.container === 'hvp' ? JSON.stringify(content) : null,
    script, scenes: scenes ? scenes.length : 0, videogenJobId: jobId,
  };
}
