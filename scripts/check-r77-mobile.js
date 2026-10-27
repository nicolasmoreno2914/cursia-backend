#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * r77 — «Mobile-first»: los materiales que arma Cursia se leen y se usan en un teléfono. Sin IA, sin red, USD 0.
 *
 * Cursos sintéticos (`lib/r77-mobile-fixtures.js`): 7 estilos + 1 con marca propia (color, serif, logo, nombre largo),
 * con todos los materiales (bienvenida, ruta, lecciones con tabla de 4 columnas, palabras y direcciones largas, portadas,
 * tarjetas de actividad, Aplicación, práctica guiada, Guía del docente, evaluaciones, audiolibro en línea r74, cierre y
 * certificado) + el curso de muestra de r76 (actividad SCORM). Medición en el navegador: `lib/r77-mobile-measure.js`.
 *
 *   M1 fixtures: los 8 cursos y el de muestra arman y pasan el validador v3
 *   M2 render SIN Moodle (gate-core, Chrome headless con emulación móvil): cada label / página / tarjeta de Cursia a
 *      320, 375, 390, 768 y 1280 px, en los DOS regímenes de Moodle —«guardado» (el HTML tal cual, como lo muestra la
 *      página del curso con «Limpiar contenido» apagado, default) y «limpio» (forceclean / app: sin <style> y solo las
 *      propiedades CSS que deja HTMLPurifier)— sin desborde horizontal (elementos ni texto), texto ≥ 12 px y texto corrido
 *      ≥ 16 px, contraste AA, áreas táctiles ≥ 44 × 44 px sin solapes
 *   M3 invariantes en línea (sin navegador): ningún ancho fijo en px > 320 sin `max-width:100%`, toda <img> con
 *      `height:auto` y atributos width/height, todo enlace-botón de Cursia con área ≥ 44 px declarada
 *   M4 (--base=<dist de origin/staging>) bytes: lo que r77 no toca queda idéntico (Libro Guía PDF, insignia, H5P, GIFT) y
 *      cada label que cambia lo hace solo en estilos (mismo texto visible)
 *   M5 (--moodle) restauración REAL en Moodle 4.5 local de los 8 cursos + 2 SCORM; Playwright (Chromium con UA/DPR/touch
 *      de Android y WebKit con los descriptores de iPhone/iPad) en 320/375/390/768/1280, con «Limpiar contenido» apagado
 *      y encendido: secciones del curso, páginas, H5P, exámenes (vista e intento), SCORM, Libro Guía (recurso PDF),
 *      insignias y navegación (índice del curso, actividad anterior/siguiente). Capturas y JSON por estilo y material.
 *
 * Uso: npm run build && node scripts/check-r77-mobile.js [--base=<dist>] [--moodle [--dist=<dist a medir>] [--out=<dir>]
 *        [--styles=a,b] [--no-fail] [--keep]]
 */
'use strict';
require('reflect-metadata');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawnSync, spawn } = require('child_process');
const realFetch = global.fetch;
global.fetch = async (u, o) => { if (/^http:\/\/127\.0\.0\.1[:/]/.test(String(u))) return realFetch(u, o); throw new Error(`NETWORK FORBIDDEN in check: ${u}`); };

const ROOT = path.resolve(__dirname, '..');
const arg = (k) => (process.argv.find((a) => a.startsWith(`--${k}=`)) || '').slice(k.length + 3);
const dist = path.resolve(arg('dist') || path.join(ROOT, 'dist'));
const L = (r) => require(path.join(dist, r));
const BASE = arg('base');
const MOODLE = process.argv.includes('--moodle');
const NO_FAIL = process.argv.includes('--no-fail');
const OUT = arg('out') || path.join(os.tmpdir(), 'r77-mobile-out');
const ONLY = arg('styles') ? arg('styles').split(',') : null;
const B = L('package/dynamic-mbz-builder-v3.js');
const VAL = L('package/v3/mbz-validator-v3.js');
const MEDIA = L('package/v3/synthetic-media.js');
const PX = L('modules/visual-design/preview-extract.js');
const PF = L('modules/visual-design/preview-fixture.js');
const P = L('modules/course-profiles/course-profiles.js');
const PK = L('modules/dynamic-packaging/packaging-v3.js');
const F = require('./lib/r77-mobile-fixtures');
const M = require('./lib/r77-mobile-measure');

let passes = 0;
let failures = 0;
const evidence = { generatedAt: new Date().toISOString(), dist, render: {}, moodle: {} };
const assert = (c, m) => { if (!c) throw new Error(m); };
async function check(name, fn) {
  const t = Date.now();
  try { await fn(); passes++; console.log(`✅ ${name} (${((Date.now() - t) / 1000).toFixed(1)} s)`); } catch (e) { failures++; console.log(`❌ ${name}\n   ${String(e.stack || e).slice(0, 6000)}`); }
}
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const WIDTHS = [320, 375, 390, 768, 1280];
const STYLES = [...F.STYLES, F.customStyle(MEDIA)].filter((s) => !ONLY || ONLY.includes(s.key));

/** Material (fila de la matriz) a partir del idnumber del empaque. */
function materialOf(idnumber, modname) {
  const id = idnumber || '';
  if (id === 'cv3:shell:welcome') return 'bienvenida';
  if (id === 'cv3:shell:audio_welcome') return 'audio-bienvenida';
  if (/^cv3:shell:(competencies|methodology|start)$/.test(id)) return 'inicio';
  if (/^cv3:shell:(route|route_start)$/.test(id)) return 'ruta';
  if (id === 'cv3:shell:libro') return 'libro-tarjeta';
  if (id === 'cv3:shell:audiobook') return 'audiolibro';
  if (id === 'cv3:shell:teacher_guide') return 'guia-docente';
  if (id === 'cv3:shell:closing') return 'cierre';
  if (id === 'cv3:shell:certificate_teacher' || id === 'cv3:shell:exams_teacher') return 'nota-docente';
  if (/^cv3:module_intro:/.test(id)) return 'presentacion-modulo';
  if (/^cv3:(exam_info:|final_exam_info$)/.test(id)) return 'intro-evaluacion';
  if (/^cv3:(exam_explanations:|final_exam_explanations$)/.test(id)) return 'respuestas-explicadas';
  if (/^cv3:(module_next:|final_exam_next$)/.test(id)) return 'siguiente-paso';
  if (/^cv3:(exam:|final_exam$)/.test(id)) return 'evaluacion';
  const m = /^cv3:ch:[^:]+:(.+)$/.exec(id);
  if (m) {
    const r = m[1];
    if (/^(opening|deepening|synthesis|self_check|closing|video_primer)$/.test(r)) return 'leccion';
    if (r === 'presentation') return 'portada-presentacion';
    if (r === 'activity_instruction') return 'tarjeta-actividad';
    if (r === 'application_instruction') return 'tarjeta-aplicacion';
    if (r === 'application') return 'actividad-aplicacion';
    if (r === 'application_solution') return 'solucionario';
    if (r === 'guided_practice') return 'practica-guiada';
    if (r === 'video' || r === 'activity' || r === 'review_cards') return modname === 'scorm' ? 'scorm' : 'h5p';
    return `capitulo:${r}`;
  }
  return modname || 'otro';
}

const validate = (b) => VAL.validateMbzV3(b.mbz, {
  facts: b.expectations.facts, resolved: b.expectations.resolved, examBankPlans: b.expectations.examBankPlans, shellProseByLabel: b.expectations.shellProseByLabel,
  builderVersion: b.expectations.builderVersion, moodleMinimum: b.expectations.moodleMinimum, internalVocabularyExempt: b.expectations.internalVocabularyExempt,
  internalVocabularyUserTexts: b.expectations.internalVocabularyUserTexts, ...(b.expectations.audiobookLinks ? { audiobookLinks: b.expectations.audiobookLinks } : {}),
});

/** Curso de muestra de r76 (SCORM) con el perfil dado. */
function scormInput(profile) {
  const norm = P.normalizePresentationProfile(profile);
  const brand = PK.applyPresentationIdentity({ logo: null, candidates: [], name: null, warnings: [] }, P.presentationIdentityOf(norm));
  return PF.previewPackagingInput(PK.resolvePackagingTheme({ presentationProfile: norm }).input, {
    logo: brand.candidates, name: brand.name, ...(brand.watermark === false ? { watermark: false } : {}), ...(brand.showInCourse ? { showInCourse: true } : {}),
  });
}

const built = {};
(async () => {
  fs.mkdirSync(OUT, { recursive: true });

  // ── M1 ──────────────────────────────────────────────────────────────────
  await check(`M1 fixtures: ${STYLES.length} cursos completos + curso de muestra SCORM por estilo, validador v3`, async () => {
    for (const s of STYLES) {
      const b = await B.buildDynamicMbzV3(F.mobileCourseInput(dist, s.profile));
      const v = await validate(b);
      assert(v.ok, `${s.key}: validador v3: ${JSON.stringify((v.issues || []).slice(0, 3))}`);
      const sc = await B.buildDynamicMbzV3(scormInput(s.profile));
      const vs = await validate(sc);
      assert(vs.ok, `${s.key} (SCORM): validador v3: ${JSON.stringify((vs.issues || []).slice(0, 3))}`);
      const acts = await PX.readMbzActivities(b.mbz);
      const sacts = await PX.readMbzActivities(sc.mbz);
      built[s.key] = { mbz: b.mbz, scorm: sc.mbz, acts, sacts };
      const mats = new Set(acts.map((a) => materialOf(a.idnumber, a.modname)));
      for (const need of ['bienvenida', 'ruta', 'leccion', 'portada-presentacion', 'tarjeta-actividad', 'actividad-aplicacion', 'practica-guiada', 'guia-docente', 'intro-evaluacion', 'audiolibro', 'cierre', 'h5p', 'evaluacion']) {
        assert(mats.has(need), `${s.key}: falta el material ${need}`);
      }
      assert(sacts.some((a) => a.modname === 'scorm'), `${s.key}: el curso de muestra trae SCORM`);
      fs.mkdirSync(path.join(OUT, s.key), { recursive: true });
      fs.writeFileSync(path.join(OUT, s.key, 'curso.mbz'), b.mbz);
      fs.writeFileSync(path.join(OUT, s.key, 'scorm.mbz'), sc.mbz);
    }
  });

  // ── M3 ──────────────────────────────────────────────────────────────────
  await check('M3 invariantes en línea: sin anchos fijos > 320 px sin tope, <img> con ancho que cabe y sin deformarse, enlaces-botón con caja propia (área ≥ 44 px)', async () => {
    const bad = [];
    for (const s of STYLES) {
      for (const a of [...built[s.key].acts, ...built[s.key].sacts.filter((x) => x.modname === 'scorm' || /:activity_instruction$/.test(x.idnumber))]) {
        if (!a.html) continue;
        for (const m of a.html.matchAll(/<(\w+)([^>]*)>/g)) {
          const tag = m[1].toLowerCase();
          const attrs = m[2];
          const style = ((/\sstyle="([^"]*)"/.exec(attrs) || [])[1] || '').replace(/&quot;/g, '"');
          const w = /(?:^|;)\s*(?:min-)?width:\s*(\d+)px/.exec(style);
          if (w && Number(w[1]) > 320 && !/max-width:\s*100%/.test(style)) bad.push(`${s.key} ${a.idnumber}: <${tag}> ancho fijo ${w[1]}px`);
          if (tag === 'img') {
            // El atributo width (px) sobrevive al purificador y mantiene la imagen dentro de la columna de 320 px; un
            // atributo height sin `height:auto` deforma la imagen cuando el tema la achica (max-width de Boost).
            const wa = Number((/\swidth="(\d+)"/.exec(attrs) || [])[1] || 0);
            if (!wa || wa > 304) bad.push(`${s.key} ${a.idnumber}: <img> sin atributo width ≤ 304 px (${wa || 'falta'})`);
            if (/\sheight="\d+"/.test(attrs) && !/height:\s*auto/.test(style)) bad.push(`${s.key} ${a.idnumber}: <img> con height fijo sin height:auto`);
          }
          // El enlace-botón es la píldora: caja de bloque que sobrevive al purificador (float) con padding ≥ 12 px.
          if (tag === 'a' && /\bcvc-btn-link\b/.test(attrs) && !(/(?:^|;)float:left/.test(style) && /(?:^|;)padding:1[2-9]px \d+px/.test(style) && /background-color:#/.test(style))) bad.push(`${s.key} ${a.idnumber}: enlace-botón sin caja propia (float + padding ≥ 12 px + fondo)`);
        }
      }
    }
    evidence.inlineInvariants = bad;
    assert(bad.length === 0, `${bad.length} problemas: ${[...new Set(bad)].slice(0, 12).join(' | ')}`);
  });

  // ── M2 ──────────────────────────────────────────────────────────────────
  await check(`M2 render sin Moodle: ${STYLES.length} estilos × materiales × ${WIDTHS.join('/')} px × regímenes guardado/limpio → sin desborde, texto legible, contraste AA, áreas táctiles ≥ 44 px`, async () => {
    const { launchChrome, sleep } = require('./lib/v21-cdp');
    const b = await launchChrome();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'r77-render-'));
    const problems = [];
    try {
      await b.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
      for (const s of STYLES) {
        const acts = [...built[s.key].acts, ...built[s.key].sacts.filter((x) => x.modname === 'scorm' || /:activity_instruction$/.test(x.idnumber))].filter((a) => a.html && /class="cvc/.test(a.html));
        for (const regime of ['guardado', 'limpio']) {
          const body = acts.map((a, i) => {
            const html = PX.displayableHtml(a);
            return `<div class="r77-act" data-r77="${i}"><div class="no-overflow">${regime === 'limpio' ? M.purifyHtmlApprox(html) : html}</div></div>`;
          }).join('\n');
          const file = path.join(tmp, `${s.key}-${regime}.html`);
          // Contenedor como el de Boost en el teléfono (8 px por lado bajo 576 px; el ancho de lectura de Moodle en escritorio).
          fs.writeFileSync(file, `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{margin:0;background:#fff;color:#1d2125;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;font-size:15px;line-height:1.5}.r77-wrap{padding:0 8px;max-width:830px;margin:0 auto}.r77-act{margin:0 0 16px}img{vertical-align:middle;border-style:none}</style></head><body><div class="r77-wrap">${body}</div></body></html>`);
          for (const w of WIDTHS) {
            const mobile = w < 768;
            await b.send('Emulation.setDeviceMetricsOverride', { width: w, height: 900, deviceScaleFactor: mobile ? 3 : 1, mobile });
            await b.send('Emulation.setUserAgentOverride', { userAgent: mobile ? 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Mobile Safari/537.36' : 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36' });
            await b.navigate('file://' + file);
            await sleep(150);
            const m = await b.evaluate(M.measureExpr({}));
            const rows = [];
            for (const r of m.roots) {
              const a = acts[Number(r.key)];
              const v = M.verdictOfRoot(r);
              const mat = materialOf(a.idnumber, a.modname);
              rows.push({ idnumber: a.idnumber, material: mat, pass: v.pass, fails: v.fails, warns: v.warns, fonts: { min: r.fonts.min, minRunning: r.fonts.minRunning }, targets: r.targets.filter((t) => !t.inline).map((t) => `${t.w}×${t.h}`) });
              if (!v.pass) problems.push(`${s.key} ${regime} ${w}px ${mat} (${a.idnumber.slice(0, 40)}): ${v.fails.join(' / ').slice(0, 400)}`);
            }
            if (m.page.overflowX) problems.push(`${s.key} ${regime} ${w}px: la página desborda (${m.page.scrollWidth} > ${m.page.clientWidth}) ${JSON.stringify(m.page.culprits || []).slice(0, 300)}`);
            ((evidence.render[s.key] = evidence.render[s.key] || {})[regime] = evidence.render[s.key][regime] || {})[w] = { pageOverflow: m.page.overflowX, rows };
          }
        }
      }
    } finally {
      b.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
    evidence.renderProblems = problems;
    assert(problems.length === 0, `${problems.length} problemas:\n   ${problems.slice(0, 40).join('\n   ')}`);
  });

  // ── M2b (solo con el Moodle local) ──────────────────────────────────────
  const MD0 = process.env.E2E_MOODLE_DIR || path.join(os.homedir(), 'cursia-test-env/moodle-local');
  if (fs.existsSync(path.join(MD0, 'source', 'config.php')) && fs.existsSync(path.join(MD0, 'php.ini'))) {
    await check('M2b calibración (Moodle local): el régimen «limpio» de M2 = purify_html() real de Moodle 4.5 (mismas etiquetas y mismos estilos)', async () => {
      process.env.E2E_MOODLE_DIR = MD0;
      process.env.PHP_BIN = process.env.PHP_BIN || '/opt/homebrew/bin/php';
      const PU = require('./lib/v21-moodle-purify');
      const tags = (h) => { const c = {}; for (const m of h.matchAll(/<([a-z0-9]+)/g)) c[m[1]] = (c[m[1]] || 0) + 1; return JSON.stringify(Object.entries(c).sort()); };
      // HTMLPurifier re-escribe las comillas de font-family ('-apple-system'): no cambia el diseño, se compara sin comillas.
      const sty = (h) => [...h.matchAll(/style="([^"]*)"/g)].map((m) => m[1].replace(/;$/, '').replace(/&#039;|'|&quot;|"/g, '')).join('|');
      const diffs = [];
      let n = 0;
      for (const s of STYLES) {
        const acts = [...built[s.key].acts, ...built[s.key].sacts.filter((x) => x.modname === 'scorm' || /:activity_instruction$/.test(x.idnumber))].filter((a) => a.html && /class="cvc/.test(a.html));
        // Con las URLs que pone Moodle (pluginfile): el purificador quita las imágenes data: (la vista previa las usa).
        const hs = acts.map((a) => a.html.replace(/@@PLUGINFILE@@\//g, 'http://127.0.0.1:8099/pluginfile.php/1/mod_label/intro/').replace(/(src|href)="(\$@[A-Z]+\*?\d*@\$)"/g, '$1="http://127.0.0.1:8099/mod/x/view.php"'));
        const real = PU.purifyMany(hs);
        hs.forEach((h, i) => {
          n++;
          const ap = M.purifyHtmlApprox(h);
          if (tags(ap) !== tags(real[i]) || sty(ap) !== sty(real[i])) diffs.push(`${s.key} ${acts[i].idnumber}`);
        });
      }
      assert(diffs.length === 0, `${diffs.length}/${n} difieren: ${diffs.slice(0, 6).join(' | ')}`);
      console.log(`   ${n} HTML de Cursia: aproximación = purificador real`);
    });
  } else {
    console.log('ℹ️  M2b calibración del purificador: NO CORRIDA (sin Moodle local; corre en el gate completo)');
  }

  // ── M4 ──────────────────────────────────────────────────────────────────
  if (BASE) {
    await check('M4 bytes frente a origin/staging: Libro Guía, insignia, H5P, GIFT y audio idénticos; los labels cambian solo en estilos (mismo texto)', async () => {
      const BB = require(path.join(BASE, 'package/dynamic-mbz-builder-v3.js'));
      const BPX = require(path.join(BASE, 'modules/visual-design/preview-extract.js'));
      const JSZip = require('jszip');
      const changed = {};
      for (const s of STYLES) {
        const a = built[s.key].mbz;
        const bb = await BB.buildDynamicMbzV3(F.mobileCourseInput(BASE, s.profile));
        const za = await JSZip.loadAsync(a);
        const zb = await JSZip.loadAsync(bb.mbz);
        // Archivos de contenido (files/…): idénticos (PDF del Libro, portadas, MP3, H5P, insignia).
        const fa = Object.keys(za.files).filter((k) => k.startsWith('files/')).sort();
        const fb = Object.keys(zb.files).filter((k) => k.startsWith('files/')).sort();
        assert(JSON.stringify(fa) === JSON.stringify(fb), `${s.key}: mismos archivos de contenido (${fa.length} / ${fb.length})`);
        for (const x of ['questions.xml']) {
          const xa = za.file(x) && (await za.file(x).async('string'));
          const xb = zb.file(x) && (await zb.file(x).async('string'));
          assert(xa === xb, `${s.key}: ${x} idéntico`);
        }
        const aa = await PX.readMbzActivities(a);
        const ab = await BPX.readMbzActivities(bb.mbz);
        assert(aa.length === ab.length, `${s.key}: mismas actividades`);
        const text = (h) => h.replace(/<style\b[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        for (let i = 0; i < aa.length; i++) {
          assert(aa[i].idnumber === ab[i].idnumber, `${s.key}: mismo orden`);
          if (aa[i].html === ab[i].html) continue;
          assert(text(aa[i].html) === text(ab[i].html), `${s.key} ${aa[i].idnumber}: el texto visible cambió\n     antes: ${text(ab[i].html).slice(0, 200)}\n     ahora: ${text(aa[i].html).slice(0, 200)}`);
          const k = materialOf(aa[i].idnumber, aa[i].modname);
          changed[k] = (changed[k] || 0) + 1;
        }
      }
      evidence.changedVsBase = changed;
      console.log(`   labels con estilos distintos de origin/staging (por material): ${JSON.stringify(changed)}`);
    });
  }

  // ── M5 ──────────────────────────────────────────────────────────────────
  if (MOODLE) await moodleChecks();

  fs.writeFileSync(path.join(OUT, 'evidence.json'), JSON.stringify(evidence, null, 1));
  console.log(`\n${passes} OK, ${failures} fallas · evidencia: ${path.join(OUT, 'evidence.json')}`);
  process.exit(failures && !NO_FAIL ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

// ─────────────────────────────────────────────────────────────────────────────
// M5 — Moodle 4.5 local + Playwright
// ─────────────────────────────────────────────────────────────────────────────
const DEVICES = [
  { key: 'android-320', engine: 'chromium', width: 320, height: 640, dpr: 3, mobile: true, ua: 'Mozilla/5.0 (Linux; Android 14; SM-A156M) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Mobile Safari/537.36' },
  { key: 'iphone-375', engine: 'webkit', descriptor: 'iPhone SE' },
  { key: 'iphone-390', engine: 'webkit', descriptor: 'iPhone 13' },
  { key: 'android-390', engine: 'chromium', width: 390, height: 844, dpr: 2.75, mobile: true, ua: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Mobile Safari/537.36' },
  { key: 'tablet-768', engine: 'webkit', descriptor: 'iPad Mini' },
  { key: 'desktop-1280', engine: 'chromium', width: 1280, height: 900, dpr: 1, mobile: false },
];

async function moodleChecks() {
  const PHP = process.env.PHP_BIN || '/opt/homebrew/bin/php';
  const MD = process.env.E2E_MOODLE_DIR || path.join(os.homedir(), 'cursia-test-env/moodle-local');
  const SRC = path.join(MD, 'source');
  const INI = path.join(MD, 'php.ini');
  const PW = require(process.env.PLAYWRIGHT_PATH || path.join(os.homedir(), 'cursia-test-env/pw-env/node_modules/playwright'));
  const php = (script, args) => {
    const r = spawnSync(PHP, ['-d', 'memory_limit=2048M', '-c', INI, path.join(ROOT, 'scripts/moodle', script), `--moodle=${SRC}`, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: 900000 });
    if (r.status !== 0) throw new Error(`${script} ${args.join(' ')} → ${r.status}: ${(r.stderr || '').slice(-1500)}${(r.stdout || '').slice(-500)}`);
    return r.stdout;
  };
  const creds = {};
  for (const l of fs.readFileSync(path.join(os.homedir(), 'cursia-test-env/creds/.local-test-credentials'), 'utf8').split('\n')) { const i = l.indexOf('='); if (i > 0) creds[l.slice(0, i)] = l.slice(i + 1).trim(); }
  const courses = {};
  const TITLE = 'Atención integral al cliente';
  const fcBefore = JSON.parse(php('r77-mobile.php', ['--action=forceclean'])).before;
  await check(`M5a Moodle 4.5: ${STYLES.length} cursos + 2 SCORM restaurados y el estudiante de prueba matriculado`, async () => {
    for (const s of STYLES) {
      for (const kind of ['curso', ...(s.key === 'aula-clara' || s.key === 'oscuro-premium' ? ['scorm'] : [])]) {
        const file = path.join(OUT, s.key, `${kind}.mbz`);
        const id = Number(/Course ID: (\d+)/.exec(php('r76-visual-design.php', ['--action=restore-new', `--file=${file}`, '--categoryid=1']))[1]);
        const r = spawnSync(PHP, ['-c', INI, path.join(ROOT, 'scripts/moodle/v21-video-moodle.php'), SRC, 'enrol', String(id), creds.username], { encoding: 'utf8' });
        assert(/"enrolled":true/.test(r.stdout || ''), `matrícula en ${s.key}/${kind}`);
        const cms = JSON.parse(php('r77-mobile.php', ['--action=cms', `--courseid=${id}`]));
        (courses[s.key] = courses[s.key] || {})[kind] = { id, cms };
      }
    }
    evidence.moodleCourses = Object.fromEntries(Object.entries(courses).map(([k, v]) => [k, Object.fromEntries(Object.entries(v).map(([kk, c]) => [kk, c.id]))]));
  });
  if (!Object.keys(courses).length) return;
  const net = require('net');
  const portInUse = (port) => new Promise((res) => { const s = net.connect({ host: '127.0.0.1', port }, () => { s.destroy(); res(true); }); s.on('error', () => res(false)); });
  assert(!(await portInUse(8099)), 'puerto 8099 libre (ver reference_gate_env_gotchas)');
  const server = spawn(PHP, ['-c', INI, '-S', '127.0.0.1:8099', '-t', SRC], { stdio: 'ignore', detached: true, env: { ...process.env, PHP_CLI_SERVER_WORKERS: '6' } });
  const browsers = {};
  const shotsDir = path.join(OUT, 'capturas');
  fs.mkdirSync(shotsDir, { recursive: true });
  const results = []; // { style, kind, material, device, regime, check… }
  try {
    for (let i = 0; i < 50 && !(await portInUse(8099)); i++) await new Promise((r) => setTimeout(r, 200));
    const ADMIN = { username: 'cursiaadmin', password: (() => { try { return fs.readFileSync(path.join(MD, '.admin-pass'), 'utf8').trim(); } catch (e) { return null; } })() };
    const contextFor = async (d, who = 'student') => {
      browsers[d.engine] = browsers[d.engine] || (await PW[d.engine].launch());
      const o = d.descriptor ? { ...PW.devices[d.descriptor] } : { viewport: { width: d.width, height: d.height }, deviceScaleFactor: d.dpr, isMobile: d.mobile, hasTouch: d.mobile, ...(d.ua ? { userAgent: d.ua } : {}) };
      const ctx = await browsers[d.engine].newContext({ ...o, locale: 'es-CO' });
      // Sin red externa: solo el Moodle local (los MP3 del audiolibro en línea apuntan a staging: no se descargan).
      await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort());
      const page = await ctx.newPage();
      await page.goto('http://127.0.0.1:8099/login/index.php');
      const u = who === 'teacher' ? ADMIN : creds;
      if (!u.password) throw new Error('sin la contraseña del administrador del Moodle local (.admin-pass)');
      await page.fill('#username', u.username);
      await page.fill('#password', u.password);
      await Promise.all([page.waitForNavigation(), page.click('#loginbtn')]);
      assert(!/\/login\/index\.php/.test(page.url()), `${d.key}: el inicio de sesión falló (${page.url()})`);
      return { ctx, page };
    };
    const go = async (page, url) => {
      await page.goto(url, { waitUntil: 'load', timeout: 60000 });
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(250);
    };
    const record = (meta, m) => {
      const cmByCm = new Map();
      for (const k of Object.keys(courses[meta.style])) for (const c of courses[meta.style][k].cms.cms) cmByCm.set(`module-${c.cmid}`, c);
      for (const r of m.roots) {
        const cm = r.id ? cmByCm.get(r.id) : null;
        const material = cm ? materialOf(cm.idnumber, cm.modname) : meta.material || 'pagina';
        const v = M.verdictOfRoot(r);
        results.push({ ...meta, material, idnumber: cm ? cm.idnumber : meta.idnumber || null, pass: v.pass, fails: v.fails, warns: v.warns, styleTags: r.styleTags, fonts: { min: r.fonts.min, minRunning: r.fonts.minRunning }, targets: r.targets.filter((t) => !t.inline).map((t) => `${t.w}×${t.h}`), moodleMedia: r.moodleMedia });
      }
      results.push({ ...meta, material: `@pagina:${meta.material || meta.page}`, pass: !m.page.overflowX, fails: m.page.overflowX ? [`la página desborda ${m.page.scrollWidth} > ${m.page.clientWidth}: ${JSON.stringify(m.page.culprits || []).slice(0, 400)}`] : [], warns: [], moodle: true });
    };
    for (const regime of ['guardado', 'limpio']) {
      php('r77-mobile.php', ['--action=forceclean', `--set=${regime === 'limpio' ? 1 : 0}`]);
      const ONLY_DEV = arg('devices') ? arg('devices').split(',') : null;
      const devices = (regime === 'guardado' ? DEVICES : DEVICES.filter((d) => ['android-320', 'iphone-390', 'desktop-1280'].includes(d.key))).filter((d) => !ONLY_DEV || ONLY_DEV.includes(d.key));
      // Materiales solo para docentes (ocultos al estudiante: Guía del docente, solucionario, notas para docentes): se miden
      // como administrador del Moodle local (el estudiante es redirigido a la portada del curso).
      for (const d of devices.filter((x) => ['android-320', 'iphone-390', 'desktop-1280'].includes(x.key))) {
        await check(`M5e ${regime} · ${d.key}: materiales solo para docentes (como docente) de ${STYLES.length} estilos`, async () => {
          const { ctx, page } = await contextFor(d, 'teacher');
          try {
            for (const s of STYLES) {
              const c = courses[s.key].curso;
              const hidden = c.cms.cms.filter((x) => !x.visible);
              for (const cm of hidden.filter((x) => x.modname === 'page')) {
                await go(page, cm.url);
                const m = await page.evaluate(M.measureExpr({}));
                const mat = materialOf(cm.idnumber, cm.modname);
                record({ style: s.key, kind: 'curso', device: d.key, regime, who: 'docente', page: `page-${mat}`, material: mat, idnumber: cm.idnumber }, m);
                if (d.key === 'iphone-390' && regime === 'guardado') await page.screenshot({ path: path.join(shotsDir, `${s.key}-${regime}-${d.key}-docente-${mat}.png`), fullPage: true });
              }
              const hiddenLabels = new Set(hidden.filter((x) => x.modname === 'label').map((x) => `module-${x.cmid}`));
              for (const sec of [...new Set(hidden.filter((x) => x.modname === 'label').map((x) => x.section))]) {
                await go(page, `http://127.0.0.1:8099/course/view.php?id=${c.id}&section=${sec}`);
                const m = await page.evaluate(M.measureExpr({}));
                m.roots = m.roots.filter((r) => hiddenLabels.has(r.id));
                m.page.overflowX = false;
                record({ style: s.key, kind: 'curso', device: d.key, regime, who: 'docente', page: `seccion-${sec}-docente`, material: `seccion-${sec}` }, m);
              }
            }
          } finally {
            await ctx.close();
          }
        });
      }
      if (process.argv.includes('--m5=teacher')) continue;
      for (const d of devices) {
        await check(`M5b ${regime} · ${d.key}: secciones, páginas, H5P, evaluaciones, SCORM, Libro e insignias de ${STYLES.length} estilos`, async () => {
          let { ctx, page } = await contextFor(d);
          try {
            for (const s of STYLES) {
              const c = courses[s.key].curso;
              const deep = (s.key === 'aula-clara' || s.key === 'oscuro-premium') && regime === 'guardado' && ['android-320', 'iphone-390', 'desktop-1280'].includes(d.key);
              const shoot = regime === 'guardado' ? ['iphone-390', 'desktop-1280', 'android-320'].includes(d.key) : d.key === 'iphone-390';
              for (const sec of c.cms.sections) {
                await go(page, `http://127.0.0.1:8099/course/view.php?id=${c.id}&section=${sec.section}`);
                let m = await page.evaluate(M.measureExpr({}));
                // Toda sección del curso tiene labels de Cursia: si no se ve ninguno, la sesión se perdió (nunca pasar en silencio).
                // Moodle local (servidor PHP de un proceso por pedido) a veces manda la PRIMERA visita a enrol/index.php: un reintento.
                // Si sigue sin verse (redirige a enrol/index.php aunque la matrícula está activa en la base), se vuelve a
                // iniciar sesión en un contexto nuevo y se reintenta UNA vez; queda registrado en la evidencia.
                for (let attempt = 0; !m.roots.length && attempt < 2; attempt++) {
                  if (attempt === 1) {
                    (evidence.moodle.sessionRetries = evidence.moodle.sessionRetries || []).push({ style: s.key, device: d.key, regime, section: sec.section, url: page.url() });
                    await ctx.close();
                    ({ ctx, page } = await contextFor(d));
                  } else await page.waitForTimeout(1500);
                  await go(page, `http://127.0.0.1:8099/course/view.php?id=${c.id}&section=${sec.section}`);
                  m = await page.evaluate(M.measureExpr({}));
                }
                assert(m.roots.length > 0, `${s.key}/${d.key}/${regime}: sección ${sec.section} sin contenido de Cursia (${page.url()}): ¿sesión perdida?`);
                record({ style: s.key, kind: 'curso', device: d.key, regime, page: `seccion-${sec.section}`, material: `seccion-${sec.section}` }, m);
                if (shoot && (sec.section <= 2 || deep)) await page.screenshot({ path: path.join(shotsDir, `${s.key}-${regime}-${d.key}-seccion${sec.section}.png`), fullPage: true });
              }
              for (const cm of c.cms.cms.filter((x) => x.modname === 'page')) {
                await go(page, cm.url);
                const m = await page.evaluate(M.measureExpr({}));
                const mat = materialOf(cm.idnumber, cm.modname);
                record({ style: s.key, kind: 'curso', device: d.key, regime, page: `page-${mat}`, material: mat, idnumber: cm.idnumber }, m);
                if (shoot && (deep || ['actividad-aplicacion', 'guia-docente', 'practica-guiada'].includes(mat))) await page.screenshot({ path: path.join(shotsDir, `${s.key}-${regime}-${d.key}-${mat}.png`), fullPage: true });
              }
              if (!deep) continue;
              await moodleDeep(page, s, c, d, regime, go, record, shotsDir);
              if (courses[s.key].scorm) await scormDeep(page, s, courses[s.key].scorm, d, regime, go, record, shotsDir);
            }
          } finally {
            await ctx.close();
          }
        });
      }
    }
  } finally {
    for (const b of Object.values(browsers)) await b.close().catch(() => {});
    // Con PHP_CLI_SERVER_WORKERS el servidor tiene hijos: se termina el grupo entero (si no, quedan huérfanos en :8099).
    try { process.kill(-server.pid, 'SIGTERM'); } catch (e) { server.kill('SIGTERM'); }
    php('r77-mobile.php', ['--action=forceclean', `--set=${fcBefore}`]);
  }
  evidence.moodle.results = results;
  fs.writeFileSync(path.join(OUT, 'moodle-results.json'), JSON.stringify(results, null, 1));
  await check('M5c Cursia en Moodle: ningún material de Cursia falla (desborde, texto, contraste, áreas táctiles) en ningún estilo, dispositivo ni régimen', async () => {
    const bad = results.filter((r) => !r.pass && !r.moodle);
    const by = {};
    for (const r of bad) { const k = `${r.material} · ${r.fails[0].split(':')[0]}`; (by[k] = by[k] || new Set()).add(`${r.style}/${r.device}/${r.regime}`); }
    assert(bad.length === 0, `${bad.length} fallas:\n   ${Object.entries(by).map(([k, v]) => `${k}: ${[...v].slice(0, 6).join(', ')}${v.size > 6 ? ` (+${v.size - 6})` : ''}`).join('\n   ')}\n   ejemplo: ${bad[0] && bad[0].fails.join(' / ').slice(0, 500)}`);
  });
  // App oficial de Moodle: lo que entrega core_course_get_contents (la app pinta esa descripción tal cual llega).
  await check('M5d app de Moodle (servicio web core_course_get_contents): con «Limpiar contenido» apagado llega el HTML con <style>; encendido llega sin <style> y los botones de Cursia conservan su caja (float + padding + fondo)', async () => {
    const id = courses[STYLES[0].key].curso.id;
    const out = {};
    try {
      for (const fc of [0, 1]) {
        php('r77-mobile.php', ['--action=forceclean', `--set=${fc}`]);
        const ws = JSON.parse(php('r77-mobile.php', ['--action=webservice-contents', `--courseid=${id}`, `--username=${creds.username}`]));
        const labels = ws.filter((m) => m.modname === 'label' && m.description);
        const all = labels.map((m) => m.description).join('\n');
        const btns = [...all.matchAll(/<a class="cvc-btn-link"[^>]*style="([^"]*)"/g)].map((m) => m[1]);
        out[fc ? 'limpio' : 'guardado'] = { labels: labels.length, styleTags: (all.match(/<style\b/g) || []).length, buttons: btns.length, buttonsWithBox: btns.filter((x) => /float:\s*left/.test(x) && /padding:\s*12px/.test(x) && /background-color/.test(x)).length };
      }
    } finally {
      php('r77-mobile.php', ['--action=forceclean', `--set=${fcBefore}`]);
    }
    evidence.moodle.app = out;
    console.log(`   ${JSON.stringify(out)}`);
    assert(out.limpio.styleTags === 0, 'con forceclean la app no recibe <style>');
    assert(out.limpio.buttons > 0 && out.limpio.buttonsWithBox === out.limpio.buttons, `botones con caja en la app (forceclean): ${out.limpio.buttonsWithBox}/${out.limpio.buttons}`);
  });
  if (!process.argv.includes('--keep')) {
    for (const k of Object.keys(courses)) for (const c of Object.values(courses[k])) {
      try { php('r76-visual-design.php', ['--action=delete', `--courseid=${c.id}`, `--title=${c.cms.fullname.slice(0, 20)}`]); } catch (e) { console.log(`   (no se pudo borrar #${c.id}: ${e.message.slice(0, 120)})`); }
    }
  }
}

/** H5P, exámenes (vista + intento), Libro Guía, insignias y navegación del curso (Moodle). */
async function moodleDeep(page, s, c, d, regime, go, record, shotsDir) {
  const meta = { style: s.key, kind: 'curso', device: d.key, regime };
  const deepOut = (evidence.moodle.deep = evidence.moodle.deep || {});
  const key = `${s.key}/${d.key}/${regime}`;
  const info = (deepOut[key] = {});
  // Navegación de Boost: índice del curso (cajón), activity navigation, enlace de vuelta.
  const first = c.cms.cms.find((x) => x.modname === 'page');
  await go(page, first.url);
  info.navigation = await page.evaluate(() => {
    const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height), visible: b.width > 0 && b.height > 0 }; };
    // El botón visible que abre el índice del curso (Boost tiene uno en el cajón y otro flotante; se toma el visible).
    const toggle = Array.from(document.querySelectorAll('.drawer-toggler.drawer-left-toggle button, button[data-target="theme_boost-drawers-courseindex"], button'))
      .filter((b) => /course index|índice del curso/i.test(`${b.getAttribute('aria-label') || ''} ${b.title || ''} ${b.getAttribute('data-original-title') || ''}`))
      .find((b) => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0; }) || null;
    if (toggle) toggle.setAttribute('data-r77-toggle', '1');
    return {
      courseIndexToggle: r(toggle),
      prev: r(document.querySelector('#prev-activity-link')),
      next: r(document.querySelector('#next-activity-link')),
      jump: r(document.querySelector('#jump-to-activity, .urlselect select')),
      breadcrumb: !!document.querySelector('.breadcrumb, #page-navbar'),
      secondaryNav: r(document.querySelector('.secondary-navigation')),
      overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    };
  });
  const tog = await page.$('[data-r77-toggle="1"]');
  if (tog && (await tog.isVisible())) {
    await tog.click();
    await page.waitForTimeout(600);
    info.navigation.drawer = await page.evaluate(() => {
      const dr = document.querySelector('#theme_boost-drawers-courseindex');
      if (!dr) return null;
      const b = dr.getBoundingClientRect();
      const links = Array.from(dr.querySelectorAll('a.courseindex-link')).filter((a) => a.getBoundingClientRect().height > 0);
      const closeBtn = dr.querySelector('.drawerheader button, button[data-action="closedrawer"]');
      const hs = links.map((a) => Math.round(a.getBoundingClientRect().height));
      const cb = closeBtn ? closeBtn.getBoundingClientRect() : null;
      return { w: Math.round(b.width), vw: document.documentElement.clientWidth, links: links.length, minLinkHeight: hs.length ? Math.min(...hs) : null, closeButton: cb ? `${Math.round(cb.width)}×${Math.round(cb.height)}` : null };
    });
    await page.screenshot({ path: path.join(shotsDir, `${s.key}-${regime}-${d.key}-indice-del-curso.png`) });
  }
  // H5P: video interactivo, actividad, Repaso (solo contenido).
  info.h5p = [];
  for (const cm of c.cms.cms.filter((x) => x.modname === 'h5pactivity')) {
    await go(page, cm.url);
    await page.waitForTimeout(2500);
    const m = await page.evaluate(M.measureExpr({}));
    const mat = materialOf(cm.idnumber, 'h5pactivity');
    record({ ...meta, page: `h5p-${cm.idnumber.split(':').pop()}`, material: 'h5p-intro', idnumber: cm.idnumber }, m);
    const frame = await page.evaluate(() => {
      const f = document.querySelector('iframe.h5p-player, iframe[src*="h5p/embed.php"]');
      if (!f) return null;
      const b = f.getBoundingClientRect();
      return { w: Math.round(b.width), h: Math.round(b.height), vw: document.documentElement.clientWidth };
    });
    let inner = null;
    for (const fr of page.frames()) {
      if (!/h5p\/embed\.php/.test(fr.url())) continue;
      const deeper = fr.childFrames()[0] || fr;
      inner = await deeper.evaluate(() => {
        const de = document.documentElement;
        const btns = Array.from(document.querySelectorAll('button,[role="button"],.h5p-joubelui-button,a')).filter((e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0; });
        const small = btns.filter((e) => { const b = e.getBoundingClientRect(); return b.width < 44 || b.height < 44; });
        let minFs = 99;
        for (const e of document.querySelectorAll('body *')) { if (e.children.length || !e.textContent.trim()) continue; const b = e.getBoundingClientRect(); if (!b.width) continue; minFs = Math.min(minFs, parseFloat(getComputedStyle(e).fontSize)); }
        return { scrollW: de.scrollWidth, clientW: de.clientWidth, overflowX: de.scrollWidth > de.clientWidth + 1, buttons: btns.length, smallButtons: small.length, smallExamples: small.slice(0, 4).map((e) => `${(e.getAttribute('aria-label') || e.textContent || e.className).trim().slice(0, 30)} ${Math.round(e.getBoundingClientRect().width)}×${Math.round(e.getBoundingClientRect().height)}`), minFontPx: minFs === 99 ? null : minFs, library: (document.querySelector('.h5p-content') || {}).className || null };
      }).catch((e) => ({ error: e.message.slice(0, 120) }));
    }
    info.h5p.push({ idnumber: cm.idnumber, material: mat, frame, inner });
    await page.screenshot({ path: path.join(shotsDir, `${s.key}-${regime}-${d.key}-h5p-${cm.idnumber.split(':').pop()}-${cm.cmid}.png`), fullPage: true });
  }
  // Evaluación del módulo: vista + intento (motor de exámenes de Moodle).
  info.quiz = [];
  for (const cm of c.cms.cms.filter((x) => x.modname === 'quiz').slice(0, 1)) {
    await go(page, cm.url);
    const m = await page.evaluate(M.measureExpr({}));
    record({ ...meta, page: 'quiz-view', material: 'intro-evaluacion-quiz', idnumber: cm.idnumber }, m);
    await page.screenshot({ path: path.join(shotsDir, `${s.key}-${regime}-${d.key}-examen-vista.png`), fullPage: true });
    const btn = await page.$('button:has-text("Intente resolver"), button:has-text("Attempt quiz"), button:has-text("Continuar"), .quizstartbuttondiv button, form[action*="startattempt"] button');
    let attempt = null;
    if (btn) {
      await Promise.all([page.waitForNavigation({ timeout: 30000 }).catch(() => {}), btn.click()]);
      const modal = await page.$('.modal-dialog button.btn-primary, #id_submitbutton');
      if (modal && (await modal.isVisible())) await Promise.all([page.waitForNavigation({ timeout: 30000 }).catch(() => {}), modal.click()]);
      await page.waitForTimeout(800);
      attempt = await page.evaluate(() => {
        const de = document.documentElement;
        const opts = Array.from(document.querySelectorAll('.que .answer input[type=radio], .que .answer input[type=checkbox]'));
        const labels = Array.from(document.querySelectorAll('.que .answer > div, .que .answer label')).map((e) => e.getBoundingClientRect()).filter((b) => b.height > 0);
        const navBtns = Array.from(document.querySelectorAll('.submitbtns input, .submitbtns button, .mod_quiz-next-nav')).map((e) => e.getBoundingClientRect()).filter((b) => b.height > 0);
        const qtext = document.querySelector('.qtext');
        return {
          url: location.pathname, questions: document.querySelectorAll('.que').length, overflowX: de.scrollWidth > de.clientWidth + 1, scrollW: de.scrollWidth, clientW: de.clientWidth,
          radios: opts.length, minAnswerRowHeight: labels.length ? Math.round(Math.min(...labels.map((b) => b.height))) : null,
          navButtons: navBtns.map((b) => `${Math.round(b.width)}×${Math.round(b.height)}`), qtextFontPx: qtext ? parseFloat(getComputedStyle(qtext).fontSize) : null,
        };
      });
      await page.screenshot({ path: path.join(shotsDir, `${s.key}-${regime}-${d.key}-examen-intento.png`), fullPage: true });
    }
    info.quiz.push({ idnumber: cm.idnumber, attempt });
  }
  // Libro Guía: recurso PDF (cómo lo abre Moodle en el teléfono, tamaño, páginas).
  const libro = c.cms.cms.find((x) => x.modname === 'resource');
  if (libro) {
    const resp = [];
    const onResp = (r) => { if (/pluginfile\.php\/.+\.pdf/i.test(r.url())) resp.push({ status: r.status(), type: r.headers()['content-type'], length: r.headers()['content-length'] || null, disposition: r.headers()['content-disposition'] || null }); };
    page.on('response', onResp);
    let dl = null;
    const dlP = page.waitForEvent('download', { timeout: 8000 }).then((x) => (dl = x.suggestedFilename())).catch(() => {});
    await page.goto(libro.url, { waitUntil: 'load', timeout: 60000 }).catch((e) => resp.push({ navError: e.message.slice(0, 80) }));
    await dlP;
    await page.waitForTimeout(1200);
    const view = await page.evaluate(() => ({
      url: location.pathname, embed: !!document.querySelector('.resourcecontent object, .resourcecontent iframe, .resourcepdf, embed[type="application/pdf"], object[type="application/pdf"]'),
      openLink: Array.from(document.querySelectorAll('.resourceworkaround a, a[href*="pluginfile.php"]')).map((a) => { const b = a.getBoundingClientRect(); return `${a.textContent.trim().slice(0, 30)} ${Math.round(b.width)}×${Math.round(b.height)}`; }).slice(0, 3),
      title: document.title.slice(0, 60),
    })).catch((e) => ({ error: e.message.slice(0, 80) }));
    page.off('response', onResp);
    info.libro = { view, responses: resp.slice(0, 3), download: dl };
    await page.screenshot({ path: path.join(shotsDir, `${s.key}-${regime}-${d.key}-libro-guia.png`) }).catch(() => {});
  }
  // Insignias del curso (el certificado se ve como insignia; se otorga al aprobar la evaluación final).
  await go(page, `http://127.0.0.1:8099/badges/index.php?type=2&id=${c.id}`);
  info.badges = await page.evaluate(() => ({ overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1, items: document.querySelectorAll('.badge-image, img.badge-image, .generaltable tbody tr, .badges li').length, title: document.title.slice(0, 60) }));
  await page.screenshot({ path: path.join(shotsDir, `${s.key}-${regime}-${d.key}-insignias.png`), fullPage: true });
}

async function scormDeep(page, s, c, d, regime, go, record, shotsDir) {
  const meta = { style: s.key, kind: 'scorm', device: d.key, regime };
  await go(page, `http://127.0.0.1:8099/course/view.php?id=${c.id}&section=2`);
  record({ ...meta, page: 'scorm-seccion', material: 'seccion-2' }, await page.evaluate(M.measureExpr({})));
  await page.screenshot({ path: path.join(shotsDir, `${s.key}-${regime}-${d.key}-scorm-seccion.png`), fullPage: true });
  const cm = c.cms.cms.find((x) => x.modname === 'scorm');
  if (!cm) return;
  await go(page, cm.url);
  record({ ...meta, page: 'scorm-view', material: 'tarjeta-scorm', idnumber: cm.idnumber }, await page.evaluate(M.measureExpr({})));
  const enter = await page.$('form[action*="player.php"] [type=submit], #scormviewform [type=submit], input[value="Entrar"], button:has-text("Entrar"), input[value="Enter"]');
  let player = null;
  if (enter) {
    await Promise.all([page.waitForNavigation({ timeout: 30000 }).catch(() => {}), enter.click()]);
    await page.waitForTimeout(2500);
    player = await page.evaluate(() => {
      const f = document.querySelector('#scorm_object, iframe#scorm_object, iframe');
      const b = f ? f.getBoundingClientRect() : null;
      return { url: location.pathname, frame: b ? { w: Math.round(b.width), h: Math.round(b.height) } : null, vw: document.documentElement.clientWidth, overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1 };
    });
    await page.screenshot({ path: path.join(shotsDir, `${s.key}-${regime}-${d.key}-scorm-player.png`), fullPage: true });
  }
  ((evidence.moodle.deep = evidence.moodle.deep || {})[`${s.key}/${d.key}/${regime}`] = evidence.moodle.deep[`${s.key}/${d.key}/${regime}`] || {}).scorm = { player };
}
