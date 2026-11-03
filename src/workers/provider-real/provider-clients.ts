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

/** Timeout por llamada (ms): PROVIDER_CALL_TIMEOUT_MS acota los defaults (pruebas de fault injection / operación). */
export function callTimeoutMs(env: Env, dflt: number): number {
  const n = Number(env.PROVIDER_CALL_TIMEOUT_MS);
  return Number.isInteger(n) && n > 0 ? Math.min(n, dflt) : dflt;
}

export class GammaClient {
  constructor(private readonly apiKey: string, private readonly env: Env = process.env, private readonly timeoutMs = callTimeoutMs(env, 60_000)) {
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

/**
 * r62 (K1, regla de ambigüedad acotada punto 1: PREVENIR antes que resolver). Los cuelgues del TTS de OpenAI observados
 * terminan entre 125 y 172 s (phase-b-n1-tts-root-cause.md, #1510); con el corte en 120 s el cliente abortaba llamadas
 * que OpenAI igual completaba y cobraba → resultado ambiguo. 210 s queda por encima de la cola observada con margen.
 * Invariantes: < lease del worker de proveedores (300 s, PROVIDER_WORKER_MIN_LEASE_SECONDS) y < drenado (270 s);
 * la ventana en vuelo de Q-21 (lease-takeover.ts, IN_FLIGHT_WINDOW_MS.openai) se deriva de este valor.
 */
export const OPENAI_TTS_TIMEOUT_MS = 210_000;
export const OPENAI_TTS_TIMEOUT_ENV = 'OPENAI_TTS_TIMEOUT_MS';

/**
 * r62 (review M4): timeout EFECTIVO del cliente TTS. `PROVIDER_CALL_TIMEOUT_MS` (acorta los demás proveedores) ya NO lo
 * baja del mínimo de 210 s: un valor operativo genérico (p. ej. 8 s del E2E o un 120 s heredado) reintroduciría el
 * timeout ambiguo de #1510. Solo `OPENAI_TTS_TIMEOUT_MS` explícito lo cambia (pruebas de fault injection / E2E); el
 * worker lo loguea al arrancar.
 */
/**
 * r62 (re-review m4): techo del override explícito = lease del worker de proveedores (300 s) − margen en vuelo (30 s).
 * La ventana en vuelo de Q-21 (lease-takeover.ts) se DERIVA del timeout efectivo (máx(210 s, override) + margen), así un
 * takeover nunca pisa una llamada viva; un override más corto (pruebas / E2E) solo hace la ventana más conservadora.
 */
export const OPENAI_TTS_TIMEOUT_MAX_MS = 270_000;
export function ttsTimeoutMs(env: Env): { ms: number; source: 'default' | 'OPENAI_TTS_TIMEOUT_MS' } {
  const n = Number(env[OPENAI_TTS_TIMEOUT_ENV]);
  if (Number.isInteger(n) && n > 0) return { ms: Math.min(n, OPENAI_TTS_TIMEOUT_MAX_MS), source: 'OPENAI_TTS_TIMEOUT_MS' };
  return { ms: OPENAI_TTS_TIMEOUT_MS, source: 'default' };
}

/**
 * r83 (incidente #91, 2026-11-02): watchdog de INACTIVIDAD del cuerpo del TTS. Un TTS sano emite bytes de forma continua;
 * un stream colgado (headers 200 y después nada) se aborta pasado este tiempo sin bytes, en vez de esperar ~2–3 min a que
 * lo corte el borde (`TypeError: terminated`) o el total de 210 s. Solo corre DESPUÉS de los headers (antes, la generación
 * puede tardar legítimamente y la cubre el total). Override: OPENAI_TTS_STALL_MS (≥ 100 ms, < timeout total).
 */
export const OPENAI_TTS_STALL_MS = 40_000;
export const OPENAI_TTS_STALL_ENV = 'OPENAI_TTS_STALL_MS';
export function ttsStallMs(env: Env, totalMs: number): number {
  const n = Number(env[OPENAI_TTS_STALL_ENV]);
  const v = Number.isInteger(n) && n >= 100 ? n : OPENAI_TTS_STALL_MS;
  return Math.max(100, Math.min(v, totalMs));
}

/** r83: cómo terminó una llamada TTS sin audio completo (evidencia para el ledger y el diagnóstico sin SSH). */
export type TtsStreamFailureKind = 'cut' | 'stall' | 'timeout' | 'network';

/**
 * r83: la llamada TTS se envió y NO devolvió un audio completo: corte del cuerpo (`terminated`), watchdog de inactividad,
 * timeout total o error de red antes de los headers. Resultado DESCONOCIDO (OpenAI pudo cobrar): `status` queda null
 * (nunca es un rechazo definitivo ni un «no cobrado» conocido). Lleva la evidencia sin secretos: x-request-id, causa
 * del socket, bytes recibidos y duración.
 */
export class TtsStreamError extends ProviderCallError {
  constructor(
    message: string,
    public readonly kind: TtsStreamFailureKind,
    public readonly phase: 'headers' | 'body',
    public readonly requestId: string | null,
    public readonly responseStatus: number | null,
    public readonly bytesReceived: number,
    public readonly elapsedMs: number,
    public readonly causeCode: string | null,
  ) {
    super('openai', true, message, null);
    this.name = 'TtsStreamError';
  }

  /** Evidencia serializable (output_summary.ttsCuts / ledger / log). Sin secretos. */
  evidence(): Record<string, unknown> {
    return { kind: this.kind, phase: this.phase, requestId: this.requestId, responseStatus: this.responseStatus,
      bytesReceived: this.bytesReceived, elapsedMs: this.elapsedMs, cause: this.causeCode };
  }
}

/** Causa del error de undici (`err.cause.code` / `.message`), recortada y sin saltos de línea. Nunca incluye headers. */
function causeOf(err: unknown): string | null {
  const c = (err as { cause?: unknown } | null)?.cause as { code?: unknown; name?: unknown; message?: unknown } | undefined;
  const parts = [c?.code, c?.name !== 'Error' ? c?.name : null, c?.message].filter((x): x is string => typeof x === 'string' && !!x.trim());
  const s = parts.join(' ').replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, 160) : null;
}

function safeRequestId(v: string | null): string | null {
  return v && /^[A-Za-z0-9._:-]{1,200}$/.test(v) ? v : null;
}

export class OpenAiTtsClient {
  private readonly stallMs: number;
  constructor(private readonly apiKey: string, private readonly env: Env = process.env, private readonly timeoutMs = ttsTimeoutMs(env).ms) {
    if (!apiKey || !apiKey.trim()) throw new ProviderCallError('openai', false, 'openai: OPENAI_API_KEY no configurada');
    this.stallMs = ttsStallMs(env, timeoutMs);
  }

  /**
   * POST /audio/speech — mismo body que TtsService (model, input, voice, response_format, instructions?).
   * r83: el cuerpo se lee por stream DENTRO del manejo de errores (antes `arrayBuffer()` quedaba fuera y un corte subía
   * como `TypeError: terminated` sin contexto), con watchdog de inactividad y el timeout total de siempre. Cualquier
   * final sin audio completo → TtsStreamError con la evidencia.
   */
  async speech(req: { model: string; voice: string; input: string; instructions?: string; speed?: number }): Promise<TtsCallResult> {
    const body: Record<string, unknown> = { model: req.model, input: req.input, voice: req.voice, response_format: 'mp3' };
    if (req.instructions) body.instructions = req.instructions;
    // r67 (A2.3): `speed` solo lo manda la estrategia `speed`, que se salta mientras el modelo no lo soporte de forma verificada.
    if (typeof req.speed === 'number' && req.speed >= 0.25 && req.speed <= 4) body.speed = req.speed;
    const what = 'POST /audio/speech';
    const url = `${base(this.env, OPENAI_API_BASE_ENV, OPENAI_API_BASE_DEFAULT)}/audio/speech`;
    const started = Date.now();
    const ctl = new AbortController();
    let aborted: 'timeout' | 'stall' | null = null;
    const total = setTimeout(() => { aborted = 'timeout'; ctl.abort(); }, this.timeoutMs);
    let stall: ReturnType<typeof setTimeout> | null = null;
    const armStall = () => {
      if (stall) clearTimeout(stall);
      stall = setTimeout(() => { aborted = aborted ?? 'stall'; ctl.abort(); }, this.stallMs);
    };
    const done = () => { clearTimeout(total); if (stall) clearTimeout(stall); };
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
    } catch (err) {
      done();
      const elapsed = Date.now() - started;
      // Mismo texto base de siempre («error de red (TimeoutError)»: lo leen las reglas y el log), más la evidencia.
      const name = aborted === 'timeout' ? 'TimeoutError' : err instanceof Error ? err.name : 'error';
      const cause = causeOf(err);
      throw new TtsStreamError(
        `openai ${what}: error de red (${name})${cause ? ` [${cause}]` : ''} sin respuesta tras ${(elapsed / 1000).toFixed(1)} s`,
        aborted === 'timeout' ? 'timeout' : 'network', 'headers', null, null, 0, elapsed, cause ?? name,
      );
    }
    const requestId = safeRequestId(res.headers.get('x-request-id'));
    if (!res.ok) {
      const snippet = await bodySnippet(res);
      done();
      throw classify('openai', what, res.status, snippet);
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    try {
      if (!res.body) throw new Error('respuesta sin cuerpo');
      armStall();
      const reader = res.body.getReader();
      for (;;) {
        const { done: end, value } = await reader.read();
        if (end) break;
        if (value && value.byteLength) {
          chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
          bytes += value.byteLength;
          armStall();
        }
      }
    } catch (err) {
      done();
      const elapsed = Date.now() - started;
      const kind: TtsStreamFailureKind = aborted === 'timeout' ? 'timeout' : aborted === 'stall' ? 'stall' : 'cut';
      const cause = kind === 'cut' ? causeOf(err) ?? (err instanceof Error ? err.message.slice(0, 120) : null) : kind;
      const label = kind === 'stall' ? `sin bytes durante ${(this.stallMs / 1000).toFixed(1)} s (watchdog)` : kind === 'timeout' ? `timeout total ${(this.timeoutMs / 1000).toFixed(0)} s` : `corte del cuerpo (${err instanceof Error ? err.message.slice(0, 60) : 'error'})`;
      throw new TtsStreamError(
        `openai ${what}: ${label}${kind === 'cut' && cause ? ` [${cause}]` : ''}; ${bytes} bytes en ${(elapsed / 1000).toFixed(1)} s; HTTP ${res.status}; x-request-id ${requestId ?? 'n/d'}`,
        kind, 'body', requestId, res.status, bytes, elapsed, cause,
      );
    }
    done();
    return { audio: Buffer.concat(chunks, bytes), requestId };
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
  constructor(private readonly apiKey: string, private readonly env: Env = process.env, private readonly timeoutMs = callTimeoutMs(env, 120_000)) {
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
