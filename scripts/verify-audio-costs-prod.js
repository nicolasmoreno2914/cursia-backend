#!/usr/bin/env node
/**
 * Verificación de costos de audio en producción.
 *
 * Ejecutar en el VPS donde corre el backend:
 *   node scripts/verify-audio-costs-prod.js          ← baseline (antes de generar)
 *   node scripts/verify-audio-costs-prod.js --after  ← después de generar audio
 *   node scripts/verify-audio-costs-prod.js --since 60  ← últimos 60 minutos
 *
 * La DB se lee desde las variables de entorno del servidor (.env del backend).
 */

'use strict';

const { Client } = require('pg');
const fs   = require('fs');
const path = require('path');

// ── Cargar .env del backend ──────────────────────────────────────────────────
const envPath = path.resolve(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split(/\r?\n/).forEach(line => {
    line = line.trim();
    if (!line || line.startsWith('#')) return;
    const eq = line.indexOf('=');
    if (eq === -1) return;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(k in process.env)) process.env[k] = v;
  });
}

const SINCE_MINUTES = (() => {
  const idx = process.argv.indexOf('--since');
  if (idx !== -1 && process.argv[idx + 1]) return Number(process.argv[idx + 1]) || 60;
  if (process.argv.includes('--after')) return 20;
  return null; // sin filtro de tiempo → muestra todos
})();

const MODE = process.argv.includes('--after') ? 'AFTER' : 'BASELINE';

const db = new Client({
  host:     process.env.DB_HOST     || '127.0.0.1',
  port:     Number(process.env.DB_PORT || 5432),
  user:     process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  ssl:      process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

const AUDIO_EVENTS = [
  'welcome_audio_started',
  'welcome_audio_completed',
  'audiobook_started',
  'audiobook_script_completed',
  'audiobook_completed',
  'audio_failed',
];

function banner(title) {
  const line = '═'.repeat(60);
  console.log(`\n${line}\n  ${title}\n${line}`);
}

async function run() {
  await db.connect();
  console.log(`\n🔍 MODO: ${MODE} — ${new Date().toISOString()}`);
  if (SINCE_MINUTES) console.log(`   Filtrando últimos ${SINCE_MINUTES} minutos`);

  // ── 1. Tarifas activas en production ────────────────────────────────────────
  banner('1. TARIFAS EN PRODUCCIÓN (cost_rates)');
  const rates = await db.query(`
    SELECT provider, service, model, unit_type,
           rate_usd::text, is_active, effective_from
    FROM cost_rates
    WHERE provider IN ('openai_tts', 'openai', 'elevenlabs', 'anthropic')
    ORDER BY provider, service, model NULLS LAST
  `);
  console.table(rates.rows.length ? rates.rows : [{ resultado: 'TABLA VACÍA — seed no ejecutado' }]);

  const hasTtsTarifa = rates.rows.some(
    r => r.provider === 'openai_tts' && r.service === 'audio_generation' && r.unit_type === 'per_1k_characters'
  );
  const hasOpenaiInput = rates.rows.some(
    r => r.provider === 'openai' && r.service === 'chat_completion' && r.unit_type === 'per_1k_input_tokens'
  );
  const hasOpenaiOutput = rates.rows.some(
    r => r.provider === 'openai' && r.service === 'chat_completion' && r.unit_type === 'per_1k_output_tokens'
  );

  console.log('\n  Verificación de tarifas necesarias:');
  console.log(`  ${hasTtsTarifa   ? '✅' : '❌'} openai_tts / audio_generation / per_1k_characters`);
  console.log(`  ${hasOpenaiInput ? '✅' : '❌'} openai / chat_completion / per_1k_input_tokens`);
  console.log(`  ${hasOpenaiOutput? '✅' : '❌'} openai / chat_completion / per_1k_output_tokens`);

  // ── 2. Eventos de audio (con filtro temporal opcional) ───────────────────────
  banner('2. EVENTOS DE AUDIO — detalle por evento');
  const timeFilter = SINCE_MINUTES
    ? `AND created_at >= NOW() - INTERVAL '${SINCE_MINUTES} minutes'`
    : '';

  const events = await db.query(`
    SELECT
      event_type,
      provider,
      model,
      cost_type,
      cost_source,
      estimated_cost_usd::text  AS est_cost_usd,
      real_cost_usd::text       AS real_cost_usd,
      units::text               AS units,
      unit_type,
      tokens_input,
      tokens_output,
      failed,
      created_at::text          AS created_at
    FROM usage_events
    WHERE event_type = ANY($1)
    ${timeFilter}
    ORDER BY created_at DESC
    LIMIT 30
  `, [AUDIO_EVENTS]);
  console.table(events.rows.length ? events.rows : [{ resultado: 'Sin eventos de audio en este período' }]);

  // ── 3. Tabla de validación (el formato que pidió el usuario) ─────────────────
  if (MODE === 'AFTER' && events.rows.length > 0) {
    banner('3. VALIDACIÓN — tabla de verificación');

    const EXPECTED = {
      'welcome_audio_completed':    { provider: 'openai_tts', service: 'audio_generation',  needsUnits: true,   needsTokens: false },
      'audiobook_script_completed': { provider: 'openai',     service: 'chat_completion',   needsUnits: false,  needsTokens: true  },
      'audiobook_completed':        { provider: 'openai_tts', service: 'audio_generation',  needsUnits: true,   needsTokens: false },
    };

    const recentCompletions = events.rows.filter(r =>
      ['welcome_audio_completed', 'audiobook_script_completed', 'audiobook_completed'].includes(r.event_type)
    );

    if (!recentCompletions.length) {
      console.log('  ⚠️  No hay eventos de completación recientes en los últimos', SINCE_MINUTES, 'minutos.');
      console.log('     Genera el audio y luego ejecuta de nuevo con --after');
    } else {
      const table = recentCompletions.map(r => {
        const exp     = EXPECTED[r.event_type] || {};
        const hasCost = r.est_cost_usd !== null && r.est_cost_usd !== 'null';
        const costOk  = hasCost && parseFloat(r.est_cost_usd) > 0;
        const provOk  = exp.provider ? r.provider === exp.provider : true;
        const typeOk  = r.cost_type === 'estimated';
        const allOk   = costOk && provOk && typeOk;
        return {
          Evento:         r.event_type,
          Proveedor:      r.provider || 'NULL',
          Modelo:         r.model    || 'NULL',
          Unidades:       r.units    || r.tokens_input && `${r.tokens_input}in/${r.tokens_output}out` || 'NULL',
          'Costo Est USD':r.est_cost_usd && parseFloat(r.est_cost_usd) > 0 ? `$${parseFloat(r.est_cost_usd).toFixed(6)}` : 'NULL ❌',
          cost_type:      r.cost_type,
          Estado:         allOk ? '✅ correcto' : '❌ revisar',
        };
      });
      console.table(table);

      const allOk = table.every(r => r.Estado === '✅ correcto');
      console.log(allOk
        ? '\n✅ VERIFICACIÓN COMPLETA — todos los eventos de audio registran costo correcto'
        : '\n❌ FALLOS DETECTADOS — algunos eventos no tienen costo calculado'
      );
    }
  }

  // ── 4. Costos por proveedor (lógica dashboard) ───────────────────────────────
  banner('4. COSTOS POR PROVEEDOR (lógica costByProvider del dashboard)');
  const byProvider = await db.query(`
    SELECT
      COALESCE(provider, ai_provider, 'otros') AS provider,
      COUNT(*) AS eventos,
      COALESCE(SUM(COALESCE(real_cost_usd, estimated_cost_usd,
        CASE WHEN cost_type = 'mock_zero' THEN 0 ELSE NULL END)), 0)::text AS cost_usd,
      COUNT(*) FILTER (WHERE cost_type = 'unknown')                        AS eventos_unknown,
      COUNT(*) FILTER (WHERE estimated_cost_usd IS NULL AND real_cost_usd IS NULL) AS sin_costo
    FROM usage_events
    WHERE created_at >= NOW() - INTERVAL '30 days'
    GROUP BY COALESCE(provider, ai_provider, 'otros')
    ORDER BY cost_usd::numeric DESC
  `);
  console.table(byProvider.rows);

  console.log('\n  Nombres en el dashboard (27-admin-dashboard.js):');
  const PROVIDER_NAMES = {
    anthropic:    'Claude',
    openai:       'OpenAI Texto',
    openai_tts:   'OpenAI Voz (TTS)',
    video_engine: 'Videos',
    elevenlabs:   'ElevenLabs',
    otros:        'Otros',
  };
  for (const r of byProvider.rows) {
    const name = PROVIDER_NAMES[r.provider] || r.provider;
    const cost = parseFloat(r.cost_usd);
    const costStr = cost > 0 ? `$${cost.toFixed(6)}` : '$0.00';
    const warn = parseFloat(r.sin_costo) > 0 ? ` ← ${r.sin_costo} eventos sin costo` : '';
    console.log(`  ${r.provider.padEnd(14)} → "${name.padEnd(20)}" ${costStr}${warn}`);
  }

  await db.end();
}

run().catch(e => {
  console.error('\n❌ ERROR DE CONEXIÓN:', e.message);
  console.error('   Verifica que la DB está corriendo y que DB_HOST/DB_USER/DB_PASS son correctos.');
  process.exit(1);
});
