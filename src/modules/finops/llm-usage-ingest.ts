/**
 * V2.1 RF-a — validación pura del body de `POST /finops/ingest/llm-usage`
 * y su traducción a RecordChargeInput (HD-V21-17: medición LLM server-side).
 *
 * El proxy (RF-b) postea: sujeto del JWT que él verificó, itemRunId
 * declarado (se verifica contra el sujeto en el ledger), callRole, attempt,
 * model, messageId (msg_…), requestId, usage de Anthropic y billingAccount.
 * Nunca se aceptan montos del caller: el monto se calcula del usage.
 */
import { FinopsError } from './errors';
import { CALL_ROLES, CallRole, RecordChargeInput } from './finops-ledger.service';

export interface LlmUsageIngestBody {
  subject: string;
  itemRunId?: string | null;
  callRole: CallRole;
  attempt: number;
  model: string;
  messageId: string;
  requestId?: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number | null;
    cache_read_input_tokens?: number | null;
  };
  billingAccount: 'cursia' | 'user_key';
  mode?: 'real' | 'mock';
}

const ALLOWED_KEYS = new Set(['subject', 'itemRunId', 'callRole', 'attempt', 'model', 'messageId', 'requestId', 'usage', 'billingAccount', 'mode']);

function bad(msg: string): never {
  throw new FinopsError('INVALID_INPUT', msg);
}

function tokenCount(v: unknown, what: string, required: boolean): number | null {
  if (v === null || v === undefined) {
    if (required) bad(`usage.${what} es obligatorio`);
    return null;
  }
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) bad(`usage.${what} debe ser entero >= 0`);
  return v as number;
}

export function parseLlmUsageIngest(body: unknown): LlmUsageIngestBody {
  if (!body || typeof body !== 'object' || Array.isArray(body)) bad('body debe ser un objeto JSON');
  const b = body as Record<string, any>;
  for (const k of Object.keys(b)) if (!ALLOWED_KEYS.has(k)) bad(`campo no permitido: ${k}`);
  const str = (k: string, required: boolean): string | null => {
    const v = b[k];
    if (v === null || v === undefined || v === '') {
      if (required) bad(`${k} es obligatorio`);
      return null;
    }
    if (typeof v !== 'string' || v.length > 256 || /\s/.test(v)) bad(`${k} inválido`);
    return v;
  };
  const subject = str('subject', true) as string;
  const itemRunId = str('itemRunId', false);
  const model = str('model', true) as string;
  const messageId = str('messageId', true) as string;
  const requestId = str('requestId', false);
  const callRole = b.callRole as CallRole;
  if (!CALL_ROLES.includes(callRole)) bad(`callRole inválido: ${String(b.callRole)}`);
  if (typeof b.attempt !== 'number' || !Number.isInteger(b.attempt) || b.attempt < 1) bad('attempt debe ser entero >= 1');
  if (b.billingAccount !== 'cursia' && b.billingAccount !== 'user_key') bad('billingAccount debe ser cursia | user_key');
  const mode = b.mode ?? 'real';
  if (mode !== 'real' && mode !== 'mock') bad('mode debe ser real | mock');
  const u = b.usage;
  if (!u || typeof u !== 'object' || Array.isArray(u)) bad('usage es obligatorio');
  const usage = {
    input_tokens: tokenCount(u.input_tokens, 'input_tokens', true) as number,
    output_tokens: tokenCount(u.output_tokens, 'output_tokens', true) as number,
    cache_creation_input_tokens: tokenCount(u.cache_creation_input_tokens, 'cache_creation_input_tokens', false),
    cache_read_input_tokens: tokenCount(u.cache_read_input_tokens, 'cache_read_input_tokens', false),
  };
  return { subject, itemRunId, callRole, attempt: b.attempt, model, messageId, requestId, usage, billingAccount: b.billingAccount, mode };
}

/** Body validado → input del ledger (medidores con los nombres del catálogo). */
export function llmIngestToChargeInput(body: LlmUsageIngestBody): RecordChargeInput {
  const mock = body.mode === 'mock';
  return {
    itemRunId: body.itemRunId ?? null,
    ownerIdFromAuth: body.subject,
    provider: 'anthropic',
    service: 'messages',
    modelOrProduct: body.model,
    usage: {
      input_tokens: body.usage.input_tokens,
      output_tokens: body.usage.output_tokens,
      cache_write_tokens: body.usage.cache_creation_input_tokens ?? 0,
      cache_read_tokens: body.usage.cache_read_input_tokens ?? 0,
    },
    usageUnit: 'output_tokens',
    externalOperationId: body.messageId,
    idempotency: { kind: 'anthropic', parts: { messageId: body.messageId } },
    callRole: body.callRole,
    attempt: body.attempt,
    billingAccount: mock ? 'mock' : body.billingAccount,
    mode: mock ? 'mock' : 'real',
    recordedBy: 'llm-proxy',
    metadata: { requestId: body.requestId ?? null, billingAccountRequested: body.billingAccount },
  };
}
