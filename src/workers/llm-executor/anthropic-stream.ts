/**
 * Loop 4 (llamadas largas, tras el piloto #1209) — cliente de streaming DIRECTO del backend a Anthropic.
 *
 * Las partes largas (Libro Guía, Actividades de Aplicación, SCORM, examen final) tardan 100–125 s: por el navegador
 * pasaban por la Pages Function de Cloudflare, que corta a los 100 s (524) aunque Anthropic termine y cobre. Desde
 * el worker no hay límite de 100 s y, con streaming, la conexión nunca queda muda: la respuesta llega entera.
 *
 * Cada fallo sale CLASIFICADO, porque de eso depende si reintentar es seguro:
 *  - `never_sent`: la conexión no se pudo abrir (DNS, rechazo, URL) → el pedido no salió: reintento seguro.
 *  - `http`: Anthropic respondió un error (status) → resultado conocido (lo decide el llamador por status).
 *  - `cut`: el stream EMPEZÓ (message_start) y se cortó → se sabe que generó y cobró una parte; la parte se
 *    reintenta como transitorio (el costo queda registrado de forma conservadora).
 *  - `unknown`: el pedido salió pero no llegó ni un evento (conexión caída / sin respuesta) → no se sabe si
 *    Anthropic lo procesó. Regla del loop: UN reintento automático; un segundo desconocido → revisión.
 */

export type LlmStreamFailureKind = 'never_sent' | 'http' | 'cut' | 'unknown';

export class LlmStreamError extends Error {
  constructor(
    public readonly kind: LlmStreamFailureKind,
    message: string,
    public readonly extra: {
      status?: number;
      body?: string;
      requestId?: string | null;
      messageId?: string | null;
      usage?: LlmUsage | null;
      errorType?: string | null;
      /** r64: por qué se cortó (`timeout_idle`, `timeout_total`, `socket:<código>`, `provider_error:<tipo>`, `no_message_stop`). */
      cause?: string | null;
      /** r64: caracteres de texto recibidos antes del corte (evidencia de cuánto alcanzó a generar). */
      partialChars?: number;
      /** r64: llegó el `message_delta` con el usage final (entonces `usage.output_tokens` es el real). */
      sawUsageDelta?: boolean;
    } = {},
  ) {
    super(message);
    this.name = 'LlmStreamError';
  }
}

export interface LlmUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

export interface LlmStreamResult {
  text: string;
  messageId: string;
  requestId: string | null;
  model: string;
  usage: LlmUsage;
  stopReason: string | null;
}

/** Códigos de conexión que prueban que el pedido NO salió (nunca se abrió el socket). */
const NEVER_SENT_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ERR_INVALID_URL', 'UND_ERR_CONNECT_TIMEOUT', 'ENETUNREACH', 'EHOSTUNREACH']);

function errCode(e: unknown): string | null {
  const any = e as { code?: string; cause?: { code?: string; cause?: { code?: string } } } | null;
  return (any && (any.code || any.cause?.code || any.cause?.cause?.code)) || null;
}

const int = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : 0);

function mergeUsage(acc: LlmUsage, u: any): void {
  if (!u || typeof u !== 'object') return;
  for (const k of ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'] as const) {
    if (typeof u[k] === 'number' && Number.isInteger(u[k]) && u[k] >= 0) acc[k] = u[k];
  }
}

export interface StreamMessageRequest {
  apiKey: string;
  baseUrl: string;
  body: Record<string, unknown>;
  /** Sin bytes durante este tiempo → corte (cut si ya empezó, unknown si no). */
  idleMs: number;
  /** Tope de pared de toda la llamada (una parte larga real tarda ~2 min). */
  totalMs: number;
  fetchImpl?: typeof fetch;
}

export async function streamMessage(req: StreamMessageRequest): Promise<LlmStreamResult> {
  const f = req.fetchImpl ?? fetch;
  const ctrl = new AbortController();
  let timedOut: 'idle' | 'total' | null = null;
  const total = setTimeout(() => { timedOut = 'total'; ctrl.abort(); }, req.totalMs);
  let idle: ReturnType<typeof setTimeout> | null = null;
  const armIdle = () => {
    if (idle) clearTimeout(idle);
    idle = setTimeout(() => { timedOut = 'idle'; ctrl.abort(); }, req.idleMs);
  };
  let started = false;
  let messageId: string | null = null;
  let model = String(req.body.model ?? '');
  let stopReason: string | null = null;
  let sawStop = false;
  let errorType: string | null = null;
  let sawUsageDelta = false;
  const usage: LlmUsage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  const parts: string[] = [];
  let requestId: string | null = null;
  try {
    let res: Response;
    try {
      armIdle();
      res = await f(`${req.baseUrl.replace(/\/+$/, '')}/v1/messages`, {
        method: 'POST',
        headers: { 'x-api-key': req.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ ...req.body, stream: true }),
        signal: ctrl.signal,
      });
    } catch (e) {
      const code = errCode(e);
      if (!timedOut && code && NEVER_SENT_CODES.has(code)) {
        throw new LlmStreamError('never_sent', `anthropic: la conexión no se pudo abrir (${code}); el pedido no salió`);
      }
      throw new LlmStreamError('unknown', `anthropic: sin respuesta (${timedOut ? `timeout ${timedOut}` : code || (e instanceof Error ? e.message : String(e))}); el pedido pudo procesarse`);
    }
    const rid = res.headers.get('request-id');
    requestId = rid && /^[A-Za-z0-9._:-]{1,200}$/.test(rid) ? rid : null;
    if (!res.ok) {
      const body = (await res.text().catch(() => '')).slice(0, 2000);
      throw new LlmStreamError('http', `anthropic HTTP ${res.status}: ${body.slice(0, 300)}`, { status: res.status, body, requestId });
    }
    if (!res.body) throw new LlmStreamError('unknown', 'anthropic: respuesta sin cuerpo', { requestId });
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const dec = new TextDecoder();
    let buf = '';
    const onEvent = (ev: any) => {
      if (!ev || typeof ev !== 'object') return;
      if (ev.type === 'message_start' && ev.message) {
        started = true;
        if (typeof ev.message.id === 'string') messageId = ev.message.id;
        if (typeof ev.message.model === 'string') model = ev.message.model;
        mergeUsage(usage, ev.message.usage);
      } else if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta' && typeof ev.delta.text === 'string') {
        parts.push(ev.delta.text);
      } else if (ev.type === 'message_delta') {
        if (ev.usage && typeof ev.usage === 'object' && Number.isInteger(ev.usage.output_tokens) && ev.usage.output_tokens >= 0) sawUsageDelta = true;
        mergeUsage(usage, ev.usage);
        if (ev.delta && typeof ev.delta.stop_reason === 'string') stopReason = ev.delta.stop_reason;
      } else if (ev.type === 'message_stop') {
        sawStop = true;
      } else if (ev.type === 'error') {
        errorType = (ev.error && ev.error.type) || 'stream_error';
      }
    };
    const drainBlocks = (flush: boolean) => {
      buf = buf.replace(/\r\n/g, '\n');
      let idx: number;
      while ((idx = buf.indexOf('\n\n')) >= 0 || (flush && buf.trim())) {
        const block = idx >= 0 ? buf.slice(0, idx) : buf;
        buf = idx >= 0 ? buf.slice(idx + 2) : '';
        const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n');
        if (data && data !== '[DONE]') {
          try { onEvent(JSON.parse(data)); } catch { /* evento ilegible: se ignora (el usage final lo decide) */ }
        }
        if (idx < 0) break;
      }
    };
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        armIdle();
        buf += dec.decode(value, { stream: true });
        drainBlocks(false);
      }
      buf += dec.decode();
      drainBlocks(true);
    } catch (e) {
      const why = timedOut ? `timeout ${timedOut}` : errCode(e) || (e instanceof Error ? e.message : String(e));
      if (started) {
        const cause = timedOut ? `timeout_${timedOut}` : `socket:${errCode(e) || (e instanceof Error ? e.name : 'error')}`;
        throw new LlmStreamError('cut', `anthropic: el stream se cortó a mitad (${why})`, { requestId, messageId, usage: { ...usage }, cause, partialChars: parts.join('').length, sawUsageDelta });
      }
      throw new LlmStreamError('unknown', `anthropic: la conexión se cayó antes del primer evento (${why})`, { requestId });
    }
    if (errorType) {
      if (!started) throw new LlmStreamError('http', `anthropic: error ${errorType} antes de generar`, { status: errorType === 'overloaded_error' ? 529 : 500, requestId, errorType });
      throw new LlmStreamError('cut', `anthropic: error ${errorType} a mitad del stream`, { requestId, messageId, usage: { ...usage }, errorType, cause: `provider_error:${errorType}`, partialChars: parts.join('').length, sawUsageDelta });
    }
    if (!started || !messageId) throw new LlmStreamError('unknown', 'anthropic: el stream terminó sin message_start', { requestId });
    if (!sawStop) throw new LlmStreamError('cut', 'anthropic: el stream terminó sin message_stop', { requestId, messageId, usage: { ...usage }, cause: 'no_message_stop', partialChars: parts.join('').length, sawUsageDelta });
    return {
      text: parts.join('').trim(),
      messageId,
      requestId,
      model,
      usage: { input_tokens: int(usage.input_tokens), output_tokens: int(usage.output_tokens), cache_creation_input_tokens: int(usage.cache_creation_input_tokens), cache_read_input_tokens: int(usage.cache_read_input_tokens) },
      stopReason,
    };
  } finally {
    clearTimeout(total);
    if (idle) clearTimeout(idle);
  }
}

/**
 * r64 (R1 #1567: la misma parte se cortó 5 veces seguidas a mitad del stream) — la MISMA solicitud por otro
 * transporte: una respuesta JSON entera, sin SSE. Si el modelo termina, llega completa (con su `stop_reason`, que el
 * llamador valida igual que siempre: un `max_tokens` sigue siendo una respuesta truncada). Un error del proveedor
 * llega como HTTP con status (resultado CONOCIDO, sin cobro), nunca como un corte cobrado a mitad.
 * Sin bytes hasta el final: no hay corte por inactividad, solo el tope de pared (`totalMs`).
 * Clasificación (la misma que el stream, para que el llamador decida igual):
 *  - `never_sent`: la conexión no se abrió → no salió.
 *  - `http`: Anthropic respondió un error → conocido.
 *  - `unknown`: salió y no llegó una respuesta legible (caída, timeout, cuerpo cortado) → pudo procesarse y cobrarse.
 */
export async function nonStreamMessage(req: StreamMessageRequest): Promise<LlmStreamResult> {
  // Review r64 (I1): el fetch global de Node (undici) corta a los 300 s sin encabezados (`headersTimeout`), y una
  // respuesta sin streaming no manda encabezados hasta terminar: una parte larga (16k tokens) caería en «desconocido».
  // Sin `fetchImpl` (producción) va por http/https de Node, sin ese tope: solo vale `totalMs` (y keepalive TCP).
  const f = req.fetchImpl ?? nodeHttpFetch;
  const ctrl = new AbortController();
  let timedOut = false;
  const total = setTimeout(() => { timedOut = true; ctrl.abort(); }, req.totalMs);
  let requestId: string | null = null;
  try {
    let res: Response;
    try {
      res = await f(`${req.baseUrl.replace(/\/+$/, '')}/v1/messages`, {
        method: 'POST',
        headers: { 'x-api-key': req.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ ...req.body, stream: false }),
        signal: ctrl.signal,
      });
    } catch (e) {
      const code = errCode(e);
      if (!timedOut && code && NEVER_SENT_CODES.has(code)) {
        throw new LlmStreamError('never_sent', `anthropic: la conexión no se pudo abrir (${code}); el pedido no salió`);
      }
      throw new LlmStreamError('unknown', `anthropic: sin respuesta (${timedOut ? 'timeout total' : code || (e instanceof Error ? e.message : String(e))}); el pedido pudo procesarse`, { cause: timedOut ? 'timeout_total' : `socket:${code || 'error'}` });
    }
    const rid = res.headers.get('request-id');
    requestId = rid && /^[A-Za-z0-9._:-]{1,200}$/.test(rid) ? rid : null;
    let raw: string;
    try {
      raw = await res.text();
    } catch (e) {
      // Llegaron los encabezados y el cuerpo se cortó: un 200 pudo cobrarse → desconocido (nunca «sin costo»).
      throw new LlmStreamError('unknown', `anthropic: el cuerpo de la respuesta se cortó (${timedOut ? 'timeout total' : errCode(e) || (e instanceof Error ? e.message : String(e))})`, { requestId, status: res.status, cause: timedOut ? 'timeout_total' : 'body_cut' });
    }
    if (!res.ok) throw new LlmStreamError('http', `anthropic HTTP ${res.status}: ${raw.slice(0, 300)}`, { status: res.status, body: raw.slice(0, 2000), requestId });
    let msg: any;
    try { msg = JSON.parse(raw); } catch { msg = null; }
    if (!msg || typeof msg !== 'object' || msg.type !== 'message' || typeof msg.id !== 'string' || !Array.isArray(msg.content)) {
      throw new LlmStreamError('unknown', 'anthropic: respuesta 200 ilegible (no es un mensaje completo)', { requestId, status: res.status, cause: 'unreadable_body' });
    }
    const usage: LlmUsage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
    mergeUsage(usage, msg.usage);
    const text = msg.content.filter((b: any) => b && b.type === 'text' && typeof b.text === 'string').map((b: any) => b.text).join('').trim();
    return {
      text,
      messageId: msg.id,
      requestId,
      model: typeof msg.model === 'string' ? msg.model : String(req.body.model ?? ''),
      usage: { input_tokens: int(usage.input_tokens), output_tokens: int(usage.output_tokens), cache_creation_input_tokens: int(usage.cache_creation_input_tokens), cache_read_input_tokens: int(usage.cache_read_input_tokens) },
      stopReason: typeof msg.stop_reason === 'string' ? msg.stop_reason : null,
    };
  } finally {
    clearTimeout(total);
  }
}

/**
 * Review r64 (I1): POST mínimo con http/https de Node con la forma de `fetch` que usa `nonStreamMessage` (status, ok,
 * headers.get, text). Sin tope de encabezados ni de cuerpo propios: lo corta `signal` (el `totalMs` del llamador).
 * Keepalive TCP para que una conexión larga y muda no la cierre un intermediario por inactividad.
 */
export const NODE_HTTP_CONNECT_TIMEOUT_MS = 10_000;
export const nodeHttpFetch: typeof fetch = ((input: any, init: any = {}) => new Promise((resolve, reject) => {
  const url = new URL(String(input));
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = url.protocol === 'https:' ? require('https') : require('http');
  const signal: AbortSignal | undefined = init.signal;
  const body = typeof init.body === 'string' ? init.body : '';
  const headers: Record<string, string> = { ...(init.headers || {}), 'content-length': String(Buffer.byteLength(body)) };
  let settled = false;
  const fail = (e: any) => { if (!settled) { settled = true; reject(e); } };
  const req = mod.request({ method: init.method || 'POST', hostname: url.hostname, port: url.port || undefined, path: url.pathname + url.search, headers }, (res: any) => {
    const chunks: Buffer[] = [];
    let textP: Promise<string> | null = null;
    const done = new Promise<string>((ok, ko) => {
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => ok(Buffer.concat(chunks).toString('utf8')));
      res.on('error', ko);
      res.on('aborted', () => ko(Object.assign(new Error('respuesta abortada'), { code: 'ECONNRESET' })));
    });
    done.catch(() => undefined);
    settled = true;
    resolve({
      status: res.statusCode,
      ok: res.statusCode >= 200 && res.statusCode < 300,
      headers: { get: (k: string) => { const v = res.headers[String(k).toLowerCase()]; return Array.isArray(v) ? v.join(', ') : v ?? null; } },
      text: () => (textP ??= done),
      body: null,
    } as any);
  });
  // Review r64 (m1): como undici, una conexión que no se abre en 10 s es «nunca salió» (UND_ERR_CONNECT_TIMEOUT), no
  // un desconocido de 15 min.
  const connectTimer = setTimeout(() => req.destroy(Object.assign(new Error('connect timeout'), { code: 'UND_ERR_CONNECT_TIMEOUT' })), NODE_HTTP_CONNECT_TIMEOUT_MS);
  req.on('socket', (sock: any) => {
    try { sock.setKeepAlive(true, 30_000); } catch { /* sin keepalive */ }
    const opened = () => clearTimeout(connectTimer);
    if (sock.connecting === false && !(url.protocol === 'https:' && !sock.encrypted)) opened();
    sock.once(url.protocol === 'https:' ? 'secureConnect' : 'connect', opened);
  });
  req.on('close', () => clearTimeout(connectTimer));
  req.on('error', fail);
  if (signal) {
    if (signal.aborted) { req.destroy(Object.assign(new Error('aborted'), { name: 'AbortError' })); }
    signal.addEventListener('abort', () => req.destroy(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
  }
  req.end(body);
})) as any;
