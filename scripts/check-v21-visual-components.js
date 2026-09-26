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

check('lint RESOURCE_MENTION: acentos/mayúsculas, límites de palabra, en cualquier campo', () => {
  const pos = ['En el Vídeo verás', 'las ACTIVIDADES', 'Evaluación final', 'el SCORM', 'un h5p', 'la presentación', 'las presentaciones', 'una diapositiva', 'los exámenes', 'el examen', 'el quiz', 'un juego', 'videos cortos', 'la actividad'];
  for (const t of pos) assert(vc.lintResourceMentions(t).length === 1, `debió marcar: ${t}`);
  const neg = ['videojuegos', 'reactividad', 'evaluar el caso', 'examinar', 'presentar la idea', 'juego de roles'.replace('juego', 'juegan')];
  for (const t of neg) assert(vc.lintResourceMentions(t).length === 0, `no debió marcar: ${t} → ${JSON.stringify(vc.lintResourceMentions(t))}`);
  expectCode(mutate((d) => (d.movements.deepening[3].rows[0].cells[1] = 'Como en la Presentación')), 'RESOURCE_MENTION', 'rows[0].cells[1]');
  expectCode(mutate((d) => (d.movements.video_primer[0].steps[0].body = 'Observa el VIDEO con atención')), 'RESOURCE_MENTION', 'steps[0].body');
});

check('lint QUANTITY_CLAIM: dígitos pegados a módulos/capítulos/…/%', () => {
  const pos = ['3 módulos', 'los 12 capítulos', 'capítulo 2', 'Módulo n° 4', '15 minutos', '2 horas', '10 páginas', '3 intentos', '5 preguntas', '30%', '45 %', '2,5 horas', '4 videos', '2 actividades'];
  for (const t of pos) assert(vc.lintQuantityClaims(t).length >= 1, `debió marcar: ${t}`);
  const neg = ['el año 1990', 'módulos del curso', 'en 3 pasos', 'Década de 1970', 'tres módulos', 'hora de actuar'];
  for (const t of neg) assert(vc.lintQuantityClaims(t).length === 0, `no debió marcar: ${t} → ${JSON.stringify(vc.lintQuantityClaims(t))}`);
  expectCode(mutate((d) => (d.movements.synthesis[0].points[0] = 'El 80% de las quejas se resuelve escuchando')), 'QUANTITY_CLAIM', 'points[0]');
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
      assert(!/onerror=alert/.test(html.replace(/onerror=alert\(2\)&gt;/g, '')) || !/<[^>]*onerror/i.test(html), `${c.type}: onerror en un tag`);
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
  const bg = (inner, extra = '') => `<div style="background-color:#FFFFFF;color:#111111${extra}">${inner}</div>`;
  const cases = [
    ['BASE_HIDDEN', bg('<p style="display:none;color:#111111">x</p>')],
    ['BASE_HIDDEN', bg('<p style="visibility:hidden">x</p>')],
    ['BASE_HIDDEN', bg('<details><summary>q</summary>a</details>')],
    ['BASE_HIDDEN', bg('<p hidden>x</p>')],
    ['NO_COLOR', '<p>texto suelto</p>'],
    ['NO_BACKGROUND', '<p style="color:#111111">x</p>'],
    ['COLOR_WITHOUT_BACKGROUND', '<p style="color:#111111">x</p>'],
    ['BG_NOT_PAIRED', bg('<div style="background-color:#000000"><p>x</p></div>')],
    ['NON_HEX_COLOR', bg('<p style="color:red">x</p>')],
    ['FORBIDDEN_VALUE', bg('<p style="color:oklch(0.5 0.1 200)">x</p>')],
    ['FORBIDDEN_VALUE', bg('<p style="color:var(--x)">x</p>')],
    ['FORBIDDEN_VALUE', bg('x', ';background-color:rgba(0,0,0,1)')],
    ['GRADIENT_WITHOUT_FALLBACK', '<div style="background:linear-gradient(#FFFFFF,#EEEEEE);color:#111111">x</div>'],
    ['DUPLICATE_SAFE_PROPERTY', bg('<p style="margin:0;margin:4px">x</p>')],
    ['FONT_TOO_SMALL', bg('<p style="font-size:14px">x</p>')],
    ['FONT_TOO_SMALL', bg('<span class="cvc-meta" style="font-size:12px">x</span>')],
    ['LOW_CONTRAST', '<div style="background-color:#FFFFFF;color:#AAAAAA">x</div>'],
  ];
  for (const [code, html] of cases) {
    const r = vc.lintCleanSafe(html);
    assert(!r.ok && r.errors.some((e) => e.code === code), `${code} no detectado en ${html}: ${JSON.stringify(r.errors)}`);
  }
  const good = [
    '<div style="background:linear-gradient(#FFFFFF,#EEEEEE);background-color:#FFFFFF;color:#111111">x</div>',
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
      let from = 0;
      for (const s of F.textsOf(variant)) {
        const i = text.indexOf(norm(s), from);
        assert(i >= 0, `${c.type}: falta u orden roto "${norm(s).slice(0, 50)}"`);
        from = i;
      }
    }
  }
});

check('palabras largas reciben guiones suaves (sin desborde bajo forceclean)', () => {
  const html = vc.renderComponent(F.longVariant(components[0]), themes[0].theme, { uid: 'l' });
  assert(html.includes('&shy;'), 'sin &shy;');
  assert(!new RegExp(`[^\\s;&]{40,}`).test(html.replace(/style="[^"]*"/g, '').replace(/<[^>]+>/g, ' ')), 'quedó una corrida de 40+ caracteres sin punto de corte');
});

if (failures > 0) {
  console.error(`\n${failures} check(s) fallaron.`);
  process.exit(1);
}
console.log(`\nTodos los checks de Visual Components pasaron (${LONG_COUNT.n} renders lintados).`);
