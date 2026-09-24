#!/usr/bin/env node

const { NestFactory } = require('@nestjs/core');
const fs = require('fs');
const path = require('path');

function loadEnvFile(envPath) {
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

const KNOWN_PRODUCTION_SUPABASE_REF = 'hriwbakbuypaiovvvkqh';

function extractSupabaseProjectRef() {
  const host = String(process.env.DB_HOST || '');
  const user = String(process.env.DB_USER || '');
  let m = host.match(/^db\.([a-z0-9]+)\.supabase\.co$/i);
  if (m) return m[1].toLowerCase();
  m = user.match(/^postgres\.([a-z0-9]+)$/i);
  if (m) return m[1].toLowerCase();
  return null;
}

function assertSafeToRun() {
  if (process.env.MIGRATION_ENV !== 'staging') {
    console.error('❌ MIGRATION_ENV no es "staging" — este harness es para staging únicamente.');
    process.exit(1);
  }
  const ref = extractSupabaseProjectRef();
  if (ref === KNOWN_PRODUCTION_SUPABASE_REF) {
    console.error('❌ La conexión apunta al proyecto de Supabase de PRODUCCIÓN. Abortando.');
    process.exit(1);
  }
  if (ref === null) {
    console.error('❌ No se pudo determinar el ref de proyecto — abortando por seguridad.');
    process.exit(1);
  }
  console.log('✅ Ref de proyecto:', ref, '(no es producción)');
}

async function main() {
  loadEnvFile(path.resolve(process.cwd(), '.env'));
  assertSafeToRun();

  const { AppModule } = require('../dist/app.module');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  const failures = [];

  try {
    const coursesService = app.get(require('../dist/modules/courses/courses.service').CoursesService);
    const TEST_OWNER_ID = process.env.TEST_OWNER_ID || '00000000-0000-0000-0000-000000000001';
    const frontendId = 'fase2-harness-' + Date.now();

    // 1. Idempotencia: dos llamadas seguidas devuelven el mismo courseId
    const first = await coursesService.findOrCreateDynamic(TEST_OWNER_ID, 'harness@test.local', frontendId, 'Curso de prueba Fase 2');
    const second = await coursesService.findOrCreateDynamic(TEST_OWNER_ID, 'harness@test.local', frontendId, 'Curso de prueba Fase 2 (segunda llamada)');
    if (first.id !== second.id) {
      failures.push(`findOrCreateDynamic no fue idempotente: primera llamada id=${first.id}, segunda id=${second.id}`);
    }
    if (first.structureVersion !== 'dynamic') {
      failures.push(`Curso creado con structureVersion="${first.structureVersion}", esperado "dynamic".`);
    }
    if (first.status !== 'draft') {
      failures.push(`Curso creado con status="${first.status}", esperado "draft".`);
    }

    // 2. CRUD completo, reorder y move — usa el curso dynamic creado arriba (first.id)
    const structureService = app.get(require('../dist/modules/course-structure/course-structure.service').CourseStructureService);
    const courseId = first.id;

    // Curso recién creado por findOrCreateDynamic arriba: structure_version_counter
    // arranca en 0 por default de columna (course.entity.ts), no es un valor inventado.
    var mod1Result = await structureService.createModule(courseId, TEST_OWNER_ID, { title: 'Módulo 1', expectedCounter: 0 });
    var mod1 = mod1Result.module;
    var counter = mod1Result.structureVersionCounter;
    var mod2Result = await structureService.createModule(courseId, TEST_OWNER_ID, { title: 'Módulo 2', expectedCounter: counter });
    var mod2 = mod2Result.module; counter = mod2Result.structureVersionCounter;

    // Ruling R3: createModule ya crea un capítulo default ("Nuevo capítulo") — mod1 y
    // mod2 arrancan con 1 capítulo cada uno, no con 0.
    var cap1Result = await structureService.createChapter(courseId, mod1.id, TEST_OWNER_ID, { title: 'Cap 1', expectedCounter: counter });
    counter = cap1Result.structureVersionCounter;
    var cap2Result = await structureService.createChapter(courseId, mod1.id, TEST_OWNER_ID, { title: 'Cap 2', expectedCounter: counter });
    counter = cap2Result.structureVersionCounter;
    var cap3Result = await structureService.createChapter(courseId, mod2.id, TEST_OWNER_ID, { title: 'Cap 3', expectedCounter: counter });
    counter = cap3Result.structureVersionCounter;

    // mod1 ahora tiene 3 capítulos (default + Cap1 + Cap2); mod2 tiene 2 (default + Cap3).
    var midStructure = await structureService.getStructure(courseId, TEST_OWNER_ID);
    var midMod1 = midStructure.modules.find((m) => m.id === mod1.id);
    var midMod2 = midStructure.modules.find((m) => m.id === mod2.id);
    if (midMod1.chapters.length !== 3) failures.push(`Módulo 1 debería tener 3 capítulos antes del move, tiene ${midMod1.chapters.length}`);
    if (midMod2.chapters.length !== 2) failures.push(`Módulo 2 debería tener 2 capítulos antes del move, tiene ${midMod2.chapters.length}`);

    // Mover Cap2 de mod1 a mod2, a la posición 1 (después del capítulo default de mod2).
    var moveResult = await structureService.moveChapter(courseId, mod1.id, cap2Result.chapter.id, TEST_OWNER_ID, {
      targetModuleId: mod2.id, targetPosition: 1, expectedCounter: counter,
    });
    counter = moveResult.structureVersionCounter;

    var finalStructure = await structureService.getStructure(courseId, TEST_OWNER_ID);
    var finalMod1 = finalStructure.modules.find((m) => m.id === mod1.id);
    var finalMod2 = finalStructure.modules.find((m) => m.id === mod2.id);
    if (finalMod1.chapters.length !== 2) failures.push(`Módulo 1 debería tener 2 capítulos tras el move, tiene ${finalMod1.chapters.length}`);
    if (finalMod2.chapters.length !== 3) failures.push(`Módulo 2 debería tener 3 capítulos tras el move, tiene ${finalMod2.chapters.length}`);
    var mod2ChapterAt1 = finalMod2.chapters.find((c) => c.position === 1);
    if (!mod2ChapterAt1 || mod2ChapterAt1.id !== cap2Result.chapter.id) {
      failures.push('Tras el move, el capítulo en la posición 1 de Módulo 2 debería ser Cap 2.');
    }

    // Caso de rechazo: expectedCounter desactualizado debe tirar ConflictException
    let conflictThrown = false;
    try {
      await structureService.createChapter(courseId, mod1.id, TEST_OWNER_ID, { title: 'no debería crearse', expectedCounter: 0 });
    } catch (e) {
      conflictThrown = e.constructor.name === 'ConflictException' || e.status === 409;
    }
    if (!conflictThrown) failures.push('createChapter con expectedCounter viejo debería tirar 409, no lo hizo.');

    // Caso de rechazo (R10): moveChapter con targetModuleId igual al módulo origen debe fallar.
    let sameModuleMoveRejected = false;
    try {
      await structureService.moveChapter(courseId, mod1.id, finalMod1.chapters[0].id, TEST_OWNER_ID, {
        targetModuleId: mod1.id, targetPosition: 0, expectedCounter: counter,
      });
    } catch (e) {
      sameModuleMoveRejected = e.constructor.name === 'BadRequestException' || e.status === 400;
    }
    if (!sameModuleMoveRejected) failures.push('moveChapter con targetModuleId == módulo origen debería rechazar con 400, no lo hizo.');

    // Caso de rechazo: eliminar el último capítulo de un módulo debe fallar.
    // Se usa un módulo recién creado (arranca con exactamente 1 capítulo default),
    // no mod1 (que después del move quedó con 2 capítulos).
    var freshModResult = await structureService.createModule(courseId, TEST_OWNER_ID, { title: 'Módulo para borrar último capítulo', expectedCounter: counter });
    var freshMod = freshModResult.module;
    counter = freshModResult.structureVersionCounter;
    let lastChapterRejected = false;
    try {
      await structureService.deleteChapter(courseId, freshMod.id, freshMod.chapters[0].id, TEST_OWNER_ID, counter);
    } catch (e) {
      lastChapterRejected = e.constructor.name === 'BadRequestException' || e.status === 400;
    }
    if (!lastChapterRejected) failures.push('deleteChapter del último capítulo del módulo debería rechazar con 400, no lo hizo.');

    // Caso de rechazo: eliminar el último MÓDULO del curso debe fallar.
    // Se arma un curso dynamic aparte, con un solo módulo, para este caso.
    var soloFrontendId = 'fase2-harness-solo-' + Date.now();
    var soloCourse = await coursesService.findOrCreateDynamic(TEST_OWNER_ID, 'harness@test.local', soloFrontendId, 'Curso de un solo módulo');
    var soloModResult = await structureService.createModule(soloCourse.id, TEST_OWNER_ID, { title: 'Único módulo', expectedCounter: 0 });
    var soloMod = soloModResult.module;
    let lastModuleRejected = false;
    try {
      await structureService.deleteModule(soloCourse.id, soloMod.id, TEST_OWNER_ID, soloModResult.structureVersionCounter);
    } catch (e) {
      lastModuleRejected = e.constructor.name === 'BadRequestException' || e.status === 400;
    }
    if (!lastModuleRejected) failures.push('deleteModule del último módulo del curso debería rechazar con 400, no lo hizo.');

    // Caso de rechazo: un curso LEGACY nunca debe ser mutable por esta API,
    // aunque se lo llame directo (sin pasar por el frontend/flag).
    var legacyCourse = await coursesService.create(
      { title: 'Curso legacy de prueba', structureVersion: 'legacy' },
      TEST_OWNER_ID,
      'harness@test.local',
    );
    let legacyRejected = false;
    try {
      await structureService.createModule(legacyCourse.id, TEST_OWNER_ID, { title: 'no debería crearse', expectedCounter: 0 });
    } catch (e) {
      legacyRejected = e.constructor.name === 'BadRequestException' || e.status === 400;
    }
    if (!legacyRejected) failures.push('createModule sobre un curso legacy debería rechazar con 400, no lo hizo.');

    if (failures.length > 0) {
      console.error('❌ Verificación FALLÓ:');
      failures.forEach((f) => console.error('  - ' + f));
      process.exitCode = 1;
    } else {
      console.log('✅ Task 1 (findOrCreateDynamic) y Task 6 (CRUD/reorder/move + rechazos) verificados correctamente. Curso de prueba id=' + first.id + ' — bórralo a mano si no querés dejarlo en staging.');
    }
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error('❌ Error inesperado:', err.message);
  process.exitCode = 1;
});
