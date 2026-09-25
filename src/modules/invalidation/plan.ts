import type { BlueprintSnapshotV1 } from '../course-blueprints/blueprint-snapshot';
import { cmpStr, sha256Canonical } from '../coherence/canonical-json';
import { Outline } from '../coherence/coherence-types';
import {
  BlueprintFingerprints,
  INVALIDATION_FINGERPRINT_VERSION,
  computeFingerprints,
  itemFingerprint,
  matchFingerprint,
  parseItemKey,
} from './fingerprints';

/**
 * Fase 8 — plan de invalidación (spec §1–§3). Función PURA, por UUID: sin
 * DB, sin reloj, sin red. Cada item del Manifest destino recibe exactamente
 * una acción, y cada item del Manifest origen ausente del destino también.
 *
 * Reglas (spec §3), resumen de cómo se implementan:
 *  - content: `own` cambió ⇒ REGENERATE. Si no, cambios de contexto (movido
 *    de módulo, título/objetivo del módulo editado, contexto del curso,
 *    reordenado dentro del módulo, módulo reordenado) ⇒ REVIEW. Si nada ⇒ REUSE.
 *  - scorm: REGENERATE si su content genera salida nueva; si no REUSE.
 *  - video: STALE_NO_AUTO si su content genera salida nueva (costo); si no REUSE.
 *  - exam: REGENERATE si cambió su huella (membresía, título/objetivo del
 *    módulo, `own` de un content) o si un content del módulo genera salida
 *    nueva; si no REUSE. Reordenar no cambia el conjunto ⇒ REUSE.
 *  - module_intro / course_plan / course_intro: REGENERATE si cambió su
 *    huella; si no REUSE. Las huellas no dependen del orden: reordenar
 *    nunca las regenera. `course_plan` NO encadena a los content.
 *  - item nuevo en el destino ⇒ GENERATE, salvo que exista un artifact
 *    `disabled` de esa misma key cuya huella coincida ⇒ REUSE (toggle ON).
 *  - item del origen ausente del destino ⇒ SOFT_DISABLE.
 *  - Reutilizar exige salida previa: item run completado con artifact
 *    `ready`. Si el artifact ya está `stale`, el video sigue STALE_NO_AUTO y
 *    el resto pasa a REGENERATE; si no hay salida previa ⇒ GENERATE.
 */

export const INVALIDATION_PLAN_VERSION = 1;
/** Solo un item run `completed` es reutilizable (estados: pending|running|completed|retrying|failed|blocked|cancelled). */
export const REUSABLE_ITEM_STATUSES: readonly string[] = ['completed'];

export type InvalidationActionType =
  | 'REUSE'
  | 'GENERATE'
  | 'REGENERATE'
  | 'REVIEW'
  | 'STALE_NO_AUTO'
  | 'SOFT_DISABLE';

export const ACTION_TYPES: readonly InvalidationActionType[] = [
  'REUSE',
  'GENERATE',
  'REGENERATE',
  'REVIEW',
  'STALE_NO_AUTO',
  'SOFT_DISABLE',
];

/** Forma mínima de un item de Manifest (v1 o v2; `type` como string). */
export interface InvalidationManifestItem {
  key: string;
  type: string;
  scope?: string;
  moduleId?: string | null;
  chapterId?: string | null;
}

export interface InvalidationManifest {
  rulesVersion?: number;
  items: InvalidationManifestItem[];
}

export interface InvalidationFromItem {
  itemKey: string;
  itemRunId: string | null;
  status: string;
  artifactIds?: string[] | null;
  artifactStatus?: 'ready' | 'stale' | 'disabled' | string | null;
  /**
   * `matchFingerprint` con el que se generó el artifact (se guarda en su
   * metadata). Un artifact `disabled` SIN huella nunca se reutiliza
   * (REGENERATE, fix wave); para los `ready` del run de origen no se usa.
   */
  inputFingerprint?: string | null;
}

export interface InvalidationPlanInput {
  from: {
    blueprint: BlueprintSnapshotV1;
    manifest: InvalidationManifest;
    items: InvalidationFromItem[];
    courseContextSha256?: string | null;
  };
  to: {
    blueprint: BlueprintSnapshotV1;
    manifest: InvalidationManifest;
    courseContextSha256?: string | null;
  };
}

export interface InvalidationAction {
  itemKey: string;
  type: string;
  moduleId: string | null;
  chapterId: string | null;
  action: InvalidationActionType;
  reasons: string[];
  inTargetManifest: boolean;
  /** Item run de origen (siempre que exista; en REUSE/REVIEW/STALE_NO_AUTO es la fuente). */
  fromItemRunId: string | null;
  fromArtifactIds: string[];
  /** Huella completa en el destino (null si el item sale del destino). */
  fingerprint: string | null;
  /** Huella con la que se decide un match (guardar en metadata del artifact). */
  matchFingerprint: string | null;
}

export interface InvalidationPlan {
  invalidationPlanVersion: number;
  fingerprintVersion: number;
  fromRulesVersion: number | null;
  toRulesVersion: number | null;
  actions: InvalidationAction[];
  totals: Record<InvalidationActionType, number>;
  planSha256: string;
}

type Reusability = 'ready' | 'stale' | 'disabled' | 'none';

function reusability(rec: InvalidationFromItem | undefined): Reusability {
  if (!rec) return 'none';
  const hasArtifacts = Array.isArray(rec.artifactIds) && rec.artifactIds.length > 0;
  if (!REUSABLE_ITEM_STATUSES.includes(rec.status) || !hasArtifacts) return 'none';
  if (rec.artifactStatus === 'stale') return 'stale';
  if (rec.artifactStatus === 'disabled') return 'disabled';
  if (rec.artifactStatus == null || rec.artifactStatus === 'ready') return 'ready';
  return 'none';
}

function indexManifest(m: InvalidationManifest, label: string): Map<string, InvalidationManifestItem> {
  const out = new Map<string, InvalidationManifestItem>();
  for (const it of m?.items ?? []) {
    if (!it || typeof it.key !== 'string') throw new Error(`INVALID_INVALIDATION_INPUT: item sin key en ${label}`);
    if (out.has(it.key)) throw new Error(`INVALID_INVALIDATION_INPUT: key duplicada en ${label}: ${it.key}`);
    const { type } = parseItemKey(it.key);
    if (it.type && it.type !== type) {
      throw new Error(`INVALID_INVALIDATION_INPUT: ${label} ${it.key} declara type=${it.type}`);
    }
    out.set(it.key, it);
  }
  return out;
}

/** Verifica que cada item referencie una entidad existente en su Blueprint (falla fuerte). */
function assertItemsMatchBlueprint(items: Map<string, InvalidationManifestItem>, outline: Outline, label: string) {
  for (const key of items.keys()) {
    const { type, entityId } = parseItemKey(key);
    const chapterScoped = type === 'content' || type === 'scorm' || type === 'video';
    const moduleScoped = type === 'exam' || type === 'module_intro';
    if (chapterScoped && !outline.chapterById.has(entityId)) {
      throw new Error(`INVALID_INVALIDATION_INPUT: ${label} ${key} referencia un capítulo que no está en su Blueprint`);
    }
    if (moduleScoped && !outline.moduleById.has(entityId)) {
      throw new Error(`INVALID_INVALIDATION_INPUT: ${label} ${key} referencia un módulo que no está en su Blueprint`);
    }
  }
}

const TYPE_RANK_IN_CHAPTER: Record<string, number> = { content: 0, scorm: 1, video: 2 };

/** Orden canónico derivado del Blueprint (nunca del orden del arreglo de entrada). */
function canonicalRank(outline: Outline): (key: string) => [number, string] {
  const rank = new Map<string, number>();
  let n = 0;
  rank.set('course_plan', n++);
  rank.set('course_intro', n++);
  for (const m of outline.modules) {
    rank.set(`module_intro:${m.id}`, n++);
    for (const c of m.chapters) {
      const base = n;
      n += 3;
      for (const [t, off] of Object.entries(TYPE_RANK_IN_CHAPTER)) rank.set(`${t}:${c.id}`, base + off);
    }
    rank.set(`exam:${m.id}`, n++);
  }
  return (key: string) => {
    const { type } = parseItemKey(key);
    const r = rank.get(key) ?? (type === 'course_plan' || type === 'course_intro' ? rank.get(type) : undefined);
    return [r ?? Number.MAX_SAFE_INTEGER, key];
  };
}

/** Capítulos cuyo orden relativo (entre los comunes al mismo módulo) cambió. */
function reorderedWithinModule(from: Outline, to: Outline): Set<string> {
  const out = new Set<string>();
  for (const tm of to.modules) {
    const fm = from.moduleById.get(tm.id);
    if (!fm) continue;
    const toIds = tm.chapters.map((c) => c.id).filter((id) => fm.chapters.some((c) => c.id === id));
    const fromIds = fm.chapters.map((c) => c.id).filter((id) => toIds.includes(id));
    toIds.forEach((id, i) => {
      if (fromIds[i] !== id) out.add(id);
    });
  }
  return out;
}

/** Módulos cuyo orden relativo (entre los comunes) cambió. */
function reorderedModules(from: Outline, to: Outline): Set<string> {
  const out = new Set<string>();
  const toIds = to.modules.map((m) => m.id).filter((id) => from.moduleById.has(id));
  const fromIds = from.modules.map((m) => m.id).filter((id) => to.moduleById.has(id));
  toIds.forEach((id, i) => {
    if (fromIds[i] !== id) out.add(id);
  });
  return out;
}

export function computeInvalidationPlan(input: InvalidationPlanInput): InvalidationPlan {
  const fromItems = indexManifest(input.from.manifest, 'from.manifest');
  const toItems = indexManifest(input.to.manifest, 'to.manifest');
  const fromFp: BlueprintFingerprints = computeFingerprints(input.from.blueprint, {
    courseContextSha256: input.from.courseContextSha256 ?? null,
  });
  const toFp: BlueprintFingerprints = computeFingerprints(input.to.blueprint, {
    courseContextSha256: input.to.courseContextSha256 ?? null,
  });
  assertItemsMatchBlueprint(fromItems, fromFp.outline, 'from.manifest');
  assertItemsMatchBlueprint(toItems, toFp.outline, 'to.manifest');

  const records = new Map<string, InvalidationFromItem>();
  for (const r of input.from.items ?? []) {
    if (!r || typeof r.itemKey !== 'string') continue;
    if (records.has(r.itemKey)) throw new Error(`INVALID_INVALIDATION_INPUT: from.items repite ${r.itemKey}`);
    records.set(r.itemKey, r);
  }

  const reorderedCh = reorderedWithinModule(fromFp.outline, toFp.outline);
  const reorderedMods = reorderedModules(fromFp.outline, toFp.outline);

  const decided = new Map<string, InvalidationAction>();
  /** content keys cuyo resultado será salida nueva (GENERATE/REGENERATE). */
  const contentProducesNew = new Set<string>();

  const base = (key: string, inTarget: boolean): InvalidationAction => {
    const it = (inTarget ? toItems.get(key) : fromItems.get(key))!;
    const { type, entityId } = parseItemKey(key);
    const outline = inTarget ? toFp.outline : fromFp.outline;
    const chapter = outline.chapterById.get(entityId);
    const moduleId =
      type === 'exam' || type === 'module_intro' ? entityId : chapter ? chapter.moduleId : (it.moduleId ?? null);
    const rec = records.get(key);
    return {
      itemKey: key,
      type,
      moduleId: moduleId ?? null,
      chapterId: chapter ? chapter.id : null,
      action: 'REUSE',
      reasons: [],
      inTargetManifest: inTarget,
      fromItemRunId: rec?.itemRunId ?? null,
      fromArtifactIds: rec?.artifactIds ? [...rec.artifactIds].sort(cmpStr) : [],
      fingerprint: inTarget ? itemFingerprint(toFp, key) : null,
      matchFingerprint: inTarget ? matchFingerprint(toFp, key) : null,
    };
  };

  /**
   * Aplica la disponibilidad real de la salida previa a una decisión de
   * "reutilizar" (REUSE / REVIEW). Devuelve la acción final.
   */
  const settleReuse = (a: InvalidationAction, wanted: 'REUSE' | 'REVIEW'): InvalidationAction => {
    const r = reusability(records.get(a.itemKey));
    if (r === 'ready') {
      a.action = wanted;
    } else if (r === 'stale') {
      a.action = a.type === 'video' ? 'STALE_NO_AUTO' : 'REGENERATE';
      a.reasons.push('previous_artifact_stale');
    } else {
      a.action = 'GENERATE';
      a.reasons.push('previous_output_missing');
    }
    return a;
  };

  /** Item nuevo en el destino: GENERATE, o REUSE de un deshabilitado que coincida. */
  const decideNewItem = (a: InvalidationAction, newReason: string, blockedByContent: boolean) => {
    const rec = records.get(a.itemKey);
    if (!blockedByContent && reusability(rec) === 'disabled') {
      // Fix wave (review F78, promovido a Important): SOLO la huella guardada
      // con el artifact decide. Sin huella no se puede saber con qué inputs se
      // generó (recalcularla desde el Blueprint de origen podía reutilizar un
      // banco de examen o un video viejos) ⇒ REGENERATE, conservador.
      const stored = rec!.inputFingerprint ?? null;
      if (!stored) {
        a.action = 'REGENERATE';
        a.reasons.push('disabled_artifact_without_fingerprint');
        return;
      }
      if (stored === a.matchFingerprint) {
        a.action = 'REUSE';
        a.reasons.push('reenabled_matching_disabled');
        return;
      }
      a.reasons.push('disabled_artifact_does_not_match');
    }
    a.action = 'GENERATE';
    a.reasons.push(newReason);
  };

  // ---- 1) content (decide primero: scorm/video/exam dependen de él) ----
  for (const key of toItems.keys()) {
    const { type, entityId: chId } = parseItemKey(key);
    if (type !== 'content') continue;
    const a = base(key, true);
    const oldCh = fromFp.outline.chapterById.get(chId);
    const newCh = toFp.outline.chapterById.get(chId)!;
    if (!fromItems.has(key)) {
      decideNewItem(a, oldCh ? 'new_item' : 'chapter_added', false);
    } else {
      const f0 = fromFp.content.get(chId)!;
      const f1 = toFp.content.get(chId)!;
      if (f0.own !== f1.own) {
        a.action = 'REGENERATE';
        a.reasons.push('chapter_title_or_objective_changed');
      } else {
        const review: string[] = [];
        if (oldCh!.moduleId !== newCh.moduleId) review.push('moved_across_modules');
        else if (f0.context !== f1.context) review.push('module_context_changed');
        if (reorderedCh.has(chId)) review.push('reordered_within_module');
        if (oldCh!.moduleId === newCh.moduleId && reorderedMods.has(newCh.moduleId)) review.push('module_order_changed');
        a.reasons.push(...(review.length ? review : ['unchanged']));
        settleReuse(a, review.length ? 'REVIEW' : 'REUSE');
      }
    }
    if (a.action === 'GENERATE' || a.action === 'REGENERATE') contentProducesNew.add(chId);
    decided.set(key, a);
  }

  // ---- 2) el resto de items del destino ----
  for (const key of toItems.keys()) {
    if (decided.has(key)) continue;
    const { type, entityId } = parseItemKey(key);
    const a = base(key, true);
    const inFrom = fromItems.has(key);

    if (type === 'scorm' || type === 'video') {
      const chId = entityId;
      const chapterIsNew = !fromFp.outline.chapterById.has(chId);
      const contentNew = contentProducesNew.has(chId);
      if (!inFrom) {
        decideNewItem(a, chapterIsNew ? 'chapter_added' : type === 'video' ? 'video_toggled_on' : 'new_item', contentNew);
      } else if (contentNew) {
        const r = reusability(records.get(key));
        if (type === 'video' && (r === 'ready' || r === 'stale')) {
          a.action = 'STALE_NO_AUTO';
          a.reasons.push('content_regenerated_video_costly');
        } else if (type === 'video') {
          a.action = 'GENERATE';
          a.reasons.push('content_regenerated', 'previous_output_missing');
        } else {
          a.action = r === 'none' ? 'GENERATE' : 'REGENERATE';
          a.reasons.push('content_regenerated');
          if (r === 'none') a.reasons.push('previous_output_missing');
        }
      } else {
        a.reasons.push('content_reused');
        settleReuse(a, 'REUSE');
      }
    } else if (type === 'exam') {
      const mId = entityId;
      const newMod = toFp.outline.moduleById.get(mId)!;
      const oldMod = fromFp.outline.moduleById.get(mId);
      const memberContentNew = newMod.chapters.some((c) => contentProducesNew.has(c.id));
      if (!inFrom) {
        decideNewItem(a, oldMod ? 'exam_toggled_on' : 'module_added', memberContentNew);
      } else {
        const reasons: string[] = [];
        const oldIds = oldMod!.chapters.map((c) => c.id).sort(cmpStr).join(',');
        const newIds = newMod.chapters.map((c) => c.id).sort(cmpStr).join(',');
        if (oldIds !== newIds) reasons.push('module_membership_changed');
        if (oldMod!.title !== newMod.title || oldMod!.objective !== newMod.objective) {
          reasons.push('module_title_or_objective_changed');
        }
        // Capítulos que ya eran del módulo y cuyo content genera salida nueva
        // (los recién agregados ya cuentan como cambio de membresía).
        const existingMemberContentNew = newMod.chapters.some(
          (c) => contentProducesNew.has(c.id) && oldMod!.chapters.some((oc) => oc.id === c.id),
        );
        if (existingMemberContentNew || (reasons.length === 0 && fromFp.exam.get(mId) !== toFp.exam.get(mId))) {
          reasons.push('member_content_changed');
        }
        if (reasons.length) {
          const r = reusability(records.get(key));
          a.action = r === 'none' ? 'GENERATE' : 'REGENERATE';
          a.reasons.push(...reasons);
          if (r === 'none') a.reasons.push('previous_output_missing');
        } else {
          a.reasons.push('unchanged');
          settleReuse(a, 'REUSE');
        }
      }
    } else if (type === 'module_intro' || type === 'course_plan' || type === 'course_intro') {
      const f0 = inFrom ? itemFingerprint(fromFp, key) : null;
      const f1 = itemFingerprint(toFp, key);
      if (!inFrom) {
        const isNewModule = type === 'module_intro' && !fromFp.outline.moduleById.has(entityId);
        decideNewItem(a, isNewModule ? 'module_added' : 'new_item', false);
      } else if (f0 !== f1) {
        const r = reusability(records.get(key));
        a.action = r === 'none' ? 'GENERATE' : 'REGENERATE';
        a.reasons.push(type === 'module_intro' ? 'module_changed' : 'outline_changed');
        if (r === 'none') a.reasons.push('previous_output_missing');
      } else {
        a.reasons.push('unchanged');
        settleReuse(a, 'REUSE');
      }
    } else {
      // Tipo desconocido: sin reglas ⇒ nunca reutilizar a ciegas.
      if (inFrom) {
        const r = reusability(records.get(key));
        a.action = r === 'none' ? 'GENERATE' : 'REGENERATE';
      } else {
        a.action = 'GENERATE';
      }
      a.reasons.push('unknown_item_type');
    }
    decided.set(key, a);
  }

  // ---- 3) items del origen ausentes del destino ⇒ SOFT_DISABLE ----
  const removed: InvalidationAction[] = [];
  for (const key of fromItems.keys()) {
    if (toItems.has(key)) continue;
    const { type, entityId } = parseItemKey(key);
    const a = base(key, false);
    a.action = 'SOFT_DISABLE';
    if (type === 'content' || type === 'scorm' || type === 'video') {
      a.reasons.push(
        !toFp.outline.chapterById.has(entityId)
          ? 'chapter_deleted'
          : type === 'video'
            ? 'video_toggled_off'
            : 'not_in_target_manifest',
      );
    } else if (type === 'exam' || type === 'module_intro') {
      a.reasons.push(
        !toFp.outline.moduleById.has(entityId)
          ? 'module_deleted'
          : type === 'exam'
            ? 'exam_toggled_off'
            : 'not_in_target_rules_version',
      );
    } else if (type === 'course_plan' || type === 'course_intro') {
      a.reasons.push('not_in_target_rules_version');
    } else {
      a.reasons.push('not_in_target_manifest');
    }
    removed.push(a);
  }

  const rankTo = canonicalRank(toFp.outline);
  const rankFrom = canonicalRank(fromFp.outline);
  const byRank = (rank: (k: string) => [number, string]) => (x: InvalidationAction, y: InvalidationAction) => {
    const [rx, kx] = rank(x.itemKey);
    const [ry, ky] = rank(y.itemKey);
    return rx - ry || cmpStr(kx, ky);
  };
  const actions = [...[...decided.values()].sort(byRank(rankTo)), ...removed.sort(byRank(rankFrom))];

  const totals = Object.fromEntries(ACTION_TYPES.map((t) => [t, 0])) as Record<InvalidationActionType, number>;
  for (const a of actions) totals[a.action] += 1;

  const body = {
    invalidationPlanVersion: INVALIDATION_PLAN_VERSION,
    fingerprintVersion: INVALIDATION_FINGERPRINT_VERSION,
    fromRulesVersion: input.from.manifest?.rulesVersion ?? null,
    toRulesVersion: input.to.manifest?.rulesVersion ?? null,
    actions,
    totals,
  };
  return { ...body, planSha256: sha256Canonical(body) };
}
