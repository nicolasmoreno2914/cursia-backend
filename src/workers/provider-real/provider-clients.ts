// ─────────────────────────────────────────────────────────────────────────────
// Cursia V2.1 F2 — clientes HTTP mínimos de los proveedores reales del worker
// de proveedor (Gamma, OpenAI TTS, Anthropic). Misma forma de request que el
// legacy probado (gamma-worker.ts, tts.service.ts, audio-worker.ts), con dos
// diferencias deliberadas:
//  - la URL base sale del entorno (default = la real) para poder probar SOLO
//    contra servidores falsos en 127.0.0.1;
//  - cada respuesta devuelve los ids que el ledger necesita (generationId,
//    x-request-id, message.id + usage).
// Las claves vienen del entorno y NUNCA se incluyen en un mensaje de error ni
// en un log (los errores se arman con status + un recorte del body del
// proveedor, que no contiene la clave).
// ─────────────────────────────────────────────────────────────────────────────

export const GAMMA_API_BASE_DEFAULT = 'https://public-api.gamma.app/v1.0';
export const OPENAI_API_BASE_DEFAULT = 'https://api.openai.com/v1';
export const ANTHROPIC_API_BASE_DEFAULT = 'https://api.anthropic.com';
export const ANTHROPIC_VERSION = '2023-06-01';

export const GAMMA_API_BASE_ENV = 'GAMMA_API_BASE_URL';
export const OPENAI_API_BASE_ENV = 'OPENAI_API_BASE_URL';
export const ANTHROPIC_API_BASE_ENV = 'ANTHROPIC_API_BASE_URL';

type Env = Record<string, string | undefined>;

function base(env: Env, key: string, dflt: string): string {
  const v = (env[key] ?? '').trim();
  return (v || dflt).replace(/\/+$/, '');
}

/** Error de proveedor con clasificación (reintentable o no) y status HTTP. Sin secretos. */
export class ProviderCallError extends Error {
  constructor(
    public readonly provider: 'gamma' | 'openai' | 'anthropic',
    public readonly retryable: boolean,
    message: string,
    public readonly status: number | null = null,
  ) {
    super(message);
    this.name = 'ProviderCallError';
  }
}

async function bodySnippet(res: Response): Promise<string> {
  const t = await res.text().catch(() => '');
  return t.replace(/\s+/g, ' ').slice(0, 200);
}

function classify(provider: 'gamma' | 'openai' | 'anthropic', what: string, status: number, snippet: string): ProviderCallError {
  // 401/403: clave/plan → no reintentable. 400/404/422: request inválido → no reintentable.
  const retryable = status === 408 || status === 409 || status === 429 || status >= 500;
  return new ProviderCallError(provider, retryable, `${provider} ${what} HTTP ${status}${snippet ? `: ${snippet}` : ''}`, status);
}

async function send(provider: 'gamma' | 'openai' | 'anthropic', what: string, url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    // Red / timeout: reintentable. El mensaje del error de fetch no contiene headers.
    throw new ProviderCallError(provider, true, `${provider} ${what}: error de red (${err instanceof Error ? err.name : 'error'})`);
  }
}

// ─── Gamma ──────────────────────────────────────────────────────────────────

export interface GammaGenerationStatus {
  status: string;
  gammaId: string | null;
  gammaUrl: string | null;
  exportUrl: string | null;
  /** `credits.deducted` / `credits.remaining` (Gamma los devuelve en completed y failed). */
  creditsDeducted: number | null;
  creditsRemaining: number | null;
  error: string | null;
}

export class GammaClient {
  constructor(private readonly apiKey: string, private readonly env: Env = process.env, private readonly timeoutMs = 60_000) {
    if (!apiKey || !apiKey.trim()) throw new ProviderCallError('gamma', false, 'gamma: GAMMA_API_KEY no configurada');
  }

  private get base(): string {
    return base(this.env, GAMMA_API_BASE_ENV, GAMMA_API_BASE_DEFAULT);
  }

  async createGeneration(body: Record<string, unknown>): Promise<string> {
    const res = await send('gamma', 'POST /generations', `${this.base}/generations`, {
      method: 'POST',
      headers: { 'X-API-KEY': this.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, this.timeoutMs);
    if (!res.ok) throw classify('gamma', 'POST /generations', res.status, await bodySnippet(res));
    const data = (await res.json().catch(() => ({}))) as { generationId?: unknown };
    if (typeof data.generationId !== 'string' || !data.generationId.trim()) {
      // La generación pudo crearse sin que tengamos su id: el caller lo trata como ambiguo.
      throw new ProviderCallError('gamma', false, 'gamma POST /generations: respuesta sin generationId');
    }
    return data.generationId;
  }

  async getGeneration(generationId: string): Promise<GammaGenerationStatus> {
    const res = await send('gamma', 'GET /generations/{id}', `${this.base}/generations/${encodeURIComponent(generationId)}`, {
      headers: { 'X-API-KEY': this.apiKey },
    }, this.timeoutMs);
    if (!res.ok) throw classify('gamma', 'GET /generations/{id}', res.status, await bodySnippet(res));
    const d = (await res.json().catch(() => ({}))) as Record<string, any>;
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
    return {
      status: String(d.status ?? ''),
      gammaId: typeof d.gammaId === 'string' ? d.gammaId : null,
      gammaUrl: typeof d.gammaUrl === 'string' ? d.gammaUrl : null,
      exportUrl: typeof d.exportUrl === 'string' ? d.exportUrl : null,
      creditsDeducted: num(d.credits?.deducted),
      creditsRemaining: num(d.credits?.remaining),
      error: d.error ? String(typeof d.error === 'string' ? d.error : d.error?.message ?? 'failed').slice(0, 300) : null,
    };
  }

  /** Descarga el export (PDF). La URL la da Gamma (firmada); no lleva la clave. */
  async download(url: string): Promise<Buffer> {
    const res = await send('gamma', 'GET export', url, {}, this.timeoutMs * 3);
    if (!res.ok) throw classify('gamma', 'GET export', res.status, '');
    return Buffer.from(await res.arrayBuffer());
  }
}

// ─── OpenAI TTS ───────────────────────────────────────────────────────────────

export interface TtsCallResult {
  audio: Buffer;
  /** `x-request-id` de la respuesta (id externo del ledger); null si no vino. */
  requestId: string | null;
}

export class OpenAiTtsClient {
  constructor(private readonly apiKey: string, private readonly env: Env = process.env, private readonly timeoutMs = 120_000) {
    if (!apiKey || !apiKey.trim()) throw new ProviderCallError('openai', false, 'openai: OPENAI_API_KEY no configurada');
  }

  /** POST /audio/speech — mismo body que TtsService (model, input, voice, response_format, instructions?). */
  async speech(req: { model: string; voice: string; input: string; instructions?: string }): Promise<TtsCallResult> {
    const body: Record<string, unknown> = { model: req.model, input: req.input, voice: req.voice, response_format: 'mp3' };
    if (req.instructions) body.instructions = req.instructions;
    const res = await send('openai', 'POST /audio/speech', `${base(this.env, OPENAI_API_BASE_ENV, OPENAI_API_BASE_DEFAULT)}/audio/speech`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, this.timeoutMs);
    if (!res.ok) throw classify('openai', 'POST /audio/speech', res.status, await bodySnippet(res));
    const audio = Buffer.from(await res.arrayBuffer());
    const rid = res.headers.get('x-request-id');
    return { audio, requestId: rid && /^[A-Za-z0-9._:-]{1,200}$/.test(rid) ? rid : null };
  }
}

// ─── Anthropic (guion del audiolibro, server-side) ────────────────────────────

export interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

export interface AnthropicCallResult {
  text: string;
  /** `message.id` (msg_…): id externo e idempotencia del ledger. */
  messageId: string;
  requestId: string | null;
  model: string;
  usage: AnthropicUsage;
  stopReason: string | null;
}

export class AnthropicClient {
  constructor(private readonly apiKey: string, private readonly env: Env = process.env, private readonly timeoutMs = 120_000) {
    if (!apiKey || !apiKey.trim()) throw new ProviderCallError('anthropic', false, 'anthropic: ANTHROPIC_API_KEY no configurada');
  }

  async messages(req: { model: string; system: string; user: string; maxTokens: number }): Promise<AnthropicCallResult> {
    const res = await send('anthropic', 'POST /v1/messages', `${base(this.env, ANTHROPIC_API_BASE_ENV, ANTHROPIC_API_BASE_DEFAULT)}/v1/messages`, {
      method: 'POST',
      headers: { 'x-api-key': this.apiKey, 'anthropic-version': ANTHROPIC_VERSION, 'content-type': 'application/json' },
      body: JSON.stringify({ model: req.model, max_tokens: req.maxTokens, system: req.system, messages: [{ role: 'user', content: req.user }] }),
    }, this.timeoutMs);
    if (!res.ok) throw classify('anthropic', 'POST /v1/messages', res.status, await bodySnippet(res));
    const d = (await res.json().catch(() => ({}))) as Record<string, any>;
    const u = d.usage ?? {};
    const int = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : 0);
    if (typeof d.id !== 'string' || !d.id || typeof u.input_tokens !== 'number' || typeof u.output_tokens !== 'number') {
      // Sin id/usage el cargo no se puede medir: fail loud (el LLM pudo cobrar; lo concilia §W.4 llm.unattributed).
      throw new ProviderCallError('anthropic', false, 'anthropic POST /v1/messages: respuesta sin id o sin usage (no medible)');
    }
    const text = Array.isArray(d.content)
      ? d.content.filter((c: any) => c && c.type === 'text' && typeof c.text === 'string').map((c: any) => c.text).join('').trim()
      : '';
    const rid = res.headers.get('request-id');
    return {
      text,
      messageId: d.id,
      requestId: rid && /^[A-Za-z0-9._:-]{1,200}$/.test(rid) ? rid : null,
      model: typeof d.model === 'string' ? d.model : req.model,
      usage: {
        input_tokens: int(u.input_tokens),
        output_tokens: int(u.output_tokens),
        cache_creation_input_tokens: int(u.cache_creation_input_tokens),
        cache_read_input_tokens: int(u.cache_read_input_tokens),
      },
      stopReason: typeof d.stop_reason === 'string' ? d.stop_reason : null,
    };
  }
}
