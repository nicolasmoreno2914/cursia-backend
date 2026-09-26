import { CanActivate, ExecutionContext, Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { createHash, timingSafeEqual } from 'crypto';

export const FINOPS_INGEST_TOKEN_HEADER = 'x-cursia-finops-token';
export const FINOPS_INGEST_TOKEN_ENV = 'FINOPS_INGEST_TOKEN';

/**
 * Comparación en tiempo constante (sha256 de ambos lados ⇒ mismo largo, sin
 * filtrar el largo del secreto). Pura.
 */
export function finopsTokenMatches(provided: unknown, expected: string): boolean {
  if (typeof provided !== 'string' || !provided) return false;
  const a = createHash('sha256').update(provided, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b);
}

/**
 * V2.1 RF-a — autenticación del ingest server-to-server (proxy LLM → backend).
 * Env FINOPS_INGEST_TOKEN sin setear ⇒ 503 (fail loud: nunca aceptar sin secreto).
 * Header ausente o distinto ⇒ 401.
 */
@Injectable()
export class FinopsIngestTokenGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const expected = process.env[FINOPS_INGEST_TOKEN_ENV];
    if (!expected || !expected.trim()) {
      throw new ServiceUnavailableException('FinOps ingest no configurado (FINOPS_INGEST_TOKEN)');
    }
    const req = context.switchToHttp().getRequest();
    const raw = req?.headers?.[FINOPS_INGEST_TOKEN_HEADER];
    const provided = Array.isArray(raw) ? raw[0] : raw;
    if (!finopsTokenMatches(provided, expected)) {
      throw new UnauthorizedException('token de FinOps inválido');
    }
    return true;
  }
}
