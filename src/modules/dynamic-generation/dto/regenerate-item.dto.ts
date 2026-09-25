import { BadRequestException } from '@nestjs/common';

/**
 * F78-BE2: body de `POST …/runs/:runId/items/:itemKey/regenerate` —
 * `{ confirmPaid?: boolean }`, sin ningún otro campo.
 *
 * Se valida A MANO (no con class-validator + el ValidationPipe global): con
 * `enableImplicitConversion` un `"false"` o un `1` se convertirían a `true`
 * (Boolean("false") === true), y la confirmación de un gasto tiene que ser el
 * booleano LITERAL `true`. Acá cualquier valor que no sea boolean → 400.
 * Si la regeneración cuesta, el servicio exige además `confirmPaid === true`.
 */
export function parseRegenerateItemBody(body: unknown): boolean | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body !== 'object' || Array.isArray(body)) {
    throw new BadRequestException('El body debe ser un objeto JSON {"confirmPaid": true}');
  }
  const extra = Object.keys(body).filter((k) => k !== 'confirmPaid');
  if (extra.length > 0) {
    throw new BadRequestException(extra.map((k) => `property ${k} should not exist`).join('; '));
  }
  const v = (body as Record<string, unknown>).confirmPaid;
  if (v === undefined) return undefined;
  if (typeof v !== 'boolean') {
    throw new BadRequestException('confirmPaid debe ser el booleano true (no un string ni un número)');
  }
  return v;
}
