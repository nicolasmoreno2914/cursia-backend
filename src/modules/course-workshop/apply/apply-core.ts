/**
 * r107 B6 · Taller de cursos — APLICAR un plan aprobado: núcleo PURO (sin Nest, sin base, sin red, sin IA, sin disco).
 *
 *   runApply({ original, expectedSha1, items, baseline })
 *     1. verifica que los bytes sean el original de la sesión (sha1): nunca se aplica sobre otra cosa;
 *     2. corre el MOTOR de B4 con las operaciones congeladas del plan, en orden (todo o nada) — el motor ya incluye la
 *        compuerta antes/después del diagnóstico de B3 (ningún hallazgo nuevo de error / aviso);
 *     3. VALIDADOR: en la línea v3, `validateMbzV3Structure` antes y después (ningún problema nuevo por código); en las
 *        demás, la estructura (el motor reabre el paquete nuevo con el lector seguro y el diagnóstico corre T01–T03);
 *     4. restauración: si hay un verificador conectado (un Moodle), se usa; si no, `not_available` con su texto — nunca
 *        «restaurado» sin haberlo hecho (regla 5, ruling de B6);
 *     5. devuelve el paquete nuevo + el INFORME DE CAMBIOS por ítem + el diagnóstico del resultado + la validación.
 *   Cualquier paso que falla devuelve la etapa, un código y el motivo en español (nunca un paquete parcial).
 *
 * Las reglas de qué ítems se aplican y qué confirmaciones hacen falta también viven acá (puras), para que el servicio y
 * la prueba usen exactamente las mismas.
 */
import { createHash } from 'crypto';
import { openMbz } from '../mbz-reader';
import { builderLineOf, readPackageFacts } from '../identify';
import { DiagnosisReport } from '../diagnosis/diagnose';
import { applyPatchPlan } from '../patch/engine';
import { stableStringify } from '../course-model';
import type { DiagnosisDelta, FieldChange, OperationReport, PatchOperation } from '../patch/types';
import { MbzV3Issue, validateMbzV3Structure } from '../../../package/v3/mbz-validator-v3';

export const APPLY_CODE_VERSION = 'b6-r0';

/** Texto EXACTO del ruling de B6 cuando no hay un Moodle conectado para restaurar. */
export const RESTORE_NOT_AVAILABLE_MESSAGE = 'Verificado en su estructura; la prueba de restauración en Moodle todavía no está disponible en este entorno';
export type RestoreCheckStatus = 'passed' | 'failed' | 'not_available';

/**
 * Interfaz para conectar un Moodle de verificación cuando exista (hoy en staging no hay ninguno: decisión 2026-10-02,
 * cotizar antes de contratar). `passed` solo si la restauración real terminó sin errores.
 */
export interface RestoreChecker {
  readonly name: string;
  check(pkg: Buffer, meta: { filename: string; sha1: string }): Promise<{ status: 'passed' | 'failed'; message: string }>;
}

/**
 * Memoria del trabajo de aplicar (RSS máximo medido, proceso aislado, sobre la base del proceso; motor = original +
 * resultado + diagnóstico(s) de B3 + el validador): v3 real 106 MB zip 6,2× (con el diagnóstico guardado como «antes»
 * 6,2×), V1 real 112 MB zip 4,7× (4,4×), re-export tar.gz 70 MB 9,0× (7,6×). Factores con margen: zip 7×, tar.gz 10×.
 * Con el tope de subida de 200 MB el peor caso es 2,0 GB (tar.gz): entra justo en el presupuesto por defecto (2 GB).
 */
export const APPLY_MEMORY_FACTOR_ZIP = 7;
export const APPLY_MEMORY_FACTOR_TGZ = 10;
export function applyMemoryFactor(container: string | null | undefined): number {
  return container === 'tar.gz' ? APPLY_MEMORY_FACTOR_TGZ : APPLY_MEMORY_FACTOR_ZIP;
}

const sha = (alg: 'sha1' | 'sha256', b: Buffer) => createHash(alg).update(b).digest('hex');

// ── qué se aplica (al aprobar) ──

/** Un ítem del plan tal como lo ve la regla de aplicar. */
export interface ApplyCandidate {
  id: string;
  requestId: string;
  operation: string;
  /** `proposed` / `removed` (el docente lo quitó) y estado del pedido. */
  status: 'proposed' | 'removed';
  requestStatus: string;
  stage: 'estimate' | 'ready';
  available: boolean;
  params: PatchOperation | null;
  requiresItemConfirm: boolean;
  summary: string;
  quote: string;
  riskLevel: string;
  /** Fix round 1 (P2-2): huella del contenido revisado (`itemContentHash`). */
  contentHash?: string;
}

export interface ApplySelection {
  /** Lo que se aplica, en el orden del plan. */
  apply: ApplyCandidate[];
  /** De una fase posterior (no se aplican todavía; se informan). */
  later: ApplyCandidate[];
  /** Lo que impide aplicar (con el motivo para el docente). */
  blocking: Array<{ itemId: string; reason: string }>;
}

/**
 * Regla de aplicar: los ítems propuestos (no quitados, pedido no retirado) de la Fase 2 tienen que tener su contenido
 * GENERADO (o no necesitarlo) y su pedido `resolved`; los de fase posterior no entran (se informan).
 */
export function selectApplyItems(items: ApplyCandidate[]): ApplySelection {
  const live = items.filter((i) => i.status === 'proposed' && i.requestStatus !== 'withdrawn');
  const out: ApplySelection = { apply: [], later: [], blocking: [] };
  for (const i of live) {
    if (!i.available) { out.later.push(i); continue; }
    if (i.stage !== 'ready') { out.blocking.push({ itemId: i.id, reason: 'Todavía no se generó su contenido (antes/después): apruébalo en el plan primero.' }); continue; }
    if (i.requestStatus !== 'resolved') { out.blocking.push({ itemId: i.id, reason: `Su pedido no está listo (${i.requestStatus}).` }); continue; }
    if (!i.params) { out.blocking.push({ itemId: i.id, reason: 'No tiene la operación resuelta.' }); continue; }
    out.apply.push(i);
  }
  return out;
}

/** Confirmaciones individuales (riesgo alto, B5 P2-4): las que faltan y las que no corresponden a ningún ítem que se aplica. */
export function confirmationsMissing(apply: ApplyCandidate[], confirmed: readonly string[]): { missing: string[]; unknown: string[] } {
  // (fix round 1, P2-2: el servicio ya filtró las confirmaciones cuya huella no es la del contenido actual)
  const need = new Set(apply.filter((i) => i.requiresItemConfirm).map((i) => i.id));
  const ids = new Set(apply.map((i) => i.id));
  const conf = new Set(confirmed.map((x) => x.toLowerCase()));
  return { missing: [...need].filter((id) => !conf.has(id)), unknown: [...conf].filter((id) => !ids.has(id)) };
}

// ── lo que el docente revisó (fix round 1, P2-2) ──

/**
 * Huella del CONTENIDO de un ítem tal como el docente lo ve en el plan: la operación con sus parámetros resueltos (lo que
 * el motor aplica: destino, HTML nuevo, pregunta, colores…) + el antes/después generado + archivos y entradas. Si el ítem
 * se vuelve a generar o a interpretar con el mismo id, la huella cambia: aplicar exige la que el docente aprobó.
 */
export function itemContentHash(x: { operation: string; stage: string; params: unknown; view: { changes?: unknown; files?: unknown; entries?: unknown } | null }): string {
  const v = x.view ?? {};
  return createHash('sha256').update(stableStringify({ operation: x.operation, stage: x.stage, params: x.params ?? null, changes: v.changes ?? [], files: v.files ?? [], entries: v.entries ?? null })).digest('hex');
}

/** Huella del PLAN que se aplica: los ítems que entran, en orden, cada uno con su huella de contenido. */
export function planContentHash(items: Array<{ id: string; contentHash: string }>): string {
  return createHash('sha256').update(items.map((i) => `${i.id.toLowerCase()}:${i.contentHash}`).join('\n')).digest('hex');
}

/** Lo que el docente envía al aprobar: cada ítem con la huella que vio (y la del plan), las confirmaciones igual. */
export interface ApplyApproval {
  planHash: string;
  items: Array<{ id: string; contentHash: string }>;
  confirm: Array<{ id: string; contentHash: string }>;
}

/** Diferencias entre lo aprobado y lo que hay ahora (pura): ítems que cambiaron de contenido, sobran o faltan. */
export function approvalMismatch(current: Array<{ id: string; contentHash: string }>, a: ApplyApproval): { changed: string[]; missing: string[]; extra: string[]; planHashOk: boolean } {
  const cur = new Map(current.map((i) => [i.id.toLowerCase(), i.contentHash]));
  const sent = new Map(a.items.map((i) => [i.id.toLowerCase(), i.contentHash]));
  return {
    changed: [...sent].filter(([id, h]) => cur.has(id) && cur.get(id) !== h).map(([id]) => id),
    missing: [...cur.keys()].filter((id) => !sent.has(id)),
    extra: [...sent.keys()].filter((id) => !cur.has(id)),
    planHashOk: planContentHash(current) === a.planHash,
  };
}

// ── informe de cambios ──

/** Tope de caracteres de cada antes/después en el INFORME (el paquete siempre lleva el texto completo). */
export const REPORT_FIELD_MAX_CHARS = 200_000;

export interface VersionItemReport {
  itemId: string;
  requestId: string;
  operation: string;
  quote: string;
  summary: string;
  fields: Array<Omit<FieldChange, 'before' | 'after'> & { before: string; after: string; truncated: boolean }>;
  files: OperationReport['files'];
  entries: { added: string[]; removed: string[]; modified: string[] };
  idsAssigned: Record<string, number[]>;
  misalignment: string[];
  notes: string[];
}

export function itemReports(items: Array<Pick<ApplyCandidate, 'id' | 'requestId' | 'operation' | 'quote' | 'summary'>>, ops: OperationReport[]): VersionItemReport[] {
  const cut = (s: string) => (s.length > REPORT_FIELD_MAX_CHARS ? `${s.slice(0, REPORT_FIELD_MAX_CHARS)}… (recortado en el informe; el paquete tiene el texto completo)` : s);
  return items.map((it, i) => {
    const r = ops[i];
    return {
      itemId: it.id, requestId: it.requestId, operation: it.operation, quote: it.quote, summary: r?.summary || it.summary,
      fields: (r?.fields ?? []).map((f) => ({ ...f, before: cut(f.before), after: cut(f.after), truncated: f.before.length > REPORT_FIELD_MAX_CHARS || f.after.length > REPORT_FIELD_MAX_CHARS })),
      files: r?.files ?? [], entries: { added: r?.entriesAdded ?? [], removed: r?.entriesRemoved ?? [], modified: r?.entriesModified ?? [] },
      idsAssigned: r?.idsAssigned ?? {}, misalignment: r?.misalignment ?? [], notes: r?.notes ?? [],
    };
  });
}

// ── validador ──

export interface ApplyValidation {
  mode: 'v3_structure' | 'structure';
  /** Problemas del validador v3 por código (sin CLEAN_SAFE, que es estilo): antes / después. */
  before: Record<string, number> | null;
  after: Record<string, number> | null;
  /** Códigos con más problemas después que antes (la versión falla si hay alguno). */
  introduced: Array<{ code: string; before: number; after: number; sample: string }>;
  note: string;
}

const countIssues = (issues: MbzV3Issue[]) => {
  const m: Record<string, number> = {};
  for (const i of issues) if (i.code !== 'CLEAN_SAFE') m[i.code] = (m[i.code] ?? 0) + 1;
  return m;
};

export async function validateResult(original: Buffer, result: Buffer, builderLine: string): Promise<ApplyValidation> {
  if (builderLine !== 'v3') {
    return { mode: 'structure', before: null, after: null, introduced: [], note: 'Paquete de una línea anterior al builder v3: el paquete nuevo se reabrió con el lector seguro y el diagnóstico verificó el contenedor, los archivos (sha1 ↔ blob) y los ids (T01–T03).' };
  }
  const b = await validateMbzV3Structure(original);
  const a = await validateMbzV3Structure(result);
  const before = countIssues(b.issues);
  const after = countIssues(a.issues);
  const introduced = Object.keys(after).filter((k) => after[k] > (before[k] ?? 0)).map((code) => ({
    code, before: before[code] ?? 0, after: after[code], sample: a.issues.find((x) => x.code === code)?.message?.slice(0, 300) ?? '',
  }));
  return { mode: 'v3_structure', before, after, introduced, note: 'Validador del builder v3 (reglas que leen los bytes) sobre el original y sobre el paquete nuevo.' };
}

// ── correr ──

export interface ApplyRunItem {
  id: string;
  requestId: string;
  operation: string;
  quote: string;
  summary: string;
  params: PatchOperation;
}

export interface ApplyRunInput {
  original: Buffer;
  expectedSha1: string;
  filename?: string | null;
  items: ApplyRunItem[];
  baseline?: { originalSha1: string; report: DiagnosisReport } | null;
  restoreChecker?: RestoreChecker | null;
  /** Avisa el paso (el servicio lo guarda: building → verifying). */
  onStage?: (stage: 'verifying') => Promise<void> | void;
}

export type ApplyStage = 'verify_original' | 'engine' | 'gate' | 'validator' | 'restore';

export interface ApplyRunOk {
  ok: true;
  package: Buffer;
  sha1: string;
  sha256: string;
  size: number;
  container: 'zip' | 'tar.gz';
  items: VersionItemReport[];
  diagnosis: DiagnosisDelta;
  validation: ApplyValidation;
  preservedEntries: number;
  restoreCheck: { status: RestoreCheckStatus; message: string; checker: string | null };
}
export interface ApplyRunFail {
  ok: false;
  stage: ApplyStage;
  code: string;
  message: string;
  /** El mismo pedido con los mismos bytes fallaría igual: no se reintenta solo. */
  retryable: boolean;
  failedItemId: string | null;
  diagnosis: DiagnosisDelta | null;
  validation: ApplyValidation | null;
}

export async function runApply(input: ApplyRunInput): Promise<ApplyRunOk | ApplyRunFail> {
  const fail = (stage: ApplyStage, code: string, message: string, extra: Partial<ApplyRunFail> = {}): ApplyRunFail => ({
    ok: false, stage, code, message, retryable: false, failedItemId: null, diagnosis: null, validation: null, ...extra,
  });
  if (sha('sha1', input.original) !== input.expectedSha1) {
    return fail('verify_original', 'WORKSHOP_ORIGINAL_CHANGED', 'Los bytes del original no son los de la sesión: no se aplica nada.');
  }
  if (!input.items.length) return fail('engine', 'WORKSHOP_APPLY_EMPTY', 'El plan no tiene ítems para aplicar.');
  const res = await applyPatchPlan({ original: input.original, filename: input.filename ?? null, operations: input.items.map((i) => i.params), baseline: input.baseline ?? null });
  if (!res.ok || !res.package) {
    const f = res.failure;
    const item = f && f.opIndex !== null ? input.items[f.opIndex] ?? null : null;
    const gate = f?.code === 'new_findings';
    return fail(gate ? 'gate' : 'engine', `WORKSHOP_APPLY_${String(f?.code ?? 'failed').toUpperCase()}`,
      gate
        ? `El paquete arreglado tendría problemas nuevos que el original no tenía, así que no se entrega: ${f?.message ?? ''}`
        : `No se pudo aplicar${item ? ` el ítem «${item.summary || item.operation}»` : ' el plan'}: ${f?.message ?? 'motivo desconocido'}`,
      { failedItemId: item?.id ?? null, diagnosis: res.diagnosis ?? null });
  }
  await input.onStage?.('verifying');
  const out = res.package;
  let validation: ApplyValidation;
  try {
    const facts = await readPackageFacts(await openMbz(input.original), input.filename ?? null);
    validation = await validateResult(input.original, out, builderLineOf(facts));
  } catch (e) {
    return fail('validator', 'WORKSHOP_APPLY_VALIDATOR_FAILED', `No se pudo correr el validador sobre el paquete nuevo: ${e instanceof Error ? e.message : String(e)}`, { diagnosis: res.diagnosis });
  }
  if (validation.introduced.length) {
    return fail('validator', 'WORKSHOP_APPLY_VALIDATOR_REJECTED',
      `El validador del builder encontró problemas nuevos en el paquete arreglado: ${validation.introduced.map((x) => `${x.code} (${x.before} → ${x.after}): ${x.sample}`).slice(0, 3).join(' · ')}`,
      { diagnosis: res.diagnosis, validation });
  }
  const sha1 = sha('sha1', out);
  let restoreCheck: ApplyRunOk['restoreCheck'] = { status: 'not_available', message: RESTORE_NOT_AVAILABLE_MESSAGE, checker: null };
  if (input.restoreChecker) {
    let r: { status: 'passed' | 'failed'; message: string };
    try {
      r = await input.restoreChecker.check(out, { filename: input.filename ?? 'version.mbz', sha1 });
    } catch (e) {
      return fail('restore', 'WORKSHOP_APPLY_RESTORE_ERROR', `La prueba de restauración en Moodle no se pudo correr: ${e instanceof Error ? e.message : String(e)}`, { retryable: true, diagnosis: res.diagnosis, validation });
    }
    if (r.status !== 'passed') return fail('restore', 'WORKSHOP_APPLY_RESTORE_FAILED', `El paquete arreglado NO restaura en Moodle: ${r.message}`, { diagnosis: res.diagnosis, validation });
    restoreCheck = { status: 'passed', message: r.message, checker: input.restoreChecker.name };
  }
  return {
    ok: true, package: out, sha1, sha256: sha('sha256', out), size: out.length, container: res.container,
    items: itemReports(input.items, res.operations), diagnosis: res.diagnosis as DiagnosisDelta, validation, preservedEntries: res.preservedEntries, restoreCheck,
  };
}

// ── cadena de versiones ──

export interface ChainLink { versionId: string; sessionId: string; number: number; parentVersionId: string | null }

/** Número de la versión nueva: el de su padre + 1 (el original cuenta como 0). */
export function nextVersionNumber(parent: { number: number } | null): number {
  return (parent?.number ?? 0) + 1;
}

/** Cadena desde el original hasta `leaf` (orden original → leaf). Corta ante un ciclo (nunca debería existir). */
export function chainOf(leaf: ChainLink | null, byId: Map<string, ChainLink>): ChainLink[] {
  const out: ChainLink[] = [];
  const seen = new Set<string>();
  let cur = leaf;
  while (cur && !seen.has(cur.versionId)) {
    seen.add(cur.versionId);
    out.unshift(cur);
    cur = cur.parentVersionId ? byId.get(cur.parentVersionId) ?? null : null;
  }
  return out;
}

/** Ruta del paquete de una versión en la carpeta del dueño (determinista: un reintento sube a la misma ruta). */
export function versionStoragePath(ownerId: string, sessionId: string, number: number, sha1: string): string {
  return `${ownerId.toLowerCase()}/workshop/${sessionId.toLowerCase()}/versions/v${number}-${sha1.slice(0, 12)}.mbz`;
}
