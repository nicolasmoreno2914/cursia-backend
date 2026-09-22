import { Injectable, Logger } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';

export interface ExtractedCourseSetup {
  purpose: string | null;
  sector: string | null;
  suggestedName: string | null;
  country: string | null;
  level: 'basico' | 'intermedio' | 'avanzado' | null;
  tone: 'conversacional' | 'tecnico' | 'directo' | 'motivador' | null;
  context: 'bachillerato' | 'tecnico' | 'universitario' | 'corporativo' | 'posgrado' | 'otro' | null;
  warnings: string[];
}

const EXTRACTION_SCHEMA = {
  type: 'object',
  properties: {
    purpose: {
      type: ['string', 'null'],
      description: 'Qué logrará el estudiante al terminar el curso, en 1-3 frases, redactado como objetivo de aprendizaje',
    },
    sector: { type: ['string', 'null'], description: 'Sector o industria del curso (ej: Salud, Tecnología, Manufactura)' },
    suggestedName: { type: ['string', 'null'], description: 'Nombre corto y atractivo para el curso, máximo 8 palabras' },
    country: { type: ['string', 'null'], description: 'País del contexto del curso si se menciona explícitamente, en español' },
    level: {
      type: ['string', 'null'],
      enum: ['basico', 'intermedio', 'avanzado', null],
      description: 'Nivel de conocimiento previo esperado del estudiante',
    },
    tone: {
      type: ['string', 'null'],
      enum: ['conversacional', 'tecnico', 'directo', 'motivador', null],
      description: 'Tono de redacción que mejor calza con el documento fuente',
    },
    context: {
      type: ['string', 'null'],
      enum: ['bachillerato', 'tecnico', 'universitario', 'corporativo', 'posgrado', 'otro', null],
      description: 'Contexto educativo del curso',
    },
    confidence: {
      type: 'string',
      enum: ['high', 'medium', 'low'],
      description: 'Confianza global de la extracción',
    },
  },
  required: ['purpose', 'sector', 'suggestedName', 'country', 'level', 'tone', 'context', 'confidence'],
  additionalProperties: false,
} as const;

@Injectable()
export class CourseSetupExtractionService {
  private readonly logger = new Logger(CourseSetupExtractionService.name);
  private readonly client = new Anthropic();
  private readonly model = process.env.COURSE_SETUP_EXTRACTION_MODEL || 'claude-opus-4-8';

  /**
   * Extrae los campos de "Datos del curso" de una guía/sílabo en PDF.
   * No persiste nada: es un prefill de un solo uso, nunca inventa datos
   * ausentes (devuelve null) y reporta baja confianza en warnings.
   */
  async extractFromPdf(pdfBuffer: Buffer): Promise<ExtractedCourseSetup> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 2048,
      output_config: {
        format: { type: 'json_schema', schema: EXTRACTION_SCHEMA as any },
      },
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'document',
              source: {
                type: 'base64',
                media_type: 'application/pdf',
                data: pdfBuffer.toString('base64'),
              },
            },
            {
              type: 'text',
              text:
                'Este es una guía, sílabo o brief de un curso que se va a crear en una plataforma de generación de ' +
                'cursos con IA para Moodle. Léelo y extrae la información que permita prellenar el formulario de ' +
                'creación del curso: qué logrará el estudiante al terminar (el propósito/objetivo principal), el ' +
                'sector o industria, un nombre corto y atractivo para el curso, el país si se menciona, el nivel de ' +
                'conocimiento previo esperado, el tono de redacción que mejor calza, y el contexto educativo. ' +
                'Si un dato no aparece o no se puede inferir razonablemente del documento, devuélvelo como null — ' +
                'no lo inventes.',
            },
          ],
        },
      ],
    });

    if (response.stop_reason === 'refusal') {
      throw new Error('El modelo rechazó procesar el documento');
    }

    const textBlock = response.content.find((b) => b.type === 'text');
    if (!textBlock || textBlock.type !== 'text') {
      throw new Error('Respuesta sin contenido de texto');
    }
    const extracted = JSON.parse(textBlock.text);

    return this.mapToResult(extracted);
  }

  private mapToResult(raw: any): ExtractedCourseSetup {
    const warnings: string[] = [];

    const str = (value: any, label: string): string | null => {
      if (typeof value === 'string' && value.trim()) return value.trim();
      warnings.push(`No se pudo extraer ${label} del documento.`);
      return null;
    };

    const enumField = <T extends string>(value: any, allowed: readonly T[], label: string): T | null => {
      if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) return value as T;
      if (value !== null && value !== undefined) {
        warnings.push(`No se pudo determinar ${label} con confianza a partir del documento.`);
      }
      return null;
    };

    if (raw?.confidence === 'low') {
      warnings.push('La confianza general de esta extracción es baja — revisa los campos antes de continuar.');
    }

    return {
      purpose: str(raw?.purpose, 'el propósito del curso'),
      sector: str(raw?.sector, 'el sector o industria'),
      suggestedName: str(raw?.suggestedName, 'un nombre sugerido'),
      country: str(raw?.country, 'el país'),
      level: enumField(raw?.level, ['basico', 'intermedio', 'avanzado'] as const, 'el nivel de conocimiento previo'),
      tone: enumField(raw?.tone, ['conversacional', 'tecnico', 'directo', 'motivador'] as const, 'el tono'),
      context: enumField(
        raw?.context,
        ['bachillerato', 'tecnico', 'universitario', 'corporativo', 'posgrado', 'otro'] as const,
        'el contexto educativo',
      ),
      warnings,
    };
  }
}
