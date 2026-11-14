#!/usr/bin/env node
/* eslint-disable no-console */
// r109 M3c · caja «Requisitos obligatorios» del docente. Sin red, sin base y sin proveedores (USD 0): funciones puras de dist/.
//
//   BX1  el lector entiende la forma DESIGUAL (4 / 7 / 4 / 5) en cada frase del brief, con o sin títulos de módulo
//   BX2  títulos parciales: null en los módulos que no los traen; sin títulos, ningún campo nuevo
//   BX3  declarativo: «28 horas» en la caja es un requisito; el mismo texto como DOCUMENTO sigue siendo «sin disparador»
//   BX4  lo entendido («Entendí: 4 módulos · capítulos 4 / 7 / 4 / 5 · 28 h») y lo NO entendido, línea por línea
//   BX5  autoridad: la caja gana a un documento N × M (misma key / misma estructura) y el documento queda inactivo con aviso
//   BX6  caja vacía = sin caja: la MISMA vista (y borrar la caja la quita); el lector de documentos da lo mismo que staging
//   BX7  structure-options recomienda la forma de la caja («viene de tus requisitos»); sin caja, la respuesta de staging
//   BX8  la propuesta y la vista previa llevan los títulos de la caja; las diferencias dicen «Tus requisitos establecen»
//   BX9  fuera de los topes (50 módulos, 30 capítulos por módulo): conflicto CRÍTICO explícito en la verificación
//   BX10 la verificación habla de «tus requisitos obligatorios», no «del documento», con la misma severidad
//   BX11 API: guardar / leer / borrar la caja, tope de largo, dueño del curso, sin IA
//   BX12 sin regresión: lector de documentos, vista, structure-options y verificación = origin/staging (golden o --base)
//
// Uso: npm run build && node scripts/r109/check-r109-requirements-box.js --ci [--dist dist] [--base <dist de origin/staging>]
//      node scripts/r109/check-r109-requirements-box.js --bite          (cada mordida tiene que hacer fallar --ci)
//      node scripts/r109/check-r109-requirements-box.js --write-golden --base <dist de origin/staging>
'use strict';
require('reflect-metadata');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const REPO = path.resolve(__dirname, '..', '..');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const DIST = path.resolve(arg('--dist', path.join(REPO, 'dist')));
const BASE = arg('--base', null) ? path.resolve(arg('--base')) : null;
const GOLDEN = path.join(REPO, 'scripts/fixtures/r109/requirements-box-golden.json');

if (process.argv.includes('--bite')) {
  const bites = [
    { name: 'la caja no tiene prioridad sobre el documento', file: 'modules/academic-context/requirements/requirements-box.js', from: 'if (!it.applies)\n            return it;', to: 'return it;' },
    { name: 'el lector solo entiende N × M (sin forma desigual)', file: 'modules/academic-context/requirements/requirements-extractor.js', from: '(0, uneven_structure_1.findUnevenStructure)(eligible, declarative)', to: 'null' },
    { name: 'la caja no es declarativa (sin «28 horas»)', file: 'modules/academic-context/requirements/requirements-extractor.js', from: 'if (declarative && !obligation && !inferred && mentions.length)', to: 'if (false)' },
    { name: 'structure-options no recomienda la forma de la caja', file: 'modules/course-design/structure-options.js', from: 'const un = s.structure.find((r) => fromBox(r) &&', to: 'const un = s.structure.find((r) => false &&' },
    { name: 'el tope excedido no es un conflicto crítico', file: 'modules/academic-context/requirements/requirement-authority.js', from: 'if (reasons.length) {', to: 'if (false) {' },
    { name: 'los módulos propuestos no llevan los títulos de la caja', file: 'modules/academic-context/requirements/requirements-box.js', from: 'return st ? [...st.moduleTitles] : null;', to: 'return null;' },
    { name: 'el documento reemplazado queda sin aviso', file: 'modules/academic-context/requirements/requirements-box.js', from: 'La caja de requisitos reemplaza a', to: 'x' },
    { name: 'lo que no se entiende se calla', file: 'modules/academic-context/requirements/requirements-box.js', from: 'notUnderstood.sort(', to: 'notUnderstood.splice(0); notUnderstood.sort(' },
    { name: 'la verificación sigue diciendo «del documento» a un requisito de la caja', file: 'modules/academic-context/requirements/requirement-authority.js', from: 'if (!boxReqs.length)', to: 'if (true)' },
    { name: 'una lista «capítulos 3, 4 y 5» se lee como estructura (sin «por módulo»)', file: 'modules/academic-context/requirements/uneven-structure.js', from: 'por\\\\s+(?:cada\\\\s+)?m[oó]dulo\\\\s*(?:', to: '(?:por\\\\s+m[oó]dulo\\\\s*)?(?:' },
    { name: 'la caja parcial deja viva la structure del documento', file: 'modules/academic-context/requirements/requirements-box.js', from: 'function contradictsBoxCount(doc, boxWins) {', to: 'function contradictsBoxCount(doc, boxWins) {\n    return false;' },
    { name: 'una caja «aproximadamente» quita un mínimo obligatorio', file: 'modules/academic-context/requirements/requirements-box.js', from: "if (by.obligation !== 'required' && it.obligation === 'required')", to: 'if (false)' },
    { name: 'una caja vacía cambia la vista', file: 'modules/academic-context/requirements/requirements-box.js', from: 'if (!box)\n        return view;', to: 'if (!box)\n        return { ...view, items: [...view.items] };' },
  ];
  const tmp = fs.mkdtempSync(path.join(REPO, '.r109-bite-'));
  let code = 0;
  try {
    for (const b of bites) {
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.cpSync(DIST, tmp, { recursive: true });
      const f = path.join(tmp, b.file);
      const src = fs.readFileSync(f, 'utf8');
      if (!src.includes(b.from)) { console.log(`❌ mordida «${b.name}»: no encontré el código`); code = 1; continue; }
      fs.writeFileSync(f, src.split(b.from).join(b.to));
      const r = spawnSync(process.execPath, [__filename, '--ci', '--dist', tmp], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      const bit = r.status !== 0 && /❌/.test(r.stdout || '');
      console.log(bit ? `✅ mordida «${b.name}»: el check FALLA (${((r.stdout || '').match(/❌ [^\n]*/g) || []).slice(0, 2).join(' · ').slice(0, 200)})` : `❌ mordida «${b.name}»: NO hizo fallar el check`);
      if (!bit) code = 1;
    }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  process.exit(code);
}

// ── Red bloqueada (USD 0) ──
const netAttempts = [];
{
  const deny = (what) => function () { netAttempts.push(what); throw new Error(`red prohibida: ${what}`); };
  for (const mod of ['http', 'https']) { const m = require(mod); m.request = deny(`${mod}.request`); m.get = deny(`${mod}.get`); }
  const net = require('net'); net.connect = deny('net.connect'); net.createConnection = deny('net.createConnection');
  const tls = require('tls'); tls.connect = deny('tls.connect');
  globalThis.fetch = deny('fetch');
}
const { Logger } = require('@nestjs/common');
Logger.overrideLogger(false);

let ok = 0; let fail = 0;
async function check(name, fn) { try { await fn(); ok++; console.log(`✅ ${name}`); } catch (e) { fail++; console.log(`❌ ${name}\n   ${String((e && e.stack) || e).split('\n').slice(0, 6).join('\n   ')}`); } }
const assert = (c, m) => { if (!c) throw new Error(m || 'falló'); };
const eq = (a, b, m) => { const x = JSON.stringify(a); const y = JSON.stringify(b); if (x !== y) throw new Error(`${m || ''}: esperado ${y}, encontrado ${x}`); };
const sha = (o) => crypto.createHash('sha256').update(JSON.stringify(o)).digest('hex');
const loader = (root) => (rel) => { try { return require(path.join(root, rel)); } catch (e) { console.error(`❌ No se pudo cargar ${rel} de ${root} (¿npm run build?): ${e.message}`); process.exit(1); } };
const L = loader(DIST);
const clone = (o) => JSON.parse(JSON.stringify(o));

// ── Frases del brief ──
const BOX_EXAMPLE = '4 módulos: Movilidad segura 4 capítulos, Normas de tránsito 7 capítulos, Señalización 4 capítulos, El vehículo 5 capítulos. 28 horas.';
const TITLES = ['Movilidad segura', 'Normas de tránsito', 'Señalización', 'El vehículo'];
const PHRASES = [
  { name: 'ejemplo del placeholder (módulos con título y capítulos, + horas)', text: BOX_EXAMPLE, titles: TITLES, hours: 28 },
  { name: '«4 módulos con 4, 7, 4 y 5 capítulos»', text: '4 módulos con 4, 7, 4 y 5 capítulos', titles: null },
  { name: '«Módulo 1: 4 capítulos / Módulo 2: 7 capítulos …»', text: 'Módulo 1: 4 capítulos / Módulo 2: 7 capítulos / Módulo 3: 4 capítulos / Módulo 4: 5 capítulos', titles: null },
  { name: 'un módulo por renglón, con título («Movilidad segura: 4 capítulos», «Normas de tránsito – 7 capítulos»)', text: 'Movilidad segura: 4 capítulos\nNormas de tránsito – 7 capítulos\nSeñalización: 4 capítulos\nEl vehículo - 5 capítulos\n28 horas', titles: TITLES, hours: 28 },
  { name: 'lista tras «capítulos por módulo»', text: '4 módulos y 28 horas. Capítulos por módulo: 4 / 7 / 4 / 5', titles: null, hours: 28 },
  { name: 'con renglones de otra cosa antes y después', text: 'Quiero que sea práctico\n4 módulos con 4, 7, 4 y 5 capítulos\nlos videos son opcionales', titles: null },
];

// ── Lectura de la caja y de documentos ──
function readers(root) {
  const R = loader(root);
  const X = R('modules/academic-context/requirements/requirements-extractor.js');
  const T = R('modules/academic-context/extract/text-sources.js');
  const lines = (txt) => T.readText(Buffer.from(txt), 'text/plain').lines;
  return { R, X, T, lines };
}
const { R: _R, X: XN, lines: linesN } = readers(DIST);
const BOXM = L('modules/academic-context/requirements/requirements-box.js');
const DOCR = L('modules/academic-context/requirements/document-requirements.js');
const AUTH = L('modules/academic-context/requirements/requirement-authority.js');
const SO = L('modules/course-design/structure-options.js');
const CD = L('modules/academic-context/context-design.js');
const boxReqs = (text) => BOXM.extractBox(text).requirements;
const shapeOf = (text) => { const s = boxReqs(text).find((r) => r.kind === 'structure'); return s ? { shape: s.shape, titles: s.moduleTitles || null, confidence: s.confidence, obligation: s.obligation } : null; };

// Documentos de prueba (sintéticos): el lector de documentos tiene que dar lo mismo que en staging.
const DOC_CORPUS = {
  nxm: 'El curso tendrá 4 módulos con 5 capítulos cada uno. El curso tendrá como mínimo 40 horas de trabajo del estudiante.',
  nxm2: 'Estructura: 3 módulos × 4 capítulos.\nCada capítulo tendrá 2 videos.\nEl curso tendrá 3 evaluaciones parciales y 1 evaluación final.',
  ficha: 'Número de módulos: 4\nCapítulos por módulo: 5\nIntensidad horaria total: 64 horas',
  minmax: 'El curso tendrá como mínimo 4 capítulos por módulo. El curso tendrá como máximo 3 capítulos por módulo.',
  hours: 'La intensidad horaria total será de 64 horas.\nEl curso tendrá entre 40 y 44 horas.',
  sml: 'Opción S: 2 módulos, 3 capítulos por módulo\nOpción M: 3 módulos, 4 capítulos por módulo\nOpción L: 4 módulos, 5 capítulos por módulo',
  unevenDoc: 'El curso deberá tener 4 módulos con 4, 5, 4 y 4 capítulos.',
  moduleN: 'Módulo 1: 4 capítulos\nMódulo 2: 5 capítulos\nMódulo 3: 4 capítulos',
  noTrigger: 'Contenido: 4 capítulos por módulo\nDuración: 28 horas\nIntroducción: 2 capítulos',
  example: 'Ejemplo: un curso de 4 módulos con 4, 7, 4 y 5 capítulos.',
  approx: 'El curso tendrá aproximadamente 28 horas y alrededor de 4 módulos.',
  videos: 'No se requieren videos. Las actividades interactivas serán 8.',
};

const INTENTIONAL = ['unevenDoc', 'moduleN'];

async function main() {
  // ── BX1 ──
  await check('BX1 el lector entiende la forma desigual en cada frase del brief: shape [4,7,4,5] (con títulos cuando vienen)', () => {
    for (const p of PHRASES) {
      const s = shapeOf(p.text);
      assert(s, `${p.name}: no produjo un requisito structure`);
      eq(s.shape, [4, 7, 4, 5], p.name);
      eq(s.titles, p.titles, `${p.name}: títulos`);
      eq([s.obligation, s.confidence], ['required', 'high'], `${p.name}: la caja manda (obligatorio, confianza alta)`);
      const h = boxReqs(p.text).find((r) => r.kind === 'target_hours');
      eq(h ? h.value : null, p.hours ?? null, `${p.name}: horas`);
      // Nada de capítulos o módulos sueltos que contradigan la forma.
      const stray = boxReqs(p.text).filter((r) => r.kind === 'chapters' || r.kind === 'modules');
      eq(stray.length, 0, `${p.name}: sin «capítulos»/«módulos» sueltos`);
    }
    // El mismo texto leído como DOCUMENTO (sin disparador) queda de confianza media: no tiene autoridad.
    const asDoc = XN.extractRequirements(linesN('4 módulos con 4, 7, 4 y 5 capítulos'), 'doc');
    eq(asDoc.requirements.find((r) => r.kind === 'structure').confidence, 'medium', 'documento sin verbo: medio');
    // Un DOCUMENTO con la forma desigual también la entiende (con verbo: confianza alta; «Módulo N:» sin verbo: media).
    const du = XN.extractRequirements(linesN(DOC_CORPUS.unevenDoc), 'D1').requirements.find((r) => r.kind === 'structure');
    eq([du.shape, du.confidence], [[4, 5, 4, 4], 'high'], 'documento con verbo');
    const dm = XN.extractRequirements(linesN(DOC_CORPUS.moduleN), 'D1').requirements.find((r) => r.kind === 'structure');
    eq([dm.shape, dm.confidence], [[4, 5, 4], 'medium'], 'documento con «Módulo N:»');
    // Lo que NO es una forma desigual no se confunde con una («mínimo 4 … máximo 3 capítulos por módulo»).
    assert(!XN.extractRequirements(linesN(DOC_CORPUS.minmax), 'D1').requirements.some((r) => r.kind === 'structure'), 'mínimo/máximo no es una forma');
    assert(!XN.extractRequirements(linesN(DOC_CORPUS.noTrigger), 'D1').requirements.some((r) => r.kind === 'structure'), 'rótulos sueltos de un documento no son una forma');
  });

  // ── BX1b (ronda 1, P1-1) ──
  await check('BX1b referencias ordinales («capítulos 3, 4 y 5 del texto», «Capítulos 1, 2 y 7») NO son estructura, ni en documentos ni en la caja', () => {
    const REFS = [
      'Los estudiantes deberán leer los capítulos 3, 4 y 5 del texto guía.',
      'Lectura obligatoria: capítulos 2 y 3 del libro de Pérez (2019).',
      'Bibliografía: Smith, J. (2010). Gestión. Capítulos 1, 2 y 7.',
      'El curso incluye los capítulos 2 y 5 del manual.',
      'Semana 1 y 2: capítulos 1 y 2. Semana 3: capítulo 3.',
      'Lee los capítulos 4 y 6 del documento de apoyo.',
      'Ver capítulos 1 y 3 en la guía.',
    ];
    for (const t of REFS) {
      assert(!XN.extractRequirements(linesN(t), 'D1').requirements.some((r) => r.kind === 'structure'), `documento: «${t}» no es una forma`);
      assert(!boxReqs(t).some((r) => r.kind === 'structure'), `caja: «${t}» no es una forma`);
    }
    // Un documento solo declara la lista con «N módulos» que coincide, o «capítulos por módulo».
    const okDoc = (t) => XN.extractRequirements(linesN(t), 'D1').requirements.find((r) => r.kind === 'structure');
    eq(okDoc('El curso deberá tener 4 módulos con 4, 5, 4 y 4 capítulos.').shape, [4, 5, 4, 4], 'N módulos coincide');
    eq(okDoc('El curso deberá tener 4 módulos con 4, 5 y 4 capítulos.'), undefined, 'N módulos no coincide: el documento no se toca');
    eq(okDoc('El curso tendrá 4 módulos. Capítulos por módulo: 4 / 5 / 4 / 4.').shape, [4, 5, 4, 4], '«capítulos por módulo»');
  });

  // ── BX2 ──
  await check('BX2 títulos parciales: null en los módulos que faltan; sin títulos no hay campo nuevo', () => {
    const s = shapeOf('Movilidad segura: 4 capítulos\n7 capítulos\nSeñalización: 4 capítulos');
    eq(s.shape, [4, 7, 4], 'forma');
    eq(s.titles, ['Movilidad segura', null, 'Señalización'], 'null donde no hay título');
    const plain = boxReqs('4 módulos con 4, 7, 4 y 5 capítulos').find((r) => r.kind === 'structure');
    assert(!('moduleTitles' in plain), 'sin títulos, sin moduleTitles');
    // Módulo N / Unidad N no es un título.
    eq(shapeOf('Módulo 1: 4 capítulos / Módulo 2: 7 capítulos').titles, null, '«Módulo 1» no es un título');
    // Horas por módulo: no se aplican (M4) ni se leen como horas del curso.
    const m = boxReqs('Movilidad segura: 4 capítulos - 6 horas\nNormas: 7 capítulos - 8 horas\n28 horas');
    eq(m.filter((r) => r.kind === 'target_hours').map((r) => r.value), [28], 'solo las 28 h del curso');
    eq(m.find((r) => r.kind === 'structure').shape, [4, 7], 'la forma con horas por módulo');
  });

  // ── BX3 ──
  await check('BX3 declarativo: «28 horas» y «4 módulos con 5 capítulos» son requisitos de la caja; como documento no lo son', () => {
    const b = boxReqs('4 módulos con 5 capítulos cada uno\n20 horas');
    eq(b.find((r) => r.kind === 'structure').shape, [5, 5, 5, 5], 'N × M sigue leyéndose');
    assert(b.every((r) => r.confidence === 'high' && r.obligation === 'required'), 'todo con autoridad');
    eq(b.find((r) => r.kind === 'target_hours').value, 20, 'horas');
    const d = XN.extractRequirements(linesN('20 horas'), 'doc');
    eq(d.requirements.length, 0, 'como documento: sin disparador, sin requisito');
    eq(d.ignored.map((x) => x.reason), ['no_trigger'], 'queda registrada');
    // «aproximadamente»: una preferencia, nunca un exacto obligatorio (también en la caja).
    const a = boxReqs('aproximadamente 28 horas').find((r) => r.kind === 'target_hours');
    eq([a.mode, a.obligation], ['approx', 'recommended'], 'aproximado');
  });

  // ── Vistas de requisitos (documento + caja) ──
  const docEntry = (text, name = 'microcurriculo.docx') => {
    const x = XN.extractRequirements(linesN(text), 'D1');
    const docs = [{ id: 'D1', name, sha256: 'a'.repeat(64) }];
    return { docs, entry: DOCR.storedEntry(docs, x, '2026-11-14T00:00:00.000Z') };
  };
  const viewOf = (docText, boxText) => {
    const base = docText ? (() => { const { docs, entry } = docEntry(docText); return DOCR.buildRequirementsView([entry], null, docs); })() : DOCR.buildRequirementsView([], null, []);
    return BOXM.applyBoxToView(base, boxText ? { version: 1, text: boxText, at: '2026-11-14T00:00:00.000Z' } : null);
  };

  // ── BX4 ──
  await check('BX4 «Entendí» y «No entendí»: el resumen, cada línea y lo que no se convirtió en requisito', () => {
    const v = viewOf(null, BOX_EXAMPLE);
    eq(v.box.understood.summary, '4 módulos · capítulos 4 / 7 / 4 / 5 · 28 h', 'resumen');
    eq(v.box.understood.shape, [4, 7, 4, 5], 'forma');
    eq(v.box.understood.moduleTitles, TITLES, 'títulos');
    eq(v.box.understood.hours, 28, 'horas');
    eq(v.box.notUnderstood, [], 'todo se entendió');
    eq(v.state, 'current', 'con requisitos de la caja la vista vale aunque no haya documento');
    const messy = '4 módulos con 4, 7, 4 y 5 capítulos\nQuiero que sea divertido y moderno\n3 módulos con 4 y 7 capítulos de relleno';
    const w = viewOf(null, messy);
    const nu = w.box.notUnderstood;
    assert(nu.some((n) => n.line === 2 && /divertido/.test(n.text)), 'la línea de relleno aparece como «No entendí»: ' + JSON.stringify(nu));
    const hpm = viewOf(null, 'Módulo 1: 4 capítulos (6 h), Módulo 2: 7 capítulos (8 h)\n13 horas');
    assert(hpm.box.notUnderstood.some((n) => /horas por módulo \(próximamente\)/.test(n.reason)), 'horas por módulo: «No entendí todavía … (próximamente)»: ' + JSON.stringify(hpm.box.notUnderstood));
    eq(hpm.items.filter((i) => i.kind === 'target_hours').map((i) => i.value), [13], 'las horas por módulo no se vuelven horas del curso (solo las 13 h)');
    // Dos formas distintas en la caja: se leen las dos y queda un conflicto visible (nunca se elige una en silencio).
    const two = viewOf(null, '4 módulos con 4, 7, 4 y 5 capítulos\n3 módulos con 4, 4 y 4 capítulos');
    assert(two.box.conflicts.length === 1 && /^La caja de requisitos dice dos cosas distintas sobre la estructura/.test(two.box.conflicts[0].message), JSON.stringify(two.box.conflicts));
    const inc = viewOf(null, '3 módulos con 4 y 7 capítulos');
    assert(inc.box.notUnderstood.some((n) => n.line === 1 && /cantidad de módulos/.test(n.reason)), 'módulos que no cuadran con lo listado: ' + JSON.stringify(inc.box.notUnderstood));
    assert(!inc.items.some((i) => i.kind === 'structure'), 'y no se inventa una estructura');
    eq(BOXM.boxRequirementText(w.items.find((i) => i.fromBox && i.kind === 'structure')), '4 módulos · capítulos 4 / 7 / 4 / 5', 'línea de lo entendido');
  });

  // ── BX5 ──
  await check('BX5 autoridad: la caja gana al documento N × M (con aviso visible) y sin choque no toca nada', () => {
    const doc = 'El curso tendrá 4 módulos con 5 capítulos cada uno. El curso tendrá como mínimo 40 horas de trabajo del estudiante.';
    const base = viewOf(doc, null);
    const v = viewOf(doc, BOX_EXAMPLE);
    const byKind = (view, k, own) => view.items.filter((i) => i.kind === k && (own === undefined || !!i.fromBox === own));
    for (const k of ['structure', 'modules', 'chapters']) {
      for (const it of byKind(v, k, false)) {
        eq([it.applies, it.active, it.overriddenByBox], [false, false, true], `${k} del documento: inactivo y reemplazado`);
        assert(it.review.some((x) => /^La caja de requisitos reemplaza a «.+» del documento\.$/.test(x)), `${k}: aviso visible en review: ${JSON.stringify(it.review)}`);
      }
    }
    // La meta del documento (mínimo 40 h) y la de la caja (28 h): misma key, gana la caja.
    const docHours = byKind(v, 'target_hours', false);
    assert(docHours.length && docHours.every((i) => i.overriddenByBox && !i.applies), 'horas del documento reemplazadas por las de la caja');
    eq(byKind(v, 'structure', true).map((i) => [i.applies, i.shape]), [[true, [4, 7, 4, 5]]], 'la caja aplica');
    eq(v.box.overrides.length >= 3, true, 'cada reemplazo queda listado: ' + v.box.overrides.length);
    for (const o of v.box.overrides) assert(/^La caja de requisitos reemplaza a «/.test(o.message), o.message);
    // Lo que NO choca queda activo (nunca se descarta de más).
    const w = viewOf('El curso tendrá 3 evaluaciones parciales. Cada capítulo tendrá 2 videos.', BOX_EXAMPLE);
    assert(w.items.filter((i) => !i.fromBox && (i.kind === 'evaluations' || i.kind === 'videos')).every((i) => i.applies && !i.overriddenByBox), 'evaluaciones y videos del documento siguen aplicando');
    // P1-2: una caja PARCIAL reemplaza también la `structure` del documento que contradice (misma frase), y la forma que
    // recomienda «tus requisitos» cumple todo lo activo (0 conflictos).
    const nxm = 'El curso tendrá 4 módulos con 5 capítulos cada uno.';
    for (const [boxText, want] of [['3 módulos', [3, 5]], ['6 capítulos por módulo', [4, 6]]]) {
      const pv = viewOf(nxm, boxText);
      const docStruct = pv.items.find((i) => !i.fromBox && i.kind === 'structure');
      eq([docStruct.applies, docStruct.overriddenByBox], [false, true], `${boxText}: la structure del documento queda reemplazada`);
      assert(docStruct.review.some((x) => /^La caja de requisitos reemplaza a «/.test(x)), `${boxText}: con aviso`);
      const reqs = pv.items.filter((i) => i.applies && i.obligation === 'required' && i.confidence === 'high');
      const rec = SO.recommendShape(reqs, null, null);
      eq([rec.modules, rec.chaptersPerModule, rec.origin], [want[0], want[1], 'teacher_box'], `${boxText}: recomendada`);
      eq(SO.shapeDifferences(reqs, { modules: rec.modules, chaptersPerModule: rec.chaptersPerModule }, null), [], `${boxText}: la forma recomendada cumple todo lo activo (0 conflictos)`);
    }
    // Una caja que NO contradice (4 módulos) no toca la structure del documento.
    const same = viewOf(nxm, '4 módulos').items.find((i) => !i.fromBox && i.kind === 'structure');
    eq([same.applies, !!same.overriddenByBox], [true, false], '4 módulos no contradice 4 × 5');
    // P2-3: «aproximadamente» no quita un mínimo obligatorio.
    const ap = viewOf('El curso tendrá como mínimo 40 horas de trabajo del estudiante.', 'aproximadamente 28 horas').items.find((i) => !i.fromBox && i.kind === 'target_hours');
    eq([ap.applies, !!ap.overriddenByBox], [true, false], 'el mínimo obligatorio sigue');
    // P2-2: un documento sin lectura de requisitos (stale) se sigue diciendo aunque haya caja.
    const stale = BOXM.applyBoxToView(DOCR.buildRequirementsView([], null, [{ sha256: 'c'.repeat(64) }]), { version: 1, text: '28 horas', at: '' });
    eq(stale.state, 'stale', 'stale se conserva');
    // Los requisitos que aplican (los que ve el diseño): solo la caja decide la estructura.
    const applying = v.items.filter((i) => i.applies && (i.kind === 'structure' || i.kind === 'modules' || i.kind === 'chapters'));
    assert(applying.every((i) => i.fromBox), 'solo la caja decide módulos y capítulos');
    // Sin documento: la caja sola.
    const solo = viewOf(null, BOX_EXAMPLE);
    assert(solo.items.every((i) => i.fromBox), 'solo requisitos de la caja');
    eq(solo.items.find((i) => i.kind === 'structure').documentName, 'Requisitos del docente', 'la fuente propia');
    eq(solo.items.find((i) => i.kind === 'structure').source.documentId, BOXM.BOX_DOCUMENT_ID, 'source.documentId reservado');
  });

  // ── BX6 ──
  await check('BX6 caja vacía = sin caja: la misma vista; borrar la caja la quita', async () => {
    const doc = DOC_CORPUS.nxm;
    const { docs, entry } = docEntry(doc);
    const plain = DOCR.buildRequirementsView([entry], null, docs);
    assert(BOXM.applyBoxToView(plain, null) === plain, 'sin caja devuelve la MISMA vista');
    eq(BOXM.parseBox(''), null, 'texto vacío');
    eq(BOXM.parseBox({ version: 1, text: '   ', at: '' }), null, 'solo espacios');
    eq(BOXM.parseBox(JSON.stringify({ version: 1, text: 'x', at: 'y' })).text, 'x', 'jsonb como texto');
    assert(!('box' in plain), 'la vista sin caja no trae el campo');
    // Autoridad sin caja: la misma que antes.
    const q = async (sql) => (/documentRequirements/.test(sql) ? [{ r: { version: 1, entries: [entry] }, s: null, b: null }] : []);
    const a = await AUTH.loadRequirementAuthority({ query: q }, 1, docs);
    eq(a.view, plain, 'loadRequirementAuthority sin caja = la vista del documento');
    // Con caja, la autoridad la trae.
    const qb = async (sql) => (/documentRequirements/.test(sql) ? [{ r: { version: 1, entries: [entry] }, s: null, b: { version: 1, text: BOX_EXAMPLE, at: '' } }] : []);
    const b = await AUTH.loadRequirementAuthority({ query: qb }, 1, docs);
    eq(b.required.filter((r) => r.kind === 'structure').map((r) => r.shape), [[4, 7, 4, 5]], 'required: la forma de la caja');
    eq(AUTH.requiredContentShape(b.required), [4, 7, 4, 5], 'requiredContentShape = la caja (no 4 × 5)');
    eq(AUTH.constraintsFor(b.required, {}).modulesFixed, 4, 'el distribuidor ve 4 módulos');
  });

  // ── Contextos para structure-options ──
  const FIX = async () => {
    const E = L('modules/academic-context/extract/extractor.js');
    const AF = require(path.join(REPO, 'scripts/lib/academic-fixtures.js'));
    const costos = (await E.extractAcademicContext([{ name: 'c.docx', data: await AF.fixture('consistent', 'docx') }])).context;
    const UN = [
      { t: 'Movilidad segura y actores viales', ra: ['RA1'], n: 4 }, { t: 'Normas de tránsito', ra: ['RA2'], n: 7 },
      { t: 'Señalización', ra: ['RA3'], n: 4 }, { t: 'El vehículo', ra: ['RA4'], n: 5 },
    ];
    const c = clone(costos);
    c.outcomes = ['Identificar los factores de riesgo.', 'Aplicar las normas de tránsito.', 'Interpretar la señalización.', 'Revisar el vehículo.'].map((t, i) => ({ ...clone(costos.outcomes[0]), id: `RA${i + 1}`, text: t }));
    c.competencies = [{ ...clone(costos.competencies[0]), text: 'Conduce de forma segura.' }];
    const keep = new Set(c.outcomes.map((o) => o.id).concat(c.competencies.map((x) => x.id)));
    c.evaluation = c.evaluation.map((e) => ({ ...e, outcomeIds: (e.outcomeIds || []).filter((id) => keep.has(id)) }));
    const src0 = clone(costos.units[0].contents[0]);
    c.units = UN.map((u, i) => ({ ...clone(costos.units[0]), id: `U${i + 1}`, title: u.t, hours: null, outcomeIds: u.ra, contents: Array.from({ length: u.n }, (_, j) => ({ ...src0, id: `U${i + 1}.${j + 1}`, text: `${u.t}: tema ${j + 1}`, outcomeIds: [] })) }));
    return { costos, a1a2: c };
  };
  const ctxs = await FIX();

  /** structure-options con el servicio REAL y lecturas simuladas (contexto guardado + requisitos del documento + caja). */
  async function optionsOf(root, ctx, { docText, boxText } = {}) {
    const RR = loader(root);
    const FEAT = RR('modules/features/dynamic-features.js');
    const AC = RR('modules/academic-context/academic-context.js');
    const SVC = RR('modules/course-design/course-design.service.js');
    const DR = RR('modules/academic-context/requirements/document-requirements.js');
    const XX = RR('modules/academic-context/requirements/requirements-extractor.js');
    const TT = RR('modules/academic-context/extract/text-sources.js');
    process.env[FEAT.DYNAMIC_FLAG_ENV] = 'true';
    process.env[FEAT.GENERAL_AVAILABILITY_ENV] = 'true';
    const stored = AC.normalizeAcademicContext(clone(ctx));
    let row = null;
    if (docText) {
      const x = XX.extractRequirements(TT.readText(Buffer.from(docText), 'text/plain').lines, 'D1');
      const docs = stored.documents.map((d) => ({ id: d.id, name: d.name, sha256: d.sha256 }));
      row = { r: { version: 1, entries: [DR.storedEntry(docs, { ...x, requirements: x.requirements.map((r) => ({ ...r, source: { ...r.source, documentId: docs[0].id } })) }, '2026-11-14T00:00:00.000Z')] }, s: null, b: null };
    }
    if (boxText) row = { ...(row || { r: null, s: null }), b: { version: 1, text: boxText, at: '2026-11-14T00:00:00.000Z' } };
    const svc = Object.create(SVC.CourseDesignService.prototype);
    svc.loadCourse = async () => {};
    svc.dataSource = {
      query: async (sql) => {
        if (/from public\.course_profiles/.test(sql) && /'academic'/.test(sql)) return [{ id: 1, version: 3, data: stored, sha256: AC.academicContextSha256(stored) }];
        if (/metadata -> 'documentRequirements'/.test(sql)) return row ? [row] : [];
        return [];
      },
    };
    return svc.structureOptions(1, 'owner');
  }

  // ── BX7 ──
  await check('BX7 structure-options recomienda la forma de la caja («tus requisitos»); sin caja, la respuesta de siempre', async () => {
    const o = await optionsOf(DIST, ctxs.a1a2, { boxText: BOX_EXAMPLE });
    eq(o.recommended.moduleChapters, [4, 7, 4, 5], 'recomendada = la caja');
    eq([o.recommended.modules, o.recommended.chaptersPerModule], [4, 7], 'modules y tope por módulo');
    eq(o.recommended.origin, 'teacher_box', 'origen: tus requisitos');
    eq(o.recommended.moduleTitles, TITLES, 'con los títulos de la caja');
    assert(/escribiste en tus requisitos/.test(o.recommended.reason), o.recommended.reason);
    eq(o.requirements.structure.length, 1, 'el requisito de la caja aparece en la lista de requisitos');
    // Documento N × M + caja: gana la caja.
    const w = await optionsOf(DIST, ctxs.a1a2, { docText: 'El curso tendrá 4 módulos con 5 capítulos cada uno.', boxText: BOX_EXAMPLE });
    eq(w.recommended.moduleChapters, [4, 7, 4, 5], 'documento 4 × 5 + caja: gana la caja');
    eq(w.recommended.origin, 'teacher_box', 'origen');
    // Una caja N × M también dice de dónde viene.
    const nm = await optionsOf(DIST, ctxs.a1a2, { boxText: '3 módulos con 4 capítulos cada uno' });
    eq([nm.recommended.modules, nm.recommended.chaptersPerModule, nm.recommended.origin], [3, 4, 'teacher_box'], 'N × M de la caja');
    // Sin caja: sin campos nuevos.
    const none = await optionsOf(DIST, ctxs.a1a2, {});
    assert(!('origin' in none.recommended) && !('moduleTitles' in none.recommended), 'sin caja, `recommended` no cambia');
    // «Como el documento» (M3b) sigue aparte y no la pisa la caja (la caja la contradice: no se ofrece o se ofrece si coincide).
    eq(o.documentRecommendation.moduleChapters, [4, 7, 4, 5], 'la forma «como el documento» de los contextos coincide con la caja');
  });

  // ── BX8 ──
  await check('BX8 propuesta y vista previa: los módulos llevan los títulos de la caja; «Tus requisitos establecen»', () => {
    const required = (text) => BOXM.extractBox(text).requirements.filter((r) => r.obligation === 'required' && r.confidence === 'high');
    const reqs = required(BOX_EXAMPLE);
    const shape = CD.normalizeShape({ moduleChapters: [4, 7, 4, 5] });
    const p = SO.structurePreviewOf(ctxs.a1a2, reqs, shape, null);
    eq(p.plan.map((m) => m.title), TITLES, 'módulos con los títulos de la caja');
    eq(p.plan.map((m) => m.chapters.length), [4, 7, 4, 5], 'capítulos por módulo');
    eq(p.differences, [], 'la forma de la caja no se aparta de la caja');
    eq(p.coverage.total, p.coverage.assigned, 'cada contenido en un capítulo');
    // Otra forma: se dice quién lo pide.
    const other = SO.structurePreviewOf(ctxs.a1a2, reqs, CD.normalizeShape({ modules: 4, chaptersPerModule: 5 }), null);
    assert(other.differences.length && other.differences.every((d) => /^Tus requisitos establecen /.test(d.text)), JSON.stringify(other.differences));
    eq(other.plan.map((m) => m.title).join('|') === TITLES.join('|'), false, 'otra forma: no reutiliza los títulos');
    // Sin caja (un documento): como siempre.
    const docOnly = SO.structurePreviewOf(ctxs.a1a2, [], shape, null);
    eq(docOnly.plan.map((m) => m.title).includes('Movilidad segura'), false, 'sin caja los títulos son los de las unidades');
    eq(CD.proposeShapedStructureFromContext(ctxs.a1a2, shape, { moduleTitles: ['A', null, 'C', null] }).modules.map((m) => m.title).slice(0, 3), ['A', 'Normas de tránsito', 'C'], 'título null: se queda el de siempre');
    eq(BOXM.boxModuleTitlesFor(reqs, [4, 7, 4, 5]), TITLES, 'boxModuleTitlesFor');
    eq(BOXM.boxModuleTitlesFor(reqs, [4, 7, 4, 4]), null, 'otra forma: sin títulos');
  });

  // ── BX9 / BX10 ──
  const cctx = { status: 'ok', baseHours: 20, estimatedHours: 20, modules: 4, moduleExams: 4, exceptionFields: {}, structureByTeacher: false };
  const unmet = (r, shape) => ({ requirementId: r.id, status: 'unmet', chosenBy: 'cursia', actual: { shape } });
  const asApplicable = (text) => BOXM.extractBox(text).requirements.filter((r) => r.obligation === 'required' && r.confidence === 'high');
  await check('BX9 fuera de los topes (50 módulos / 30 capítulos por módulo): conflicto CRÍTICO explícito, y no se recomienda', async () => {
    const reqs = asApplicable('2 módulos con 4 y 40 capítulos');
    const st = reqs.find((r) => r.kind === 'structure');
    eq(st.shape, [4, 40], 'se lee igual (no se pierde en silencio)');
    const checks = AUTH.requirementVerificationChecks(reqs, [unmet(st, [4, 5])], cctx);
    const lim = checks.find((c) => /^requirement-limits:/.test(c.id));
    assert(lim && lim.severity === 'critical', 'conflicto crítico de topes: ' + JSON.stringify(checks.map((c) => [c.id, c.severity])));
    assert(/módulo 2 tiene 40 capítulos y un módulo admite hasta 30/.test(lim.detail), lim.detail);
    // 51 módulos.
    const many = asApplicable(`51 módulos con ${Array.from({ length: 51 }, (_, i) => (i % 3) + 1).join(', ')} capítulos`);
    assert(many.find((r) => r.kind === 'structure'), '51 módulos se leen');
    const c2 = AUTH.requirementVerificationChecks(many, [unmet(many.find((r) => r.kind === 'structure'), [4])], cctx);
    assert(c2.some((c) => /^requirement-limits:/.test(c.id) && c.severity === 'critical' && /admite hasta 50/.test(c.detail)), 'más de 50 módulos');
    // Dentro de los topes no hay conflicto de topes.
    const okReqs = asApplicable(BOX_EXAMPLE);
    assert(!AUTH.requirementVerificationChecks(okReqs, [unmet(okReqs.find((r) => r.kind === 'structure'), [4, 7, 4, 5])], cctx).some((c) => /^requirement-limits:/.test(c.id)), 'sin topes excedidos: sin conflicto de topes');
    // No se recomienda una forma que Cursia no puede producir.
    const o = await optionsOf(DIST, ctxs.a1a2, { boxText: '2 módulos con 4 y 40 capítulos' });
    assert(!o.recommended.origin, 'no se recomienda la forma fuera de topes');
  });

  await check('BX10 la verificación habla de «tus requisitos obligatorios» (no «del documento») con la misma severidad', () => {
    const reqs = asApplicable(BOX_EXAMPLE);
    const st = reqs.find((r) => r.kind === 'structure');
    const ch = AUTH.requirementVerificationChecks(reqs, [unmet(st, [4, 5, 4, 5]), { requirementId: reqs.find((r) => r.kind === 'target_hours').id, status: 'met', chosenBy: 'cursia', actual: {} }], cctx);
    const c = ch.find((x) => x.id === `requirement:${st.id}`);
    eq(c.severity, 'critical', 'misma severidad que un documento');
    assert(/^Conflicto con tus requisitos obligatorios: /.test(c.title) && !/documento/i.test(`${c.title} ${c.detail}`), `${c.title} / ${c.detail}`);
    // El mismo requisito leído de un DOCUMENTO sigue diciendo «documento».
    const doc = XN.requirementsFor(XN.extractRequirements(linesN('El curso tendrá exactamente 4 módulos con 5 capítulos cada uno.'), 'D1'), {}).filter((r) => r.kind === 'structure');
    const dch = AUTH.requirementVerificationChecks(doc, [unmet(doc[0], [4, 4, 4, 4])], cctx).find((x) => x.id === `requirement:${doc[0].id}`);
    assert(/^Conflicto con un requisito del documento: /.test(dch.title), dch.title);
  });

  // ── BX11 ──
  await check('BX11 API: guardar, leer y borrar la caja; tope de largo; dueño del curso; USD 0', async () => {
    const SVCM = L('modules/academic-context/academic-context.service.js');
    const DTO = L('modules/academic-context/dto/extract.dto.js');
    const FEAT = L('modules/features/dynamic-features.js');
    process.env[FEAT.DYNAMIC_FLAG_ENV] = 'true';
    process.env[FEAT.GENERAL_AVAILABILITY_ENV] = 'true';
    const calls = [];
    let meta = null;
    const run = async (sql, p) => {
      calls.push(sql);
      if (/jsonb_set/.test(sql) && /requirementsBox/.test(sql)) { meta = JSON.parse(p[1]); return []; }
      if (/- 'requirementsBox'/.test(sql)) { meta = null; return []; }
      if (/metadata -> 'documentRequirements'/.test(sql)) return [{ r: null, s: null, b: meta }];
      return [];
    };
    const svc = Object.create(SVCM.AcademicContextService.prototype);
    const owners = [];
    svc.loadCourse = async (id, owner) => { owners.push([id, owner]); };
    svc.dataSource = { query: run, transaction: async (fn) => fn({ query: run }) };
    const view = await svc.setRequirementsBox(7, 'owner-1', BOX_EXAMPLE);
    eq(owners, [[7, 'owner-1'], [7, 'owner-1']], 'comprueba que el curso es del dueño (guardar y leer)');
    eq(meta.text, BOX_EXAMPLE, 'guardado');
    eq(view.box.understood.summary, '4 módulos · capítulos 4 / 7 / 4 / 5 · 28 h', 'devuelve la vista con lo entendido');
    eq(view.box.notUnderstood, [], 'sin líneas sin entender');
    // Texto con basura: lo no entendido vuelve en la respuesta.
    const v2 = await svc.setRequirementsBox(7, 'owner-1', `${BOX_EXAMPLE}\nlo quiero para ayer`);
    assert(v2.box.notUnderstood.some((n) => /ayer/.test(n.text)), JSON.stringify(v2.box.notUnderstood));
    // Vacío = sin caja.
    const v3 = await svc.setRequirementsBox(7, 'owner-1', '   \n ');
    eq(meta, null, 'la caja en blanco borra la caja');
    assert(!('box' in v3), 'sin caja la vista no trae `box`');
    // Tope de largo (ACADEMIC_LIMITS).
    let err = null;
    try { await svc.setRequirementsBox(7, 'owner-1', 'x'.repeat(BOXM.BOX_MAX_CHARS + 1)); } catch (e) { err = e; }
    assert(err && /BOX_TOO_LONG/.test(JSON.stringify(err.getResponse && err.getResponse())), 'tope de largo: BOX_TOO_LONG');
    eq(BOXM.BOX_MAX_CHARS, L('modules/academic-context/academic-context.js').ACADEMIC_LIMITS.text * 4, 'el tope sale de ACADEMIC_LIMITS');
    // Un curso que no es del dueño no se toca.
    const denied = Object.create(SVCM.AcademicContextService.prototype);
    denied.loadCourse = async () => { throw new Error('NOT_OWNER'); };
    denied.dataSource = { query: run, transaction: async (fn) => fn({ query: run }) };
    let e2 = null; try { await denied.setRequirementsBox(7, 'otro', 'x'); } catch (e) { e2 = e; }
    assert(e2 && /NOT_OWNER/.test(e2.message), 'curso ajeno: rechazado antes de escribir');
    // DTO + controlador (auth y permiso).
    const { validateSync } = require('class-validator');
    const mk = (t) => { const d = new DTO.RequirementsBoxDto(); d.text = t; return validateSync(d).length; };
    eq([mk('hola'), mk(''), mk(5), mk('x'.repeat(20001))].map((n) => n > 0), [false, false, true, true], 'DTO: texto (vacío vale: borra la caja)');
    const CTRL = L('modules/academic-context/academic-context.controller.js');
    const meta2 = (fn) => Reflect.getMetadata('permission', CTRL.AcademicContextController.prototype[fn]) ;
    const guards = Reflect.getMetadata('__guards__', CTRL.AcademicContextController) || [];
    assert(guards.length >= 1, 'el controlador sigue con SupabaseJwtGuard');
    assert(typeof CTRL.AcademicContextController.prototype.requirementsBox === 'function' && typeof CTRL.AcademicContextController.prototype.getRequirementsBox === 'function', 'rutas PUT y GET');
    const keys = Reflect.getMetadataKeys(CTRL.AcademicContextController.prototype.requirementsBox).join(',');
    assert(/permission|require/i.test(keys), 'PUT con permiso courses.edit: ' + keys);
    void meta2;
    // Sin IA: la lectura no usa proveedores.
    eq(netAttempts, [], 'cero intentos de red');
  });

  // ── BX12 ──
  await check('BX12 sin regresión: lector de documentos, vista, structure-options y verificación = origin/staging', async () => {
    const live = async (root) => {
      const { X, lines } = readers(root);
      const RR = loader(root);
      const DR = RR('modules/academic-context/requirements/document-requirements.js');
      const AU = RR('modules/academic-context/requirements/requirement-authority.js');
      const out = {};
      // `unevenDoc` y `moduleN` cambian A PROPÓSITO (el lector ahora entiende la forma desigual): se verifican en BX1.
      for (const [k, t] of Object.entries(DOC_CORPUS)) if (!INTENTIONAL.includes(k)) out[`extract:${k}`] = sha(X.extractRequirements(lines(t), 'D1'));
      for (const k of ['nxm', 'ficha', 'sml', 'hours', 'videos']) {
        const x = X.extractRequirements(lines(DOC_CORPUS[k]), 'D1');
        const docs = [{ id: 'D1', name: 'd.docx', sha256: 'b'.repeat(64) }];
        const e = DR.storedEntry(docs, x, '2026-11-14T00:00:00.000Z');
        out[`view:${k}`] = sha(DR.buildRequirementsView([e], null, docs));
        const applicable = DR.buildRequirementsView([e], null, docs).items.filter((i) => i.applies);
        const checks = applicable.map((r) => ({ requirementId: r.id, status: 'unmet', chosenBy: 'cursia', actual: { value: 1, shape: [2, 2], each: [1] } }));
        out[`verify:${k}`] = sha(AU.requirementVerificationChecks(applicable, checks, cctx));
        out[`constraints:${k}`] = sha(AU.constraintsFor(applicable.filter((r) => r.obligation === 'required' && r.confidence === 'high'), {}));
      }
      for (const [cn, ctx] of Object.entries({ costos: ctxs.costos, a1a2: ctxs.a1a2 })) {
        for (const [dn, doc] of [['sin', null], ['nxm', DOC_CORPUS.nxm], ['ficha', DOC_CORPUS.ficha]]) out[`options:${cn}:${dn}`] = sha(await optionsOf(root, ctx, { docText: doc }));
      }
      return out;
    };
    const got = await live(DIST);
    if (process.argv.includes('--write-golden')) {
      assert(BASE, '--write-golden pide --base <dist de origin/staging>');
      fs.mkdirSync(path.dirname(GOLDEN), { recursive: true });
      fs.writeFileSync(GOLDEN, `${JSON.stringify(await live(BASE), null, 2)}\n`);
      console.log(`   golden escrito en ${path.relative(REPO, GOLDEN)}`);
      return;
    }
    const want = BASE ? await live(BASE) : JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
    const bad = Object.keys(want).filter((k) => want[k] !== got[k]);
    eq(bad, [], `huellas distintas de origin/staging (${BASE ? 'en vivo' : 'golden'})`);
    eq(Object.keys(got).length > 20, true, 'hay casos');
  });

  eq(netAttempts, [], 'red');
  console.log(`\n${ok} OK · ${fail} fallas · red ${netAttempts.length} · USD 0.00`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
