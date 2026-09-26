import type { BlueprintSnapshotV2 } from '../course-blueprints/blueprint-snapshot';
import { cmpStr, sha256Canonical } from '../coherence/canonical-json';
import { Outline } from '../coherence/coherence-types';
import {
  BlueprintFingerprintsV3,
  CHAPTER_ITEM_TYPES_V3,
  COURSE_ITEM_TYPES_V3,
  FingerprintExtrasV3,
  INVALIDATION_FINGERPRINT_VERSION_V3,
  MODULE_ITEM_TYPES_V3,
  computeFingerprintsV3,
  itemFingerprintV3,
  matchFingerprintV3,
  parseItemKey,
} from './fingerprints';
import {
  ACTION_TYPES,
  InvalidationAction,
  InvalidationActionType,
  InvalidationFromItem,
  InvalidationManifestItem,
  InvalidationPlan,
  InvalidationPlanInput,
  indexManifest,
  reorderedModules,
  reorderedWithinModule,
  reusability,
} from './plan';

/**
 * V2.1 (R5) — plan de invalidación para Manifests rulesVersion 3 (audit §P).
 * Función PURA, por UUID (sin DB, reloj ni red). Mismo contrato de salida
 * que el plan v1/v2 (`InvalidationPlan`), más `fromMatchFingerprint` en cada
 * acción. El plan v1/v2 (`plan.ts`) no cambia: `computeInvalidationPlan`
 * despacha acá solo cuando ambos Manifests son rulesVersion 3.
 *
 * Garantías (DECISIONES VIGENTES + brief R5):
 *  - Presentación, calificación y tema nunca pagan proveedores: los perfiles
 *    no entran en ninguna huella ⇒ dos Blueprints/Manifests idénticos dan
 *    todo REUSE, cambien o no los perfiles.
 *  - Items pagados a proveedores (video = Videogen, presentation = Gamma,
 *    audio_welcome / audiobook_chapter = TTS) NUNCA se regeneran solos: si
 *    sus inputs cambian ⇒ STALE_NO_AUTO (se siguen empaquetando, con aviso;
 *    regenerarlos exige el regenerate con confirmPaid).
 *  - Items LLM (course_plan, course_intro, module_intro, content, experience,
 *    video_interactions, activity, exam, final_exam): REGENERATE / REVIEW.
 *  - Toggles ON→OFF ⇒ SOFT_DISABLE (video + video_interactions, activity,
 *    final_exam, exam); OFF→ON ⇒ GENERATE o REUSE de un deshabilitado con la
 *    misma huella guardada.
 *  - Un reorder nunca regenera nada caro (las huellas son de conjunto).
 *
 * Reglas por tipo (además de "reutilizar exige salida previa ready"):
 *  - content: igual que v1/v2 (own cambió ⇒ REGENERATE; contexto/orden ⇒ REVIEW).
 *  - experience: content nuevo ⇒ REGENERATE; content en REVIEW por moverse de
 *    módulo o por cambio del módulo ⇒ REVIEW; reorder ⇒ REUSE.
 *  - activity: content nuevo ⇒ REGENERATE; variant (motor) distinto ⇒
 *    REGENERATE solo de activity; si no ⇒ REUSE.
 *  - presentation / audiobook_chapter / video: content nuevo ⇒ STALE_NO_AUTO.
 *  - video_interactions: sigue al video. Video GENERATE/REGENERATE ⇒
 *    REGENERATE (describen un video nuevo); video STALE_NO_AUTO ⇒
 *    STALE_NO_AUTO (describen el video viejo, que sigue vigente); video
 *    reutilizado ⇒ REUSE.
 *  - exam, course_plan, course_intro: igual que v1/v2 (REGENERATE si cambió
 *    su huella; las huellas son de conjunto, un reorder no las cambia).
 *  - module_intro: igual, pero su huella v3 incluye el `own` de sus
 *    capítulos (§P: editar un capítulo regenera la intro de su módulo).
 *  - final_exam: huella = conjunto de capítulos + `own`; cualquier content
 *    nuevo o cambio de membresía ⇒ REGENERATE; reorder / mover ⇒ REUSE.
 *  - audio_welcome: course_intro produce salida nueva (outline cambió) ⇒
 *    STALE_NO_AUTO.
 */

export const INVALIDATION_PLAN_VERSION_V3 = 2;

/** Items pagados a un proveedor: nunca REGENERATE automático (STALE_NO_AUTO). */
export const PROVIDER_PAID_ITEM_TYPES_V3: readonly string[] = ['video', 'presentation', 'audio_welcome', 'audiobook_chapter'];
const PROVIDER = new Set(PROVIDER_PAID_ITEM_TYPES_V3);

const PRODUCES_NEW = new Set<InvalidationActionType>(['GENERATE', 'REGENERATE']);

/** Posición de cada tipo dentro del bloque de un capítulo (orden canónico del Manifest v3, §N.2). */
const TYPE_RANK_IN_CHAPTER_V3: Record<string, number> = {
  content: 0,
  experience: 1,
  presentation: 2,
  video: 3,
  video_interactions: 4,
  activity: 5,
  audiobook_chapter: 6,
};

/** Orden canónico v3 derivado del Blueprint (nunca del orden del arreglo de entrada). */
function canonicalRankV3(outline: Outline): (key: string) => [number, string] {
  const rank = new Map<string, number>();
  let n = 0;
  rank.set('course_plan', n++);
  rank.set('course_intro', n++);
  rank.set('audio_welcome', n++);
  const width = Object.keys(TYPE_RANK_IN_CHAPTER_V3).length;
  for (const m of outline.modules) {
    rank.set(`module_intro:${m.id}`, n++);
    for (const c of m.chapters) {
      const base = n;
      n += width;
      for (const [t, off] of Object.entries(TYPE_RANK_IN_CHAPTER_V3)) rank.set(`${t}:${c.id}`, base + off);
    }
    rank.set(`exam:${m.id}`, n++);
  }
  rank.set('final_exam', n++);
  return (key: string) => {
    const { type } = parseItemKey(key);
    const r = rank.get(key) ?? (COURSE_ITEM_TYPES_V3.includes(type) ? rank.get(type) : undefined);
    return [r ?? Number.MAX_SAFE_INTEGER, key];
  };
}

function assertV3Input(input: InvalidationPlanInput): { from: BlueprintSnapshotV2; to: BlueprintSnapshotV2 } {
  const fromRv = input?.from?.manifest?.rulesVersion;
  const toRv = input?.to?.manifest?.rulesVersion;
  if (fromRv !== 3 || toRv !== 3) {
    throw new Error(`INVALID_INVALIDATION_INPUT: el plan v3 requiere dos Manifests rulesVersion 3 (from=${fromRv}, to=${toRv})`);
  }
  const bpFrom = input.from.blueprint as BlueprintSnapshotV2;
  const bpTo = input.to.blueprint as BlueprintSnapshotV2;
  for (const [label, bp] of [['from', bpFrom], ['to', bpTo]] as const) {
    if (!bp || bp.schemaVersion !== 2) {
      throw new Error(
        `INVALID_INVALIDATION_INPUT: ${label}.blueprint es schemaVersion ${(bp as any)?.schemaVersion} (rulesVersion 3 requiere 2)`,
      );
    }
  }
  return { from: bpFrom, to: bpTo };
}

/** Cada item referencia una entidad existente y de su clase; activity lleva variant válido. */
function assertItemsMatchBlueprintV3(items: Map<string, InvalidationManifestItem>, outline: Outline, courseId: number, label: string) {
  for (const [key, it] of items) {
    const { type, entityId } = parseItemKey(key);
    if (CHAPTER_ITEM_TYPES_V3.includes(type)) {
      if (!outline.chapterById.has(entityId)) {
        throw new Error(`INVALID_INVALIDATION_INPUT: ${label} ${key} referencia un capítulo que no está en su Blueprint`);
      }
    } else if (MODULE_ITEM_TYPES_V3.includes(type)) {
      if (!outline.moduleById.has(entityId)) {
        throw new Error(`INVALID_INVALIDATION_INPUT: ${label} ${key} referencia un módulo que no está en su Blueprint`);
      }
    } else if (COURSE_ITEM_TYPES_V3.includes(type)) {
      if (entityId !== String(courseId)) {
        throw new Error(`INVALID_INVALIDATION_INPUT: ${label} ${key} no corresponde al curso #${courseId}`);
      }
    } else {
      // Sin reglas para el tipo ⇒ fallar fuerte (nunca reutilizar ni regenerar a ciegas).
      throw new Error(`INVALID_INVALIDATION_INPUT: ${label} ${key} tiene un tipo desconocido en rulesVersion 3`);
    }
    if (type === 'activity' && it.variant !== 'h5p' && it.variant !== 'scorm') {
      throw new Error(`INVALID_INVALIDATION_INPUT: ${label} ${key} sin variant válido (fue ${JSON.stringify(it.variant)})`);
    }
    if (type !== 'activity' && it.variant != null) {
      throw new Error(`INVALID_INVALIDATION_INPUT: ${label} ${key} declara variant pero no es activity`);
    }
  }
}

export function computeInvalidationPlanV3(input: InvalidationPlanInput): InvalidationPlan {
  const bps = assertV3Input(input);
  const fromItems = indexManifest(input.from.manifest, 'from.manifest');
  const toItems = indexManifest(input.to.manifest, 'to.manifest');
  const fromFp: BlueprintFingerprintsV3 = computeFingerprintsV3(bps.from, {
    courseContextSha256: input.from.courseContextSha256 ?? null,
  });
  const toFp: BlueprintFingerprintsV3 = computeFingerprintsV3(bps.to, {
    courseContextSha256: input.to.courseContextSha256 ?? null,
  });
  if (bps.from.course.id !== bps.to.course.id) {
    throw new Error(`INVALID_INVALIDATION_INPUT: los Blueprints son de cursos distintos (${bps.from.course.id} vs ${bps.to.course.id})`);
  }
  assertItemsMatchBlueprintV3(fromItems, fromFp.outline, bps.from.course.id, 'from.manifest');
  assertItemsMatchBlueprintV3(toItems, toFp.outline, bps.to.course.id, 'to.manifest');

  const records = new Map<string, InvalidationFromItem>();
  for (const r of input.from.items ?? []) {
    if (!r || typeof r.itemKey !== 'string') continue;
    if (records.has(r.itemKey)) throw new Error(`INVALID_INVALIDATION_INPUT: from.items repite ${r.itemKey}`);
    records.set(r.itemKey, r);
  }

  const reorderedCh = reorderedWithinModule(fromFp.outline, toFp.outline);
  const reorderedMods = reorderedModules(fromFp.outline, toFp.outline);

  /** Identidad del output de un item según su registro de origen (A o linaje). */
  const identityOf = (key: string): string | null => records.get(key)?.outputIdentity ?? null;

  /** Extras de huella de un item del ORIGEN (variant del Manifest A, video vigente en A). */
  const fromExtras = (key: string): FingerprintExtrasV3 => {
    const { type, entityId } = parseItemKey(key);
    if (type === 'activity') return { variant: fromItems.get(key)?.variant ?? null };
    if (type === 'video_interactions') {
      const vKey = `video:${entityId}`;
      return { videoIdentity: fromItems.has(vKey) ? identityOf(vKey) : null };
    }
    return {};
  };

  const base = (key: string, inTarget: boolean, toExtras: FingerprintExtrasV3 = {}): InvalidationAction => {
    const it = (inTarget ? toItems.get(key) : fromItems.get(key))!;
    const { type, entityId } = parseItemKey(key);
    const outline = inTarget ? toFp.outline : fromFp.outline;
    const chapter = outline.chapterById.get(entityId);
    const moduleId = MODULE_ITEM_TYPES_V3.includes(type) ? entityId : chapter ? chapter.moduleId : (it.moduleId ?? null);
    const rec = records.get(key);
    const inFrom = fromItems.has(key);
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
      fingerprint: inTarget ? itemFingerprintV3(toFp, key, toExtras) : null,
      matchFingerprint: inTarget ? matchFingerprintV3(toFp, key, toExtras) : null,
      fromMatchFingerprint: inFrom ? matchFingerprintV3(fromFp, key, fromExtras(key)) : null,
    };
  };

  /** REUSE/REVIEW si la salida previa está ready; stale ⇒ proveedor STALE_NO_AUTO, LLM REGENERATE; nada ⇒ GENERATE. */
  const settleReuse = (a: InvalidationAction, wanted: 'REUSE' | 'REVIEW', staleAction?: InvalidationActionType): InvalidationAction => {
    const r = reusability(records.get(a.itemKey));
    if (r === 'ready') {
      a.action = wanted;
    } else if (r === 'stale') {
      a.action = staleAction ?? (PROVIDER.has(a.type) ? 'STALE_NO_AUTO' : 'REGENERATE');
      a.reasons.push('previous_artifact_stale');
    } else {
      a.action = 'GENERATE';
      a.reasons.push('previous_output_missing');
    }
    return a;
  };

  /** Salida nueva para un item LLM que existía: REGENERATE, o GENERATE si no había salida previa. */
  const regenerate = (a: InvalidationAction, ...reasons: string[]) => {
    const r = reusability(records.get(a.itemKey));
    a.action = r === 'none' ? 'GENERATE' : 'REGENERATE';
    a.reasons.push(...reasons);
    if (r === 'none') a.reasons.push('previous_output_missing');
  };

  /** Item pagado cuyos inputs cambiaron: STALE_NO_AUTO si hay salida previa; si no, GENERATE (no hay nada que conservar). */
  const staleProvider = (a: InvalidationAction, reason: string) => {
    const r = reusability(records.get(a.itemKey));
    if (r === 'ready' || r === 'stale') {
      a.action = 'STALE_NO_AUTO';
      a.reasons.push(reason);
    } else {
      a.action = 'GENERATE';
      a.reasons.push(reason, 'previous_output_missing');
    }
  };

  /** Item nuevo en el destino: GENERATE, o REUSE de un deshabilitado cuya huella guardada coincida. */
  const decideNewItem = (a: InvalidationAction, newReason: string, blocked: boolean) => {
    const rec = records.get(a.itemKey);
    if (!blocked && reusability(rec) === 'disabled') {
      const stored = rec!.inputFingerprint ?? null;
      if (!stored) {
        a.action = 'REGENERATE';
        a.reasons.push('disabled_artifact_without_fingerprint');
        return;
      }
      if (a.matchFingerprint && stored === a.matchFingerprint) {
        a.action = 'REUSE';
        a.reasons.push('reenabled_matching_disabled');
        return;
      }
      a.reasons.push('disabled_artifact_does_not_match');
    }
    a.action = 'GENERATE';
    a.reasons.push(newReason);
  };

  const decided = new Map<string, InvalidationAction>();
  const contentProducesNew = new Set<string>();

  // ---- 1) content (todo lo demás del capítulo depende de él) ----
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
    if (PRODUCES_NEW.has(a.action)) contentProducesNew.add(chId);
    decided.set(key, a);
  }

  // ---- 2) el resto del destino, en orden canónico (video antes que video_interactions, course_intro antes que audio_welcome) ----
  const rankTo = canonicalRankV3(toFp.outline);
  const byRankKey = (rank: (k: string) => [number, string]) => (x: string, y: string) => {
    const [rx, kx] = rank(x);
    const [ry, ky] = rank(y);
    return rx - ry || cmpStr(kx, ky);
  };
  const remaining = [...toItems.keys()].filter((k) => !decided.has(k)).sort(byRankKey(rankTo));
  const anyContentNew = contentProducesNew.size > 0;

  for (const key of remaining) {
    const { type, entityId } = parseItemKey(key);
    const toItem = toItems.get(key)!;
    const inFrom = fromItems.has(key);
    const chapterIsNew = CHAPTER_ITEM_TYPES_V3.includes(type) && !fromFp.outline.chapterById.has(entityId);
    const contentNew = CHAPTER_ITEM_TYPES_V3.includes(type) && contentProducesNew.has(entityId);
    let a: InvalidationAction;

    if (type === 'experience') {
      a = base(key, true);
      if (!inFrom) {
        decideNewItem(a, chapterIsNew ? 'chapter_added' : 'new_item', contentNew);
      } else if (contentNew) {
        regenerate(a, 'content_regenerated');
      } else {
        const content = decided.get(`content:${entityId}`);
        const review = (content?.reasons ?? []).filter((r) => r === 'moved_across_modules' || r === 'module_context_changed');
        a.reasons.push(...(review.length ? review : ['content_reused']));
        settleReuse(a, review.length ? 'REVIEW' : 'REUSE');
      }
    } else if (type === 'activity') {
      a = base(key, true, { variant: toItem.variant ?? null });
      if (!inFrom) {
        decideNewItem(a, chapterIsNew ? 'chapter_added' : 'activity_toggled_on', contentNew);
      } else if (contentNew) {
        regenerate(a, 'content_regenerated');
      } else if ((fromItems.get(key)!.variant ?? null) !== (toItem.variant ?? null)) {
        regenerate(a, 'activity_engine_changed');
      } else {
        a.reasons.push('content_reused');
        settleReuse(a, 'REUSE');
      }
    } else if (type === 'presentation' || type === 'audiobook_chapter' || type === 'video') {
      a = base(key, true);
      if (!inFrom) {
        decideNewItem(a, chapterIsNew ? 'chapter_added' : type === 'video' ? 'video_toggled_on' : 'new_item', contentNew);
      } else if (contentNew) {
        staleProvider(a, 'content_regenerated_provider_costly');
      } else {
        a.reasons.push('content_reused');
        settleReuse(a, 'REUSE');
      }
    } else if (type === 'video_interactions') {
      const vKey = `video:${entityId}`;
      const video = decided.get(vKey);
      if (!video) {
        throw new Error(`INVALID_INVALIDATION_INPUT: to.manifest ${key} sin ${vKey} (video_interactions depende del video)`);
      }
      const videoKeepsOutput = video.action === 'REUSE' || video.action === 'REVIEW' || video.action === 'STALE_NO_AUTO';
      // Identidad del video vigente en B: la del output que B hereda (A o un deshabilitado del linaje).
      a = base(key, true, { videoIdentity: videoKeepsOutput ? identityOf(vKey) : null });
      if (PRODUCES_NEW.has(video.action)) {
        if (!inFrom) {
          a.action = 'GENERATE';
          a.reasons.push(chapterIsNew ? 'chapter_added' : 'video_toggled_on', 'video_generated');
        } else {
          regenerate(a, 'video_regenerated');
        }
      } else if (video.action === 'STALE_NO_AUTO') {
        if (!inFrom) {
          a.action = 'GENERATE';
          a.reasons.push('new_item', 'video_stale');
        } else {
          staleProvider(a, 'video_stale');
        }
      } else if (!inFrom) {
        decideNewItem(a, chapterIsNew ? 'chapter_added' : 'video_toggled_on', contentNew);
      } else if (contentNew) {
        regenerate(a, 'content_regenerated');
      } else if (a.matchFingerprint !== a.fromMatchFingerprint) {
        // El video que B hereda no es el que describían (o no se conoce su identidad).
        regenerate(a, a.matchFingerprint ? 'video_changed' : 'video_identity_unknown');
      } else {
        a.reasons.push('video_reused');
        settleReuse(a, 'REUSE');
      }
    } else if (type === 'exam') {
      a = base(key, true);
      const newMod = toFp.outline.moduleById.get(entityId)!;
      const oldMod = fromFp.outline.moduleById.get(entityId);
      const memberContentNew = newMod.chapters.some((c) => contentProducesNew.has(c.id));
      if (!inFrom) {
        decideNewItem(a, oldMod ? 'exam_toggled_on' : 'module_added', memberContentNew);
      } else {
        const reasons: string[] = [];
        const oldIds = oldMod!.chapters.map((c) => c.id).sort(cmpStr).join(',');
        const newIds = newMod.chapters.map((c) => c.id).sort(cmpStr).join(',');
        if (oldIds !== newIds) reasons.push('module_membership_changed');
        if (oldMod!.title !== newMod.title || oldMod!.objective !== newMod.objective) reasons.push('module_title_or_objective_changed');
        const existingMemberContentNew = newMod.chapters.some(
          (c) => contentProducesNew.has(c.id) && oldMod!.chapters.some((oc) => oc.id === c.id),
        );
        if (existingMemberContentNew || (reasons.length === 0 && fromFp.exam.get(entityId) !== toFp.exam.get(entityId))) {
          reasons.push('member_content_changed');
        }
        if (reasons.length) regenerate(a, ...reasons);
        else {
          a.reasons.push('unchanged');
          settleReuse(a, 'REUSE');
        }
      }
    } else if (type === 'final_exam') {
      a = base(key, true);
      if (!inFrom) {
        decideNewItem(a, 'final_exam_toggled_on', anyContentNew);
      } else {
        const reasons: string[] = [];
        const oldIds = fromFp.outline.chapters.map((c) => c.id).sort(cmpStr).join(',');
        const newIds = toFp.outline.chapters.map((c) => c.id).sort(cmpStr).join(',');
        if (oldIds !== newIds) reasons.push('course_membership_changed');
        const existingContentNew = toFp.outline.chapters.some((c) => contentProducesNew.has(c.id) && fromFp.outline.chapterById.has(c.id));
        if (existingContentNew || (reasons.length === 0 && fromFp.finalExam !== toFp.finalExam)) reasons.push('member_content_changed');
        if (reasons.length) regenerate(a, ...reasons);
        else {
          a.reasons.push('unchanged');
          settleReuse(a, 'REUSE');
        }
      }
    } else if (type === 'module_intro' || type === 'course_plan' || type === 'course_intro') {
      a = base(key, true);
      if (!inFrom) {
        const isNewModule = type === 'module_intro' && !fromFp.outline.moduleById.has(entityId);
        decideNewItem(a, isNewModule ? 'module_added' : 'new_item', false);
      } else if (itemFingerprintV3(fromFp, key) !== itemFingerprintV3(toFp, key)) {
        regenerate(a, type === 'module_intro' ? 'module_changed' : 'outline_changed');
      } else {
        a.reasons.push('unchanged');
        settleReuse(a, 'REUSE');
      }
    } else if (type === 'audio_welcome') {
      a = base(key, true);
      const intro = [...decided.values()].find((x) => x.type === 'course_intro');
      const introNew = !!intro && PRODUCES_NEW.has(intro.action);
      if (!inFrom) {
        decideNewItem(a, 'new_item', introNew);
      } else if (introNew || itemFingerprintV3(fromFp, key) !== itemFingerprintV3(toFp, key)) {
        staleProvider(a, 'course_intro_changed_tts_costly');
      } else {
        a.reasons.push('unchanged');
        settleReuse(a, 'REUSE');
      }
    } else {
      // assertItemsMatchBlueprintV3 ya rechazó cualquier otro tipo.
      throw new Error(`INVALID_INVALIDATION_INPUT: ${key} sin reglas v3`);
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
    if (CHAPTER_ITEM_TYPES_V3.includes(type)) {
      a.reasons.push(
        !toFp.outline.chapterById.has(entityId)
          ? 'chapter_deleted'
          : type === 'video' || type === 'video_interactions'
            ? 'video_toggled_off'
            : type === 'activity'
              ? 'activity_toggled_off'
              : 'not_in_target_manifest',
      );
    } else if (MODULE_ITEM_TYPES_V3.includes(type)) {
      a.reasons.push(!toFp.outline.moduleById.has(entityId) ? 'module_deleted' : type === 'exam' ? 'exam_toggled_off' : 'not_in_target_manifest');
    } else if (type === 'final_exam') {
      a.reasons.push('final_exam_toggled_off');
    } else {
      a.reasons.push('not_in_target_manifest');
    }
    removed.push(a);
  }

  const rankFrom = canonicalRankV3(fromFp.outline);
  const byRank = (rank: (k: string) => [number, string]) => (x: InvalidationAction, y: InvalidationAction) =>
    byRankKey(rank)(x.itemKey, y.itemKey);
  const actions = [...[...decided.values()].sort(byRank(rankTo)), ...removed.sort(byRank(rankFrom))];

  const totals = Object.fromEntries(ACTION_TYPES.map((t) => [t, 0])) as Record<InvalidationActionType, number>;
  for (const a of actions) totals[a.action] += 1;

  const body = {
    invalidationPlanVersion: INVALIDATION_PLAN_VERSION_V3,
    fingerprintVersion: INVALIDATION_FINGERPRINT_VERSION_V3,
    fromRulesVersion: 3,
    toRulesVersion: 3,
    actions,
    totals,
  };
  return { ...body, planSha256: sha256Canonical(body) };
}
