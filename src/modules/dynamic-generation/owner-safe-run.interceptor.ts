import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { isSuperAdminEmail } from '../../auth/super-admin';
import { redactCompletionForOwner } from './run-completion';

/**
 * DoD follow-up (R3): las respuestas de RunsController (RunDto suelto o `{run: RunDto}`) llevan
 * `completion`; a quien NO es SUPER_ADMIN se le quita el texto de admin del bloqueo del paquete
 * (`redactCompletionForOwner`). Un SUPER_ADMIN recibe el detalle completo. Recorre solo objetos planos y
 * arrays, con profundidad acotada; nunca muta la respuesta original.
 */
export function redactRunPayloadForOwner(value: unknown, depth = 0): unknown {
  if (depth > 4 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redactRunPayloadForOwner(v, depth + 1));
  if (value instanceof Date || Buffer.isBuffer(value)) return value;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k === 'completion' && v && typeof v === 'object' && !Array.isArray(v)) out[k] = redactCompletionForOwner(v as any);
    else if (k === 'courseContext' || k === 'items') out[k] = v; // nunca llevan `completion`
    else out[k] = redactRunPayloadForOwner(v, depth + 1);
  }
  return out;
}

@Injectable()
export class OwnerSafeRunInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<{ user?: { email?: string | null } }>();
    const admin = isSuperAdminEmail(req?.user?.email ?? null);
    return next.handle().pipe(map((data) => (admin ? data : redactRunPayloadForOwner(data))));
  }
}
