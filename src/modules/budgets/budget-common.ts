/**
 * r75 (Agente C) — utilidades comunes del módulo de presupuestos: modo, meses (UTC), montos (string decimal), errores
 * HTTP estables (02 §D/§F), y los PUERTOS que implementan otros agentes:
 *   - auditoría: AuditLogService de A (AccessModule), en la MISMA transacción del cambio;
 *   - permisos (B: PermissionService) — token R75_PERMISSION_SERVICE (access.tokens.ts); sin proveedor: solo SA, salvo
 *     CURSIA_RBAC_MODE=off donde el dueño del curso conserva lo de hoy (dueño único).
 */
import { BadRequestException, ConflictException, ForbiddenException, Logger, NotFoundException } from '@nestjs/common';
import { cmpDec, normalizeDecimal } from '../finops/decimal';
import { userBudgetsMode, UserBudgetsMode } from '../finops/user-budget-gate';
import type { AuditLogService } from '../access/audit-log.service';

export type Runner = { query: (sql: string, params?: any[]) => Promise<any> };

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Monto máximo que acepta la API (por fila). Defensa contra errores de tipeo; no es una regla de negocio. */
export const MAX_AMOUNT_USD = '1000000';

export function budgetsMode(): UserBudgetsMode {
  return userBudgetsMode();
}

/** Con el flag en off las rutas de presupuesto no existen (404), como el gating de V2: producción no toca las tablas. */
export function assertBudgetsEnabled(): void {
  if (budgetsMode() === 'off') throw new NotFoundException({ code: 'budgets_disabled', message: 'Los presupuestos por usuario no están activos en este entorno.' });
}

// ─── meses UTC (D-17) ────────────────────────────────────────────────────────────────────────────────────────────

export function currentMonth(now: Date = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** 'YYYY-MM' válido (2020–2100) o 400 month_invalid. undefined/'' → mes actual si `allowDefault`. */
export function parseMonth(v: unknown, allowDefault = true): string {
  if ((v === undefined || v === null || v === '') && allowDefault) return currentMonth();
  if (typeof v !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(v)) {
    throw new BadRequestException({ code: 'month_invalid', message: 'month debe ser "YYYY-MM"' });
  }
  const y = Number(v.slice(0, 4));
  if (y < 2020 || y > 2100) throw new BadRequestException({ code: 'month_invalid', message: 'month fuera de rango' });
  return v;
}

export function monthDate(month: string): string {
  return `${month}-01`;
}

/** [inicio, fin) del mes en UTC. */
export function monthRange(month: string): { from: Date; to: Date } {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  return { from: new Date(Date.UTC(y, m - 1, 1)), to: new Date(Date.UTC(y, m, 1)) };
}

export function monthOfDate(v: unknown): string {
  const d = v instanceof Date ? v : new Date(String(v));
  return currentMonth(d);
}

// ─── montos ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** String decimal (hasta 10 decimales) → normalizado; nunca `number` (02: «Montos: strings decimales»). */
export function parseAmount(v: unknown, what: string, opts: { allowNegative?: boolean; allowZero?: boolean } = {}): string {
  if (typeof v !== 'string' || !/^-?\d{1,10}(\.\d{1,10})?$/.test(v.trim())) {
    throw new BadRequestException({ code: 'invalid_amount', message: `${what} debe ser un string decimal (p. ej. "12.50")` });
  }
  const n = normalizeDecimal(v.trim());
  const sign = cmpDec(n, 0);
  if (sign < 0 && !opts.allowNegative) throw new BadRequestException({ code: 'invalid_amount', message: `${what} no puede ser negativo` });
  if (sign === 0 && !opts.allowZero) throw new BadRequestException({ code: 'invalid_amount', message: `${what} no puede ser 0` });
  const abs = n.startsWith('-') ? n.slice(1) : n;
  if (cmpDec(abs, MAX_AMOUNT_USD) > 0) throw new BadRequestException({ code: 'invalid_amount', message: `${what} supera el máximo (USD ${MAX_AMOUNT_USD})` });
  return n;
}

export function parseReason(v: unknown, what = 'reason', required = true): string | null {
  if ((v === undefined || v === null || v === '') && !required) return null;
  if (typeof v !== 'string' || !v.trim() || v.length > 1000) throw new BadRequestException({ code: 'invalid_input', message: `${what} es obligatorio (1–1000 caracteres)` });
  return v.trim();
}

export function assertOnlyKeys(body: unknown, keys: readonly string[]): Record<string, unknown> {
  const b = (body && typeof body === 'object' && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
  for (const k of Object.keys(b)) if (!keys.includes(k)) throw new BadRequestException({ code: 'invalid_input', message: `campo no permitido: ${k}` });
  return b;
}

export function assertUuid(v: unknown, what: string): string {
  if (typeof v !== 'string' || !UUID_RE.test(v)) throw new BadRequestException({ code: 'invalid_input', message: `${what} debe ser UUID` });
  return v.toLowerCase();
}

export function dec(v: unknown): string {
  return normalizeDecimal(v === null || v === undefined ? '0' : String(v));
}

export function iso(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

export function pgCode(err: unknown): string | null {
  const e = err as { code?: unknown; driverError?: { code?: unknown } } | null;
  const c = e && (e.code ?? e.driverError?.code);
  return typeof c === 'string' ? c : null;
}

export const budgetRequestNotPending = (status: string) =>
  new ConflictException({ code: 'budget_request_not_pending', message: `La solicitud ya no está pendiente (${status}).` });

// ─── actor ───────────────────────────────────────────────────────────────────────────────────────────────────────

export interface BudgetActor {
  id: string;
  email: string | null;
  superAdmin: boolean;
}

// ─── auditoría (A: AuditLogService, rama r75/a-institutions) ──────────────────────────────────────────────────────

export interface BudgetAuditEntry {
  actorId: string;
  actorEmail: string | null;
  actorIsSuperadmin: boolean;
  /** 'budget.set' | 'budget.adjust' | 'request.create' | 'request.cancel' | 'request.approve' | 'request.reject' |
   *  'budget.shadow_insufficient' | 'finops.reconcile_drift'. */
  action: string;
  targetType: string;
  targetId: string | null;
  institutionId: string | null;
  before: unknown;
  after: unknown;
}

/**
 * Escritor de auditoría sobre el AuditLogService de A (`record(entry, tx)`): SIEMPRE con el runner de la tx del cambio,
 * así un cambio de presupuesto o una decisión sin su fila de auditoría nunca se commitea. Sin secretos (no hay).
 */
export class BudgetAuditWriter {
  private readonly logger = new Logger('BudgetAudit');

  constructor(private readonly audit: Pick<AuditLogService, 'record'>) {}

  async record(runner: Runner, entry: BudgetAuditEntry): Promise<void> {
    await this.audit.record({
      actorId: entry.actorId, actorEmail: entry.actorEmail, actorIsSuperAdmin: entry.actorIsSuperadmin, action: entry.action,
      targetType: entry.targetType, targetId: entry.targetId, institutionId: entry.institutionId, before: entry.before, after: entry.after,
    }, runner);
  }

  /** Para registros informativos (shadow, drift): un fallo se loguea y no rompe la operación (savepoint: la tx sigue). */
  async recordBestEffort(runner: Runner, entry: BudgetAuditEntry): Promise<void> {
    try {
      await runner.query('savepoint r75_audit_best_effort');
      await this.record(runner, entry);
      await runner.query('release savepoint r75_audit_best_effort');
    } catch (err) {
      await runner.query('rollback to savepoint r75_audit_best_effort').catch(() => undefined);
      this.logger.warn(`auditoría informativa no registrada (${entry.action}): ${(err as Error).message}`);
    }
  }
}

// ─── puerto de permisos (B) ──────────────────────────────────────────────────────────────────────────────────────

export type BudgetPermission = 'generations.start' | 'generations.retry' | 'spend.view';

export interface BudgetPermissionPort {
  /** ¿`actor` tiene `permission` en `institutionId`? (resolución de 01 §2.3; el SA ya pasa por fuera). */
  // PermissionService (B) devuelve una DECISIÓN `{ allowed, … }`, no un booleano: leerla SIEMPRE con permissionAllowed().
  can(actor: { id: string; email: string | null }, permission: BudgetPermission, institutionId: string): Promise<boolean | { allowed: boolean }>;
}

/**
 * r75 (integración, P0): el resultado de `can()` es un objeto `{ allowed, … }` (PermissionDecision de B). Un objeto es
 * «truthy» aunque sea un rechazo → usarlo como booleano abría el gasto por institución y el acceso a solicitudes y
 * presupuesto a cualquiera. Solo `allowed === true` (o un `true` literal de un puerto booleano) permite.
 */
export function permissionAllowed(result: unknown): boolean {
  if (result === true) return true;
  return !!result && typeof result === 'object' && (result as { allowed?: unknown }).allowed === true;
}

export function rbacMode(env: NodeJS.ProcessEnv = process.env): 'off' | 'shadow' | 'enforce' {
  const v = String(env.CURSIA_RBAC_MODE ?? '').trim().toLowerCase();
  return v === 'shadow' || v === 'enforce' ? v : 'off';
}

export const permissionDenied = (permission: string) =>
  new ForbiddenException({ code: 'permission_denied', permission, message: `No tienes permiso para esta acción (${permission}).` });
