import { BadRequestException } from '@nestjs/common';

/**
 * F78-BE2: body de `POST …/runs/:runId/items/:itemKey/regenerate` —
 * `{ confirmPaid?: boolean, dryRun?: boolean, expectedGeneration?: integer ≥ 1 }`,
 * sin ningún otro campo.
 *
 * Se valida A MANO (no con class-validator + el ValidationPipe global): con
 * `enableImplicitConversion` un `"false"` o un `1` se convertirían a `true`
 * (Boolean("false") === true), y la confirmación de un gasto tiene que ser el
 * booleano LITERAL `true`. Acá cualquier tipo inesperado → 400.
 * Si la regeneración cuesta, el servicio exige además `confirmPaid === true`
 * (salvo en `dryRun`, que no escribe nada).
 */
export interface RegenerateItemBody {
  confirmPaid?: boolean;
  dryRun?: boolean;
  expectedGeneration?: number;
}

const ALLOWED = new Set(['confirmPaid', 'dryRun', 'expectedGeneration']);

export function parseRegenerateItemBody(body: unknown): RegenerateItemBody {
  if (body === undefined || body === null) return {};
  if (typeof body !== 'object' || Array.isArray(body)) {
    throw new BadRequestException('El body debe ser un objeto JSON {"confirmPaid": true}');
  }
  const extra = Object.keys(body).filter((k) => !ALLOWED.has(k));
  if (extra.length > 0) {
    throw new BadRequestException(extra.map((k) => `property ${k} should not exist`).join('; '));
  }
  const b = body as Record<string, unknown>;
  const out: RegenerateItemBody = {};
  if (b.confirmPaid !== undefined) {
    if (typeof b.confirmPaid !== 'boolean') {
      throw new BadRequestException('confirmPaid debe ser el booleano true (no un string ni un número)');
    }
    out.confirmPaid = b.confirmPaid;
  }
  if (b.dryRun !== undefined) {
    if (typeof b.dryRun !== 'boolean') throw new BadRequestException('dryRun debe ser un booleano');
    out.dryRun = b.dryRun;
  }
  if (b.expectedGeneration !== undefined) {
    const g = b.expectedGeneration;
    if (typeof g !== 'number' || !Number.isInteger(g) || g < 1) {
      throw new BadRequestException('expectedGeneration debe ser un entero ≥ 1 (la generación vigente que viste)');
    }
    out.expectedGeneration = g;
  }
  return out;
}
