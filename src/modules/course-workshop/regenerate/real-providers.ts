/**
 * r107 B10 · Fase 3 — los proveedores REALES detrás de los puertos, con los CLIENTES EXISTENTES del backend:
 * `OpenAiTtsClient`, `GammaClient` (provider-real/provider-clients), `VideogenService` (Video Engine), la subida de
 * YouTube de la cuenta (`YoutubeService` + `YoutubeUploadService`), pdftoppm (`pdftoppmRasterizer`) y ffmpeg
 * (`transcodeMp3Bitrate`). La IA va al mismo endpoint y con el mismo cuerpo que el worker de IA del backend
 * (`serverLlmRequestBody`, con `output_config` cuando el generador pide un esquema).
 *
 * Las claves se leen del entorno en cada llamada y nunca se registran. Una clave o herramienta faltante deja la
 * operación `provider_not_ready` ANTES de gastar (`config.missing`). Este archivo NO corre en las pruebas: los checks
 * usan proveedores simulados y prohíben la red (check-r107-regenerate).
 */
import { spawn } from 'child_process';
import { serverLlmRequestBody } from '../../../workers/llm-executor/server-llm';
import { GammaClient, OpenAiTtsClient, ProviderCallError } from '../../../workers/provider-real/provider-clients';
import { pdftoppmRasterizer } from '../../../workers/provider-real/pdf-cover';
import { TTS_VOICE_DEFAULT } from '../../../workers/provider-real/real-providers';
import { transcodeMp3Bitrate } from '../../../tts/mp3-transcode.util';
import { resolveTtsModel } from '../../../tts/tts-models';
import { VideogenService } from '../../../video-engine/videogen.service';
import { RegenProviders } from './ports';
import { REGEN_LLM_MODEL } from './produce';

type Env = Record<string, string | undefined>;
const trimmed = (env: Env, k: string) => (env[k] ?? '').trim();

/** Error previo al envío (configuración): la compuerta lo clasifica `not_sent` (no pudo cobrarse). */
class NotSent extends Error { readonly notSent = true; }

export interface YoutubeDeps {
  /** Conexión de YouTube del que paga (YoutubeService.getConnection). */
  connection(): Promise<{ status?: string } | null>;
  upload(conn: unknown, a: { downloadUrl: string; title: string }): Promise<{ videoId: string }>;
}

export function realRegenProviders(env: Env = process.env, opts: { youtube?: YoutubeDeps | null; gammaThemeId?: string | null } = {}): RegenProviders {
  const missing: string[] = [];
  for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GAMMA_API_KEY', 'VIDEOGEN_API_KEY', 'VIDEOGEN_API_URL']) if (!trimmed(env, k)) missing.push(k);
  const ttsModel = resolveTtsModel(undefined, env).model;
  const videogen = new VideogenService();
  const ffmpegOk = (): Promise<boolean> => new Promise((res) => {
    try {
      const p = spawn(trimmed(env, 'FFMPEG_BIN') || 'ffmpeg', ['-version'], { stdio: 'ignore' });
      p.on('error', () => res(false));
      p.on('close', (code) => res(code === 0));
    } catch { res(false); }
  });
  return {
    simulated: false,
    config: { llmModel: REGEN_LLM_MODEL, ttsModel, ttsVoice: trimmed(env, 'OPENAI_TTS_VOICE') || TTS_VOICE_DEFAULT, gammaThemeId: opts.gammaThemeId ?? (trimmed(env, 'GAMMA_THEME_V21_LIGHT_DEFAULT') || null), missing },
    poll: { intervalMs: Number(env.WORKSHOP_REGEN_POLL_MS) > 0 ? Number(env.WORKSHOP_REGEN_POLL_MS) : 6000, timeoutMs: Number(env.WORKSHOP_REGEN_TIMEOUT_MS) > 0 ? Number(env.WORKSHOP_REGEN_TIMEOUT_MS) : 25 * 60_000 },
    llm: {
      async messages(req: { model: string; system: string; user: string; maxTokens: number; schema?: unknown }) {
        const key = trimmed(env, 'ANTHROPIC_API_KEY');
        if (!key) throw new NotSent('ANTHROPIC_API_KEY no configurada');
        const { body } = serverLlmRequestBody({ system: req.system, user: req.user, maxTok: req.maxTokens, schema: req.schema, model: req.model, defaultModel: REGEN_LLM_MODEL });
        let res: Response;
        try {
          res = await fetch(`${trimmed(env, 'ANTHROPIC_API_BASE_URL') || 'https://api.anthropic.com'}/v1/messages`, {
            method: 'POST', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(180_000),
          });
        } catch (err) {
          throw new ProviderCallError('anthropic', true, `anthropic: error de red (${err instanceof Error ? err.name : 'error'})`);
        }
        if (!res.ok) throw new ProviderCallError('anthropic', res.status >= 500 || res.status === 429, `anthropic HTTP ${res.status}`, res.status);
        const d = (await res.json().catch(() => ({}))) as Record<string, any>;
        if (typeof d.id !== 'string' || !d.usage) throw new ProviderCallError('anthropic', false, 'anthropic: respuesta sin id o sin usage (no medible)');
        const text = Array.isArray(d.content) ? d.content.filter((c: any) => c?.type === 'text').map((c: any) => String(c.text ?? '')).join('') : '';
        return { text, messageId: d.id, model: typeof d.model === 'string' ? d.model : req.model, usage: d.usage, stopReason: typeof d.stop_reason === 'string' ? d.stop_reason : null };
      },
    },
    tts: {
      async speech(req) {
        const key = trimmed(env, 'OPENAI_API_KEY');
        if (!key) throw new NotSent('OPENAI_API_KEY no configurada');
        return new OpenAiTtsClient(key, env).speech(req);
      },
    },
    gamma: {
      createGeneration: (body) => { const k = trimmed(env, 'GAMMA_API_KEY'); if (!k) throw new NotSent('GAMMA_API_KEY no configurada'); return new GammaClient(k, env).createGeneration(body); },
      getGeneration: (id) => new GammaClient(trimmed(env, 'GAMMA_API_KEY'), env).getGeneration(id),
      download: (url) => new GammaClient(trimmed(env, 'GAMMA_API_KEY'), env).download(url),
    },
    videogen: {
      async create(payload) {
        if (!trimmed(env, 'VIDEOGEN_API_KEY') || !trimmed(env, 'VIDEOGEN_API_URL')) throw new NotSent('Videogen no configurado');
        const r = await videogen.batchCreate([payload]);
        const j = r.jobs[0];
        if (!j || !j.job_id) throw new Error('Videogen aceptó el pedido sin devolver el id del job (resultado desconocido)');
        return { jobId: j.job_id };
      },
      status: (jobId) => videogen.getVideoStatus(jobId),
      async cost(jobId) { const c = await videogen.getVideoCost(jobId); return Number.isFinite(c.estimated_total_cost) ? c.estimated_total_cost : null; },
      async download(url) {
        const r = await fetch(url, { signal: AbortSignal.timeout(300_000) });
        if (!r.ok) throw new Error(`descarga del video HTTP ${r.status}`);
        return Buffer.from(await r.arrayBuffer());
      },
    },
    youtube: {
      async ready() {
        if (!opts.youtube) return 'YouTube no está disponible en este proceso.';
        const c = await opts.youtube.connection().catch(() => null);
        if (!c) return 'Tu cuenta no tiene YouTube conectado (Cuenta → YouTube): el video interactivo se entrega por YouTube.';
        if (c.status === 'revoked' || c.status === 'reauth_required') return 'La conexión de YouTube venció: vuelve a conectarla en Cuenta.';
        return null;
      },
      async upload(a) {
        if (!opts.youtube) throw new NotSent('YouTube no disponible');
        const c = await opts.youtube.connection();
        if (!c) throw new NotSent('YouTube sin conexión');
        return opts.youtube.upload(c, { downloadUrl: a.videoUrl, title: a.title });
      },
    },
    media: {
      rasterizer: pdftoppmRasterizer(env),
      transcoderAvailable: ffmpegOk,
      transcode: (mp3, kbps) => transcodeMp3Bitrate(mp3, kbps),
    },
  };
}
