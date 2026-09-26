/* eslint-disable */
// R2 — Visual Components: fixtures compartidos por los tres checks
// (check-v21-visual-components.js, check-v21-vc-purifier.js, visual/vc-gallery.mjs).
// Todo determinista: sin reloj ni azar.

const path = require('path');
const fs = require('fs');

const FIXTURE = path.resolve(__dirname, '..', 'fixtures', 'v21-vc-components.json');

/** Familias × modos soportados (R1). */
const THEME_COMBOS = [
  { themeFamily: 'aula-clara', mode: 'light' },
  { themeFamily: 'institucional', mode: 'light' },
  { themeFamily: 'editorial', mode: 'light' },
  { themeFamily: 'vibrante', mode: 'light' },
  { themeFamily: 'tecnico', mode: 'light' },
  { themeFamily: 'tecnico', mode: 'dark' },
  { themeFamily: 'oscuro-premium', mode: 'dark' },
];

function clone(x) {
  return JSON.parse(JSON.stringify(x));
}

function loadFixture() {
  return JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
}

/** Un componente de cada tipo (16) + variantes de callout. */
function loadComponents() {
  const f = loadFixture();
  return [...f.components, ...f.callout_variants].map(clone);
}

function byType(type, variant) {
  const c = loadComponents().find((x) => x.type === type && (!variant || x.variant === variant));
  if (!c) throw new Error(`fixture sin componente ${type}`);
  return c;
}

/** Documento de capítulo completo y válido. */
function buildExperience() {
  return {
    vcSchemaVersion: 1,
    chapterId: 'cap-escucha-activa',
    movements: {
      opening: [byType('hero'), byType('learning_objectives'), byType('callout', 'tip')],
      deepening: [byType('concept_cards'), byType('accordion'), byType('tabs'), byType('comparison')],
      synthesis: [byType('summary_visual'), byType('myth_reality')],
      closing: [byType('reflection'), byType('case_scenario')],
      video_primer: [byType('process_steps'), byType('timeline')],
      self_check: [byType('self_check')],
    },
    bridge_to_next: 'Con la escucha resuelta, el siguiente paso es aprender a negociar acuerdos que el cliente sienta justos.',
  };
}

/** Palabra de 400 caracteres sin espacios (estrés de desborde horizontal). */
const LONG_WORD = ('Responsabilidad' + 'Interdepartamental').repeat(12).slice(0, 400);

/**
 * Variante "texto largo": cada campo de texto (incluidos títulos) pasa a ser una palabra de
 * 400 caracteres seguida de una frase larga. NO es válida para el validador (excede
 * longitudes) — sirve para estresar el renderer y el layout.
 */
function longVariant(c) {
  const sentence = ' ' + 'La escucha activa se demuestra con acciones concretas y verificables. '.repeat(4).trim();
  const walk = (v, key) => {
    if (key === 'type' || key === 'variant') return v;
    if (typeof v === 'string') return LONG_WORD + sentence;
    if (Array.isArray(v)) return v.map((x) => walk(x, null));
    if (v && typeof v === 'object') {
      const o = {};
      for (const k of Object.keys(v)) o[k] = walk(v[k], k);
      return o;
    }
    return v;
  };
  return walk(clone(c), null);
}

/** Todos los strings de texto de un componente (sin type/variant), con ** removidos. */
function textsOf(c) {
  const out = [];
  const walk = (v, key) => {
    if (key === 'type' || key === 'variant') return;
    if (typeof v === 'string') out.push(v.split('**').join(''));
    else if (Array.isArray(v)) v.forEach((x) => walk(x, null));
    else if (v && typeof v === 'object') Object.keys(v).forEach((k) => walk(v[k], k));
  };
  walk(c, null);
  return out;
}

function themeLabel(combo) {
  return `${combo.themeFamily}-${combo.mode}`;
}

module.exports = { THEME_COMBOS, loadComponents, buildExperience, longVariant, textsOf, themeLabel, LONG_WORD, clone };
