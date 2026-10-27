/**
 * r75 (Agente C) — punto de extensión de FinOps para el presupuesto mensual POR USUARIO (01 §5).
 *
 * FinOps no depende del módulo de presupuestos (evita la dependencia circular de Nest): `BudgetsModule` registra su
 * implementación al iniciar (`FinopsBudgetService.setUserBudgetGate` / `FinopsLedgerService.setUserBudgetGate`). Sin
 * gate registrado, o con `CURSIA_USER_BUDGETS=off` (default), TODO se comporta exactamente como antes de r75.
 *
 * El presupuesto por usuario es un control MÁS: nunca reemplaza al tope por run (insertReservationWithinRunCap), al
 * runtimeGuard / budget_exceeded, a la política global, al kill switch ni al techo de gasto sin atribuir.
 */
import { DecimalLike } from './decimal';

export type UserBudgetsMode = 'off' | 'shadow' | 'enforce';
export const CURSIA_USER_BUDGETS_ENV = 'CURSIA_USER_BUDGETS';
export const USER_BUDGETS_MODES: readonly UserBudgetsMode[] = ['off', 'shadow', 'enforce'];

/** Valor del flag; null = valor inválido (el módulo de presupuestos no arranca con un valor inválido). */
export function parseUserBudgetsMode(raw: unknown): UserBudgetsMode | null {
  const v = raw === undefined || raw === null ? '' : String(raw).trim().toLowerCase();
  if (v === '') return 'off';
  return (USER_BUDGETS_MODES as readonly string[]).includes(v) ? (v as UserBudgetsMode) : null;
}

/** Modo vigente. Un valor inválido en caliente se lee como 'off' (el arranque ya lo rechaza: BudgetsModule). */
export function userBudgetsMode(env: NodeJS.ProcessEnv = process.env): UserBudgetsMode {
  return parseUserBudgetsMode(env[CURSIA_USER_BUDGETS_ENV]) ?? 'off';
}

/** Lock consultivo por usuario (01 §5.2 paso 3). Orden fijo: curso → MONTH_CAP_LOCK → usuario → (run-cap del run). */
export const USER_BUDGET_LOCK_PREFIX = 'finops:user-budget:';

/** Código del ledger cuando una llamada SIN run no entra en el disponible del usuario (HTTP 409 user_budget_insufficient). */
export const USER_BUDGET_EXHAUSTED = 'USER_BUDGET_EXHAUSTED';
/** Código del ledger/budget cuando un arranque / ampliación no entra en el disponible (HTTP 409 user_budget_insufficient). */
export const USER_BUDGET_INSUFFICIENT = 'USER_BUDGET_INSUFFICIENT';

/**
 * Costo real > reservado (01 §5.5). r75 mantiene el comportamiento vigente: el run se PAUSA (`run_budget_cap`,
 * pauseRunIfOverCap con overshoot) y para seguir hace falta una autorización. Las alternativas B–E están documentadas en
 * validation/r75-roles/LEDGER.md («Fase 1 · C»); NINGUNA se activa. Este es el único punto de extensión: una constante.
 */
export type OvershootPolicy = 'pause';
export const OVERSHOOT_POLICY: OvershootPolicy = 'pause';

type Runner = { query: (sql: string, params?: any[]) => Promise<any> };

export type ReservationKind = 'start' | 'extension' | 'upgrade' | 'reopen';

export interface ReserveRunInput {
  runId: string;
  courseId: number;
  /** Quien paga con su presupuesto (iniciador del run; D-20: los reintentos de otro miembro se cargan al iniciador). */
  payerUserId: string;
  kind: ReservationKind;
  authorizationId: string | null;
  /** Autorización vigente del run DESPUÉS de este paso (la que acaba de escribir el caller en la misma tx). */
  authorizedBudget: DecimalLike;
  /** Autorización vigente ANTES de este paso (null = run nuevo). */
  previousAuthorizedBudget?: DecimalLike | null;
  /**
   * Solo el SuperAdmin (POST finops/courses/:id/authorizations {runId, extendUserBudget:true}, o la aprobación de una
   * solicitud): si no entra, crea en la MISMA tx un month_adjustment auditado por la diferencia (nunca invisible).
   */
  extendUserBudget?: { actorId: string; actorEmail: string | null; reason: string } | null;
}

export interface UserBudgetGate {
  /** Modo vigente (off = el gate no hace nada; el caller ni siquiera lo llama). */
  mode(): UserBudgetsMode;
  /**
   * Controles de A en cada arranque / reapertura / upgrade (01 §2.3, §7), con o sin presupuestos activos: congelación de
   * plataforma (también para el SA) y suspensión de cuenta o de generación de quien paga → 403 estable. Sin el esquema
   * de A (producción hoy) no hay filas: no cambia nada.
   */
  assertMayStart(runner: Runner, payerUserId: string): Promise<void>;
  /** Reanudar / reintentar un run existente: los controles de A sobre quien PAGA el run (D-20), no sobre quien hace clic. */
  assertPayerMaySpend(runner: Runner, runId: string): Promise<void>;
  /** Reabrir un run terminal vuelve a retener max(autorizado − gastado, 0) del iniciador: tiene que entrar (D-20). */
  assertRunReopenFits(runner: Runner, runId: string): Promise<void>;
  /** Disponible del mes (sin un run) para la vista previa del estimado (`userBudget`). Sin caché, solo lectura. */
  availability(runner: Runner, payerUserId: string, excludeRunId?: string | null): Promise<{ month: string; available: string; assigned: boolean }>;
  /** Pasos 2–3: MONTH_CAP_LOCK y luego el lock del usuario, dentro de la tx del caller (antes de escribir la autorización). */
  lockForRun(runner: Runner, payerUserId: string): Promise<void>;
  /** Pasos 5–8: disponible recalculado en la tx (sin caché), rechazo 409 o reserva + startedBy. */
  reserveRun(runner: Runner, input: ReserveRunInput): Promise<{ reservationId: string | null; shadowInsufficient: boolean }>;
  /** Quién paga un run existente (reserva 'start' → input_payload.startedBy → owner_id). */
  payerOfRun(runner: Runner, runId: string): Promise<string | null>;
  /**
   * Llamada pagada SIN run (proxy sin parte, llamadas directas con reserva): exige disponible ≥ monto bajo el lock del
   * usuario. Lanza FinopsError USER_BUDGET_EXHAUSTED en enforce (shadow: solo registra). Reintento idempotente → no evalúa.
   */
  guardUnattributedSpend(runner: Runner, input: { userId: string; amount: DecimalLike; idempotencyKey: string }): Promise<void>;
  /** Institución a la que se atribuye un evento NUEVO del ledger (01 §6). null = sin institución (solo la ve el SA). */
  institutionForCharge(runner: Runner, input: { ownerId: string; courseId: number | null; runId: string | null }): Promise<string | null>;
}

/**
 * Acceso del sujeto a gastar (cuenta autorizada / no suspendida / generación no suspendida / plataforma no congelada).
 * Lo implementan A/B (suspensiones, allow-list); FinOps solo lo consulta en `finops/ingest/llm-reservation` (02 §E.5).
 * → null = permitido; si no, el código estable y su HTTP.
 */
export interface SubjectSpendAccess {
  denialFor(subjectUserId: string): Promise<null | { code: 'account_not_authorized' | 'account_suspended' | 'generation_suspended' | 'platform_generation_frozen'; status: 403; message: string }>;
}
