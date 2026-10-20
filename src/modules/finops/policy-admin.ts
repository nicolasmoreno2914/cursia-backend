/**
 * r62 (d12) — administración de políticas de presupuesto. Puro: sin DB, sin reloj.
 *
 * Las políticas (`cost_budget_policies`) son filas INMUTABLES versionadas (trigger append-only): cambiar una política es
 * insertar una versión nueva del mismo scope/scope_id. Este módulo valida el pedido del admin y arma esa versión:
 * - `limits` es un PARCHE sobre la versión vigente de ese scope (una clave en null quita ese tope; las que no vienen
 *   quedan igual), como scripts/staging-budget-policy.js;
 * - el pedido explícito de admin por política se guarda en `limits.requireHumanApprovalForRealSpend` (lo que lee
 *   policyFromRow) y también en la columna, para que fila y columna digan lo mismo desde r62;
 * - `reason` es obligatorio: queda en `created_by` junto con quién lo cambió (auditoría en la propia fila);
 * - sin cambios → noop (no se inserta una versión idéntica).
 */
import { FinopsError } from './errors';
import { cmpDec, normalizeDecimal } from './decimal';

export const POLICY_ADMIN_SCOPES = ['global', 'owner', 'course'] as const;
export type PolicyAdminScope = (typeof POLICY_ADMIN_SCOPES)[number];

/** Topes totales (USD) que acepta el endpoint. */
export const POLICY_TOTAL_LIMIT_KEYS = ['maxCostPerRun', 'maxCostPerCourse', 'monthlyCap', 'monthlyCapStaging', 'ownerMonthlyCap'] as const;
/** Topes por parte (mapa clave → USD | null). */
export const POLICY_MAP_LIMIT_KEYS = ['maxCostPerProvider', 'maxCostPerItemType'] as const;
/** Cota de cordura de un tope (USD): un valor mayor es casi seguro un error de tipeo. */
export const POLICY_LIMIT_SANITY_MAX = '100000';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY_RE = /^[a-z][a-z0-9_]{0,63}$/i;

export interface PolicyRow {
  id?: string;
  scope: string;
  scope_id: string | null;
  version: number;
  limits: Record<string, unknown>;
  require_human_approval_for_real_spend: boolean;
  on_exceed: string;
  created_by?: string | null;
  created_at?: string | Date | null;
}

export interface PolicyUpdateRequest {
  scope: PolicyAdminScope;
  scopeId: string | null;
  limits: Record<string, unknown>;
  onExceed: 'BLOCK' | 'ADMIN_APPROVAL' | null;
  requireHumanApprovalForRealSpend: boolean | null;
  reason: string;
}

function bad(msg: string): never {
  throw new FinopsError('INVALID_INPUT', msg);
}

function limitValue(v: unknown, what: string): string | null {
  if (v === null) return null;
  if (typeof v !== 'string' && typeof v !== 'number') bad(`${what}: debe ser un número/decimal en USD o null`);
  if (typeof v === 'string' && !/^\d+(\.\d{1,10})?$/.test(v.trim())) bad(`${what}: decimal inválido (${String(v).slice(0, 40)})`);
  if (typeof v === 'number' && (!Number.isFinite(v) || v < 0)) bad(`${what}: número inválido (${String(v)})`);
  const n = normalizeDecimal(typeof v === 'string' ? v.trim() : v, what);
  if (cmpDec(n, 0) < 0) bad(`${what}: no puede ser negativo`);
  if (cmpDec(n, POLICY_LIMIT_SANITY_MAX) > 0) bad(`${what}: supera la cota de cordura de USD ${POLICY_LIMIT_SANITY_MAX}`);
  // Se guarda como texto decimal exacto (igual que las políticas existentes con '106').
  return typeof v === 'string' ? v.trim() : String(v);
}

/** Valida el cuerpo de POST /finops/budget-policies. Lanza FinopsError INVALID_INPUT con el motivo. */
export function parsePolicyUpdate(body: unknown): PolicyUpdateRequest {
  if (!body || typeof body !== 'object' || Array.isArray(body)) bad('cuerpo inválido');
  const b = body as Record<string, unknown>;
  for (const k of Object.keys(b)) {
    if (!['scope', 'scopeId', 'limits', 'onExceed', 'requireHumanApprovalForRealSpend', 'reason'].includes(k)) bad(`campo no permitido: ${k}`);
  }
  const scope = b.scope;
  if (typeof scope !== 'string' || !(POLICY_ADMIN_SCOPES as readonly string[]).includes(scope)) bad(`scope inválido: debe ser ${POLICY_ADMIN_SCOPES.join(' | ')}`);
  let scopeId: string | null = null;
  if (scope === 'global') {
    if (b.scopeId !== undefined && b.scopeId !== null) bad('scope global no lleva scopeId');
  } else if (scope === 'course') {
    const raw = typeof b.scopeId === 'number' ? String(b.scopeId) : b.scopeId;
    if (typeof raw !== 'string' || !/^[1-9]\d{0,9}$/.test(raw)) bad('scopeId de un curso: id numérico');
    scopeId = raw;
  } else {
    if (typeof b.scopeId !== 'string' || !UUID_RE.test(b.scopeId)) bad('scopeId de un dueño: UUID');
    scopeId = (b.scopeId as string).toLowerCase();
  }
  const limits: Record<string, unknown> = {};
  if (b.limits !== undefined) {
    if (!b.limits || typeof b.limits !== 'object' || Array.isArray(b.limits)) bad('limits debe ser un objeto');
    for (const [k, v] of Object.entries(b.limits as Record<string, unknown>)) {
      if ((POLICY_TOTAL_LIMIT_KEYS as readonly string[]).includes(k)) {
        limits[k] = limitValue(v, `limits.${k}`);
      } else if ((POLICY_MAP_LIMIT_KEYS as readonly string[]).includes(k)) {
        if (v === null) { limits[k] = null; continue; }
        if (!v || typeof v !== 'object' || Array.isArray(v)) bad(`limits.${k} debe ser un objeto {clave: USD | null} o null`);
        const m: Record<string, string | null> = {};
        for (const [kk, vv] of Object.entries(v as Record<string, unknown>)) {
          if (!KEY_RE.test(kk)) bad(`limits.${k}: clave inválida (${kk.slice(0, 40)})`);
          m[kk] = limitValue(vv, `limits.${k}.${kk}`);
        }
        limits[k] = m;
      } else if (k === 'requireHumanApprovalForRealSpend') {
        bad('requireHumanApprovalForRealSpend va al nivel del cuerpo, no dentro de limits');
      } else {
        bad(`limits.${k}: tope desconocido (permitidos: ${[...POLICY_TOTAL_LIMIT_KEYS, ...POLICY_MAP_LIMIT_KEYS].join(', ')})`);
      }
    }
  }
  const onExceed = b.onExceed === undefined || b.onExceed === null ? null : b.onExceed;
  if (onExceed !== null && onExceed !== 'BLOCK' && onExceed !== 'ADMIN_APPROVAL') bad('onExceed inválido: BLOCK | ADMIN_APPROVAL');
  const rh = b.requireHumanApprovalForRealSpend === undefined || b.requireHumanApprovalForRealSpend === null ? null : b.requireHumanApprovalForRealSpend;
  if (rh !== null && typeof rh !== 'boolean') bad('requireHumanApprovalForRealSpend debe ser boolean');
  if (typeof b.reason !== 'string' || b.reason.trim().length < 5 || b.reason.length > 500) bad('reason es obligatorio (5 a 500 caracteres): queda en la auditoría de la política');
  if (Object.keys(limits).length === 0 && onExceed === null && rh === null) bad('nada que cambiar: limits, onExceed o requireHumanApprovalForRealSpend');
  return { scope: scope as PolicyAdminScope, scopeId, limits, onExceed: onExceed as PolicyUpdateRequest['onExceed'], requireHumanApprovalForRealSpend: rh as boolean | null, reason: b.reason.trim() };
}

function canonical(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v as object).sort().map((k) => JSON.stringify(k) + ':' + canonical((v as any)[k])).join(',') + '}';
  return JSON.stringify(v === undefined ? null : v);
}

function sameLimitValue(a: unknown, b: unknown): boolean {
  if ((a === null || a === undefined) && (b === null || b === undefined)) return true;
  if (a === null || a === undefined || b === null || b === undefined) return false;
  if ((typeof a === 'string' || typeof a === 'number') && (typeof b === 'string' || typeof b === 'number')) {
    try { return cmpDec(normalizeDecimal(a), normalizeDecimal(b)) === 0; } catch { return false; }
  }
  return canonical(a) === canonical(b);
}

/**
 * Plan (puro) de la versión nueva. `current` = versión vigente de ESE scope/scope_id (o null). → noop | insert.
 * Un pedido sin versión previa necesita los tres topes totales o el admin explícito (nunca una política nueva «sin tope»
 * sin decirlo): una política sin topes igual exige admin (decideRunBudget), pero así el error es visible al crearla.
 */
export function planPolicyUpdate(current: PolicyRow | null, req: PolicyUpdateRequest, actor: string):
  { action: 'noop'; current: PolicyRow } | { action: 'insert'; row: Omit<PolicyRow, 'id' | 'created_at'> } {
  if (typeof actor !== 'string' || !actor.trim()) bad('actor obligatorio');
  const base = current && current.limits && typeof current.limits === 'object' ? { ...current.limits } : {};
  const next: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(req.limits)) {
    if (v === null) delete next[k];
    else next[k] = v;
  }
  const curExplicit = base.requireHumanApprovalForRealSpend === true;
  const explicit = req.requireHumanApprovalForRealSpend === null ? curExplicit : req.requireHumanApprovalForRealSpend;
  if (explicit) next.requireHumanApprovalForRealSpend = true;
  else delete next.requireHumanApprovalForRealSpend;
  const onExceed = req.onExceed ?? (current ? current.on_exceed : 'BLOCK');
  if (current) {
    const keys = new Set([...Object.keys(base), ...Object.keys(next)]);
    const same = [...keys].every((k) => sameLimitValue(base[k], next[k])) && onExceed === current.on_exceed
      && current.require_human_approval_for_real_spend === explicit;
    if (same) return { action: 'noop', current };
  } else {
    const has = (k: string) => next[k] !== undefined && next[k] !== null;
    const monthly = has('monthlyCap') || has('monthlyCapStaging');
    if (!explicit && !(has('maxCostPerRun') && has('maxCostPerCourse') && monthly)) {
      bad('una política nueva necesita maxCostPerRun, maxCostPerCourse y monthlyCap (o requireHumanApprovalForRealSpend: true)');
    }
  }
  return {
    action: 'insert',
    row: {
      scope: req.scope,
      scope_id: req.scopeId,
      version: current ? Number(current.version) + 1 : 1,
      limits: next,
      require_human_approval_for_real_spend: explicit,
      on_exceed: onExceed,
      created_by: `admin_policy_update:${actor.trim()} · ${req.reason}`.slice(0, 1000),
    },
  };
}
