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
 */
export const EXAM_BANK_DRAFT_ARTIFACT_TYPE = 'dynamic_exam_bank_draft_json';
const DRAFT_ITEM_TYPES = new Set(['exam', 'final_exam']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ExamBankDraftOutcome =
  | { recorded: true; artifactId: string }
  | { recorded: false; reason: 'not_requested' | 'not_exam_item' | 'not_retryable' | 'invalid_id' | 'artifact_mismatch' };

/**
 * Dentro de la transacción del fail (item bajo FOR UPDATE, guardas de lease ya aplicadas).
 * item = fila completa de generation_item_runs; ownerId = dueño del run (production_jobs.owner_id).
 */
export async function recordExamBankDraft(
  qr: QueryRunner,
  item: { id: string; type: string; generation: number | null; attempt_count: number | null },
  ownerId: string,
  artifactId: string | null | undefined,
  retryable: boolean,
): Promise<ExamBankDraftOutcome> {
  if (artifactId === undefined || artifactId === null || artifactId === '') return { recorded: false, reason: 'not_requested' };
  if (!DRAFT_ITEM_TYPES.has(String(item.type))) return { recorded: false, reason: 'not_exam_item' };
  if (!retryable) return { recorded: false, reason: 'not_retryable' };
  if (!UUID_RE.test(String(artifactId))) return { recorded: false, reason: 'invalid_id' };
  const [art] = await qr.query(
    `select id from public.artifacts
      where id = $1 and owner_id = $2 and type = $3 and metadata->>'itemRunId' = $4`,
    [artifactId, ownerId, EXAM_BANK_DRAFT_ARTIFACT_TYPE, item.id],
  );
  if (!art) return { recorded: false, reason: 'artifact_mismatch' };
  const draft = { artifactId: String(art.id), generation: item.generation ?? null, attempt: item.attempt_count ?? null, recordedAt: new Date().toISOString() };
  const rows = returningRows(
    await qr.query(
      `update public.generation_item_runs
          set output_summary = coalesce(output_summary, '{}'::jsonb) || jsonb_build_object('examBankDraft', $2::jsonb)
        where id = $1 and status = 'running'
        returning id`,
      [item.id, JSON.stringify(draft)],
    ),
  );
  if (rows.length !== 1) return { recorded: false, reason: 'artifact_mismatch' };
  return { recorded: true, artifactId: draft.artifactId };
}

/**
 * Fix round 2 (N2): quita `output_summary.examBankDraft` de un exam/final_exam (fail sin borrador válido).
 * No-op para otros tipos o si no hay borrador. Dentro de la transacción del fail.
 */
export async function clearExamBankDraft(qr: QueryRunner, item: { id: string; type: string; output_summary?: any }): Promise<boolean> {
  if (!DRAFT_ITEM_TYPES.has(String(item.type))) return false;
  if (!item.output_summary || typeof item.output_summary !== 'object' || !('examBankDraft' in item.output_summary)) return false;
  await qr.query(
    `update public.generation_item_runs set output_summary = output_summary - 'examBankDraft' where id = $1 and status = 'running'`,
    [item.id],
  );
  return true;
}
