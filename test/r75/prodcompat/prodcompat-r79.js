// r79.2 · compatibilidad de producción del árbol de release r79 + r79.1 con la config planeada
// para prod: esquema V2 de prod + r75-access + r75-budgets (aplicadas en Orbia el 2026-10-27) y SIN la migración r79.1
// (course_chapters.application_kind) salvo R79_WITH_MIGRATION=1; flags r75 como en prod (guard/RBAC off, budgets shadow);
// V2 owner-only (DYNAMIC_V2_ALLOWED_OWNERS = U1). Corre dos veces: DYNAMIC_BUDGET_FIT ausente y =true (R79_FLAG).
// Destino final sugerido: test/r75/prodcompat/prodcompat-r79.js (mismo patrón que prodcompat-r78.js).
// Detecta: 500 / 42703 / 42P01 por la columna ausente, fugas del ajuste a un no-owner, y que un diseño con tipos NUNCA
// se aplique en silencio sin la columna (503 schema_not_migrated_application_kind).
'use strict';
const path = require('path');
const crypto = require('crypto');
const env = require(process.env.REPO + '/test/r75/lib/env');
const { startFakeSupabase } = require(process.env.REPO + '/test/r75/lib/fake-supabase');
let ok = 0, fail = 0;
const check = (name, cond, detail) => { if (cond) { ok++; console.log('✅ ' + name); } else { fail++; console.log('❌ ' + name + ' → ' + detail); } };
const brief = (r) => `${r.status} ${r.code || (r.data && r.data.code) || ''} ${String(r.error || '').slice(0, 220)}`;
const FLAG = process.env.R79_FLAG === 'on';
const WITH_MIG = process.env.R79_WITH_MIGRATION === '1';
const LABEL = `app-r79-flag-${FLAG ? 'on' : 'off'}${WITH_MIG ? '-mig' : ''}`;

(async () => {
  await env.dbConnect();
  // ── Esquema = prod ────────────────────────────────────────────────────
  check(WITH_MIG ? 'con la migración r79.1: course_chapters.application_kind existe' : 'sin la migración r79.1 (como prod hoy): course_chapters.application_kind NO existe',
    (await env.columnExists('course_chapters', 'application_kind')) === WITH_MIG, 'no coincide');
  check('course_chapters.application_minutes existe (prerrequisito)', await env.columnExists('course_chapters', 'application_minutes'), 'falta');
  for (const t of ['institution_memberships', 'user_budgets']) check(`r75 presente como en prod: ${t}`, await env.tableExists(t), 'falta');

  const fakes = await startFakeSupabase({ serviceKey: env.SERVICE_KEY });
  const U1 = { id: crypto.randomUUID(), email: 'owner-r79@x.test' }; // el owner (allow-list V2)
  const U2 = { id: crypto.randomUUID(), email: 'otro-r79@x.test' };  // usuario de prod que NO está en la allow-list
  const SA = { id: U1.id, email: U1.email };                         // en prod el owner es también el SuperAdmin
  for (const u of [U1, U2]) await env.q(`insert into public.authorized_users (email, is_admin) values ($1, $2)`, [u.email, u === U1]).catch(() => {});
  const prodLike = {
    CURSIA_ACCOUNT_GUARD: 'off', CURSIA_RBAC_MODE: 'off', CURSIA_USER_BUDGETS: 'shadow', PUBLIC_MEDIA_BASE_URL: '',
    DYNAMIC_V2_ALLOWED_OWNERS: U1.id, DYNAMIC_V2_GENERAL_AVAILABILITY: 'false', DYNAMIC_ALLOW_VIDEO_PREVIEW: 'true',
    // Mismos valores que el .env de prod (los informa 10-precheck): ajustar si difieren.
    DYNAMIC_MANIFEST_RULES_VERSION: process.env.R79_RULES_VERSION || '3', DYNAMIC_ACTIVITY_TYPE_RULES: process.env.R79_ACTIVITY_TYPE_RULES || '2',
    SUPER_ADMIN_EMAILS: SA.email, SUPER_ADMIN_USER_IDS: SA.id,
    DYNAMIC_BUDGET_FIT: FLAG ? 'true' : '',
    // Prod tiene el worker de proveedores (Gamma/TTS) desplegado; aquí NO corre ningún worker (el run queda en cola, sin
    // llamadas: netguard y sin claves). Sin la marca, arrancar responde 501 PROVIDER_WORKER_NOT_DEPLOYED.
    DYNAMIC_PROVIDER_WORKER_ENABLED: 'true',
  };
  await env.startApp(fakes, prodLike, LABEL);
  const T1 = env.tokenFor(U1), T2 = env.tokenFor(U2);
  const A = (m, p, b, tok = T1) => env.api(m, p, { token: tok, body: b });
  check('/health 200', (await env.api('GET', '/health')).status === 200, '');

  // ── /features: el ajuste solo para el owner ───────────────────────────
  const f1 = await A('GET', '/features'), f2 = await A('GET', '/features', undefined, T2);
  check('/features owner 200', f1.status === 200, brief(f1));
  check(`/features owner: budgetFit ${FLAG ? '=true' : 'ausente'}`, FLAG ? f1.data && f1.data.budgetFit === true : f1.data && f1.data.budgetFit === undefined, JSON.stringify(f1.data));
  check('/features no-owner: sin V2 y SIN budgetFit (aunque el flag esté encendido)', f2.status === 200 && f2.data.dynamicCourseStructure === false && f2.data.budgetFit === undefined, JSON.stringify(f2.data));
  const nv = await A('POST', '/courses/dynamic', { frontendCourseId: crypto.randomUUID(), title: 'no-owner' }, T2);
  check('no-owner no puede crear un curso dynamic (403/404)', nv.status === 403 || nv.status === 404, brief(nv));

  // ── Curso V2 del owner (6 módulos × 1 capítulo, 60 h) ─────────────────
  let cid = null;
  try {
    const dc = await A('POST', '/courses/dynamic', { frontendCourseId: crypto.randomUUID(), title: 'r79 prodcompat (sintético)' });
    if (dc.status !== 201) throw new Error('POST /courses/dynamic ' + brief(dc));
    cid = Number(dc.data.id);
    const TOPICS = ['Peligros', 'Riesgos', 'Controles', 'Protección', 'Incidentes', 'Emergencias'];
    let st = (await A('GET', `/courses/${cid}/modules`)).data;
    for (const t of TOPICS) {
      const mm = await A('POST', `/courses/${cid}/modules`, { title: t, objective: 'Analizar ' + t.toLowerCase(), examEnabled: true, expectedCounter: st.structureVersionCounter });
      if (mm.status !== 201 && mm.status !== 200) throw new Error('module ' + brief(mm));
      st = (await A('GET', `/courses/${cid}/modules`)).data;
      const mid = st.modules[st.modules.length - 1].id;
      if (!(st.modules[st.modules.length - 1].chapters || []).length) {
        const ch = await A('POST', `/courses/${cid}/modules/${mid}/chapters`, { title: `${t}: caso de análisis en planta`, objective: 'Analizar riesgos y proponer controles', expectedCounter: st.structureVersionCounter });
        if (ch.status !== 201 && ch.status !== 200) throw new Error('chapter ' + brief(ch));
        st = (await A('GET', `/courses/${cid}/modules`)).data;
      }
    }
    const ped = { pedagogyProfileVersion: 1, primaryApproach: 'competencias', secondaryApproaches: [], origin: 'manual', targetHours: 60,
      learner: { description: 'Supervisores de planta', ageGroup: 'adults', educationLevel: 'technical', priorKnowledge: 'basic', experience: 'some' },
      learningOutcomes: { know: ['Los tipos de riesgo'], do: ['Evaluar riesgos de una tarea', 'Proponer controles'], competencies: ['Gestiona la prevención en su área'] },
      learningModes: [], experienceTypes: [], assessmentMethods: [], principles: [] };
    const sp = await A('POST', `/courses/${cid}/profiles/pedagogy`, { data: ped, expectedVersion: 0 });
    if (sp.status !== 201 && sp.status !== 200) throw new Error('perfil pedagógico ' + brief(sp));
    check('curso V2 del owner armado (6 × 1, perfil 60 h)', true, '');
  } catch (e) { check('curso V2 del owner armado', false, e.message); }

  if (cid) {
    const REC = `/courses/${cid}/design/recommendation`;
    const counter = async () => (await A('GET', `/courses/${cid}/modules`)).data.structureVersionCounter;
    // «Usar este diseño» como el FE: si la tarjeta trae un perfil distinto del guardado, se guarda y se recalcula (el
    // servidor recalcula la propuesta con el perfil GUARDADO al aplicar).
    const useCard = async () => {
      let card = (await A('POST', REC, {})).data;
      if (card && card.profileChanged) {
        const cur = await A('GET', `/courses/${cid}/profiles/pedagogy`);
        await A('POST', `/courses/${cid}/profiles/pedagogy`, { data: card.profile, expectedVersion: Number(cur.data.version) });
        card = (await A('POST', REC, {})).data;
      }
      return card;
    };
    // Lecturas (dry-run en memoria: nunca necesitan la columna)
    const r0 = await A('POST', REC, {});
    check('«Cursia recomienda» sin ajuste: 200', r0.status === 200, brief(r0));
    check('respuesta trae preferences.activityKinds = none (r79.1, siempre explícito)', r0.data && r0.data.preferences && r0.data.preferences.activityKinds === 'none', JSON.stringify(r0.data && r0.data.preferences));
    check(`clave budgetFit ${FLAG ? 'presente (null sin presupuesto)' : 'AUSENTE (respuesta de siempre)'}`, FLAG ? Object.prototype.hasOwnProperty.call(r0.data, 'budgetFit') : !Object.prototype.hasOwnProperty.call(r0.data, 'budgetFit'), Object.keys(r0.data || {}).join(','));
    const r90 = await A('POST', REC, { adjust: { productionBudgetUsd: 90 } });
    check('ajuste con presupuesto USD 90: 200 (con el flag apagado se ignora)', r90.status === 200, brief(r90));
    if (FLAG) check('con el flag: budgetFit.status ∈ fits/does_not_fit/impossible y isAuthorizedCap=false',
      r90.data && r90.data.budgetFit && ['fits', 'does_not_fit', 'impossible'].includes(r90.data.budgetFit.status) && r90.data.productionBudget && r90.data.productionBudget.isAuthorizedCap === false, JSON.stringify(r90.data && r90.data.budgetFit && r90.data.budgetFit.status));
    else check('sin el flag: sin productionBudget ni budgetFit', r90.data && r90.data.productionBudget === undefined && r90.data.budgetFit === undefined, '');
    const r35 = await A('POST', REC, { adjust: { productionBudgetUsd: 35 } });
    check('ajuste USD 35 («No cabe»): 200, no 500', r35.status === 200, brief(r35));
    const bad = await A('POST', REC, { adjust: { productionBudgetUsd: 0.5 } });
    check('presupuesto fuera de rango → 400 (no 500)', bad.status === 400, brief(bad));
    const rk = await A('POST', REC, { adjust: { activityKinds: 'auto' } });
    check('«Tipos de actividad: automático» (lectura): 200 aunque falte la columna', rk.status === 200, brief(rk));
    const otro = await A('POST', REC, {}, T2);
    check('no-owner sobre el curso del owner → 404 (no ve el ajuste)', otro.status === 404 || otro.status === 403, brief(otro));

    // Escritura con tipos: sin la columna → 503 visible, nunca 500 ni pérdida silenciosa
    const kinds = rk.data && rk.data.design && (rk.data.design.modules || []).some((m) => (m.chapters || []).some((c) => !!c.applicationKind));
    if (kinds) {
      const c0 = await counter();
      // «Usar este diseño» = guardar el perfil de la tarjeta + aplicar la distribución (como el FE).
      const cur = await A('GET', `/courses/${cid}/profiles/pedagogy`);
      const prof = Object.assign({}, cur.data.profile, { designPreferences: Object.assign({}, cur.data.profile.designPreferences || {}, { activityKinds: 'auto' }) });
      await A('POST', `/courses/${cid}/profiles/pedagogy`, { data: prof, expectedVersion: Number(cur.data.version) });
      const card = await useCard();
      const ap = await A('POST', `/courses/${cid}/modules/apply-distribution`, { expectedCounter: c0, proposalSha256: card.design.proposalSha256 });
      if (WITH_MIG) check('con la migración: aplicar un diseño con tipos → 200/201', ap.status === 200 || ap.status === 201, brief(ap));
      else {
        check('sin la migración: aplicar un diseño con tipos → 503 schema_not_migrated_application_kind (no 500)', ap.status === 503 && /schema_not_migrated_application_kind/.test(JSON.stringify(ap.data || ap.error)), brief(ap));
        check('sin la migración: la estructura no cambió (mismo contador)', (await counter()) === c0, 'cambió');
      }
      // volver a «ninguno» para seguir con el flujo normal
      const cur2 = await A('GET', `/courses/${cid}/profiles/pedagogy`);
      const p2 = JSON.parse(JSON.stringify(cur2.data.profile)); if (p2.designPreferences) delete p2.designPreferences.activityKinds;
      await A('POST', `/courses/${cid}/profiles/pedagogy`, { data: p2, expectedVersion: Number(cur2.data.version) });
    } else console.log('ℹ️  este curso no recibe tipos con «automático» (K1–K3 no aplican): la rama 503 no se ejerció');

    // Flujo normal sin tipos: aplicar → Blueprint → Manifest → plan de empaque → estimación
    const card = await useCard();
    const ap2 = await A('POST', `/courses/${cid}/modules/apply-distribution`, { expectedCounter: await counter(), proposalSha256: card.design.proposalSha256 });
    check('aplicar el diseño de siempre (sin tipos) sin la columna: 200/201', ap2.status === 200 || ap2.status === 201, brief(ap2));
    const st = (await A('GET', `/courses/${cid}/modules`)).data;
    check('GET modules 200 y ningún capítulo informa applicationKind', !!st && (st.modules || []).every((m) => (m.chapters || []).every((c) => c.applicationKind === undefined || c.applicationKind === null)), JSON.stringify(st && st.modules && st.modules[0]));
    const lock = await A('POST', `/courses/${cid}/blueprints`, { expectedCounter: st.structureVersionCounter });
    check('Blueprint (lock-snapshot con to_jsonb ->> application_kind): 200/201', lock.status === 200 || lock.status === 201, brief(lock));
    const n = lock.data && lock.data.blueprint && lock.data.blueprint.blueprintNumber;
    if (n) {
      const man = await A('POST', `/courses/${cid}/blueprints/${n}/manifest`);
      check('Manifest 200/201', man.status === 200 || man.status === 201, brief(man));
      const DESIGN = { themeFamily: 'institucional', mode: 'light', brandSeed: { accent: '#7A1F5C', moduleColors: ['#7A1F5C', '#0F766E', '#B45309'] }, themeVersion: 1, typography: 'serif' };
      const vp = await A('POST', `/courses/${cid}/visual-design/preview`, { data: DESIGN, includePackage: true });
      check('vista previa con paquete (packaging-plan-v3 + builder 3.19.0): 200/201', vp.status === 200 || vp.status === 201, brief(vp));
      const pv = await A('POST', `/courses/${cid}/blueprints/${n}/manifest/runs/estimate-preview`, { videoMode: 'mock' });
      check('estimate-preview sin 500', pv.status !== 500, brief(pv));
      if (pv.status === 200) {
        check('estimate-preview: provisionalPricing (Gamma sin verificar) presente o null, nunca error', pv.data.provisionalPricing === undefined || pv.data.provisionalPricing === null || typeof pv.data.provisionalPricing.gamma === 'boolean', JSON.stringify(pv.data.provisionalPricing));
        check(`estimate-preview: productionBudget ${FLAG ? 'presente' : 'ausente'}`, FLAG ? Object.prototype.hasOwnProperty.call(pv.data, 'productionBudget') : pv.data.productionBudget === undefined, JSON.stringify(pv.data.productionBudget));
      }
      // Claim: el ejecutor viejo (solo application-activity-1) recibe 409 visible si el run tiene Actividades.
      const D = { nombre: 'r79 prodcompat', sector: 'Industria', pais: 'Colombia', ciudad: 'Bogotá', contexto: 'Supervisores', nivel: 'Básico', tono: 'cercano', obj: 'Prevenir', comp: 'Gestiona', videoMode: 'mock' };
      const run = await A('POST', `/courses/${cid}/blueprints/${n}/manifest/runs`, D);
      // Sin claves de proveedores (USD 0, sin red) el arranque se detiene ANTES de crear nada con 409 provider_not_ready: es
      // la respuesta correcta de este entorno (nunca 500). El reclamo con el ejecutor viejo (409 «recarga la página») lo
      // cubre check-r79-1-activity-kinds K16.
      const notReady = run.status === 409 && /provider_not_ready/.test(JSON.stringify(run.data || run.error || ''));
      check('arrancar run (owner): 200/201, o 409 provider_not_ready sin claves de proveedor (nunca 500)', run.status === 200 || run.status === 201 || notReady, brief(run));
      const runId = run.data && (run.data.id || run.data.runId || (run.data.run && run.data.run.id));
      if (runId) {
        // Mismo transporte que el FE: ?features=… (query). Ejecutor viejo = FE de main hoy (sin application-activity-2).
        const old = await env.api('POST', '/dynamic-generation/claim?features=pedagogy-brief-1,application-activity-1,guided-practice-1,video-scenes-1',
          { token: T1, body: { runId, executorId: 'prodcompat-r79-old', types: ['application_activity', 'chapter_text'] } });
        check('claim de un ejecutor viejo (sin application-activity-2): 409 executor_outdated_application o 200 si el run no tiene Actividades; nunca 500', old.status !== 500, brief(old));
        await A('POST', `/courses/${cid}/blueprints/${n}/manifest/runs/${runId}/cancel`, {});
      }
    }
  }

  // ── SuperAdmin › Precios (Gamma): sin migración (pricing_catalog existe desde V2.1) ──
  const g1 = await A('GET', '/finops/pricing/gamma');
  check('GET /finops/pricing/gamma (SA): 200', g1.status === 200, brief(g1));
  const g2 = await A('GET', '/finops/pricing/gamma', undefined, T2);
  check('GET /finops/pricing/gamma (no SA): 403', g2.status === 403, brief(g2));

  await env.stopApp();
  const log = require('fs').readFileSync(path.join(env.OUT, LABEL + '.log'), 'utf8');
  check('log de la app sin errores de esquema (42P01/42703/application_kind does not exist)', !/42P01|42703|column "application_kind" does not exist|relation .* does not exist/.test(log), (log.match(/.*(42P01|42703|does not exist).*/) || [''])[0].slice(0, 300));
  check('log sin BUDGET_FIT_CONFIG', !/BUDGET_FIT_CONFIG/.test(log), 'margen inválido');
  console.log(`\n${ok} ok, ${fail} fail`); process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error(e); try { await env.stopApp(); } catch {} process.exit(2); });
