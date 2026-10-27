/* eslint-disable */
// r75 · Agente E — inventario de rutas (desde el código fuente bajo prueba) y sustitución de parámetros por fixture.
'use strict';
const path = require('path');
const { scanControllers } = require(path.join(__dirname, '..', '..', '..', 'scripts', 'check-r75-authz-coverage.js'));

function permissionOf(h) {
  const d = [...h.methodDecos, ...h.classDecos].find((x) => x.name === 'RequirePermission');
  if (!d) return null;
  const m = d.text.match(/RequirePermission\(\s*['"`]([a-z]+\.[a-z]+)['"`]\s*,\s*\{\s*([a-z]+)\s*:\s*(?:['"`]([^'"`]+)['"`]|true)/);
  return m ? { permission: m[1], scopeKind: m[2], scopeRef: m[3] || null } : { permission: '?', scopeKind: '?', scopeRef: null };
}
function inventory(root) {
  return scanControllers(root).map((h) => ({
    file: h.file, line: h.line, controller: h.controller, handler: h.handler, method: h.method, route: h.route, marks: h.marks,
    perm: permissionOf(h),
    public: h.marks.includes('Public') || h.marks.includes('PublicCapability'),
    token: h.marks.includes('TokenAuthenticated') || /finops\/ingest/.test(h.route),
    allowInactive: h.marks.includes('AllowInactiveAccount'),
    superAdmin: h.marks.includes('SuperAdminOnly') || [...h.methodDecos, ...h.classDecos].some((d) => d.name === 'UseGuards' && /SuperAdminGuard/.test(d.text)),
    jwt: [...h.methodDecos, ...h.classDecos].some((d) => d.name === 'UseGuards' && /SupabaseJwtGuard/.test(d.text)),
  }));
}

// fx = { course, number, run, itemKey, artifact, institution, job, brandProfile, userId, moduleId, chapterId, budgetRequest }
function fill(route, fx) {
  const pick = (name) => {
    switch (name) {
      case 'courseId': return fx.course;
      case 'number': return fx.number || 1;
      case 'runId': return fx.run;
      case 'itemKey': return encodeURIComponent(fx.itemKey || `course_plan:${fx.course}`);
      case 'institutionId': return fx.institution;
      case 'userId': return fx.userId;
      case 'moduleId': return fx.moduleId || '00000000-0000-4000-8000-0000000000aa';
      case 'chapterId': return fx.chapterId || '00000000-0000-4000-8000-0000000000ab';
      case 'kind': return 'account';
      case 'callId': return '00000000-0000-4000-8000-0000000000ac';
      case 'id': {
        if (/^\/courses\/:id/.test(route)) return fx.course;
        if (/^\/artifacts\/:id/.test(route)) return fx.artifact;
        if (/^\/institutions\/:id/.test(route) || /^\/admin\/institutions\/:id/.test(route)) return fx.institution;
        if (/^\/jobs\/:id/.test(route)) return fx.job;
        if (/brand-profiles\/:id/.test(route)) return fx.brandProfile || '00000000-0000-4000-8000-0000000000ad';
        if (/budget-requests\/:id/.test(route)) return fx.budgetRequest || '00000000-0000-4000-8000-0000000000ae';
        if (/runs\/:id/.test(route)) return fx.run;
        return '00000000-0000-4000-8000-0000000000af';
      }
      default:
        if (/version|^n$|number/i.test(name)) return 1;
        return '1';
    }
  };
  return route.replace(/:([A-Za-z_]\w*)/g, (_, n) => String(pick(n)));
}
const RESOURCE_PARAMS = /:(courseId|runId|institutionId|id)\b/;
module.exports = { inventory, fill, RESOURCE_PARAMS };
