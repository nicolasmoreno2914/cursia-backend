import type { QueryRunner } from 'typeorm';
import { returningRows } from '../../common/db/returning-rows';

/**
 * BANKOPT (opción 1e) — borrador del banco de un examen entre intentos.
 *
 * Contrato mínimo (sin migración: vive en `generation_item_runs.output_summary`):
 *  - el ejecutor del navegador, ante EXAM_BANK_INCOMPLETE / EXAM_BANK_GENERATION_FAILED, sube un artifact
 *    `dynamic_exam_bank_draft_json` (preguntas VÁLIDAS del intento, con itemRunId en metadata) y manda su
 *    id en el fail (`FailItemDto.examBankDraftArtifactId`);
 *  - el servidor lo acepta solo si el item es exam/final_exam, el fail es retryable y el artifact es del
 *    dueño del run, de ese tipo y de ESE item run; entonces deja
 *    `output_summary.examBankDraft = { artifactId, generation, attempt, recordedAt }` (si no, lo ignora:
 *    el fail se registra igual, nunca se rechaza por el borrador);
 *  - un fail con `examBankDraftArtifactId: null` explícito BORRA el anterior (fix round 2 N2 / round 4 R4):
 *    el ejecutor lo manda ante una falla de reglas del banco sin faltante; un fail transitorio sin el campo
 *    lo conserva;
 *  - el claim ya devuelve `outputSummary`; además anuncia el soporte con
 *    `claimPayload.examBank.draftArtifactType` (el FailItemDto anterior rechazaría el campo por whitelist).
 * El ejecutor solo usa el borrador si coinciden generación, alcance, versión de prompt, plan y el sha256
 * del Markdown de cada capítulo, y RE-VALIDA cada pregunta; el servidor sigue validando el banco final
 * completo al completar (validateExamBank), así que el borrador nunca se confía.
 *
 * O2b — mismo contrato para `application_activity`: si la 1.ª pasada (actividad del estudiante) quedó
 * validada y la 2.ª (solucionario) falla reintentable, el ejecutor sube `dynamic_application_draft_json`
 * y manda `FailItemDto.applicationDraftArtifactId`; el servidor lo deja en `output_summary.applicationDraft`
 * con las MISMAS guardas (tipo de item, retryable, dueño, tipo de artifact, itemRunId) y el claim lo anuncia
 * con `claimPayload.application.draftArtifactType`. El ejecutor exige generación, item, capítulo, minutos,
 * schemaVersion, versión de prompt, sha256 del Markdown fuente y `resumes` < 1, y RE-VALIDA la actividad; el
 * servidor valida el documento completo al completar (validateApplicationDoc).
 */
export const EXAM_BANK_DRAFT_ARTIFACT_TYPE = 'dynamic_exam_bank_draft_json';
export const APPLICATION_DRAFT_ARTIFACT_TYPE = 'dynamic_application_draft_json';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ItemDraftKind {
  /** Clave en output_summary. */
  summaryKey: 'examBankDraft' | 'applicationDraft';
  artifactType: string;
  itemTypes: ReadonlySet<string>;
  wrongItemReason: 'not_exam_item' | 'not_application_item';
}
const EXAM_BANK_KIND: ItemDraftKind = {
  summaryKey: 'examBankDraft', artifactType: EXAM_BANK_DRAFT_ARTIFACT_TYPE, itemTypes: new Set(['exam', 'final_exam']), wrongItemReason: 'not_exam_item',
};
const APPLICATION_KIND: ItemDraftKind = {
  summaryKey: 'applicationDraft', artifactType: APPLICATION_DRAFT_ARTIFACT_TYPE, itemTypes: new Set(['application_activity']), wrongItemReason: 'not_application_item',
};

/** Claves de output_summary que solo sirven entre intentos (completeItem las quita). */
export const ITEM_DRAFT_SUMMARY_KEYS: readonly string[] = Object.freeze([EXAM_BANK_KIND.summaryKey, APPLICATION_KIND.summaryKey]);

export type ItemDraftOutcome =
  | { recorded: true; artifactId: string }
  | { recorded: false; reason: 'not_requested' | 'not_exam_item' | 'not_application_item' | 'not_retryable' | 'invalid_id' | 'artifact_mismatch' };
export type ExamBankDraftOutcome = ItemDraftOutcome;

type DraftItem = { id: string; type: string; generation: number | null; attempt_count: number | null };

async function recordItemDraft(
  kind: ItemDraftKind,
  qr: QueryRunner,
  item: DraftItem,
  ownerId: string,
  artifactId: string | null | undefined,
  retryable: boolean,
): Promise<ItemDraftOutcome> {
  if (artifactId === undefined || artifactId === null || artifactId === '') return { recorded: false, reason: 'not_requested' };
  if (!kind.itemTypes.has(String(item.type))) return { recorded: false, reason: kind.wrongItemReason };
  if (!retryable) return { recorded: false, reason: 'not_retryable' };
  if (!UUID_RE.test(String(artifactId))) return { recorded: false, reason: 'invalid_id' };
  const [art] = await qr.query(
    `select id from public.artifacts
      where id = $1 and owner_id = $2 and type = $3 and metadata->>'itemRunId' = $4`,
    [artifactId, ownerId, kind.artifactType, item.id],
  );
  if (!art) return { recorded: false, reason: 'artifact_mismatch' };
  const draft = { artifactId: String(art.id), generation: item.generation ?? null, attempt: item.attempt_count ?? null, recordedAt: new Date().toISOString() };
  const rows = returningRows(
    await qr.query(
      `update public.generation_item_runs
          set output_summary = coalesce(output_summary, '{}'::jsonb) || jsonb_build_object($3::text, $2::jsonb)
        where id = $1 and status = 'running'
        returning id`,
      [item.id, JSON.stringify(draft), kind.summaryKey],
    ),
  );
  if (rows.length !== 1) return { recorded: false, reason: 'artifact_mismatch' };
  return { recorded: true, artifactId: draft.artifactId };
}

async function clearItemDraft(kind: ItemDraftKind, qr: QueryRunner, item: { id: string; type: string; output_summary?: any }): Promise<boolean> {
  if (!kind.itemTypes.has(String(item.type))) return false;
  if (!item.output_summary || typeof item.output_summary !== 'object' || !(kind.summaryKey in item.output_summary)) return false;
  await qr.query(
    `update public.generation_item_runs set output_summary = output_summary - $2::text where id = $1 and status = 'running'`,
    [item.id, kind.summaryKey],
  );
  return true;
}

/**
 * Dentro de la transacción del fail (item bajo FOR UPDATE, guardas de lease ya aplicadas).
 * item = fila completa de generation_item_runs; ownerId = dueño del run (production_jobs.owner_id).
 */
export function recordExamBankDraft(
  qr: QueryRunner,
  item: DraftItem,
  ownerId: string,
  artifactId: string | null | undefined,
  retryable: boolean,
): Promise<ItemDraftOutcome> {
  return recordItemDraft(EXAM_BANK_KIND, qr, item, ownerId, artifactId, retryable);
}

/**
 * Fix round 2 (N2): quita `output_summary.examBankDraft` de un exam/final_exam (fail sin borrador válido).
 * No-op para otros tipos o si no hay borrador. Dentro de la transacción del fail.
 */
export function clearExamBankDraft(qr: QueryRunner, item: { id: string; type: string; output_summary?: any }): Promise<boolean> {
  return clearItemDraft(EXAM_BANK_KIND, qr, item);
}

/** O2b: igual que recordExamBankDraft para application_activity (`output_summary.applicationDraft`). */
export function recordApplicationDraft(
  qr: QueryRunner,
  item: DraftItem,
  ownerId: string,
  artifactId: string | null | undefined,
  retryable: boolean,
): Promise<ItemDraftOutcome> {
  return recordItemDraft(APPLICATION_KIND, qr, item, ownerId, artifactId, retryable);
}

/** O2b: quita `output_summary.applicationDraft` de un application_activity. No-op para otros tipos. */
export function clearApplicationDraft(qr: QueryRunner, item: { id: string; type: string; output_summary?: any }): Promise<boolean> {
  return clearItemDraft(APPLICATION_KIND, qr, item);
}
