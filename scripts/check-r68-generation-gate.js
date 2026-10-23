#!/usr/bin/env node
/* eslint-disable */
// R68 (piloto, 2026-10-07): bloqueo REAL de generación en el servidor — cableado y clasificación de errores (sin DB, sin red).
//   RG-DI  Nest inyecta GenerationDesignGate en RunsService (si faltara, @Optional dejaría el gate abierto).
//   RG-ERR un error de negocio de «Cursia recomienda» → 409 unverified; uno transitorio → 503 (no «el diseño está mal»).
//   RG-RUN RunsService: generación nueva → el gate decide; con un run activo en el Manifest (retomar) → sin gate.
// Los casos con Postgres (lock + «Cursia recomienda» reales) están en check-loop86c-requirements-authority.js (RG1–RG4)
// y el recorrido HTTP completo en test/e2e-v2/e2e-v3.js (E18).
'use strict';
const path = require('path');
require('reflect-metadata');
const DIST = path.resolve(process.argv[2] || path.join(__dirname, '..', 'dist'));
const loadDist = (rel) => require(path.join(DIST, rel));
let ok = 0, fail = 0;
async function check(name, fn) { try { await fn(); ok++; console.log(`✅ ${name}`); } catch (e) { fail++; console.log(`❌ ${name}\n   ${String(e && e.stack || e).split('\n').slice(0, 4).join('\n   ')}`); } }
const assert = (c, m) => { if (!c) throw new Error(m || 'falló'); };

(async () => {
  const { RunsService } = loadDist('modules/dynamic-generation/runs.service.js');
  const { GenerationDesignGate, GENERATION_NOT_VERIFIED } = loadDist('modules/course-design/generation-design-gate.js');
  const { DynamicGenerationModule } = loadDist('modules/dynamic-generation/dynamic-generation.module.js');
  const { CourseDesignModule } = loadDist('modules/course-design/course-design.module.js');

  await check('RG-DI RunsService pide GenerationDesignGate; DynamicGenerationModule importa CourseDesignModule y éste lo exporta y provee', () => {
    const params = Reflect.getMetadata('design:paramtypes', RunsService) || [];
    assert(params.includes(GenerationDesignGate), 'RunsService no declara GenerationDesignGate en su constructor');
    const imports = Reflect.getMetadata('imports', DynamicGenerationModule) || [];
    assert(imports.includes(CourseDesignModule), 'DynamicGenerationModule no importa CourseDesignModule');
    assert((Reflect.getMetadata('exports', CourseDesignModule) || []).includes(GenerationDesignGate), 'CourseDesignModule no exporta el gate');
    assert((Reflect.getMetadata('providers', CourseDesignModule) || []).includes(GenerationDesignGate), 'CourseDesignModule no provee el gate');
  });

  await check('RG-ERR «Cursia recomienda» falla: 4xx → 409 GENERATION_NOT_VERIFIED (unverified); error transitorio → 503 GENERATION_VERIFICATION_UNAVAILABLE', async () => {
    const { NotFoundException } = require(path.join(__dirname, '..', 'node_modules', '@nestjs/common'));
    const ds = { query: async (sql) => {
      if (/from public\.courses where id = \$1 and owner_id/.test(sql)) return [{ id: 1, structure_version_counter: 5, current_blueprint_id: 10 }];
      if (/from public\.course_blueprints/.test(sql)) return [{ id: 10, schema_version: 1, snapshot_sha256: 'x', structure_counter_at_lock: 5 }];
      return [{ structure_version_counter: 5 }];
    } };
    const g1 = new GenerationDesignGate(ds, { recommend: async () => { throw new NotFoundException('sin curso'); } });
    let e1 = null; try { await g1.assertVerified(1, 'o', 1); } catch (e) { e1 = e; }
    assert(e1 && e1.getStatus() === 409 && e1.getResponse().code === GENERATION_NOT_VERIFIED && e1.getResponse().reason === 'unverified', String(e1 && e1.message));
    const g2 = new GenerationDesignGate(ds, { recommend: async () => { throw new Error('connection terminated'); } });
    let e2 = null; try { await g2.assertVerified(1, 'o', 1); } catch (e) { e2 = e; }
    assert(e2 && e2.getStatus() === 503 && e2.getResponse().code === 'GENERATION_VERIFICATION_UNAVAILABLE', String(e2 && e2.message));
  });

  await check('RG-RUN RunsService: sin run activo el gate decide (y su 409 corta antes de crear nada); con un run activo en el Manifest, retomar no pasa por el gate', async () => {
    const svc = Object.create(RunsService.prototype);
    const calls = [];
    svc.designGate = { assertVerified: async (...a) => { calls.push(a); const { ConflictException } = require(path.join(__dirname, '..', 'node_modules', '@nestjs/common')); throw new ConflictException({ code: GENERATION_NOT_VERIFIED, reason: 'critical' }); } };
    svc.findActiveRunRow = async () => null;
    let e = null; try { await svc.assertDesignVerifiedForNewRun(7, 'o', 2, 99); } catch (x) { e = x; }
    assert(e && e.getStatus() === 409 && calls.length === 1 && calls[0][0] === 7 && calls[0][2] === 2, 'el gate debe decidir una generación nueva');
    svc.findActiveRunRow = async () => ({ id: 'run-activo' });
    await svc.assertDesignVerifiedForNewRun(7, 'o', 2, 99);
    assert(calls.length === 1, 'retomar el run activo no vuelve a verificar');
  });

  console.log(`\n${ok} OK · ${fail} fallas`);
  process.exit(fail ? 1 : 0);
})();
