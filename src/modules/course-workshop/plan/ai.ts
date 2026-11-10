import Anthropic from '@anthropic-ai/sdk';
import { assertDirectCallAllowed } from '../../finops/direct-call-ledger';

/**
 * r107 B5 · Taller de cursos — cliente de IA de los pedidos (interpretación y contenido nuevo).
 *
 * UNA llamada a Claude con herramienta forzada (`tool_choice: { type: 'tool' }`), mismo patrón que el generador del
 * microcurrículo (r81). El modelo lo fija Cursia (WORKSHOP_AI_MODEL, por defecto el de los textos del curso): el docente
 * nunca lo elige. Se inyecta por el token Nest WORKSHOP_AI_CLIENT: TODAS las pruebas de este bloque usan un cliente
 * simulado (respuestas fixture, USD 0); el real queda cableado y es el default del servicio, pero ninguna prueba lo
 * ejecuta (check-r107-plan.js / check-r107-workshop-service.js fallan si se llega a invocar).
 *
 * Acá solo se llama y se devuelve lo medido (uso, modelo, id del mensaje para el ledger). El servicio decide antes si hay
 * saldo (D9) y después registra el costo; la validación de la salida es de interpret.ts / content.ts.
 */

export const WORKSHOP_AI_CLIENT = 'WORKSHOP_AI_CLIENT';

export interface WorkshopTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface WorkshopAiRequest {
  /** Para qué es la llamada (ledger + pruebas). */
  purpose: 'interpret' | 'content';
  model: string;
  system: string;
  user: string;
  tool: WorkshopTool;
  maxTokens: number;
  timeoutMs: number;
}

export interface WorkshopAiUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

export interface WorkshopAiResult {
  /** `input` del bloque tool_use de la herramienta pedida; null si el modelo no la llamó. */
  input: unknown | null;
  stopReason: string | null;
  model: string;
  messageId: string | null;
  usage: WorkshopAiUsage | null;
  /** true SOLO en el cliente simulado de las pruebas: el ledger lo registra como `mock`, nunca como gasto real. */
  simulated?: boolean;
}

export interface WorkshopAiClient {
  call(req: WorkshopAiRequest): Promise<WorkshopAiResult>;
  /** true SOLO en el cliente simulado de las pruebas: la reserva del tope se registra `mock`. */
  simulated?: boolean;
}

export const WORKSHOP_AI_TIMEOUT_MS = 120_000;
export const WORKSHOP_INTERPRET_MAX_TOKENS = 4_000;
export const WORKSHOP_QUESTION_MAX_TOKENS = 1_500;
/**
 * Ronda de decisiones (controlador): el tope de salida de cada llamada se ajusta a lo que se pide (no un tope fijo
 * enorme): es la COTA de la llamada que se compara con el tope aprobado antes de llamar. HTML: el campo entero vuelve
 * (≈ caracteres / 2,5 tokens) + margen; Libro: ≈ 3.000 tokens por capítulo.
 */
export function htmlMaxTokens(fieldChars: number): number {
  return Math.min(16_000, Math.max(1_000, Math.ceil(fieldChars / 2.5) + 800));
}
export function libroMaxTokens(chapters: number): number {
  return Math.min(16_000, 3_000 * Math.max(1, chapters) + 1_000);
}

/** Modelo fijado por Cursia (no lo elige el usuario: memoria «Models fixed by Cursia»). */
export function workshopModel(env: NodeJS.ProcessEnv = process.env): string {
  return (env.WORKSHOP_AI_MODEL || '').trim() || 'claude-sonnet-4-6';
}

/**
 * Fix round 2 (N1): error ANTES de que el pedido salga (kill switch, sin ANTHROPIC_API_KEY, construcción del cliente,
 * configuración). Anthropic no pudo cobrar nada: la llamada queda `not_sent` y la reserva se libera.
 */
export class WorkshopAiNotSentError extends Error {
  readonly notSent = true;
  constructor(readonly cause: unknown) {
    super(`no se envió la llamada a la IA: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'WorkshopAiNotSentError';
  }
}

type AnthropicLike = { messages: { create: (body: any, opts?: any) => Promise<any> } };

export class AnthropicWorkshopAiClient implements WorkshopAiClient {
  private client: AnthropicLike | null = null;

  /**
   * `sdkFactory` solo para pruebas (un SDK falso: ninguna red). En producción, el SDK real, que exige la clave: el SDK
   * instalado no falla al construirse sin ella (fallaría ya dentro de `messages.create`, después de la frontera), así
   * que se verifica acá, antes de enviar.
   */
  constructor(private readonly sdkFactory: () => AnthropicLike = () => {
    if (!String(process.env.ANTHROPIC_API_KEY ?? '').trim()) throw new Error('falta ANTHROPIC_API_KEY en el servidor');
    return new Anthropic({ timeout: WORKSHOP_AI_TIMEOUT_MS, maxRetries: 0 }) as unknown as AnthropicLike;
  }) {}

  async call(req: WorkshopAiRequest): Promise<WorkshopAiResult> {
    // FRONTERA EXPLÍCITA (N1): todo lo anterior a `sending = true` ocurre antes de que el pedido salga → cualquier error
    // ahí es «no enviado». Desde que se invoca `messages.create`, un error es INCIERTO (pudo cobrarse).
    let sending = false;
    let res: any;
    try {
      // Kill switch / allow-list de proveedores ANTES de llamar. maxRetries 0: el SDK no repite (duplicaría costo); el
      // único reintento es el de validación, que decide el llamador.
      assertDirectCallAllowed('anthropic');
      if (!this.client) this.client = this.sdkFactory(); // sin ANTHROPIC_API_KEY el SDK lanza acá
      const body = {
        model: req.model,
        max_tokens: req.maxTokens,
        system: req.system,
        tools: [req.tool as any],
        tool_choice: { type: 'tool', name: req.tool.name },
        messages: [{ role: 'user', content: req.user }],
      };
      const opts = { timeout: Math.max(5_000, Math.min(req.timeoutMs, WORKSHOP_AI_TIMEOUT_MS)) };
      sending = true;
      res = await this.client.messages.create(body as any, opts);
    } catch (err) {
      if (!sending) throw new WorkshopAiNotSentError(err);
      throw err;
    }
    const block = (res.content || []).find((b: any) => b && b.type === 'tool_use' && b.name === req.tool.name) as { input?: unknown } | undefined;
    return {
      input: block && block.input !== undefined ? block.input : null,
      stopReason: (res as { stop_reason?: string | null }).stop_reason ?? null,
      model: (res as { model?: string }).model || req.model,
      messageId: res.id || null,
      usage: (res.usage as WorkshopAiUsage) || null,
    };
  }
}
