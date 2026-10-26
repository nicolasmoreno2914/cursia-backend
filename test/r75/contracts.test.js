/* eslint-disable */
// r75 · Agente E — valida que los fixtures de contrato (fixtures/contracts) cumplen 02-contratos-api.md.
//   node test/r75/contracts.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const { ROUTE_SHAPES, S } = require('./lib/contract-shapes');
const t = require('./lib/t');
const DIR = path.join(__dirname, 'fixtures', 'contracts');
const idx = JSON.parse(fs.readFileSync(path.join(DIR, 'index.json'), 'utf8'));
t.item('contratos');
for (const [key, file] of Object.entries(idx.routes)) {
  const fx = JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8'))[key];
  const route = key.split('#')[0];
  const shape = ROUTE_SHAPES[route];
  if (!t.ok(!!shape, `${key}: hay validador de forma`)) continue;
  const errs = [];
  t.ok(fx && fx.body && 'data' in fx.body && typeof fx.body.timestamp === 'string', `${key}: cuerpo {data,timestamp}`);
  shape(fx.body.data, errs);
  t.ok(errs.length === 0, `${key}: forma válida`, errs);
}
const errors = JSON.parse(fs.readFileSync(path.join(DIR, 'errors.json'), 'utf8'));
for (const [code, fx] of Object.entries(errors)) {
  if (code.startsWith('_')) continue;
  const errs = [];
  S.ErrorBody(fx.body, errs, code, { status: fx.status, code });
  t.ok(errs.length === 0, `error ${code}: forma válida`, errs);
}
// Toda ruta de 02 §A–§D (copiada del contrato) tiene al menos un fixture.
const REQUIRED = ['GET /me/context', 'GET /permissions/catalog', 'GET /institutions', 'GET /institutions/:id', 'POST /institutions',
  'POST /admin/institutions', 'PATCH /admin/institutions/:id', 'PATCH /admin/courses/:courseId/institution', 'GET /institutions/:id/members',
  'POST /institutions/:id/members', 'PATCH /institutions/:id/members/:userId', 'DELETE /institutions/:id/members/:userId',
  'PUT /institutions/:id/members/:userId/overrides', 'GET /admin/users', 'POST /admin/users', 'GET /admin/users/:userId',
  'POST /admin/users/:userId/authorize', 'POST /admin/users/:userId/repair', 'POST /admin/users/:userId/suspensions',
  'DELETE /admin/users/:userId/suspensions/:kind', 'GET /admin/platform/controls', 'PUT /admin/platform/generation-freeze', 'GET /admin/audit-log',
  'GET /me/budget', 'GET /admin/budgets', 'GET /admin/users/:userId/budget', 'PUT /admin/users/:userId/budget',
  'POST /admin/users/:userId/budget-adjustments', 'GET /admin/budget-reservations', 'POST /budget-requests', 'GET /me/budget-requests',
  'POST /budget-requests/:id/cancel', 'GET /admin/budget-requests', 'POST /admin/budget-requests/:id/approve',
  'POST /admin/budget-requests/:id/reject', 'GET /institutions/:id/spend', 'GET /admin/spend', 'POST /admin/budgets/reconcile',
  'POST …/runs/estimate-preview'];
const have = new Set(Object.keys(idx.routes).map((k) => k.split('#')[0].split('?')[0]));
for (const r of REQUIRED) t.ok(have.has(r), `fixture para ${r}`);
// tempPassword: solo en la variante temp_password y con Cache-Control no-store.
const au = JSON.parse(fs.readFileSync(path.join(DIR, 'admin-users.json'), 'utf8'));
t.ok(au['POST /admin/users#temp_password'].headers['Cache-Control'] === 'no-store', 'temp_password lleva Cache-Control: no-store');
t.ok(!('tempPassword' in au['POST /admin/users#invite'].body.data), 'invite no trae tempPassword');
const s = t.summary('contratos r75');
process.exit(s.fail ? 1 : 0);
