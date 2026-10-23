#!/usr/bin/env node
/* eslint-disable */
// Prebrief pedagógico · exporta respuestas REALES de GET /courses/:id/prebrief (armadas con los módulos compilados y los
// fixtures sintéticos) para el harness del frontend (test-59-v2-prebrief.mjs). USD 0, sin red ni DB.
// Uso: node scripts/export-prebrief-fixture.js <frontend>/src/js/__harness__/fixtures/prebrief-state-v1.json [dist]
'use strict';
const fs = require('fs');
const path = require('path');
const REPO = path.resolve(__dirname, '..');
const DIST = path.resolve(process.argv[3] || path.join(REPO, 'dist'));
const D = (rel) => require(path.join(DIST, rel));
const M = D('modules/prebrief/prebrief-model.js');
const DOC = D('modules/prebrief/prebrief-document.js');
const RD = D('modules/prebrief/prebrief-readiness.js');
const PL = D('modules/prebrief/plausibility.js');
const RA = D('modules/academic-context/requirements/requirement-authority.js');
const { fixture } = require(path.join(REPO, 'scripts/fixtures/prebrief-fixtures.js'));

const out = process.argv[2];
if (!out) { console.error('uso: export-prebrief-fixture.js <salida.json> [dist]'); process.exit(1); }
const build = (o) => { const inp = fixture(o); const m = M.buildPrebriefModel(inp, RA.actualText, RA.requirementText); return { inp, m }; };
function draftOf(o, extraDoubt) {
  const { inp, m } = build(o);
  const doubts = extraDoubt ? [{ kind: 'outcome', id: 'RA1', text: 'INSTRUCCIÓN: Tomar ejemplos del sector productivo de la región.', reason: 'template', confirmKey: PL.confirmKeyOf('outcome', 'INSTRUCCIÓN: Tomar ejemplos del sector productivo de la región.') }] : [];
  const doc = DOC.buildPrebriefDocument(m);
  const sha = M.prebriefModelSha(m);
  return {
    model: m, modelSha256: sha, document: doc, documentSha256: DOC.documentSha(doc),
    readiness: RD.prebriefReadiness(m, inp.card, doubts, []), verification: { criticals: 0, warnings: 0 },
    stateTexts: DOC.approvalStateTexts({ status: 'draft', version: null, date: null, fingerprint: sha, approval: null }),
    matchesLatest: false, diffFromLatest: [],
  };
}
const R = 'La institución prioriza una duración menor para el piloto.';
const draftBlocked = draftOf({ format: 'M', doc4x5: true }, true);
const draftReady = draftOf({ format: 'M', doc4x5: true, reason: R });
const at = '2026-10-12T15:00:00.000Z';
const approval = { name: 'María Gómez', role: 'Coordinadora académica', at: '2026-10-13T15:42:00.000Z', email: 'docente@demo.test' };
const version = (n, status, d, extra = {}) => {
  const meta = { status, version: n, date: at, fingerprint: d.modelSha256, approval: status === 'approved' ? approval : null };
  return {
    version: n, status, modelSha256: d.modelSha256, preparedAt: at, preparedByEmail: 'docente@demo.test',
    approval: status === 'approved' ? approval : null, changesRequest: status === 'changes_requested' ? { note: 'Más actividades prácticas en el módulo 2.', at } : null,
    invalidatedAt: null, invalidationReason: null, invalidationDiff: [], blueprintNumber: n, runs: [],
    model: d.model, document: d.document, documentSha256: d.documentSha256, stateTexts: DOC.approvalStateTexts(meta), ...extra,
  };
};
const summary = (v) => { const { model, document, documentSha256, stateTexts, ...s } = v; return s; };
const ready = version(1, 'ready', draftReady);
const approved = version(1, 'approved', draftReady);
const changes = version(1, 'changes_requested', draftReady);
const invalid = { ...summary(approved), status: 'invalidated', invalidatedAt: '2026-10-14T10:00:00.000Z', invalidationReason: 'design_changed', invalidationDiff: ['Horas: 42 h → 44 h', 'Datos del curso para producir: tono'] };
const state = (status, draft, current, versions) => ({ prebriefVersion: 1, approvalFlow: true, status, draft: { ...draft, matchesLatest: !!current }, current, versions, format: { code: 'M', catalogVersion: 1, at, by: 'docente@demo.test' } });
const fx = {
  exportedBy: 'orbia-backend scripts/export-prebrief-fixture.js',
  draftBlocked: state('draft', draftBlocked, null, []),
  draftReady: state('draft', draftReady, null, []),
  ready: state('ready', draftReady, ready, [summary(ready)]),
  changesRequested: state('changes_requested', draftReady, changes, [summary(changes)]),
  approved: state('approved', draftReady, approved, [summary(approved)]),
  invalidated: state('draft', draftReady, null, [invalid]),
  legacy: { ...state('draft', draftReady, null, []), approvalFlow: false },
  formatCatalog: D('modules/prebrief/course-formats.js').COURSE_FORMAT_CODES.map((c) => D('modules/prebrief/course-formats.js').COURSE_FORMATS[c]),
};
fs.writeFileSync(out, JSON.stringify(fx) + '\n');
console.log(`✅ ${out} (${Math.round(fs.statSync(out).size / 1024)} KB)`);
