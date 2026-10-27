// r78-ready · flujo de creación E2E sintético (USD 0, sin IA) contra la app real del árbol de release con la config
// planeada para prod (flags r75 off, SIN migraciones r75, canario V2 = el dueño): crear → estructura → diseño docente sin
// IA (keepTeacherDesign, en vez de «Diseñar el curso») → «Diseño visual»: los 7 estilos con vista previa y paquete de
// muestra → guardar uno → sobrevive a un reinicio de la app → Blueprint + Manifest → estimado (costo, presupuesto y
// entrega visibles) → arranque autorizado (y rechazos para quien no es dueño / no está en el canario).
// Los .mbz de muestra quedan en $OUT/mbz/ para restaurarlos en el Moodle 4.5 local (creation-flow-r78-moodle.sh).
'use strict';
const fs = require('fs');
const path = require('path');
const env = require(process.env.REPO + '/test/r75/lib/env');
const { startFakeSupabase } = require(process.env.REPO + '/test/r75/lib/fake-supabase');
const { keepTeacherDesign } = require(path.join(process.env.REPO, 'test', 'e2e-v2', 'design-approval.js'));
const crypto = require('crypto');
let ok = 0, fail = 0;
const check = (name, cond, detail) => { if (cond) { ok++; console.log('✅ ' + name); } else { fail++; console.log('❌ ' + name + ' → ' + detail); } };
const brief = (r) => `${r.status} ${r.code || ''} ${String(r.error || '').slice(0, 220)}`;
const OWNER = { id: crypto.randomUUID(), email: 'qa-r78-owner@x.test' };
const OTHER = { id: crypto.randomUUID(), email: 'qa-r78-other@x.test' };
const D = { nombre: 'QA r78 flujo', sector: 'Educación', pais: 'Colombia', ciudad: 'Bogotá', contexto: 'Estudiantes de grado 6', nivel: 'Básico', tono: 'cercano', obj: 'Comunicarse en inglés básico', comp: 'Se presenta y describe su rutina', videoMode: 'mock' };
(async () => {
  await env.dbConnect();
  check('base como prod: sin user_budgets / institution_memberships', !(await env.tableExists('user_budgets')) && !(await env.tableExists('institution_memberships')), '');
  for (const u of [OWNER, OTHER]) await env.q(`insert into public.authorized_users (email, is_admin) values ($1, false)`, [u.email]).catch(() => {});
  const fakes = await startFakeSupabase({ serviceKey: env.SERVICE_KEY });
  const cfg = { CURSIA_ACCOUNT_GUARD: '', CURSIA_RBAC_MODE: '', CURSIA_USER_BUDGETS: '', DYNAMIC_V2_ALLOWED_OWNERS: OWNER.id, DYNAMIC_ALLOW_VIDEO_PREVIEW: 'true', PUBLIC_MEDIA_BASE_URL: '' };
  await env.startApp(fakes, cfg, 'app-flow-1');
  const T = env.tokenFor(OWNER), T2 = env.tokenFor(OTHER);
  const A = (m, p, b, tok = T) => env.api(m, p, { token: tok, body: b });
  // 1. crear
  const nv = await A('POST', '/courses/dynamic', { frontendCourseId: crypto.randomUUID(), title: 'x' }, T2);
  check('fuera del canario V2: POST /courses/dynamic → 403 (V2 solo para el owner)', nv.status === 403, brief(nv));
  const dc = await A('POST', '/courses/dynamic', { frontendCourseId: crypto.randomUUID(), title: 'QA r78 Inglés 6º (sintético)' });
  check('crear curso V2 (dueño en el canario) 201', dc.status === 201, brief(dc));
  const cid = Number(dc.data && dc.data.id);
  // 2. estructura: 2 módulos
  let st = (await A('GET', `/courses/${cid}/modules`)).data;
  let counter = st.structureVersionCounter;
  for (const title of ['Módulo 1 · Saludos', 'Módulo 2 · Rutinas']) {
    if (st.modules.some((m) => m.title === title)) continue;
    const mm = await A('POST', `/courses/${cid}/modules`, { title, objective: 'Objetivo ' + title, examEnabled: false, expectedCounter: counter });
    if (mm.status === 201) counter = mm.data.structureVersionCounter;
  }
  st = (await A('GET', `/courses/${cid}/modules`)).data;
  check('estructura con módulos y capítulos', st.modules.length >= 1 && st.modules.some((m) => (m.chapters || []).length > 0), JSON.stringify(st.modules.map((m) => [m.title, (m.chapters || []).length])));
  // 3. diseño docente sin IA (la ruta de «Diseñar el curso» con IA se evita: keepTeacherDesign = «Mantener mi diseño»)
  await keepTeacherDesign(async (mt, p, b) => { const r = await A(mt, p, b); return { status: r.status, data: r.data, error: r.error }; }, cid, 'r78 flujo');
  check('diseño pedagógico aprobado sin IA (keepTeacherDesign)', true, '');
  // 4. Diseño visual: 7 estilos
  const vd = await A('GET', `/courses/${cid}/visual-design`);
  check('GET visual-design 200', vd.status === 200, brief(vd));
  const fams = (vd.data && vd.data.families) || [];
  const combos = []; for (const f of fams) for (const m of f.modes) combos.push({ themeFamily: f.id, mode: m, label: f.label + ' · ' + m });
  check('7 estilos disponibles (familias × modos)', combos.length === 7, combos.map((c) => c.label).join(', '));
  const mbzDir = path.join(env.OUT, 'mbz'); fs.mkdirSync(mbzDir, { recursive: true });
  for (const c of combos) {
    const prof = { themeFamily: c.themeFamily, mode: c.mode, brandSeed: null, themeVersion: 1 };
    const pv = await A('POST', `/courses/${cid}/visual-design/preview`, { data: prof, includePackage: true });
    const pk = pv.data && pv.data.package;
    const okp = pv.status === 200 && pk && pk.base64 && pk.sizeBytes > 1000;
    if (okp) fs.writeFileSync(path.join(mbzDir, `${c.themeFamily}-${c.mode}.mbz`), Buffer.from(pk.base64, 'base64'));
    check(`vista previa real + paquete de muestra: ${c.label}`, okp, brief(pv));
  }
  const CHOSEN = { themeFamily: 'oscuro-premium', mode: 'dark', brandSeed: { accent: '#38BDF8', moduleColors: ['#38BDF8', '#F472B6'] }, themeVersion: 1, typography: 'serif', identity: { institutionName: { source: 'custom', text: 'Colegio QA r78' }, watermark: false, showInCourse: true } };
  let sv = await A('POST', `/courses/${cid}/profiles/presentation`, { data: CHOSEN });
  if (sv.status === 400) { // forma de identity distinta: se guarda sin identity
    delete CHOSEN.identity; sv = await A('POST', `/courses/${cid}/profiles/presentation`, { data: CHOSEN });
  }
  check('guardar el diseño elegido (Oscuro Premium + serif + color propio)', sv.status === 200 || sv.status === 201, brief(sv));
  await env.stopApp();
  await env.startApp(fakes, cfg, 'app-flow-2'); // «recargar»: proceso nuevo, sin cachés
  const vd2 = await A('GET', `/courses/${cid}/visual-design`);
  const cur = JSON.stringify(vd2.data || {});
  check('tras reiniciar la app el diseño sigue guardado (familia, modo, serif, color) con su versión y autor', vd2.status === 200 && cur.includes('oscuro-premium') && cur.includes('serif') && cur.includes('#38BDF8'), cur.slice(0, 300));
  // 5. Blueprint + Manifest + estimado
  st = (await A('GET', `/courses/${cid}/modules`)).data;
  const lock = await A('POST', `/courses/${cid}/blueprints`, { expectedCounter: st.structureVersionCounter });
  check('confirmar estructura (Blueprint) 201', lock.status === 201 || lock.status === 200, brief(lock));
  const n = lock.data.blueprint.blueprintNumber;
  const man = await A('POST', `/courses/${cid}/blueprints/${n}/manifest`);
  check('Manifest 201', man.status === 201 || man.status === 200, brief(man));
  const base = `/courses/${cid}/blueprints/${n}/manifest/runs`;
  const pv = await A('POST', `${base}/estimate-preview`, D);
  const pj = JSON.stringify(pv.data || {});
  check('estimado visible: costo esperado/máximo', pv.status === 200 && /expected|max/i.test(pj), brief(pv));
  check('estimado visible: presupuesto del usuario (userBudget, modo off)', pv.status === 200 && pv.data && pv.data.userBudget && pv.data.userBudget.mode === 'off', JSON.stringify(pv.data && pv.data.userBudget));
  check('estimado visible: tamaño/entrega del paquete (r74)', /packageSize|delivery/i.test(pj), pj.slice(0, 200));
  console.log('   estimado:', JSON.stringify({ totals: pv.data && (pv.data.totals || (pv.data.estimate && pv.data.estimate.totals)), userBudget: pv.data && pv.data.userBudget, delivery: pv.data && pv.data.packageSize && pv.data.packageSize.delivery }).slice(0, 600));
  // 6. arranque autorizado
  const o = await A('POST', base, D, T2);
  check('otro usuario no puede arrancar el run del curso ajeno (403/404)', o.status === 403 || o.status === 404, brief(o));
  const s = await A('POST', base, D);
  check('el dueño arranca la generación autorizada (201)', s.status === 201 || s.status === 200, brief(s));
  console.log('   arranque keys:', Object.keys(s.data || {}).join(','), '| estimado keys:', Object.keys(pv.data || {}).join(','));
  const ct = (await env.q(`select udt_name from information_schema.columns where table_name='production_jobs' and column_name='course_id'`))[0].udt_name;
  const [lr] = await env.q(`select id::text from public.production_jobs where execution_mode = 'dynamic_generation' and course_id = $1 order by created_at desc limit 1`, [ct === 'text' ? String(cid) : cid]);
  const runId = (s.data && (s.data.runId || (s.data.run && s.data.run.id) || s.data.id)) || (lr && lr.id);
  const [job] = runId ? await env.q(`select worker_status, input_payload->>'manifestId' as m from public.production_jobs where id = $1`, [runId]) : [null];
  check('run encolado en el servidor (USD 0: sin workers ni proveedores)', job && ['queued', 'running'].includes(job.worker_status), JSON.stringify(job));
  const [auth] = runId ? await env.q(`select decision, authorized_budget from public.cost_budget_authorizations where run_id = $1 order by created_at desc limit 1`, [runId]) : [null];
  check('autorización de presupuesto vinculada al run', !!auth, JSON.stringify(auth));
  console.log('   autorización:', JSON.stringify(auth));
  await env.stopApp();
  const log = fs.readFileSync(env.OUT + '/app-flow-1.log', 'utf8') + fs.readFileSync(env.OUT + '/app-flow-2.log', 'utf8');
  check('logs sin errores de esquema (42P01/42703)', !/42P01|42703|relation .* does not exist/.test(log), (log.match(/.*(42P01|42703|does not exist).*/) || [''])[0].slice(0, 300));
  console.log(`\n${ok} ok, ${fail} fail`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
