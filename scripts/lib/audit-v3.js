'use strict';

// ══════════════════════════════════════════════════════════════════════════
// audit-v3.js — invariantes de datos de rulesVersion 3 (Cursia V2.1, R5) para
// las auditorías de staging (audit-generation-manifests.js y
// audit-dynamic-generation.js). Funciones PURAS (sin DB): reciben filas ya
// leídas y devuelven la lista de violaciones (strings). Así se prueban con el
// builder real en scripts/check-v21-invalidation-v3.js.
//
// Autónomo a propósito (sin require de dist/): las auditorías corren en el
// deploy antes y después del build y no deben depender de él. Las tablas de
// abajo copian el contrato de R4 (generation-manifest-builder.ts
// `buildGenerationManifestV3` y artifact-resolver.ts `requiredArtifactTypesV3`);
// el check de R5 verifica que coincidan con el código compilado.
// ══════════════════════════════════════════════════════════════════════════

/** Tipos de item v3, en orden canónico (audit §N.2). */
const V3_ITEM_TYPES = [
  'course_plan', 'course_intro', 'audio_welcome', 'module_intro', 'content', 'experience',
  'presentation', 'video', 'video_interactions', 'activity', 'audiobook_chapter', 'exam', 'final_exam',
];

/** tipo de item → columna de conteo de course_generation_manifests. */
const V3_COUNT_COLUMNS = {
  content: 'content_count',
  video: 'video_count',
  exam: 'exam_count',
  course_plan: 'course_plan_count',
  course_intro: 'course_intro_count',
  module_intro: 'module_intro_count',
  experience: 'experience_count',
  presentation: 'presentation_count',
  video_interactions: 'video_interactions_count',
  activity: 'activity_count',
  audiobook_chapter: 'audiobook_chapter_count',
  audio_welcome: 'audio_welcome_count',
  final_exam: 'final_exam_count',
};

/** Roles de artifact obligatorios de un item v3 COMPLETADO (activity según su variant). */
const V3_ARTIFACT_ROLES = {
  course_plan: ['dynamic_course_plan_json'],
  course_intro: ['dynamic_course_intro_json'],
  module_intro: ['dynamic_module_intro_json'],
  content: ['dynamic_content_md', 'dynamic_context_package_json'],
  experience: ['dynamic_experience_json'],
  presentation: ['dynamic_presentation'],
  video: ['dynamic_video'],
  video_interactions: ['dynamic_video_interactions_json'],
  exam: ['dynamic_exam_gift'],
  final_exam: ['dynamic_exam_gift'],
  audio_welcome: ['dynamic_audio_mp3'],
  audiobook_chapter: ['dynamic_audio_mp3'],
};
const V3_ACTIVITY_ROLES = {
  h5p: ['dynamic_h5p_params_json'],
  scorm: ['dynamic_scorm_html', 'dynamic_scorm_manifest'],
};

/** Roles v3 de un tipo (activity: por variant). undefined = tipo/variant desconocido. */
function requiredRolesV3(type, variant) {
  if (type === 'activity') return V3_ACTIVITY_ROLES[variant] ? [...V3_ACTIVITY_ROLES[variant]] : undefined;
  return V3_ARTIFACT_ROLES[type] ? [...V3_ARTIFACT_ROLES[type]] : undefined;
}

const CHAPTER_TYPES = ['content', 'experience', 'presentation', 'video', 'video_interactions', 'activity', 'audiobook_chapter'];

/**
 * Invariantes de un Manifest rulesVersion 3 contra el snapshot (schemaVersion
 * 2) de su Blueprint y las columnas de conteo de la fila.
 *
 * @param row   fila de course_generation_manifests (+ blueprint_snapshot_json y columnas *_count)
 * @param label prefijo de los mensajes
 * @returns string[] violaciones (vacío = OK)
 */
function auditManifestV3(row, label) {
  const failures = [];
  const push = (m) => failures.push(`${label}: ${m}`);
  const manifest = row.manifest_json || {};
  const items = Array.isArray(manifest.items) ? manifest.items : [];
  const snap = row.blueprint_snapshot_json || {};
  const courseId = row.course_id;

  if (manifest.rulesVersion !== 3) push(`manifest_json.rulesVersion=${manifest.rulesVersion} (la columna rules_version es 3).`);
  if (snap.schemaVersion !== 2) {
    push(`el Blueprint referenciado es schemaVersion ${snap.schemaVersion}; rulesVersion 3 exige schemaVersion 2.`);
    return failures;
  }
  const course = snap.course || {};
  const features = manifest.features || {};
  if (features.finalExam !== course.finalExam || features.activityEngine !== course.activityEngine) {
    push(`features=${JSON.stringify(features)} no coincide con el Blueprint (finalExam=${course.finalExam}, activityEngine=${course.activityEngine}).`);
  }

  // Conteos por tipo = columnas; ningún tipo fuera de v3 (en particular `scorm`).
  const byType = Object.fromEntries(V3_ITEM_TYPES.map((t) => [t, 0]));
  const keys = new Set();
  for (const it of items) {
    if (!it || !Object.prototype.hasOwnProperty.call(byType, it.type)) {
      push(`item con type desconocido/ausente en v3: ${JSON.stringify(it && it.key)} (type=${JSON.stringify(it && it.type)}).`);
      continue;
    }
    byType[it.type] += 1;
    if (keys.has(it.key)) push(`key duplicada: ${it.key}.`);
    keys.add(it.key);
    if (it.type === 'activity') {
      if (it.variant !== course.activityEngine) push(`${it.key}.variant=${JSON.stringify(it.variant)} ≠ activityEngine del Blueprint (${course.activityEngine}).`);
    } else if (it.variant !== undefined && it.variant !== null) {
      push(`${it.key} declara variant pero no es activity.`);
    }
    for (const d of Array.isArray(it.dependsOn) ? it.dependsOn : []) {
      if (!items.some((x) => x && x.key === d)) push(`${it.key}.dependsOn referencia ${d}, que no existe en el Manifest.`);
    }
  }
  for (const [t, col] of Object.entries(V3_COUNT_COLUMNS)) {
    if (row[col] !== undefined && byType[t] !== Number(row[col])) push(`items de type=${t} (${byType[t]}) no coincide con ${col}=${row[col]}.`);
  }
  if (row.scorm_count !== undefined && Number(row.scorm_count) !== 0) push(`scorm_count=${row.scorm_count} (v3 no tiene items scorm; esperado 0).`);

  // Items de curso: uno de plan/intro/audio_welcome; final_exam sii course.finalExam.
  const courseExpect = { course_plan: 1, course_intro: 1, audio_welcome: 1, final_exam: course.finalExam === true ? 1 : 0 };
  for (const [t, n] of Object.entries(courseExpect)) {
    const found = items.filter((i) => i && i.type === t);
    if (found.length !== n) push(`esperado ${n} item(s) ${t} (encontrados ${found.length}).`);
    for (const i of found) {
      if (i.key !== `${t}:${courseId}` || i.scope !== 'course' || i.moduleId !== null || i.chapterId !== null) {
        push(`${i.key} debe ser ${t}:${courseId}, scope=course, sin moduleId/chapterId.`);
      }
    }
  }
  const planKey = `course_plan:${courseId}`;
  for (const i of items) {
    if (i && i.type === 'content' && !(Array.isArray(i.dependsOn) && i.dependsOn.includes(planKey))) {
      push(`${i.key}.dependsOn no incluye ${planKey}.`);
    }
  }

  // Cobertura exacta en ambas direcciones contra el snapshot.
  const count = new Map();
  for (const i of items) {
    if (!i || !i.key) continue;
    count.set(i.key, (count.get(i.key) || 0) + 1);
    if (CHAPTER_TYPES.includes(i.type)) {
      const mod = (snap.modules || []).find((m) => m && m.id === i.moduleId);
      const ch = mod && (mod.chapters || []).find((c) => c && c.id === i.chapterId);
      if (!ch || i.key !== `${i.type}:${i.chapterId}` || i.scope !== 'chapter') {
        push(`${i.key} no referencia un capítulo del snapshot con su módulo (moduleId=${i.moduleId}, chapterId=${i.chapterId}).`);
      }
    }
    if (i.type === 'exam' || i.type === 'module_intro') {
      if (!(snap.modules || []).some((m) => m && m.id === i.moduleId) || i.key !== `${i.type}:${i.moduleId}` || i.scope !== 'module') {
        push(`${i.key} no referencia un módulo del snapshot.`);
      }
    }
  }
  for (const m of snap.modules || []) {
    const n = (k) => count.get(k) || 0;
    if (n(`module_intro:${m.id}`) !== 1) push(`módulo ${m.id}: ${n(`module_intro:${m.id}`)} module_intro (esperado 1).`);
    const exp = m.examEnabled === true ? 1 : 0;
    if (n(`exam:${m.id}`) !== exp) push(`módulo ${m.id} (examEnabled=${m.examEnabled === true}): ${n(`exam:${m.id}`)} exam (esperado ${exp}).`);
    for (const c of m.chapters || []) {
      for (const t of ['content', 'experience', 'presentation', 'audiobook_chapter']) {
        if (n(`${t}:${c.id}`) !== 1) push(`capítulo ${c.id}: ${n(`${t}:${c.id}`)} ${t} (esperado 1).`);
      }
      const v = c.videoEnabled === true ? 1 : 0;
      for (const t of ['video', 'video_interactions']) {
        if (n(`${t}:${c.id}`) !== v) push(`capítulo ${c.id} (videoEnabled=${c.videoEnabled === true}): ${n(`${t}:${c.id}`)} ${t} (esperado ${v}).`);
      }
      const a = c.activityEnabled === true ? 1 : 0;
      if (n(`activity:${c.id}`) !== a) push(`capítulo ${c.id} (activityEnabled=${c.activityEnabled === true}): ${n(`activity:${c.id}`)} activity (esperado ${a}).`);
    }
  }
  return failures;
}

/**
 * Roles de artifact de un item run v3 COMPLETADO: exactamente 1 artifact de
 * cada rol obligatorio (activity según su variant del Manifest).
 *
 * @param row { id, item_key, type, variant, artifact_types: string[] }
 * @returns string[] violaciones
 */
function auditItemRolesV3(row) {
  const label = `Item run v3 id=${row.id} (item_key=${row.item_key})`;
  const roles = requiredRolesV3(row.type, row.variant);
  if (!roles) return [`${label}: tipo/variant sin roles v3 conocidos (type=${row.type}, variant=${JSON.stringify(row.variant)}).`];
  const types = row.artifact_types || [];
  const out = [];
  for (const r of roles) {
    const n = types.filter((t) => t === r).length;
    if (n !== 1) out.push(`${label}: esperado exactamente 1 artifact ${r}, encontrados ${n}.`);
  }
  return out;
}

module.exports = {
  V3_ITEM_TYPES,
  V3_COUNT_COLUMNS,
  V3_ARTIFACT_ROLES,
  V3_ACTIVITY_ROLES,
  requiredRolesV3,
  auditManifestV3,
  auditItemRolesV3,
};
