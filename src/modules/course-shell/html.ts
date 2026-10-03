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

export function heading(h: Hx, tag: 'h2' | 'h3' | 'h4', text: string, s: Surf, opts: { display?: boolean } = {}): string {
  const ty = h.t.typography;
  const p = h.t.personality;
  // r19 W: `display` = tamaño de titular en un h4 (título del curso bajo el h3 «Bienvenida» de Moodle).
  const spec =
    tag === 'h2' || opts.display
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
export function lead(h: Hx, text: string, s: Surf, opts: { last?: boolean; cls?: string } = {}): string {
  const ty = h.t.typography;
  const ps = richParagraphs(text);
  return ps
    .map(
      (p, i) =>
        `<p${opts.cls ? ` class="${opts.cls}"` : ''}${st(
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

/**
 * Reproductor nativo + enlace de descarga (el fallback sobrevive a forceclean).
 * UX r18 (problema 2): `preload="metadata"` (antes "none"): el navegador pide solo la cabecera del MP3 y
 * muestra la duración REAL antes de Play (con "none" el control quedaba en 0:00 hasta reproducir).
 * UX r18 fix 1 (M6): nombre accesible = el título visible del label (`name`, p.ej. «Audio de bienvenida»), para
 * que el control nunca quede sin nombre (con html5audio o sin filtro de medios Moodle no le pone `title`):
 *  - `title` SIEMPRE: está en el conjunto 'Common' de HTMLPurifier para <audio> (lib/weblib.php), así sobrevive a
 *    forceclean y entra en CLEAN_SAFE; el cálculo de nombre accesible lo usa cuando no hay otro;
 *  - `aria-label` solo en ENHANCED (regla de la casa: aria/id/role/data- son solo ENHANCED; el purificador los quita).
 */
export function audio(h: Hx, src: string, label: string, s: Surf, name: string): string {
  if (!name || !name.trim()) shellFail('audio(): falta el nombre accesible del reproductor');
  return (
    `<p${st(h, [['margin', '0 0 12px 0'], ['padding', 0], ['color', s.fg]])}>` +
    `<audio controls preload="metadata" title="${attr(name.trim())}"${h.enh ? ` aria-label="${attr(name.trim())}"` : ''} src="${attr(src)}"${st(h, [['width', '100%'], ['max-width', '100%']])}>` +
    `${labelHtml('Tu navegador no puede reproducir este audio: usa el enlace de descarga.')}</audio></p>` +
    `<p${st(h, [['margin', '0'], ['padding', 0], ['color', s.fg2], ['font-size', h.t.typography.sizeSmallPx]])}>${link(h, src, `Descargar ${label} (MP3)`, s)}</p>`
  );
}

/**
 * r19 W — superficie del hero de bienvenida según `personality.heroTreatment` de la familia
 * (antes declarado y nunca pintado). Todo en CLEAN_SAFE (fondo sólido + borde + padding); el
 * radio y el padding fluido son ENHANCED. El texto interior usa la `Surf` que se le pasa a `inner`
 * (contraste ≥ 4.5:1 garantizado por surfOn; falla fuerte si la familia no lo alcanza).
 *  - band  → panel tintado (surfaceAlt / surface en láminas oscuras);
 *  - rule  → fondo del label + filete superior de acento de 6 px + borde fino;
 *  - plate → tinte suave de acento (accentSoft).
 */
export function heroBand(h: Hx, cls: string, inner: (s: Surf) => string): string {
  const c = h.t.color;
  const treatment = h.t.personality.heroTreatment;
  const s = treatment === 'band' ? panelSurf(h) : treatment === 'plate' ? surfOn(h.t, c.accentSoft) : bgSurf(h);
  const safe: Decl[] = [['background-color', s.bg], ['color', s.fg]];
  if (treatment === 'rule') {
    const col = readable(s.bg, [c.accent, c.accentStrong], c.borderStrong);
    safe.push(['border', `1px solid ${c.border}`], ['border-top', `6px solid ${col}`]);
  } else if (treatment === 'band') {
    safe.push(['border', `1px solid ${c.border}`]);
  }
  safe.push(['margin', '0 0 24px 0'], ['padding', '24px']);
  // Fix round 1: en las familias de lámina (oscuras) el label ya trae su propio padding fluido; el hero usa uno menor
  // para que la entrada (≤ 240 caracteres) quepa en 4 líneas a 1280 igual que en las claras.
  const pad = h.t.personality.plate ? 'clamp(20px, 3vw, 28px)' : 'clamp(20px, 4vw, 44px)';
  return `<div class="${cls} cvc-hero-${treatment}"${st(h, safe, [['border-radius', h.t.shape.radiusLg], ['padding', pad], ['min-width', '0']])}>${inner(s)}</div>`;
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

// ─── r19 W: entrada + cuerpo (un solo divisor de oraciones para módulo y bienvenida) ───

/** Palabras visibles (separadas por espacios). */
export function wordCount(text: string): number {
  return String(text).trim().split(/\s+/).filter(Boolean).length;
}

/** Abreviaturas frecuentes: su punto no cierra la oración («Dr. Pérez», «EE. UU.»). Solo en modo `guard`. */
const ABBREV_BEFORE_DOT = /(?:^|[\s(«"“])(?:Dr|Dra|Sr|Sra|Srta|Ud|Uds|Lic|Ing|Prof|Profa|Arq|Mtro|Mtra|Av|Sto|Sta|núm|Núm|art|Art|pág|Pág|aprox|vs|EE|UU|p\. ej|P\. ej)$/;

export interface SentenceOpts {
  /**
   * false (default, presentación del módulo): EXACTAMENTE los cortes del regex de 3.12.0
   * (`[.!?]+` seguido de espacio, sea cual sea lo que siga: minúscula, `**`, raya, emoji…), así
   * su salida no cambia; la única diferencia es que ya no descarta texto (ver splitSentences).
   * true (bienvenida, r19 W): además no corta tras una abreviatura ni dentro de un énfasis `*…*`
   * abierto, corta en «…» y en una línea en blanco.
   */
  guard?: boolean;
}

/**
 * Oraciones de `text` SIN perder nada: la concatenación de las piezas es exactamente `text`.
 * Corte = puntuación final + cierre opcional (»”"')]) + espacio. Un punto sin espacio detrás
 * («1.5», «N.º», «web.com») no corta. El regex anterior del módulo
 * (`/[^.!?]+[.!?]+(\s+|$)|[^.!?]+$/g`) DESCARTABA en silencio el texto previo a ese punto
 * («El valor 1.5 es…» perdía «El valor 1.»); en todo texto que no perdía nada, los cortes son los
 * mismos que los de aquel regex (modo por defecto).
 */
export function splitSentences(text: string, opts: SentenceOpts = {}): string[] {
  const t = String(text);
  const out: string[] = [];
  const re = opts.guard ? /(?:[.!?…]+[»”"')\]]*\s+|\r?\n[ \t]*\r?\n\s*)/g : /[.!?]+[»”"')\]]*\s+/g;
  let start = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t))) {
    const end = m.index + m[0].length;
    if (end >= t.length) break;
    if (opts.guard && /^[.!?…]/.test(m[0])) {
      if (m[0][0] === '.' && ABBREV_BEFORE_DOT.test(t.slice(0, m.index))) continue;
      const head = t.slice(0, m.index);
      if ((head.match(/\*\*/g) || []).length % 2 === 1 || (head.replace(/\*\*/g, '').match(/\*/g) || []).length % 2 === 1) continue;
    }
    if (end === start) continue;
    out.push(t.slice(start, end));
    start = end;
  }
  if (start < t.length) out.push(t.slice(start));
  return out.length ? out : [t];
}

/**
 * Corta `s` en [cabeza, cola] con la cabeza lo más larga posible dentro de los topes: en el
 * último límite de cláusula (`,` `;` `:` `—` `–`) que quepa; si no hay, en el último espacio.
 * Sin elipsis ni texto agregado: cabeza + cola = s. `null` si ni una palabra cabe.
 */
export function cutToFit(s: string, maxChars: number, maxWords?: number): [string, string] | null {
  const ok = (x: string) => x.trim().length > 0 && x.trim().length <= maxChars && (maxWords === undefined || wordCount(x) <= maxWords);
  const ends = (re: RegExp) => [...s.matchAll(re)].map((m) => (m.index as number) + m[0].length).filter((at) => at < s.length);
  for (const re of [/[,;:—–]\s+|\s+[—–]\s+/g, /\s+/g]) {
    const cut = ends(re).filter((at) => ok(s.slice(0, at))).pop();
    if (cut !== undefined) return [s.slice(0, cut), s.slice(cut)];
  }
  return null;
}

/**
 * Entrada (banda) + resto: oraciones enteras desde el inicio mientras quepan en `maxChars`
 * (y en `maxWords`, si se pide). La primera oración entra siempre, salvo con `cut`: si no cabe,
 * se corta con cutToFit y lo que sobra abre el resto (bienvenida: ninguna forma de texto válida
 * por el esquema produce una entrada fuera de tope). Con `guard` la entrada no cruza una línea en
 * blanco. `fits` dice si la entrada respeta los topes. Lo usan la presentación del módulo
 * (240 caracteres, modo 3.12.0) y la bienvenida (240 caracteres / 40 palabras, guard + cut).
 */
export function splitLeadRest(
  text: string,
  opts: { maxChars: number; maxWords?: number; guard?: boolean; cut?: boolean },
): { lead: string; rest: string; fits: boolean } {
  const sentences = splitSentences(text, { guard: opts.guard });
  const ok = (s: string) => s.trim().length <= opts.maxChars && (opts.maxWords === undefined || wordCount(s) <= opts.maxWords);
  const blankEnd = (s: string) => opts.guard === true && /\n[ \t]*\r?\n\s*$/.test(s);
  let lead = '';
  let k = 0;
  while (k < sentences.length && (lead.length === 0 || (!blankEnd(lead) && ok(lead + sentences[k])))) lead += sentences[k++];
  let rest = sentences.slice(k).join('');
  if (opts.cut && !ok(lead)) {
    const c = cutToFit(lead, opts.maxChars, opts.maxWords);
    if (c) {
      lead = c[0];
      rest = c[1] + rest;
    }
  }
  return { lead: lead.trim(), rest: rest.trim(), fits: ok(lead.trim()) };
}

/**
 * Cuerpo en párrafos legibles: corta en límites de oración, cerca del reparto parejo
 * (≈ `target` palabras) y nunca por encima de `maxWords`; una línea en blanco del texto
 * fuerza un corte. Una oración sola más larga que `maxWords` se parte con cutToFit (cláusula,
 * luego espacio) y sus trozos siguen el reparto normal. Determinista; la concatenación
 * (normalizando espacios) es el texto original.
 */
export function splitBodyParagraphs(text: string, opts: { maxWords: number; target: number }): string[] {
  const pieces: Array<{ s: string; brk: boolean }> = [];
  for (const block of String(text).split(/\r?\n[ \t]*\r?\n/)) {
    if (!block.trim()) continue;
    splitSentences(block, { guard: true }).forEach((s0, i) => {
      let s = s0;
      let brk = i === 0 && pieces.length > 0;
      while (wordCount(s) > opts.maxWords) {
        const c = cutToFit(s, Infinity, opts.maxWords);
        if (!c) break;
        pieces.push({ s: c[0], brk });
        s = c[1];
        brk = false;
      }
      pieces.push({ s, brk });
    });
  }
  const total = pieces.reduce((n, p) => n + wordCount(p.s), 0);
  const n = Math.max(1, Math.ceil(total / opts.target));
  const per = total / n;
  const paras: string[] = [];
  let cur = '';
  let curW = 0;
  let done = 0;
  for (const p of pieces) {
    const w = wordCount(p.s);
    // corte si: línea en blanco, se pasa del tope, o el punto medio de la pieza cae después del siguiente reparto parejo
    if (curW > 0 && (p.brk || curW + w > opts.maxWords || done + w / 2 > per * (paras.length + 1))) {
      paras.push(cur.trim());
      cur = '';
      curW = 0;
    }
    cur += (cur && !/\s$/.test(cur) ? ' ' : '') + p.s;
    curW += w;
    done += w;
  }
  if (cur.trim()) paras.push(cur.trim());
  return paras;
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
