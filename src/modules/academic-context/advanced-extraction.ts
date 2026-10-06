// LOOP 8.1 · Lectura avanzada de documentos (cargador único, respaldo con costo).
//
// Solo cuando la extracción gratuita no alcanza (PDF escaneado, ilegible o sin lo esencial) y solo con el clic del
// usuario después de ver el costo. La IA NO arma el contexto: TRANSCRIBE el PDF a texto y ese texto pasa por el MISMO
// extractor determinista (mismas reglas, mismas validaciones, mismas citas). El gasto se registra en FinOps.
// Apagada por defecto (ACADEMIC_ADVANCED_EXTRACTION_ENABLED=true para encenderla): USD 0 hasta que el dueño la active.
import Anthropic from '@anthropic-ai/sdk';

export const ADVANCED_EXTRACTION_OPERATION = 'llm.academic_extraction';
export const ADVANCED_MAX_OUTPUT_TOKENS = 16000;
/** Tarifas de referencia (USD por millón de tokens) del modelo por defecto; el registro real usa el catálogo FinOps. */
export const ADVANCED_REFERENCE_PRICE = Object.freeze({ inputPerMTok: 3, outputPerMTok: 15 });
/** Uso típico por página de un PDF escaneado (imagen + texto) y su transcripción; el rango cubre lo atípico. */
export const ADVANCED_TOKENS = Object.freeze({ inputPerPage: 1800, outputPerPage: 700, inputBase: 600 });
export const ADVANCED_RANGE = Object.freeze({ min: 0.6, max: 2 });
/**
 * Review L81 I4: solo se aceptan los PDF cuya transcripción típica CABE en una respuesta (con margen): más páginas
 * fallarían truncadas después de cobrar. 16000 tokens / 700 por página ≈ 22 → 20 páginas.
 */
export const ADVANCED_MAX_PAGES = Math.floor((ADVANCED_MAX_OUTPUT_TOKENS - 1000) / ADVANCED_TOKENS.outputPerPage / 1.05);

export function advancedExtractionEnabled(): boolean {
  return process.env.ACADEMIC_ADVANCED_EXTRACTION_ENABLED === 'true';
}
export function advancedExtractionModel(): string {
  return process.env.ACADEMIC_ADVANCED_EXTRACTION_MODEL || 'claude-sonnet-4-6';
}

const cents = (x: number) => Math.round(x * 100) / 100;
const ceilCents = (x: number) => Math.ceil(x * 100) / 100;

export interface AdvancedEstimate {
  pages: number;
  model: string;
  estimateUsd: { min: number; expected: number; max: number };
  assumptions: string[];
}

/** Costo estimado por páginas (aproximado, con rango). Nunca precisión inventada: dólares con 2 decimales y rango. */
export function estimateAdvancedExtraction(pages: number, model = advancedExtractionModel()): AdvancedEstimate {
  const p = Math.max(1, pages);
  const input = ADVANCED_TOKENS.inputBase + p * ADVANCED_TOKENS.inputPerPage;
  // Nunca se cobra más salida que el tope de la respuesta (review L81 I4).
  const output = Math.min(p * ADVANCED_TOKENS.outputPerPage, ADVANCED_MAX_OUTPUT_TOKENS);
  const expected = (input * ADVANCED_REFERENCE_PRICE.inputPerMTok + output * ADVANCED_REFERENCE_PRICE.outputPerMTok) / 1e6;
  // El máximo tampoco supera lo que la respuesta puede producir.
  const ceiling = (input * ADVANCED_RANGE.max * ADVANCED_REFERENCE_PRICE.inputPerMTok + ADVANCED_MAX_OUTPUT_TOKENS * ADVANCED_REFERENCE_PRICE.outputPerMTok) / 1e6;
  return {
    pages: p,
    model,
    estimateUsd: { min: cents(expected * ADVANCED_RANGE.min), expected: ceilCents(expected), max: ceilCents(Math.min(expected * ADVANCED_RANGE.max, ceiling)) },
    assumptions: [
      `${p} página(s); unos ${ADVANCED_TOKENS.inputPerPage} tokens de lectura y ${ADVANCED_TOKENS.outputPerPage} de transcripción por página`,
      'tarifas de referencia del modelo; el gasto real queda en el registro de costos',
    ],
  };
}

export interface TranscriptionResult {
  text: string;
  model: string;
  messageId: string;
  usage: { input_tokens: number; output_tokens: number };
  truncated: boolean;
}
export interface DocumentTranscriber {
  transcribe(input: { name: string; pdf: Buffer; model: string }): Promise<TranscriptionResult>;
}

export const TRANSCRIPTION_PROMPT =
  'Transcribe este documento académico (microcurrículo, sílabo o guía) a texto plano en Markdown, FIEL al original: ' +
  'conserva los títulos de sección (por ejemplo «Resultados de aprendizaje», «Competencias», «Unidades», «Contenidos», ' +
  '«Intensidad horaria», «Evaluación», «Bibliografía»), las listas, la numeración y las tablas (como tablas Markdown). ' +
  'No resumas, no interpretes, no corrijas y no agregues nada que no esté en el documento. Si un fragmento es ilegible, ' +
  'escribe [ilegible]. Responde solo con la transcripción.';

/** Transcriptor real (Anthropic). Las pruebas inyectan uno falso: el gate nunca llama a un proveedor. */
export class AnthropicTranscriber implements DocumentTranscriber {
  private client: Anthropic | null = null;
  async transcribe(input: { name: string; pdf: Buffer; model: string }): Promise<TranscriptionResult> {
    if (!this.client) this.client = new Anthropic();
    const res = await this.client.messages.create({
      model: input.model,
      max_tokens: ADVANCED_MAX_OUTPUT_TOKENS,
      messages: [{
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: input.pdf.toString('base64') } },
          { type: 'text', text: TRANSCRIPTION_PROMPT },
        ],
      }],
    } as any);
    const text = (res.content || []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n').trim();
    return {
      text,
      model: res.model || input.model,
      messageId: res.id,
      usage: { input_tokens: res.usage?.input_tokens ?? 0, output_tokens: res.usage?.output_tokens ?? 0 },
      truncated: res.stop_reason === 'max_tokens',
    };
  }
}
