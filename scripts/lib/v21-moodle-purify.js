/* eslint-disable */
// R2 — puente Node → purify_html() de un Moodle LOCAL (solo lectura), vía PHP CLI.
// Rutas por variables de entorno; los defaults son el Moodle desechable del entorno de
// desarrollo de V2.1. Si algo falta, FALLA FUERTE (nunca se salta el check en silencio).
//
//   PHP_BIN         binario de PHP            (default /opt/homebrew/opt/php@8.3/bin/php)
//   PHP_INI         php.ini del Moodle local
//   MOODLE_CONFIG   config.php del Moodle local

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const SCRATCH = '/private/tmp/claude-501/-Users-nicolas-Documents-Claude-course-gen/c3707ccd-9a84-4474-8052-2f6dfeb251b1/scratchpad/moodle-local';
const PHP_BIN = process.env.PHP_BIN || '/opt/homebrew/opt/php@8.3/bin/php';
const PHP_INI = process.env.PHP_INI || path.join(SCRATCH, 'php.ini');
const MOODLE_CONFIG = process.env.MOODLE_CONFIG || path.join(SCRATCH, 'source', 'config.php');
const BRIDGE = path.resolve(__dirname, 'moodle-purify.php');

function purifyMany(htmls) {
  for (const [label, p] of [['PHP_BIN', PHP_BIN], ['PHP_INI', PHP_INI], ['MOODLE_CONFIG', MOODLE_CONFIG]]) {
    if (!fs.existsSync(p)) throw new Error(`MOODLE_PURIFY_UNAVAILABLE: ${label} no existe (${p})`);
  }
  const r = spawnSync(PHP_BIN, ['-c', PHP_INI, BRIDGE], {
    input: JSON.stringify(htmls),
    env: { ...process.env, MOODLE_CONFIG },
    maxBuffer: 512 * 1024 * 1024,
    encoding: 'utf8',
  });
  if (r.status !== 0) {
    throw new Error(`MOODLE_PURIFY_FAILED: exit ${r.status}: ${(r.stderr || '').slice(0, 800)} ${(r.stdout || '').slice(0, 400)}`);
  }
  let out;
  try {
    out = JSON.parse(r.stdout);
  } catch (e) {
    throw new Error(`MOODLE_PURIFY_FAILED: salida no JSON: ${(r.stdout || '').slice(0, 400)}`);
  }
  if (!Array.isArray(out) || out.length !== htmls.length) throw new Error('MOODLE_PURIFY_FAILED: cantidad de resultados distinta');
  return out;
}

const FORMAT_BRIDGE = path.resolve(__dirname, 'moodle-format.php');

/** format_text() con filtros (ver moodle-format.php). */
function moodleFormat(payload) {
  for (const [label, p] of [['PHP_BIN', PHP_BIN], ['PHP_INI', PHP_INI], ['MOODLE_CONFIG', MOODLE_CONFIG]]) {
    if (!fs.existsSync(p)) throw new Error(`MOODLE_FORMAT_UNAVAILABLE: ${label} no existe (${p})`);
  }
  const r = spawnSync(PHP_BIN, ['-c', PHP_INI, FORMAT_BRIDGE], {
    input: JSON.stringify(payload),
    env: { ...process.env, MOODLE_CONFIG },
    maxBuffer: 512 * 1024 * 1024,
    encoding: 'utf8',
  });
  if (r.status !== 0) {
    throw new Error(`MOODLE_FORMAT_FAILED: exit ${r.status}: ${(r.stderr || '').slice(0, 800)} ${(r.stdout || '').slice(0, 400)}`);
  }
  try {
    return JSON.parse(r.stdout);
  } catch (e) {
    throw new Error(`MOODLE_FORMAT_FAILED: salida no JSON: ${(r.stdout || '').slice(0, 400)}`);
  }
}

module.exports = { purifyMany, moodleFormat, PHP_BIN, PHP_INI, MOODLE_CONFIG };
