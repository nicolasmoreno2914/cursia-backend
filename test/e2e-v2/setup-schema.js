// E2E Fase 9 (copia de int-be2/f78db + BrandProfile/YoutubeConnection). Fase 5A / Task 2 — schema setup on the throwaway local PG16.
// 1) synchronize the base entities the real modules need to boot, INCLUDING
//    the real ProductionJob/ProductionStep/Artifact entities (so the legacy
//    ProductionJobsService runs against a realistic production_jobs shape);
// 2) the real legacy scripts/migrate-production-jobs-constraints.js (run as a
//    child process by run.sh, before this file's step 3);
// 3) Fase 1 -> Fase 3 -> Fase 4 -> Fase 5A Task 1 SQL, run for real.
const path = require('path');
const fs = require('fs');
const { DataSource } = require('typeorm');

const BUILD = process.env.BUILD_DIR;
const PORT = Number(process.env.PGPORT_T);
const REPO = process.env.REPO;
const step = process.argv[2];

const req = (p) => require(path.join(BUILD, p));

(async () => {
  const base = { type: 'postgres', host: '127.0.0.1', port: PORT, username: 'postgres', database: 'v2db' };
  if (step === 'base') {
    const ents = [
      req('modules/courses/entities/course.entity.js').Course,
      req('modules/course-versions/entities/course-version.entity.js').CourseVersion,
      req('modules/institutions/entities/institution.entity.js').Institution,
      req('admin/entities/cost-rate.entity.js').CostRate,
      req('admin/entities/traditional-cost-benchmark.entity.js').TraditionalCostBenchmark,
      req('events/entities/usage-event.entity.js').UsageEvent,
      req('modules/production-jobs/entities/production-job.entity.js').ProductionJob,
      req('modules/production-jobs/entities/production-step.entity.js').ProductionStep,
      req('modules/artifacts/entities/artifact.entity.js').Artifact,
      req('modules/brand-profiles/entities/brand-profile.entity.js').BrandProfile,
      req('youtube/entities/youtube-connection.entity.js').YoutubeConnection,
    ];
    const ds0 = new DataSource({ ...base, entities: [], synchronize: false });
    await ds0.initialize();
    await ds0.query(`create extension if not exists pgcrypto;`);
    await ds0.query(`create extension if not exists "uuid-ossp";`);
    await ds0.destroy();
    const s = new DataSource({ ...base, entities: ents, synchronize: true });
    await s.initialize();
    await s.destroy();
    console.log('base synchronize done');
    return;
  }
  const ds = new DataSource({ ...base, entities: [], synchronize: false });
  await ds.initialize();
  for (const f of [
    'supabase-migration-dynamic-course-structure.sql',
    'supabase-migration-course-blueprints.sql',
    'supabase-migration-generation-manifests.sql',
    'supabase-migration-dynamic-generation.sql',
    'supabase-migration-v21-blueprint-profiles.sql', // V2.1 R3: toggles de Blueprint v2 + course_profiles
    // V2.1 R4 (supabase-migration-v21-manifest-v3.sql) NO va acá: extiende los
    // CHECKs de supabase-migration-dynamic-generation-v2.sql, que run-e2e.sh
    // aplica DESPUÉS de este paso con su script real. run-e2e.sh corre
    // scripts/migrate-v21-manifest-v3.js (+ su verify) justo después de la v2.
  ]) {
    await ds.query(fs.readFileSync(path.join(REPO, f), 'utf8'));
    console.log('applied', f);
  }
  const [c] = await ds.query(`select pg_get_constraintdef(oid) d from pg_constraint where conname='production_jobs_execution_mode_check'`);
  if (!c || !/dynamic_generation/.test(c.d)) throw new Error('execution_mode CHECK missing dynamic_generation');
  await ds.destroy();
  console.log('SETUP OK');
})().catch((e) => { console.error('SETUP FAILED', e); process.exit(1); });
