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

    if (failures.length > 0) {
      console.error('❌ Verificación FALLÓ:');
      failures.forEach((f) => console.error('  - ' + f));
      process.exitCode = 1;
    } else {
      console.log('✅ Task 1 (findOrCreateDynamic) verificado correctamente. Curso de prueba id=' + first.id + ' — bórralo a mano si no querés dejarlo en staging.');
    }
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error('❌ Error inesperado:', err.message);
  process.exitCode = 1;
});
