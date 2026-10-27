// r78-ready · compatibilidad de producción del árbol de release (r74+r75+r76+r77) con la config planeada para prod:
// flags r75 en off (ausentes), SIN migraciones r75 (EXCLUDED), PG descartable con el esquema V2 de prod, Supabase falso.
// Extiende el smoke r75 (19/0) con las rutas que tocan presupuestos/runs (reanudar, reintentar), r76 (diseño visual)
// y r74 (medios duraderos) para detectar 42P01/42703 por tablas r75 ausentes.
'use strict';
const path = require('path');
const env = require(process.env.REPO + '/test/r75/lib/env');
const { startFakeSupabase } = require(process.env.REPO + '/test/r75/lib/fake-supabase');
const { keepTeacherDesign } = require(path.join(process.env.REPO, 'test', 'e2e-v2', 'design-approval.js'));
const crypto = require('crypto');
let ok = 0, fail = 0;
const check = (name, cond, detail) => { if (cond) { ok++; console.log('✅ ' + name); } else { fail++; console.log('❌ ' + name + ' → ' + detail); } };
const brief = (r) => `${r.status} ${r.code || ''} ${String(r.error || '').slice(0, 220)}`;
(async () => {
  await env.dbConnect();
  for (const t of ['institution_memberships', 'user_budgets', 'budget_reservations', 'budget_requests', 'admin_audit_log', 'user_suspensions', 'platform_controls'])
    check(`sin tabla r75 ${t} (como prod)`, !(await env.tableExists(t)), 'existe');
  const fakes = await startFakeSupabase({ serviceKey: env.SERVICE_KEY });
  const U1 = { id: crypto.randomUUID(), email: 'owner1@x.test' }, U2 = { id: crypto.randomUUID(), email: 'owner2@x.test' };
  for (const u of [U1, U2]) await env.q(`insert into public.authorized_users (email, is_admin) values ($1, false)`, [u.email]).catch(() => {});
  const strip = { CURSIA_ACCOUNT_GUARD: '', CURSIA_RBAC_MODE: '', CURSIA_USER_BUDGETS: '' };
  let refused = false;
  try { await env.startApp(fakes, Object.assign({}, strip, { ALLOW_UNOWNED_COURSES: 'true' }), 'app-unowned'); await env.stopApp(); } catch (e) { refused = /terminó al arrancar/.test(e.message); }
  check('D-26: ALLOW_UNOWNED_COURSES=true en NODE_ENV=production → no arranca', refused, 'arrancó');
  await env.startApp(fakes, Object.assign({}, strip, { PUBLIC_MEDIA_BASE_URL: '', DYNAMIC_V2_ALLOWED_OWNERS: U1.id, DYNAMIC_ALLOW_VIDEO_PREVIEW: 'true' }), 'app-flags-off');
  const T1 = env.tokenFor(U1), T2 = env.tokenFor(U2);
  const A = (m, p, b, tok = T1) => env.api(m, p, { token: tok, body: b });
  check('/health 200', (await env.api('GET', '/health')).status === 200, '');
  check('/features 200', (await A('GET', '/features')).status === 200, '');
  // V1 / legacy
  const c = await A('POST', '/courses', { title: 'Curso legacy' }); check('POST /courses 201 (legacy V1)', c.status === 201, brief(c));
  const id = c.data && c.data.id;
  const l = await A('GET', '/courses'); check('GET /courses 200 y lista el propio', l.status === 200 && Array.isArray(l.data) && l.data.some((x) => x.id === id), l.status);
  check('GET /courses/:id dueño 200', (await A('GET', '/courses/' + id)).status === 200, '');
  check('PATCH /courses/:id dueño 200', (await A('PATCH', '/courses/' + id, { description: 'x' })).status === 200, '');
  check('otro usuario → 404', (await A('GET', '/courses/' + id, undefined, T2)).status === 404, '');
  check('GET /artifacts 200', (await A('GET', '/artifacts')).status === 200, '');
  check('GET /jobs 200', (await A('GET', '/jobs')).status === 200, '');
  const m = await A('GET', '/me/context'); check('GET /me/context no 500', m.status !== 500, brief(m));
  // V2: curso con Manifest
  let gc = null;
  try {
    const dc = await A('POST', '/courses/dynamic', { frontendCourseId: crypto.randomUUID(), title: 'r78 prodcompat' });
    if (dc.status !== 201) throw new Error('POST /courses/dynamic ' + brief(dc));
    const cid = Number(dc.data.id);
    let st = (await A('GET', `/courses/${cid}/modules`)).data;
    if (!st.modules.length) { const mm = await A('POST', `/courses/${cid}/modules`, { title: 'Módulo', objective: 'Objetivo', examEnabled: false, expectedCounter: st.structureVersionCounter }); if (mm.status !== 201) throw new Error('module ' + brief(mm)); }
    await keepTeacherDesign(async (mt, p, b) => { const r = await A(mt, p, b); return { status: r.status, data: r.data, error: r.error }; }, cid, 'r78');
    st = (await A('GET', `/courses/${cid}/modules`)).data;
    const lock = await A('POST', `/courses/${cid}/blueprints`, { expectedCounter: st.structureVersionCounter });
    if (lock.status !== 201 && lock.status !== 200) throw new Error('blueprints ' + brief(lock));
    const n = lock.data.blueprint.blueprintNumber;
    const man = await A('POST', `/courses/${cid}/blueprints/${n}/manifest`);
    if (man.status !== 201 && man.status !== 200) throw new Error('manifest ' + brief(man));
    gc = { id: cid, n };
  } catch (e) { check('curso V2 con Manifest armado', false, e.message); }
  if (gc) {
    check('curso V2 con Manifest armado', true, '');
    const DESIGN = { themeFamily: 'institucional', mode: 'light', brandSeed: { accent: '#7A1F5C', moduleColors: ['#7A1F5C', '#0F766E', '#B45309'] }, themeVersion: 1, typography: 'serif' };
    const vd = await A('GET', `/courses/${gc.id}/visual-design`); check('r76 GET visual-design 200 (curso sin perfil visual)', vd.status === 200, brief(vd));
    const vp = await A('POST', `/courses/${gc.id}/visual-design/preview`, { data: DESIGN, includePackage: true }); check('r76 POST visual-design/preview 200/201', vp.status === 200 || vp.status === 201, brief(vp));
    const sv = await A('POST', `/courses/${gc.id}/profiles/presentation`, { data: DESIGN });
    check('r76 guardar diseño (perfil de presentación) 200/201', sv.status === 200 || sv.status === 201, brief(sv));
    const rd = await A('GET', `/courses/${gc.id}/profiles/presentation`);
    check('r76 diseño sobrevive la relectura (familia + tipografía)', rd.status === 200 && JSON.stringify(rd.data).includes('institucional') && JSON.stringify(rd.data).includes('serif'), brief(rd));
    const pv = await A('POST', `/courses/${gc.id}/blueprints/${gc.n}/manifest/runs/estimate-preview`, { videoMode: 'mock' });
    check('estimate-preview sin 500', pv.status !== 500, brief(pv));
    const D = { nombre: 'r78 prodcompat', sector: 'Educación', pais: 'Colombia', ciudad: 'Bogotá', contexto: 'Estudiantes', nivel: 'Básico', tono: 'cercano', obj: 'Aprender', comp: 'Comprende', videoMode: 'mock' };
    const base = `/courses/${gc.id}/blueprints/${gc.n}/manifest/runs`;
    const st = await A('POST', base, D);
    check('arrancar run (dueño, flags off, sin r75): 201/200', st.status === 201 || st.status === 200, brief(st));
    const runId = st.data && (st.data.id || st.data.runId || (st.data.run && st.data.run.id));
    if (runId) {
      const pz = await A('POST', `${base}/${runId}/pause`, {}); check('pausar run 200/201', pz.status === 200 || pz.status === 201, brief(pz));
      const rs = await A('POST', `${base}/${runId}/resume`, {}); check('reanudar run pausado sin tablas r75 (payerOfRun): 200/201', rs.status === 200 || rs.status === 201, brief(rs));
      const [it] = await env.q(`select id, item_key from public.generation_item_runs where job_id = $1 order by id limit 1`, [runId]).catch(() => [null]);
      if (it) {
        await env.q(`update public.generation_item_runs set status = 'failed' where id = $1`, [it.id]).catch(() => {});
        const ri = await A('POST', `${base}/${runId}/items/${encodeURIComponent(it.item_key)}/retry`, {});
        check('reintentar parte fallida sin tablas r75: no 500', ri.status !== 500, brief(ri));
      }
    }
  }
  const md = await env.api('GET', '/media/' + crypto.randomUUID() + '/audiobook-m1/x.mp3');
  check('r74 /media/* sin PUBLIC_MEDIA_BASE_URL: 404, no 500', md.status !== 500, brief(md));
  await env.stopApp();
  const log = require('fs').readFileSync(env.OUT + '/app-flags-off.log', 'utf8');
  check('log de la app sin errores de esquema (42P01/42703)', !/42P01|42703|relation .* does not exist/.test(log), (log.match(/.*(42P01|42703|does not exist).*/) || [''])[0].slice(0, 300));
  console.log(`\n${ok} ok, ${fail} fail`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
