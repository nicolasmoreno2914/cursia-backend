/**
 * R2 — Visual Components: renderer (JSON validado + ResolvedTheme → HTML de label Moodle).
 * R14-A — reescrito según «CURSIA V2 DESIGN LANGUAGE V1» (docs/v21/design-language-v1.md):
 * contenido ABIERTO por defecto, jerarquía tipográfica real, superficies solo por rol
 * (panel / sección tintada / bloque delineado), nunca una superficie dentro de otra.
 *
 * Dos niveles sobre EL MISMO markup (§X.1, HD-V21-3):
 *  - CLEAN_SAFE (siempre): HTML semántico + estilos inline que sobreviven forceclean=1
 *    (hex, margin/padding/border, tipografía, max-width…). Todo el contenido visible, en
 *    orden de lectura, en flujo de bloques (una columna), sin desborde a 390 px. Todo
 *    elemento que fija `color` está dentro de (o es) un elemento con `background-color`
 *    sólido del tema, elegido para ese color. Todo texto va en <span class="nolink">.
 *  - ENHANCED (ctx.level === 'enhanced'): propiedades extra DESPUÉS de las seguras (tamaños
 *    fluidos, radius, overflow-wrap), <details open>, aria/ids/role, y en renderMovement un
 *    <style> con scope (layout en columnas, grillas, ejes, botones) + runtime JS.
 *    El layout en columnas vive SOLO en el <style> (clases), así que sin él todo queda en
 *    una columna legible.
 *
 * Determinista: mismo componente + tema + uid → mismos bytes. Sin reloj ni azar.
 * El renderer NO valida longitudes (eso es validateExperience); sí exige estructura, un
 * tema bien formado y escapa todo texto, así que un input fuera de rango nunca produce
 * HTML inseguro.
 *
 * Jerarquía de encabezados: el nombre de la sección Moodle es <h3>; la apertura de capítulo
 * (ctx.opener) usa <h2> para el título del capítulo; dentro del label los títulos de
 * componente son <h4> y los encabezados de ítem <h5> (o <h4> si el componente no tiene título).
 */
import { contrastRatio, isValidHex, ResolvedTheme } from '../theme-engine';
import {
  VcAccordion,
  VcCallout,
  VcCaseScenario,
  VcChecklist,
  VcComparison,
  VcComponent,
  VcConceptCards,
  VcHero,
  VcLearningObjectives,
  VcMythReality,
  VcProcessSteps,
  VcReflection,
  VcRevealCards,
  VcSelfCheck,
  VcSummaryVisual,
  VcTabs,
  VcTimeline,
  VcWorkedExample,
  VcDiagram,
} from './schema';
import { HYPHEN_HEADING, HYPHEN_TABLE, HyphenOpts, inlineHtml, labelHtml, richParagraphs } from './text';
import { runtimeScript, scopedStyle } from './runtime';

export type VcRenderLevel = 'enhanced';

/** R14-A — contexto de apertura de capítulo: el título del capítulo es el pico de la página. */
export interface VcOpener {
  /** Línea meta, p. ej. "Módulo 1 · Capítulo 2". */
  kicker: string;
  /** Título del capítulo (display, <h2>). */
  title: string;
  /** Numeral grande (p. ej. "02"); opcional. */
  numeral?: string;
}

export interface VcRenderContext {
  /**
   * Identificador del label, ÚNICO en la página del curso; [a-z0-9-]. renderComponent admite
   * hasta 64 caracteres; renderMovement hasta 60 (deriva `<uid>-<i>` por componente).
   * Recomendado: `<courseId>-<chapterId>-<movimiento>` normalizado.
   */
  uid: string;
  /** Omitido = solo CLEAN_SAFE. */
  level?: VcRenderLevel;
  /** Solo para un `hero`: lo convierte en la apertura del capítulo (Design Language §5). */
  opener?: VcOpener;
  /**
   * Labels del shell: toda cifra visible debe salir de facts (SHELL_NUMBER_NOT_FROM_FACTS),
   * así que sin conteos en los kickers ni numerales de índice.
   */
  countless?: boolean;
}

const UID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MOVEMENT_UID_MAX = 60;
const MIN_CONTRAST = 4.5;
/** Una comparación con más columnas que esto se apila por criterio en la base (I2). */
export const VC_TABLE_MAX_COLUMNS = 2;

const hasOwn = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

// ─── Contexto interno ───────────────────────────────────────────────────────

interface Surf {
  bg: string;
  fg: string;
  fg2: string;
}

interface R {
  t: ResolvedTheme;
  enh: boolean;
  uid: string;
  seq: number;
  opener?: VcOpener;
  countless?: boolean;
}

type Decl = [string, string | number];
type HTag = 'h4' | 'h5';

function renderFail(msg: string): never {
  throw new Error(`VC_RENDER: ${msg}`);
}

function checkCtx(ctx: VcRenderContext, maxLen = 64): void {
  if (!ctx || typeof ctx.uid !== 'string' || !UID_RE.test(ctx.uid) || ctx.uid.length > maxLen) {
    renderFail(`uid inválido "${ctx && ctx.uid}" (se espera [a-z0-9-], 1–${maxLen})`);
  }
  if (ctx.level !== undefined && ctx.level !== 'enhanced') renderFail(`level desconocido "${String(ctx.level)}"`);
  if (ctx.opener !== undefined) {
    const o = ctx.opener;
    if (!o || typeof o.kicker !== 'string' || typeof o.title !== 'string' || !o.title.trim()) renderFail('opener inválido');
    if (o.numeral !== undefined && !/^[0-9]{1,3}$/.test(o.numeral)) renderFail(`opener.numeral inválido "${String(o.numeral)}"`);
  }
}

const FONT_RE = /^[A-Za-z0-9 ,'\-]+$/;

/**
 * Defensa en profundidad (M6): el tema entra crudo en style="" y en <style>. Un
 * ResolvedTheme deserializado/alterado con un token malicioso no debe poder inyectar.
 */
function checkTheme(t: ResolvedTheme): void {
  if (!t || typeof t !== 'object' || !t.color || !t.typography || !t.shape || !t.variants || !t.personality) renderFail('tema inválido');
  for (const [k, v] of Object.entries(t.color)) if (!isValidHex(v)) renderFail(`tema: color.${k} no es #RRGGBB`);
  const ty = t.typography;
  const p = t.personality;
  for (const [k, v] of [['fontBody', ty.fontBody], ['fontHeading', ty.fontHeading], ['fontDisplay', p.fontDisplay], ['fontMeta', p.fontMeta], ['fontNumeral', p.fontNumeral]] as const) {
    if (typeof v !== 'string' || !FONT_RE.test(v)) renderFail(`tema: ${k} con caracteres no permitidos`);
  }
  for (const k of [
    'sizeBodyPx', 'sizeSmallPx', 'sizeMetaPx', 'sizeH3Px', 'sizeH2Px', 'sizeH1Px', 'lineBody', 'lineHeading', 'weightBody', 'weightHeading', 'measureCh',
    'sizeDisplayPx', 'sizeTitlePx', 'sizeItemPx', 'sizeLeadPx', 'sizeStatementPx', 'sizeNumeralPx',
  ] as const) {
    if (typeof ty[k] !== 'number' || !Number.isFinite(ty[k]) || ty[k] <= 0) renderFail(`tema: typography.${k} no es un número positivo`);
  }
  if (ty.sizeBodyPx < 16 || ty.sizeSmallPx < 16 || ty.sizeMetaPx < 13) renderFail('tema: tamaños de fuente por debajo del mínimo');
  const CLAMP = /^clamp\([0-9a-z.+\- ,]+\)$/;
  for (const k of ['sizeBodyFluid', 'sizeH3Fluid', 'sizeH2Fluid', 'sizeH1Fluid'] as const) {
    if (!ty.enhanced || typeof ty.enhanced[k] !== 'string' || !CLAMP.test(ty.enhanced[k])) renderFail(`tema: typography.enhanced.${k} inválido`);
  }
  for (const k of ['display', 'title', 'item', 'lead', 'statement', 'numeral'] as const) {
    if (!ty.scale || typeof ty.scale[k] !== 'string' || !CLAMP.test(ty.scale[k])) renderFail(`tema: typography.scale.${k} inválido`);
  }
  for (const k of ['radiusSm', 'radiusMd', 'radiusLg', 'borderWidth'] as const) {
    if (typeof t.shape[k] !== 'number' || !Number.isFinite(t.shape[k]) || t.shape[k] < 0) renderFail(`tema: shape.${k} inválido`);
  }
  if (!['flat', 'outline', 'tinted'].includes(t.variants.card) || !['flat', 'outline', 'tinted'].includes(t.variants.callout) || !['solid', 'soft'].includes(t.variants.hero)) {
    renderFail('tema: variants inválidas');
  }
  if (!['rule', 'band', 'plate'].includes(p.heroTreatment) || !['compact', 'regular', 'airy'].includes(p.density)) renderFail('tema: personality inválida');
  for (const k of ['displayWeight', 'metaTracking'] as const) {
    if (typeof p[k] !== 'number' || !Number.isFinite(p[k]) || p[k] < 0) renderFail(`tema: personality.${k} inválido`);
  }
}

/** Texto legible sobre `bg`: primero los preferidos, luego los neutros del tema. Falla fuerte si nada llega a 4.5. */
function surf(t: ResolvedTheme, bg: string, preferred: string[] = []): Surf {
  const cands = [...preferred, t.color.textPrimary, t.color.textSecondary, t.color.textOnAccent];
  const fg = cands.find((c) => contrastRatio(c, bg) >= MIN_CONTRAST);
  if (!fg) renderFail(`ningún color de texto del tema alcanza ${MIN_CONTRAST}:1 sobre ${bg}`);
  const fg2 = contrastRatio(t.color.textSecondary, bg) >= MIN_CONTRAST ? t.color.textSecondary : fg;
  return { bg, fg, fg2 };
}

/** Primer color legible (≥ 4.5:1) sobre `bg` de la lista; si ninguno, el texto principal de `s`. */
function readable(bg: string, cands: string[], fallback: string): string {
  return cands.find((c) => isValidHex(c) && contrastRatio(c, bg) >= MIN_CONTRAST) ?? fallback;
}

function attr(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/** style="" con las declaraciones seguras primero y (solo ENHANCED) las extra después. */
function st(r: R, safe: Decl[], enh: Decl[] = []): string {
  const decls = r.enh ? [...safe, ...enh] : safe;
  const body = decls.map(([k, v]) => `${k}:${typeof v === 'number' ? `${v}px` : v}`).join(';');
  return ` style="${attr(body)}"`;
}

function nextId(r: R, tag: string): string {
  r.seq += 1;
  return `cvc-${r.uid}-${tag}${r.seq}`;
}

/** Atributos solo-ENHANCED (aria/id/role/data-…). */
function ea(r: R, attrs: Record<string, string | undefined>): string {
  if (!r.enh) return '';
  return Object.entries(attrs)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => ` ${k}="${attr(v as string)}"`)
    .join('');
}

/** Ritmo vertical según la densidad de la familia (§2). */
function D(r: R, px: number): number {
  const m = r.t.personality.density === 'compact' ? 0.85 : r.t.personality.density === 'airy' ? 1.15 : 1;
  return Math.round(px * m);
}

/** Fondo del label: lámina (familias oscuras) o la superficie casi blanca que se funde con la página. */
export function groundColor(t: ResolvedTheme): string {
  return t.personality && t.personality.plate ? t.color.bg : t.color.surface;
}

function ground(r: R): Surf {
  return surf(r.t, groundColor(r.t));
}

/** Superficie de un panel/sección tintada: distinta del fondo del label. */
function panelBg(r: R): string {
  return r.t.personality.plate ? r.t.color.surface : r.t.color.surfaceAlt;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Kicker con conteo ("Proceso · 6 pasos"); en labels del shell (countless) solo la etiqueta. */
function counted(r: R, label: string, n: number, one: string, many: string): string {
  return r.countless ? label : `${label} · ${plural(n, one, many)}`;
}

/** Índice "01"; en countless un glifo neutro (sin cifras). */
function indexText(r: R, i: number): string {
  return r.countless ? '—' : pad2(i + 1);
}

// ─── Primitivas tipográficas ────────────────────────────────────────────────

/** Ritmo: los componentes "mayores" respiran más antes del siguiente (64 vs 44, × densidad). */
const MAJOR_TYPES = new Set(['hero', 'process_steps', 'comparison', 'summary_visual', 'case_scenario', 'timeline', 'accordion', 'concept_cards', 'tabs', 'worked_example', 'diagram']);

function componentWrap(r: R, type: string, inner: string, s: Surf, extraSafe: Decl[] = [], extraEnh: Decl[] = [], cls = ''): string {
  const ty = r.t.typography;
  const gap = D(r, MAJOR_TYPES.has(type) ? 64 : 44);
  return (
    `<div class="cvc-c cvc-t-${type}${cls ? ' ' + cls : ''}"` +
    st(
      r,
      [
        ['background-color', s.bg],
        ['color', s.fg],
        ['font-family', ty.fontBody],
        ['font-size', ty.sizeBodyPx],
        ['line-height', String(ty.lineBody)],
        ['margin', `0 0 ${gap}px 0`],
        ...extraSafe,
      ],
      [['font-size', ty.enhanced.sizeBodyFluid], ['overflow-wrap', 'break-word'], ...extraEnh],
    ) +
    `>${inner}</div>`
  );
}

/** Línea meta / kicker (única excepción de tamaño: sizeMetaPx, clase cvc-meta). */
function kicker(r: R, text: string, s: Surf, opts: { color?: string; margin?: string; tag?: 'p' | 'span'; llm?: boolean } = {}): string {
  const p = r.t.personality;
  const color = readable(s.bg, [opts.color ?? r.t.color.accentStrong, r.t.color.accent, s.fg2], s.fg);
  const tag = opts.tag ?? 'p';
  return (
    `<${tag} class="cvc-meta cvc-kicker"` +
    st(r, [
      ['margin', opts.margin ?? `0 0 ${D(r, 10)}px 0`],
      ['padding', 0],
      ['color', color],
      ['font-family', p.fontMeta],
      // < 16 px solo para meta en MAYÚSCULAS (regla de QA/a11y); en caja de oración, 16 px.
      ['font-size', p.metaCase === 'sentence' ? r.t.typography.sizeSmallPx : r.t.typography.sizeMetaPx],
      ['font-weight', '700'],
      ['line-height', '1.4'],
      ['letter-spacing', p.metaCase === 'sentence' ? '0.01em' : `${p.metaTracking}em`],
      ['text-transform', p.metaCase === 'sentence' ? 'none' : 'uppercase'],
    ]) +
    `>${opts.llm ? inlineHtml(text) : labelHtml(text)}</${tag}>`
  );
}

/** Kicker que abre un componente: en familias con `sectionRule` lleva un filete de acento a todo el ancho. */
function sectionKicker(r: R, text: string, s: Surf): string {
  if (!r.t.personality.sectionRule) return kicker(r, text, s);
  const col = readable(s.bg, [r.t.color.accent, r.t.color.accentStrong], r.t.color.borderStrong);
  return `<div class="cvc-secrule"${st(r, [['margin', '0 0 14px 0'], ['padding', '12px 0 0 0'], ['border-top', `2px solid ${col}`]])}>${kicker(r, text, s, { margin: '0' })}</div>`;
}

type Role = 'display' | 'title' | 'item' | 'statement';

function heading(r: R, tag: 'h2' | HTag, text: string, s: Surf, role: Role, opts: { cls?: string; id?: string; margin?: string } = {}): string {
  const ty = r.t.typography;
  const p = r.t.personality;
  const spec =
    role === 'display'
      ? { px: ty.sizeDisplayPx, fl: ty.scale.display, font: p.fontDisplay, w: p.displayWeight, lh: '1.08', ls: '-0.015em', m: `0 0 ${D(r, 20)}px 0` }
      : role === 'title'
        ? { px: ty.sizeTitlePx, fl: ty.scale.title, font: ty.fontHeading, w: ty.weightHeading, lh: '1.2', ls: '-0.01em', m: `0 0 ${D(r, 20)}px 0` }
        : role === 'statement'
          ? { px: ty.sizeStatementPx, fl: ty.scale.statement, font: p.fontDisplay, w: 600, lh: '1.3', ls: '-0.005em', m: `0 0 ${D(r, 16)}px 0` }
          : { px: ty.sizeItemPx, fl: ty.scale.item, font: ty.fontHeading, w: 600, lh: '1.3', ls: '0', m: '0 0 6px 0' };
  const cls = opts.cls ? ` class="${opts.cls}"` : '';
  const id = opts.id ? ea(r, { id: opts.id }) : '';
  return (
    `<${tag}${cls}${id}` +
    st(
      r,
      [
        ['margin', opts.margin ?? spec.m],
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
    `>${inlineHtml(text, role === 'item' ? undefined : HYPHEN_HEADING)}</${tag}>`
  );
}

function paragraphs(
  r: R,
  text: string,
  s: Surf,
  opts: { secondary?: boolean; role?: 'body' | 'lead' | 'statement'; weight?: number; last?: boolean; id?: string; italic?: boolean; font?: string; climax?: boolean } = {},
): string {
  const ty = r.t.typography;
  const role = opts.role ?? 'body';
  const px = opts.climax ? ty.sizeDisplayPx - 8 : role === 'lead' ? ty.sizeLeadPx : role === 'statement' ? ty.sizeStatementPx : ty.sizeBodyPx;
  const fl = opts.climax ? 'clamp(1.625rem, 1.2rem + 2vw, 2.5rem)' : role === 'lead' ? ty.scale.lead : role === 'statement' ? ty.scale.statement : ty.enhanced.sizeBodyFluid;
  const lh = opts.climax ? '1.18' : role === 'lead' ? '1.5' : role === 'statement' ? '1.3' : String(ty.lineBody);
  const measure = role === 'body' ? `${ty.measureCh}ch` : role === 'lead' ? '60ch' : '36ch';
  const ps = richParagraphs(text);
  return ps
    .map((p, i) => {
      const safe: Decl[] = [
        ['margin', i === ps.length - 1 && opts.last ? '0' : `0 0 ${role === 'body' ? 14 : 16}px 0`],
        ['padding', 0],
        ['color', opts.secondary ? s.fg2 : s.fg],
        ['font-size', px],
        ['line-height', lh],
        ['max-width', measure],
      ];
      if (opts.font || role === 'statement') safe.push(['font-family', opts.font ?? r.t.personality.fontDisplay]);
      if (opts.weight || role === 'statement') safe.push(['font-weight', String(opts.weight ?? 600)]);
      if (opts.italic) safe.push(['font-style', 'italic']);
      const id = i === 0 && opts.id ? ea(r, { id: opts.id }) : '';
      return `<p${id}${st(r, safe, [['font-size', fl]])}>${p}</p>`;
    })
    .join('');
}

/** Filete de acento (40–56 × 3 px): marca la apertura y la idea central, nada más (§4). */
function accentRule(r: R, s: Surf, margin?: string): string {
  const col = readable(s.bg, [r.t.color.accent, r.t.color.accentStrong], r.t.color.borderStrong);
  return `<div class="cvc-rule"${ea(r, { 'aria-hidden': 'true' })}${st(r, [['width', '48px'], ['max-width', '48px'], ['margin', margin ?? `0 0 ${D(r, 20)}px 0`], ['border-top', `3px solid ${col}`]])}></div>`;
}

/** Numeral grande (capítulo, paso). */
function numeral(r: R, text: string, s: Surf, size: 'xl' | 'md' | 'sm' = 'md'): string {
  const ty = r.t.typography;
  const col = readable(s.bg, [r.t.color.accentStrong, r.t.color.accent], s.fg);
  const px = size === 'xl' ? Math.round(ty.sizeNumeralPx * 1.6) : size === 'md' ? ty.sizeNumeralPx : ty.sizeItemPx;
  const fl = size === 'xl' ? 'clamp(3.25rem, 2.2rem + 4vw, 5.5rem)' : size === 'md' ? ty.scale.numeral : ty.scale.item;
  return (
    `<div class="cvc-num"` +
    st(
      r,
      [
        ['margin', size === 'sm' ? '0 0 4px 0' : '0 0 8px 0'],
        ['color', col],
        ['font-family', r.t.personality.fontNumeral],
        ['font-size', px],
        ['font-weight', String(Math.max(600, Math.min(900, Math.round(r.t.personality.displayWeight / 100) * 100)))],
        ['line-height', '1'],
        ['letter-spacing', '-0.02em'],
      ],
      [['font-size', fl], ['font-variant-numeric', 'tabular-nums lining-nums']],
    ) +
    `>${labelHtml(text)}</div>`
  );
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Fila separada por filete superior (el separador de todo contenido abierto). */
function row(r: R, inner: string, s: Surf, opts: { tag?: 'div' | 'li'; cls?: string; first?: boolean; id?: string } = {}): string {
  const tag = opts.tag ?? 'div';
  return (
    `<${tag}${opts.cls ? ` class="${opts.cls}"` : ''}${opts.id ? ` id="${attr(opts.id)}"` : ''}` +
    st(r, [
      ['margin', 0],
      ['padding', `${D(r, 18)}px 0 ${D(r, 18)}px 0`],
      ['color', s.fg],
      // Edu EV4: la primera fila dentro de un panel no lleva filete (el panel ya separa).
      ...(opts.first ? [] : ([['border-top', `1px solid ${r.t.personality.gridRules ? r.t.color.borderStrong : r.t.color.border}`]] as Decl[])),
    ]) +
    `>${inner}</${tag}>`
  );
}

/** Panel: una superficie por rol (caso, tarjetas de revelado). Nunca contiene otra superficie. */
function panel(r: R, inner: string, s: Surf, opts: { cls?: string; tag?: 'div' | 'li'; border?: string; borderWidth?: number; padding?: string } = {}): string {
  const tag = opts.tag || 'div';
  return (
    `<${tag} class="cvc-panel${opts.cls ? ' ' + opts.cls : ''}"` +
    st(
      r,
      [
        ['background-color', s.bg],
        ['color', s.fg],
        ['border', `${opts.borderWidth ?? 1}px solid ${opts.border ?? r.t.color.border}`],
        ['margin', `0 0 ${D(r, 16)}px 0`],
        ['padding', opts.padding ?? `${D(r, 24)}px ${D(r, 28)}px`],
      ],
      [['border-radius', r.t.shape.radiusMd]],
    ) +
    `>${inner}</${tag}>`
  );
}

/**
 * Edu EV4 — tarjeta de aprendizaje: superficie tintada con relleno (no una fila entre filetes),
 * para que un bloque didáctico se lea como pieza del curso y no como párrafo de revista.
 */
function tile(r: R, inner: string, s: Surf, opts: { cls?: string; tag?: 'div' | 'li' } = {}): string {
  const tag = opts.tag || 'li';
  return (
    `<${tag} class="cvc-tile${opts.cls ? ' ' + opts.cls : ''}"` +
    st(
      r,
      [
        ['background-color', s.bg],
        ['color', s.fg],
        ['margin', `0 0 ${D(r, 12)}px 0`],
        ['padding', `${D(r, 18)}px ${D(r, 20)}px`],
      ],
      [['border-radius', r.t.shape.radiusMd]],
    ) +
    `>${inner}</${tag}>`
  );
}

/** Edu EV4 — insignia numerada (paso): cifra clara sobre el acento, no un numeral gigante. */
function badge(r: R, text: string): string {
  const b = surf(r.t, r.t.color.accentStrong, [r.t.color.textOnAccent]);
  return (
    `<div class="cvc-badge"` +
    st(
      r,
      [
        ['width', '36px'],
        ['margin', '0 0 8px 0'],
        ['background-color', b.bg],
        ['color', b.fg],
        ['font-family', r.t.personality.fontNumeral],
        ['font-size', r.t.typography.sizeSmallPx],
        ['font-weight', '700'],
        ['line-height', '36px'],
        ['text-align', 'center'],
      ],
      [['border-radius', '50%'], ['font-variant-numeric', 'tabular-nums lining-nums']],
    ) +
    `>${labelHtml(text)}</div>`
  );
}

/** <ul>/<ol> sin viñetas: en ENHANCED se devuelve role="list" (Safari/VoiceOver lo pierde). */
function bareList(r: R, tag: 'ul' | 'ol', inner: string, cls?: string): string {
  return `<${tag}${cls ? ` class="${cls}"` : ''}${ea(r, { role: 'list' })}${st(r, [['list-style', 'none'], ['margin', 0], ['padding', 0]])}>${inner}</${tag}>`;
}

/**
 * Bloque de revelado. CLEAN_SAFE: etiqueta + cuerpo apilados, siempre visibles.
 * ENHANCED: <details open> (el runtime lo cierra al iniciar; sin JS queda abierto), con un
 * botón-píldora como <summary> y un nombre accesible con el contexto del ítem.
 */
function reveal(r: R, cls: string, summaryInner: string, cleanLead: string, body: string, opts: { keepOpen?: boolean; ariaLabel?: string; button?: boolean } = {}): string {
  if (!r.enh) return `<div class="${cls}">${cleanLead}${body}</div>`;
  const k = opts.keepOpen ? ' cvc-keep-open' : '';
  return (
    `<details class="${cls} cvc-collapsible${k}" open>` +
    `<summary class="cvc-summary${opts.button ? ' cvc-btn' : ''}"${ea(r, { 'aria-label': opts.ariaLabel })}${st(r, [['margin', opts.button ? '4px 0 0 0' : '0']])}>${summaryInner}</summary>` +
    `<div class="cvc-dbody">${body}</div></details>`
  );
}

/** Texto de un botón-píldora de revelado (solo ENHANCED lo muestra como botón). */
function btnLabel(r: R, text: string, s: Surf): string {
  const col = readable(s.bg, [r.t.color.accentStrong, r.t.color.accent], s.fg);
  return `<span class="cvc-btn-t"${st(r, [['color', col], ['font-size', r.t.typography.sizeSmallPx], ['font-weight', '700']])}>${labelHtml(text)}</span>`;
}

function titleIf(r: R, title: string | undefined, s: Surf, fallback?: string, id?: string): string {
  const tt = title ?? fallback;
  return tt ? heading(r, 'h4', tt, s, 'title', { id }) : '';
}

function itemTag(title: string | undefined, fallback?: string): HTag {
  return title ?? fallback ? 'h5' : 'h4';
}

function list<T>(v: T[] | undefined, what: string): T[] {
  if (!Array.isArray(v) || v.length === 0) renderFail(`${what}: se esperaba una lista no vacía`);
  return v;
}

function glyph(r: R, ch: string, color: string, cls = 'cvc-glyph'): string {
  return `<span class="${cls}"${ea(r, { 'aria-hidden': 'true' })}${st(r, [['color', color], ['font-weight', '700']])}>${ch}</span> `;
}

/** "Paso 3: Frota…" → "Frota…" (el numeral ya dice el orden). */
const STEP_PREFIX_RE = /^\s*(?:paso|etapa|fase|step)\s*\d{1,2}\s*[:.\-–—)]\s*/i;
function stripStepPrefix(h: string): string {
  const out = h.replace(STEP_PREFIX_RE, '');
  return out.trim() ? out : h;
}

// ─── Componentes (una función por tipo) ─────────────────────────────────────

function renderHero(r: R, c: VcHero): string {
  const col = r.t.color;
  const p = r.t.personality;
  const g = ground(r);
  const op = r.opener;
  const plate = p.heroTreatment === 'plate';
  const s = plate ? surf(r.t, col.accentSoft) : g;
  const metaParts = [op ? op.kicker : '', c.eyebrow ?? ''].filter((x) => x && x.trim());
  let head = '';
  if (p.heroTreatment === 'band' && metaParts.length) {
    const bs = surf(r.t, col.accent, [col.textOnAccent]);
    head =
      `<div class="cvc-band"${st(r, [['background-color', bs.bg], ['color', bs.fg], ['margin', `0 0 ${D(r, 24)}px 0`], ['padding', '10px 16px']], [['border-radius', r.t.shape.radiusSm]])}>` +
      kicker(r, metaParts.join(' · '), bs, { color: bs.fg, margin: '0', llm: true }) +
      `</div>`;
  } else if (metaParts.length) {
    head = kicker(r, metaParts.join(' · '), s, { llm: true });
  }
  let main: string;
  if (op) {
    main =
      heading(r, 'h2', op.title, s, 'display') +
      accentRule(r, s) +
      paragraphs(r, c.title, s, { role: 'statement', italic: p.thesisItalic }) +
      paragraphs(r, c.lead, s, { role: 'lead', last: true });
  } else {
    main = heading(r, 'h4', c.title, s, 'display') + accentRule(r, s) + paragraphs(r, c.lead, s, { role: 'lead', last: true });
  }
  const num = op && op.numeral ? `<div class="cvc-op-num">${numeral(r, op.numeral, s, 'xl')}</div>` : '';
  const body = `<div class="cvc-op${num ? ' cvc-op-split' : ''}"><div class="cvc-op-lead">${head}</div>${num}<div class="cvc-op-main">${main}</div></div>`;
  if (plate) {
    return componentWrap(
      r,
      'hero',
      body,
      s,
      [['padding', `${D(r, 32)}px ${D(r, 28)}px`], ['border', `1px solid ${col.accentSoft}`]],
      [['border-radius', r.t.shape.radiusLg], ['padding', 'clamp(24px, 4vw, 48px)']],
      op ? 'cvc-opener' : '',
    );
  }
  return componentWrap(r, 'hero', body, s, [['padding', `${D(r, 8)}px 0 0 0`]], [], op ? 'cvc-opener' : '');
}

function renderLearningObjectives(r: R, c: VcLearningObjectives): string {
  const s = ground(r);
  const ps = surf(r.t, panelBg(r));
  const items = list(c.items, 'learning_objectives.items');
  const lis = items
    .map(
      (it, i) =>
        row(
          r,
          `<div class="cvc-li-n"${st(r, [['margin', '0 0 4px 0'], ['color', readable(ps.bg, [r.t.color.accentStrong], ps.fg)], ['font-family', r.t.personality.fontNumeral], ['font-size', r.t.typography.sizeSmallPx], ['font-weight', '700']], [['font-variant-numeric', 'tabular-nums']])}>${labelHtml(indexText(r, i))}</div>` +
            `<div class="cvc-li-t"${st(r, [['color', ps.fg]])}>${inlineHtml(it)}</div>`,
          ps,
          { tag: 'li', cls: 'cvc-obj', first: i === 0 },
        ),
    )
    .join('');
  const cls = items.length >= 4 ? 'cvc-cols2 cvc-objs' : 'cvc-objs';
  return componentWrap(
    r,
    'learning_objectives',
    // Edu EV4: el kicker ya no repite el título; la lista vive en un panel tintado.
    sectionKicker(r, 'Objetivos de aprendizaje', s) +
      titleIf(r, c.title, s, 'Al terminar podrás') +
      panel(r, bareList(r, 'ol', lis, cls), ps, { cls: 'cvc-obj-panel', border: ps.bg, padding: `${D(r, 6)}px ${D(r, 24)}px` }),
    s,
  );
}

function renderConceptCards(r: R, c: VcConceptCards): string {
  const s = ground(r);
  const ht = itemTag(c.title, 'Glosario');
  const cards = list(c.cards, 'concept_cards.cards');
  const ts = surf(r.t, panelBg(r));
  const items = cards
    .map((k) => tile(r, heading(r, ht, k.term, ts, 'item') + paragraphs(r, k.definition, ts, { last: true, secondary: true }), ts, { cls: 'cvc-term' }))
    .join('');
  return componentWrap(
    r,
    'concept_cards',
    sectionKicker(r, 'Glosario', s) + titleIf(r, c.title, s, 'Conceptos clave') + bareList(r, 'ul', items, 'cvc-cards'),
    s,
  );
}

function renderRevealCards(r: R, c: VcRevealCards): string {
  const s = ground(r);
  const ps = surf(r.t, panelBg(r));
  const cards = list(c.cards, 'reveal_cards.cards');
  const items = cards
    .map((k, i) => {
      const front = paragraphs(r, k.front, ps, { weight: 600 });
      const lead = kicker(r, 'Respuesta', ps, { margin: '0 0 6px 0' });
      const back = reveal(r, 'cvc-reveal', btnLabel(r, 'Respuesta', ps), lead, paragraphs(r, k.back, ps, { last: true }), {
        ariaLabel: `Respuesta: tarjeta ${i + 1}`,
        button: true,
      });
      return panel(r, front + back, ps, { tag: 'li', cls: 'cvc-reveal-card' });
    })
    .join('');
  return componentWrap(
    r,
    'reveal_cards',
    sectionKicker(r, 'Pon a prueba', s) + titleIf(r, c.title, s) + bareList(r, 'ul', items, 'cvc-cols2 cvc-cards'),
    s,
  );
}

function renderAccordion(r: R, c: VcAccordion): string {
  const s = ground(r);
  const ht = itemTag(c.title);
  const its = list(c.items, 'accordion.items');
  const items = its
    .map((it, i) => {
      const h = heading(r, ht, it.heading, s, 'item', { margin: '0' });
      return row(r, reveal(r, 'cvc-acc', h, h, `<div${st(r, [['padding', '10px 0 0 0']])}>${paragraphs(r, it.body, s, { last: true, secondary: true })}</div>`, { keepOpen: i === 0 }), s, {
        cls: 'cvc-acc-row',
      });
    })
    .join('');
  return componentWrap(
    r,
    'accordion',
    sectionKicker(r, 'Profundiza', s) + titleIf(r, c.title, s) + `<div class="cvc-rows"${st(r, [['border-bottom', `1px solid ${r.t.color.border}`]])}>${items}</div>`,
    s,
  );
}

function renderTabs(r: R, c: VcTabs): string {
  const s = ground(r);
  const ht = itemTag(c.title);
  const titleId = r.enh && c.title ? nextId(r, 'tt') : undefined;
  const tabs = list(c.tabs, 'tabs.tabs');
  const panels = tabs
    .map((tb) => {
      const id = r.enh ? nextId(r, 'tab') : undefined;
      return row(r, heading(r, ht, tb.label, s, 'item', { cls: 'cvc-tablabel' }) + paragraphs(r, tb.body, s, { last: true }), s, { cls: 'cvc-tabpanel', id });
    })
    .join('');
  const box = `<div class="cvc-tabs"${ea(r, titleId ? { 'data-cvc-labelledby': titleId } : { 'data-cvc-label': 'Pestañas' })}>${panels}</div>`;
  return componentWrap(r, 'tabs', sectionKicker(r, 'Perspectivas', s) + titleIf(r, c.title, s, undefined, titleId) + box, s);
}

function renderTimeline(r: R, c: VcTimeline): string {
  const s = ground(r);
  const col = r.t.color;
  const ht = itemTag(c.title);
  const evs = list(c.events, 'timeline.events');
  const events = evs
    .map((ev) => {
      const marker = kicker(r, ev.marker, s, { margin: '0 0 4px 0', llm: true });
      return (
        `<li class="cvc-ev"${st(r, [['margin', 0], ['padding', `0 0 ${D(r, 28)}px ${D(r, 28)}px`], ['color', s.fg]])}>` +
        marker +
        heading(r, ht, ev.heading, s, 'item') +
        paragraphs(r, ev.body, s, { last: true, secondary: true }) +
        `</li>`
      );
    })
    .join('');
  void col;
  const axis = `<ol class="cvc-axis"${ea(r, { role: 'list' })}${st(r, [['list-style', 'none'], ['margin', '0 0 0 6px'], ['padding', `${D(r, 4)}px 0 0 0`]])}>${events}</ol>`;
  return componentWrap(r, 'timeline', sectionKicker(r, counted(r, 'Línea de tiempo', evs.length, 'hito', 'hitos'), s) + titleIf(r, c.title, s) + axis, s);
}

function renderProcessSteps(r: R, c: VcProcessSteps): string {
  const s = ground(r);
  const ht = itemTag(c.title);
  const sps = list(c.steps, 'process_steps.steps');
  const steps = sps
    .map((sp, i) =>
      row(
        r,
        `<div class="cvc-step-n">${badge(r, String(i + 1))}</div>` +
          `<div class="cvc-step-b">${heading(r, ht, stripStepPrefix(sp.heading), s, 'item')}${paragraphs(r, sp.body, s, { last: true, secondary: true })}</div>`,
        s,
        { tag: 'li', cls: 'cvc-step' },
      ),
    )
    .join('');
  return componentWrap(
    r,
    'process_steps',
    sectionKicker(r, counted(r, 'Proceso', sps.length, 'paso', 'pasos'), s) + titleIf(r, c.title, s) + bareList(r, 'ol', steps, 'cvc-steps'),
    s,
  );
}

/** ≤ 2 columnas: <table> real (cabe a 390 px); en ENHANCED dentro de una región desplazable accesible. */
function comparisonTable(r: R, columns: string[], rows: VcComparison['rows'], titleId?: string): string {
  const col = r.t.color;
  const ty = r.t.typography;
  const g = ground(r);
  const head = surf(r.t, panelBg(r));
  const h: HyphenOpts = HYPHEN_TABLE;
  const cellStyle = (x: Surf, bold: boolean, isHead = false): Decl[] => [
    ['background-color', x.bg],
    ['color', x.fg],
    ['border-bottom', `1px solid ${isHead ? col.borderStrong : col.border}`],
    ['padding', '12px 14px'],
    ['font-size', ty.sizeSmallPx],
    ['line-height', '1.5'],
    ['font-weight', bold ? '700' : String(ty.weightBody)],
    ['text-align', 'left'],
    ['vertical-align', 'top'],
  ];
  const headCell = (x: Surf): Decl[] => cellStyle(x, true, true);
  const thead =
    `<thead><tr><th scope="col"${st(r, headCell(head))}>${labelHtml('Aspecto')}</th>` +
    columns.map((cn) => `<th scope="col"${st(r, headCell(head))}>${inlineHtml(cn, h)}</th>`).join('') +
    '</tr></thead>';
  const tbody =
    '<tbody>' +
    rows
      .map((row) => {
        const cells = list(row.cells, 'comparison.rows[].cells');
        return (
          `<tr><th scope="row"${st(r, cellStyle(g, true))}>${inlineHtml(row.label, h)}</th>` +
          cells.map((v) => `<td${st(r, cellStyle(g, false))}>${inlineHtml(v, h)}</td>`).join('') +
          '</tr>'
        );
      })
      .join('') +
    '</tbody>';
  const table = `<table${st(r, [['border-collapse', 'collapse'], ['width', '100%'], ['margin', 0]])}>${thead}${tbody}</table>`;
  if (!r.enh) return `<div class="cvc-cmp">${table}</div>`;
  return (
    `<div class="cvc-cmp cvc-scroll" role="region" tabindex="0"` +
    (titleId ? ` aria-labelledby="${attr(titleId)}"` : ' aria-label="Comparación"') +
    `>${table}</div>`
  );
}

/**
 * > 2 columnas: en la base, un bloque por criterio con "Columna: valor" apilados (nunca
 * desborda a 390 px, ni con forceclean). En ENHANCED el runtime construye además la tabla
 * completa (región desplazable) y la muestra en pantallas anchas.
 */
function comparisonStack(r: R, columns: string[], rows: VcComparison['rows'], title: string | undefined): string {
  const s = ground(r);
  const ht = itemTag(title);
  const blocks = rows
    .map((rw) => {
      const cells = list(rw.cells, 'comparison.rows[].cells');
      const items = cells
        .map(
          (v, i) =>
            `<p class="cvc-cmp-cell"${st(r, [['margin', '0 0 6px 0'], ['color', s.fg], ['font-size', r.t.typography.sizeBodyPx], ['line-height', String(r.t.typography.lineBody)]])}>` +
            `<strong class="cvc-cmp-col">${inlineHtml(columns[i] ?? '')}:</strong> <span class="cvc-cmp-val">${inlineHtml(v)}</span></p>`,
        )
        .join('');
      return row(r, heading(r, ht, rw.label, s, 'item', { cls: 'cvc-cmp-label' }) + items, s, { cls: 'cvc-cmp-row' });
    })
    .join('');
  return `<div class="cvc-cmp cvc-cmp-stack"${ea(r, { 'data-cvc-cols': String(columns.length) })}>${blocks}</div>`;
}

/**
 * R14 — encabezado que nombra el CRITERIO (no un sujeto comparado): vacío, "Aspecto", "Criterio",
 * "Tipo de adaptación", "Nivel"... Texto ya sin tildes y en minúsculas. Espejo en el frontend
 * (DYN_CRITERION_HEADER_RE, 45-dynamic-generation-executor.js).
 */
export const VC_CRITERION_HEADER_RE =
  /^(?:|aspectos?|criterios?|caracteristicas?|dimension(?:es)?|elementos?|factor(?:es)?|variables?|rasgos?|categorias?|indicador(?:es)?|parametros?|atributos?|conceptos?|puntos?|temas?|ejes?|ambitos?|items?|comparacion|dato|tipos?|nivel(?:es)?|clases?|modalidad(?:es)?|fases?|etapas?|momentos?|situacion(?:es)?|escenarios?|casos?|opcion(?:es)?|enfoques?)(?:\s.*)?$/;

const foldHeader = (x: unknown): string =>
  String(x ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

/**
 * R14 — comparación ALMACENADA con la firma del repair anterior: la columna del rótulo quedó en
 * columns[0] y cada fila recibió un relleno "—" al final. Se normaliza al renderizar (sin
 * regenerar): se quita columns[0] y el "—" final. Solo con esa firma exacta y un encabezado de criterio.
 */
export function normalizeLegacyLabelColumn(
  columns: string[],
  rows: VcComparison['rows'],
): { columns: string[]; rows: VcComparison['rows'] } | null {
  if (columns.length < 3 || !rows.length) return null;
  const padded = rows.every(
    (rw) => Array.isArray(rw.cells) && rw.cells.length === columns.length && String(rw.cells[rw.cells.length - 1]).trim() === '—',
  );
  if (!padded || !VC_CRITERION_HEADER_RE.test(foldHeader(columns[0]))) return null;
  // "Nivel básico / Nivel intermedio", "Opción A / Opción B": serie de sujetos, no un criterio.
  const w0 = foldHeader(columns[0]).split(/\s+/)[0];
  if (w0 && columns.slice(1).some((cn) => foldHeader(cn).split(/\s+/)[0] === w0)) return null;
  return { columns: columns.slice(1), rows: rows.map((rw) => ({ ...rw, cells: rw.cells.slice(0, -1) })) };
}

function renderComparison(r: R, c: VcComparison): string {
  const s = ground(r);
  const rawColumns = list(c.columns, 'comparison.columns');
  const rawRows = list(c.rows, 'comparison.rows');
  const legacy = normalizeLegacyLabelColumn(rawColumns, rawRows);
  const columns = legacy ? legacy.columns : rawColumns;
  const rows = legacy ? legacy.rows : rawRows;
  const titleId = r.enh && c.title ? nextId(r, 'cmp') : undefined;
  const body = columns.length > VC_TABLE_MAX_COLUMNS ? comparisonStack(r, columns, rows, c.title) : comparisonTable(r, columns, rows, titleId);
  return componentWrap(r, 'comparison', sectionKicker(r, 'Comparación', s) + titleIf(r, c.title, s, undefined, titleId) + body, s);
}

function renderMythReality(r: R, c: VcMythReality): string {
  const s = ground(r);
  const col = r.t.color;
  const pairs = list(c.pairs, 'myth_reality.pairs');
  const rowsHtml = pairs
    .map((p, i) => {
      const myth = `<div class="cvc-myth-a">${kicker(r, 'Mito', s, { color: col.danger, margin: '0 0 6px 0' })}${paragraphs(r, p.myth, s, { secondary: true, last: true })}</div>`;
      const lead = kicker(r, 'Realidad', s, { color: col.success, margin: '0 0 6px 0' });
      const real = `<div class="cvc-myth-b">${reveal(r, 'cvc-myth', btnLabel(r, 'Realidad', s), lead, paragraphs(r, p.reality, s, { weight: 600, last: true }), {
        ariaLabel: `Realidad: mito ${i + 1}`,
        button: true,
      })}</div>`;
      return row(r, myth + real, s, { tag: 'li', cls: 'cvc-mr' });
    })
    .join('');
  return componentWrap(r, 'myth_reality', sectionKicker(r, 'Mito y realidad', s) + titleIf(r, c.title, s) + bareList(r, 'ul', rowsHtml), s);
}

function renderCaseScenario(r: R, c: VcCaseScenario): string {
  const ps = surf(r.t, panelBg(r));
  const qs = list(c.questions, 'case_scenario.questions')
    .map(
      (q, i) =>
        `<li class="cvc-q"${st(r, [['margin', '0 0 12px 0'], ['padding', 0], ['color', ps.fg]])}>` +
        `<span class="cvc-q-n"${st(r, [['color', readable(ps.bg, [r.t.color.accentStrong], ps.fg)], ['font-family', r.t.personality.fontNumeral], ['font-weight', '700']])}>${labelHtml(`${i + 1}.`)}</span> ` +
        `<span class="cvc-q-t">${inlineHtml(q)}</span></li>`,
    )
    .join('');
  const inner =
    kicker(r, 'Caso', ps) +
    heading(r, 'h4', c.title, ps, 'title') +
    paragraphs(r, c.narrative, ps) +
    kicker(r, 'Preguntas guía', ps, { margin: `${D(r, 20)}px 0 12px 0` }) +
    bareList(r, 'ol', qs, 'cvc-qs');
  return componentWrap(r, 'case_scenario', panel(r, inner, ps, { padding: `${D(r, 28)}px ${D(r, 28)}px` }), ground(r), [], [], 'cvc-case');
}

function renderChecklist(r: R, c: VcChecklist): string {
  const s = ground(r);
  const its = list(c.items, 'checklist.items');
  const items = its
    .map((it) => row(r, glyph(r, '☐', readable(s.bg, [r.t.color.accentStrong], s.fg)) + `<span class="cvc-li-t">${inlineHtml(it)}</span>`, s, { tag: 'li', cls: 'cvc-check' }))
    .join('');
  return componentWrap(r, 'checklist', sectionKicker(r, 'Lista de verificación', s) + titleIf(r, c.title, s) + bareList(r, 'ul', items), s);
}

function renderReflection(r: R, c: VcReflection): string {
  const s = ground(r);
  const p = r.t.personality;
  const q = `<div class="cvc-quote"${ea(r, { 'aria-hidden': 'true' })}${st(r, [['margin', '0 0 -8px 0'], ['color', readable(s.bg, [r.t.color.accent, r.t.color.accentStrong], s.fg)], ['font-family', "Georgia, 'Times New Roman', serif"], ['font-size', 64], ['font-weight', '700'], ['line-height', '1']])}>${labelHtml('“')}</div>`;
  let inner = q + kicker(r, 'Para reflexionar', s) + paragraphs(r, c.prompt, s, { role: 'statement', italic: p.thesisItalic, last: !c.hint });
  if (c.hint) {
    inner += reveal(r, 'cvc-hint', btnLabel(r, 'Pista', s), kicker(r, 'Pista', s, { margin: '0 0 6px 0' }), paragraphs(r, c.hint, s, { last: true, secondary: true }), {
      ariaLabel: 'Pista para la reflexión',
      button: true,
    });
  }
  return componentWrap(
    r,
    'reflection',
    inner,
    s,
    [['padding', `${D(r, 24)}px 0 ${D(r, 8)}px 0`], ['border-top', `1px solid ${r.t.color.borderStrong}`]],
  );
}

const CALLOUT_LABEL: Record<VcCallout['variant'], string> = {
  tip: 'Consejo',
  warning: 'Atención',
  info: 'Dato',
  example: 'Ejemplo',
};

function renderCallout(r: R, c: VcCallout): string {
  const col = r.t.color;
  const tone: Record<VcCallout['variant'], string> = {
    tip: col.success,
    warning: col.warning,
    info: col.info,
    example: col.accent,
  };
  if (typeof c.variant !== 'string' || !hasOwn(tone, c.variant)) renderFail(`callout.variant desconocido "${String(c.variant)}"`);
  const s = ground(r);
  const border = tone[c.variant];
  const inner =
    kicker(r, CALLOUT_LABEL[c.variant], s, { color: border, margin: '0 0 8px 0' }) +
    (c.title ? heading(r, 'h5', c.title, s, 'item') : '') +
    paragraphs(r, c.body, s, { last: true });
  return componentWrap(
    r,
    'callout',
    inner,
    s,
    [['padding', `${D(r, 20)}px ${D(r, 24)}px`], ['border', `${c.variant === 'warning' ? 2 : 1}px solid ${border}`]],
    [['border-radius', r.t.shape.radiusMd]],
  );
}

function renderSummaryVisual(r: R, c: VcSummaryVisual): string {
  const ts = surf(r.t, panelBg(r));
  const pts = list(c.points, 'summary_visual.points');
  const points = pts
    .map(
      (p, i) =>
        `<li class="cvc-pt"${st(r, [['margin', 0], ['padding', `${D(r, 14)}px 0 ${D(r, 14)}px 0`], ['color', ts.fg], ['border-top', `1px solid ${r.t.color.border}`]])}>` +
        `<div class="cvc-li-n"${st(r, [['margin', '0 0 4px 0'], ['color', readable(ts.bg, [r.t.color.accentStrong], ts.fg)], ['font-family', r.t.personality.fontNumeral], ['font-size', r.t.typography.sizeSmallPx], ['font-weight', '700']], [['font-variant-numeric', 'tabular-nums']])}>${labelHtml(indexText(r, i))}</div>` +
        `<div class="cvc-li-t">${inlineHtml(p)}</div></li>`,
    )
    .join('');
  const inner =
    kicker(r, 'Ideas clave', ts) +
    accentRule(r, ts, `0 0 ${D(r, 16)}px 0`) +
    `<div class="cvc-central">${paragraphs(r, c.central, ts, { role: 'statement', italic: r.t.personality.thesisItalic, last: true, climax: true })}</div>` +
    `<div${st(r, [['margin', `${D(r, 24)}px 0 0 0`]])}>${bareList(r, 'ol', points, pts.reduce((a, x) => a + x.length, 0) / pts.length > 90 ? 'cvc-pts' : 'cvc-cols2 cvc-pts')}</div>`;
  return componentWrap(
    r,
    'summary_visual',
    inner,
    ts,
    [['padding', `${D(r, 32)}px ${D(r, 28)}px ${D(r, 20)}px ${D(r, 28)}px`]],
    [['border-radius', r.t.shape.radiusLg], ['padding', `clamp(24px, 3.4vw, ${D(r, 44)}px)`]],
  );
}

function renderSelfCheck(r: R, c: VcSelfCheck): string {
  const s = ground(r);
  const its = list(c.items, 'self_check.items');
  const items = its
    .map((it, i) => {
      const q = kicker(r, `Pregunta ${i + 1}`, s, { margin: '0 0 6px 0' }) + paragraphs(r, it.q, s, { weight: 600 });
      const lead = kicker(r, 'Respuesta', s, { color: r.t.color.success, margin: '0 0 6px 0' });
      return row(r, q + reveal(r, 'cvc-selfcheck', btnLabel(r, 'Respuesta', s), lead, paragraphs(r, it.a, s, { last: true, secondary: true }), { ariaLabel: `Respuesta: pregunta ${i + 1}`, button: true }), s, {
        tag: 'li',
      });
    })
    .join('');
  return componentWrap(r, 'self_check', sectionKicker(r, counted(r, 'Autoevaluación', its.length, 'pregunta', 'preguntas'), s) + titleIf(r, c.title, s, 'Repaso rápido') + bareList(r, 'ol', items), s);
}

/**
 * Edu Phase A — ejemplo resuelto: situación → datos (ilustrativos) → resolución paso a paso →
 * resultado (panel, la única superficie) → para recordar. Todo abierto: es contenido, no revelado.
 */
function renderWorkedExample(r: R, c: VcWorkedExample): string {
  const s = ground(r);
  const ps = surf(r.t, panelBg(r));
  const data = list(c.data, 'worked_example.data')
    .map((d) => row(r, `<span class="cvc-li-t">${inlineHtml(d)}</span>`, s, { tag: 'li', cls: 'cvc-we-datum' }))
    .join('');
  const steps = list(c.steps, 'worked_example.steps')
    .map((sp, i) =>
      row(
        r,
        `<div class="cvc-step-n">${badge(r, String(i + 1))}</div>` +
          `<div class="cvc-step-b">${heading(r, 'h5', stripStepPrefix(sp.action), s, 'item')}${paragraphs(r, sp.detail, s, { last: true, secondary: true })}</div>`,
        s,
        { tag: 'li', cls: 'cvc-step' },
      ),
    )
    .join('');
  const result =
    kicker(r, 'Resultado', ps, { color: r.t.color.success }) +
    paragraphs(r, c.result, ps, { weight: 600, last: !c.takeaway }) +
    (c.takeaway ? kicker(r, 'Para recordar', ps, { margin: `${D(r, 16)}px 0 6px 0` }) + paragraphs(r, c.takeaway, ps, { last: true, secondary: true }) : '');
  const inner =
    sectionKicker(r, 'Ejemplo resuelto', s) +
    heading(r, 'h4', c.title, s, 'title') +
    paragraphs(r, c.situation, s) +
    kicker(r, 'Datos del caso (ilustrativos)', s, { margin: `${D(r, 20)}px 0 4px 0` }) +
    bareList(r, 'ul', data, 'cvc-cols2 cvc-we-data') +
    kicker(r, 'Resolución paso a paso', s, { margin: `${D(r, 24)}px 0 4px 0` }) +
    bareList(r, 'ol', steps, 'cvc-steps') +
    `<div${st(r, [['margin', `${D(r, 20)}px 0 0 0`]])}>${panel(r, result, ps, { cls: 'cvc-we-result', border: readable(ps.bg, [r.t.color.success], r.t.color.border), borderWidth: 2 })}</div>`;
  return componentWrap(r, 'worked_example', inner, s);
}

const DIAGRAM_KIND_LABEL: Record<VcDiagram['kind'], string> = {
  cycle: 'Ciclo',
  flow: 'Flujo',
  hierarchy: 'Estructura',
  matrix: 'Matriz',
};

/** Nodo de diagrama: etiqueta (h5) + detalle opcional. En ENHANCED el CSS lo convierte en caja. */
function diagramNode(r: R, n: { label: string; detail?: string }, s: Surf, idx: string | null, cls: string): string {
  const num = idx === null ? '' : `<span class="cvc-dg-i"${st(r, [['color', readable(s.bg, [r.t.color.accentStrong, r.t.color.accent], s.fg)], ['font-family', r.t.personality.fontNumeral], ['font-weight', '700']], [['font-variant-numeric', 'tabular-nums']])}>${labelHtml(idx)}</span> `;
  return (
    `<li class="cvc-dg-node ${cls}"${st(r, [['margin', `0 0 ${D(r, 10)}px 0`], ['padding', '10px 14px'], ['background-color', s.bg], ['color', s.fg], ['border', `1px solid ${r.t.color.borderStrong}`]], [['border-radius', r.t.shape.radiusMd]])}>` +
    `<p${st(r, [['margin', 0], ['padding', 0], ['color', s.fg], ['font-weight', '700'], ['line-height', '1.35']])}>${num}${inlineHtml(n.label)}</p>` +
    (n.detail ? paragraphs(r, n.detail, s, { last: true, secondary: true }) : '') +
    `</li>`
  );
}

/** Anillo decorativo (solo ENHANCED, aria-hidden, sin texto): un punto por etapa y el sentido de giro. */
function cycleRing(r: R, n: number, s: Surf): string {
  const acc = readable(s.bg, [r.t.color.accent, r.t.color.accentStrong], r.t.color.borderStrong);
  const R0 = 70;
  const dots = Array.from({ length: n }, (_, i) => {
    const a = -Math.PI / 2 + (2 * Math.PI * i) / n;
    const x = (100 + R0 * Math.cos(a)).toFixed(1);
    const y = (100 + R0 * Math.sin(a)).toFixed(1);
    return `<circle cx="${x}" cy="${y}" r="${i === 0 ? 11 : 9}" fill="${acc}"/>`;
  }).join('');
  return (
    `<svg class="cvc-dg-ring" viewBox="0 0 200 200" width="160" height="160" aria-hidden="true" focusable="false">` +
    `<circle cx="100" cy="100" r="${R0}" fill="none" stroke="${r.t.color.borderStrong}" stroke-width="3"/>` +
    `<path d="M150 42 L162 50 L148 56 Z" fill="${r.t.color.borderStrong}"/>` +
    dots +
    `</svg>`
  );
}

function renderDiagram(r: R, c: VcDiagram): string {
  const s = ground(r);
  const nodes = list(c.nodes, 'diagram.nodes');
  if (typeof c.kind !== 'string' || !hasOwn(DIAGRAM_KIND_LABEL, c.kind)) renderFail(`diagram: forma desconocida "${String(c.kind)}"`);
  if (c.kind === 'matrix' && nodes.length !== 4) renderFail('diagram: una matriz necesita exactamente 4 nodos');
  if (c.kind === 'hierarchy' && nodes.length < 2) renderFail('diagram: una jerarquía necesita raíz y al menos un hijo');
  const head =
    sectionKicker(r, `Diagrama · ${DIAGRAM_KIND_LABEL[c.kind]}`, s) +
    heading(r, 'h4', c.title, s, 'title') +
    (c.caption ? paragraphs(r, c.caption, s, { secondary: true }) : '');
  let body = '';
  if (c.kind === 'cycle' || c.kind === 'flow') {
    const items = nodes.map((n, i) => diagramNode(r, n, s, String(i + 1), c.kind === 'flow' ? 'cvc-dg-step' : 'cvc-dg-stage')).join('');
    const loop = c.kind === 'cycle' ? paragraphs(r, `Después de «${nodes[nodes.length - 1].label}», el ciclo vuelve a empezar en «${nodes[0].label}».`, s, { secondary: true, last: true }) : '';
    // Flujos largos (> 4 pasos) quedan en columna también en pantallas anchas: una fila que se parte
    // dejaría flechas apuntando al vacío al final de cada fila.
    body =
      `<div class="cvc-dg cvc-dg-${c.kind}${c.kind === 'flow' && nodes.length > 4 ? ' cvc-dg-long' : ''}">` +
      (c.kind === 'cycle' && r.enh ? cycleRing(r, nodes.length, s) : '') +
      `<div class="cvc-dg-body">${bareList(r, 'ol', items, 'cvc-dg-list')}${loop}</div>` +
      `</div>`;
  } else if (c.kind === 'hierarchy') {
    const [root, ...kids] = nodes;
    const ps = surf(r.t, panelBg(r));
    const rootBox =
      `<div class="cvc-dg-root"${st(r, [['margin', `0 0 ${D(r, 12)}px 0`], ['padding', '12px 16px'], ['background-color', ps.bg], ['color', ps.fg], ['border', `2px solid ${readable(ps.bg, [r.t.color.accent, r.t.color.accentStrong], r.t.color.borderStrong)}`]], [['border-radius', r.t.shape.radiusMd]])}>` +
      `<p${st(r, [['margin', 0], ['padding', 0], ['color', ps.fg], ['font-weight', '700']])}>${inlineHtml(root.label)}</p>` +
      (root.detail ? paragraphs(r, root.detail, ps, { last: true, secondary: true }) : '') +
      `</div>`;
    body = `<div class="cvc-dg cvc-dg-hierarchy">${rootBox}${bareList(r, 'ul', kids.map((n) => diagramNode(r, n, s, null, 'cvc-dg-child')).join(''), 'cvc-dg-kids')}</div>`;
  } else {
    // matrix: tabla 2×2 real (sobrevive a forceclean y cabe a 390 px); ejes como encabezados.
    const ps = surf(r.t, panelBg(r));
    const cell = (n: { label: string; detail?: string }, hi: boolean): string => {
      const x = hi ? ps : s;
      return (
        `<td class="cvc-dg-q"${st(r, [['background-color', x.bg], ['color', x.fg], ['border', `1px solid ${r.t.color.borderStrong}`], ['padding', '12px 14px'], ['vertical-align', 'top'], ['width', '50%']])}>` +
        `<p${st(r, [['margin', 0], ['padding', 0], ['color', x.fg], ['font-weight', '700']])}>${inlineHtml(n.label)}</p>` +
        (n.detail ? paragraphs(r, n.detail, x, { last: true, secondary: true }) : '') +
        `</td>`
      );
    };
    const axis = (text: string) => `<p class="cvc-dg-axis"${st(r, [['margin', '0 0 8px 0'], ['padding', 0], ['color', s.fg2], ['font-size', r.t.typography.sizeSmallPx], ['font-weight', '600']])}>${inlineHtml(text)}</p>`;
    body =
      `<div class="cvc-dg cvc-dg-matrix">` +
      axis(`Eje horizontal: ${c.x_axis ?? ''} (más a la derecha = más)`) +
      axis(`Eje vertical: ${c.y_axis ?? ''} (más arriba = más)`) +
      `<table${st(r, [['border-collapse', 'collapse'], ['width', '100%'], ['margin', 0]])}><tbody>` +
      `<tr>${cell(nodes[0], false)}${cell(nodes[1], false)}</tr>` +
      `<tr>${cell(nodes[2], false)}${cell(nodes[3], false)}</tr>` +
      `</tbody></table></div>`;
  }
  return componentWrap(r, 'diagram', head + body, s);
}

const RENDERERS: { [K in VcComponent['type']]: (r: R, c: Extract<VcComponent, { type: K }>) => string } = {
  hero: renderHero,
  learning_objectives: renderLearningObjectives,
  concept_cards: renderConceptCards,
  reveal_cards: renderRevealCards,
  accordion: renderAccordion,
  tabs: renderTabs,
  timeline: renderTimeline,
  process_steps: renderProcessSteps,
  comparison: renderComparison,
  myth_reality: renderMythReality,
  case_scenario: renderCaseScenario,
  checklist: renderChecklist,
  reflection: renderReflection,
  callout: renderCallout,
  summary_visual: renderSummaryVisual,
  self_check: renderSelfCheck,
  worked_example: renderWorkedExample,
  diagram: renderDiagram,
};

function renderWith(r: R, c: VcComponent): string {
  if (!c || typeof c !== 'object') renderFail('componente no es un objeto');
  const type = (c as { type?: unknown }).type;
  // hasOwn: "constructor", "toString", "__proto__"… no son tipos (I5)
  if (typeof type !== 'string' || !hasOwn(RENDERERS, type)) renderFail(`tipo de componente desconocido "${String(type)}"`);
  const fn = (RENDERERS as Record<string, (r: R, c: VcComponent) => string>)[type];
  return fn(r, c);
}

// ─── API pública ────────────────────────────────────────────────────────────

/** Un componente → HTML (sin <style>/<script>; esos van una vez por label en renderMovement). */
export function renderComponent(c: VcComponent, theme: ResolvedTheme, ctx: VcRenderContext): string {
  checkCtx(ctx);
  checkTheme(theme);
  return renderWith({ t: theme, enh: ctx.level === 'enhanced', uid: ctx.uid, seq: 0, opener: ctx.opener, countless: !!ctx.countless }, c);
}

/** Estilos de la raíz de un label (compartidos con el shell): lámina en familias oscuras, abierta en claras. */
export function labelRootStyle(theme: ResolvedTheme, enh: boolean): string {
  const ty = theme.typography;
  const plate = !!theme.personality && theme.personality.plate;
  const safe: Decl[] = [
    ['background-color', groundColor(theme)],
    ['color', theme.color.textPrimary],
    ['font-family', ty.fontBody],
    ['font-size', ty.sizeBodyPx],
    ['line-height', String(ty.lineBody)],
    ['margin', 0],
    ['padding', plate ? '24px' : '8px 4px'],
    ['max-width', '100%'],
  ];
  const e: Decl[] = plate ? [['border-radius', theme.shape.radiusLg], ['padding', 'clamp(20px, 3.2vw, 44px)'], ['overflow-wrap', 'break-word']] : [['overflow-wrap', 'break-word']];
  const decls = enh ? [...safe, ...e] : safe;
  return ` style="${attr(decls.map(([k, v]) => `${k}:${typeof v === 'number' ? `${v}px` : v}`).join(';'))}"`;
}

/** Un movimiento → cuerpo completo de UN label Moodle. `opener` aplica al primer hero. */
export function renderMovement(components: VcComponent[], theme: ResolvedTheme, ctx: VcRenderContext): string {
  checkCtx(ctx, MOVEMENT_UID_MAX);
  checkTheme(theme);
  if (!Array.isArray(components) || components.length === 0) renderFail('un movimiento necesita al menos un componente');
  const enh = ctx.level === 'enhanced';
  const r: R = { t: theme, enh, uid: ctx.uid, seq: 0 };
  let openerUsed = false;
  const body = components
    .map((c, i) => {
      const useOpener = !!ctx.opener && !openerUsed && i === 0 && c && (c as { type?: unknown }).type === 'hero';
      if (useOpener) openerUsed = true;
      return renderComponent(c, theme, { uid: `${ctx.uid}-${i}`, level: ctx.level, opener: useOpener ? ctx.opener : undefined });
    })
    .join('');
  const style = enh ? `<style>${scopedStyle(ctx.uid, theme)}</style>` : '';
  const script = enh ? `<script>${runtimeScript(ctx.uid)}</script>` : '';
  const plateCls = theme.personality && theme.personality.plate ? ' cvc-plate' : '';
  return `<div class="cvc cvc-${ctx.uid}${plateCls}"${ea(r, { 'data-cvc-uid': ctx.uid, 'data-cvc-v': '2' })} lang="es"` + labelRootStyle(theme, enh) + `>${style}${body}${script}</div>`;
}
