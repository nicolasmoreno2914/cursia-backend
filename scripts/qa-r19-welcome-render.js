#!/usr/bin/env node
/* eslint-disable */
// r19 W — render real (Chrome headless, CDP de scripts/lib/v21-cdp.js; sin Moodle, sin red, sin puerto fijo) del label de
// bienvenida de cada familia × modo (7), en ENHANCED y CLEAN_SAFE, con las bienvenidas de largo real
// (scripts/lib/r19-welcome-fixtures.js). El label va en una columna tipo Moodle (≤ 780 px + 16 px de margen) bajo un h3
// «Bienvenida», como lo pinta format_topics. Se mide a 1280 px y a 375 px (emulación móvil):
//   - sin desborde horizontal (scrollWidth ≤ clientWidth) en ambos anchos; texto ≥ 16 px salvo chips de metadato en
//     MAYÚSCULAS de ≤ 30 caracteres y una línea (la regla del QA del navegador, browser-qa-v3);
//   - a 1280: la entrada ocupa ≤ 4 líneas; ningún bloque de texto (p, h4, li) supera 260 px de alto;
//     la fila de cifras (ul.cvc-facts) empieza dentro de los primeros 900 px del label (bienvenidas ≤ 160 palabras;
//     con 220, el tope del esquema, solo se informa);
//   - a 375: ningún bloque de texto supera 450 px y el título ≤ 40 px. Los topes de ALTO de bloque (260 / 450) no se
//     aplican a las formas sintéticas SYNTHETIC_FILLER de los fixtures (tokens de 250–300 caracteres + relleno de palabras
//     largas); para ellas vale todo lo demás, en particular «sin desborde horizontal».
// Para todo largo: la fila de cifras va inmediatamente después del cuerpo (orden intro → información del curso).
// Con `--shots DIR` guarda capturas (bienvenida de #625) por familia a 1280 y 375: DIR/<tag>_<familia>-<modo>[_clean]_<ancho>.png
// (ENHANCED y CLEAN_SAFE).
// Si Chrome no está disponible el script NO pasa: imprime «SKIP» y sale con código 3.
//
// Usage: node scripts/qa-r19-welcome-render.js [path/to/dist] [--shots DIR] [--tag after] [--fixtures w625,w616]
//   (requiere `npm run build`; CHROME_BIN para otro binario de Chrome)

const fs = require('fs');
const os = require('os');
const path = require('path');

const args = process.argv.slice(2);
const opt = (k) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : undefined;
};
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
const distRoot = path.resolve(process.cwd(), positional[0] || 'dist');
const SHOTS = opt('--shots');
const TAG = opt('--tag') || 'after';
const S = require(path.join(distRoot, 'modules/course-shell/index.js'));
const te = require(path.join(distRoot, 'modules/theme-engine/index.js'));
const cp = require(path.join(distRoot, 'modules/course-profiles/course-profiles.js'));
const F = require('./lib/v21-shell-fixtures');
const VCF = require('./lib/v21-vc-fixtures');
const { WELCOMES: W0, C1_WELCOMES, SYNTHETIC_FILLER } = require('./lib/r19-welcome-fixtures');
const WELCOMES = { ...W0, ...C1_WELCOMES }; // fix round 1: + las formas límite de C1
const { launchChrome, sleep } = require('./lib/v21-cdp');

const CHROME = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const FIXTURES = (opt('--fixtures') || Object.keys(WELCOMES).join(',')).split(',');

const MEASURE = `(() => {
  const L = document.getElementById('lab');
  const top0 = L.getBoundingClientRect().top + scrollY;
  const blocks = [];
  L.querySelectorAll('p,h4,li').forEach((e) => {
    if (e.closest('li') && e.tagName !== 'LI') return;
    const b = e.getBoundingClientRect();
    const cs = getComputedStyle(e);
    const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2;
    blocks.push({ tag: e.tagName, cls: e.className || '', h: Math.round(b.height), lines: Math.round(b.height / lh), fs: parseFloat(cs.fontSize), text: e.innerText.trim().slice(0, 40) });
  });
  // Misma regla que el QA del navegador (browser-qa-v3): texto ≥ 16 px salvo chips .cvc-meta en MAYÚSCULAS de ≤ 30 caracteres y 1 línea (≥ 13 px).
  const small = [];
  const tw = document.createTreeWalker(L, NodeFilter.SHOW_TEXT);
  for (let n = tw.nextNode(); n; n = tw.nextNode()) {
    const t = n.nodeValue.replace(/[\\u00AD\\u200B]/g, '').trim();
    if (!t || !n.parentElement || n.parentElement.closest('style,script')) continue;
    const el = n.parentElement;
    const fs = parseFloat(getComputedStyle(el).fontSize);
    const meta = el.closest('.cvc-meta');
    const chip = meta && meta.innerText.trim().length <= 30 && !/\\n/.test(meta.innerText.trim()) && meta.getBoundingClientRect().height < fs * 2.2 && getComputedStyle(meta).textTransform === 'uppercase';
    if (chip ? fs < 13 : fs < 16) small.push(fs + 'px «' + t.slice(0, 30) + '»');
  }
  const lead = L.querySelector('p.cvc-lead');
  const stats = L.querySelector('ul.cvc-facts');
  const body = L.querySelector('.cvc-welcome-body');
  const bodyPs = body ? body.querySelectorAll('p') : [];
  const lastBody = bodyPs.length ? bodyPs[bodyPs.length - 1].getBoundingClientRect() : null;
  const title = L.querySelector('h4');
  const lb = lead && lead.getBoundingClientRect();
  const llh = lead && (parseFloat(getComputedStyle(lead).lineHeight) || 30);
  return {
    sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth,
    leadLines: lead ? Math.round(lb.height / llh) : null,
    statsTop: stats ? Math.round(stats.getBoundingClientRect().top + scrollY - top0) : null,
    // I3 (fix round 1): las cifras van INMEDIATAMENTE después del cuerpo (siguiente hermano y debajo de su último párrafo).
    statsAfterBody: !!(stats && body && body.nextElementSibling === stats && lastBody && stats.getBoundingClientRect().top >= lastBody.bottom - 1),
    titlePx: title ? parseFloat(getComputedStyle(title).fontSize) : null,
    labH: Math.round(L.getBoundingClientRect().height),
    docH: document.documentElement.scrollHeight,
    blocks,
    small,
  };
})()`;

function page(body) {
  return (
    `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>` +
    `<body style="margin:0;background:#ffffff;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;color:#1d2125">` +
    `<div style="max-width:780px;margin:0 auto;padding:16px"><h3 style="font-size:1.640625rem;font-weight:700;margin:0 0 16px">Bienvenida</h3>` +
    `<div id="lab">${body}</div></div></body></html>`
  );
}

(async () => {
  if (!fs.existsSync(CHROME)) {
    console.error(`⚠️  SKIP: Chrome no está disponible (${CHROME}); el render de la bienvenida NO se verificó.`);
    process.exit(3);
  }
  let chrome;
  try {
    chrome = await launchChrome();
  } catch (e) {
    console.error(`⚠️  SKIP: no se pudo lanzar Chrome headless (${e.message}); el render de la bienvenida NO se verificó.`);
    process.exit(3);
  }
  const C2 = F.course2(distRoot);
  const facts = S.buildCourseFacts({
    manifest: C2.manifest,
    blueprint: C2.snapshot,
    assessment: cp.defaultAssessmentProfile({ finalExam: C2.manifest.features.finalExam }),
    artifacts: F.measuredArtifacts(C2.manifest),
  });
  const CI = F.courseIntroFixture();
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-r19-welcome-'));
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  const fails = [];
  const rows = [];
  let renders = 0;
  try {
    for (const combo of VCF.THEME_COMBOS) {
      const theme = te.resolveTheme(combo);
      const key = `${combo.themeFamily}-${combo.mode}`;
      for (const level of ['enhanced', undefined]) {
        for (const fx of FIXTURES) {
          const html = S.welcomeLabel(facts, { ...CI, welcome: WELCOMES[fx] }, theme, level ? { level } : undefined).html;
          const file = path.join(TMP, `${key}-${level || 'clean'}-${fx}.html`);
          fs.writeFileSync(file, page(html));
          for (const [w, mobile] of [[1280, false], [375, true]]) {
            await chrome.setViewport(w, 900, mobile);
            await chrome.navigate('file://' + file);
            await sleep(120);
            const m = await chrome.evaluate(MEASURE);
            renders++;
            const where = `${key}/${level || 'clean'}/${fx}@${w}`;
            const big = m.blocks.reduce((a, b) => (b.h > a.h ? b : a), { h: 0 });
            rows.push(`${where.padEnd(44)} lead ${String(m.leadLines ?? '-').padStart(2)} lín · bloque máx ${String(big.h).padStart(3)} px (${big.tag}) · cifras a ${String(m.statsTop).padStart(4)} px · título ${m.titlePx}px · label ${m.labH} px · sw ${m.sw}/${m.cw}`);
            if (m.sw > m.cw) fails.push(`${where}: desborde horizontal (scrollWidth ${m.sw} > ${m.cw})`);
            if (!m.statsAfterBody) fails.push(`${where}: la fila de cifras no va inmediatamente después del cuerpo`);
            if (m.small.length) fails.push(`${where}: texto < 16 px fuera de un chip de metadato: ${m.small.slice(0, 3).join(', ')}`);
            if (w === 1280) {
              if (m.leadLines !== null && m.leadLines > 4) fails.push(`${where}: la entrada ocupa ${m.leadLines} líneas (> 4)`);
              if (big.h > 260 && !SYNTHETIC_FILLER.has(fx)) fails.push(`${where}: bloque de texto de ${big.h} px (> 260): ${big.tag} «${big.text}…»`);
              // Cifras sobre el pliegue: para bienvenidas de largo real (≤ 160 palabras; #625 = 141, #616 = 155). En el tope del
              // esquema (220) el cuerpo solo ya ocupa ~14 líneas y el orden pedido por el usuario (intro → información del curso)
              // las deja a ~920–1070 px: aceptado por el controlador (r19 fix round 1, I3); para todo largo se exige el ORDEN.
              const wc = WELCOMES[fx].trim().split(/\s+/).length;
              if (m.statsTop === null || (wc <= 160 && m.statsTop > 900)) fails.push(`${where}: la fila de cifras empieza a ${m.statsTop} px (> 900)`);
            } else {
              if (big.h > 450 && !SYNTHETIC_FILLER.has(fx)) fails.push(`${where}: bloque de texto de ${big.h} px a 375 (> 450): ${big.tag} «${big.text}…»`);
              if (m.titlePx === null || m.titlePx > 40) fails.push(`${where}: título de ${m.titlePx}px a 375 (> 40)`);
            }
            if (SHOTS && fx === FIXTURES[0]) {
              await chrome.setViewport(w, Math.max(600, Math.min(m.docH, 4000)), mobile);
              await sleep(80);
              await chrome.screenshot(path.join(SHOTS, `${TAG}_${key}${level ? '' : '_clean'}_${w}.png`));
            }
          }
        }
      }
    }
  } finally {
    chrome.close();
  }
  rows.forEach((r) => console.log('   ' + r));
  if (fails.length) {
    console.error(`\n❌ ${fails.length} falla(s) en ${renders} renders:\n   ${fails.slice(0, 40).join('\n   ')}`);
    process.exit(1);
  }
  console.log(`\n✅ render de la bienvenida OK: ${renders} renders (7 familia×modo × 2 niveles × ${FIXTURES.length} bienvenidas × 2 anchos; cifras justo después del cuerpo en todos)${SHOTS ? `; capturas en ${SHOTS}` : ''}.`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
