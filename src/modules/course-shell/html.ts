/**
 * R11a — primitivas HTML del shell y de las transiciones del capítulo, con las
 * mismas reglas que el renderer de R2 (§X.1, HD-V21-3):
 *
 *  - CLEAN_SAFE siempre: colores hex resueltos del tema (R1), todo texto con un
 *    `color` elegido para el `background-color` sólido del mismo elemento o de
 *    un ancestro, flujo de bloques, margin/padding/border/tipografía.
 *  - ENHANCED (level 'enhanced'): declaraciones extra DESPUÉS de las seguras
 *    (radius, flex, overflow-wrap) que forceclean descarta sin perder nada.
 *
 * El texto pasa siempre por `inlineHtml`/`multilineInlineHtml` de R2 (escape
 * completo + `**énfasis**` + guiones suaves). Determinista.
 */
import { contrastRatio, ResolvedTheme } from '../theme-engine';
import { HtmlNode, parseHtml } from '../visual-components/lint-output';
import { HYPHEN_HEADING, inlineHtml, labelHtml, richParagraphs } from '../visual-components/text';
import { groundColor, labelRootStyle } from '../visual-components/render';
import { eduStyle, plateJoinStyle } from '../visual-components/runtime';

export type ShellLevel = 'enhanced';

export interface ShellRenderOptions {
  /** Omitido = solo CLEAN_SAFE. */
  level?: ShellLevel;
}

export interface Hx {
  t: ResolvedTheme;
  enh: boolean;
}

export type Decl = [string, string | number];

export interface Surf {
  bg: string;
  fg: string;
  fg2: string;
}

const MIN_CONTRAST = 4.5;
const UID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function shellFail(msg: string): never {
  throw new Error(`SHELL_RENDER: ${msg}`);
}

export function hx(theme: ResolvedTheme, opts?: ShellRenderOptions): Hx {
  if (!theme || !theme.color || !theme.typography) shellFail('tema inválido (se espera un ResolvedTheme de R1)');
  if (opts?.level !== undefined && opts.level !== 'enhanced') shellFail(`level desconocido "${String(opts.level)}"`);
  return { t: theme, enh: opts?.level === 'enhanced' };
}

/** Texto legible sobre `bg` (preferidos → neutros del tema). Falla fuerte si nada llega a 4.5:1. */
export function surfOn(t: ResolvedTheme, bg: string, preferred: string[] = []): Surf {
  const cands = [...preferred, t.color.textPrimary, t.color.textSecondary, t.color.textOnAccent];
  const fg = cands.find((c) => contrastRatio(c, bg) >= MIN_CONTRAST);
  if (!fg) shellFail(`ningún color de texto del tema alcanza ${MIN_CONTRAST}:1 sobre ${bg}`);
  const fg2 = contrastRatio(t.color.textSecondary, bg) >= MIN_CONTRAST ? t.color.textSecondary : fg;
  return { bg, fg, fg2 };
}

function attr(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function st(h: Hx, safe: Decl[], enh: Decl[] = []): string {
  const decls = h.enh ? [...safe, ...enh] : safe;
  return ` style="${attr(decls.map(([k, v]) => `${k}:${typeof v === 'number' ? `${v}px` : v}`).join(';'))}"`;
}

/** Raíz de un label del shell (misma forma que la de R2: `cvc cvc-<uid>`; lámina en familias oscuras, abierta en claras). */
export function root(h: Hx, uid: string, inner: string): string {
  if (!UID_RE.test(uid)) shellFail(`uid inválido "${uid}"`);
  const style = h.enh ? `<style>${shellStyle(uid, h.t)}</style>` : '';
  const plateCls = h.t.personality && h.t.personality.plate ? ' cvc-plate' : '';
  return `<div class="cvc cvc-shell cvc-${uid}${plateCls}" lang="es"` + labelRootStyle(h.t, h.enh) + `>${style}${inner}</div>`;
}

/** R14-A — CSS mínimo del shell (fila de cifras, filas con numeral). Solo ENHANCED. */
function shellStyle(uid: string, t: ResolvedTheme): string {
  const S = `.cvc-${uid}`;
  return [
    `${S}{container-type:inline-size}`,
    t.personality && t.personality.plate ? plateJoinStyle() : '',
    `${S},${S} *{box-sizing:border-box}`,
    `${S}>:last-child{margin-bottom:0!important}`,
    `${S} .cvc-num{white-space:nowrap}`,
    `${S} a{text-underline-offset:.18em}`,
    `${S} .cvc-numrow{display:grid;grid-template-columns:3.5rem minmax(0,1fr);column-gap:12px;align-items:baseline}`,
    `${S} .cvc-numrow .cvc-num{margin:0!important}`,
    `${S} .cvc-btn-wrap{min-height:44px;line-height:1.35}`,
    `${S} a.cvc-btn-link:focus-visible{outline:3px solid ${t.color.accentStrong};outline-offset:6px;border-radius:999px}`,
    `${S} .cvc-facts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px 0}`,
    `${S} .cvc-facts>li{margin:0!important;padding:0 16px 0 0!important}`,
    `${S} .cvc-facts strong,${S} .cvc-facts span{display:block}`,
    `@container (min-width:560px){${S} .cvc-facts{grid-template-columns:repeat(auto-fit,minmax(6.5rem,1fr))}${S} .cvc-facts>li{padding:0 16px!important;border-left:1px solid ${t.color.border}}${S} .cvc-facts>li:first-child{padding-left:0!important;border-left:0}}`,
    `@container (min-width:600px){${S} .cvc-cols2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));column-gap:40px}}`,
    ...eduStyle(S, t.color),
  ].join('\n');
}

export function bgSurf(h: Hx): Surf {
  return surfOn(h.t, groundColor(h.t));
}

/** Superficie de panel (distinta del fondo del label). */
export function panelSurf(h: Hx): Surf {
  return surfOn(h.t, h.t.personality && h.t.personality.plate ? h.t.color.surface : h.t.color.surfaceAlt);
}

function readable(bg: string, cands: string[], fallback: string): string {
  return cands.find((c) => contrastRatio(c, bg) >= MIN_CONTRAST) ?? fallback;
}

export function heading(h: Hx, tag: 'h2' | 'h3' | 'h4', text: string, s: Surf): string {
  const ty = h.t.typography;
  const p = h.t.personality;
  const spec =
    tag === 'h2'
      ? { px: ty.sizeDisplayPx, fl: ty.scale.display, font: p.fontDisplay, w: p.displayWeight, lh: '1.08', ls: '-0.015em', m: '0 0 20px 0' }
      : tag === 'h3'
        ? { px: ty.sizeTitlePx, fl: ty.scale.title, font: ty.fontHeading, w: ty.weightHeading, lh: '1.2', ls: '-0.01em', m: '0 0 16px 0' }
        : { px: ty.sizeItemPx, fl: ty.scale.item, font: ty.fontHeading, w: 600, lh: '1.3', ls: '0', m: '0 0 8px 0' };
  return (
    `<${tag}` +
    st(
      h,
      [
        ['margin', spec.m],
        ['padding', 0],
        ['color', s.fg],
        ['font-family', spec.font],
        ['font-size', spec.px],
        ['font-weight', String(spec.w)],
        ['line-height', spec.lh],
        ['letter-spacing', spec.ls],
      ],
      [['font-size', spec.fl], ['text-wrap', 'balance']],
    ) +
    `>${inlineHtml(text, HYPHEN_HEADING)}</${tag}>`
  );
}

/** Párrafo "lead" (entrada destacada). */
export function lead(h: Hx, text: string, s: Surf, opts: { last?: boolean } = {}): string {
  const ty = h.t.typography;
  const ps = richParagraphs(text);
  return ps
    .map(
      (p, i) =>
        `<p${st(
          h,
          [
            ['margin', i === ps.length - 1 && opts.last ? '0' : '0 0 16px 0'],
            ['padding', 0],
            ['color', s.fg],
            ['font-size', ty.sizeLeadPx],
            ['line-height', '1.5'],
            ['max-width', '60ch'],
          ],
          [['font-size', ty.scale.lead]],
        )}>${p}</p>`,
    )
    .join('');
}

/** Filete de acento (48 × 3 px). */
export function accentRule(h: Hx, s: Surf): string {
  const col = readable(s.bg, [h.t.color.accent, h.t.color.accentStrong], h.t.color.borderStrong);
  return `<div class="cvc-rule"${st(h, [['width', '48px'], ['max-width', '48px'], ['margin', '0 0 20px 0'], ['border-top', `3px solid ${col}`]])}></div>`;
}

/** Numeral grande de acento (módulo / capítulo). */
export function numeralHtml(h: Hx, text: string, s: Surf, big = false): string {
  const ty = h.t.typography;
  const col = readable(s.bg, [h.t.color.accentStrong, h.t.color.accent], s.fg);
  return (
    `<div class="cvc-num"` +
    st(
      h,
      [
        ['margin', '0 0 8px 0'],
        ['color', col],
        ['font-family', h.t.personality.fontNumeral],
        ['font-size', big ? Math.round(ty.sizeNumeralPx * 1.6) : ty.sizeNumeralPx],
        ['font-weight', '700'],
        ['line-height', '1'],
        ['letter-spacing', '-0.02em'],
      ],
      [['font-size', big ? 'clamp(3.5rem, 2.4rem + 4.4vw, 6rem)' : ty.scale.numeral], ['font-variant-numeric', 'tabular-nums lining-nums']],
    ) +
    `>${labelHtml(text)}</div>`
  );
}

/** Fila abierta con filete superior; con `num` el numeral va en su columna (ENHANCED). */
export function numRow(h: Hx, inner: string, s: Surf, num?: string): string {
  const n = num ? `<div${st(h, [['margin', '0 0 4px 0'], ['color', readable(s.bg, [h.t.color.accentStrong], s.fg)], ['font-family', h.t.personality.fontNumeral], ['font-size', h.t.typography.sizeItemPx], ['font-weight', '700']], [['font-variant-numeric', 'tabular-nums']])}>${labelHtml(num)}</div>` : '';
  return (
    `<li${num ? ' class="cvc-numrow"' : ''}${st(h, [['margin', 0], ['padding', '16px 0'], ['color', s.fg], ['border-top', `1px solid ${h.t.color.border}`]])}>` +
    n +
    `<div>${inner}</div></li>`
  );
}

/** Lista sin viñetas (filas con filete). */
export function rows(h: Hx, itemsHtml: string, opts: { cls?: string; ordered?: boolean } = {}): string {
  const tag = opts.ordered ? 'ol' : 'ul';
  return `<${tag}${opts.cls ? ` class="${opts.cls}"` : ''}${st(h, [['list-style', 'none'], ['margin', '0 0 24px 0'], ['padding', 0], ['border-bottom', `1px solid ${h.t.color.border}`]])}>${itemsHtml}</${tag}>`;
}

/** Párrafos de texto plano (línea en blanco = párrafo). */
export function paras(h: Hx, text: string, s: Surf, opts: { secondary?: boolean; weight?: number; last?: boolean } = {}): string {
  const ty = h.t.typography;
  const ps = richParagraphs(text);
  return ps
    .map((p, i) => {
      const safe: Decl[] = [
        ['margin', i === ps.length - 1 && opts.last ? '0' : '0 0 12px 0'],
        ['padding', 0],
        ['color', opts.secondary ? s.fg2 : s.fg],
        ['font-size', ty.sizeBodyPx],
        ['line-height', String(ty.lineBody)],
        ['max-width', `${ty.measureCh}ch`],
      ];
      if (opts.weight) safe.push(['font-weight', String(opts.weight)]);
      return `<p${st(h, safe, [['font-size', ty.enhanced.sizeBodyFluid]])}>${p}</p>`;
    })
    .join('');
}

/** Un párrafo con HTML ya seguro (armado con esc/inlineHtml por el caller). */
export function pHtml(h: Hx, html: string, s: Surf, opts: { secondary?: boolean; last?: boolean; weight?: number } = {}): string {
  const ty = h.t.typography;
  const safe: Decl[] = [
    ['margin', opts.last ? '0' : '0 0 12px 0'],
    ['padding', 0],
    ['color', opts.secondary ? s.fg2 : s.fg],
    ['font-size', ty.sizeBodyPx],
    ['line-height', String(ty.lineBody)],
    ['max-width', `${ty.measureCh}ch`],
  ];
  if (opts.weight) safe.push(['font-weight', String(opts.weight)]);
  return `<p${st(h, safe)}>${html}</p>`;
}

/** Línea meta / kicker (cvc-meta, 14 px, mayúsculas con tracking de la familia). */
export function eyebrow(h: Hx, text: string, s: Surf, opts: { color?: string; margin?: string; sentence?: boolean } = {}): string {
  // P3: `sentence` — encabezado de navegación largo (riel, recorrido): 16 px en caja de oración en toda familia
  // (en mayúsculas a 14 px solo cabe un chip corto de una línea, regla del QA del navegador).
  const p = opts.sentence ? { ...h.t.personality, metaCase: 'sentence' as const } : h.t.personality;
  const color = readable(s.bg, [opts.color ?? h.t.color.accentStrong, h.t.color.accent, s.fg2], s.fg);
  return (
    `<p class="cvc-meta cvc-kicker"${st(h, [
      ['margin', opts.margin ?? '0 0 10px 0'],
      ['padding', 0],
      ['color', color],
      ['font-family', p.fontMeta],
      ['font-size', p.metaCase === 'sentence' ? h.t.typography.sizeSmallPx : h.t.typography.sizeMetaPx],
      ['font-weight', '700'],
      ['line-height', '1.4'],
      ['letter-spacing', p.metaCase === 'sentence' ? '0.01em' : `${p.metaTracking}em`],
      ['text-transform', p.metaCase === 'sentence' ? 'none' : 'uppercase'],
    ])}>${inlineHtml(text)}</p>`
  );
}

export type Tone = 'surface' | 'alt' | 'soft';

export function toneSurf(h: Hx, tone: Tone): { s: Surf; border: string } {
  const c = h.t.color;
  if (tone === 'alt') return { s: surfOn(h.t, h.t.personality && h.t.personality.plate ? c.surface : c.surfaceAlt), border: c.border };
  if (tone === 'soft') return { s: surfOn(h.t, c.accentSoft), border: c.border };
  return { s: surfOn(h.t, c.surface), border: c.border };
}

/** Caja con fondo sólido propio (bg + color en el MISMO elemento). */
export function box(
  h: Hx,
  inner: string,
  cs: { s: Surf; border: string },
  opts: { cls?: string; tag?: 'div' | 'li'; accentBorder?: string } = {},
): string {
  const tag = opts.tag ?? 'div';
  const bw = h.t.shape.borderWidth;
  const safe: Decl[] = [
    ['background-color', cs.s.bg],
    ['color', cs.s.fg],
    // Acento = borde COMPLETO (el Visual System prohíbe franjas laterales).
    ['border', `${bw}px solid ${opts.accentBorder ?? cs.border}`],
    ['margin', '0 0 16px 0'],
    ['padding', '24px 28px'],
  ];
  return (
    `<${tag}${opts.cls ? ` class="${opts.cls}"` : ''}` +
    st(h, safe, [['border-radius', h.t.shape.radiusMd], ['min-width', '0']]) +
    `>${inner}</${tag}>`
  );
}

/** Lista con viñetas; `itemsHtml` ya es HTML seguro. */
export function ul(h: Hx, itemsHtml: string[], s: Surf, opts: { ordered?: boolean } = {}): string {
  const tag = opts.ordered ? 'ol' : 'ul';
  const items = itemsHtml
    .map((it) => `<li${st(h, [['margin', '0 0 10px 0'], ['padding', 0], ['color', s.fg]])}>${it}</li>`)
    .join('');
  return `<${tag}${st(h, [['margin', '0 0 16px 0'], ['padding', '0 0 0 24px'], ['list-style', opts.ordered ? 'decimal' : 'disc']])}>${items}</${tag}>`;
}

/** Enlace con color de acento legible sobre `s.bg`. `button`: píldora con fondo de acento (CTA). */
export function link(h: Hx, href: string, text: string, s: Surf, opts: { button?: boolean; margin?: string; fill?: { bg: string; fg: string } } = {}): string {
  const c = h.t.color;
  if (opts.button) {
    // CLEAN_SAFE: un BLOQUE con fondo de acento (el <a> en línea partía el fondo al envolver a
    // 390 px). ENHANCED: el bloque se vuelve píldora (inline-block, radio 999).
    // P3: el botón toma el color del módulo cuando el shell lo pasa (fill).
    const b = opts.fill ? surfOn(h.t, opts.fill.bg, [opts.fill.fg]) : surfOn(h.t, c.accent, [c.textOnAccent]);
    return (
      `<div class="cvc-btn-wrap"${st(h, [['background-color', b.bg], ['color', b.fg], ['padding', '12px 20px'], ['margin', opts.margin ?? '0'], ['text-align', 'center']], [['display', 'table'], ['border-radius', '999px'], ['max-width', '100%']])}>` +
      `<a class="cvc-btn-link" href="${attr(href)}"${st(h, [['color', b.fg], ['font-weight', '700'], ['text-decoration', 'none']])}>${inlineHtml(text)}</a></div>`
    );
  }
  const col = [c.accentStrong, c.accent, s.fg].find((x) => contrastRatio(x, s.bg) >= MIN_CONTRAST) ?? s.fg;
  return `<a href="${attr(href)}"${st(h, [['color', col], ['font-weight', '700']])}>${inlineHtml(text)}</a>`;
}

/** Reproductor nativo + enlace de descarga (el fallback sobrevive a forceclean). */
export function audio(h: Hx, src: string, label: string, s: Surf): string {
  return (
    `<p${st(h, [['margin', '0 0 12px 0'], ['padding', 0], ['color', s.fg]])}>` +
    `<audio controls preload="none" src="${attr(src)}"${st(h, [['width', '100%'], ['max-width', '100%']])}>` +
    `${labelHtml('Tu navegador no puede reproducir este audio: usa el enlace de descarga.')}</audio></p>` +
    `<p${st(h, [['margin', '0'], ['padding', 0], ['color', s.fg2], ['font-size', h.t.typography.sizeSmallPx]])}>${link(h, src, `Descargar ${label} (MP3)`, s)}</p>`
  );
}

/** Fila de cifras (cada cifra sale de facts). CLEAN_SAFE: una lista abierta; ENHANCED: una fila con divisores finos. Sin tarjetas. */
export function statRow(h: Hx, stats: Array<{ value: number; label: string }>): string {
  const s = bgSurf(h);
  const ty = h.t.typography;
  const col = readable(s.bg, [h.t.color.accentStrong], s.fg);
  const items = stats
    .map(
      (x) =>
        `<li class="cvc-stat"${st(h, [['margin', '0 0 8px 0'], ['padding', 0], ['color', s.fg]])}>` +
        `<strong${st(h, [['color', col], ['font-family', h.t.personality.fontNumeral], ['font-size', ty.sizeTitlePx], ['font-weight', '700'], ['line-height', '1.2']], [['font-variant-numeric', 'tabular-nums']])}>${labelHtml(String(x.value))}</strong>` +
        `<span${st(h, [['color', s.fg2], ['font-size', ty.sizeSmallPx], ['line-height', '1.35']])}>${labelHtml(` ${x.label}`)}</span></li>`,
    )
    .join('');
  return `<ul class="cvc-facts"${st(h, [['list-style', 'none'], ['margin', '24px 0 8px 0'], ['padding', '16px 0 0 0'], ['border-top', `1px solid ${h.t.color.border}`]])}>${items}</ul>`;
}

/** Transición "a continuación": filete de acento de 2 px + kicker, sin caja (Design Language §5). */
export function transitionBox(h: Hx, inner: string, ink?: string): string {
  const s = bgSurf(h);
  const col = readable(s.bg, [...(ink ? [ink] : []), h.t.color.accent, h.t.color.accentStrong], h.t.color.borderStrong);
  return (
    `<div class="cvc-transition"${st(h, [['margin', '40px 0 8px 0'], ['padding', '20px 0 0 0'], ['color', s.fg], ['border-top', `2px solid ${col}`]])}>` +
    eyebrow(h, 'A continuación', s, ink ? { color: ink } : {}) +
    inner +
    `</div>`
  );
}

export function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/**
 * Inserta HTML del shell dentro de un label ya renderizado por R2
 * (`renderMovement`): `before` justo después de la raíz (y de su <style> en
 * ENHANCED) y `after` antes del <script> final (o del cierre de la raíz).
 * Falla fuerte si la estructura no es la esperada.
 */
export function injectIntoMovement(movementHtml: string, before: string, after: string): string {
  const open = /^<div class="cvc cvc-[a-z0-9-]+(?: cvc-plate)?"[^>]*>/.exec(movementHtml);
  if (!open || !movementHtml.endsWith('</div>')) shellFail('el label de R2 no tiene la raíz esperada');
  let head = open[0].length;
  if (movementHtml.startsWith('<style>', head)) {
    const endStyle = movementHtml.indexOf('</style>', head);
    if (endStyle < 0) shellFail('<style> sin cerrar en el label de R2');
    head = endStyle + '</style>'.length;
  }
  const scriptAt = movementHtml.lastIndexOf('<script>');
  const tail = scriptAt > head ? scriptAt : movementHtml.length - '</div>'.length;
  return movementHtml.slice(0, head) + before + movementHtml.slice(head, tail) + after + movementHtml.slice(tail);
}

/**
 * Textos visibles que NO están dentro de `<span class="nolink">` (los filtros
 * de Moodle —activitynames, glossary, emoticon, urltolink— los reescribirían;
 * ledger R-005). Vacío = todo protegido.
 */
export function unprotectedText(html: string): string[] {
  const out: string[] = [];
  const walk = (n: HtmlNode, protectedRun: boolean) => {
    if (n.kind === 'text') {
      const t = n.text.replace(/[\u00AD\u200B]/g, '').trim();
      // Solo texto con letras o dígitos: los glifos decorativos de R2 (✓, ☐) no los reescribe ningún filtro.
      if (t && /[\p{L}\p{N}]/u.test(t) && !protectedRun) out.push(t);
      return;
    }
    if (n.tag === 'style' || n.tag === 'script') return;
    const isNolink = n.tag === 'span' && (n.attrs.class || '').split(/\s+/).includes('nolink');
    n.children.forEach((c) => walk(c, protectedRun || isNolink));
  };
  walk(parseHtml(html), false);
  return out;
}
