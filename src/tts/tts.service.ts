import { Injectable, Logger } from '@nestjs/common';

const MAX_CHARS = 4000;
const DEFAULT_VOICE = 'marin';
const DEFAULT_MODEL = 'gpt-4o-mini-tts';
const OPENAI_TTS_URL = 'https://api.openai.com/v1/audio/speech';

export interface TtsSpeechOpts {
  text: string;
  voice?: string;
  model?: string;
  format?: string;
  instructions?: string;
}

export interface TtsSpeechResult {
  audioBuffer: Buffer;
  chars: number;
  voice: string;
  model: string;
  format: string;
}

@Injectable()
export class TtsService {
  private readonly logger = new Logger(TtsService.name);

  private get apiKey(): string {
    return (process.env.OPENAI_API_KEY ?? '').trim();
  }

  /** Sintetiza texto con OpenAI TTS y devuelve el buffer de audio. */
  async synthesize(opts: TtsSpeechOpts): Promise<TtsSpeechResult> {
    const text   = opts.text?.trim() ?? '';
    const voice  = (opts.voice  || process.env.OPENAI_TTS_VOICE  || DEFAULT_VOICE).trim();
    const model  = (opts.model  || process.env.OPENAI_TTS_MODEL  || DEFAULT_MODEL).trim();
    const format = (opts.format || 'mp3').trim();

    if (!this.apiKey) {
      throw new Error('OPENAI_API_KEY no configurado en el servidor — agrega la variable al .env');
    }
    if (!text) {
      throw new Error('El texto no puede estar vacío');
    }
    if (text.length > MAX_CHARS) {
      throw new Error(`El texto supera el límite de ${MAX_CHARS} caracteres (recibidos: ${text.length})`);
    }

    const body: Record<string, unknown> = { model, input: text, voice, response_format: format };
    if (opts.instructions) {
      body['instructions'] = opts.instructions;
    }

    this.logger.log(
      `[TTS] synthesize — model=${model} voice=${voice} format=${format} chars=${text.length}`,
    );

    const res = await fetch(OPENAI_TTS_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      let errMsg = `OpenAI TTS HTTP ${res.status}`;
      try {
        const parsed = JSON.parse(errText) as { error?: { message?: string } };
        if (parsed?.error?.message) errMsg += `: ${parsed.error.message}`;
      } catch { /* raw text */ }
      if (errText && errText.length < 200) errMsg += ` — ${errText}`;
      this.logger.error(`[TTS] OpenAI error: ${errMsg}`);
      throw new Error(errMsg);
    }

    const arrayBuffer = await res.arrayBuffer();
    const audioBuffer = Buffer.from(arrayBuffer);

    this.logger.log(`[TTS] OK — ${audioBuffer.length} bytes`);

    return { audioBuffer, chars: text.length, voice, model, format };
  }
}
