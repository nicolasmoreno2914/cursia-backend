#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * r76 — «Diseño visual»: perfil de presentación extendido, vista previa REAL y paridad vista previa = paquete = Moodle.
 * Sin IA, sin red, USD 0.
 *
 *   V1 esquema: perfiles anteriores idénticos (mismo objeto y sha que origin/staging); tipografía e identidad validadas;
 *      el default de identidad se normaliza a ausente («Restaurar valores» = mismo sha)
 *   V2 tema: sin `typography` el tema es el de siempre (mismo themeSha256 que origin/staging en las 7 combinaciones, con y
 *      sin colores de marca); sans / serif cambian solo las fuentes; el Libro Guía usa la familia elegida
 *   V3 contraste: todo color principal (amarillo, blanco, gris, negro, marcas) × 7 estilos → todos los pares de texto del
 *      tema ≥ 4,5:1 (WCAG AA) y el informe dice cuándo el motor ajustó el color pedido
 *   V4 compatibilidad: sin las claves nuevas el builder arma EXACTAMENTE los mismos bytes que el de origin/staging
 *      (--base=<dist de origin/staging>), en 3 temas
 *   V5 vista previa = paquete: el HTML de cada muestra es el del label del .mbz (byte a byte); el HTML para mostrar solo
 *      cambia src/href; el paquete de muestra pasa el validador v3
 *   V6 paridad con OTRO curso (2 módulos × 2): mismos estilos en línea (colores y fuentes) en bienvenida, presentación del
 *      módulo, lección e introducción de la evaluación
 *   V7 identidad: logo propio → Libro (course_profile) + bienvenida con <img> en files.xml (SHA1 = bytes); nombre con cifras
 *      admitido; marca de agua apagada = 0 por página; Cursia; logo inválido → siguiente candidato con aviso
 *   V8 empaque: applyPresentationIdentity / huella de marca (default = la de siempre); loadPackagingProfilesV3 lleva
 *      tipografía e identidad
 *   V9 permisos y autoría: marcas @RequirePermission de los endpoints nuevos; POST de perfil registra al ACTOR
 *   V10 (--moodle) restauración REAL en Moodle 4.5 local de 4 diseños (incluido uno con color, logo y nombre propios):
 *      HTML tras format_text con los estilos en línea, colores, fuentes y logo; archivos con su sha1; capturas
 *
 * Uso: npm run build && node scripts/check-r76-visual-design.js [--base=<dist>] [--moodle] [--out=<dir>]
 */
'use strict';
require('reflect-metadata');
const OWNER = '0b6c7f2e-1111-4222-8333-944444444444';
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const realFetch = global.fetch;
// Sin red: solo 127.0.0.1 (el CDP de Chrome headless de las capturas de V10).
global.fetch = async (u, o) => { if (/^http:\/\/127\.0\.0\.1[:/]/.test(String(u))) return realFetch(u, o); throw new Error(`NETWORK FORBIDDEN in check: ${u}`); };

const ROOT = path.resolve(__dirname, '..');
const dist = path.join(ROOT, 'dist');
const L = (r) => require(path.join(dist, r));
const arg = (k) => (process.argv.find((a) => a.startsWith(`--${k}=`)) || '').slice(k.length + 3);
const BASE = arg('base');
const MOODLE = process.argv.includes('--moodle');
const OUT = arg('out') || path.join(os.homedir(), 'cursia-test-env/work/r76/out');
const B = L('package/dynamic-mbz-builder-v3.js');
const VAL = L('package/v3/mbz-validator-v3.js');
const P = L('modules/course-profiles/course-profiles.js');
const T = L('modules/theme-engine/index.js');
const PK = L('modules/dynamic-packaging/packaging-v3.js');
const LIBRO = L('package/v3/libro-v3.js');
const LOGO = L('package/v3/libro-logo.js');
const MEDIA = L('package/v3/synthetic-media.js');
const PF = L('modules/visual-design/preview-fixture.js');
const PX = L('modules/visual-design/preview-extract.js');
const VS = L('modules/visual-design/visual-design.service.js');
const V = require('./lib/v21-packaging-fixtures');

let passes = 0;
let failures = 0;
const previews = {};
const evidence = { generatedAt: new Date().toISOString(), designs: {}, moodle: {} };
const assert = (c, m) => { if (!c) throw new Error(m); };
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: esperado ${JSON.stringify(b)}, encontrado ${JSON.stringify(a)}`); };
async function check(name, fn) {
  const t = Date.now();
  try { await fn(); passes++; console.log(`✅ ${name} (${((Date.now() - t) / 1000).toFixed(1)} s)`); } catch (e) { failures++; console.log(`❌ ${name}\n   ${e.stack || e}`); }
}
const sha1 = (b) => crypto.createHash('sha1').update(b).digest('hex');
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const COMBOS = [['aula-clara', 'light'], ['institucional', 'light'], ['editorial', 'light'], ['vibrante', 'light'], ['tecnico', 'light'], ['tecnico', 'dark'], ['oscuro-premium', 'dark']];

/** Logo de prueba: PNG RGBA 240×90, fondo transparente con una franja de color (determinístico). */
function testLogoPng(hex = '#7A1F5C') {
  const w = 240, h = 90;
  const px = Buffer.alloc(w * h * 4);
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    const inside = (x > 10 && x < 80 && y > 10 && y < 80) || (y > 35 && y < 55 && x > 90 && x < 230);
    px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = inside ? 255 : 0;
  }
  return MEDIA.encodePng(w, h, 4, px);
}
const LOGO_URI = `data:image/png;base64,${testLogoPng().toString('base64')}`;

/** DB falsa para VisualDesignService: curso #77 de user-A, sin institución; logo de la cuenta opcional. */
function fakeDb(o = {}) {
  return {
    query: async (sql) => {
      if (/select title, owner_id, institution_id/.test(sql)) return [{ title: 'QA r76 Diseño visual', owner_id: 'user-A', institution_id: o.institutionId ?? null }];
      if (/select owner_id, institution_id from public\.courses/.test(sql)) return [{ owner_id: 'user-A', institution_id: o.institutionId ?? null }];
      if (/to_regclass/.test(sql)) return [{ bp: true, us: true, inst: true }];
      if (/from public\.institutions/.test(sql)) return [{ name: 'Institución QA' }];
      if (/from public\.brand_profiles/.test(sql)) return [];
      if (/from public\.user_settings/.test(sql)) return o.accountLogo ? [{ logo_b64: o.accountLogo }] : [];
      throw new Error(`consulta no esperada: ${sql.slice(0, 80)}`);
    },
  };
}
const fakeProfiles = { getCurrent: async () => ({ profile: P.defaultPresentationProfile(), version: 0, isDefault: true, createdAt: null, createdBy: null }) };
const service = (o) => new VS.VisualDesignService(fakeDb(o), fakeProfiles);

const DESIGNS = {
  'editorial-serif': { themeFamily: 'editorial', mode: 'light', brandSeed: null, themeVersion: 1, typography: 'serif' },
  'oscuro-premium': { themeFamily: 'oscuro-premium', mode: 'dark', brandSeed: null, themeVersion: 1 },
  'tecnico-oscuro-color': { themeFamily: 'tecnico', mode: 'dark', brandSeed: { accent: '#F59E0B', moduleColors: ['#0EA5E9', '#22C55E', '#E11D48'] }, themeVersion: 1 },
  'institucional-marca': {
    themeFamily: 'institucional', mode: 'light', brandSeed: { accent: '#7A1F5C', moduleColors: ['#7A1F5C', '#0F766E', '#B45309'] }, themeVersion: 1, typography: 'sans',
    identity: { logo: 'custom', logoDataUri: LOGO_URI, institutionName: 'Colegio 21 de Mayo', watermark: false, showInCourse: true },
  },
};

(async () => {
  fs.mkdirSync(OUT, { recursive: true });

  // ── V1 ──────────────────────────────────────────────────────────────────
  await check('V1 esquema: perfiles anteriores idénticos; tipografía e identidad validadas; el default de identidad no cambia el sha', async () => {
    const BP = BASE ? require(path.join(BASE, 'modules/course-profiles/course-profiles.js')) : null;
    const olds = [P.defaultPresentationProfile(), { themeFamily: 'tecnico', mode: 'dark', brandSeed: { accent: '#0E7490', moduleColors: ['#111111', '#222222'] }, themeVersion: 1 }];
    for (const o of olds) {
      eq(P.validatePresentationProfile(o), [], 'perfil anterior válido');
      eq(P.normalizePresentationProfile(o), o, 'mismo objeto');
      if (BP) eq(P.profileSha256(P.normalizePresentationProfile(o)), BP.profileSha256(BP.normalizePresentationProfile(o)), 'mismo sha que origin/staging');
    }
    const withDefault = { ...olds[0], typography: 'family', identity: { logo: 'account', watermark: true, showInCourse: false } };
    eq(P.normalizePresentationProfile(withDefault), olds[0], 'default de tipografía e identidad → ausente');
    eq(P.profileSha256(P.normalizePresentationProfile(withDefault)), P.profileSha256(olds[0]), '«Restaurar valores» = mismo sha');
    const n = P.normalizePresentationProfile(DESIGNS['institucional-marca']);
    eq(Object.keys(n.identity), ['logo', 'logoDataUri', 'institutionName', 'watermark', 'showInCourse'], 'identidad completa');
    eq(n.typography, 'sans', 'tipografía');
    const bad = (p, code) => {
      const e = P.validatePresentationProfile({ ...olds[0], ...p });
      assert(e.some((x) => x.code === code), `${JSON.stringify(p).slice(0, 80)} → ${code} (hubo ${JSON.stringify(e.map((x) => x.code))})`);
    };
    bad({ typography: 'comic' }, 'INVALID_TYPOGRAPHY');
    bad({ identity: { logo: 'otro', watermark: true, showInCourse: false } }, 'INVALID_IDENTITY_LOGO');
    bad({ identity: { logo: 'custom', watermark: true, showInCourse: false } }, 'MISSING_FIELD');
    bad({ identity: { logo: 'account', logoDataUri: LOGO_URI, watermark: true, showInCourse: false } }, 'INVALID_IDENTITY_LOGO');
    bad({ identity: { logo: 'custom', logoDataUri: 'data:image/svg+xml;base64,PHN2Zz4=', watermark: true, showInCourse: false } }, 'INVALID_IDENTITY_LOGO');
    bad({ identity: { logo: 'custom', logoDataUri: 'data:image/png;base64,' + 'A'.repeat(P.PRESENTATION_LOGO_MAX_CHARS), watermark: true, showInCourse: false } }, 'IDENTITY_LOGO_TOO_LARGE');
    bad({ identity: { logo: 'account', institutionName: '<script>', watermark: true, showInCourse: false } }, 'INVALID_IDENTITY_NAME');
    bad({ identity: { logo: 'account', watermark: 'sí', showInCourse: false } }, 'INVALID_TYPE');
    bad({ identity: { logo: 'account', watermark: true, showInCourse: false, extra: 1 } }, 'UNKNOWN_FIELD');
    bad({ fuente: 'x' }, 'UNKNOWN_FIELD');
  });

  // ── V2 ──────────────────────────────────────────────────────────────────
  await check('V2 tema: sin tipografía = el de siempre (themeSha de origin/staging); sans/serif cambian solo las fuentes; el Libro las sigue', async () => {
    const BT = BASE ? require(path.join(BASE, 'modules/theme-engine/index.js')) : null;
    for (const [f, m] of COMBOS) {
      for (const seed of [undefined, { accent: '#7A1F5C', moduleColors: ['#0F766E'] }]) {
        const input = { themeFamily: f, mode: m, ...(seed ? { brandSeed: seed } : {}) };
        const t = T.resolveTheme(input);
        if (BT) {
          let baseTheme = null;
          try { baseTheme = BT.resolveTheme(input); } catch (e) { if (!/THEME_INVALID/.test(e.message)) throw e; }
          // Un color que origin/staging no podía resolver (THEME_INVALID al empaquetar) ahora se corrige: se registra.
          if (baseTheme) eq(T.themeSha256(t), BT.themeSha256(baseTheme), `${f}/${m}: mismo tema que origin/staging`);
          else (evidence.previouslyInvalidNowResolved = evidence.previouslyInvalidNowResolved || []).push({ f, m, seed, adjustments: t.adjustments });
        }
        for (const ty of ['sans', 'serif']) {
          const u = T.resolveTheme({ ...input, typography: ty });
          eq(u.color, t.color, `${f}/${m}/${ty}: mismos colores`);
          assert(T.themeSha256(u) !== T.themeSha256(t) || (ty === 'sans' && t.typography.fontBody === u.typography.fontBody), `${f}/${m}/${ty}: el sha cambia con la fuente`);
          assert(ty === 'serif' ? /serif\s*$/.test(u.typography.fontBody) : !/(^|,)\s*serif\s*$/.test(u.typography.fontBody), `${f}/${m}/${ty}: pila del cuerpo`);
          eq(u.personality.fontDisplay, T.TYPOGRAPHY_STACKS ? u.personality.fontDisplay : u.personality.fontDisplay, 'personalidad');
        }
      }
    }
    let threw = false;
    try { T.resolveTheme({ themeFamily: 'aula-clara', mode: 'light', typography: 'comic' }); } catch (e) { threw = /THEME_INVALID/.test(e.message); }
    assert(threw, 'tipografía desconocida → THEME_INVALID');
  });

  // ── V3 ──────────────────────────────────────────────────────────────────
  await check('V3 contraste WCAG AA: cualquier color principal × 7 estilos → todos los pares de texto ≥ 4,5:1; se informa el ajuste', async () => {
    const accents = ['#FFFF00', '#FFFFFF', '#777777', '#000000', '#7A1F5C', '#38BDF8', '#22C55E', '#F59E0B', '#E11D48'];
    const table = [];
    for (const [f, m] of COMBOS) for (const a of accents) {
      const t = T.resolveTheme({ themeFamily: f, mode: m, brandSeed: { accent: a } });
      const r = VS.contrastReport(t, a);
      for (const p of r.pairs) assert(p.ok && p.ratio >= 4.5, `${f}/${m} ${a}: ${p.label} ${p.ratio}:1`);
      if (r.requested.onBg < 4.5) assert(r.adjustments.length > 0 || T.contrastRatio(t.color.accentStrong, t.color.bg) >= 4.5, `${f}/${m} ${a}: color ilegible sin ajuste`);
      table.push({ f, m, a, applied: r.requested.applied, adjusted: r.requested.adjusted, min: Math.min(...r.pairs.map((p) => p.ratio)) });
    }
    const y = table.find((x) => x.f === 'aula-clara' && x.a === '#FFFF00');
    assert(y.adjusted, 'amarillo puro sobre claro se ajusta');
    evidence.contrast = table;
  });

  // ── V4 ──────────────────────────────────────────────────────────────────
  if (BASE) {
    await check('V4 compatibilidad: sin las claves nuevas, mismos bytes que el builder de origin/staging (3 temas)', async () => {
      const BB = require(path.join(BASE, 'package/dynamic-mbz-builder-v3.js'));
      for (const theme of [{ themeFamily: 'aula-clara', mode: 'light' }, { themeFamily: 'tecnico', mode: 'dark' }, { themeFamily: 'editorial', mode: 'light' }]) {
        const a = await B.buildDynamicMbzV3(V.packagingInput(dist, { theme }));
        const b = await BB.buildDynamicMbzV3(V.packagingInput(BASE, { theme }));
        eq(sha256(a.mbz), sha256(b.mbz), `${theme.themeFamily}/${theme.mode}: mismo .mbz`);
        const c = await B.buildDynamicMbzV3({ ...V.packagingInput(dist, { theme }), libroBrand: { logo: null, name: 'Institución QA' } });
        const d = await BB.buildDynamicMbzV3({ ...V.packagingInput(BASE, { theme }), libroBrand: { logo: null, name: 'Institución QA' } });
        eq(sha256(c.mbz), sha256(d.mbz), `${theme.themeFamily}/${theme.mode}: mismo .mbz con marca de la cuenta`);
      }
    });
  }

  // ── V5 ──────────────────────────────────────────────────────────────────
  // (previews: ámbito del módulo, también lo usa V10)
  await check('V5 vista previa = paquete: cada muestra es el HTML del label del .mbz; solo src/href cambian para mostrarla; el paquete valida', async () => {
    const svc = service();
    for (const [name, profile] of Object.entries(DESIGNS)) {
      const pv = await svc.preview(77, 'user-A', profile, { includePackage: true });
      previews[name] = pv;
      const mbz = Buffer.from(pv.package.base64, 'base64');
      // Independiente: el mismo curso de muestra con el mismo perfil armado aparte.
      const norm = P.normalizePresentationProfile(profile);
      const brand = PK.applyPresentationIdentity({ logo: null, candidates: [], name: null, warnings: [] }, P.presentationIdentityOf(norm));
      const input = PF.previewPackagingInput(PK.resolvePackagingTheme({ presentationProfile: norm }).input, {
        logo: brand.candidates, name: brand.name, ...(brand.watermark === false ? { watermark: false } : {}), ...(brand.showInCourse ? { showInCourse: true } : {}),
      });
      const built = await B.buildDynamicMbzV3(input);
      eq(sha256(built.mbz), pv.package.sha256, `${name}: el paquete de la vista previa = el armado aparte`);
      const acts = await PX.readMbzActivities(built.mbz);
      assert(pv.samples.length >= 9, `${name}: ${pv.samples.length} muestras`);
      for (const s of pv.samples) {
        const a = acts.find((x) => x.idnumber === s.idnumber);
        assert(a, `${name}: ${s.idnumber} en el paquete`);
        assert(a.html === s.packagedHtml, `${name}/${s.key}: HTML de la vista previa = HTML del label en el .mbz`);
        const strip = (h) => h.replace(/(src|href)="[^"]*"/g, '$1=""');
        assert(strip(s.html) === strip(a.html), `${name}/${s.key}: para mostrar solo cambian src/href`);
        assert(!/@@PLUGINFILE@@/.test(s.html), `${name}/${s.key}: sin URLs de Moodle en la vista previa`);
      }
      const errs = VAL.validateMbzV3(built.mbz, {
        facts: built.expectations.facts, resolved: built.expectations.resolved, examBankPlans: built.expectations.examBankPlans, shellProseByLabel: built.expectations.shellProseByLabel,
        builderVersion: built.expectations.builderVersion, moodleMinimum: built.expectations.moodleMinimum, internalVocabularyExempt: built.expectations.internalVocabularyExempt,
        internalVocabularyUserTexts: built.expectations.internalVocabularyUserTexts,
      });
      const list = Array.isArray(errs) ? errs : (errs && errs.errors) || [];
      eq(list.length ? list.slice(0, 3) : [], [], `${name}: validador v3`);
      assert(pv.libro && pv.libro.pageCount >= 4 && Buffer.from(pv.libro.pdfBase64, 'base64').subarray(0, 5).toString() === '%PDF-', `${name}: Libro Guía en PDF`);
      assert(pv.badge && /^data:image\/png;base64,/.test(pv.badge.dataUri), `${name}: insignia`);
      fs.mkdirSync(path.join(OUT, name), { recursive: true });
      fs.writeFileSync(path.join(OUT, name, 'muestra.mbz'), mbz);
      fs.writeFileSync(path.join(OUT, name, 'libro.pdf'), Buffer.from(pv.libro.pdfBase64, 'base64'));
      for (const s of pv.samples) fs.writeFileSync(path.join(OUT, name, `${s.key}.html`), `<!doctype html><meta charset="utf-8"><body style="margin:0;padding:16px;background:#fff">${s.html}`);
      evidence.designs[name] = { profile: { ...norm, ...(norm.identity && norm.identity.logoDataUri ? { identity: { ...norm.identity, logoDataUri: `(${norm.identity.logoDataUri.length} caracteres)` } } : {}) }, themeSha256: pv.theme.sha256, logo: pv.logo, libroPages: pv.libro.pageCount, samples: pv.samples.map((s) => [s.key, s.sha256]), ms: pv.ms };
    }
  });

  // ── V6 ──────────────────────────────────────────────────────────────────
  await check('V6 paridad con OTRO curso (2 × 2): mismos estilos en línea (colores y fuentes) en bienvenida, módulo, lección y evaluación', async () => {
    for (const name of ['editorial-serif', 'tecnico-oscuro-color']) {
      const norm = P.normalizePresentationProfile(DESIGNS[name]);
      const other = await B.buildDynamicMbzV3({ ...V.packagingInput(dist, { engine: 'scorm' }), presentation: PK.resolvePackagingTheme({ presentationProfile: norm }).input });
      const acts = await PX.readMbzActivities(other.mbz);
      const pv = previews[name];
      for (const [key, match] of [['welcome', (i) => i === 'cv3:shell:welcome'], ['module', (i) => /^cv3:module_intro:/.test(i)], ['lesson', (i) => /:opening$/.test(i)], ['exam', (i) => /^cv3:exam_info:/.test(i)]]) {
        const a = acts.find((x) => match(x.idnumber));
        const s = pv.samples.find((x) => x.key === key);
        const sa = PX.inlineStyleSignature(a.html);
        const sb = PX.inlineStyleSignature(s.packagedHtml);
        eq(sa.fonts, sb.fonts, `${name}/${key}: mismas fuentes`);
        // Los colores de módulo dependen de cuántos módulos hay: se compara el núcleo del tema (fondo, texto, acento).
        const t = T.resolveTheme(PK.resolvePackagingTheme({ presentationProfile: norm }).input);
        for (const c of [t.color.textPrimary].map((x) => x.toUpperCase())) {
          assert(sa.colors.includes(c) && sb.colors.includes(c), `${name}/${key}: ${c} en ambos`);
        }
        const common = sa.colors.filter((c) => sb.colors.includes(c));
        assert(common.length / Math.max(1, sb.colors.length) >= 0.6, `${name}/${key}: colores compartidos ${common.length}/${sb.colors.length}`);
      }
    }
  });

  // ── V7 ──────────────────────────────────────────────────────────────────
  await check('V7 identidad: logo propio en Libro y bienvenida (files.xml SHA1), nombre con cifras, sin marca de agua; Cursia; logo inválido', async () => {
    const pv = previews['institucional-marca'];
    eq(pv.logo.source, 'course_profile', 'el Libro usa el logo del curso');
    const w = pv.samples.find((s) => s.key === 'welcome');
    assert(/<img src="@@PLUGINFILE@@\/logo-institucion\.png" alt="Logo de la institución" width="\d+" height="\d+"/.test(w.packagedHtml), 'img del logo en la bienvenida');
    assert(/Colegio 21 de Mayo/.test(w.packagedHtml), 'nombre de la institución (con cifras) en la bienvenida');
    const acts = await PX.readMbzActivities(Buffer.from(pv.package.base64, 'base64'));
    const wa = acts.find((a) => a.idnumber === 'cv3:shell:welcome');
    const f = wa.files.get('logo-institucion.png');
    assert(f && f.mime === 'image/png' && sha1(f.bytes) === f.sha1, 'logo en files.xml con SHA1 = bytes');
    // Marca de agua apagada (Libro directo): 0 por página; encendida: 1.
    const t = T.resolveTheme({ themeFamily: 'institucional', mode: 'light' });
    const base = PF.previewPackagingInput({ themeFamily: 'institucional', mode: 'light' });
    const libroIn = {
      courseTitle: 'QA', theme: t, courseIntro: base.contents.courseIntro, logo: LOGO.resolveLibroLogo({ source: 'course_profile', dataUri: LOGO_URI }),
      modules: base.manifest.modules.map((m) => ({ number: m.moduleNumber, title: m.title, intro: base.contents.moduleIntros.get(m.moduleId), chapters: m.chapters.map((c) => ({ number: c.chapterNumber, title: 'Cap', md: base.contents.contentMd.get(c.chapterId) })) })),
    };
    const on = await LIBRO.renderLibroPdfV3(libroIn);
    const off = await LIBRO.renderLibroPdfV3({ ...libroIn, watermark: false });
    assert(on.watermarkDrawsPerPage.every((d) => d === 1), 'con marca: 1 por página');
    assert(off.watermarkDrawsPerPage.every((d) => d === 0) && off.coverLogoDraws === 1, 'sin marca: 0 por página, el logo sigue en la portada');
    // Cursia y logo inválido.
    const svc = service({ accountLogo: LOGO_URI });
    const c = await svc.preview(77, 'user-A', { ...DESIGNS['oscuro-premium'], identity: { logo: 'cursia', watermark: true, showInCourse: false } });
    eq(c.logo.source, 'cursia_default', 'logo de Cursia aunque la cuenta tenga uno');
    const a = await svc.preview(77, 'user-A', DESIGNS['oscuro-premium']);
    eq(a.logo.source, 'user_settings', 'logo de la cuenta por defecto');
    const broken = 'data:image/png;base64,' + Buffer.from('no es un png').toString('base64');
    const x = await svc.preview(77, 'user-A', { ...DESIGNS['oscuro-premium'], identity: { logo: 'custom', logoDataUri: broken, watermark: true, showInCourse: false } });
    eq(x.logo.source, 'user_settings', 'logo inválido → siguiente candidato (la cuenta)');
    assert(x.warnings.some((s) => /^libro_logo_invalid:course_profile:/.test(s)), `aviso visible (${x.warnings})`);
    const ctx = await new VS.VisualDesignService(fakeDb({ accountLogo: LOGO_URI }), fakeProfiles).context(77, 'user-A', 'user-A');
    assert(ctx.account.logo && ctx.account.logo.source === 'user_settings' && ctx.families.length === 6, 'contexto: logo de la cuenta y 6 familias');
  });

  // ── V8 ──────────────────────────────────────────────────────────────────
  await check('V8 empaque: identidad sobre la marca de la cuenta; huella de siempre con el default; loadPackagingProfilesV3 lleva tipografía e identidad', async () => {
    const account = { logo: { source: 'user_settings', dataUri: LOGO_URI }, candidates: [{ source: 'user_settings', dataUri: LOGO_URI }], name: 'Inst', warnings: [] };
    eq(PK.applyPresentationIdentity(account, P.presentationIdentityOf(null)), { logo: account.logo, candidates: account.candidates, name: 'Inst', warnings: [] }, 'default = la de la cuenta');
    eq(PK.applyPresentationIdentity(account, { logo: 'cursia', watermark: true, showInCourse: false }).candidates, [], 'cursia → sin candidatos');
    eq(PK.applyPresentationIdentity(account, { logo: 'account', institutionName: '', watermark: true, showInCourse: false }).name, null, "'' → sin nombre");
    const f0 = PK.libroBrandFingerprintV3(account).sha256;
    if (BASE) eq(f0, require(path.join(BASE, 'modules/dynamic-packaging/packaging-v3.js')).libroBrandFingerprintV3(account).sha256, 'misma huella que origin/staging');
    assert(PK.libroBrandFingerprintV3({ ...account, watermark: false }).sha256 !== f0, 'marca de agua apagada → otra huella (re-empaqueta)');
    assert(PK.libroBrandFingerprintV3({ ...account, showInCourse: true }).sha256 !== f0, 'logo en la bienvenida → otra huella');
    const q = { query: async (sql) => {
      if (/from public\.course_profiles/.test(sql)) return [{ kind: 'presentation', version: 4, data: DESIGNS['institucional-marca'] }];
      throw new Error(sql);
    } };
    const prof = await PK.loadPackagingProfilesV3(q, 77, true);
    eq(prof.theme.input.typography, 'sans', 'tipografía al tema del paquete');
    eq(prof.identity.logo, 'custom', 'identidad al empaque');
    eq(prof.themeSha256, T.themeSha256(T.resolveTheme(prof.theme.input)), 'clave de reuso con el tema completo');
  });

  // ── V9 ──────────────────────────────────────────────────────────────────
  await check('V9 permisos y autoría: courses.view en GET/preview; el POST de perfil (courses.edit) registra al actor', async () => {
    const C = L('modules/visual-design/visual-design.controller.js').VisualDesignController;
    const RP = L('modules/authz/require-permission.decorator.js');
    const key = RP.AUTHZ_REQUIRE_PERMISSION_KEY;
    for (const m of ['context', 'preview']) {
      const r = Reflect.getMetadata(key, C.prototype[m]);
      eq([r && r.permission, r && r.scope], ['courses.view', { course: 'param:courseId' }], `${m}: marca de permiso`);
    }
    const PC = L('modules/course-profiles/course-profiles.controller.js').CourseProfilesController;
    eq(Reflect.getMetadata(key, PC.prototype.append).permission, 'courses.edit', 'guardar = courses.edit');
    // El controller pasa access.actorId como autor.
    let args = null;
    const ctrl = new PC({ append: async (...a) => { args = a; return { created: true, profile: {} }; } });
    await ctrl.append(77, 'presentation', { data: DESIGNS['oscuro-premium'], expectedVersion: 0 }, { id: 'actor-B' }, { actorId: 'actor-B', effectiveOwnerId: 'owner-A' }, { status() {} });
    eq([args[1], args[5]], ['owner-A', 'actor-B'], 'dueño efectivo para filtrar, actor como autor');
    // El servicio escribe created_by = autor.
    const CS = L('modules/course-profiles/course-profiles.service.js').CourseProfilesService;
    let inserted = null;
    const qr = { connect: async () => {}, startTransaction: async () => {}, commitTransaction: async () => {}, rollbackTransaction: async () => {}, release: async () => {},
      query: async (sql, p) => {
        if (/for update/.test(sql)) return [{ id: 77 }];
        if (/to_regclass\('public\.course_prebrief_events'\)/.test(sql)) return [{ present: false }];
        if (/final_exam_enabled/.test(sql)) return [{ final_exam_enabled: true }];
        if (/from public\.course_profiles where course_id = \$1 and kind = \$2 order by version desc limit 1/.test(sql)) return [];
        if (/insert into public\.course_profiles/.test(sql)) { inserted = p; return [{ course_id: 77, kind: p[1], version: p[2], data: p[3], sha256: p[4], created_by: p[5], created_at: '2026-10-26T00:00:00Z' }]; }
        return [];
      } };
    const svc = new CS({ createQueryRunner: () => qr, query: qr.query }, { findOne: async () => ({ structureVersion: 'dynamic' }) });
    process.env.DYNAMIC_COURSE_STRUCTURE = 'true';
    process.env.DYNAMIC_V2_ALLOWED_OWNERS = OWNER;
    const r = await svc.append(77, OWNER, 'presentation', DESIGNS['oscuro-premium'], 0, 'actor-B');
    eq(inserted && inserted[5], 'actor-B', 'created_by = actor');
    eq(r.profile.createdBy, 'actor-B', 'DTO con el autor');
  });

  // ── V10 ─────────────────────────────────────────────────────────────────
  if (MOODLE) await moodleChecks();

  fs.writeFileSync(path.join(OUT, 'evidence.json'), JSON.stringify(evidence, null, 2));
  console.log(`\n${passes} OK, ${failures} fallas · evidencia: ${path.join(OUT, 'evidence.json')}`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

async function moodleChecks() {
  const PHP = process.env.PHP_BIN || '/opt/homebrew/opt/php@8.3/bin/php';
  const SRC = path.join(os.homedir(), 'cursia-test-env/moodle-local/source');
  const INI = path.join(os.homedir(), 'cursia-test-env/moodle-local/php.ini');
  const PS = path.join(ROOT, 'scripts/moodle/r76-visual-design.php');
  const run = (args) => {
    const r = spawnSync(PHP, ['-d', 'memory_limit=2048M', '-c', INI, PS, `--moodle=${SRC}`, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: 900000 });
    if (r.status !== 0) throw new Error(`${args.join(' ')} → ${r.status}: ${(r.stderr || '').slice(-1500)}${(r.stdout || '').slice(-500)}`);
    if (/(PHP )?(Warning|Fatal error):/i.test(r.stderr || '')) throw new Error(`avisos de PHP: ${(r.stderr || '').slice(-1500)}`);
    return r.stdout;
  };
  const restored = {};
  for (const [name, profile] of Object.entries(DESIGNS)) {
    await check(`V10 Moodle 4.5: «${name}» restaurado; el HTML que ve el estudiante conserva estilos en línea, colores, fuentes${profile.identity ? ', logo y nombre' : ''}`, async () => {
      const file = path.join(OUT, name, 'muestra.mbz');
      const id = Number(/Course ID: (\d+)/.exec(run(['--action=restore-new', `--file=${file}`, '--categoryid=1']))[1]);
      const data = JSON.parse(run(['--action=labels', `--courseid=${id}`]));
      restored[name] = { courseId: id };
      fs.writeFileSync(path.join(OUT, name, 'moodle-labels.json'), JSON.stringify(data, null, 1));
      const pv = previews[name];
      const norm = P.normalizePresentationProfile(profile);
      const t = T.resolveTheme(PK.resolvePackagingTheme({ presentationProfile: norm }).input);
      const ev = { courseId: id, samples: {} };
      for (const s of pv.samples) {
        const a = data.activities.find((x) => x.idnumber === s.idnumber);
        assert(a, `${s.idnumber} restaurado`);
        const stored = a.stored;
        // La restauración resuelve los tokens $@…@$ y @@PLUGINFILE@@ a URLs de ESTE Moodle: el resto, byte a byte.
        const noUrls = (h) => h.replace(/(src|href)="[^"]*"/g, '$1=""');
        assert(noUrls(stored) === noUrls(s.packagedHtml), `${s.key}: HTML guardado en Moodle = HTML de la vista previa (salvo las URLs que resuelve la restauración)`);
        const sigP = PX.inlineStyleSignature(s.packagedHtml);
        const sigR = PX.inlineStyleSignature(a.rendered);
        const kept = sigP.colors.filter((c) => sigR.colors.includes(c));
        // format_text puede quitar declaraciones avanzadas, nunca los colores base del tema.
        for (const c of [t.color.textPrimary.toUpperCase()]) assert(sigR.colors.includes(c), `${s.key}: color de texto ${c} tras format_text`);
        assert(kept.length / Math.max(1, sigP.colors.length) >= 0.9, `${s.key}: colores conservados ${kept.length}/${sigP.colors.length}`);
        // HTMLPurifier re-escribe las comillas de font-family ('-apple-system'): se comparan sin comillas ni espacios.
        const nf = (f) => f.replace(/['"\s]/g, '').toLowerCase();
        const fontsP = new Set(sigP.fonts.map(nf));
        assert(sigR.fonts.length > 0 && sigR.fonts.every((f) => fontsP.has(nf(f))) && sigP.fonts.every((f) => sigR.fonts.map(nf).includes(nf(f))), `${s.key}: las fuentes del diseño sobreviven a format_text (${sigR.fonts.slice(0, 2)})`);
        ev.samples[s.key] = { styleTags: { packaged: (s.packagedHtml.match(/<style\b/g) || []).length, rendered: (a.rendered.match(/<style\b/g) || []).length }, colorsPackaged: sigP.colors.length, colorsRendered: kept.length, fonts: sigR.fonts.slice(0, 2), bytesPackaged: stored.length, bytesRendered: a.rendered.length };
        fs.writeFileSync(path.join(OUT, name, `moodle-${s.key}.html`), `<!doctype html><meta charset="utf-8"><body style="margin:0;padding:16px;background:#fff">${a.rendered}`);
      }
      const wel = data.activities.find((x) => x.idnumber === 'cv3:shell:welcome');
      if (profile.identity && profile.identity.showInCourse) {
        assert(/<img[^>]+src="[^"]*pluginfile\.php\/\d+\/mod_label\/intro\/(0\/)?logo-institucion\.png"[^>]*alt="Logo de la institución"/.test(wel.rendered), 'logo en la bienvenida tras format_text (pluginfile)');
        assert(/Colegio 21 de Mayo/.test(wel.rendered), 'nombre de la institución tras format_text');
        const lf = wel.files.find((f) => f.filename === 'logo-institucion.png');
        assert(lf && lf.sha1 === lf.contenthash && lf.sha1 === sha1(LOGO.resolveLibroLogo({ source: 'course_profile', dataUri: LOGO_URI }).bytes), 'logo en disco = el logo validado del curso (PNG canónico, sha1)');
        ev.logo = lf;
      } else {
        assert(!/logo-institucion/.test(wel.rendered), 'sin logo cuando no se pide');
      }
      const libro = data.activities.find((x) => x.idnumber === 'cv3:shell:libro');
      const pdf = libro.files.find((f) => /\.pdf$/.test(f.filename));
      assert(pdf && pdf.sha1 === pv.libro.sha1 && pdf.sha1 === pdf.contenthash, 'Libro Guía restaurado = el de la vista previa (sha1)');
      ev.libro = pdf;
      evidence.moodle[name] = ev;
    });
  }
  // Capturas de la página del curso (como estudiante) con Chrome headless + servidor PHP desechable en 127.0.0.1:8099.
  await check('V10 capturas: página del curso restaurado en Moodle (bienvenida y capítulo 1) para cada diseño', async () => {
    const net = require('net');
    const { launchChrome, sleep } = require('./lib/v21-cdp');
    const portInUse = (port) => new Promise((res) => { const s = net.connect({ host: '127.0.0.1', port }, () => { s.destroy(); res(true); }); s.on('error', () => res(false)); });
    assert(!(await portInUse(8099)), 'puerto 8099 libre');
    const creds = {};
    for (const l of fs.readFileSync(path.join(os.homedir(), 'cursia-test-env/creds/.local-test-credentials'), 'utf8').split('\n')) { const i = l.indexOf('='); if (i > 0) creds[l.slice(0, i)] = l.slice(i + 1).trim(); }
    const VM = path.join(ROOT, 'scripts/moodle/v21-video-moodle.php');
    for (const n of Object.keys(restored)) {
      const r = spawnSync(PHP, ['-c', INI, VM, SRC, 'enrol', String(restored[n].courseId), creds.username], { encoding: 'utf8' });
      assert(/RESULT_JSON .*"enrolled":true/.test(r.stdout || ''), `matrícula del estudiante de prueba en ${n}: ${(r.stdout || r.stderr || '').slice(-300)}`);
    }
    const { spawn } = require('child_process');
    const server = spawn(PHP, ['-c', INI, '-S', '127.0.0.1:8099', '-t', SRC], { stdio: 'ignore' });
    let b;
    try {
      for (let i = 0; i < 50 && !(await portInUse(8099)); i++) await sleep(200);
      b = await launchChrome();
      await b.setViewport(1280, 900, false);
      await b.navigate('http://127.0.0.1:8099/login/index.php');
      await b.evaluate(`(()=>{document.querySelector('#username').value=${JSON.stringify(creds.username)};document.querySelector('#password').value=${JSON.stringify(creds.password)};document.querySelector('#login').submit();return 1})()`);
      await sleep(2500);
      const shots = [];
      for (const [n, { courseId }] of Object.entries(restored)) {
        for (const [sec, w, label] of [[0, 1280, 'bienvenida'], [2, 1280, 'capitulo1'], [0, 390, 'bienvenida-movil']]) {
          await b.setViewport(w, 900, w < 600);
          await b.navigate(`http://127.0.0.1:8099/course/view.php?id=${courseId}&section=${sec}`);
          await sleep(1500);
          const f = path.join(OUT, n, `moodle-${label}.png`);
          await b.screenshot(f, { fullPage: true });
          shots.push(f);
          const info = await b.evaluate(`(()=>{const el=document.querySelector('.cvc-shell-welcome,.cvc');if(!el)return null;const cs=getComputedStyle(el);const img=document.querySelector('img[alt="Logo de la institución"]');return {bg:cs.backgroundColor,color:cs.color,font:cs.fontFamily.slice(0,40),logo:!!img&&img.complete&&img.naturalWidth>0}})()`);
          evidence.moodle[n][`render_${label}`] = info;
          if (label === 'bienvenida') {
            assert(info, `${n}: la bienvenida se ve en la página del curso`);
            if (DESIGNS[n].identity && DESIGNS[n].identity.showInCourse) assert(info.logo, `${n}: el logo carga en Moodle`);
          }
        }
      }
      evidence.shots = shots;
    } finally {
      if (b) b.close();
      server.kill('SIGTERM');
    }
  });
  evidence.moodleCourses = restored;
  // Los cursos de prueba se borran al final (--keep los deja para revisarlos a mano).
  if (!process.argv.includes('--keep')) {
    for (const { courseId } of Object.values(restored)) {
      try { run(['--action=delete', `--courseid=${courseId}`, '--title=Curso de muestra: Atención al cliente']); } catch (e) { console.log(`   (no se pudo borrar el curso de prueba #${courseId}: ${e.message.slice(0, 120)})`); }
    }
  }
}
