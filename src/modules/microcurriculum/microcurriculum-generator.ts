import Anthropic from '@anthropic-ai/sdk';
import { assertDirectCallAllowed } from '../finops/direct-call-ledger';
import type { McTool } from './prompt';

/**
 * r81 · Generador del microcurrículo: UNA llamada a Claude con herramienta forzada (`tool_choice: { type: 'tool' }`).
 * Se inyecta por el token Nest MICROCURRICULUM_GENERATOR para que las pruebas usen un generador falso (sin red). El
 * servicio decide qué es una salida inválida (sin tool_use o cortada por max_tokens) y cuándo reintentar; aquí solo se
 * llama y se devuelve lo medido (uso, modelo e id del mensaje para el ledger de FinOps).
 */

export const MICROCURRICULUM_GENERATOR = 'MICROCURRICULUM_GENERATOR';

export interface McGenerationRequest {
  model: string;
  system: string;
  user: string;
  tool: McTool;
  maxTokens: number;
  /** Tiempo máximo de ESTA llamada (lo acota el plazo total de la petición síncrona). */
  timeoutMs: number;
}

export interface McGenerationResult {
  /** `input` del bloque tool_use de la herramienta pedida; null si el modelo no la llamó. */
  input: unknown | null;
  stopReason: string | null;
  model: string;
  messageId: string | null;
  usage: { input_tokens?: number | null; output_tokens?: number | null; cache_creation_input_tokens?: number | null; cache_read_input_tokens?: number | null } | null;
}

export interface MicrocurriculumGenerator {
  generate(req: McGenerationRequest): Promise<McGenerationResult>;
}

export const MICROCURRICULUM_MAX_TOKENS = 12000;
export const MICROCURRICULUM_CALL_TIMEOUT_MS = 140_000;

export function microcurriculumModel(env: NodeJS.ProcessEnv = process.env): string {
  return env.MICROCURRICULUM_MODEL || 'claude-sonnet-4-6';
}

export class AnthropicMicrocurriculumGenerator implements MicrocurriculumGenerator {
  private client: Anthropic | null = null;

  async generate(req: McGenerationRequest): Promise<McGenerationResult> {
    // Kill switch / allow-list de proveedores ANTES de llamar (llamada directa: no reserva en el ledger).
    assertDirectCallAllowed('anthropic');
    if (!this.client) this.client = new Anthropic({ timeout: MICROCURRICULUM_CALL_TIMEOUT_MS, maxRetries: 1 });
    const res = await this.client.messages.create(
      {
        model: req.model,
        max_tokens: req.maxTokens,
        system: req.system,
        tools: [req.tool as any],
        tool_choice: { type: 'tool', name: req.tool.name },
        messages: [{ role: 'user', content: req.user }],
      } as any,
      { timeout: Math.max(5_000, Math.min(req.timeoutMs, MICROCURRICULUM_CALL_TIMEOUT_MS)) },
    );
    const block = (res.content || []).find((b: any) => b && b.type === 'tool_use' && b.name === req.tool.name) as { input?: unknown } | undefined;
    return {
      input: block && block.input !== undefined ? block.input : null,
      stopReason: (res as { stop_reason?: string | null }).stop_reason ?? null,
      model: (res as { model?: string }).model || req.model,
      messageId: res.id || null,
      usage: (res.usage as McGenerationResult['usage']) || null,
    };
  }
}
