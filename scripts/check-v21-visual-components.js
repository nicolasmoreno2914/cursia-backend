#!/usr/bin/env node
/* eslint-disable */
// R2 (Cursia V2.1) — Visual Components: check puro (sin DB, sin red, sin Moodle).
// Requiere el módulo COMPILADO (dist/), igual que check-generation-manifest-determinism.js.
//
// Cubre: validador (fixture completo + cada clase de error), lints de texto, determinismo,
// escape, lintCleanSafe para todos los componentes × familias × modos × niveles (incluye
// textos/títulos con palabras de 400 caracteres), tamaño de fuente ≥ 16 y equivalencia de
// texto CLEAN_SAFE ↔ ENHANCED.
//
// Uso: node scripts/check-v21-visual-components.js [dist/modules/visual-components/index.js]

const path = require('path');
const F = require('./lib/v21-vc-fixtures');

const modPath = path.resolve(process.cwd(), process.argv[2] || 'dist/modules/visual-components/index.js');
const themePath = path.resolve(process.cwd(), 'dist/modules/theme-engine/index.js');
let vc, te;
try {
  vc = require(modPath);
  te = require(themePath);
} catch (err) {
  console.error(`❌ No se pudo cargar el módulo compilado (${modPath})`);
  console.error(`   (¿corriste "npm run build" antes? — dist/ no se versiona)`);
  console.error(`   ${err.message}`);
  process.exit(1);
}

for (const name of ['validateExperience', 'validateComponent', 'lintResourceMentions', 'lintQuantityClaims', 'renderComponent', 'renderMovement', 'lintCleanSafe', 'extractText']) {
  if (typeof vc[name] !== 'function') {
    console.error(`❌ El módulo compilado no exporta "${name}" como función.`);
    process.exit(1);
  }
}

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`✅ ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`❌ ${name}`);
    console.error(`   ${err && err.message ? err.message : err}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
function codesOf(res) {
  return (res.errors || res).map((e) => e.code);
}
function expectCode(doc, code, pathIncludes) {
  const r = vc.validateExperience(doc);
  assert(!r.ok, `se esperaba ok=false para ${code}`);
  const hit = r.errors.find((e) => e.code === code && (!pathIncludes || e.path.includes(pathIncludes)));
  assert(hit, `se esperaba ${code}${pathIncludes ? ' en ' + pathIncludes : ''}; errores: ${JSON.stringify(r.errors.slice(0, 6))}`);
  return r;
}
function mutate(fn) {
  const d = F.buildExperience();
  fn(d);
  return d;
}

const themes = F.THEME_COMBOS.map((combo) => ({ combo, theme: te.resolveTheme(combo) }));
const components = F.loadComponents();
const LEVELS = [undefined, 'enhanced'];

// Fix round 1 (I1): mismos vectores en el harness del frontend (test-45-v3-items.mjs).
// Fix round 3: «Sí/No» + «:» o guion y «Si X:» también son DÉBILES. Fix round 2: FUERTES marcan solos; DÉBILES («Sí,» «No;» «Sí (») solo en pareja de polaridad opuesta o tras «¿…?».
const VC_BRANCH_POSITIVES = ['Sí', 'No', 'No.', 'Si responde → consciente', '2 Sí → Consciente', '3. No → Inconsciente', '«Sí» → x', 'Si no hay pulso, inicia RCP', 'No -> detén la máquina'];
const VC_BRANCH_WEAK = ['Sí, está consciente', 'No, llama al 123', 'No; espera la señal', 'Sí (consciente)', 'No, nunca la muevas', 'Sí, siempre', 'No, no uses agua en un incendio eléctrico', 'Sí; continúa con el protocolo', 'Si, siempre usa casco', 'Sí, aplica presión constante', 'No, jamás dejes la máquina encendida', 'Si respira: posición lateral', '"No": detén la máquina', 'No: pero primero verifica', 'No - pero antes verifica el nivel de aceite', 'Sí - revisa el manómetro cada hora', 'Sí – está consciente', 'No: llama al 123', 'Sí: llama al supervisor', 'No - espera la señal', 'No — detén la línea'];
/** Secuencias realistas: [encabezados, índices esperados]. */
const VC_BRANCH_SEQ_CASES = [
  // una advertencia DÉBIL sola dentro de un procedimiento normal: nada
  [['Asegura la escena', 'Evalúa la respuesta', 'No, nunca la muevas', 'Llama a emergencias', 'Mantén la vigilancia'], []],
  [['Revisa el EPP', 'Sí, siempre', 'Colócate el arnés', 'Verifica el anclaje'], []],
  [['Corta la energía', 'No, no uses agua en un incendio eléctrico', 'Usa un extintor de CO2', 'Evacúa el área', 'Informa al supervisor'], []],
  [['Confirma el diagnóstico', 'Sí; continúa con el protocolo', 'Registra la atención', 'Deriva si corresponde'], []],
  [['Ingresa a la obra', 'Si, siempre usa casco', 'Revisa el andamio', 'Firma el permiso'], []],
  [['Sí, aplica presión constante', 'Eleva la extremidad', 'Sí, revisa el pulso distal', 'Pide ayuda'], []],
  // pareja de polaridad opuesta: ambas cuentan
  [['Evalúa la respuesta', 'Sí, está consciente', 'No, llama al 123', 'Vigila la respiración'], [1, 2]],
  // DÉBIL justo después de una pregunta
  [['¿Responde?', 'Sí, está consciente', 'Colócala de lado'], [1]],
  // FUERTE solo
  [['Evalúa', 'Sí → Consciente', 'Actúa'], [1]],
  [['Revisa el nivel', 'No - pero antes verifica el nivel de aceite', 'Arranca el motor', 'Registra la lectura'], []],
  [['Enciende el equipo', 'Sí - revisa el manómetro cada hora', 'Anota la presión', 'Apaga al final'], []],
  [['Prepara la herramienta', 'No: pero primero verifica', 'Ajusta la válvula', 'Prueba la línea', 'Cierra el permiso'], []],
  [['Evalúa la respuesta', 'Sí – está consciente', 'No: llama al 123', 'Vigila la respiración'], [1, 2]],
  [['Evalúa', 'Si respira: posición lateral', 'Si no respira: inicia RCP'], [1, 2]],
];
const VC_BRANCH_SEQUENCES = VC_BRANCH_SEQ_CASES.map(([h]) => h);
const VC_BRANCH_NEGATIVES = ['Sistema de bloqueo', 'Silencio operativo', 'Nota: revisa el tablero', 'No-conformidades del lote', 'Normas vigentes', 'Si el equipo vibra, detén la línea', 'Señales de alerta', 'No olvides el casco', 'No toques el tablero energizado', 'No uses agua en un fuego eléctrico', 'Nunca trabajes solo', 'Si bien es simple, requiere práctica', 'Sin tensión: verifica'];

// ─── Validador ──────────────────────────────────────────────────────────────

check('schema: VC_SCHEMA_VERSION === 1 y 18 tipos de componente (Edu Phase A: worked_example, diagram)', () => {
  assert(vc.VC_SCHEMA_VERSION === 1, 'VC_SCHEMA_VERSION');
  assert(vc.VC_COMPONENT_TYPES.length === 18, `tipos: ${vc.VC_COMPONENT_TYPES.length}`);
  const inFixture = new Set(components.map((c) => c.type));
  for (const t of vc.VC_COMPONENT_TYPES) assert(inFixture.has(t), `fixture sin ${t}`);
});

check('espejo del frontend (44): DYN_VC_COMPONENT_SPECS, nodos por diagrama y tipos ilustrativos idénticos al schema R2', () => {
  const fs = require('fs');
  const vm = require('vm');
  const FE = process.env.CURSIA_FRONTEND_REPO || path.resolve(__dirname, '..', '..', 'campuscloud-gen');
  const file = path.join(FE, 'src/js/44-dynamic-prompt-builders.js');
  if (!fs.existsSync(file)) {
    console.log(`   ⚠️  sin ${file} (CURSIA_FRONTEND_REPO): se omite la paridad del espejo`);
    return;
  }
  const ctx = { console: { log() {}, warn() {}, error() {} } };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(file, 'utf8') + '\n;this.__specs = DYN_VC_COMPONENT_SPECS; this.__nodes = DYN_VC_DIAGRAM_NODES; this.__ill = DYN_VC_ILLUSTRATIVE_TYPES; this.__limits = DYN_VC_MOVEMENT_LIMITS; this.__ped = typeof DYN_VC_PEDAGOGY !== "undefined" ? DYN_VC_PEDAGOGY : null; this.__dec = DYN_VC_DECISION_LIMITS; this.__decSpec = DYN_VC_DECISION_DIAGRAM_SPEC;', ctx);
  const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.keys(v).sort().reduce((o, k) => ((o[k] = canon(v[k])), o), {}) : v);
  const norm = (spec) => canon(JSON.parse(JSON.stringify(spec, (k, v) => (k === 'optional' && v === false ? undefined : v))));
  const be = norm(vc.VC_COMPONENT_SPECS);
  const fe = norm(ctx.__specs);
  assert(JSON.stringify(Object.keys(fe).sort()) === JSON.stringify(Object.keys(be).sort()), `tipos distintos: FE ${Object.keys(fe)} / BE ${Object.keys(be)}`);
  for (const t of Object.keys(be)) assert(JSON.stringify(fe[t]) === JSON.stringify(be[t]), `${t}: FE ${JSON.stringify(fe[t])} ≠ BE ${JSON.stringify(be[t])}`);
  assert(JSON.stringify(canon(ctx.__nodes)) === JSON.stringify(canon(vc.VC_DIAGRAM_NODES)), 'VC_DIAGRAM_NODES');
  assert(JSON.stringify(Array.from(ctx.__ill)) === JSON.stringify(Array.from(vc.VC_ILLUSTRATIVE_TYPES)), 'VC_ILLUSTRATIVE_TYPES');
  assert(JSON.stringify(canon(ctx.__limits)) === JSON.stringify(canon(vc.VC_MOVEMENT_LIMITS)), `VC_MOVEMENT_LIMITS: FE ${JSON.stringify(ctx.__limits)} ≠ BE ${JSON.stringify(vc.VC_MOVEMENT_LIMITS)}`);
  if (vc.VC_PEDAGOGY) assert(JSON.stringify(canon(ctx.__ped)) === JSON.stringify(canon(vc.VC_PEDAGOGY)), `VC_PEDAGOGY: FE ${JSON.stringify(ctx.__ped)} ≠ BE ${JSON.stringify(vc.VC_PEDAGOGY)}`);
  // Fix round 1: lints anti-simulación del ejecutor (45) idénticos al backend sobre los vectores compartidos.
  const f45 = path.join(FE, 'src/js/45-dynamic-generation-executor.js');
  vm.runInContext(fs.readFileSync(f45, 'utf8') + '\n;this.__br = dynIsBranchHead; this.__q = dynIsQuestionHead; this.__ar = dynArrowChainLength; this.__sim = dynValidateSimulatedDiagramsV3; this.__bk = dynBranchHead; this.__bi = dynBranchingHeadIndexes;', ctx);
  for (const t of [...VC_BRANCH_POSITIVES, ...VC_BRANCH_WEAK, ...VC_BRANCH_NEGATIVES, '¿Responde?', '1. ¿Respira?', 'Calor → dilatación\nFrío → contracción', 'a → b → c', 'x -> y ⇒ z']) {
    assert(ctx.__br(t) === vc.isBranchHead(t) && ctx.__q(t) === vc.isQuestionHead(t) && ctx.__ar(t) === vc.arrowChainLength(t), `lint FE ≠ BE en "${t}"`);
    assert(JSON.stringify(JSON.parse(JSON.stringify(ctx.__bk(t)))) === JSON.stringify(vc.branchHead(t)), `branchHead FE ≠ BE en "${t}"`);
  }
  for (const seq of VC_BRANCH_SEQUENCES) {
    assert(JSON.stringify(Array.from(ctx.__bi(seq))) === JSON.stringify(vc.branchingHeadIndexes(seq)), `branchingHeadIndexes FE ≠ BE en ${JSON.stringify(seq)}`);
  }
  const simDoc = F.buildExperience();
  simDoc.movements.deepening[1] = { type: 'diagram', kind: 'flow', title: 'V', nodes: ['¿Responde?', 'Sí', 'Consciente', 'No, llama', 'Inconsciente'].map((label) => ({ label })) };
  simDoc.bridge_to_next = 'Observa → decide → actúa.';
  assert(JSON.stringify(JSON.parse(JSON.stringify(ctx.__sim(simDoc)))) === JSON.stringify(vc.validateSimulatedDiagrams(simDoc)), 'validateSimulatedDiagrams FE ≠ BE');
  // EV6: árbol de decisión (límites + spec de primer nivel)
  assert(JSON.stringify(canon(ctx.__dec)) === JSON.stringify(canon(vc.VC_DECISION_LIMITS)), `VC_DECISION_LIMITS: FE ${JSON.stringify(ctx.__dec)} ≠ BE ${JSON.stringify(vc.VC_DECISION_LIMITS)}`);
  assert(JSON.stringify(norm(ctx.__decSpec)) === JSON.stringify(norm(vc.VC_DECISION_DIAGRAM_SPEC)), `VC_DECISION_DIAGRAM_SPEC: FE ${JSON.stringify(ctx.__decSpec)} ≠ BE`);
});

check('EV5: guiones suaves en fronteras de sílaba, *énfasis* simple sin asteriscos literales, hero sin repetir el título', () => {
  const T = require(path.join(path.dirname(modPath), 'text.js'));
  const hy = (w, o) => T.inlineHtml(w, o).replace(/<[^>]+>/g, '').split('&shy;').join('-');
  const o = { minLen: 10, every: 6 };
  for (const [w, want] of [['estudiantes', 'estu-diantes'], ['potencialmente', 'poten-cial-mente'], ['acondicionamiento', 'acondi-ciona-miento']]) {
    assert(hy(w, o) === want, `${w} → ${hy(w, o)} (esperaba ${want})`);
  }
  assert(hy('ABCDEFGHIJKLMNOPQRSTUVWXYZ', o).includes('-'), 'sin sílabas (sigla/código): igual se corta para no desbordar');
  // Garantía anti-desborde intacta: ningún tramo supera every + 2 (el último), en los 3 perfiles.
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const L = 'abcdefghilmnoprstuáéíóñ';
  for (const prof of [T.HYPHEN_TABLE, T.HYPHEN_HEADING, T.HYPHEN_DEFAULT]) {
    let worst = 0;
    for (let i = 0; i < 4000; i++) {
      let w = '';
      const n = prof.minLen + Math.floor(rnd() * 30);
      for (let j = 0; j < n; j++) w += L[Math.floor(rnd() * L.length)];
      for (const piece of T.inlineHtml(w, prof).replace(/<[^>]+>/g, '').split('&shy;')) worst = Math.max(worst, Array.from(piece).length);
    }
    assert(worst <= prof.every + 2, `every ${prof.every}: tramo de ${worst}`);
  }
  const em = T.inlineHtml('requiere *tu* contexto, *tu* voz; 5 * 3 = 15; **fuerte**');
  assert(!/\*tu\*/.test(em) && em.includes('requiere tu contexto, tu voz') && em.includes('5 * 3 = 15') && em.includes('<strong>fuerte</strong>'), `énfasis: ${em}`);
  assert(T.inlineHtml('Los campos (*) son obligatorios (*).').includes('(*) son obligatorios (*)'), 'marcas de nota (*) intactas');
  const t0 = themes[0].theme;
  const op = { title: 'Cómo funciona la IA generativa', kicker: 'Módulo 1 · Capítulo 1', numeral: '01' };
  const dup = vc.renderComponent({ type: 'hero', title: 'Cómo funciona la IA generativa.', lead: 'Una idea clara para empezar.' }, t0, { uid: 'h', opener: op });
  assert(vc.extractText(dup).split('Cómo funciona la IA generativa').length === 2, `hero repite el título: ${vc.extractText(dup).slice(0, 120)}`);
  const own = vc.renderComponent({ type: 'hero', title: 'Una tesis distinta del título.', lead: 'Una idea clara para empezar.' }, t0, { uid: 'h', opener: op });
  assert(vc.extractText(own).includes('Una tesis distinta del título.'), 'el enunciado propio se conserva');
  const legacy = vc.renderComponent({ type: 'hero', title: 'Cómo funciona la IA generativa en el aula de secundaria y qué cambia para docentes y estudiantes', lead: 'Una idea clara para empezar.' }, t0, { uid: 'h', opener: op });
  assert(vc.extractText(legacy).split('Cómo funciona la IA generativa').length === 2, 'hero con el título legado largo (nombre + descripción) no se repite');
});

check('Edu EV4: bloques como piezas de curso (tarjetas, panel de objetivos, insignias) sin kicker repetido', () => {
  for (const { combo, theme } of themes) {
    for (const level of LEVELS) {
      const o = { uid: 'ev4', level };
      // Objetivos: kicker distinto del título; en 2 columnas los ítems 0 y 1 sin filete superior.
      const four = vc.renderComponent({ type: 'learning_objectives', items: ['Uno claro', 'Dos claro', 'Tres claro', 'Cuatro claro'] }, theme, o);
      const lis = four.match(/<li class="cvc-obj"[^>]*>/g) || [];
      // Inline (apilado, una columna): solo el primero sin filete; en 2 columnas el runtime quita el del 2.º.
      assert(lis.length === 4 && !/border-top/.test(lis[0]) && /border-top/.test(lis[1]) && /border-top/.test(lis[2]), `${combo.themeFamily}: filetes (${lis.map((l) => /border-top/.test(l)).join(',')})`);
      if (level) {
        const lblObj = vc.renderMovement([{ type: 'learning_objectives', items: ['Uno claro', 'Dos claro', 'Tres claro', 'Cuatro claro'] }], theme, o);
        assert(/@container \(min-width:600px\)\{[^]*\.cvc-obj-panel \.cvc-cols2>li:nth-child\(2\)\{border-top:0!important\}/.test(lblObj), 'en 2 columnas el 2.º objetivo pierde el filete solo en ≥600px');
      }
      assert(four.includes('Objetivos de aprendizaje') && four.includes('Al terminar podrás') && four.includes('cvc-obj-panel'), 'kicker + título + panel');
      const dup = vc.extractText(vc.renderComponent({ type: 'learning_objectives', title: 'Objetivos de aprendizaje', items: ['Uno claro', 'Dos claro'] }, theme, o));
      assert(dup.split('Objetivos de aprendizaje').length === 2, `${combo.themeFamily}: kicker repite el título del LLM: ${dup.slice(0, 80)}`);
      // Conceptos: tarjetas con borde (visible también en familias con lámina).
      const cards = vc.renderComponent({ type: 'concept_cards', cards: [{ term: 'Término', definition: 'Definición breve.' }, { term: 'Otro', definition: 'Otra definición.' }] }, theme, o);
      assert((cards.match(/class="cvc-tile cvc-term"[^>]*border:1px solid/g) || []).length === 2 && cards.includes('class="cvc-cards"'), `${combo.themeFamily}: tarjetas de conceptos`);
      // Pasos: insignia, no numeral gigante.
      const steps = vc.renderComponent({ type: 'process_steps', steps: [{ heading: 'Primero', body: 'Hacer algo.' }, { heading: 'Luego', body: 'Hacer otra cosa.' }, { heading: 'Final', body: 'Cerrar.' }] }, theme, o);
      assert((steps.match(/class="cvc-badge"/g) || []).length === 3 && !steps.includes('class="cvc-num"'), `${combo.themeFamily}: insignias de paso`);
      if (level) {
        const lbl = vc.renderMovement([{ type: 'concept_cards', cards: [{ term: 'Término', definition: 'Definición breve.' }] }], theme, o);
        assert(/\.cvc-cards\{display:grid;grid-template-columns:minmax\(0,1fr\)/.test(lbl), 'la grilla de tarjetas no desborda en angosto');
      }
    }
  }
});

check('Edu EV2: validatePedagogy — introducción visual, conceptos clave, ejemplo práctico, recurso visual y sin muros de texto', () => {
  const base = () => {
    const d = F.buildExperience();
    d.movements.deepening = [
      F.clone(components.find((c) => c.type === 'concept_cards')),
      F.clone(components.find((c) => c.type === 'accordion')),
      F.clone(components.find((c) => c.type === 'worked_example')),
      F.clone(components.find((c) => c.type === 'diagram')),
    ];
    return d;
  };
  const codes = (d) => vc.validatePedagogy(d).map((e) => e.code + ' ' + e.path);
  assert(vc.validateExperience(base()).ok, 'base válida por schema: ' + JSON.stringify(vc.validateExperience(base()).errors));
  assert(codes(base()).length === 0, 'base cumple: ' + codes(base()));
  let d = base(); d.movements.opening.shift();
  assert(codes(d).some((c) => c.startsWith('PEDAGOGY_MISSING $.movements.opening[0]')), 'sin hero al inicio');
  d = base(); d.movements.deepening = d.movements.deepening.filter((c) => c.type !== 'concept_cards');
  assert(codes(d).length === 1 && /concept_cards|conceptos/.test(vc.validatePedagogy(d)[0].message), 'sin conceptos clave');
  d = base(); d.movements.deepening = d.movements.deepening.filter((c) => c.type !== 'worked_example');
  d.movements.closing = [{ type: 'reflection', prompt: '¿Qué harías distinto?' }];
  assert(vc.validatePedagogy(d).some((e) => /ejemplo práctico/.test(e.message)), 'sin ejemplo');
  d = base(); d.movements.deepening = d.movements.deepening.filter((c) => c.type !== 'diagram');
  assert(vc.validatePedagogy(d).some((e) => /recurso visual/.test(e.message)), 'sin recurso visual');
  d = base(); d.movements.deepening[1].items[0].body = 'Una idea extensa sobre la escucha. '.repeat(20);
  assert(codes(d).some((c) => c.startsWith('TEXT_DENSE $.movements.deepening[1].items[0].body')), 'muro de texto');
  // el schema R2 NO cambia: un capítulo viejo sin estas piezas sigue siendo válido para empaquetar
  const old = F.buildExperience();
  old.movements.opening.shift();
  assert(vc.validateExperience(old).ok && vc.validatePedagogy(old).length > 0, 'compatibilidad: schema ok, pedagogía solo para lo nuevo');
});

check('validador acepta el fixture completo (capítulo) y cada componente suelto', () => {
  const r = vc.validateExperience(F.buildExperience());
  assert(r.ok && r.errors.length === 0, JSON.stringify(r.errors));
  for (const c of components) {
    const e = vc.validateComponent(c);
    assert(e.length === 0, `${c.type}: ${JSON.stringify(e)}`);
  }
});

check('Edu Phase A: diagram — nodos por forma y ejes solo en matriz (DIAGRAM_SHAPE); worked_example admite datos ilustrativos', () => {
  const dg = (kind, n, extra) => Object.assign({ type: 'diagram', kind, title: 'T', nodes: Array.from({ length: n }, (_, i) => ({ label: 'Etapa ' + String.fromCharCode(65 + i) })) }, extra || {});
  const codes = (c) => vc.validateComponent(c).map((e) => e.code);
  assert(codes(dg('cycle', 4)).length === 0, 'ciclo de 4');
  assert(codes(dg('cycle', 2)).includes('DIAGRAM_SHAPE'), 'ciclo de 2');
  assert(codes(dg('flow', 7)).includes('DIAGRAM_SHAPE'), 'flujo de 7');
  assert(codes(dg('hierarchy', 3)).length === 0, 'jerarquía raíz + 2');
  assert(codes(dg('matrix', 4, { x_axis: 'Urgencia', y_axis: 'Impacto' })).length === 0, 'matriz ok');
  assert(codes(dg('matrix', 4)).filter((c) => c === 'DIAGRAM_SHAPE').length === 2, 'matriz sin ejes');
  assert(codes(dg('matrix', 3, { x_axis: 'a', y_axis: 'b' })).includes('DIAGRAM_SHAPE'), 'matriz de 3');
  assert(codes(dg('flow', 3, { x_axis: 'a' })).includes('DIAGRAM_SHAPE'), 'eje en un flujo');
  assert(codes(dg('radial', 3)).includes('ENUM_VALUE'), 'forma desconocida');
  const we = F.clone(components.find((x) => x.type === 'worked_example'));
  assert(codes(we).length === 0, 'fixture con $ y % válido: ' + JSON.stringify(vc.validateComponent(we)));
  we.steps[0].detail = 'Aplica esto en los 3 módulos del curso.';
  assert(codes(we).includes('QUANTITY_CLAIM'), 'cantidades del curso siguen prohibidas en el ejemplo');
  const callout = { type: 'callout', variant: 'info', body: 'El 30 % de los reclamos se repite.' };
  assert(codes(callout).includes('QUANTITY_CLAIM'), '% fuera del ejemplo resuelto sigue prohibido');
});

// ─── EV6 — árbol de decisión y diagramas simulados con texto ───────────────
const DEC = (tree, extra) => Object.assign({ type: 'diagram', kind: 'decision', title: 'Valoración inicial', tree }, extra || {});
const leaf = (a) => ({ action: a });
const q = (question, yes, no) => ({ question, yes, no });
const DEPTH1 = DEC(q('¿Responde cuando le hablas?', leaf('Mantenla acompañada y vigila su estado.'), leaf('Llama a emergencias y revisa si respira.')));
const DEPTH3 = DEC(q('¿Responde?', { label: 'Consciente', action: 'Pregúntale qué pasó.' }, { label: 'Inconsciente', tree: q('¿Respira con normalidad?', leaf('Posición lateral de seguridad.'), { tree: q('¿Hay un desfibrilador cerca?', leaf('Inicia RCP y pide que lo traigan.'), leaf('Inicia RCP y llama a emergencias.')) }) }));

check('EV6: diagram kind "decision" — forma, profundidad ≤ 3, ≤ 4 preguntas, «?» final, sin nodes/ejes; tree solo en decision', () => {
  const codes = (c) => vc.validateComponent(c).map((e) => e.code);
  const errs = (c) => vc.validateComponent(c);
  assert(vc.VC_DIAGRAM_KINDS.includes('decision') && vc.VC_DECISION_LIMITS.maxDepth === 3 && vc.VC_DECISION_LIMITS.maxQuestions === 4, 'límites exportados');
  assert(codes(DEPTH1).length === 0, 'profundidad 1: ' + JSON.stringify(errs(DEPTH1)));
  assert(codes(DEPTH3).length === 0, 'profundidad 3: ' + JSON.stringify(errs(DEPTH3)));
  const noTitle = F.clone(DEPTH1); delete noTitle.title;
  assert(codes(noTitle).length === 0, 'title opcional en decision');
  // acción Y subárbol en la misma rama
  const both = F.clone(DEPTH1); both.tree.yes.tree = q('¿Otra?', leaf('a'), leaf('b'));
  assert(errs(both).some((e) => e.code === 'DIAGRAM_SHAPE' && e.path === 'component.tree.yes'), 'action + tree: ' + JSON.stringify(errs(both)));
  const neither = F.clone(DEPTH1); neither.tree.no = { label: 'No' };
  assert(errs(neither).some((e) => e.code === 'DIAGRAM_SHAPE' && e.path === 'component.tree.no'), 'rama vacía');
  // profundidad 4
  const deep = DEC(q('¿A?', leaf('x'), { tree: q('¿B?', leaf('x'), { tree: q('¿C?', leaf('x'), { tree: q('¿D?', leaf('x'), leaf('y')) }) }) }));
  assert(errs(deep).some((e) => e.code === 'DIAGRAM_SHAPE' && /encadenadas/.test(e.message) && e.path === 'component.tree.no.tree.no.tree.no.tree'), 'profundidad 4: ' + JSON.stringify(errs(deep)));
  // 5 preguntas con profundidad ≤ 3
  const wide = DEC(q('¿A?', { tree: q('¿B?', { tree: q('¿C?', leaf('x'), leaf('y')) }, leaf('z')) }, { tree: q('¿D?', { tree: q('¿E?', leaf('x'), leaf('y')) }, leaf('z')) }));
  assert(errs(wide).some((e) => e.code === 'DIAGRAM_SHAPE' && /como máximo 4 preguntas \(hay 5\)/.test(e.message)), '5 preguntas: ' + JSON.stringify(errs(wide)));
  assert(!errs(wide).some((e) => /encadenadas/.test(e.message)), '5 preguntas en profundidad 3 no es error de profundidad');
  // sin «?»
  const noQ = F.clone(DEPTH1); noQ.tree.question = 'La persona responde';
  assert(errs(noQ).some((e) => e.code === 'DIAGRAM_SHAPE' && e.path === 'component.tree.question'), 'pregunta sin «?»');
  // nodes / ejes en decision; tree en flow
  const withNodes = Object.assign(F.clone(DEPTH1), { nodes: [{ label: 'a' }, { label: 'b' }, { label: 'c' }], x_axis: 'x' });
  const wn = errs(withNodes);
  assert(wn.some((e) => e.code === 'DIAGRAM_SHAPE' && e.path === 'component.nodes') && wn.some((e) => e.code === 'DIAGRAM_SHAPE' && e.path === 'component.x_axis'), 'nodes/ejes en decision: ' + JSON.stringify(wn));
  const flowTree = { type: 'diagram', kind: 'flow', title: 'Flujo', nodes: [{ label: 'A' }, { label: 'B' }, { label: 'C' }], tree: DEPTH1.tree };
  assert(JSON.stringify(codes(flowTree)) === '["DIAGRAM_SHAPE"]', 'tree en flow: ' + JSON.stringify(errs(flowTree)));
  const noTree = F.clone(DEPTH1); delete noTree.tree;
  assert(codes(noTree).includes('MISSING_FIELD'), 'decision sin tree');
  // longitudes, campos extra, lints de texto dentro del árbol
  const long = F.clone(DEPTH1); long.tree.question = '¿' + 'x'.repeat(90) + '?'; long.tree.yes.label = 'y'.repeat(25); long.tree.no.action = 'z'.repeat(91); long.tree.no.extra = 1; long.tree.extra = 1;
  const lc = errs(long).map((e) => e.code + ' ' + e.path);
  for (const want of ['TEXT_TOO_LONG component.tree.question', 'TEXT_TOO_LONG component.tree.yes.label', 'TEXT_TOO_LONG component.tree.no.action', 'UNKNOWN_FIELD component.tree.no.extra', 'UNKNOWN_FIELD component.tree.extra']) assert(lc.includes(want), `falta ${want}: ${JSON.stringify(lc)}`);
  const lint = F.clone(DEPTH1); lint.tree.no.action = 'Revisa el video del capítulo.';
  assert(codes(lint).includes('RESOURCE_MENTION'), 'lints R2 dentro del árbol');
  // árbol hostil muy profundo: termina y reporta
  let hostile = leaf('fin');
  for (let i = 0; i < 2000; i++) hostile = { tree: q('¿N?', leaf('x'), hostile) };
  assert(codes(DEC(hostile.tree)).includes('DIAGRAM_SHAPE'), 'árbol hostil');
  // capítulo con decision en deepening: schema + pedagogía (cuenta como recurso visual)
  const d = F.buildExperience();
  d.movements.deepening = [d.movements.deepening[0], F.clone(DEPTH3)];
  d.movements.opening[0] = { type: 'hero', title: 'Primeros pasos', lead: 'Antes de actuar, decide con criterio.' };
  d.movements.closing = [d.movements.closing[1]];
  assert(vc.validateExperience(d).ok, 'experiencia con decision: ' + JSON.stringify(vc.validateExperience(d).errors));
  assert(!vc.validatePedagogy(d).some((e) => /recurso visual/.test(e.message)), 'decision cuenta como recurso visual: ' + JSON.stringify(vc.validatePedagogy(d)));
});

check('EV6: validateSimulatedDiagrams — DIAGRAM_BRANCHING_IN_SEQUENCE y TEXT_SIMULATED_DIAGRAM (sin falsos positivos)', () => {
  const doc = (deepExtra, bridge) => {
    const d = F.buildExperience();
    if (deepExtra) d.movements.deepening = [d.movements.deepening[0], deepExtra];
    if (bridge !== undefined) d.bridge_to_next = bridge;
    return d;
  };
  const codesAt = (d) => vc.validateSimulatedDiagrams(d).map((e) => `${e.code} ${e.path}`);
  assert(vc.validateSimulatedDiagrams(F.buildExperience()).length === 0, 'fixture completo sin hallazgos: ' + JSON.stringify(vc.validateSimulatedDiagrams(F.buildExperience())));
  // Auditoría #413: árbol aplanado en un flujo
  const flat = { type: 'diagram', kind: 'flow', title: 'Valoración', nodes: [{ label: '¿Responde?' }, { label: 'Sí → Consciente' }, { label: 'No → Inconsciente' }, { label: '¿Respira?' }] };
  const fc = codesAt(doc(flat));
  assert(fc.includes('DIAGRAM_BRANCHING_IN_SEQUENCE $.movements.deepening[1].nodes[1].label') && fc.includes('DIAGRAM_BRANCHING_IN_SEQUENCE $.movements.deepening[1].nodes[2].label'), 'flujo aplanado: ' + JSON.stringify(fc));
  for (const [type, list, field] of [['process_steps', 'steps', 'heading'], ['timeline', 'events', 'heading']]) {
    for (const head of ['Si no responde, pide ayuda', 'En caso contrario, detén la máquina', 'SÍ → sigue', 'No -> detén', 'Si responde → sigue']) {
      const items = [0, 1, 2].map((i) => Object.assign({ heading: i === 1 ? head : 'Paso normal ' + 'abc'[i], body: 'Detalle del paso.' }, type === 'timeline' ? { marker: 'Etapa' } : {}));
      const c = { type, [list]: items };
      assert(codesAt(doc(c)).includes(`DIAGRAM_BRANCHING_IN_SEQUENCE $.movements.deepening[1].${list}[1].${field}`), `${type} "${head}": ${JSON.stringify(codesAt(doc(c)))}`);
    }
  }
  // Fix round 1 (I1): variantes que el modelo produce después de «no escribas Sí → …»
  for (const head of VC_BRANCH_POSITIVES) {
    assert(vc.isBranchHead(head), `isBranchHead("${head}")`);
    const c = { type: 'diagram', kind: 'flow', title: 'Valoración', nodes: [{ label: 'Observar' }, { label: head }, { label: 'Actuar' }] };
    assert(codesAt(doc(c)).includes('DIAGRAM_BRANCHING_IN_SEQUENCE $.movements.deepening[1].nodes[1].label'), `flujo con "${head}": ${JSON.stringify(codesAt(doc(c)))}`);
  }
  // señal estructural: «¿Responde?» seguida de ramas → también se marca la pregunta
  const bare = { type: 'diagram', kind: 'flow', title: 'Valoración', nodes: ['¿Responde?', 'Sí', 'Consciente', 'No', 'Inconsciente'].map((label) => ({ label })) };
  const bc = codesAt(doc(bare));
  for (const j of [0, 1, 3]) assert(bc.includes(`DIAGRAM_BRANCHING_IN_SEQUENCE $.movements.deepening[1].nodes[${j}].label`), `flujo «Sí»/«No» sueltos, nodo ${j}: ${JSON.stringify(bc)}`);
  assert(bc.length === 3, 'solo pregunta + ramas: ' + JSON.stringify(bc));
  const qOnly = { type: 'process_steps', steps: [{ heading: '¿Qué riesgo ves?', body: 'a' }, { heading: 'Evalúa el riesgo', body: 'b' }, { heading: 'Controla', body: 'c' }] };
  assert(codesAt(doc(qOnly)).length === 0, 'una pregunta sin ramas no es un árbol');
  // Fix round 2: DÉBILES — nunca solos; sí en pareja de polaridad opuesta o tras una pregunta
  for (const head of VC_BRANCH_WEAK) {
    assert(!vc.isBranchHead(head) && vc.branchHead(head).strength === 'weak', `débil "${head}"`);
    const alone = { type: 'process_steps', steps: [{ heading: 'Asegura la escena', body: 'a' }, { heading: head, body: 'b' }, { heading: 'Llama a emergencias', body: 'c' }, { heading: 'Mantén la vigilancia', body: 'd' }] };
    assert(codesAt(doc(alone)).length === 0, `débil solo en un procedimiento "${head}": ${JSON.stringify(codesAt(doc(alone)))}`);
    const afterQ = { type: 'diagram', kind: 'flow', title: 'V', nodes: [{ label: '¿Responde?' }, { label: head }, { label: 'Actúa' }] };
    const aq = codesAt(doc(afterQ));
    assert(aq.includes('DIAGRAM_BRANCHING_IN_SEQUENCE $.movements.deepening[1].nodes[1].label') && aq.includes('DIAGRAM_BRANCHING_IN_SEQUENCE $.movements.deepening[1].nodes[0].label'), `débil tras pregunta "${head}": ${JSON.stringify(aq)}`);
  }
  for (const [heads, want] of VC_BRANCH_SEQ_CASES) {
    assert(JSON.stringify(vc.branchingHeadIndexes(heads)) === JSON.stringify(want), `${JSON.stringify(heads)} → ${JSON.stringify(vc.branchingHeadIndexes(heads))}, esperado ${JSON.stringify(want)}`);
    const c = { type: 'process_steps', steps: heads.map((heading) => ({ heading, body: 'Detalle.' })) };
    const extraQ = heads.filter((h, i) => vc.isQuestionHead(h) && want.some((k) => k > i)).length; // la pregunta que anuncia ramas también se marca
    assert(codesAt(doc(c)).length === want.length + extraQ, `procedimiento ${JSON.stringify(heads)}: ${JSON.stringify(codesAt(doc(c)))}`);
  }
  const paired = { type: 'diagram', kind: 'flow', title: 'Valoración', nodes: ['Evalúa la respuesta', 'Sí, está consciente', 'No, llama al 123', 'Vigila la respiración'].map((label) => ({ label })) };
  const pc = codesAt(doc(paired));
  assert(pc.length === 2 && pc.includes('DIAGRAM_BRANCHING_IN_SEQUENCE $.movements.deepening[1].nodes[1].label') && pc.includes('DIAGRAM_BRANCHING_IN_SEQUENCE $.movements.deepening[1].nodes[2].label'), 'pareja «Sí, …» + «No, …»: ' + JSON.stringify(pc));
  // Fix round 3: pareja con guion y dos puntos («Sí – …» / «No: …») en un flujo
  const paired3 = { type: 'diagram', kind: 'flow', title: 'Valoración', nodes: ['Evalúa la respuesta', 'Sí – está consciente', 'No: llama al 123', 'Vigila la respiración'].map((label) => ({ label })) };
  assert(JSON.stringify(codesAt(doc(paired3))) === JSON.stringify([1, 2].map((j) => `DIAGRAM_BRANCHING_IN_SEQUENCE $.movements.deepening[1].nodes[${j}].label`)), 'pareja «Sí – …» + «No: …»: ' + JSON.stringify(codesAt(doc(paired3))));
  for (const head of VC_BRANCH_NEGATIVES) {
    const c = { type: 'process_steps', steps: [{ heading: head, body: 'Detalle.' }, { heading: 'Otro paso', body: 'Detalle.' }, { heading: 'Cierre', body: 'Detalle.' }] };
    assert(codesAt(doc(c)).length === 0, `falso positivo "${head}": ${JSON.stringify(codesAt(doc(c)))}`);
    assert(!vc.isBranchHead(head), `isBranchHead("${head}")`);
  }
  // flechas
  for (const t of ['Paso 1 → Paso 2 → Paso 3', 'Recibir -> clasificar -> responder', 'Causa ⇒ efecto ⇒ medida', 'Observa → decide -> actúa']) {
    const c = { type: 'callout', variant: 'info', body: t };
    assert(codesAt(doc(null, t)).includes('TEXT_SIMULATED_DIAGRAM $.bridge_to_next'), `bridge "${t}"`);
    const d = doc(); d.movements.opening[2] = c;
    assert(codesAt(d).includes('TEXT_SIMULATED_DIAGRAM $.movements.opening[2].body'), `callout "${t}": ${JSON.stringify(codesAt(d))}`);
  }
  const nested = doc(); nested.movements.deepening[0].cards[0].definition = 'Entrada → proceso → salida.';
  assert(codesAt(nested).includes('TEXT_SIMULATED_DIAGRAM $.movements.deepening[0].cards[0].definition'), 'campo anidado');
  for (const t of ['El calor sube → el aceite pierde viscosidad.', 'Una flecha → aquí.\n\nOtra flecha → en otro párrafo.', 'Calor → dilatación\nFrío → contracción', 'Temperatura a 40 °C y presión estable.']) {
    assert(codesAt(doc(null, t)).length === 0, `falso positivo flechas "${t}"`);
  }
  assert(vc.arrowChainLength('a → b → c') === 2 && vc.arrowChainLength('a → b\n\nc → d') === 1 && vc.arrowChainLength('a → b\nc → d') === 1, 'arrowChainLength por línea (M1)');
  // el árbol de decisión real no dispara nada
  assert(codesAt(doc(F.clone(DEPTH3))).length === 0, 'decision limpia');
  // el empaque (validateExperience) no aplica estos lints: los cursos ya generados siguen válidos
  assert(vc.validateExperience(doc(flat, 'Observa → decide → actúa.')).ok, 'validateExperience no cambia');
});

check('EV6: render de decision — CLEAN_SAFE sin <style>/flex/grid/height, orden «pregunta → Sí → No», ENHANCED con dos columnas solo si hay decision', () => {
  for (const { combo, theme } of themes) {
    for (const c of [DEPTH1, DEPTH3, components.find((x) => x.kind === 'decision')]) {
      const clean = vc.renderMovement([c], theme, { uid: 'dt' });
      for (const bad of ['<style', '<script', 'flex', 'grid', 'display:', 'aria-', 'border-radius']) assert(!clean.includes(bad), `${F.themeLabel(combo)}: "${bad}" en CLEAN_SAFE`);
      assert(!/(?:^|[;"\s])(?:min-|max-)?height\s*:/.test(clean) && !/\sheight=/.test(clean), `${F.themeLabel(combo)}: height en CLEAN_SAFE (el purificador lo quita)`);
      assert(vc.lintCleanSafe(clean).ok, `${F.themeLabel(combo)} lint clean: ${JSON.stringify(vc.lintCleanSafe(clean).errors.slice(0, 3))}`);
      const enh = vc.renderMovement([c], theme, { uid: 'dt', level: 'enhanced' });
      assert(vc.lintCleanSafe(enh).ok, `${F.themeLabel(combo)} lint enhanced`);
      assert(enh.includes('.cvc-dt-d1>.cvc-dt-branches{display:grid'), 'dos columnas en ENHANCED');
      assert(vc.extractText(clean) === vc.extractText(enh), 'mismo texto en ambos niveles');
    }
  }
  const text = vc.extractText(vc.renderComponent(DEPTH1, themes[0].theme, { uid: 'o' }));
  const order = ['Diagrama · Decisión', 'Valoración inicial', '¿Responde cuando le hablas?', 'Sí', 'Mantenla acompañada', 'No', 'Llama a emergencias'];
  let from = 0;
  for (const s of order) { const i = text.indexOf(s, from); assert(i >= 0, `orden: falta "${s}" después de ${from} en "${text}"`); from = i + s.length; }
  // d3: el orden de lectura recorre el árbol en profundidad, «Sí» antes que «No» en cada nivel
  const t3 = vc.extractText(vc.renderComponent(DEPTH3, themes[0].theme, { uid: 'o' }));
  from = 0;
  for (const s of ['¿Responde?', 'Consciente', 'Pregúntale', 'Inconsciente', '¿Respira', 'Sí', 'Posición lateral', 'No', '¿Hay un desfibrilador', 'Sí', 'pide que lo traigan', 'No', 'llama a emergencias']) { const i = t3.indexOf(s, from); assert(i >= 0, `orden d3: "${s}"`); from = i + s.length; }
  // snapshot de estructura: par de acciones → <table> de 2 columnas; rama con subárbol → apilada
  const h1 = vc.renderComponent(DEPTH1, themes[0].theme, { uid: 's' });
  assert((h1.match(/<td class="cvc-dt-br/g) || []).length === 2 && !h1.includes('cvc-dt-branches'), 'profundidad 1: par lado a lado');
  const h3 = vc.renderComponent(DEPTH3, themes[0].theme, { uid: 's' });
  assert((h3.match(/class="cvc-dt-node cvc-dt-d/g) || []).length === 3 && h3.includes('cvc-dt-d3') && (h3.match(/class="cvc-dt-branches"/g) || []).length === 3, 'profundidad 3: 3 nodos, los 3 niveles apilados');
  assert(!h3.includes('<table'), 'el par de nivel 3 se apila (no aprieta una tabla en un teléfono)');
  assert(h3.includes('>Consciente<') && h3.split('&shy;').join('').includes('>Inconsciente<'), 'rótulos propios');
  // Fix round 1 (M2): texto plano «Sí: …» / «No: …»; el conector ↙ / ↘ es decorativo (solo ::before en ENHANCED)
  assert(!h3.includes('↙') && !h3.includes('↘'), 'sin glifos en el texto');
  const plain1 = vc.extractText(vc.renderComponent(DEPTH1, themes[0].theme, { uid: 'o' })).replace(/\s+/g, ' ');
  assert(plain1.includes('¿Responde cuando le hablas? Sí: Mantenla acompañada') && plain1.includes('No: Llama a emergencias'), 'texto plano: ' + plain1);
  const plain3 = vc.extractText(h3).replace(/\s+/g, ' ');
  assert(plain3.includes('Consciente: Pregúntale') && plain3.includes('Sí: Posición lateral'), 'rótulo propio con «:»: ' + plain3);
  const enh1 = vc.renderMovement([DEPTH1], themes[0].theme, { uid: 'g', level: 'enhanced' });
  assert(enh1.includes('.cvc-dt-sep{display:none}') && enh1.includes('content:"\\2199" / ""') && enh1.includes('content:"\\2198" / ""'), 'conectores decorativos en ENHANCED');
  assert(vc.renderComponent(DEPTH1, themes[0].theme, { uid: 's' }) === h1, 'determinista');
  // sin decision en el label: <style> byte-idéntico al de siempre (sin reglas cvc-dt)
  const flow = components.find((x) => x.kind === 'flow');
  assert(!vc.renderMovement([flow], themes[0].theme, { uid: 'f', level: 'enhanced' }).includes('cvc-dt'), 'labels sin decision no cargan sus reglas');
  let msg = '';
  try { vc.renderComponent({ type: 'diagram', kind: 'decision', tree: { question: '¿x?', yes: {}, no: { action: 'a' } } }, themes[0].theme, { uid: 'x' }); } catch (err) { msg = err.message; }
  assert(/^VC_RENDER: diagram/.test(msg), 'rama sin action/tree → VC_RENDER: ' + msg);
});

check('validador: HTML en texto → HTML_IN_TEXT (tags, cierre, comentario)', () => {
  expectCode(mutate((d) => (d.movements.opening[0].title = 'Hola <b>mundo</b>')), 'HTML_IN_TEXT', 'opening[0].title');
  expectCode(mutate((d) => (d.movements.deepening[0].cards[1].definition = 'texto </p> suelto')), 'HTML_IN_TEXT', 'cards[1].definition');
  expectCode(mutate((d) => (d.bridge_to_next = 'antes <!-- x --> después')), 'HTML_IN_TEXT', 'bridge_to_next');
  expectCode(mutate((d) => (d.movements.closing[0].prompt = '<script>alert(1)</script>')), 'HTML_IN_TEXT');
  // "a < b" no es una etiqueta
  const ok = vc.validateComponent({ type: 'callout', variant: 'info', body: 'Si a < b y b > c, entonces a < c.' });
  assert(ok.length === 0, JSON.stringify(ok));
});

check('validador: campo desconocido → UNKNOWN_FIELD (componente, ítem, raíz, movimiento)', () => {
  expectCode(mutate((d) => (d.movements.opening[0].html = '<b>x</b>')), 'UNKNOWN_FIELD', 'opening[0].html');
  expectCode(mutate((d) => (d.movements.deepening[1].items[0].extra = 'x')), 'UNKNOWN_FIELD', 'items[0].extra');
  expectCode(mutate((d) => (d.foo = 1)), 'UNKNOWN_FIELD', '$.foo');
  expectCode(mutate((d) => (d.movements.intro = [])), 'UNKNOWN_FIELD', 'movements.intro');
});

check('validador: tipo desconocido, enum, faltantes, tipos de dato, schemaVersion, chapterId', () => {
  expectCode(mutate((d) => (d.movements.opening[0] = { type: 'carousel', items: [] })), 'UNKNOWN_COMPONENT');
  expectCode(mutate((d) => (d.movements.opening[2].variant = 'danger')), 'ENUM_VALUE');
  expectCode(mutate((d) => delete d.movements.opening[0].title), 'MISSING_FIELD', 'opening[0].title');
  expectCode(mutate((d) => delete d.movements.synthesis), 'MISSING_FIELD', 'movements.synthesis');
  expectCode(mutate((d) => delete d.bridge_to_next), 'MISSING_FIELD', 'bridge_to_next');
  expectCode(mutate((d) => (d.movements.opening[1].items = 'x')), 'TYPE_MISMATCH');
  expectCode(mutate((d) => (d.movements.opening[0].lead = 42)), 'TYPE_MISMATCH');
  expectCode(mutate((d) => (d.vcSchemaVersion = 2)), 'SCHEMA_VERSION');
  expectCode(mutate((d) => (d.chapterId = 'cap 1 <x>')), 'CHAPTER_ID');
  const r = vc.validateExperience(null);
  assert(!r.ok && r.errors[0].code === 'NOT_OBJECT', 'null → NOT_OBJECT');
});

check('validador: rangos de cantidad por componente (COUNT_RANGE / ARITY_MISMATCH)', () => {
  const cases = [
    ['concept_cards', (c) => (c.cards = c.cards.slice(0, 1))],
    ['concept_cards', (c) => (c.cards = Array(7).fill(c.cards[0]))],
    ['tabs', (c) => (c.tabs = c.tabs.slice(0, 1))],
    ['tabs', (c) => (c.tabs = Array(6).fill(c.tabs[0]))],
    ['timeline', (c) => (c.events = c.events.slice(0, 2))],
    ['timeline', (c) => (c.events = Array(9).fill(c.events[0]))],
    ['process_steps', (c) => (c.steps = c.steps.slice(0, 2))],
    ['process_steps', (c) => (c.steps = Array(9).fill(c.steps[0]))],
    ['comparison', (c) => (c.columns = ['A'])],
    ['comparison', (c) => (c.columns = ['A', 'B', 'C', 'D', 'E'])],
    ['comparison', (c) => (c.rows = c.rows.slice(0, 1))],
    ['comparison', (c) => (c.rows = Array(9).fill(c.rows[0]))],
    ['self_check', (c) => (c.items = c.items.slice(0, 1))],
    ['self_check', (c) => (c.items = Array(5).fill(c.items[0]))],
    ['learning_objectives', (c) => (c.items = Array(7).fill('Objetivo claro'))],
    ['summary_visual', (c) => (c.points = c.points.slice(0, 2))],
    ['checklist', (c) => (c.items = c.items.slice(0, 2))],
  ];
  for (const [type, fn] of cases) {
    const c = F.clone(components.find((x) => x.type === type));
    fn(c);
    const e = vc.validateComponent(c);
    assert(codesOf(e).includes('COUNT_RANGE') || codesOf(e).includes('ARITY_MISMATCH'), `${type}: ${JSON.stringify(e)}`);
  }
  const cmp = F.clone(components.find((x) => x.type === 'comparison'));
  cmp.rows[1].cells = ['solo una'];
  assert(codesOf(vc.validateComponent(cmp)).includes('ARITY_MISMATCH'), 'ARITY_MISMATCH');
});

check('R14: comparación almacenada con la columna del rótulo + relleno "—" → se normaliza al renderizar (sin regenerar)', () => {
  const t = themes[0].theme;
  const legacy = {
    type: 'comparison',
    title: 'Niveles de adaptación y esfuerzo docente',
    columns: ['Tipo de adaptación', 'Qué cambia', 'Riesgo de error', 'Ejemplo real'],
    rows: [
      { label: 'Cambio de lenguaje', cells: ['Simplificar jerga sin perder contenido', 'Bajo a medio', 'Artículo académico → guía práctica', '—'] },
      { label: 'Cambio de formato', cells: ['De ensayo a procedimiento', 'Bajo', 'Capítulo → protocolo paso a paso', '—'] },
    ],
  };
  const n = vc.normalizeLegacyLabelColumn(legacy.columns, legacy.rows);
  assert(n && JSON.stringify(n.columns) === JSON.stringify(['Qué cambia', 'Riesgo de error', 'Ejemplo real']), JSON.stringify(n));
  assert(n.rows.every((r) => r.cells.length === 3 && !r.cells.includes('—')), 'sin relleno');
  for (const level of [undefined, 'enhanced']) {
    const html = vc.renderComponent(legacy, t, { uid: 'lg', level });
    assert(!html.includes('>—<') && !html.includes('Tipo de adaptación'), level + ': sin columna del rótulo ni relleno');
    assert(html.includes('Ejemplo real') && html.includes('Capítulo → protocolo paso a paso'), level + ': contenido completo');
  }
  // Un SUJETO real con relleno, o filas sin la firma exacta → intacto.
  assert(vc.normalizeLegacyLabelColumn(['Docente', 'Estudiante', 'Familia'], [{ label: 'Rol', cells: ['Guía', 'Aprende', '—'] }]) === null, 'sujeto real');
  assert(vc.normalizeLegacyLabelColumn(['Aspecto', 'A', 'B'], [{ label: 'x', cells: ['1', '2', '—'] }, { label: 'y', cells: ['1', '2', '3'] }]) === null, 'relleno parcial');
  assert(vc.normalizeLegacyLabelColumn(['A', 'B'], [{ label: 'x', cells: ['1', '—'] }]) === null, 'dos columnas');
  assert(vc.normalizeLegacyLabelColumn(['Nivel básico', 'Nivel intermedio', 'Nivel avanzado'], [{ label: 'x', cells: ['1', '2', '—'] }]) === null, 'serie de sujetos');
  assert(vc.normalizeLegacyLabelColumn(['Opción A', 'Opción B', 'Opción C'], [{ label: 'x', cells: ['1', '2', '—'] }]) === null, 'serie de opciones');
});

check('validador: límites por movimiento, self_check exclusivo, diversidad y repetición de tipos', () => {
  // Edu EV2: deepening admite hasta 5 (4 del fixture + 2 = 6 → fuera de rango).
  expectCode(mutate((d) => d.movements.deepening.push(d.movements.opening[1], d.movements.opening[2])), 'MOVEMENT_RANGE', 'deepening');
  expectCode(mutate((d) => (d.movements.opening = [])), 'MOVEMENT_RANGE', 'opening');
  expectCode(mutate((d) => d.movements.opening.push(d.movements.closing[0])), 'MOVEMENT_RANGE', 'opening');
  expectCode(mutate((d) => d.movements.synthesis.push(d.movements.closing[0])), 'MOVEMENT_RANGE', 'synthesis');
  expectCode(mutate((d) => d.movements.self_check.push(F.clone(d.movements.self_check[0]))), 'MOVEMENT_RANGE', 'self_check');
  expectCode(mutate((d) => (d.movements.self_check = [d.movements.opening[2]])), 'COMPONENT_NOT_ALLOWED', 'self_check[0]');
  expectCode(mutate((d) => (d.movements.closing[1] = F.clone(d.movements.self_check[0]))), 'COMPONENT_NOT_ALLOWED', 'closing[1]');
  expectCode(
    mutate((d) => {
      const co = d.movements.opening[2];
      d.movements.deepening[3] = F.clone(co);
      d.movements.synthesis[1] = F.clone(co);
    }),
    'TYPE_REPEATED',
  );
  // un solo tipo (salvo self_check obligatorio) → TYPE_DIVERSITY no aplica (hay 2), pero TYPE_REPEATED sí
  const mono = mutate((d) => {
    const co = d.movements.opening[2];
    for (const mv of ['opening', 'deepening', 'synthesis', 'closing', 'video_primer']) d.movements[mv] = [F.clone(co)];
  });
  const r = vc.validateExperience(mono);
  assert(codesOf(r).includes('TYPE_REPEATED'), 'TYPE_REPEATED en mono');
  // diversidad: documento con un único tipo en total
  const div = vc.validateExperience({
    vcSchemaVersion: 1,
    chapterId: 'x',
    movements: { opening: [], deepening: [], synthesis: [], closing: [], video_primer: [], self_check: [F.clone(mono.movements.self_check[0])] },
    bridge_to_next: 'Seguimos.',
  });
  assert(codesOf(div).includes('TYPE_DIVERSITY'), 'TYPE_DIVERSITY');
});

check('validador: longitudes, vacío y formato (TEXT_TOO_LONG / TEXT_EMPTY / TEXT_FORMAT)', () => {
  expectCode(mutate((d) => (d.movements.opening[0].title = 'x'.repeat(121))), 'TEXT_TOO_LONG', 'opening[0].title');
  const at = vc.validateExperience(mutate((d) => (d.movements.opening[0].title = 'x'.repeat(120))));
  assert(at.ok, 'título de 120 caracteres debe pasar');
  expectCode(mutate((d) => (d.movements.deepening[2].tabs[0].label = 'y'.repeat(41))), 'TEXT_TOO_LONG', 'tabs[0].label');
  expectCode(mutate((d) => (d.bridge_to_next = 'z'.repeat(301))), 'TEXT_TOO_LONG', 'bridge_to_next');
  expectCode(mutate((d) => (d.movements.opening[0].lead = '   ')), 'TEXT_EMPTY');
  expectCode(mutate((d) => (d.movements.opening[0].lead = 'un **énfasis sin cerrar')), 'TEXT_FORMAT');
  expectCode(mutate((d) => (d.movements.opening[0].lead = 'control \u0007 char')), 'TEXT_FORMAT');
});

check('validador: junta todos los errores (no corta en el primero)', () => {
  const d = mutate((d) => {
    d.movements.opening[0].title = '<i>x</i>';
    d.movements.deepening[0].cards = d.movements.deepening[0].cards.slice(0, 1);
    d.bridge_to_next = 'Nos vemos en el video del capítulo 3';
    d.extra = true;
  });
  const codes = codesOf(vc.validateExperience(d));
  for (const c of ['HTML_IN_TEXT', 'COUNT_RANGE', 'RESOURCE_MENTION', 'QUANTITY_CLAIM', 'UNKNOWN_FIELD']) assert(codes.includes(c), `falta ${c} en ${codes}`);
});

check('lint RESOURCE_MENTION (ruling I4): referencias a recursos/navegación sí, vocabulario del dominio no', () => {
  const deny = [
    'En el video verás el proceso', 'Mira este video con atención', 'Observa el VIDEO', 'los videos del capítulo',
    'Resuelve la actividad interactiva', 'la actividad de práctica', 'Continúa en la siguiente actividad',
    'Prepárate para el examen', 'Repasa antes del examen', 'la evaluación del módulo', 'La evaluación final',
    'En la presentación verás los datos', 'Revisa la presentación del capítulo', 'la presentación de este capítulo',
    'la diapositiva 3', 'las diapositivas', 'el quiz', 'un SCORM', 'el H5P', 'un juego interactivo', 'el juego de práctica',
    'Sigue con el siguiente recurso', 'En este Vídeo', 'Verás un video', 'en estas diapositivas', 'este quiz', 'En la siguiente diapositiva', 'la última diapositiva', 'en las próximas diapositivas',
  ];
  for (const t of deny) assert(vc.lintResourceMentions(t).length >= 1, `debió marcar: "${t}"`);
  const allow = [
    'El juego de roles ayuda a practicar la escucha', 'juego limpio entre colegas', 'La evaluación de riesgos es obligatoria',
    'evaluación del desempeño', 'La presentación de resultados al cliente', 'la presentación del producto',
    'la actividad económica del sector', 'las actividades del puesto', 'Un examen físico previo', 'el examen médico anual',
    'producción de video para redes', 'videojuegos y aprendizaje', 'reactividad', 'evaluar el caso', 'presentar la idea',
    // R14 (curso sobre enseñar y evaluar): menciones GENÉRICAS del tema, no del curso.
    'Diseña un examen que valore el proceso', 'unos exámenes bien diseñados', 'crea un quiz de repaso con IA',
    'genera diapositivas claras para tu clase', 'Un examen tradicional mide memoria',
  ];
  for (const t of allow) assert(vc.lintResourceMentions(t).length === 0, `no debió marcar: "${t}" → ${JSON.stringify(vc.lintResourceMentions(t))}`);
  expectCode(mutate((d) => (d.movements.deepening[3].rows[0].cells[1] = 'Como en la Presentación')), 'RESOURCE_MENTION', 'rows[0].cells[1]');
  expectCode(mutate((d) => (d.movements.video_primer[0].steps[0].body = 'Observa el VIDEO con atención')), 'RESOURCE_MENTION', 'steps[0].body');
  // el énfasis no evade el lint
  expectCode(mutate((d) => (d.movements.opening[0].lead = 'Mira **el** video')), 'RESOURCE_MENTION');
  const ok = vc.validateExperience(mutate((d) => (d.movements.opening[0].lead = 'El **juego de roles** y la **evaluación de riesgos** son parte del trabajo.')));
  assert(ok.ok, JSON.stringify(ok.errors));
});

check('lint QUANTITY_CLAIM: dígitos pegados a módulos/capítulos/…/%', () => {
  const pos = ['3 módulos', 'los 12 capítulos', 'capítulo 2', 'Módulo n° 4', '15 minutos', '2 horas', '10 páginas', '3 intentos', '5 preguntas', '30%', '45 %', '2,5 horas', '4 videos', '2 actividades'];
  for (const t of pos) assert(vc.lintQuantityClaims(t).length >= 1, `debió marcar: ${t}`);
  const neg = ['el año 1990', 'módulos del curso', 'en 3 pasos', 'Década de 1970', 'tres módulos', 'hora de actuar'];
  for (const t of neg) assert(vc.lintQuantityClaims(t).length === 0, `no debió marcar: ${t} → ${JSON.stringify(vc.lintQuantityClaims(t))}`);
  expectCode(mutate((d) => (d.movements.synthesis[0].points[0] = 'El 80% de las quejas se resuelve escuchando')), 'QUANTITY_CLAIM', 'points[0]');
});

check('I1: el énfasis ** y los invisibles no evaden QUANTITY_CLAIM / RESOURCE_MENTION', () => {
  const pos = ['En **3** módulos', '**3** módulos', 'el **30**% del grupo', 'el **30%** del grupo', 'Ver **capítulo** 2', '**capítulo 2**', '3\n**módulos**', '3  \n  módulos'];
  for (const t of pos) assert(vc.lintQuantityClaims(t).length >= 1, `debió marcar: ${JSON.stringify(t)}`);
  expectCode(mutate((d) => (d.movements.opening[0].lead = 'Recuerda **esta idea\nclave** siempre. En **3** módulos y el **30**% y **capítulo** 2')), 'QUANTITY_CLAIM');
  // invisibles: rechazados explícitamente
  for (const t of ['vid\u200Beo', 'hola\u00ADmundo', 'a\uFEFFb', 'x\u202Ey', 'p\uE000q']) {
    expectCode(mutate((d) => (d.movements.opening[0].lead = t)), 'TEXT_FORMAT');
  }
  assert(vc.lintResourceMentions('en el vid\u200Beo').length === 1, 'zero-width dentro de la palabra');
});

check('I1: énfasis que cruza saltos de línea se renderiza sin ** literales ni tramos corridos', () => {
  const t = themes[0].theme;
  const html = vc.renderComponent({ type: 'callout', variant: 'info', body: 'Recuerda **esta idea\nclave** siempre.\n\nOtro **párrafo\n\ncon énfasis** largo y **fin**.' }, t, { uid: 'b' });
  assert(!html.includes('**'), `quedaron ** literales: ${html}`);
  assert(html.includes('<strong>esta idea</strong><br><strong>clave</strong> siempre.'), `línea con énfasis: ${html}`);
  assert(html.includes('<strong>párrafo</strong>') && html.includes('<strong>con énfasis</strong> largo y <strong>fin</strong>.'), `párrafos con énfasis: ${html}`);
  assert(vc.extractText(html) === 'Dato Recuerda esta idea clave siempre. Otro párrafo con énfasis largo y fin.', vc.extractText(html));
  // strong siempre balanceado
  const opens = (html.match(/<strong>/g) || []).length;
  const closes = (html.match(/<\/strong>/g) || []).length;
  assert(opens === closes, `strong desbalanceado ${opens}/${closes}`);
  // un ** sin pareja queda literal (el validador lo rechaza igual)
  assert(vc.renderComponent({ type: 'callout', variant: 'info', body: 'a **b' }, t, { uid: 'b' }).includes('a **b'), 'literal');
});

check('I5: claves del prototipo no son tipos ni campos ("constructor", "__proto__", "toString")', () => {
  for (const type of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
    const e = vc.validateComponent(JSON.parse(`{"type":"${type}"}`));
    assert(e.some((x) => x.code === 'UNKNOWN_COMPONENT'), `${type}: ${JSON.stringify(e)}`);
    let msg = '';
    try {
      vc.renderMovement([JSON.parse(`{"type":"${type}"}`)], themes[0].theme, { uid: 'p' });
    } catch (err) {
      msg = err.message;
    }
    assert(/^VC_RENDER: tipo de componente desconocido/.test(msg), `${type}: renderer → ${msg}`);
  }
  const doc = F.buildExperience();
  for (const mv of ['opening', 'deepening', 'synthesis', 'closing', 'video_primer']) doc.movements[mv] = [{ type: 'constructor' }];
  const r = vc.validateExperience(doc);
  assert(!r.ok && r.errors.filter((e) => e.code === 'UNKNOWN_COMPONENT').length === 5, JSON.stringify(r.errors.slice(0, 3)));
  for (const extra of ['constructor', 'toString', '__proto__']) {
    const c = JSON.parse(`{"type":"callout","variant":"info","body":"hola","${extra}":"x"}`);
    const e = vc.validateComponent(c);
    assert(e.some((x) => x.code === 'UNKNOWN_FIELD' && x.path.endsWith(extra)), `${extra} como campo: ${JSON.stringify(e)}`);
  }
  const bad = JSON.parse('{"type":"callout","variant":"constructor","body":"hola"}');
  assert(vc.validateComponent(bad).some((x) => x.code === 'ENUM_VALUE'), 'variant constructor');
  let msg = '';
  try { vc.renderComponent(bad, themes[0].theme, { uid: 'p' }); } catch (err) { msg = err.message; }
  assert(/^VC_RENDER/.test(msg), `variant constructor en renderer: ${msg}`);
});

// ─── Renderer ───────────────────────────────────────────────────────────────

check('determinismo: mismo componente + tema + uid → mismos bytes; cambia con uid/tema/nivel', () => {
  for (const { theme } of themes) {
    for (const c of components) {
      for (const level of LEVELS) {
        const a = vc.renderComponent(c, theme, { uid: 'det-1', level });
        const b = vc.renderComponent(F.clone(c), te.resolveTheme({ themeFamily: theme.familyId, mode: theme.mode }), { uid: 'det-1', level });
        assert(a === b, `${theme.familyId}/${c.type}/${level}: no determinista`);
      }
    }
    const mv = F.buildExperience().movements.deepening;
    assert(vc.renderMovement(mv, theme, { uid: 'm-1', level: 'enhanced' }) === vc.renderMovement(F.clone(mv), theme, { uid: 'm-1', level: 'enhanced' }), 'movement');
    assert(vc.renderMovement(mv, theme, { uid: 'm-1', level: 'enhanced' }) !== vc.renderMovement(mv, theme, { uid: 'm-2', level: 'enhanced' }), 'uid cambia bytes');
    assert(vc.renderMovement(mv, theme, { uid: 'm-1' }) !== vc.renderMovement(mv, theme, { uid: 'm-1', level: 'enhanced' }), 'nivel cambia bytes');
  }
  const [a, b] = [themes[0].theme, themes[5].theme];
  assert(vc.renderComponent(components[0], a, { uid: 'x' }) !== vc.renderComponent(components[0], b, { uid: 'x' }), 'tema cambia bytes');
});

check('escape: <script>, atributos y entidades en texto quedan inertes (ambos niveles)', () => {
  const evil = '<script>alert(1)</script> "><img src=x onerror=alert(2)> & &amp; \'x\'';
  const comps = [
    { type: 'hero', title: evil, lead: evil, eyebrow: evil },
    { type: 'comparison', title: evil, columns: [evil, 'B'], rows: [{ label: evil, cells: [evil, evil] }, { label: 'b', cells: ['c', 'd'] }] },
    { type: 'tabs', tabs: [{ label: evil, body: evil }, { label: 'b', body: 'c' }] },
    { type: 'self_check', items: [{ q: evil, a: evil }, { q: 'q', a: 'a' }] },
  ];
  for (const level of LEVELS) {
    for (const c of comps) {
      const html = vc.renderMovement([c], themes[0].theme, { uid: 'esc', level });
      assert(!/<script>alert/i.test(html), `${c.type}: <script> sin escapar`);
      assert(!/<img/i.test(html), `${c.type}: <img> sin escapar`);
      const onAttrs = [];
      const walkOn = (el) => {
        if (el.kind !== 'el') return;
        for (const k of Object.keys(el.attrs)) if (/^on/i.test(k)) onAttrs.push(`${el.tag}[${k}]`);
        el.children.forEach(walkOn);
      };
      walkOn(vc.parseHtml(html));
      assert(onAttrs.length === 0, `${c.type}: atributos de evento en el HTML: ${onAttrs.join(', ')}`);
      assert(html.split('&shy;').join('').includes('&lt;script&gt;alert(1)&lt;/script&gt;'), `${c.type}: no se ve el texto escapado`);
      // el texto sobrevive tal cual (decodificado)
      assert(vc.extractText(html).includes('<script>alert(1)</script> "><img src=x onerror=alert(2)> & &amp; \'x\''), `${c.type}: texto no preservado`);
      // única <script> permitida: el runtime propio en ENHANCED
      const scripts = (html.match(/<script/g) || []).length;
      assert(scripts === (level === 'enhanced' ? 1 : 0), `${c.type}/${level}: ${scripts} <script>`);
    }
  }
  let threw = false;
  try {
    vc.renderComponent(components[0], themes[0].theme, { uid: 'x"><script>' });
  } catch (e) {
    threw = /VC_RENDER/.test(e.message);
  }
  assert(threw, 'uid inválido debe lanzar VC_RENDER');
  threw = false;
  try {
    vc.renderComponent({ type: 'marquee' }, themes[0].theme, { uid: 'x' });
  } catch (e) {
    threw = /VC_RENDER/.test(e.message);
  }
  assert(threw, 'tipo desconocido debe lanzar VC_RENDER');
});

check('**énfasis** → <strong>; saltos de línea → párrafos/<br>', () => {
  const html = vc.renderComponent({ type: 'callout', variant: 'info', body: 'uno **dos** tres\n\ncuatro\ncinco' }, themes[0].theme, { uid: 'x' });
  assert(html.includes('<strong>dos</strong>'), 'strong');
  // R14-A: el callout abre con un kicker (<p class="cvc-meta">); el cuerpo son 2 párrafos.
  assert((html.match(/<p (?!class="cvc-meta)/g) || []).length === 2, 'dos párrafos');
  assert(html.includes('cuatro<br>cinco'), 'br');
});

const LONG_COUNT = { n: 0 };
check('lintCleanSafe: todos los componentes × familias × modos × niveles × (normal, textos de 400 caracteres)', () => {
  let n = 0;
  for (const { combo, theme } of themes) {
    for (const c of components) {
      for (const variant of [c, F.longVariant(c)]) {
        for (const level of LEVELS) {
          for (const html of [
            vc.renderComponent(variant, theme, { uid: 'lint', level }),
            vc.renderMovement([variant], theme, { uid: 'lint', level }),
          ]) {
            const r = vc.lintCleanSafe(html);
            n++;
            assert(r.ok, `${F.themeLabel(combo)}/${c.type}${variant === c ? '' : '(largo)'}/${level || 'clean'}: ${JSON.stringify(r.errors.slice(0, 3))}`);
          }
        }
      }
    }
    // cada movimiento del capítulo completo
    const doc = F.buildExperience();
    for (const [mv, list] of Object.entries(doc.movements)) {
      for (const level of LEVELS) {
        const r = vc.lintCleanSafe(vc.renderMovement(list, theme, { uid: `ch-${mv.replace('_', '-')}`, level }));
        n++;
        assert(r.ok, `${F.themeLabel(combo)}/movimiento ${mv}/${level || 'clean'}: ${JSON.stringify(r.errors.slice(0, 3))}`);
      }
    }
  }
  // tema con seed problemática (acento amarillo)
  const seeded = te.resolveTheme({ themeFamily: 'aula-clara', mode: 'light', brandSeed: { accent: '#FFFF00' } });
  for (const c of components) {
    const r = vc.lintCleanSafe(vc.renderMovement([c], seeded, { uid: 'seed', level: 'enhanced' }));
    n++;
    assert(r.ok, `seed amarilla/${c.type}: ${JSON.stringify(r.errors.slice(0, 3))}`);
  }
  LONG_COUNT.n = n;
  assert(n > 900, `pocas combinaciones: ${n}`);
});

check('lintCleanSafe detecta violaciones (ocultos, color sin fondo, valores prohibidos, duplicados, fuente chica, contraste)', () => {
  const bg = (inner, extra = '') => `<div style="background-color:#FAFAFA;color:#111111${extra}">${inner}</div>`;
  const cases = [
    ['BASE_HIDDEN', bg('<p style="display:none;color:#111111">x</p>')],
    ['BASE_HIDDEN', bg('<p style="visibility:hidden">x</p>')],
    ['BASE_HIDDEN', bg('<details><summary>q</summary>a</details>')],
    ['BASE_HIDDEN', bg('<p hidden>x</p>')],
    ['NO_COLOR', '<p>texto suelto</p>'],
    ['NO_BACKGROUND', '<p style="color:#111111">x</p>'],
    ['COLOR_WITHOUT_BACKGROUND', '<p style="color:#111111">x</p>'],
    ['BG_NOT_PAIRED', bg('<div style="background-color:#101010"><p>x</p></div>')],
    ['NON_HEX_COLOR', bg('<p style="color:red">x</p>')],
    ['FORBIDDEN_VALUE', bg('<p style="color:oklch(0.5 0.1 200)">x</p>')],
    ['FORBIDDEN_VALUE', bg('<p style="color:var(--x)">x</p>')],
    ['FORBIDDEN_VALUE', bg('x', ';background-color:rgba(0,0,0,1)')],
    ['GRADIENT_WITHOUT_FALLBACK', '<div style="background:linear-gradient(#FAFAFA,#EEEEEE);color:#111111">x</div>'],
    ['LINK_WITHOUT_COLOR', bg('<p><a href="#">enlace inyectado</a></p>')],
    ['PURE_BLACK_WHITE', '<div style="background-color:#FFFFFF;color:#111111">x</div>'],
    ['PURE_BLACK_WHITE', '<div style="background-color:#FAFAFA;color:#000">x</div>'],
    ['DUPLICATE_SAFE_PROPERTY', bg('<p style="margin:0;margin:4px">x</p>')],
    ['FONT_TOO_SMALL', bg('<p style="font-size:14px">x</p>')],
    ['FONT_TOO_SMALL', bg('<span class="cvc-meta" style="font-size:12px">x</span>')],
    ['LOW_CONTRAST', '<div style="background-color:#FAFAFA;color:#AAAAAA">x</div>'],
  ];
  for (const [code, html] of cases) {
    const r = vc.lintCleanSafe(html);
    assert(!r.ok && r.errors.some((e) => e.code === code), `${code} no detectado en ${html}: ${JSON.stringify(r.errors)}`);
  }
  const good = [
    '<div style="background:linear-gradient(#FAFAFA,#EEEEEE);background-color:#FAFAFA;color:#111111">x</div>',
    bg('<p><a href="#" style="color:#1D4ED8">enlace con color</a></p>'),
    bg('<p style="font-size:18px;font-size:clamp(1rem, 1vw, 2rem)">x</p>'),
    bg('<span class="cvc-meta" style="font-size:14px">x</span>'),
    bg('<details open><summary>q</summary>a</details>'),
    bg('<style>.x{display:none}</style><script>var a="<p>"</script>x'),
  ];
  for (const html of good) {
    const r = vc.lintCleanSafe(html);
    assert(r.ok, `falso positivo en ${html}: ${JSON.stringify(r.errors)}`);
  }
});

check('fuente del cuerpo ≥ 16 px (18 base); < 16 solo en .cvc-meta (≥ 13)', () => {
  for (const { theme } of themes) {
    assert(theme.typography.sizeBodyPx === 18, 'sizeBodyPx 18');
    for (const c of components) {
      for (const level of LEVELS) {
        const html = vc.renderMovement([c], theme, { uid: 'fs', level });
        const root = vc.parseHtml(html);
        const walk = (el) => {
          if (el.kind !== 'el') return;
          const decls = vc.parseStyle(el.attrs.style);
          const fsd = decls.filter((d) => d.prop === 'font-size' && /px$/.test(d.value));
          for (const d of fsd) {
            const px = parseFloat(d.value);
            const meta = (el.attrs.class || '').split(/\s+/).includes('cvc-meta');
            assert(meta ? px >= 13 : px >= 16, `${c.type}: <${el.tag}> font-size ${px}px${meta ? ' (meta)' : ''}`);
          }
          el.children.forEach(walk);
        };
        walk(root);
        const rootStyle = vc.parseStyle(root.children[0].attrs.style);
        assert(rootStyle.find((d) => d.prop === 'font-size').value === '18px', 'raíz 18px');
      }
    }
  }
});

check('CLEAN_SAFE puro: sin <style>/<script>/<details>/aria/data-/role/display en el nivel base', () => {
  for (const { theme } of themes) {
    for (const c of components) {
      const html = vc.renderMovement([c], theme, { uid: 'cs' });
      for (const bad of ['<style', '<script', '<details', 'aria-', 'data-', 'role=', 'display:', 'border-radius', 'box-shadow', 'clamp(', ' id=']) {
        assert(!html.includes(bad), `${c.type}: "${bad}" en CLEAN_SAFE`);
      }
      const decls = [];
      const walk = (el) => {
        if (el.kind !== 'el') return;
        decls.push(...vc.parseStyle(el.attrs.style));
        el.children.forEach(walk);
      };
      walk(vc.parseHtml(html));
      for (const d of decls) assert(vc.isCleanSafeProperty(d.prop), `${c.type}: propiedad no segura "${d.prop}"`);
    }
  }
});

check('ENHANCED: un <style> con scope y un runtime por label; details abiertos; mismo texto que CLEAN_SAFE', () => {
  const doc = F.buildExperience();
  for (const { theme } of themes) {
    for (const [mv, list] of Object.entries(doc.movements)) {
      const uid = `eq-${mv.replace('_', '-')}`;
      const clean = vc.renderMovement(list, theme, { uid });
      const enh = vc.renderMovement(list, theme, { uid, level: 'enhanced' });
      assert(vc.extractText(clean) === vc.extractText(enh), `${theme.familyId}/${mv}: texto distinto entre niveles`);
      assert((enh.match(/<style>/g) || []).length === 1 && (enh.match(/<script>/g) || []).length === 1, `${mv}: style/script`);
      assert(enh.includes(`.cvc-${uid} `) && enh.includes(`data-cvc-uid="${uid}"`), `${mv}: scope`);
      assert(enh.includes('window.CursiaVC') || enh.includes('w.CursiaVC=w.CursiaVC'), `${mv}: namespace`);
      assert(enh.includes('prefers-reduced-motion'), `${mv}: reduced motion`);
      assert(!/<details(?![^>]*\bopen\b)/.test(enh), `${mv}: <details> cerrado en el markup`);
    }
    for (const c of components) {
      assert(vc.extractText(vc.renderComponent(c, theme, { uid: 'e' })) === vc.extractText(vc.renderComponent(c, theme, { uid: 'e', level: 'enhanced' })), `${c.type}: texto distinto`);
    }
  }
});

check('todo el texto del JSON aparece en el HTML, en orden (normal y largo)', () => {
  const norm = (s) => s.replace(/\s+/g, ' ').trim();
  for (const c of components) {
    for (const variant of [c, F.longVariant(c)]) {
      const text = vc.extractText(vc.renderComponent(variant, themes[0].theme, { uid: 't' }));
      // comparación apilada (> 2 columnas): el orden de lectura es por criterio; se exige presencia
      const ordered = !(c.type === 'comparison' && c.columns.length > vc.VC_TABLE_MAX_COLUMNS);
      let from = 0;
      for (const s of F.textsOf(variant)) {
        const i = text.indexOf(norm(s), ordered ? from : 0);
        assert(i >= 0, `${F.fixtureName(c)}: falta u orden roto "${norm(s).slice(0, 50)}"`);
        if (ordered) from = i;
      }
    }
  }
});

check('M9: palabras normales no reciben guiones suaves; solo las muy largas', () => {
  const html = vc.renderComponent({ type: 'callout', variant: 'info', title: 'Internacionalización y responsabilidades', body: 'La implementación, la administración y las responsabilidades interdepartamentales.' }, themes[0].theme, { uid: 'h' });
  assert(!html.includes('&shy;'), `&shy; en palabras normales: ${html}`);
});

check('palabras largas reciben guiones suaves (sin desborde bajo forceclean)', () => {
  const html = vc.renderComponent(F.longVariant(components[0]), themes[0].theme, { uid: 'l' });
  assert(html.includes('&shy;'), 'sin &shy;');
  assert(!new RegExp(`[^\\s;&]{40,}`).test(html.replace(/style="[^"]*"/g, '').replace(/<[^>]+>/g, ' ')), 'quedó una corrida de 40+ caracteres sin punto de corte');
});

check('I6: todo texto va en <span class="nolink"> (clase exacta, sin <span> internos) en ambos niveles', () => {
  for (const { theme } of themes.slice(0, 2)) {
    for (const c of components) {
      for (const level of LEVELS) {
        const root = vc.parseHtml(vc.renderMovement([c, F.longVariant(c)], theme, { uid: 'nl', level }));
        const walk = (node, inNolink) => {
          if (node.kind === 'text') {
            if (node.text.replace(/[­\s]/g, '') && !/^[✓☐:]+$/.test(node.text.trim())) {
              assert(inNolink, `${F.fixtureName(c)}/${level || 'clean'}: texto fuera de nolink: "${node.text.slice(0, 40)}"`);
            }
            return;
          }
          if (['style', 'script'].includes(node.tag)) return;
          const isNolink = node.tag === 'span' && node.attrs.class === 'nolink';
          if (inNolink) assert(node.tag !== 'span' && node.tag !== 'a', `${F.fixtureName(c)}: <${node.tag}> dentro de nolink (el filtro cierra la región en el primer </span>)`);
          node.children.forEach((ch) => walk(ch, inNolink || isNolink));
        };
        walk(root, false);
      }
    }
  }
});

check('I2: comparación de > 2 columnas se apila por criterio en la base (sin <table>); ≤ 2 columnas es <table>', () => {
  const theme = themes[0].theme;
  for (const c of components.filter((x) => x.type === 'comparison')) {
    for (const level of LEVELS) {
      const html = vc.renderComponent(c, theme, { uid: 'cmp', level });
      if (c.columns.length > vc.VC_TABLE_MAX_COLUMNS) {
        assert(!html.includes('<table'), `${F.fixtureName(c)}/${level || 'clean'}: <table> en la base`);
        assert((html.match(/class="cvc-cmp-row"/g) || []).length === c.rows.length, 'un bloque por criterio');
        assert((html.match(/class="cvc-cmp-col"/g) || []).length === c.rows.length * c.columns.length, 'columna:valor por celda');
      } else {
        assert(html.includes('<table') && html.includes('scope="col"') && html.includes('scope="row"'), 'tabla con th scope');
        if (level) assert(/class="cvc-cmp cvc-scroll" role="region" tabindex="0" aria-label/.test(html), 'región desplazable accesible en ENHANCED');
      }
    }
  }
});

check('M1: jerarquía de encabezados (sin h1–h3 en el label), role=list en ENHANCED, summaries con nombre accesible', () => {
  for (const c of components) {
    const clean = vc.renderMovement([c], themes[0].theme, { uid: 'hx' });
    const enh = vc.renderMovement([c], themes[0].theme, { uid: 'hx', level: 'enhanced' });
    assert(!/<h[1-3][\s>]/.test(clean + enh), `${F.fixtureName(c)}: h1–h3 dentro del label`);
    if (/style="list-style:none/.test(enh)) assert(/role="list" style="list-style:none/.test(enh), `${F.fixtureName(c)}: lista sin role=list`);
    for (const m of enh.matchAll(/<summary([^>]*)>/g)) {
      if (/cvc-acc/.test(enh) && !/aria-label/.test(m[1])) continue; // acordeón: el nombre es su encabezado
      assert(/aria-label="[^"]+"/.test(m[1]), `${F.fixtureName(c)}: summary sin aria-label`);
    }
  }
  const tabs = vc.renderMovement([components.find((c) => c.type === 'tabs')], themes[0].theme, { uid: 'tl', level: 'enhanced' });
  assert(/data-cvc-labelledby="cvc-tl-0-tt\d+"/.test(tabs) && /<h4 id="cvc-tl-0-tt\d+"/.test(tabs), 'tablist nombrada por el título');
});

check('M6/M7: tema adulterado y uid fuera de rango → VC_RENDER', () => {
  const bad = [
    (t) => (t.color.bg = '#fff}</style><script>alert(1)</script>'),
    (t) => (t.color.textPrimary = 'red'),
    (t) => (t.typography.fontBody = 'Arial;}</style><script>'),
    (t) => (t.typography.sizeBodyPx = 12),
    (t) => (t.typography.enhanced.sizeBodyFluid = 'expression(alert(1))'),
    (t) => (t.shape.radiusMd = NaN),
    (t) => (t.variants.card = 'x'),
  ];
  for (const fn of bad) {
    const t = F.clone(themes[0].theme);
    fn(t);
    let msg = '';
    try { vc.renderMovement([components[0]], t, { uid: 'bad', level: 'enhanced' }); } catch (err) { msg = err.message; }
    assert(/^VC_RENDER: tema/.test(msg), `debió lanzar VC_RENDER: ${fn} → ${msg}`);
  }
  const u60 = 'a'.repeat(60), u61 = 'a'.repeat(61), u64 = 'a'.repeat(64);
  vc.renderMovement([components[0]], themes[0].theme, { uid: u60 });
  vc.renderComponent(components[0], themes[0].theme, { uid: u64 });
  let msg = '';
  try { vc.renderMovement([components[0]], themes[0].theme, { uid: u61 }); } catch (err) { msg = err.message; }
  assert(/^VC_RENDER: uid/.test(msg), `uid 61 en renderMovement: ${msg}`);
});

check('M2: runtime versionado, localiza su label por currentScript y genera ids faltantes', () => {
  const html = vc.renderMovement([components.find((c) => c.type === 'tabs')], themes[0].theme, { uid: 'rt', level: 'enhanced' });
  assert(vc.VC_RUNTIME_VERSION >= 2, 'versión');
  assert(html.includes(`var V=${vc.VC_RUNTIME_VERSION}`) && html.includes('(N.v|0)<V'), 'version gate');
  assert(html.includes('document.currentScript'), 'currentScript');
  assert(html.includes('N.id=function'), 'ids derivados');
});

if (failures > 0) {
  console.error(`\n${failures} check(s) fallaron.`);
  process.exit(1);
}
console.log(`\nTodos los checks de Visual Components pasaron (${LONG_COUNT.n} renders lintados).`);
