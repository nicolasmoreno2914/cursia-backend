/* eslint-disable */
// r77 — «Mobile-first»: medición EN EL NAVEGADOR de los materiales hechos por Cursia (Chrome headless por CDP o
// Playwright Chromium/WebKit). Sin dependencias: `MEASURE_SOURCE` es una función que se evalúa en la página.
//
// Alcance «Cursia»: cada raíz `.cvc` (labels, páginas y tarjetas del empaque). Lo demás (cabecera de Moodle, índice
// del curso, reproductor H5P, motor de exámenes, reproductor SCORM) se mide aparte como «Moodle» (no lo arregla Cursia).
//
// Por raíz `.cvc`:
//   overflow   elementos o texto (rangos de cada nodo de texto: palabras y URLs largas) que salen del ancho de la raíz o
//              de la ventana, imágenes deformadas (proporción ≠ la natural), iframes / audio / video más anchos
//   fonts      tamaño mínimo de cualquier texto (falla < 12 px) y del texto corrido (p, li, td, dd: falla < 16 px)
//   lineHeight interlineado del texto corrido (aviso < 1,4)
//   contrast   cada texto contra su fondo efectivo (AA: 4,5:1; 3:1 si es grande); fondo con imagen/degradado = sin medir
//   targets    enlaces y controles de Cursia que NO están dentro de un párrafo (botones/CTA): ≥ 44 × 44 px; solapes
// Página:      document.scrollWidth > clientWidth (desborde de toda la página) y quién lo causa (Cursia o Moodle).
'use strict';

function measurePage(opts) {
  opts = opts || {};
  const MIN_TARGET = opts.minTarget || 44;
  const vw = document.documentElement.clientWidth;
  const out = { vw, dpr: window.devicePixelRatio, ua: navigator.userAgent.slice(0, 80), roots: [], page: {} };
  const de = document.documentElement;
  out.page.scrollWidth = Math.max(de.scrollWidth, document.body ? document.body.scrollWidth : 0);
  out.page.clientWidth = de.clientWidth;
  out.page.overflowX = out.page.scrollWidth > out.page.clientWidth + 1;
  // ── utilidades ──
  const parseColor = (s) => {
    const m = /rgba?\(([^)]+)\)/.exec(s || '');
    if (!m) return null;
    const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const lum = (c) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const blend = (top, under) => ({ r: top.r * top.a + under.r * (1 - top.a), g: top.g * top.a + under.g * (1 - top.a), b: top.b * top.a + under.b * (1 - top.a), a: 1 });
  function effectiveBg(el) {
    const layers = [];
    for (let e = el; e; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.backgroundImage && cs.backgroundImage !== 'none') return { unknown: true, by: e.tagName.toLowerCase() };
      const c = parseColor(cs.backgroundColor);
      if (c && c.a > 0) { layers.push(c); if (c.a >= 1) break; }
    }
    let bg = { r: 255, g: 255, b: 255, a: 1 };
    for (let i = layers.length - 1; i >= 0; i--) bg = blend(layers[i], bg);
    return bg;
  }
  const visible = (el) => {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const isCvc = (e) => !!(e && e.classList && Array.from(e.classList).some((c) => c === 'cvc' || c.indexOf('cvc-') === 0));
  const cvcAncestor = (e) => { for (let p = e && e.parentElement; p; p = p.parentElement) if (isCvc(p)) return p; return null; };
  const path = (el) => {
    const parts = [];
    for (let e = el; e && e.nodeType === 1 && parts.length < 4; e = e.parentElement) {
      let s = e.tagName.toLowerCase();
      const cls = (e.getAttribute('class') || '').split(/\s+/).filter((c) => c && c.indexOf('cvc') === 0).slice(0, 2);
      if (cls.length) s += '.' + cls.join('.');
      parts.unshift(s);
      if (isCvc(e) && !cvcAncestor(e)) break;
    }
    return parts.join('>');
  };
  const snippet = (t) => (t || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  // Ancestro más cercano DENTRO de la raíz de Cursia (Moodle envuelve cada actividad en un <li class="activity">).
  const closestIn = (el, sel, root) => { const x = el.closest(sel); return x && root.contains(x) ? x : null; };
  const isRunning = (el, root) => !!closestIn(el, 'p,li,td,th,dd,blockquote,figcaption', root) && !closestIn(el, '.cvc-meta,.cvc-kicker,.cvc-caption,small,sup,sub', root);
  // Raíz Cursia = primer elemento con una clase `cvc` / `cvc-…` (labels del shell y de R2: `cvc`; tarjetas de actividad: `cvc-act`).
  const roots = Array.from(document.querySelectorAll('[class*="cvc"]')).filter((r) => isCvc(r) && !cvcAncestor(r));
  // Lo que Moodle pone DENTRO de un label de Cursia (reproductor multimedia de Moodle: Video.js / mediaplugin) es de Moodle.
  const EXCL = opts.excludeSelector || '.mediaplugin,.video-js';
  const excluded = (el) => !!(el && el.closest && el.closest(EXCL));
  const sel = opts.rootSelector ? Array.from(document.querySelectorAll(opts.rootSelector)) : null;
  for (const root of sel || roots) {
    if (!visible(root)) continue;
    const rr = root.getBoundingClientRect();
    const right = Math.min(rr.right, vw);
    const left = Math.max(rr.left, 0);
    const rep = {
      cls: (root.getAttribute('class') || '').split(/\s+/).slice(0, 4).join(' '),
      id: root.closest('[id^="module-"]') ? root.closest('[id^="module-"]').id : null,
      key: root.closest('[data-r77]') ? root.closest('[data-r77]').getAttribute('data-r77') : null,
      width: Math.round(rr.width), styleTags: root.querySelectorAll('style').length,
      overflow: [], fonts: { min: 99, minRunning: 99, small: [], tiny: [], runningSmall: [] }, lineHeight: [], contrast: [], contrastUnknown: 0, targets: [], targetIssues: [], images: [], moodleMedia: [],
    };
    // Desborde de elementos (y de medios)
    const els = [root, ...root.querySelectorAll('*')];
    for (const el of els) {
      if (el.tagName === 'STYLE' || el.tagName === 'SCRIPT' || el.tagName === 'BR') continue;
      if (excluded(el)) { if (el.matches(EXCL) && !rep.moodleMedia.includes(el.className.split(' ')[0])) rep.moodleMedia.push(el.className.split(' ')[0]); if (!el.matches(EXCL)) continue; }
      if (!visible(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.right > right + 1.5 || r.left < left - 1.5) {
        // Solo el más externo de cada rama (el hijo que se sale ya lo explica el padre).
        const parentOut = rep.overflow.find((o) => o.el && o.el.contains(el));
        if (!parentOut) rep.overflow.push({ el, kind: 'element', tag: el.tagName.toLowerCase(), path: path(el), by: Math.round(Math.max(r.right - right, left - r.left)), text: snippet(el.textContent) });
      }
      if (el.tagName === 'IMG' && el.naturalWidth) {
        const ar = el.naturalWidth / el.naturalHeight;
        const got = r.width / r.height;
        const img = { src: (el.getAttribute('src') || '').split('/').pop().slice(0, 40), w: Math.round(r.width), h: Math.round(r.height), natural: [el.naturalWidth, el.naturalHeight], distorted: Math.abs(got / ar - 1) > 0.03 };
        rep.images.push(img);
        if (img.distorted) rep.overflow.push({ kind: 'image_distorted', tag: 'img', path: path(el), by: 0, text: `${img.w}×${img.h} (natural ${img.natural.join('×')})` });
      }
    }
    // Desborde de TEXTO (palabras o direcciones largas que no cortan) — rectángulos de cada nodo de texto.
    const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    let n;
    const seenText = new Set();
    while ((n = tw.nextNode())) {
      if (!n.nodeValue.trim()) continue;
      const pe = n.parentElement;
      if (!pe || pe.closest('style,script') || excluded(pe) || !visible(pe)) continue;
      range.selectNodeContents(n);
      for (const q of range.getClientRects()) {
        if (q.width > 0 && (q.right > right + 1.5 || q.left < left - 1.5)) {
          const k = path(pe) + snippet(n.nodeValue);
          if (!seenText.has(k)) { seenText.add(k); rep.overflow.push({ kind: 'text', tag: pe.tagName.toLowerCase(), path: path(pe), by: Math.round(Math.max(q.right - right, left - q.left)), text: snippet(n.nodeValue) }); }
          break;
        }
      }
      // Tipografía y contraste por nodo de texto
      const cs = getComputedStyle(pe);
      const fs = parseFloat(cs.fontSize);
      rep.fonts.min = Math.min(rep.fonts.min, fs);
      const running = isRunning(pe, root);
      if (running) rep.fonts.minRunning = Math.min(rep.fonts.minRunning, fs);
      if (fs < 12) rep.fonts.tiny.push({ fs, path: path(pe), text: snippet(n.nodeValue) });
      else if (fs < 14) rep.fonts.small.push({ fs, path: path(pe), text: snippet(n.nodeValue) });
      if (running && fs < 16 && n.nodeValue.trim().length > 20) rep.fonts.runningSmall.push({ fs, path: path(pe), text: snippet(n.nodeValue) });
      if (running && n.nodeValue.trim().length > 40) {
        const lh = cs.lineHeight === 'normal' ? 1.2 : parseFloat(cs.lineHeight) / fs;
        if (lh < 1.4) rep.lineHeight.push({ lh: Math.round(lh * 100) / 100, path: path(pe) });
      }
      const fg = parseColor(cs.color);
      const bg = effectiveBg(pe);
      if (!fg || bg.unknown) { rep.contrastUnknown++; continue; }
      const c = ratio(fg.a < 1 ? blend(fg, bg) : fg, bg);
      const large = fs >= 24 || (fs >= 18.66 && Number(cs.fontWeight) >= 700);
      const need = large ? 3 : 4.5;
      if (c + 0.005 < need) rep.contrast.push({ ratio: Math.round(c * 100) / 100, need, fs, path: path(pe), text: snippet(n.nodeValue) });
    }
    // Áreas táctiles: enlaces/controles «botón» (no los enlaces dentro de un párrafo de texto).
    const ctrls = Array.from(root.querySelectorAll('a[href],button,input,select,textarea,summary,audio[controls],video[controls]')).filter((a) => visible(a) && !excluded(a));
    const rects = [];
    for (const a of ctrls) {
      const r = a.getBoundingClientRect();
      const block = closestIn(a, 'p,li,td,dd,blockquote', root);
      const inline = a.tagName === 'A' && block && (block.textContent || '').trim().length > (a.textContent || '').trim().length + 3;
      const t = { tag: a.tagName.toLowerCase(), w: Math.round(r.width), h: Math.round(r.height), text: snippet(a.textContent || a.getAttribute('aria-label') || ''), inline, path: path(a) };
      rep.targets.push(t);
      if (!inline && (r.width < MIN_TARGET - 0.5 || r.height < MIN_TARGET - 0.5)) rep.targetIssues.push({ ...t, issue: 'small' });
      if (!inline) rects.push([r, t]);
    }
    for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
      const [a, ta] = rects[i];
      const [b, tb] = rects[j];
      const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (ox > 1 && oy > 1) rep.targetIssues.push({ ...ta, issue: 'overlap', with: tb.text });
    }
    rep.overflow = rep.overflow.map(({ el, ...o }) => o);
    if (rep.fonts.min === 99) rep.fonts.min = null;
    if (rep.fonts.minRunning === 99) rep.fonts.minRunning = null;
    rep.fonts.small = rep.fonts.small.slice(0, 6);
    rep.fonts.tiny = rep.fonts.tiny.slice(0, 6);
    rep.fonts.runningSmall = rep.fonts.runningSmall.slice(0, 6);
    rep.contrast = rep.contrast.slice(0, 8);
    out.roots.push(rep);
  }
  // Desborde de la página: quién lo causa (elementos de primer nivel que salen de la ventana).
  if (out.page.overflowX) {
    const culprits = [];
    for (const el of document.body.querySelectorAll('*')) {
      if (culprits.length >= 8) break;
      if (!visible(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.right > vw + 1.5) {
        if (culprits.some((c) => c.el.contains(el))) continue;
        let clipped = false;
        for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
          const o = getComputedStyle(p).overflowX;
          if (o === 'hidden' || o === 'auto' || o === 'scroll' || o === 'clip') { if (p.getBoundingClientRect().right <= vw + 1.5) { clipped = true; break; } }
        }
        if (!clipped) culprits.push({ el, tag: el.tagName.toLowerCase(), cls: (el.getAttribute('class') || '').slice(0, 60), id: el.id || null, cursia: isCvc(el) || !!cvcAncestor(el), by: Math.round(r.right - vw) });
      }
    }
    out.page.culprits = culprits.map(({ el, ...c }) => c);
  }
  return out;
}

/** Veredicto PASS/FAIL de una raíz (y motivos). `strictRunning`: texto corrido ≥ 16 px. */
function verdictOfRoot(r) {
  const fails = [];
  const warns = [];
  if (r.overflow.length) fails.push(`desborde: ${r.overflow.slice(0, 3).map((o) => `${o.kind} ${o.path} +${o.by}px «${o.text}»`).join(' | ')}`);
  if (r.fonts.tiny.length) fails.push(`texto < 12 px: ${r.fonts.tiny.slice(0, 2).map((f) => `${f.fs}px ${f.path}`).join(' | ')}`);
  if (r.fonts.runningSmall.length) fails.push(`texto corrido < 16 px: ${r.fonts.runningSmall.slice(0, 2).map((f) => `${f.fs}px ${f.path} «${f.text}»`).join(' | ')}`);
  if (r.contrast.length) fails.push(`contraste: ${r.contrast.slice(0, 2).map((c) => `${c.ratio}:1 < ${c.need} ${c.path} «${c.text}»`).join(' | ')}`);
  const small = r.targetIssues.filter((t) => t.issue === 'small');
  if (small.length) fails.push(`áreas táctiles < 44 px: ${small.slice(0, 3).map((t) => `${t.tag} ${t.w}×${t.h} «${t.text}»`).join(' | ')}`);
  const ov = r.targetIssues.filter((t) => t.issue === 'overlap');
  if (ov.length) fails.push(`áreas táctiles solapadas: ${ov.slice(0, 2).map((t) => `«${t.text}» / «${t.with}»`).join(' | ')}`);
  if (r.lineHeight.length) warns.push(`interlineado < 1,4: ${r.lineHeight.slice(0, 2).map((l) => `${l.lh} ${l.path}`).join(' | ')}`);
  if (r.fonts.small.length) warns.push(`texto de 12–13 px: ${r.fonts.small.slice(0, 2).map((f) => `${f.fs}px ${f.path} «${f.text}»`).join(' | ')}`);
  return { pass: fails.length === 0, fails, warns };
}

const MEASURE_SOURCE = measurePage.toString();
/** Expresión para Runtime.evaluate / page.evaluate (string). */
const measureExpr = (opts) => `(${MEASURE_SOURCE})(${JSON.stringify(opts || {})})`;

// ── Aproximación del purificador de Moodle (HTMLPurifier de Moodle 4.5, `CSS.AllowTricky`/`Proprietary` apagados) ──
// La verdad la da el Moodle local (`--moodle`); esto solo sirve para gate-core (sin PHP). Propiedades BASE de
// HTMLPurifier_CSSDefinition (las «tricky» display/overflow/position/visibility/opacity/top… y las propietarias
// border-radius/filter… se quitan); funciones calc()/min()/max()/clamp()/var() no son longitudes válidas; en <img>,
// width/height/max-*/min-* solo aceptan px ≤ 1200 o auto (sin %).
const PURIFIER_BASE_PROPS = new Set(['background', 'background-attachment', 'background-color', 'background-image', 'background-position', 'background-repeat', 'background-size', 'border', 'border-bottom', 'border-bottom-color', 'border-bottom-style', 'border-bottom-width', 'border-collapse', 'border-color', 'border-left', 'border-left-color', 'border-left-style', 'border-left-width', 'border-right', 'border-right-color', 'border-right-style', 'border-right-width', 'border-spacing', 'border-style', 'border-top', 'border-top-color', 'border-top-style', 'border-top-width', 'border-width', 'caption-side', 'clear', 'color', 'float', 'font', 'font-family', 'font-size', 'font-style', 'font-variant', 'font-weight', 'height', 'letter-spacing', 'line-height', 'list-style', 'list-style-image', 'list-style-position', 'list-style-type', 'margin', 'margin-bottom', 'margin-left', 'margin-right', 'margin-top', 'max-height', 'max-width', 'min-height', 'min-width', 'padding', 'padding-bottom', 'padding-left', 'padding-right', 'padding-top', 'table-layout', 'text-align', 'text-decoration', 'text-decoration-color', 'text-decoration-line', 'text-decoration-style', 'text-decoration-thickness', 'text-indent', 'text-transform', 'vertical-align', 'white-space', 'width', 'word-spacing']);
function purifyStyleApprox(style, tag) {
  const keep = [];
  for (const d of style.split(';')) {
    const i = d.indexOf(':');
    if (i < 0) continue;
    const k = d.slice(0, i).trim().toLowerCase();
    const v = d.slice(i + 1).trim();
    if (!PURIFIER_BASE_PROPS.has(k)) continue;
    if (/\b(calc|min|max|clamp|var|env)\(/i.test(v)) continue;
    if (tag === 'img' && /^(width|height|max-width|max-height|min-width|min-height)$/.test(k) && !/^(\d+(\.\d+)?px|auto|none)$/.test(v)) continue;
    keep.push(`${k}:${v}`);
  }
  return keep.join(';');
}
function purifyHtmlApprox(html) {
  return html
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, '')
    .replace(/<iframe\b[\s\S]*?<\/iframe>/gi, '')
    // <details>/<summary>/<button> no existen en XHTML 1.0 Transitional: HTMLPurifier quita la etiqueta y deja el texto.
    .replace(/<\/?(details|summary|button)\b[^>]*>/gi, '')
    .replace(/<(\w+)([^>]*?)\sstyle="([^"]*)"/g, (m, tag, pre, s) => {
      const p = purifyStyleApprox(s.replace(/&quot;/g, '"').replace(/&amp;/g, '&'), tag.toLowerCase());
      return p ? `<${tag}${pre} style="${p.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"` : `<${tag}${pre}`;
    });
}

module.exports = { measurePage, measureExpr, MEASURE_SOURCE, verdictOfRoot, purifyHtmlApprox, purifyStyleApprox, PURIFIER_BASE_PROPS };
