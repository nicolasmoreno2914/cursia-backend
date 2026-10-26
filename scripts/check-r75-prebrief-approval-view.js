#!/usr/bin/env node
/* r75 Fase 2 — regresiones encontradas en staging con cuentas QA reales:
 *  R75-E16: GET …/prebrief/versions/:n/pdf SIN ?variant sobre una versión aprobada resolvía a «approved» y se lo
 *           entregaba a CONSULTA (sin exports.download). El permiso se decide sobre la variante RESUELTA.
 *  R75-E17: la vista de la versión (current/versions) exponía solo nombre/cargo de la aprobación; 02 §E.2 pide también
 *           userId (quien aprobó) y selfApproved.
 * Puro (dist/), sin base: el servicio con dobles mínimos.  node scripts/check-r75-prebrief-approval-view.js */
'use strict';
const path = require('path');
const { PrebriefService } = require(path.join(__dirname, '..', 'dist/modules/prebrief/prebrief.service.js'));
let ok = 0, bad = 0;
async function check(name, fn) { try { await fn(); ok++; console.log('✅ ' + name); } catch (e) { bad++; console.log('❌ ' + name + '\n   ' + (e && e.stack ? e.stack.split('\n').slice(0, 2).join('\n   ') : e)); } }
const assert = (c, m) => { if (!c) throw new Error(m); };
const approval = { name: 'QA Aprobador', role: 'Coordinación', at: '2026-10-26T12:00:00.000Z', email: 'qa-r75-aprobador-a@example.com', userId: '1706ff10-1157-4fa5-9e11-6e42bc9b1133', selfApproved: false };
function svc(status) {
  const s = Object.create(PrebriefService.prototype);
  s.loadCourse = async () => ({});
  s.versions = async () => [{ id: 'v1', version: 1, status, approval: status === 'approved' ? approval : null, model_json: { course: { title: 'QA r75' } }, document_json: {} }];
  s.dataSource = { query: async () => [{ bytes: Buffer.from('%PDF-qa') }] };
  s.storePdf = async () => {};
  return s;
}
(async () => {
  await check('R75-E16: versión aprobada SIN ?variant y sin exports.download → 403 permission_denied', async () => {
    let err = null;
    try { await svc('approved').versionPdf(1, 'o', 1, '', false); } catch (e) { err = e; }
    assert(err && err.getStatus && err.getStatus() === 403, 'esperaba 403, vino ' + (err && err.message));
    assert(err.getResponse().code === 'permission_denied' && err.getResponse().permission === 'exports.download', JSON.stringify(err.getResponse()));
  });
  await check('R75-E16: ?variant=approved sin permiso → 403; variante inválida → 403 (resuelve a approved)', async () => {
    for (const v of ['approved', 'cualquiera']) { let e = null; try { await svc('approved').versionPdf(1, 'o', 1, v, false); } catch (x) { e = x; } assert(e && e.getStatus() === 403, v); }
  });
  await check('R75-E16: ?variant=ready de una versión aprobada sigue permitido con courses.view (no es el entregable)', async () => {
    const r = await svc('approved').versionPdf(1, 'o', 1, 'ready', false); assert(/para-aprobacion/.test(r.filename), r.filename);
  });
  await check('R75-E16: con exports.download (o SA/legacy) el aprobado se entrega', async () => {
    const r = await svc('approved').versionPdf(1, 'o', 1, '', true); assert(/aprobado/.test(r.filename), r.filename);
  });
  await check('R75-E16: versión ready sin ?variant y sin permiso → se entrega el «para aprobación»', async () => {
    const r = await svc('ready').versionPdf(1, 'o', 1, '', false); assert(/para-aprobacion/.test(r.filename), r.filename);
  });
  await check('R75-E17: la vista de la versión expone approval.userId y selfApproved (02 §E.2)', async () => {
    const s = svc('approved');
    const v = (await s.versions())[0];
    const out = s.versionSummary(Object.assign({}, v, { model_sha256: 'x', prepared_at: null, prepared_by_email: null, changes_request: null, invalidated_at: null, invalidation_reason: null, invalidation_diff: [], blueprint_number: 1 }), []);
    assert(out.approval.userId === approval.userId && out.approval.selfApproved === false, JSON.stringify(out.approval));
    assert(out.approval.name === approval.name && out.approval.role === approval.role, 'conserva nombre/cargo');
  });
  console.log(`\n${ok} OK, ${bad} fallas`);
  process.exit(bad ? 1 : 0);
})();
