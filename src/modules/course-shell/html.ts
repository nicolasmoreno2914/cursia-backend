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

/** Raíz de un label del shell (misma forma que la de R2: `cvc cvc-<uid>`, fondo y color del tema). */
export function root(h: Hx, uid: string, inner: string): string {
  if (!UID_RE.test(uid)) shellFail(`uid inválido "${uid}"`);
  const ty = h.t.typography;
  return (
    `<div class="cvc cvc-shell cvc-${uid}" lang="es"` +
    st(
      h,
      [
        ['background-color', h.t.color.bg],
        ['color', h.t.color.textPrimary],
        ['font-family', ty.fontBody],
        ['font-size', ty.sizeBodyPx],
        ['line-height', String(ty.lineBody)],
        ['margin', 0],
        ['padding', '16px'],
        ['max-width', '100%'],
      ],
      [['border-radius', h.t.shape.radiusLg], ['overflow-wrap', 'anywhere']],
    ) +
    `>${inner}</div>`
  );
}

export function bgSurf(h: Hx): Surf {
  return surfOn(h.t, h.t.color.bg);
}

export function heading(h: Hx, tag: 'h2' | 'h3' | 'h4', text: string, s: Surf): string {
  const ty = h.t.typography;
  const px = tag === 'h2' ? ty.sizeH2Px : tag === 'h3' ? ty.sizeH3Px : ty.sizeBodyPx;
  const fl = tag === 'h2' ? ty.enhanced.sizeH2Fluid : tag === 'h3' ? ty.enhanced.sizeH3Fluid : ty.enhanced.sizeBodyFluid;
  return (
    `<${tag}` +
    st(
      h,
      [
        ['margin', tag === 'h4' ? '0 0 8px 0' : '0 0 16px 0'],
        ['padding', 0],
        ['color', s.fg],
        ['font-family', ty.fontHeading],
        ['font-size', px],
        ['font-weight', String(ty.weightHeading)],
        ['line-height', String(ty.lineHeading)],
      ],
      [['font-size', fl]],
    ) +
    `>${inlineHtml(text, HYPHEN_HEADING)}</${tag}>`
  );
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

/** Línea "eyebrow" (pequeña, mayúsculas, ≥ 16 px). */
export function eyebrow(h: Hx, text: string, s: Surf): string {
  return (
    `<p${st(h, [
      ['margin', '0 0 8px 0'],
      ['padding', 0],
      ['color', s.fg2],
      ['font-size', h.t.typography.sizeSmallPx],
      ['font-weight', '700'],
      ['letter-spacing', '0.06em'],
      ['text-transform', 'uppercase'],
    ])}>${inlineHtml(text)}</p>`
  );
}

export type Tone = 'surface' | 'alt' | 'soft';

export function toneSurf(h: Hx, tone: Tone): { s: Surf; border: string } {
  const c = h.t.color;
  if (tone === 'alt') return { s: surfOn(h.t, c.surfaceAlt), border: c.border };
  if (tone === 'soft') return { s: surfOn(h.t, c.accentSoft), border: c.border };
  return { s: surfOn(h.t, c.surface), border: c.border };
}

/** Caja con fondo sólido propio (bg + color en el MISMO elemento). */
export function box(
  h: Hx,
  inner: string,
  cs: { s: Surf; border: string },
  opts: { cls?: string; tag?: 'div' | 'li'; accentLeft?: string } = {},
): string {
  const tag = opts.tag ?? 'div';
  const bw = h.t.shape.borderWidth;
  const safe: Decl[] = [
    ['background-color', cs.s.bg],
    ['color', cs.s.fg],
    ['border', `${bw}px solid ${cs.border}`],
    ['margin', '0 0 16px 0'],
    ['padding', '16px 20px'],
  ];
  if (opts.accentLeft) safe.push(['border-left', `4px solid ${opts.accentLeft}`]);
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

/** Enlace con color de acento legible sobre `s.bg`. */
export function link(h: Hx, href: string, text: string, s: Surf): string {
  const c = h.t.color;
  const col = [c.accentStrong, c.accent, s.fg].find((x) => contrastRatio(x, s.bg) >= MIN_CONTRAST) ?? s.fg;
  return `<a href="${attr(href)}"${st(h, [['color', col], ['font-weight', '700']])}>${inlineHtml(text)}</a>`;
}

/** Reproductor nativo + enlace de descarga (el fallback sobrevive a forceclean). */
export function audio(h: Hx, src: string, label: string, s: Surf): string {
  return (
    `<p${st(h, [['margin', '0 0 12px 0'], ['padding', 0], ['color', s.fg]])}>` +
    `<audio controls preload="none" src="${attr(src)}"${st(h, [['width', '100%'], ['max-width', '100%']])}>` +
    `${labelHtml('Tu navegador no puede reproducir este audio: usa el enlace de descarga.')}</audio></p>` +
    pHtml(h, link(h, src, `Descargar ${label} (MP3)`, s), s, { secondary: true })
  );
}

/** Fila de cifras (cada cifra sale de facts). CLEAN_SAFE: apiladas; ENHANCED: en fila. */
export function statRow(h: Hx, stats: Array<{ value: number; label: string }>): string {
  const cs = toneSurf(h, 'alt');
  const ty = h.t.typography;
  const items = stats
    .map(
      (x) =>
        `<li class="cvc-stat"` +
        st(
          h,
          [
            ['background-color', cs.s.bg],
            ['color', cs.s.fg],
            ['border', `${h.t.shape.borderWidth}px solid ${cs.border}`],
            ['margin', '0 0 8px 0'],
            ['padding', '12px 16px'],
          ],
          [['border-radius', h.t.shape.radiusMd], ['flex', '1 1 9rem'], ['min-width', '0']],
        ) +
        `><strong${st(h, [['color', cs.s.fg], ['font-size', ty.sizeH2Px], ['font-weight', '700'], ['line-height', '1.2']])}>${labelHtml(String(x.value))}</strong>` +
        `<span${st(h, [['color', cs.s.fg], ['font-size', ty.sizeBodyPx]])}>${labelHtml(` ${x.label}`)}</span></li>`,
    )
    .join('');
  return (
    `<ul class="cvc-stats"` +
    st(h, [['list-style', 'none'], ['margin', '0 0 16px 0'], ['padding', 0]], [['display', 'flex'], ['flex-wrap', 'wrap'], ['column-gap', '8px']]) +
    `>${items}</ul>`
  );
}

/** Bloque de transición determinística (fondo propio + filete de acento). */
export function transitionBox(h: Hx, inner: string): string {
  return box(h, inner, toneSurf(h, 'alt'), { cls: 'cvc-transition', accentLeft: h.t.color.accent });
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
  const open = /^<div class="cvc cvc-[a-z0-9-]+"[^>]*>/.exec(movementHtml);
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
