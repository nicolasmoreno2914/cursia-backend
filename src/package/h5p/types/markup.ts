// Cursia V2.1 / R7-core — validación de la sintaxis de huecos `*respuesta*`
// usada por H5P.DragText y H5P.Blanks (`*respuesta/alternativa*` en Blanks).
//
// Reglas estrictas (la entrada viene de un LLM):
//  - asteriscos balanceados; ningún hueco vacío (`**`);
//  - sin anidamiento: una respuesta no empieza/termina con espacio (`*a *b* c*`
//    produce "a " y " c", que se rechazan) ni contiene saltos de línea;
//  - sin sintaxis avanzada de H5P (`:pista`, `\+`, `\-`) ni & < > dentro del hueco;
//  - en Blanks, cada alternativa separada por `/` debe ser no vacía;
//  - en DragText no hay alternativas: `/` es parte literal de la respuesta.

import { Issues } from './common';

export interface ParsedBlank {
  answer: string;
  alternatives: string[];
}

export interface ParsedMarkup {
  blanks: ParsedBlank[];
  /** Texto fuera de los huecos (para validar que no haya HTML). */
  outside: string;
}

export function parseBlankMarkup(
  issues: Issues,
  path: string,
  text: string,
  mode: 'dragtext' | 'blanks',
): ParsedMarkup {
  const parts = text.split('*');
  const blanks: ParsedBlank[] = [];
  let outside = '';
  if (parts.length % 2 === 0) {
    issues.add(path, 'asteriscos desbalanceados (cada hueco es *respuesta*)');
    return { blanks, outside: text };
  }
  parts.forEach((part, i) => {
    if (i % 2 === 0) {
      outside += part;
      return;
    }
    const n = blanks.length + 1;
    const bp = `${path} hueco ${n}`;
    if (part.length === 0) {
      issues.add(bp, 'hueco vacío (**)');
      return;
    }
    if (part.trim() !== part) issues.add(bp, `respuesta con espacios en los bordes ("${part}"): ¿asteriscos anidados?`);
    if (/[\r\n]/.test(part)) issues.add(bp, 'la respuesta no puede tener saltos de línea');
    if (/[&<>]/.test(part)) issues.add(bp, 'la respuesta no puede contener & < >');
    if (/[:\\]/.test(part)) issues.add(bp, 'sintaxis avanzada no permitida (":" o "\\")');
    let alternatives = [part.trim()];
    if (mode === 'blanks') {
      alternatives = part.split('/').map((a) => a.trim());
      if (alternatives.some((a) => a.length === 0)) issues.add(bp, 'alternativa vacía en "/"');
    }
    if (part.length > 80) issues.add(bp, 'respuesta demasiado larga (máx. 80)');
    blanks.push({ answer: alternatives[0], alternatives });
  });
  return { blanks, outside };
}
