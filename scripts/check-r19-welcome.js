#!/usr/bin/env node
/* eslint-disable */
// r19 W — composición de la bienvenida del curso (label cv3:shell:welcome). Sin DB, sin red, sin proveedores, sin navegador.
//
// Antes (builder 3.12.0) TODO `course_intro.welcome` (141–155 palabras reales) salía como UN <p> a tamaño de entrada
// dentro de un hero sin superficie: un muro de texto bajo el encabezado «Bienvenida» de Moodle, igual en las 6 familias.
// Ahora (3.13.0): superficie del hero según `heroTreatment` (band / rule / plate) → «Curso · N módulos · M capítulos» →
// título → filete → entrada (≤ 40 palabras / 240 caracteres) → resto a tamaño de cuerpo en párrafos de ≤ 70 palabras →
// fila de cifras.
//
// Para cada familia × modo (7) × nivel (CLEAN_SAFE, ENHANCED) × bienvenida (#625, #616, 80 y 220 palabras,
// abreviaturas, primera oración larga) se verifica, sobre el HTML parseado (parser propio del repo; no hay jsdom en
// node_modules):
//   1. orden de los hitos por posición en el documento: título → entrada → cuerpo → cifras;
//   2. entrada ≤ 40 palabras y ≤ 240 caracteres (o, si la primera oración no cabe, NO hay entrada: va a tamaño cuerpo);
//   3. ningún <p> de más de 70 palabras en el label;
//   4. el hero tiene superficie: clase = heroTreatment de la familia; band/plate → fondo ≠ fondo del label;
//      rule → border-top ≥ 4 px; padding ≥ 20 px; todo en style="" (CLEAN_SAFE);
//   5. el texto visible de entrada + cuerpo = la bienvenida original (espacios normalizados): nada perdido ni repetido;
//   6. en CLEAN_SAFE ningún elemento queda sin style="" (salvo <span class="nolink">, <br> y el énfasis dentro de <p>),
//      y no hay <style>;
//   7. determinismo (mismo insumo → mismos bytes).
// Además: divisor de oraciones (sin pérdida, abreviaturas/decimales, igual al de 3.12.0 en prosa normal → la
// presentación del módulo no cambia), control negativo con el hero de 3.12.0, y el validador (≥ 3.13.0) marca
// STRUCTURE si la bienvenida empaquetada pierde la superficie o trae un párrafo largo (no evalúa paquetes 3.12.0).
//
// Usage: node scripts/check-r19-welcome.js [path/to/dist]     (requiere `npm run build`)
//   Con un dist de 3.12.0 este check FALLA (es el control de que detecta el muro de texto).

const path = require('path');
const JSZip = require('jszip');

const distArg = process.argv.slice(2).find((a) => !a.startsWith('--'));
const distRoot = path.resolve(process.cwd(), distArg || 'dist');
function loadDist(rel) {
  try {
    return require(path.join(distRoot, rel));
  } catch (err) {
    console.error(`❌ No se pudo cargar ${rel} desde ${distRoot} (¿corriste "npm run build"?)\n   ${err.message}`);
    process.exit(1);
  }
}
const S = loadDist('modules/course-shell/index.js');
const HTML = loadDist('modules/course-shell/html.js');
const te = loadDist('modules/theme-engine/index.js');
const vc = loadDist('modules/visual-components/index.js');
const cp = loadDist('modules/course-profiles/course-profiles.js');
const F = require('./lib/v21-shell-fixtures');
const VCF = require('./lib/v21-vc-fixtures');
const PF = require('./lib/v21-packaging-fixtures');
const { WELCOMES, NO_LEAD } = require('./lib/r19-welcome-fixtures');

let passes = 0;
let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    passes++;
    console.log(`✅ ${name}`);
  } catch (err) {
    failures++;
    console.error(`❌ ${name}\n   ${err && err.message ? err.message.split('\n').slice(0, 8).join('\n   ') : err}`);
  }
}
function assert(c, m) {
  if (!c) throw new Error(m);
}
function eq(a, b, m) {
  assert(JSON.stringify(a) === JSON.stringify(b), `${m}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
}

const norm = (t) => String(t).replace(/[\u00AD\u200B]/g, '').replace(/\s+/g, ' ').trim();
const words = (t) => norm(t).split(' ').filter(Boolean).length;
const cls = (n) => (n.attrs && n.attrs.class ? n.attrs.class.split(/\s+/) : []);
const styleOf = (n) => (n.attrs && n.attrs.style) || '';
const decl = (n, prop) => {
  const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`).exec(styleOf(n));
  return m ? m[1].trim() : null;
};
function textOf(n) {
  if (n.kind === 'text') return n.text;
  if (n.tag === 'style' || n.tag === 'script') return '';
  return n.children.map(textOf).join(n.tag === 'br' ? ' ' : '');
}
function all(n, out = []) {
  if (n.kind !== 'el') return out;
  out.push(n);
  n.children.forEach((c) => all(c, out));
  return out;
}

/**
 * Las aserciones de composición sobre el HTML de UN label de bienvenida. Devuelve la lista de fallas (vacía = OK),
 * para poder usarla también como control negativo sobre el hero de 3.12.0.
 */
function welcomeIssues(html, { welcome, title, theme, clean, noLead }) {
  const bad = [];
  const root = vc.parseHtml(html);
  const els = all(root).filter((n) => n.tag !== '#root');
  const pos = new Map(els.map((n, i) => [n, i]));
  const labelRoot = els.find((n) => cls(n).includes('cvc-shell-welcome'));
  const band = els.find((n) => cls(n).includes('cvc-welcome-band'));
  const titleEl = els.find((n) => n.tag === 'h4' && norm(textOf(n)) === norm(title));
  const leadEl = els.find((n) => n.tag === 'p' && cls(n).includes('cvc-lead'));
  const bodyWrap = els.find((n) => cls(n).includes('cvc-welcome-body'));
  const bodyPs = bodyWrap ? all(bodyWrap).filter((n) => n.tag === 'p') : [];
  const stats = els.find((n) => n.tag === 'ul' && cls(n).includes('cvc-facts'));
  if (!labelRoot) bad.push('sin raíz cvc-shell-welcome');
  if (!titleEl) bad.push('sin título h4 = título del curso');
  if (!stats) bad.push('sin fila de cifras');
  if (!band) bad.push('sin superficie del hero (cvc-welcome-band)');
  // (1) orden
  if (noLead) {
    if (leadEl) bad.push('primera oración larga renderizada como entrada');
  } else if (!leadEl) bad.push('sin entrada (p.cvc-lead)');
  if (!bodyPs.length) bad.push('sin cuerpo (cvc-welcome-body p)');
  if (titleEl && stats && bodyPs.length) {
    const seq = [titleEl, ...(leadEl ? [leadEl] : []), bodyPs[0], stats].map((n) => pos.get(n));
    if (!seq.every((x, i) => i === 0 || x > seq[i - 1])) bad.push(`orden de hitos roto (título → entrada → cuerpo → cifras): ${seq.join(' ')}`);
    if (band && !(titleEl && all(band).includes(titleEl))) bad.push('el título no está dentro del hero');
    if (band && leadEl && !all(band).includes(leadEl)) bad.push('la entrada no está dentro del hero');
    if (band && bodyPs.some((p) => all(band).includes(p))) bad.push('el cuerpo quedó dentro del hero');
  }
  // (2) entrada
  if (leadEl) {
    const lt = norm(textOf(leadEl));
    if (words(lt) > S.WELCOME_LEAD_MAX_WORDS) bad.push(`entrada de ${words(lt)} palabras (> 40)`);
    if (lt.length > 240) bad.push(`entrada de ${lt.length} caracteres (> 240)`);
  }
  // (3) muro de texto
  for (const p of els.filter((n) => n.tag === 'p')) {
    const n = words(textOf(p));
    if (n > 70) bad.push(`<p> de ${n} palabras (> 70)`);
  }
  // (4) superficie
  if (band && labelRoot) {
    const tr = theme.personality.heroTreatment;
    if (!cls(band).includes(`cvc-hero-${tr}`)) bad.push(`tratamiento ${cls(band).join(' ')} ≠ heroTreatment ${tr}`);
    const bg = decl(band, 'background-color');
    const rootBg = decl(labelRoot, 'background-color');
    if (!bg) bad.push('hero sin background-color inline');
    if (tr === 'rule') {
      const bt = /^(\d+)px solid #[0-9A-Fa-f]{6}$/.exec(decl(band, 'border-top') || '');
      if (!bt || Number(bt[1]) < 4) bad.push(`rule sin border-top ≥ 4 px (${decl(band, 'border-top')})`);
    } else if (bg && rootBg && bg.toLowerCase() === rootBg.toLowerCase()) bad.push(`${tr}: fondo del hero = fondo del label (${bg})`);
    const pad = /^(\d+)px/.exec(decl(band, 'padding') || '');
    if (!pad || Number(pad[1]) < 20) bad.push(`padding del hero < 20 px (${decl(band, 'padding')})`);
  }
  // (5) texto preservado
  const parts = [...(band ? all(band).filter((n) => n.tag === 'p' && !cls(n).includes('cvc-kicker')) : []), ...bodyPs].map(textOf);
  if (norm(parts.join(' ')) !== norm(welcome)) bad.push(`texto entrada+cuerpo ≠ bienvenida original:\n     got  ${norm(parts.join(' ')).slice(0, 160)}…\n     want ${norm(welcome).slice(0, 160)}…`);
  // (6) CLEAN_SAFE: todo con estilo en línea
  if (clean) {
    if (/<style/i.test(html)) bad.push('CLEAN_SAFE con <style>');
    for (const n of els) {
      if (styleOf(n)) continue;
      if (n.tag === 'br') continue;
      if (n.tag === 'span' && cls(n).includes('nolink')) continue;
      if ((n.tag === 'strong' || n.tag === 'em') && n.parent && n.parent.tag !== '#root') {
        let a = n.parent;
        while (a && a.tag !== 'p' && a.tag !== '#root') a = a.parent;
        if (a && a.tag === 'p') continue;
      }
      bad.push(`elemento sin style="" en CLEAN_SAFE: <${n.tag} class="${cls(n).join(' ')}">`);
    }
  }
  return bad;
}

(async () => {
  const C2 = F.course2(distRoot);
  const facts = S.buildCourseFacts({
    manifest: C2.manifest,
    blueprint: C2.snapshot,
    assessment: cp.defaultAssessmentProfile({ finalExam: C2.manifest.features.finalExam }),
    artifacts: F.measuredArtifacts(C2.manifest),
  });
  const CI = F.courseIntroFixture();

  await check('fixtures: las bienvenidas cumplen el esquema (80–220 palabras, ≤ 2000 caracteres)', () => {
    for (const [id, w] of Object.entries(WELCOMES)) {
      S.assertValidCourseIntroV3({ ...CI, welcome: w });
      assert(words(w) >= 80 && words(w) <= 220, `${id}: ${words(w)} palabras`);
    }
    eq([words(WELCOMES.w625), words(WELCOMES.w616)], [141, 155], 'largos reales de #625 / #616');
  });

  // ── Divisor de oraciones / entrada / párrafos (html.ts) ──
  await check('divisor: sin pérdida (concatenación = texto), no corta en «1.5», «Dr.», «N.º», «EE. UU.» ni dentro de **énfasis**', () => {
    assert(typeof HTML.splitSentences === 'function', 'splitSentences ausente (dist anterior a r19)');
    for (const w of [...Object.values(WELCOMES), 'Sin punto final', 'Uno. dos. Tres.', '  Espacios.  Raros.  ', 'A **b. C** d. E.']) {
      eq(HTML.splitSentences(w).join(''), w, 'concatenación');
    }
    const s = HTML.splitSentences(WELCOMES.abbrev).map((x) => x.trim());
    assert(s[0].startsWith('El Dr. Ramírez') && s[0].endsWith('detalles.'), `Dr.: ${s[0]}`);
    assert(s.some((x) => x.startsWith('Una temperatura de 4.5 grados')), '4.5 partido');
    assert(s.some((x) => x.startsWith('La Resolución N.º 3')), 'N.º partido');
    assert(s.some((x) => x.startsWith('En EE. UU. y en Chile')), 'EE. UU. partido');
    eq(HTML.splitSentences('A **b. C** d. E.').map((x) => x.trim()), ['A **b. C** d.', 'E.'], 'énfasis abierto');
  });

  await check('divisor = el de 3.12.0 en prosa normal (la presentación del módulo no cambia de bytes); el viejo perdía texto con «1.5»', () => {
    const oldSplit = (t) => {
      const sentences = t.match(/[^.!?]+[.!?]+(\s+|$)|[^.!?]+$/g) || [t];
      let band = '';
      let k = 0;
      while (k < sentences.length && (band.length === 0 || band.length + sentences[k].length <= 240)) band += sentences[k++];
      return { lead: band.trim(), rest: sentences.slice(k).join('').trim() };
    };
    const MI = F.moduleIntroFixture ? F.moduleIntroFixture : null;
    const texts = [WELCOMES.w625, WELCOMES.w616, WELCOMES.short80, WELCOMES.long220, WELCOMES.longFirst, CI.closing, CI.methodology_note];
    if (MI) {
      try {
        const m = MI(facts.modules[0], facts);
        if (m && m.presentation) texts.push(m.presentation);
      } catch (e) {}
    }
    for (const t of texts) {
      const n = HTML.splitLeadRest(t, { maxChars: 240 });
      eq({ lead: n.lead, rest: n.rest }, oldSplit(t), `entrada/resto de «${t.slice(0, 30)}…»`);
    }
    const lossy = 'El valor 1.5 es alto. Fin del ejemplo.';
    const o = oldSplit(lossy);
    assert(!norm(`${o.lead} ${o.rest}`).includes('El valor 1.'), 'precondición: el regex viejo descartaba «El valor 1.»');
    const n = HTML.splitLeadRest(lossy, { maxChars: 240 });
    eq(norm(`${n.lead} ${n.rest}`), norm(lossy), 'el divisor nuevo conserva todo');
  });

  await check('entrada: #625 = las 4 primeras oraciones (39 palabras), #616 = 2 (25 palabras); cuerpo en párrafos ≤ 70 palabras, sin pérdida', () => {
    const a = HTML.splitLeadRest(WELCOMES.w625, { maxChars: 240, maxWords: 40 });
    eq([words(a.lead), a.fits], [39, true], '#625');
    const b = HTML.splitLeadRest(WELCOMES.w616, { maxChars: 240, maxWords: 40 });
    eq([words(b.lead), b.fits], [25, true], '#616');
    const lf = HTML.splitLeadRest(WELCOMES.longFirst, { maxChars: 240, maxWords: 40 });
    eq(lf.fits, false, 'primera oración larga → no cabe');
    for (const [id, w] of Object.entries(WELCOMES)) {
      const sp = HTML.splitLeadRest(w, { maxChars: 240, maxWords: 40 });
      const ps = HTML.splitBodyParagraphs(sp.rest, { maxWords: 70, target: 60 });
      assert(ps.every((p) => words(p) <= 70), `${id}: párrafo > 70 (${ps.map(words)})`);
      eq(norm([sp.lead, ...ps].join(' ')), norm(w), `${id}: sin pérdida`);
    }
    eq(HTML.splitBodyParagraphs(HTML.splitLeadRest(WELCOMES.w625, { maxChars: 240, maxWords: 40 }).rest, { maxWords: 70, target: 60 }).map(words), [46, 56], '#625 cuerpo');
    eq(HTML.splitBodyParagraphs('Uno dos tres.\n\nCuatro cinco.', { maxWords: 70, target: 60 }), ['Uno dos tres.', 'Cuatro cinco.'], 'línea en blanco = corte');
    const huge = Array.from({ length: 90 }, (_, i) => (i === 44 ? 'palabra,' : 'palabra')).join(' ') + '.';
    const hp = HTML.splitBodyParagraphs(huge, { maxWords: 70, target: 60 });
    assert(hp.length === 2 && hp.every((p) => words(p) <= 70) && norm(hp.join(' ')) === norm(huge), `oración de 90 palabras: ${hp.map(words)}`);
  });

  // ── Matriz de render ──
  for (const combo of VCF.THEME_COMBOS) {
    const theme = te.resolveTheme(combo);
    for (const level of [undefined, 'enhanced']) {
      const tag = `${combo.themeFamily}-${combo.mode}/${level || 'clean'}`;
      await check(`[${tag}] ${Object.keys(WELCOMES).length} bienvenidas: título → entrada → cuerpo → cifras; entrada ≤ 40 palabras; ningún <p> > 70; hero «${theme.personality.heroTreatment}» con superficie; texto íntegro; ${level ? 'ENHANCED' : 'todo en style=""'}; determinista`, () => {
        const errs = [];
        for (const [id, welcome] of Object.entries(WELCOMES)) {
          const ci = { ...CI, welcome };
          const o = level ? { level } : undefined;
          const lbl = S.welcomeLabel(facts, ci, theme, o);
          const again = S.welcomeLabel(facts, ci, theme, o);
          if (lbl.html !== again.html) errs.push(`${id}: no determinista`);
          const issues = welcomeIssues(lbl.html, { welcome, title: facts.course.title, theme, clean: !level, noLead: NO_LEAD.has(id) });
          issues.forEach((i) => errs.push(`${id}: ${i}`));
        }
        assert(errs.length === 0, errs.slice(0, 8).join('\n'));
      });
    }
  }

  await check('eyebrow del hero = «Curso · 2 módulos · 4 capítulos» (cifras de facts, nunca «Bienvenida»); aviso QA y horas intactos', () => {
    const theme = te.resolveTheme({ themeFamily: 'aula-clara', mode: 'light' });
    const lbl = S.welcomeLabel(facts, CI, theme);
    const kick = /<p class="cvc-meta cvc-kicker"[^>]*>([\s\S]*?)<\/p>/.exec(lbl.html);
    assert(kick, 'sin línea meta');
    eq(norm(kick[1].replace(/<[^>]+>/g, '')), `Curso · ${facts.counts.modules} módulos · ${facts.counts.chapters} capítulos`, 'eyebrow');
    const qa = S.welcomeLabel(facts, CI, theme, undefined, true);
    assert(qa.html.indexOf('cvc-qa-preview') < qa.html.indexOf('cvc-welcome-band'), 'el aviso QA va antes del hero');
  });

  await check('control negativo: el hero de 3.12.0 (renderComponent hero, un <p> a tamaño de entrada) falla las aserciones', () => {
    const theme = te.resolveTheme({ themeFamily: 'tecnico', mode: 'light' });
    const hx = HTML.hx(theme);
    const old = vc.renderComponent({ type: 'hero', title: facts.course.title, lead: WELCOMES.w625 }, theme, { uid: 'shell-welcome-hero', countless: true });
    const html = HTML.root(hx, 'shell-welcome', old + HTML.statRow(hx, [{ value: 2, label: 'módulos' }]));
    const issues = welcomeIssues(html, { welcome: WELCOMES.w625, title: facts.course.title, theme, clean: true, noLead: false });
    for (const re of [/superficie del hero/, /<p> de 141 palabras/, /sin entrada/, /sin cuerpo/]) assert(issues.some((i) => re.test(i)), `faltó ${re}: ${JSON.stringify(issues)}`);
  });

  // ── Paquete + validador ──
  let mbz = null;
  let exp = null;
  await check('paquete 3.13.0 con la bienvenida de #616: el label empaquetado conserva la composición y el validador pasa', async () => {
    const input = PF.packagingInput(distRoot, { engine: 'h5p', finalExam: true, theme: { themeFamily: 'editorial', mode: 'light' } });
    input.contents.courseIntro = { ...input.contents.courseIntro, welcome: WELCOMES.w616 };
    const r = await loadDist('package/dynamic-mbz-builder-v3.js').buildDynamicMbzV3(input);
    eq(r.summary.builderVersion, '3.13.0', 'versión');
    mbz = r.mbz;
    exp = r.expectations;
    const z = await JSZip.loadAsync(mbz);
    let intro = null;
    for (const f of Object.keys(z.files).filter((f) => /^activities\/label_\d+\/module\.xml$/.test(f))) {
      if ((await z.file(f).async('string')).includes('<idnumber>cv3:shell:welcome</idnumber>')) {
        const x = await z.file(f.replace('module.xml', 'label.xml')).async('string');
        intro = /<intro>([\s\S]*?)<\/intro>/.exec(x)[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
      }
    }
    assert(intro, 'sin label de bienvenida');
    const theme = te.resolveTheme({ themeFamily: 'editorial', mode: 'light' });
    const issues = welcomeIssues(intro, { welcome: WELCOMES.w616, title: exp.facts.course.title, theme, clean: false, noLead: false });
    assert(issues.length === 0, issues.join('\n'));
    const V = loadDist('package/v3/mbz-validator-v3.js');
    const v = await V.validateMbzV3(mbz, exp);
    assert(v.ok, JSON.stringify(v.issues.slice(0, 5)));
  });

  await check('validador ≥ 3.13.0: bienvenida sin superficie o con un párrafo > 70 palabras → STRUCTURE; con builderVersion 3.12.0 no se evalúa', async () => {
    assert(mbz, 'sin paquete');
    const V = loadDist('package/v3/mbz-validator-v3.js');
    const z = await JSZip.loadAsync(mbz);
    let file = null;
    for (const f of Object.keys(z.files).filter((f) => /^activities\/label_\d+\/module\.xml$/.test(f))) {
      if ((await z.file(f).async('string')).includes('<idnumber>cv3:shell:welcome</idnumber>')) file = f.replace('module.xml', 'label.xml');
    }
    const x = await z.file(file).async('string');
    const wall = x.replace(/class=&quot;cvc-welcome-band /, 'class=&quot;cvc-x-band ').replace(/(&lt;p class=&quot;cvc-lead&quot;.*?&gt;)/, `$1${'palabra '.repeat(80)}`);
    assert(wall !== x && !wall.includes('cvc-welcome-band') && wall.includes('palabra palabra'), 'la mutación no cambió lo esperado');
    z.file(file, wall);
    const bad = await z.generateAsync({ type: 'nodebuffer' });
    const v = await V.validateMbzV3(bad, exp);
    const st = v.issues.filter((i) => i.code === 'STRUCTURE' && i.where === 'cv3:shell:welcome').map((i) => i.message);
    assert(st.some((m) => /superficie del hero/.test(m)), JSON.stringify(st));
    assert(st.some((m) => /entrada de la bienvenida supera 40/.test(m)), JSON.stringify(st));
    assert(st.some((m) => /párrafo de \d+ palabras/.test(m)), JSON.stringify(st));
    const old = await V.validateMbzV3(bad, { ...exp, builderVersion: '3.12.0' });
    assert(!old.issues.some((i) => i.where === 'cv3:shell:welcome' && i.code === 'STRUCTURE'), 'un paquete 3.12.0 no se evalúa con la regla de 3.13.0');
  });

  console.log(`\n${failures ? 'HAY FALLOS' : 'OK'} (${passes} ✅, ${failures} ❌).`);
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
