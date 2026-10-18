/* eslint-disable */
// r58 (I1) — INFORME ESTRUCTURADO de una corrida sintética (dry-run + driver offline de componentes), en JSON y
// Markdown. No calcula nada nuevo: proyecta los campos del dry-run del producto (pedagogy/dry-run.ts: distribución,
// decisiones por capítulo, proveedores y estimado FinOps, studyTime) y el resultado del driver (componentes generados,
// validaciones, paquete). TODO lo de este informe es sintético (`runKind: 'synthetic'`): nunca describe un curso real.
'use strict';

const REPORT_VERSION = 1;
const REPORT_SCHEMA_KEYS = ['reportVersion', 'runKind', 'synthetic', 'generatedAt', 'configuration', 'pedagogicalDecisions', 'plannedResources', 'validationsPassed', 'warnings', 'errors', 'componentsNotVerified', 'externalDependencies', 'components', 'affectedComponents', 'package', 'quality', 'network'];

const LLM_TYPES = new Set(['course_plan', 'course_intro', 'module_intro', 'content', 'experience', 'activity', 'video_interactions', 'application_activity', 'guided_practice', 'exam', 'final_exam']);
const WORKER_OF = { llm: 'dynamic-llm-worker', presentation: 'dynamic-provider-worker', audio_welcome: 'dynamic-provider-worker', audiobook_chapter: 'dynamic-provider-worker', video: 'dynamic-item-worker', package: 'dynamic-package-worker' };

function countBy(arr, f) {
  const o = {};
  for (const x of arr) { const k = f(x); o[k] = (o[k] || 0) + 1; }
  return o;
}

/**
 * @param {object} r resultado de offline-driver.runComponents
 * @param {{ generatedAt?: string }} o
 */
function buildDryRunReport(r, o = {}) {
  const { prep, cfg } = r;
  const d = prep.dryRun;
  const dist = d.distribution;
  const side = d.pedagogical || d.baseline;
  const manifest = prep.manifest;
  const items = Object.values(r.items);
  const chapters = d.chapters || [];
  const h5pActs = manifest.items.filter((i) => i.type === 'activity' && i.variant === 'h5p');

  const configuration = {
    courseConfigId: cfg.id || null,
    courseId: cfg.courseId,
    title: cfg.title,
    format: cfg.format || null,
    targetHours: cfg.targetHours ?? null,
    activityEngine: manifest.features.activityEngine,
    finalExam: manifest.features.finalExam,
    examMode: cfg.exams || 'bank',
    rulesVersion: manifest.rulesVersion,
    activityTypeRules: manifest.features.activityTypeRules ?? null,
    ivAdvanced: manifest.features.ivAdvanced ?? null,
    manifestSha256: r.manifestSha256,
    blueprintSha256: manifest.source.blueprintSha256,
    selection: r.selection,
    llm: { mode: r.llm.mode, provider: r.llm.provider, calls: r.llm.calls, replayMisses: r.llm.misses },
    providerModes: { llm: r.llm.mode === 'replay' ? 'replay' : 'fake', presentation: 'mock', audio: 'mock', video: 'mock' },
    driverVersion: r.driverVersion,
    validatorVersion: r.validatorVersion,
  };

  const pedagogicalDecisions = {
    primaryApproach: (d.profile && d.profile.primaryApproach) || null,
    methodology: d.learningPlan ? { framework: d.learningPlan.framework.id, label: d.learningPlan.framework.label, phases: d.learningPlan.framework.phases.map((p) => ({ id: p.id, label: p.label, required: p.required })), phaseLabels: d.learningPlan.phaseLabels } : null,
    chapters: chapters.map((c) => ({
      moduleNumber: c.moduleNumber, chapterNumber: c.chapterNumber, chapterId: c.chapterId, title: c.title, role: c.role,
      learningType: c.learningType ? { type: c.learningType.type, level: c.learningType.level ?? null, ruleId: c.learningType.ruleId ?? null } : null,
      activityDecision: c.activityDecision ? { type: c.activityDecision.type, ruleId: c.activityDecision.ruleId ?? null, reason: c.activityDecision.reason ?? null } : null,
      video: c.video ? { enabled: c.video.enabled, style: c.video.style ?? null } : null,
      framework: c.framework ? (c.framework.id || c.framework) : null,
    })),
    distributionChapters: dist ? dist.modules.flatMap((m) => m.chapters.map((c) => ({ chapterId: c.id, kind: c.kind, applicationMinutes: c.applicationMinutes ?? null, guidedPracticeMinutes: c.guidedPracticeMinutes ?? null, videoDecision: c.videoDecision ? c.videoDecision.ruleId : null, targetMinutes: c.targetMinutes }))) : [],
    appliedRules: (d.appliedRules || []).map((a) => ({ ruleId: a.ruleId, target: a.target, value: a.value, outcome: a.outcome })),
    frozenActivityTypes: h5pActs.map((i) => ({ itemKey: i.key, h5pType: i.h5pType ?? null })),
  };

  const totals = manifest.totals;
  const plannedResources = {
    manifestTotals: totals,
    itemsByType: countBy(manifest.items, (i) => i.type),
    videos: totals.videoCount ?? 0,
    h5p: { activities: h5pActs.length, videoInteractions: totals.videoInteractionsCount ?? 0, byType: countBy(h5pActs, (i) => i.h5pType || 'rotation') },
    exams: { module: totals.examCount ?? 0, final: totals.finalExamCount ?? 0, mode: cfg.exams || 'bank' },
    applicationActivities: { count: totals.applicationActivityCount ?? 0, minutes: dist ? dist.counts.applicationMinutes ?? null : null },
    guidedPractice: { count: totals.guidedPracticeCount ?? 0 },
    practiceFiles: ((prep.assessment.profile.practiceResources) || []).map((p) => ({ id: p.id, chapterId: p.chapterId, relation: p.relation, kind: p.source.kind, format: p.source.format || null, filename: p.source.filename })),
    hours: dist ? { target: dist.targetHours, estimated: dist.estimatedHours, base: dist.baseHours, generable: dist.generableHours, status: dist.status, byComponent: dist.hoursByComponent, measured: false } : null,
  };

  const validationsPassed = [];
  for (const it of items) for (const v of it.validations || []) if (v.ok) validationsPassed.push({ itemKey: it.key, validator: v.validator, artifactType: v.artifactType || null });
  validationsPassed.push(...[
    { itemKey: null, validator: 'validateProfile(pedagogy|assessment)' },
    { itemKey: null, validator: 'validateGenerationManifestV3 (materializado)' },
  ]);
  if (items.some((it) => LLM_TYPES.has(it.type) && it.source !== 'approved_reused' && it.status === 'completed')) validationsPassed.push({ itemKey: null, validator: 'assembleClaimedItem (integridad del claim)' });
  if (r.package && r.package.validation.ok) validationsPassed.push({ itemKey: null, validator: 'validateMbzV3', artifactType: 'mbz' });
  if (r.network.attempts.length === 0) validationsPassed.push({ itemKey: null, validator: 'network-barrier: 0 intentos de red' });

  const warnings = [
    ...(side.providers && side.providers.estimateNote ? [{ code: 'ESTIMATE_NOTE', message: side.providers.estimateNote }] : []),
    ...((side.providers && side.providers.assumptions) || []).map((m) => ({ code: 'ESTIMATE_ASSUMPTION', message: m })),
    // Horas: la propuesta del distribuidor (la que se congela), no la vista previa sin distribuir.
    ...(dist && dist.status !== 'within_tolerance' ? [{ code: 'HOURS_OUT_OF_TOLERANCE', message: `objetivo ${dist.targetHours} h, estimado ${dist.estimatedHours} h (${dist.status})` }] : []),
    ...r.warnings.map((w) => ({ code: w.code, itemKey: w.itemKey || null, message: w.message })),
  ];

  // Componentes NO verificados: todo lo que en esta corrida salió de un falso, una fixture o un replay.
  const componentsNotVerified = [];
  for (const it of items) {
    if (it.status !== 'completed') continue;
    if (LLM_TYPES.has(it.type)) componentsNotVerified.push({ itemKey: it.key, type: it.type, source: it.source, reason: it.source === 'approved_reused' ? 'reutilizado de una corrida anterior (aprobado)' : 'requires real AI (texto de un LLM falso o de replay)' });
    else if (it.type === 'presentation') componentsNotVerified.push({ itemKey: it.key, type: it.type, source: it.source, reason: 'requires Gamma (presentación simulada)' });
    else if (it.type === 'audio_welcome' || it.type === 'audiobook_chapter') componentsNotVerified.push({ itemKey: it.key, type: it.type, source: it.source, reason: 'requires OpenAI TTS (audio simulado)' });
    else if (it.type === 'video') componentsNotVerified.push({ itemKey: it.key, type: it.type, source: it.source, reason: 'requires Videogen + YouTube (video de vista previa; se omite del paquete)' });
  }
  if (r.package) {
    for (const k of r.package.packageFixtures) componentsNotVerified.push({ itemKey: k, type: k.split(':')[0], source: 'package_fixture', reason: 'fixture de empaque (no generado en esta corrida)' });
    componentsNotVerified.push({ itemKey: null, type: 'package', source: 'synthetic', reason: 'requires Moodle client (restauración real no ejecutada por el driver)' });
  }
  componentsNotVerified.push({ itemKey: null, type: 'pedagogy', source: 'synthetic', reason: 'requires academic review (decisiones pedagógicas sin revisión humana)' });

  const byProvider = (side.providers && side.providers.byProvider) || {};
  const externalDependencies = {
    providers: Object.entries(byProvider).map(([provider, v]) => ({ provider, items: v.items, operations: v.operations })),
    models: r.llm.models,
    quota: { youtubeUploads: (byProvider.youtube && byProvider.youtube.items) || 0, videogenRenders: (byProvider.videogen && byProvider.videogen.items) || 0 },
    estimateUsd: side.providers ? side.providers.estimateUsd : null,
    unverifiedPricing: (side.providers && side.providers.unverifiedProviders) || [],
    workers: [...new Set(manifest.items.map((i) => (LLM_TYPES.has(i.type) ? WORKER_OF.llm : WORKER_OF[i.type])).filter(Boolean).concat(WORKER_OF.package))].sort(),
  };

  const report = {
    reportVersion: REPORT_VERSION,
    runKind: 'synthetic',
    synthetic: true,
    generatedAt: o.generatedAt || '2026-01-01T00:00:00.000Z',
    configuration,
    pedagogicalDecisions,
    plannedResources,
    validationsPassed,
    warnings,
    errors: r.errors.map((e) => ({ code: e.code, itemKey: e.itemKey || null, message: e.message })),
    componentsNotVerified,
    externalDependencies,
    components: items.map((it) => ({ itemKey: it.key, type: it.type, role: it.role, status: it.status, source: it.source, llmCalls: it.llmCalls || 0, artifacts: (it.artifacts || []).map((a) => ({ type: a.type, sha256: a.sha256, bytes: a.bytes })), error: it.error || null })),
    affectedComponents: r.affected,
    package: r.package ? { sha256: r.package.sha256, bytes: r.package.bytes, builderVersion: r.package.builderVersion, validation: r.package.validation, syntheticMarker: r.package.marker, pendingVideos: r.package.pendingVideos.map((p) => p.itemKey), mockProviderItems: r.package.mockProviderItems } : null,
    // r58 (I2): informe de calidad del paquete sintético (mismo formato que el job de empaque); null sin paquete.
    quality: r.package && r.package.qualityReport ? { counts: r.package.qualityReport.counts, blocksDelivery: r.package.qualityReport.blocksDelivery, requiresHumanResolution: r.package.qualityReport.requiresHumanResolution, notMeasured: r.package.qualityReport.notMeasured, findings: r.package.qualityReport.findings } : null,
    network: { barrier: true, attempts: r.network.attempts.length },
  };
  const errs = validateReport(report);
  if (errs.length) throw new Error(`informe inválido: ${errs.join('; ')}`);
  return report;
}

function validateReport(rep) {
  const errs = [];
  for (const k of REPORT_SCHEMA_KEYS) if (!(k in rep)) errs.push(`falta ${k}`);
  if (rep.runKind !== 'synthetic' && rep.runKind !== 'real') errs.push('runKind debe ser synthetic|real');
  if (rep.runKind === 'synthetic' && rep.synthetic !== true) errs.push('un informe synthetic debe tener synthetic:true');
  for (const k of ['validationsPassed', 'warnings', 'errors', 'componentsNotVerified', 'components', 'affectedComponents']) if (!Array.isArray(rep[k])) errs.push(`${k} no es lista`);
  if (rep.externalDependencies && !Array.isArray(rep.externalDependencies.providers)) errs.push('externalDependencies.providers no es lista');
  return errs;
}

/** Markdown legible del informe (mismo contenido; ningún dato nuevo). */
function renderReportMarkdown(rep) {
  const L = [];
  const c = rep.configuration;
  L.push(`# Informe de corrida SINTÉTICA — ${c.title}`);
  L.push('');
  L.push(`> **runKind: ${rep.runKind}** · todo el contenido es sintético (LLM falso/replay, Gamma/TTS/Videogen simulados). No es un curso entregable.`);
  L.push('');
  L.push('## Configuración');
  L.push(`- Curso ${c.courseConfigId || ''} (#${c.courseId}), formato ${c.format || '—'}, objetivo ${c.targetHours ?? '—'} h, motor ${c.activityEngine}, examen final ${c.finalExam ? 'sí' : 'no'}, exámenes ${c.examMode}`);
  L.push(`- Manifest v${c.rulesVersion} \`${c.manifestSha256.slice(0, 12)}\`, activityTypeRules ${c.activityTypeRules}, IA ${c.llm.mode} (${c.llm.provider}, ${c.llm.calls} llamadas, ${c.llm.replayMisses} sin fixture)`);
  L.push(`- Selección: ${c.selection.selected.length} componente(s); aprobados: ${c.selection.approved.length}; sub-DAG: ${c.selection.order.length}`);
  L.push('');
  L.push('## Decisiones pedagógicas');
  const p = rep.pedagogicalDecisions;
  L.push(`- Enfoque: ${p.primaryApproach || '—'}; metodología: ${p.methodology ? `${p.methodology.label} (${p.methodology.phases.map((x) => x.label).join(' → ')})` : '—'}`);
  L.push('');
  L.push('| Cap. | Título | Tipo de aprendizaje | Actividad | Video |');
  L.push('|---|---|---|---|---|');
  for (const ch of p.chapters) L.push(`| ${ch.moduleNumber}.${ch.chapterNumber} | ${ch.title} | ${ch.learningType ? ch.learningType.type : '—'} | ${ch.activityDecision ? ch.activityDecision.type : '—'} | ${ch.video && ch.video.enabled ? ch.video.style || 'sí' : 'no'} |`);
  L.push('');
  L.push('## Recursos planificados');
  const r = rep.plannedResources;
  L.push(`- Videos ${r.videos} · H5P ${r.h5p.activities} (+${r.h5p.videoInteractions} interactivos) · exámenes ${r.exams.module} + final ${r.exams.final} · AA ${r.applicationActivities.count} · práctica guiada ${r.guidedPractice.count} · archivos de práctica ${r.practiceFiles.length}`);
  if (r.hours) L.push(`- Horas: objetivo ${r.hours.target}, estimado ${r.hours.estimated} (${r.hours.status}; valores planificados, no medidos)`);
  L.push('');
  L.push(`## Validaciones aprobadas (${rep.validationsPassed.length})`);
  for (const v of rep.validationsPassed) L.push(`- ${v.validator}${v.itemKey ? ` — \`${v.itemKey}\`` : ''}`);
  L.push('');
  L.push(`## Errores (${rep.errors.length})`);
  for (const e of rep.errors) L.push(`- **${e.code}** ${e.itemKey ? `\`${e.itemKey}\` ` : ''}${e.message}`);
  L.push('');
  L.push(`## Avisos (${rep.warnings.length})`);
  for (const w of rep.warnings.slice(0, 40)) L.push(`- ${w.code}: ${String(w.message).slice(0, 240)}`);
  L.push('');
  L.push(`## Componentes no verificados (${rep.componentsNotVerified.length})`);
  for (const u of rep.componentsNotVerified) L.push(`- ${u.itemKey ? `\`${u.itemKey}\`` : u.type}: ${u.reason}`);
  L.push('');
  L.push('## Dependencias externas necesarias para una corrida real');
  for (const pv of rep.externalDependencies.providers) L.push(`- ${pv.provider}: ${pv.items} item(s) — ${Object.entries(pv.operations).map(([k, n]) => `${k}×${n}`).join(', ')}`);
  L.push(`- Modelos: ${rep.externalDependencies.models.join(', ') || '—'}; cuota YouTube: ${rep.externalDependencies.quota.youtubeUploads} subidas; workers: ${rep.externalDependencies.workers.join(', ')}`);
  if (rep.externalDependencies.estimateUsd) L.push(`- Estimado (dry-run, no cobrado): USD ${rep.externalDependencies.estimateUsd.expected} (min ${rep.externalDependencies.estimateUsd.min}, max ${rep.externalDependencies.estimateUsd.max})`);
  L.push('');
  if (rep.package) {
    L.push('## Paquete sintético');
    L.push(`- \`${rep.package.sha256.slice(0, 16)}\` · ${rep.package.bytes} bytes · validateMbzV3 ${rep.package.validation.ok ? 'OK' : 'FALLÓ'} · marca \`cursia-synthetic.json\` + título «[SINTÉTICO] …» + aviso QA`);
    L.push(`- Videos omitidos (vista previa): ${rep.package.pendingVideos.length}`);
    L.push('');
  }
  if (rep.quality) {
    const q = rep.quality;
    L.push(`## Informe de calidad (BLOCKER ${q.counts.BLOCKER} · MAJOR ${q.counts.MAJOR} · MINOR ${q.counts.MINOR} · INFO ${q.counts.INFO})`);
    L.push(`- Entrega: ${q.blocksDelivery ? 'BLOQUEADA (hay BLOCKER)' : 'sin bloqueantes'}${q.requiresHumanResolution ? '; hay MAJOR que una persona debe resolver o aceptar' : ''}${q.notMeasured.length ? `; no medido: ${q.notMeasured.join(', ')}` : ''}`);
    for (const f of q.findings.slice(0, 40)) L.push(`- **${f.severity}** ${f.code}${f.location.chapterId ? ` (${f.location.section || ''} ${f.location.chapterId})` : ''}: ${String(f.evidence).slice(0, 200)}${f.kind === 'needs_human_review' ? ' — revisión humana' : ''}`);
    L.push('');
  }
  L.push(`Red: barrera activa, ${rep.network.attempts} intento(s).`);
  return L.join('\n') + '\n';
}

module.exports = { buildDryRunReport, renderReportMarkdown, validateReport, REPORT_VERSION, REPORT_SCHEMA_KEYS };
