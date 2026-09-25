#!/usr/bin/env node

// Preflight de SOLO LECTURA de Fase 5A (generación dinámica) en staging.
//
// Responde, sin imprimir ningún secreto, las preguntas que hay que contestar
// ANTES de autorizar una aceptación real con Videogen (spec 2026-09-24
// fase5-generation-design §7.7):
//   - variables de entorno necesarias presentes (solo SÍ/NO, nunca el valor);
//   - SUPABASE_URL / DB no apuntan al proyecto de producción;
//   - tarifa activa de cost_rates para video_engine/video_generation/per_video
//     y costo estimado de 6 videos; costo real histórico de Videogen en
//     usage_events de staging (si hay);
//   - bucket de storage `cursia-artifacts`: tipos MIME / tamaño permitidos
//     para los artifacts dynamic, y políticas RLS de storage.objects;
//   - R5: el CHECK de production_jobs.execution_mode acepta
//     'dynamic_generation' y conserva todos los modos legacy.
//
// Nunca escribe nada: una única transacción READ ONLY que termina en
// ROLLBACK. Solo falla (exit 1) ante un guardarraíl de seguridad (no-staging,
// ref de producción) o si R5 no se cumple; todo lo demás es informativo.

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

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
const KNOWN_STAGING_SUPABASE_REF = 'ljdtmkwuhkvtmlhugjrv';

const DYNAMIC_MODE = 'dynamic_generation';

// MIME types que usa el flujo dynamic (frontend 45 + worker de video).
const DYNAMIC_MIME_TYPES = ['text/markdown', 'text/html', 'application/xml', 'text/plain', 'application/json'];
const ARTIFACTS_BUCKET = 'cursia-artifacts';
const VIDEOS_FOR_ACCEPTANCE = 6;

function assertExplicitStagingIntent() {
  if (process.env.MIGRATION_ENV !== 'staging') {
    console.error('❌ MIGRATION_ENV no es "staging" — este preflight es exclusivo de staging. Abortando.');
    process.exit(1);
  }
}

function dbProjectRef() {
  const host = String(process.env.DB_HOST || '');
  const user = String(process.env.DB_USER || '');
  let m = host.match(/^db\.([a-z0-9]+)\.supabase\.co$/i);
  if (m) return m[1].toLowerCase();
  m = user.match(/^postgres\.([a-z0-9]+)$/i);
  if (m) return m[1].toLowerCase();
  return null;
}

function supabaseUrlRef() {
  const raw = String(process.env.SUPABASE_URL || '');
  try {
    const host = new URL(raw).hostname;
    const m = host.match(/^([a-z0-9]+)\.supabase\.co$/i);
    return m ? m[1].toLowerCase() : `(host no estándar)`;
  } catch {
    return null;
  }
}

function present(name) {
  const v = process.env[name];
  return typeof v === 'string' && v.trim().length > 0;
}

function yesNo(b) {
  return b ? 'SÍ' : 'NO';
}

// Nunca imprime el valor de una clave: solo su formato, los claims NO secretos
// de un JWT (role, ref) y la respuesta de Storage a una firma de prueba sobre
// un path inexistente. Cualquier cosa con forma de JWT en esa respuesta se
// redacta antes de imprimir.
function redact(text) {
  return String(text || '')
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '<jwt>')
    .replace(/sb_(secret|publishable)_[A-Za-z0-9_-]+/g, '<key>')
    .slice(0, 200);
}

function jwtClaims(token) {
  const parts = String(token).split('.');
  if (parts.length !== 3) return null;
  try {
    const json = Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const p = JSON.parse(json);
    return { role: p.role ?? null, ref: p.ref ?? null, iss: p.iss ?? null };
  } catch {
    return null;
  }
}

async function diagnoseServiceRoleKey() {
  console.log('── SUPABASE_SERVICE_ROLE_KEY: diagnóstico (sin mostrar el valor) ──');
  const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  const base = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
  if (!key || !base) {
    console.log('  ⚠️ falta SUPABASE_SERVICE_ROLE_KEY o SUPABASE_URL');
    return;
  }
  const format = key.startsWith('sb_secret_') ? 'sb_secret (clave nueva)'
    : key.startsWith('sb_publishable_') ? 'sb_publishable (clave pública nueva — NO sirve como service role)'
    : key.split('.').length === 3 ? 'JWT (clave clásica)' : 'desconocido';
  console.log(`  formato: ${format}`);
  const claims = jwtClaims(key);
  if (claims) {
    console.log(`  claims: role=${claims.role} ref=${claims.ref} iss=${claims.iss}`);
    console.log(`  role === service_role: ${yesNo(claims.role === 'service_role')}`);
    console.log(`  ref coincide con SUPABASE_URL (${supabaseUrlRef()}): ${yesNo(claims.ref === supabaseUrlRef())}`);
    if (claims.ref === KNOWN_PRODUCTION_SUPABASE_REF) {
      console.log('  ❌ la clave pertenece al proyecto de PRODUCCIÓN');
    }
  }
  // Firma de prueba sobre un objeto inexistente: con una service role válida
  // del proyecto la respuesta esperada es "not found" (400/404); una clave
  // inválida o de otro proyecto da un error de firma/autorización.
  try {
    const res = await fetch(`${base}/storage/v1/object/sign/${ARTIFACTS_BUCKET}/__preflight__/no-existe.txt`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, apikey: key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ expiresIn: 60 }),
    });
    const body = await res.text();
    console.log(`  firma de prueba (objeto inexistente): HTTP ${res.status} ${redact(body)}`);
  } catch (err) {
    console.log(`  firma de prueba: error de red ${redact(err && err.message)}`);
  }
}

async function main() {
  loadEnvFile(path.resolve(process.cwd(), '.env'));
  assertExplicitStagingIntent();

  let failed = false;

  console.log('── Proyecto / referencias a producción ──');
  const dbRef = dbProjectRef();
  const sbRef = supabaseUrlRef();
  if (dbRef === KNOWN_PRODUCTION_SUPABASE_REF || sbRef === KNOWN_PRODUCTION_SUPABASE_REF) {
    console.error('❌ DB_HOST/DB_USER o SUPABASE_URL apuntan al proyecto de PRODUCCIÓN. Abortando.');
    process.exit(1);
  }
  if (dbRef === null) {
    console.error('❌ No se pudo determinar el ref de proyecto de la DB. Abortando por seguridad.');
    process.exit(1);
  }
  console.log(`  ref DB:           ${dbRef}${dbRef === KNOWN_STAGING_SUPABASE_REF ? ' (staging conocido)' : ''}`);
  console.log(`  ref SUPABASE_URL: ${sbRef ?? '(no definido)'}${sbRef === KNOWN_STAGING_SUPABASE_REF ? ' (staging conocido)' : ''}`);
  console.log(`  mismo proyecto DB/Storage: ${yesNo(dbRef === sbRef)}`);

  console.log('── Variables de entorno (solo presencia, nunca el valor) ──');
  for (const name of ['NODE_ENV', 'VIDEOGEN_API_KEY', 'VIDEOGEN_API_URL', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']) {
    console.log(`  ${name.padEnd(26)} presente: ${yesNo(present(name))}`);
  }
  console.log(`  NODE_ENV === production:    ${yesNo(process.env.NODE_ENV === 'production')}`);
  console.log(`  VIDEO_WORKER_MOCK_VIDEOGEN presente: ${yesNo(present('VIDEO_WORKER_MOCK_VIDEOGEN'))} (legacy; no afecta al worker dynamic)`);

  const client = new Client({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 5432),
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
    ssl: String(process.env.DB_SSL || '').toLowerCase() === 'true' ? { rejectUnauthorized: false } : false,
  });
  await diagnoseServiceRoleKey();

  await client.connect();
  try {
    await client.query('begin transaction read only');

    console.log('── R5: CHECK de production_jobs.execution_mode ──');
    const chk = await client.query(
      `select conname, pg_get_constraintdef(c.oid) as def
         from pg_constraint c
        where c.conrelid = 'public.production_jobs'::regclass and c.contype = 'c'
          and pg_get_constraintdef(c.oid) ilike '%execution_mode%'`,
    );
    if (chk.rows.length === 0) {
      console.error('  ❌ No hay CHECK sobre execution_mode');
      failed = true;
    }
    for (const r of chk.rows) {
      const modes = [...r.def.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
      console.log(`  ${r.conname}: ${modes.join(', ')}`);
      if (!modes.includes(DYNAMIC_MODE)) {
        console.error(`  ❌ '${DYNAMIC_MODE}' no está permitido`);
        failed = true;
      } else {
        console.log(`  ✓ '${DYNAMIC_MODE}' permitido`);
      }
      const brandExtractionAllowed = modes.includes('brand_extraction');
      console.log(`  'brand_extraction' permitido: ${yesNo(brandExtractionAllowed)}`);
      if (!brandExtractionAllowed) {
        console.error("  ❌ 'brand_extraction' no está permitido (ver scripts/migrate-production-jobs-constraints.js)");
        failed = true;
      }
    }
    const legacyModes = await client.query(
      `select coalesce(execution_mode, '(null)') as mode, count(*)::int as n
         from public.production_jobs group by 1 order by 1`,
    );
    console.log('  filas existentes por execution_mode: ' +
      (legacyModes.rows.map((r) => `${r.mode}=${r.n}`).join(', ') || '(ninguna)'));

    console.log('── Tarifa de Videogen (cost_rates) ──');
    const rates = await client.query(
      `select id, provider, service, model, unit_type, rate_usd::text as rate_usd, is_active,
              effective_from::text as effective_from, source, notes
         from public.cost_rates
        where provider = 'video_engine' and service = 'video_generation'
        order by is_active desc, effective_from desc nulls last, id desc`,
    );
    if (rates.rows.length === 0) {
      console.log('  ⚠️ Sin filas video_engine/video_generation → /estimate devolverá costo null');
    }
    for (const r of rates.rows) {
      console.log(`  #${r.id} unit=${r.unit_type} model=${r.model ?? 'null'} rate_usd=${r.rate_usd} activo=${yesNo(r.is_active)} ` +
        `desde=${r.effective_from ?? 'null'} source=${r.source ?? 'null'} notes="${r.notes ?? ''}"`);
    }
    const active = rates.rows.find((r) => r.is_active && r.unit_type === 'per_video' && r.model === null);
    if (active) {
      const est = Number(active.rate_usd) * VIDEOS_FOR_ACCEPTANCE;
      console.log(`  ✓ tarifa activa per_video: USD ${Number(active.rate_usd)} → ${VIDEOS_FOR_ACCEPTANCE} videos ≈ USD ${est.toFixed(2)}`);
    } else {
      console.log('  ⚠️ No hay tarifa activa per_video con model null (la que usa /estimate)');
    }

    console.log('── Costo REAL histórico de Videogen en usage_events (staging) ──');
    const real = await client.query(
      `select count(*)::int as eventos,
              coalesce(sum(video_count), 0)::int as videos,
              sum(real_cost_usd)::text as real_total,
              case when sum(video_count) > 0 then (sum(real_cost_usd) / sum(video_count))::text end as real_por_video,
              max(created_at)::text as ultimo
         from public.usage_events
        where real_cost_usd is not null and coalesce(video_count, 0) > 0`,
    );
    const rr = real.rows[0];
    if (!rr || rr.eventos === 0) {
      console.log('  (sin eventos con costo real de video en staging)');
    } else {
      console.log(`  eventos=${rr.eventos} videos=${rr.videos} costo_real_total=USD ${rr.real_total} ` +
        `→ promedio por video ≈ USD ${Number(rr.real_por_video).toFixed(4)} (último: ${rr.ultimo})`);
    }

    console.log(`── Storage: bucket ${ARTIFACTS_BUCKET} ──`);
    const bucket = await client.query(
      `select id, public, file_size_limit, allowed_mime_types from storage.buckets where id = $1`,
      [ARTIFACTS_BUCKET],
    );
    if (bucket.rows.length === 0) {
      console.log(`  ⚠️ El bucket ${ARTIFACTS_BUCKET} no existe`);
    } else {
      const b = bucket.rows[0];
      const allowed = b.allowed_mime_types;
      console.log(`  público=${yesNo(b.public)} file_size_limit=${b.file_size_limit ?? 'sin límite de bucket'}`);
      if (!allowed || allowed.length === 0) {
        console.log('  ✓ allowed_mime_types = sin restricción (acepta todos los tipos del flujo dynamic)');
      } else {
        console.log(`  allowed_mime_types: ${allowed.join(', ')}`);
        for (const t of DYNAMIC_MIME_TYPES) {
          const ok = allowed.some((a) => a === t || (a.endsWith('/*') && t.startsWith(a.slice(0, -1))));
          console.log(`    ${t.padEnd(18)} ${ok ? '✓ aceptado' : '⚠️ NO aceptado'}`);
        }
      }
    }
    const pol = await client.query(
      `select policyname, cmd, roles::text as roles, qual, with_check
         from pg_policies where schemaname = 'storage' and tablename = 'objects'
        order by policyname`,
    );
    console.log(`  políticas RLS de storage.objects: ${pol.rows.length}`);
    for (const p of pol.rows) {
      const mentions = `${p.qual ?? ''} ${p.with_check ?? ''}`.includes(ARTIFACTS_BUCKET);
      if (!mentions) continue;
      console.log(`  - [${p.cmd}] ${p.policyname} roles=${p.roles}`);
      if (p.qual) console.log(`      using: ${p.qual}`);
      if (p.with_check) console.log(`      check: ${p.with_check}`);
    }

    console.log('── Estado de datos dynamic (conteos) ──');
    const counts = await client.query(
      `select (select count(*) from public.production_jobs where execution_mode = 'dynamic_generation')::int as runs,
              (select count(*) from public.generation_item_runs)::int as items,
              (select count(*) from public.generation_run_contexts)::int as contexts,
              (select count(*) from public.artifacts where item_run_id is not null)::int as linked_artifacts`,
    );
    const c = counts.rows[0];
    console.log(`  runs=${c.runs} items=${c.items} contexts=${c.contexts} artifacts_enlazados=${c.linked_artifacts}`);

    await client.query('rollback');
  } finally {
    await client.end();
  }

  if (failed) {
    console.error('❌ Preflight: R5 no se cumple');
    process.exit(1);
  }
  console.log('✅ Preflight de Fase 5A terminado (solo lectura)');
}

main().catch((err) => {
  console.error('❌ Preflight falló:', err && err.message ? err.message : err);
  process.exit(1);
});
