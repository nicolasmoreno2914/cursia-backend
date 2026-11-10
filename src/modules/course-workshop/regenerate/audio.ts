/**
 * r107 B10 · `regenerate_audio` — rehace el audio de bienvenida o el audiolibro COMPLETO con el pipeline TTS EXISTENTE
 * del backend:
 *   - guion: el del audiolibro v3 vigente (r19, `planAudiobookSections` + `generateSectionScript`): cada capítulo
 *     narrado por bloques `##` con validación de conteo de palabras (banda 85–110 % de la fuente, UNA continuación si
 *     queda corto, UNA condensación si queda largo); la bienvenida, el texto de bienvenida del curso (sin IA);
 *   - voz: OpenAI TTS por trozos (`splitForTts`), transcode a 64 kbps mono (`transcodeMp3Bitrate`, ffmpeg verificado
 *     ANTES de pagar) y `concatMp3` (frame Info con el conteo real);
 *   - audiolibro: NINGÚN capítulo faltante (CLAUDE.md #8/#9): un capítulo sin fuente corta ANTES de gastar, y uno cuyo
 *     guion o voz no sale corta la producción entera (nunca un audiolibro con capítulos de menos marcado «listo»).
 */
import { createHash } from 'crypto';
import type { DryRunPricing } from '../../pedagogy/dry-run';
import { WorkshopCourse, plainText } from '../course-model';
import { audioFramesOf, concatMp3, mp3DurationSeconds, parseMp3 } from '../../../package/audio';
import { AudioScriptError, ScriptLlm, cleanAudioText, generateSectionScript, planAudiobookSections, splitForTts, wordCount } from '../../../workers/provider-real/audio-scripts';
import { AUDIOBOOK_TTS_SEGMENT_CHARS_DEFAULT } from '../../../workers/provider-real/tts-resilience';
import { PaidCallGate, RegenProviders, classifyAnthropic, classifyTts, llmBoundUsd, llmChargeInput, llmMeasuredUsd, paidCall, ttsBoundUsd, ttsChargeInputOf, ttsMeasuredUsd } from './ports';
import type { ChapterSource } from './sources';
import { ProducedRegen, RegenError, RegenTarget } from './types';

type AudioTarget = Extract<RegenTarget, { op: 'regenerate_audio' }>;
export const REGEN_AUDIO_KBPS = 64;
/** Mínimo de palabras del texto de bienvenida para narrarlo. */
export const WELCOME_MIN_WORDS = 25;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** Texto de bienvenida del curso en el paquete (la etiqueta de bienvenida; sin IA). */
export function welcomeTextOf(course: WorkshopCourse): string | null {
  const a = course.activities.find((x) => x.kind === 'welcome' && !x.missingFolder);
  const html = a?.html.map((h) => h.html).join('\n') ?? '';
  const text = cleanAudioText(plainText(html, 6000));
  return wordCount(text) >= WELCOME_MIN_WORDS ? text : null;
}

/** Bitrate y canales del MP3 (del primer frame de audio; null si varían). */
export function mp3Format(buf: Buffer): { bitrateKbps: number | null; channels: number | null } {
  const fr = audioFramesOf(parseMp3(buf));
  const br = fr.length && fr.every((f) => f.bitrateKbps === fr[0].bitrateKbps) ? fr[0].bitrateKbps : null;
  const ch = fr.length && fr.every((f) => f.channels === fr[0].channels) ? fr[0].channels : null;
  return { bitrateKbps: br, channels: ch };
}

/** Validación del audio producido (independiente del pipeline). */
export function audioProblems(p: { audio: 'welcome' | 'audiobook'; mp3: Buffer; chapters: Array<{ number: number; seconds: number; words: number }> }, expectedChapters: number[]): string[] {
  const out: string[] = [];
  let dur = 0;
  try { dur = mp3DurationSeconds(p.mp3); } catch (e) { out.push(`el MP3 no es válido (${e instanceof Error ? e.message : String(e)})`); }
  if (!(dur > 0)) out.push('el audio no dura nada');
  try {
    const f = mp3Format(p.mp3);
    if (f.channels !== null && f.channels !== 1) out.push(`el audio es estéreo (${f.channels} canales); se exige mono`);
    if (f.bitrateKbps !== null && f.bitrateKbps > REGEN_AUDIO_KBPS) out.push(`el audio está a ${f.bitrateKbps} kbps; el tope es ${REGEN_AUDIO_KBPS} kbps`);
  } catch { /* ya informado */ }
  if (p.audio === 'audiobook') {
    const got = new Set(p.chapters.filter((c) => c.seconds > 0 && c.words > 0).map((c) => c.number));
    const missing = expectedChapters.filter((n) => !got.has(n));
    if (missing.length) out.push(`al audiolibro le faltan los capítulos ${missing.join(', ')}`);
    if (p.chapters.length !== new Set(p.chapters.map((c) => c.number)).size) out.push('el audiolibro repite capítulos');
  }
  return out;
}

async function speak(a: { providers: RegenProviders; gate: PaidCallGate; pricing: DryRunPricing }, text: string, segChars: number): Promise<{ mp3: Buffer; seconds: number }> {
  const P = a.providers;
  const parts: Buffer[] = [];
  let attempt = 0;
  for (const chunk of splitForTts(text, segChars)) {
    attempt++;
    const r = await paidCall(a.gate, { provider: 'openai', kind: 'chunk', boundUsd: ttsBoundUsd(a.pricing, P.config.ttsModel, chunk.length), attempt },
      () => P.tts.speech({ model: P.config.ttsModel, voice: P.config.ttsVoice, input: chunk }), classifyTts,
      (res, callId) => {
        const secs = mp3DurationSeconds(res.audio); // no medible → ambiguo (paidCall), nunca un 0 inventado
        return { costUsd: ttsMeasuredUsd(a.pricing, P.config.ttsModel, secs), charge: ttsChargeInputOf(a.gate.charge, callId, { model: P.config.ttsModel, requestId: res.requestId, seconds: secs, characters: chunk.length }), externalId: res.requestId };
      });
    parts.push(await P.media.transcode(r.audio, REGEN_AUDIO_KBPS));
  }
  if (!parts.length) throw new RegenError('invalid_result', 'No hay texto para narrar.');
  const mp3 = concatMp3(parts);
  return { mp3, seconds: mp3DurationSeconds(mp3) };
}

export async function produceAudio(a: { target: AudioTarget; course: WorkshopCourse; providers: RegenProviders; gate: PaidCallGate; pricing: DryRunPricing; sources: ChapterSource[]; segmentChars?: number }): Promise<ProducedRegen> {
  const t = a.target;
  const P = a.providers;
  if (P.config.missing.some((m) => /OPENAI/.test(m))) throw new RegenError('provider_not_ready', `Falta la configuración de la voz (${P.config.missing.filter((m) => /OPENAI/.test(m)).join(', ')}): no se pagó nada.`);
  if (!(await P.media.transcoderAvailable())) throw new RegenError('provider_not_ready', 'El servidor no tiene ffmpeg para dejar el audio a 64 kbps mono: no se pagó nada.');
  const segChars = a.segmentChars ?? AUDIOBOOK_TTS_SEGMENT_CHARS_DEFAULT;
  if (t.audio === 'welcome') {
    const text = welcomeTextOf(a.course);
    if (!text) throw new RegenError('source_missing', 'El curso no tiene un texto de bienvenida para narrar.');
    const v = await speak(a, text, segChars);
    const f = mp3Format(v.mp3);
    const produced: ProducedRegen = { kind: 'audio', moduleId: t.moduleId, audio: 'welcome', mp3: v.mp3, durationSec: v.seconds, bitrateKbps: f.bitrateKbps, channels: f.channels, chapters: [], scriptWords: wordCount(text) };
    const pr = audioProblems(produced as any, []);
    if (pr.length) throw new RegenError('invalid_result', `El audio nuevo no es válido: ${pr.join('; ')}.`);
    return produced;
  }
  const byN = new Map(a.sources.map((s) => [s.number, s]));
  const missing = t.chapters.filter((n) => !byN.has(n));
  if (missing.length) throw new RegenError('source_missing', `Faltan los textos de los capítulos ${missing.join(', ')}: un audiolibro no se arma con capítulos de menos. No se pagó nada.`);
  let attempt = 0;
  const llm: ScriptLlm = async (prompt, role) => {
    attempt++;
    const m = P.config.llmModel;
    const r = await paidCall(a.gate, { provider: 'anthropic', kind: `audiobook_${role}`, boundUsd: llmBoundUsd(a.pricing, m, prompt.system.length + prompt.user.length, prompt.maxTokens), attempt },
      () => P.llm.messages({ model: m, system: prompt.system, user: prompt.user, maxTokens: prompt.maxTokens }), classifyAnthropic,
      (res, callId) => ({ costUsd: llmMeasuredUsd(a.pricing, res.model || m, res.usage), charge: llmChargeInput(a.gate.charge, callId, { model: res.model || m, messageId: res.messageId, usage: res.usage }, `audiobook_${role}`), externalId: res.messageId }));
    return { text: r.text, messageId: r.messageId, truncated: r.stopReason === 'max_tokens' };
  };
  const chapterAudio: Buffer[] = [];
  const records: Array<{ number: number; words: number; seconds: number; scriptSha256: string; frames: number }> = [];
  let words = 0;
  for (const n of t.chapters) {
    const src = byN.get(n)!;
    let plan;
    try { plan = planAudiobookSections(src.md); } catch (e) { throw new RegenError('invalid_result', `No se pudo planear la narración del capítulo ${n}: ${e instanceof Error ? e.message : String(e)}.`); }
    if (!plan.sections.length) throw new RegenError('source_missing', `El capítulo ${n} no tiene texto narrable.`);
    const input = { courseTitle: a.course.course.title ?? '', chapterNumber: n, chapterTitle: src.title, contentMarkdown: src.md };
    const scripts: string[] = [];
    let prev: string | null = null;
    for (const s of plan.sections) {
      let r;
      try {
        r = await generateSectionScript(input, s, plan.sections.length, prev, llm);
      } catch (e) {
        if (e instanceof RegenError) throw e;
        throw new RegenError('invalid_result', `El guion del capítulo ${n} no pasó la validación (${e instanceof AudioScriptError ? e.code : 'error'}): ${e instanceof Error ? e.message.slice(0, 200) : String(e)}. No se arma un audiolibro con capítulos de menos.`);
      }
      scripts.push(r.text);
      prev = r.text;
    }
    const script = scripts.join('\n\n');
    const v = await speak(a, script, segChars);
    chapterAudio.push(v.mp3);
    const w = wordCount(script);
    words += w;
    records.push({ number: n, words: w, seconds: v.seconds, scriptSha256: sha256(script), frames: audioFramesOf(parseMp3(v.mp3)).length });
  }
  const mp3 = concatMp3(chapterAudio);
  const f = mp3Format(mp3);
  const produced: ProducedRegen = { kind: 'audio', moduleId: t.moduleId, audio: 'audiobook', mp3, durationSec: mp3DurationSeconds(mp3), bitrateKbps: f.bitrateKbps, channels: f.channels, chapters: records, scriptWords: words };
  const pr = audioProblems(produced as any, t.chapters);
  if (pr.length) throw new RegenError('invalid_result', `El audiolibro nuevo no es válido: ${pr.join('; ')}.`);
  return produced;
}
