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

// ─── Validador ──────────────────────────────────────────────────────────────

check('schema: VC_SCHEMA_VERSION === 1 y 16 tipos de componente', () => {
  assert(vc.VC_SCHEMA_VERSION === 1, 'VC_SCHEMA_VERSION');
  assert(vc.VC_COMPONENT_TYPES.length === 16, `tipos: ${vc.VC_COMPONENT_TYPES.length}`);
  const inFixture = new Set(components.map((c) => c.type));
  for (const t of vc.VC_COMPONENT_TYPES) assert(inFixture.has(t), `fixture sin ${t}`);
});

check('validador acepta el fixture completo (capítulo) y cada componente suelto', () => {
  const r = vc.validateExperience(F.buildExperience());
  assert(r.ok && r.errors.length === 0, JSON.stringify(r.errors));
  for (const c of components) {
    const e = vc.validateComponent(c);
    assert(e.length === 0, `${c.type}: ${JSON.stringify(e)}`);
  }
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

check('validador: límites por movimiento, self_check exclusivo, diversidad y repetición de tipos', () => {
  expectCode(mutate((d) => d.movements.deepening.push(d.movements.opening[1])), 'MOVEMENT_RANGE', 'deepening');
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
    'Sigue con el siguiente recurso', 'En este Vídeo',
  ];
  for (const t of deny) assert(vc.lintResourceMentions(t).length >= 1, `debió marcar: "${t}"`);
  const allow = [
    'El juego de roles ayuda a practicar la escucha', 'juego limpio entre colegas', 'La evaluación de riesgos es obligatoria',
    'evaluación del desempeño', 'La presentación de resultados al cliente', 'la presentación del producto',
    'la actividad económica del sector', 'las actividades del puesto', 'Un examen físico previo', 'el examen médico anual',
    'producción de video para redes', 'videojuegos y aprendizaje', 'reactividad', 'evaluar el caso', 'presentar la idea',
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
  assert((html.match(/<p /g) || []).length === 2, 'dos párrafos');
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
        assert((html.match(/class="cvc-card cvc-cmp-row"/g) || []).length === c.rows.length, 'un bloque por criterio');
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
