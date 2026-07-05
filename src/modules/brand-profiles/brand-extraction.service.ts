import { Injectable, Logger } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';

export interface ExtractedBrand {
  colors: {
    m1: string; m1a: string; m2: string; m2a: string;
    m3: string; m3a: string; accent: string; dark: string;
  };
  typography: Record<string, any> | null;
  usageRules: Record<string, any> | null;
  raw: Record<string, any>;
  warnings: string[];
}

/** Paleta navy-teal (firma Cursia) — fallback seguro para campos no extraídos. */
const SAFE_DEFAULTS = {
  m1: '#1A3C5E', m1a: '#BAD4FE', m2: '#0B6B56', m2a: '#99F6E4',
  m3: '#7D3C98', m3a: '#E9D5FF', accent: '#E8692A', dark: '#060F1C',
};

const HEX = /^#[0-9a-fA-F]{6}$/;

const EXTRACTION_SCHEMA = {
  type: 'object',
  properties: {
    colors: {
      type: 'object',
      description: 'Colores dominantes del manual de marca, en hex de 6 dígitos',
      properties: {
        primary: { type: ['string', 'null'], description: 'Color primario/institucional principal (hex)' },
        secondary: { type: ['string', 'null'], description: 'Color secundario (hex)' },
        tertiary: { type: ['string', 'null'], description: 'Tercer color de marca si existe (hex)' },
        accent: { type: ['string', 'null'], description: 'Color de acento/llamadas a la acción (hex)' },
        darkBackground: { type: ['string', 'null'], description: 'Color de fondo oscuro derivado de la marca (hex muy oscuro)' },
      },
      required: ['primary', 'secondary', 'tertiary', 'accent', 'darkBackground'],
      additionalProperties: false,
    },
    typography: {
      type: 'object',
      properties: {
        heading: { type: ['string', 'null'], description: 'Fuente para títulos' },
        body: { type: ['string', 'null'], description: 'Fuente para cuerpo de texto' },
        notes: { type: ['string', 'null'], description: 'Notas sobre uso tipográfico' },
      },
      required: ['heading', 'body', 'notes'],
      additionalProperties: false,
    },
    usageRules: {
      type: 'array',
      description: 'Reglas de uso de marca relevantes (texto libre, en español)',
      items: { type: 'string' },
    },
    confidence: {
      type: 'string',
      enum: ['high', 'medium', 'low'],
      description: 'Confianza global de la extracción',
    },
  },
  required: ['colors', 'typography', 'usageRules', 'confidence'],
  additionalProperties: false,
} as const;

@Injectable()
export class BrandExtractionService {
  private readonly logger = new Logger(BrandExtractionService.name);
  private readonly client = new Anthropic();
  private readonly model = process.env.BRAND_EXTRACTION_MODEL || 'claude-opus-4-8';

  /**
   * Extrae el brand kit de un PDF de manual de marca con Claude (multimodal).
   * Nunca devuelve colores vacíos: completa huecos con SAFE_DEFAULTS y lo
   * registra en warnings para la revisión humana.
   */
  async extractFromPdf(pdfBuffer: Buffer): Promise<ExtractedBrand> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 4096,
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
                'Este es el manual de marca de una institución educativa. Extrae su identidad visual: ' +
                'los colores institucionales dominantes (hex exactos si el manual los declara; si solo aparecen ' +
                'en imágenes, infiérelos de forma conservadora), las tipografías, y las reglas de uso de marca ' +
                'más importantes (restricciones de logo, combinaciones prohibidas, etc.). ' +
                'Para darkBackground deriva una versión muy oscura (~90% más oscura) del color primario, apta como fondo de interfaz dark. ' +
                'Si un dato no aparece en el manual, devuélvelo como null — no lo inventes.',
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

    return this.mapToBrand(extracted);
  }

  /** Mapea la extracción cruda a los 8 campos de paleta + warnings del linter. */
  private mapToBrand(raw: any): ExtractedBrand {
    const warnings: string[] = [];
    const c = raw?.colors || {};

    const pick = (value: any, fallbackKey: keyof typeof SAFE_DEFAULTS, label: string): string => {
      if (typeof value === 'string' && HEX.test(value.trim())) return value.trim();
      warnings.push(`No se pudo extraer ${label}; se usó un color por defecto (${SAFE_DEFAULTS[fallbackKey]}).`);
      return SAFE_DEFAULTS[fallbackKey];
    };

    const m1 = pick(c.primary, 'm1', 'el color primario');
    const m2 = pick(c.secondary, 'm2', 'el color secundario');
    const m3 = pick(c.tertiary, 'm3', 'el tercer color de marca');
    const accent = pick(c.accent, 'accent', 'el color de acento');
    const dark = pick(c.darkBackground, 'dark', 'el fondo oscuro');

    // Colores de texto por módulo: versión clara derivada del fondo del módulo
    const m1a = this.lightVariant(m1);
    const m2a = this.lightVariant(m2);
    const m3a = this.lightVariant(m3);

    const colors = { m1, m1a, m2, m2a, m3, m3a, accent, dark };

    // Linter de contraste WCAG AA (≥4.5:1) — advierte, no bloquea
    (['m1', 'm2', 'm3'] as const).forEach((k) => {
      const bg = colors[k];
      const fg = colors[(k + 'a') as 'm1a' | 'm2a' | 'm3a'];
      const ratio = this.contrastRatio(bg, fg);
      if (ratio < 4.5) {
        warnings.push(
          `Contraste bajo entre ${k} (${bg}) y su texto (${fg}): ${ratio.toFixed(2)}:1 — mínimo recomendado 4.5:1.`,
        );
      }
    });
    if (this.contrastRatio(m1, '#FFFFFF') < 4.5) {
      warnings.push(`El color primario ${m1} tiene contraste bajo con texto blanco.`);
    }

    return {
      colors,
      typography: raw?.typography ?? null,
      usageRules: Array.isArray(raw?.usageRules) ? { rules: raw.usageRules } : null,
      raw,
      warnings,
    };
  }

  /** Variante clara de un color (para texto sobre el fondo del módulo). */
  private lightVariant(hex: string): string {
    const [r, g, b] = this.rgb(hex);
    // Mezcla 75% hacia blanco manteniendo el hue
    const mix = (ch: number) => Math.round(ch + (255 - ch) * 0.78);
    return (
      '#' +
      [mix(r), mix(g), mix(b)]
        .map((v) => v.toString(16).padStart(2, '0').toUpperCase())
        .join('')
    );
  }

  private rgb(hex: string): [number, number, number] {
    const h = hex.replace('#', '');
    return [
      parseInt(h.slice(0, 2), 16),
      parseInt(h.slice(2, 4), 16),
      parseInt(h.slice(4, 6), 16),
    ];
  }

  /** Luminancia relativa WCAG. */
  private luminance(hex: string): number {
    const [r, g, b] = this.rgb(hex).map((v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  private contrastRatio(a: string, b: string): number {
    const la = this.luminance(a);
    const lb = this.luminance(b);
    const [hi, lo] = la > lb ? [la, lb] : [lb, la];
    return (hi + 0.05) / (lo + 0.05);
  }
}
