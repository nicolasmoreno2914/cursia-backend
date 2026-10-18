#!/usr/bin/env node
/* eslint-disable */
// r58 (I1) — DRIVER OFFLINE DE COMPONENTES (scripts/lib/offline-driver.js) + informe estructurado del dry-run
// (scripts/lib/dry-run-report.js). Check puro contra dist/ (`npm run build` antes). Curso SINTÉTICO
// (scripts/fixtures/offline-driver/course.json), LLM falso del E2E, Gamma/TTS/Videogen simulados, barrera de red
// activa, sin DB ni Storage, USD 0. Las fixtures H5P v2 del LLM falso vienen del frontend (CURSIA_FRONTEND_REPO; por
// defecto ../fe o ../campuscloud-gen).
//
//   OD1 validación de entrada: selección vacía / clave o tipo inexistente / capítulo fuera de rango / aprobado y
//       seleccionado a la vez / courseId fuera del rango sintético → error explícito (DriverError con código)
//   OD2 selección por clave o tipo + sub-DAG del Manifest: un capítulo, un H5P, un banco de examen, video_interactions,
//       una Actividad de Aplicación, el examen final (cada uno con EXACTAMENTE sus dependencias transitivas, en orden
//       topológico) — todos generados y validados por el validador de completeItem
//   OD3 claim = el del scheduler: SchedulerService.buildClaimedItem (con lecturas SQL simuladas sobre los mismos datos)
//       devuelve el MISMO ClaimedItem que el driver (assembleClaimedItem) para content, experience, activity, AA y exam
//   OD4 aprobados preservados: la 2.ª corrida reutiliza content/course_plan aprobados byte a byte (mismos ids y sha,
//       0 llamadas de IA para ellos) y solo genera lo seleccionado; un aprobado alterado → APPROVED_HASH_MISMATCH
//   OD5 reproducibilidad: la misma corrida dos veces → mismos ids, mismos artifacts y el mismo .mbz byte a byte
//   OD6 sin duplicados: un artifact por (item, tipo), ids únicos; el almacén rechaza un segundo contenido distinto
//   OD7 informe (JSON + Markdown): esquema completo, runKind synthetic, decisiones pedagógicas, recursos planificados,
//       validaciones, no verificados («requires real AI», «requires Moodle client», «requires academic review»),
//       dependencias externas (proveedores, modelos, cuota, workers)
//   OD8 marca sintética: el .mbz lleva «[SINTÉTICO]» + sufijo QA en el nombre del curso y cursia-synthetic.json
//       (deliverable:false); validateMbzV3 limpio CON la marca; videos de vista previa omitidos
//   OD9 nunca escribe en la base ni en Storage: el driver no importa pg/typeorm/ArtifactsService/Supabase, su fachada
//       del scheduler rechaza SQL y el cargador del paquete rechaza Storage
//   OD10 registro de afectados: regenerar un content enumera la cascada del producto (REGENERATE / STALE_NO_AUTO) y
//       sus dependientes
//
// Uso: node scripts/check-offline-driver.js [--out=<dir>]   (informe de ejemplo en --out; default: tmp)
'use strict';
require('reflect-metadata');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const D = require('./lib/offline-driver');
const REP = require('./lib/dry-run-report');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const CFG = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/offline-driver/course.json'), 'utf8'));
const OUT = (process.argv.find((a) => a.startsWith('--out=')) || '').slice(6) || fs.mkdtempSync(path.join(os.tmpdir(), 'check-offline-driver-'));
let passed = 0;
let failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log(`✅ ${name}`); } catch (err) { failed++; console.error(`❌ ${name}\n   ${String(err && err.stack ? err.stack : err).split('\n').slice(0, 6).join('\n   ')}`); }
}
const assert = (c, msg) => { if (!c) throw new Error(msg); };
const eq = (a, b, msg) => { const x = JSON.stringify(a); const y = JSON.stringify(b); if (x !== y) throw new Error(`${msg}:\n   ${x.slice(0, 600)}\n !==\n   ${y.slice(0, 600)}`); };
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const run = (select, o = {}) => D.runComponents(DIST, CFG, { select, ...o });
const keysOf = (r) => r.selection.order;
const typesOf = (r) => r.selection.order.map((k) => k.split(':')[0]);
const okRun = (r, what) => assert(r.ok, `${what}: ${JSON.stringify(r.errors.slice(0, 3))}`);
const expectErr = async (fn, code, what) => {
  let err = null;
  try { await fn(); } catch (e) { err = e; }
  assert(err && err.code === code, `${what}: se esperaba ${code}, vino ${err ? `${err.code} ${err.message}` : 'sin error'}`);
};

(async () => {
  if (!D.loadH5p2Fixture()) {
    console.log('❌ faltan las fixtures H5P v2 del LLM falso (fixtures/h5p2/fake-llm-h5p2.json del frontend): definir CURSIA_FRONTEND_REPO');
    process.exit(1);
  }
  const prep = await require('./lib/commercial-simulation').prepareCourse(DIST, { ...CFG, title: D.SYNTHETIC_TITLE_PREFIX + CFG.title });
  const m0c0 = prep.structure.modules[0].chapters[0].id;
  const mod0 = prep.structure.modules[0];

  await check('OD1 validación de entrada: errores explícitos (selección vacía, clave/tipo inexistentes, capítulo fuera de rango, conflicto aprobado/seleccionado, courseId no sintético)', async () => {
    await expectErr(() => run([]), 'INPUT_INVALID', 'selección vacía');
    await expectErr(() => run(['content:00000000-0000-4000-8000-000000000000']), 'INPUT_INVALID', 'clave inexistente');
    await expectErr(() => run([{ type: 'scorm' }]), 'INPUT_INVALID', 'tipo inexistente en el Manifest');
    await expectErr(() => run([{ chapter: { m: 0, c: 9 } }]), 'INPUT_INVALID', 'capítulo fuera de rango');
    await expectErr(() => run([{}]), 'INPUT_INVALID', 'selector vacío');
    await expectErr(() => run([`content:${m0c0}`], { approved: { [`content:${m0c0}`]: { artifacts: [] } } }), 'SELECTION_CONFLICT', 'aprobado y seleccionado');
    await expectErr(() => D.runComponents(DIST, { ...CFG, courseId: 601 }, { select: [{ type: 'course_plan' }] }), 'INPUT_INVALID', 'courseId fuera del rango sintético');
    await expectErr(() => run([{ type: 'course_plan' }], { llm: { mode: 'live' } }), 'INPUT_INVALID', 'modo de IA desconocido');
  });

  const runs = {};
  await check('OD2 selección + sub-DAG: capítulo, H5P, banco de examen, video_interactions, AA y examen final con exactamente sus dependencias', async () => {
    const cases = {
      chapter: { sel: [{ chapter: { m: 0, c: 0 } }], types: ['course_plan', 'content', 'experience', 'presentation', 'video', 'video_interactions', 'activity', 'application_activity', 'audiobook_chapter'] },
      h5p: { sel: [{ type: 'activity', chapter: { m: 0, c: 0 } }], types: ['course_plan', 'content', 'activity'] },
      exam: { sel: [{ type: 'exam', module: 0 }], types: ['course_plan', 'content', 'content', 'exam'] },
      vi: { sel: [`video_interactions:${m0c0}`], types: ['course_plan', 'content', 'video', 'video_interactions'] },
      aa: { sel: [{ type: 'application_activity', chapter: { m: 0, c: 0 } }], types: ['course_plan', 'content', 'application_activity'] },
    };
    for (const [name, c] of Object.entries(cases)) {
      const r = await run(c.sel, { keepClaims: true });
      okRun(r, name);
      eq(typesOf(r), c.types, `${name}: sub-DAG`);
      const sel = r.selection.selected;
      for (const k of keysOf(r)) {
        const it = r.items[k];
        assert(it.status === 'completed', `${name}: ${k} ${it.status}`);
        eq(it.role, sel.includes(k) ? 'selected' : 'dependency', `${name}: rol de ${k}`);
        for (const d of prep.manifest.items.find((i) => i.key === k).dependsOn) assert(keysOf(r).indexOf(d) < keysOf(r).indexOf(k), `${name}: ${d} después de ${k}`);
      }
      const validated = Object.values(r.items).filter((i) => i.validations.some((v) => v.validator === 'validateV3ItemArtifact' && v.ok)).map((i) => i.type);
      for (const t of ['experience', 'activity', 'video_interactions', 'application_activity', 'exam']) if (c.types.includes(t)) assert(validated.includes(t), `${name}: ${t} sin validateV3ItemArtifact`);
      assert(r.network.attempts.length === 0, `${name}: intentos de red`);
      runs[name] = r;
    }
    // Examen del módulo 0: banco con evidencia en los dos capítulos generados en ESTA corrida.
    const ex = runs.exam.items[`exam:${mod0.id}`];
    assert(ex.artifacts.some((a) => a.type === 'dynamic_exam_bank_json') && ex.outputSummary.v3Validation && ex.outputSummary.v3Validation.artifactType === 'dynamic_exam_bank_json', 'el examen no es un banco validado');
    // Examen final: depende de todo el contenido (y de los exámenes de módulo si el Manifest trae esa arista).
    const fin = await run([{ type: 'final_exam' }]);
    okRun(fin, 'final_exam');
    const fItem = prep.manifest.items.find((i) => i.type === 'final_exam');
    for (const d of fItem.dependsOn) assert(keysOf(fin).includes(d), `final_exam sin su dependencia ${d}`);
    assert(fin.items[fItem.key].status === 'completed', 'final_exam no completado');
    runs.final = fin;
  });

  await check('OD3 claim del driver = SchedulerService.buildClaimedItem sobre los mismos datos (content, experience, activity, AA, exam)', async () => {
    const SCH = require(path.join(DIST, 'modules/dynamic-generation/scheduler.service.js'));
    const MB = require(path.join(DIST, 'modules/generation-manifests/generation-manifest-builder.js'));
    const SNAP = require(path.join(DIST, 'modules/course-blueprints/blueprint-snapshot.js'));
    const pairs = [[runs.h5p, `content:${m0c0}`], [runs.chapter, `experience:${m0c0}`], [runs.h5p, `activity:${m0c0}`], [runs.aa, `application_activity:${m0c0}`], [runs.exam, `exam:${mod0.id}`]];
    for (const [r, key] of pairs) {
      const st = r._state();
      const mItem = st.manifest.items.find((i) => i.key === key);
      const row = st.rowOf(mItem);
      const claim = r.items[key].claim;
      assert(claim && claim.itemKey === key, `${key}: el driver no guardó el claim`);
      const depRows = (mItem.dependsOn || []).flatMap((d) => r.items[d].artifacts.map((a) => ({ item_key: d, id: a.id, type: a.type, storage_path: a.storagePath })));
      const qr = {
        async query(sql) {
          if (/from public\.generation_run_contexts/.test(sql)) return [{ context: st.ctx.context, context_hash: st.ctx.context_hash }];
          if (/from public\.course_generation_manifests where id/.test(sql)) return [{ course_id: row.course_id, blueprint_id: row.blueprint_id, manifest_json: JSON.stringify(st.manifest), manifest_sha256: MB.manifestSha256(st.manifest), blueprint_sha256: st.manifest.source.blueprintSha256 }];
          if (/from public\.course_blueprints/.test(sql)) return [{ id: 1, course_id: row.course_id, blueprint_number: 1, snapshot_json: JSON.stringify(st.locked), snapshot_sha256: SNAP.snapshotSha256V2(st.locked) }];
          if (/join public\.artifacts a on a\.item_run_id/.test(sql)) return depRows;
          throw new Error(`consulta no simulada: ${sql.slice(0, 80)}`);
        },
      };
      const facade = r._facade();
      assert(Object.getPrototypeOf(facade) === SCH.SchedulerService.prototype, 'la fachada no es el SchedulerService del producto');
      const prod = await SCH.SchedulerService.prototype.buildClaimedItem.call(facade, qr, { id: st.job.id, course_id: st.job.course_id, frontend_course_id: null, input_payload: { contextHash: st.ctx.context_hash } }, row, true);
      eq(JSON.parse(JSON.stringify(prod)), claim, `${key}: claim del scheduler ≠ claim del driver`);
    }
  });

  await check('OD4 aprobados preservados byte a byte (mismos ids/sha, 0 llamadas de IA) y solo se genera lo seleccionado; aprobado alterado → APPROVED_HASH_MISMATCH', async () => {
    const a = runs.h5p;
    const approved = { [`course_plan:${CFG.courseId}`]: a.exportItem(`course_plan:${CFG.courseId}`), [`content:${m0c0}`]: a.exportItem(`content:${m0c0}`) };
    const b = await run([{ type: 'activity', chapter: { m: 0, c: 0 } }, { type: 'experience', chapter: { m: 0, c: 0 } }], { approved });
    okRun(b, 'corrida con aprobados');
    for (const k of Object.keys(approved)) {
      eq(b.items[k].artifacts.map((x) => [x.id, x.type, x.sha256]), a.items[k].artifacts.map((x) => [x.id, x.type, x.sha256]), `${k}: artifacts aprobados cambiaron`);
      eq([b.items[k].role, b.items[k].source, b.items[k].llmCalls], ['approved', 'approved_reused', 0], `${k}: no se reutilizó`);
      for (const x of b.items[k].artifacts) eq(sha(b.artifactText(x.id)), x.sha256, `${k}: bytes del aprobado`);
    }
    const generated = Object.values(b.items).filter((i) => i.source === 'fake_llm').map((i) => i.type).sort();
    eq(generated, ['activity', 'experience'], 'solo debían generarse los seleccionados');
    eq(b.items[`activity:${m0c0}`].artifacts.map((x) => x.sha256), a.items[`activity:${m0c0}`].artifacts.map((x) => x.sha256), 'el activity generado sobre el content aprobado es el mismo');
    const tampered = JSON.parse(JSON.stringify(approved));
    tampered[`content:${m0c0}`].artifacts[0].content += '\nalterado';
    await expectErr(async () => { const r = await run([{ type: 'activity', chapter: { m: 0, c: 0 } }], { approved: tampered }); if (!r.ok) { const e = new Error(r.errors[0].message); e.code = r.errors[0].code; throw e; } }, 'APPROVED_HASH_MISMATCH', 'aprobado alterado');
  });

  let pkgA = null;
  await check('OD5 reproducibilidad: la misma corrida dos veces → mismos ids, artifacts y .mbz byte a byte', async () => {
    const sel = [{ chapter: { m: 0, c: 0 } }, { type: 'exam', module: 0 }];
    pkgA = await run(sel, { package: true });
    const b = await run(sel, { package: true });
    okRun(pkgA, 'A');
    okRun(b, 'B');
    eq(b.allArtifacts(), pkgA.allArtifacts(), 'artifacts (ids/sha)');
    eq([b.runId, b.manifestSha256], [pkgA.runId, pkgA.manifestSha256], 'ids del run');
    assert(pkgA.package && Buffer.compare(pkgA.package.mbz, b.package.mbz) === 0, '.mbz distinto entre corridas');
  });

  await check('OD6 sin duplicados: un artifact por (item, tipo), ids únicos; el almacén rechaza un contenido distinto para el mismo (item, tipo)', async () => {
    for (const r of [pkgA, ...Object.values(runs)]) {
      const all = r.allArtifacts();
      eq(new Set(all.map((a) => a.id)).size, all.length, 'ids repetidos');
      eq(new Set(all.map((a) => `${a.itemKey}|${a.type}`)).size, all.length, '(item, tipo) repetido');
    }
    const st = D.createMemStore('t');
    const x = st.put('content:x', 'ir', { type: 'dynamic_content_md', content: 'a' });
    const y = st.put('content:x', 'ir', { type: 'dynamic_content_md', content: 'a' });
    assert(x.id === y.id && st.byId.size === 1, 'el mismo contenido debía reutilizar el artifact');
    let err = null;
    try { st.put('content:x', 'ir', { type: 'dynamic_content_md', content: 'b' }); } catch (e) { err = e; }
    assert(err && err.code === 'DUPLICATE_ARTIFACT', 'debía rechazar un segundo contenido distinto');
  });

  await check('OD7 informe estructurado (JSON + Markdown): esquema, synthetic, decisiones, recursos, validaciones, no verificados, dependencias externas', async () => {
    const rep = REP.buildDryRunReport(pkgA);
    eq(REP.validateReport(rep), [], 'esquema');
    for (const k of REP.REPORT_SCHEMA_KEYS) assert(k in rep, `falta ${k}`);
    eq([rep.runKind, rep.synthetic], ['synthetic', true], 'runKind');
    assert(rep.configuration.title.startsWith(D.SYNTHETIC_TITLE_PREFIX) && rep.configuration.providerModes.llm === 'fake', 'configuración');
    assert(rep.pedagogicalDecisions.methodology && rep.pedagogicalDecisions.methodology.phases.length >= 2, 'fases de la metodología');
    assert(rep.pedagogicalDecisions.chapters.length === 4 && rep.pedagogicalDecisions.chapters.every((c) => c.learningType && c.activityDecision), 'tipos de aprendizaje / decisión de actividad por capítulo');
    const pr = rep.plannedResources;
    assert(pr.videos === prep.manifest.totals.videoCount && pr.h5p.activities > 0 && pr.exams.module === 2 && pr.exams.final === 1 && pr.applicationActivities.count > 0 && pr.practiceFiles.length === 1 && pr.hours && pr.hours.target === CFG.targetHours, `recursos planificados: ${JSON.stringify(pr).slice(0, 400)}`);
    const vnames = rep.validationsPassed.map((v) => v.validator);
    for (const v of ['validateV3ItemArtifact', 'validateMbzV3', 'network-barrier: 0 intentos de red']) assert(vnames.includes(v), `validación ${v} ausente`);
    const reasons = rep.componentsNotVerified.map((u) => u.reason).join('\n');
    for (const want of ['requires real AI', 'requires Gamma', 'requires OpenAI TTS', 'requires Videogen', 'requires Moodle client', 'requires academic review', 'fixture de empaque']) assert(reasons.includes(want), `no verificado sin «${want}»`);
    const provs = rep.externalDependencies.providers.map((p) => p.provider).sort();
    for (const p of ['anthropic', 'gamma', 'openai', 'videogen', 'youtube']) assert(provs.includes(p), `dependencia ${p} ausente`);
    assert(rep.externalDependencies.models.includes('claude-sonnet-4-6') && rep.externalDependencies.workers.includes('dynamic-llm-worker') && rep.externalDependencies.quota.youtubeUploads >= 0, 'modelos / workers / cuota');
    eq(rep.errors, [], 'errores');
    const md = REP.renderReportMarkdown(rep);
    for (const s of ['SINTÉTICO', 'runKind: synthetic', '## Decisiones pedagógicas', '## Componentes no verificados', '## Dependencias externas']) assert(md.includes(s), `Markdown sin «${s}»`);
    // Un informe que dice synthetic sin el flag no pasa el esquema.
    assert(REP.validateReport({ ...rep, synthetic: false }).length > 0, 'el esquema debía exigir synthetic:true');
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, 'offline-driver-report.json'), JSON.stringify(rep, null, 1));
    fs.writeFileSync(path.join(OUT, 'offline-driver-report.md'), md);
  });

  await check('OD8 marca sintética en el .mbz: «[SINTÉTICO]» + sufijo QA en el nombre, cursia-synthetic.json (deliverable:false), validateMbzV3 limpio, videos de vista previa omitidos', async () => {
    const B = require(path.join(DIST, 'package/dynamic-mbz-builder-v3.js'));
    const mk = await D.readSyntheticMarker(pkgA.package.mbz);
    assert(mk.marker && mk.marker.cursiaSynthetic === true && mk.marker.deliverable === false && mk.marker.runKind === 'synthetic', `marca: ${JSON.stringify(mk.marker)}`);
    assert(mk.fullname && mk.fullname.startsWith(D.SYNTHETIC_TITLE_PREFIX) && mk.fullname.endsWith(B.QA_PREVIEW_COURSE_SUFFIX), `nombre del curso: ${mk.fullname}`);
    eq(pkgA.package.validation, { ok: true, issues: 0 }, 'validateMbzV3');
    eq(pkgA.package.pendingVideos.map((p) => p.itemKey).sort(), prep.manifest.items.filter((i) => i.type === 'video').map((i) => i.key).sort(), 'videos de vista previa omitidos');
    eq(mk.marker.generated, Object.keys(pkgA.items).sort(), 'componentes generados en la marca');
    assert(mk.marker.packageFixtures.length > 0 && mk.marker.packageFixtures.every((k) => !pkgA.items[k]), 'rellenos de empaque en la marca');
    const JSZip = require('jszip');
    const z = await JSZip.loadAsync(pkgA.package.mbz);
    const welcome = Object.keys(z.files).filter((f) => /activities\/label_\d+\/label\.xml$/.test(f));
    let qa = false;
    for (const f of welcome) if (/vista previa/i.test(await z.file(f).async('string'))) { qa = true; break; }
    assert(qa, 'sin aviso QA visible en los labels');
  });

  await check('OD9 nunca escribe en la base ni en Storage (sin pg/typeorm/ArtifactsService/Supabase; SQL y Storage rechazados en tiempo de ejecución)', async () => {
    const src = ['lib/offline-driver.js', 'lib/replay-api.js', 'lib/dry-run-report.js', 'lib/netguard.js'].map((f) => fs.readFileSync(path.join(__dirname, f), 'utf8')).join('\n');
    for (const bad of [/require\(['"]pg['"]\)/, /require\(['"]typeorm['"]\)/, /artifacts\.service/, /supabase/i, /uploadBufferArtifact|putStorageObject/, /SUPABASE_|DATABASE_URL/]) assert(!bad.test(src), `el driver referencia ${bad}`);
    const facade = pkgA._facade();
    let e1 = null;
    try { await facade.dataSource.query('insert into public.artifacts values (1)'); } catch (e) { e1 = e; }
    assert(e1 && /no soportada/.test(e1.message), 'la fachada debía rechazar SQL');
    const st = pkgA._state();
    assert(st.job.frontend_course_id === null && st.ownerId === D.detUuid(`${CFG.courseId}|${pkgA.manifestSha256}|owner`), 'ids sintéticos del run');
    assert([...st.store.byId.values()].every((a) => a.storageBucket === 'synthetic-offline-driver' && a.storagePath.startsWith('synthetic/')), 'artifacts fuera del espacio sintético');
  });

  await check('OD10 registro de afectados: regenerar un content enumera la cascada del producto y sus dependientes', async () => {
    const r = runs.h5p;
    const sel = [`content:${m0c0}`];
    const reg = D.affectedRegistry({ CASC: require(path.join(DIST, 'modules/dynamic-generation/regeneration-cascade.js')) }, r._state().manifest, sel);
    const why = Object.fromEntries(reg.map((x) => [x.key, x.reasons.map((y) => y.reason).sort().join('+')]));
    for (const t of ['experience', 'activity', 'application_activity']) assert(/cascade_regenerate/.test(why[`${t}:${m0c0}`] || ''), `${t} sin cascade_regenerate`);
    for (const t of ['presentation', 'video', 'audiobook_chapter']) assert(/cascade_stale_no_auto/.test(why[`${t}:${m0c0}`] || ''), `${t} sin cascade_stale_no_auto`);
    assert(/cascade_regenerate/.test(why[`exam:${mod0.id}`] || '') && reg.some((x) => x.key.startsWith('final_exam:')), 'exámenes en la cascada');
    assert(!why[sel[0]], 'lo seleccionado no es «afectado»');
    assert(runs.exam.affected.some((x) => x.key.startsWith('final_exam:') && x.reasons.some((y) => y.via === `exam:${mod0.id}`)), 'la corrida del examen reporta el final como afectado');
  });

  console.log(`\n${passed} ok, ${failed} fallos (informe de ejemplo: ${OUT})`);
  process.exit(failed ? 1 : 0);
})();
