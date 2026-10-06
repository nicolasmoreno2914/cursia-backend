import type { BloomLevel, OutcomeDomain } from './academic-context';

/**
 * Nivel cognitivo (taxonomía de Bloom revisada) de un resultado de aprendizaje a partir de su verbo, con un
 * léxico cerrado en español. Determinista: el mismo texto da siempre el mismo nivel; un verbo que no está en el
 * léxico da `null` (nunca se adivina). Lo usan la extracción (nivel del resultado), las sugerencias al perfil
 * (saber / saber hacer) y la Fase 4 (qué evidencia pide cada resultado).
 */

export const BLOOM_LEXICON_VERSION = 1 as const;

const LEXICON: Readonly<Record<BloomLevel, readonly string[]>> = Object.freeze({
  remember: ['identificar', 'reconocer', 'definir', 'enumerar', 'listar', 'nombrar', 'recordar', 'citar', 'señalar', 'memorizar', 'mencionar', 'conocer'],
  understand: ['comprender', 'explicar', 'describir', 'interpretar', 'clasificar', 'resumir', 'distinguir', 'diferenciar', 'ilustrar', 'relacionar', 'entender', 'caracterizar', 'parafrasear', 'ejemplificar', 'asociar'],
  apply: ['aplicar', 'usar', 'utilizar', 'emplear', 'ejecutar', 'realizar', 'calcular', 'resolver', 'implementar', 'demostrar', 'operar', 'registrar', 'preparar', 'liquidar', 'determinar', 'practicar', 'manejar', 'medir', 'cuantificar', 'costear', 'gestionar', 'administrar', 'atender', 'redactar', 'ajustar', 'instalar', 'mantener', 'reparar', 'inspeccionar', 'configurar', 'montar', 'ensamblar', 'conectar', 'programar'],
  analyze: ['analizar', 'comparar', 'examinar', 'contrastar', 'organizar', 'descomponer', 'inferir', 'categorizar', 'diagnosticar', 'investigar', 'indagar'],
  evaluate: ['evaluar', 'valorar', 'juzgar', 'justificar', 'argumentar', 'criticar', 'decidir', 'seleccionar', 'verificar', 'defender', 'priorizar', 'auditar', 'controlar'],
  create: ['crear', 'diseñar', 'formular', 'proponer', 'desarrollar', 'construir', 'planear', 'planificar', 'elaborar', 'producir', 'componer', 'generar', 'plantear', 'estructurar', 'integrar', 'innovar'],
});

const ORDER: readonly BloomLevel[] = ['remember', 'understand', 'apply', 'analyze', 'evaluate', 'create'];

function strip(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

/** Formas reconocidas → nivel: infinitivo, 3.ª persona («aplica», «comprende»). */
const FORMS: ReadonlyMap<string, BloomLevel> = (() => {
  const m = new Map<string, BloomLevel>();
  for (const level of ORDER) {
    for (const inf of LEXICON[level]) {
      const base = strip(inf);
      const add = (f: string) => { if (!m.has(f)) m.set(f, level); };
      add(base);
      const stem = base.slice(0, -2);
      const end = base.slice(-2);
      if (end === 'ar') add(`${stem}a`);
      if (end === 'er' || end === 'ir') add(`${stem}e`);
      // «evalúa», «gradúa»: la tilde se quita al normalizar, así que «evalua» ya está cubierta por stem+a.
    }
  }
  return m;
})();

/** Frases de arranque que se saltan antes de buscar el verbo («El estudiante será capaz de…», «Al finalizar…»). */
const LEAD_RE = /^(?:(?:al\s+(?:finalizar|terminar|culminar)[^,]*,\s*)?(?:el|la|los|las)\s+(?:estudiantes?|participantes?|aprendices?|alumnos?)\s+(?:sera|seran|estara|estaran)\s+(?:capaz|capaces|en\s+capacidad)\s+de\s+|(?:ser|estar)\s+capaz\s+de\s+)/;

/** Nivel del primer verbo reconocido entre las primeras 6 palabras; null si ninguno está en el léxico. */
export function bloomLevelOf(text: string): BloomLevel | null {
  const t = strip(String(text || '')).replace(/^[\s¿¡"«(\-–—•*]+/, '').replace(LEAD_RE, '');
  const words = t.split(/[^a-zñ]+/).filter(Boolean).slice(0, 6);
  for (const w of words) {
    const level = FORMS.get(w);
    if (level) return level;
  }
  return null;
}

/** Recordar / comprender → saber; aplicar en adelante → saber hacer. Sin nivel → saber (no se presume desempeño). */
export function outcomeDomainOf(level: BloomLevel | null): OutcomeDomain {
  return level === null || level === 'remember' || level === 'understand' ? 'know' : 'do';
}

/** ¿El nivel pide desempeño (aplicar o superior)? Lo usa la Fase 4 para exigir evidencia práctica. */
export function isPerformanceLevel(level: BloomLevel | null): boolean {
  return level !== null && ORDER.indexOf(level) >= ORDER.indexOf('apply');
}

export function bloomRank(level: BloomLevel | null): number {
  return level === null ? -1 : ORDER.indexOf(level);
}
