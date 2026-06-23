/**
 * Validación local del registro de costos de audio.
 * Sin llamadas a APIs ni a la DB — simula resolveCostEstimate con las
 * tarifas del seed (admin-seed.service.ts).
 *
 * Ejecutar: node validate-audio-costs.js
 */

// ── Tarifas exactas del seed (admin-seed.service.ts) ────────────────────────
const RATES = {
  // openai_tts — voz
  'openai_tts|audio_generation|gpt-4o-mini-tts|per_1k_characters': 0.0006,
  // openai — chat (guion audiolibro)
  'openai|chat_completion|gpt-4o-mini|per_1k_input_tokens':  0.00015,
  'openai|chat_completion|gpt-4o-mini|per_1k_output_tokens': 0.0006,
};

// ── Replica de resolveCostEstimate (cost-rates.service.ts) ──────────────────
function resolveCostEstimate({ provider, service, model, tokensInput, tokensOutput, units, unitType }) {
  if (!provider || !service) return { costUsd: null, reason: 'service undefined → retorno inmediato' };

  let total = 0;
  let hasValue = false;

  function getRate(ut) {
    return RATES[`${provider}|${service}|${model}|${ut}`] ?? null;
  }

  if (tokensInput && tokensInput > 0) {
    const rate = getRate('per_1k_input_tokens');
    if (rate) { total += (tokensInput / 1000) * rate; hasValue = true; }
  }

  if (tokensOutput && tokensOutput > 0) {
    const rate = getRate('per_1k_output_tokens');
    if (rate) { total += (tokensOutput / 1000) * rate; hasValue = true; }
  }

  if (unitType && units && units > 0) {
    const rate = getRate(unitType);
    if (rate) {
      const divisor = unitType.startsWith('per_1k_') ? 1000 : 1;
      total += (units / divisor) * rate;
      hasValue = true;
    }
  }

  return hasValue ? { costUsd: total } : { costUsd: null, reason: 'sin tarifa matching' };
}

// ── Nombres del dashboard (27-admin-dashboard.js) ───────────────────────────
const PROVIDER_NAMES = {
  anthropic:    'Claude',
  openai:       'OpenAI Texto',
  openai_tts:   'OpenAI Voz (TTS)',
  elevenlabs:   'ElevenLabs',
  video_engine: 'Videos',
  otros:        'Otros',
};

// ── Casos de prueba ──────────────────────────────────────────────────────────
const TESTS = [
  {
    label: 'Evento 1: welcome_audio_completed  (10 000 caracteres)',
    eventType: 'welcome_audio_completed',
    input: {
      provider:  'openai_tts',
      service:   'audio_generation',
      model:     'gpt-4o-mini-tts',
      units:     10000,
      unitType:  'per_1k_characters',
      costType:  'estimated',
    },
    expected: 10000 / 1000 * 0.0006,
    dashboardGroup: 'openai_tts',
  },
  {
    label: 'Evento 2: audiobook_script_completed  (1 000 in / 5 000 out tokens)',
    eventType: 'audiobook_script_completed',
    input: {
      provider:      'openai',
      service:       'chat_completion',
      model:         'gpt-4o-mini',
      tokensInput:   1000,
      tokensOutput:  5000,
      costType:      'estimated',
    },
    expected: (1000 / 1000) * 0.00015 + (5000 / 1000) * 0.0006,
    dashboardGroup: 'openai',
  },
  {
    label: 'Evento 3: audiobook_completed / TTS  (20 000 caracteres)',
    eventType: 'audiobook_completed',
    input: {
      provider:  'openai_tts',
      service:   'audio_generation',
      model:     'gpt-4o-mini-tts',
      units:     20000,
      unitType:  'per_1k_characters',
      costType:  'estimated',
    },
    expected: 20000 / 1000 * 0.0006,
    dashboardGroup: 'openai_tts',
  },
  {
    label: 'Control negativo: sin service (bug anterior)',
    eventType: 'audiobook_completed',
    input: {
      provider: 'openai_tts',
      model:    'gpt-4o-mini-tts',
      units:    20000,
      unitType: 'per_1k_characters',
      costType: 'estimated',
      // service: undefined  ← deliberadamente ausente
    },
    expected: null,
    dashboardGroup: 'openai_tts',
    expectFail: true,
  },
];

// ── Ejecución ────────────────────────────────────────────────────────────────
console.log('═══════════════════════════════════════════════════════════');
console.log('  VALIDACIÓN DE COSTOS DE AUDIO — sin APIs, sin DB');
console.log('═══════════════════════════════════════════════════════════\n');

let allOk = true;
const summary = [];

for (const t of TESTS) {
  const resolved = resolveCostEstimate(t.input);
  const cost = resolved.costUsd;
  const finalCostType = cost !== null ? 'estimated' : 'unknown';

  const costOk   = t.expectFail ? cost === null : (cost !== null && Math.abs(cost - t.expected) < 1e-9);
  const groupName = PROVIDER_NAMES[t.dashboardGroup] || t.dashboardGroup;
  const status    = costOk ? '✅' : '❌';

  if (!costOk) allOk = false;

  console.log(`${status} ${t.label}`);
  console.log(`   event_type:    ${t.eventType}`);
  console.log(`   cost_type DB:  ${finalCostType}`);
  if (cost !== null) {
    console.log(`   estimated_cost_usd: $${cost.toFixed(8)}`);
    if (!t.expectFail) {
      console.log(`   esperado:           $${t.expected.toFixed(8)}`);
    }
  } else {
    console.log(`   estimated_cost_usd: NULL  ${resolved.reason ? '← ' + resolved.reason : ''}`);
  }
  console.log(`   dashboard group: ${t.dashboardGroup} → "${groupName}"`);
  console.log('');

  summary.push({
    evento:     t.eventType,
    costo_usd:  cost !== null ? `$${cost.toFixed(6)}` : 'NULL (unknown)',
    grupo_dash: groupName,
    ok:         costOk ? '✅' : '❌',
  });
}

console.log('═══════════════════════════════════════════════════════════');
console.log('  RESUMEN');
console.log('═══════════════════════════════════════════════════════════');
console.table(summary.map(r => ({
  Evento:         r.evento,
  'Costo USD':    r.costo_usd,
  'Dashboard':    r.grupo_dash,
  'Estado':       r.ok,
})));

const openaiTtsTotal = TESTS
  .filter(t => t.dashboardGroup === 'openai_tts' && !t.expectFail)
  .reduce((s, t) => s + t.expected, 0);
const openaiTextTotal = TESTS
  .filter(t => t.dashboardGroup === 'openai' && !t.expectFail)
  .reduce((s, t) => s + t.expected, 0);

console.log('\n  Simulación de totales en dashboard costByProvider:');
console.log(`  openai_tts → "OpenAI Voz (TTS)":  $${openaiTtsTotal.toFixed(6)}  (bienvenida + audiolibro TTS)`);
console.log(`  openai     → "OpenAI Texto":       $${openaiTextTotal.toFixed(6)}  (guion audiolibro)`);

console.log('\n  Sobre el histórico ($0 actual):');
console.log('  Los eventos anteriores ya existen en DB con cost_type="unknown" y costo NULL.');
console.log('  No se modificarán — el dashboard mostrará $0 para fechas pasadas.');
console.log('  Los nuevos cursos ya registrarán los costos correctamente desde este deploy.\n');

console.log(allOk
  ? '✅ VALIDACIÓN COMPLETA — todos los eventos registran costo correcto'
  : '❌ FALLOS DETECTADOS — revisar antes de deploy');
