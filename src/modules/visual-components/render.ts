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
 *
 * P3 (EV6 sistema visual educativo 2.0): cada bloque abre con su RÓTULO (ícono + etiqueta del rol
 * pedagógico, en el color del rol) y toma la FORMA de su rol (ficha tintada, riel de pasos, expediente,
 * par error/correcto, árbol, pausa, figura enmarcada). La estructura (apertura, objetivos, síntesis,
 * repaso) usa el color del MÓDULO (ctx.module). `why` / `apply` (opcionales) se muestran como «Por qué
 * importa:» bajo el título y «Cómo lo aplicas:» al pie; sin ellos no se muestra nada (experiencias viejas).
 * Un acordeón cuyos encabezados son «Paso N: …» se dibuja como proceso (pasos siempre visibles).
 */
import { contrastRatio, isValidHex, ModuleColor, ResolvedTheme, EduBlockRole } from '../theme-engine';
import { EduIcon, Tone, eduIcon, moduleTone, roleTone } from './edu';
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
  VcDecisionBranch,
  VcDecisionDiagram,
  VcDecisionNode,
  VcNodeDiagram,
} from './schema';
import { HYPHEN_HEADING, HYPHEN_TABLE, HyphenOpts, inlineHtml, labelHtml, richParagraphs } from './text';
import { runtimeScript, scopedStyle } from './runtime';

export type VcRenderLevel = 'enhanced';

/**
 * P3 — generación del lenguaje visual del renderer (entra en VC_RENDERER_VERSION → clave de reuse del
 * paquete): un cambio de estilo que no toca el schema ni el runtime JS igual debe re-empaquetar.
 * 1 = R14-A/EV4 (diseño editorial), 2 = sistema visual educativo 2.0.
 */
export const VC_RENDER_STYLE_VERSION = 2;

/** R14-A — contexto de apertura de capítulo: el título del capítulo es el pico de la página. */
export interface VcOpener {
  /** Línea meta, p. ej. "Módulo 1 · Capítulo 2". */
  kicker: string;
  /** Título del capítulo (display, <h2>). */
  title: string;
  /** Numeral grande (p. ej. "02"); opcional. */
  numeral?: string;
  /** P3 — línea de progreso «Módulo 1 · Capítulo 2 de 6» (de facts); reemplaza a `kicker` si está. */
  progress?: string;
  /** P3 — minutos estimados del capítulo (de facts). */
  minutes?: number;
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
  /** P3 — color del módulo del capítulo (moduleColor del tema): apertura, síntesis, repaso. */
  module?: ModuleColor;
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
  mod?: ModuleColor;
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
  if (!t.blocks) renderFail('tema sin blocks (P3)');
  for (const [role, b] of Object.entries(t.blocks)) for (const [k, v] of Object.entries(b)) if (!isValidHex(v)) renderFail(`tema: blocks.${role}.${k} no es #RRGGBB`);
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


// ─── Primitivas tipográficas ────────────────────────────────────────────────

/** Ritmo: los componentes "mayores" respiran más antes del siguiente (64 vs 44, × densidad). */
const MAJOR_TYPES = new Set(['hero', 'process_steps', 'comparison', 'summary_visual', 'case_scenario', 'timeline', 'accordion', 'concept_cards', 'tabs', 'worked_example', 'diagram']);

function componentWrap(r: R, type: string, inner: string, s: Surf, extraSafe: Decl[] = [], extraEnh: Decl[] = [], cls = ''): string {
  const ty = r.t.typography;
  const gap = D(r, MAJOR_TYPES.has(type) ? 56 : 40);
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

/** Mismo texto visible (sin énfasis, puntuación, mayúsculas ni espacios extra). */
function sameText(a: string | undefined, b: string | undefined): boolean {
  const n = (x: string | undefined) => String(x ?? '').replace(/\*+/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return !!n(a) && n(a) === n(b);
}

/** Título legado «Nombre + descripción» cuyo nombre es el título del capítulo ya mostrado. */
function startsWithTitle(a: string | undefined, title: string | undefined): boolean {
  const n = (x: string | undefined) => String(x ?? '').replace(/\*+/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const t = n(title);
  return t.length >= 20 && n(a).startsWith(t + ' ') && n(a).length > 80;
}

/** El título del LLM que repetiría el kicker de objetivos (evita «Objetivos de aprendizaje» dos veces). */
const OBJ_KICKER_RE = /^objetivos( de aprendizaje)?[.:]?$/i;

/** Borde de una superficie tintada: en familias con lámina (oscuras) el tinte casi no se distingue del fondo. */
function edgeOf(r: R, s: Surf): string {
  return r.t.personality.plate ? r.t.color.border : s.bg;
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


/** "Paso 3: Frota…" → "Frota…" (el numeral ya dice el orden). */
const STEP_PREFIX_RE = /^\s*(?:paso|etapa|fase|step)\s*\d{1,2}\s*[:.\-–—)]\s*/i;
function stripStepPrefix(h: string): string {
  const out = h.replace(STEP_PREFIX_RE, '');
  return out.trim() ? out : h;
}

// ─── Componentes (una función por tipo) ─────────────────────────────────────




/** Cuerpo de las tarjetas de revelado (título + tarjetas); el rótulo lo pone renderReveal. */
function revealCardsBody(r: R, c: VcRevealCards): string {
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
  return titleIf(r, c.title, s) + bareList(r, 'ul', items, 'cvc-cols2 cvc-cards');
}


function tabsBody(r: R, c: VcTabs, afterTitle = ''): string {
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
  return titleIf(r, c.title, s, undefined, titleId) + afterTitle + box;
}

function timelineBody(r: R, c: VcTimeline, afterTitle = ''): string {
  const s = ground(r);
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
  const axis = `<ol class="cvc-axis"${ea(r, { role: 'list' })}${st(r, [['list-style', 'none'], ['margin', '0 0 0 6px'], ['padding', `${D(r, 4)}px 0 0 0`]])}>${events}</ol>`;
  return titleIf(r, c.title, s) + afterTitle + axis;
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

function comparisonBody(r: R, c: VcComparison, afterTitle = ''): string {
  const s = ground(r);
  const rawColumns = list(c.columns, 'comparison.columns');
  const rawRows = list(c.rows, 'comparison.rows');
  const legacy = normalizeLegacyLabelColumn(rawColumns, rawRows);
  const columns = legacy ? legacy.columns : rawColumns;
  const rows = legacy ? legacy.rows : rawRows;
  const titleId = r.enh && c.title ? nextId(r, 'cmp') : undefined;
  const body = columns.length > VC_TABLE_MAX_COLUMNS ? comparisonStack(r, columns, rows, c.title) : comparisonTable(r, columns, rows, titleId);
  return titleIf(r, c.title, s, undefined, titleId) + afterTitle + body;
}








function selfCheckBody(r: R, c: VcSelfCheck): string {
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
  return titleIf(r, c.title, s, 'Repaso rápido') + bareList(r, 'ol', items);
}

/**
 * Edu Phase A — ejemplo resuelto: situación → datos (ilustrativos) → resolución paso a paso →
 * resultado (panel, la única superficie) → para recordar. Todo abierto: es contenido, no revelado.
 */

const DIAGRAM_KIND_LABEL: Record<VcDiagram['kind'], string> = {
  cycle: 'Ciclo',
  flow: 'Flujo',
  hierarchy: 'Estructura',
  matrix: 'Matriz',
  decision: 'Decisión',
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

// ─── EV6 — árbol de decisión ────────────────────────────────────────────────
//
// CLEAN_SAFE (sin flex/grid ni <style>): la pregunta es una caja DELINEADA; cada rama abre con su
// píldora («Sí:» / «No:»; ENHANCED le suma el conector ↙ / ↘) y termina en una acción (caja TINTADA) o en otra pregunta. Un par de
// acciones finales en los dos primeros niveles va lado a lado en una <table> de 2 columnas (lo único
// que da columnas bajo forceclean y cabe a 390 px); una rama que abre otra pregunta se apila con un
// filete de 1 px a la izquierda (nunca se aprieta un subárbol en media columna de teléfono).
// ENHANCED: el <style> del label pone las ramas en dos columnas desde 600 px (nivel 1) y 960 px (nivel 2).
// Orden de lectura (y texto sin estilos): pregunta → «Sí» → su rama → «No» → su rama.

const DECISION_DEFAULT_LABEL = { yes: 'Sí', no: 'No' } as const;
/** Pares de acciones finales lado a lado solo hasta este nivel (más adentro se apilan). */
const DECISION_TABLE_MAX_DEPTH = 2;
/** Tope de recursión del renderer (el validador limita a 3 niveles; esto solo evita un árbol hostil). */
const DECISION_RENDER_MAX_DEPTH = 8;

/**
 * Píldora de la rama («Sí:» / «No:»). El texto plano (lectores de pantalla, Moodle sin estilos) dice
 * «Sí: …» / «No: …»: los dos puntos van FUERA del <span class="nolink"> (rótulo del renderer) y el
 * conector ↙ / ↘ es decorativo: lo dibuja SOLO el <style> de ENHANCED (::before, texto alternativo
 * vacío). Los dos puntos se ven en ambos niveles (ningún texto de un label se oculta). En CLEAN_SAFE el
 * conector es el filete o la barra.
 * `bar`: en un par lado a lado la columna es angosta (≈150 px a 390): el rótulo va en una barra de
 * bloque delineada que envuelve limpio, no en un <span> con borde que se partiría en dos líneas.
 */
function decisionPill(r: R, side: 'yes' | 'no', label: string | undefined, s: Surf, bar = false): string {
  const acc = readable(s.bg, [r.t.color.accentStrong, r.t.color.accent], s.fg);
  const text = (label !== undefined ? inlineHtml(label, HYPHEN_TABLE) : labelHtml(DECISION_DEFAULT_LABEL[side])) + '<span class="cvc-dt-sep">:</span>';
  if (bar) {
    return (
      `<p class="cvc-dt-pill cvc-dt-bar"${st(
        r,
        [['background-color', s.bg], ['color', acc], ['border', `2px solid ${acc}`], ['margin', `0 0 ${D(r, 8)}px 0`], ['padding', '2px 10px'], ['font-weight', '700'], ['line-height', '1.5'], ['text-align', 'center']],
        [['border-radius', '999px']],
      )}><span class="cvc-dt-lbl">${text}</span></p>`
    );
  }
  return (
    `<p class="cvc-dt-pill"${st(r, [['margin', `0 0 ${D(r, 8)}px 0`], ['padding', 0], ['color', s.fg], ['line-height', '1.6']])}>` +
    `<span class="cvc-dt-lbl"${st(
      r,
      [['background-color', s.bg], ['color', acc], ['border', `2px solid ${acc}`], ['padding', '2px 12px'], ['font-weight', '700']],
      [['border-radius', '999px'], ['display', 'inline-block']],
    )}>${text}</span></p>`
  );
}

function decisionAction(r: R, text: string): string {
  const ps = surf(r.t, panelBg(r));
  return (
    `<div class="cvc-dt-act"${st(r, [['background-color', ps.bg], ['color', ps.fg], ['border', `1px solid ${edgeOf(r, ps)}`], ['margin', 0], ['padding', '12px 14px']], [['border-radius', r.t.shape.radiusMd]])}>` +
    `<p${st(r, [['margin', 0], ['padding', 0], ['color', ps.fg], ['font-weight', '600'], ['line-height', '1.45']])}>${inlineHtml(text)}</p>` +
    `</div>`
  );
}

function decisionQuestion(r: R, q: string, s: Surf, depth: number): string {
  const acc = readable(s.bg, [r.t.color.accent, r.t.color.accentStrong], r.t.color.borderStrong);
  return (
    `<div class="cvc-dt-q"${st(r, [['background-color', s.bg], ['color', s.fg], ['border', `2px solid ${acc}`], ['margin', `0 0 ${D(r, 12)}px 0`], ['padding', '12px 16px']], [['border-radius', r.t.shape.radiusMd]])}>` +
    kicker(r, depth === 1 ? 'Pregunta' : 'Siguiente pregunta', s, { margin: '0 0 4px 0' }) +
    `<p class="cvc-dt-qt"${st(r, [['margin', 0], ['padding', 0], ['color', s.fg], ['font-size', depth === 1 ? r.t.typography.sizeItemPx : r.t.typography.sizeBodyPx], ['font-weight', '700'], ['line-height', '1.35']])}>${inlineHtml(q)}</p>` +
    `</div>`
  );
}

function decisionBranchBody(r: R, b: VcDecisionBranch, s: Surf, depth: number): string {
  if (b.tree !== undefined) return decisionNode(r, b.tree, s, depth + 1);
  if (typeof b.action !== 'string') renderFail('diagram: una rama de decisión necesita "action" o "tree"');
  return decisionAction(r, b.action);
}

function decisionNode(r: R, n: VcDecisionNode, s: Surf, depth: number): string {
  if (depth > DECISION_RENDER_MAX_DEPTH) renderFail('diagram: árbol de decisión demasiado profundo');
  if (!n || typeof n !== 'object' || typeof n.question !== 'string' || !n.yes || typeof n.yes !== 'object' || !n.no || typeof n.no !== 'object') {
    renderFail('diagram: nodo de decisión inválido (se espera {question, yes, no})');
  }
  const sides = ['yes', 'no'] as const;
  let branches: string;
  if (n.yes.tree === undefined && n.no.tree === undefined && depth <= DECISION_TABLE_MAX_DEPTH) {
    // Dos acciones finales: lado a lado, cada columna encabezada por su barra ↙ Sí / ↘ No.
    const cell = (side: 'yes' | 'no') =>
      `<td class="cvc-dt-br cvc-dt-${side}"${st(r, [['background-color', s.bg], ['color', s.fg], ['width', '50%'], ['vertical-align', 'top'], ['padding', side === 'yes' ? '0 6px 0 0' : '0 0 0 6px']])}>` +
      decisionPill(r, side, n[side].label, s, true) +
      decisionBranchBody(r, n[side], s, depth) +
      `</td>`;
    branches = `<table class="cvc-dt-pair"${st(r, [['border-collapse', 'collapse'], ['width', '100%'], ['margin', 0]])}><tbody><tr>${cell('yes')}${cell('no')}</tr></tbody></table>`;
  } else {
    const br = (side: 'yes' | 'no') =>
      `<div class="cvc-dt-br cvc-dt-${side}"${st(r, [['margin', side === 'yes' ? `0 0 ${D(r, 16)}px 0` : '0'], ['padding', '0 0 0 14px'], ['border-left', `1px solid ${r.t.color.borderStrong}`]])}>` +
      decisionPill(r, side, n[side].label, s) +
      decisionBranchBody(r, n[side], s, depth) +
      `</div>`;
    branches = `<div class="cvc-dt-branches">${sides.map(br).join('')}</div>`;
  }
  return `<div class="cvc-dt-node cvc-dt-d${depth}">${decisionQuestion(r, n.question, s, depth)}${branches}</div>`;
}


/** Cuerpo de un diagrama de nodos (título + leyenda + dibujo); el rótulo lo pone renderDiagram. */
function nodeDiagramBody(r: R, c: VcNodeDiagram, afterTitle = ''): string {
  const s = ground(r);
  const nodes = list(c.nodes, 'diagram.nodes');
  if (typeof c.kind !== 'string' || !hasOwn(DIAGRAM_KIND_LABEL, c.kind)) renderFail(`diagram: forma desconocida "${String(c.kind)}"`);
  if (c.kind === 'matrix' && nodes.length !== 4) renderFail('diagram: una matriz necesita exactamente 4 nodos');
  if (c.kind === 'hierarchy' && nodes.length < 2) renderFail('diagram: una jerarquía necesita raíz y al menos un hijo');
  const head =
    heading(r, 'h4', c.title, s, 'title') +
    afterTitle +
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
  return head + body;
}

// ─── P3 — Sistema visual educativo 2.0 ──────────────────────────────────────
//
// Cada bloque pedagógico abre con su RÓTULO (ícono + etiqueta del rol, en el color del rol) y toma
// la FORMA de su rol: concepto = ficha tintada · ejemplo = franjas (datos → pasos → resultado) ·
// caso = expediente con cabecera · error = par error/correcto · proceso = riel numerado abierto ·
// decisión = árbol · reflexión = pausa tintada cálida · recurso visual = figura enmarcada.
// Estructura (apertura, objetivos, síntesis, repaso) usa el COLOR DEL MÓDULO.
// `why` / `apply` (opcionales) responden «¿Por qué importa?» / «¿Cómo lo aplicas?».

function tn(r: R, role: EduBlockRole): Tone {
  return roleTone(r.t, role);
}

function modTn(r: R): Tone {
  if (r.mod) return moduleTone(r.t, r.mod, groundColor(r.t));
  const c = r.t.color;
  return { ink: c.accentStrong, soft: c.accentSoft, edge: c.border, fill: c.accentStrong, onFill: c.textOnAccent };
}

/** Tema derivado: el acento y la superficie de panel pasan a ser los del tono (reusa los dibujos existentes). */
function tinted(r: R, k: Tone): R {
  const plate = !!r.t.personality.plate;
  const color = { ...r.t.color, accent: k.ink, accentStrong: k.ink, ...(plate ? { surface: k.soft } : { surfaceAlt: k.soft }) };
  return { ...r, t: { ...r.t, color } };
}

/** Rótulo del bloque: ícono + etiqueta en el color del rol. ENHANCED: píldora. */
function chip(r: R, icon: EduIcon, label: string, k: Tone, s: Surf, opts: { margin?: string; onPanel?: boolean } = {}): string {
  const ink = readable(s.bg, [k.ink], s.fg);
  const pill = opts.onPanel ? groundColor(r.t) : k.soft;
  return (
    `<p class="cvc-meta cvc-chip"` +
    st(
      r,
      [
        ['margin', opts.margin ?? `0 0 ${D(r, 12)}px 0`],
        ['color', ink],
        ['font-family', r.t.personality.fontMeta],
        ['font-size', r.t.typography.sizeSmallPx],
        ['font-weight', '700'],
        ['line-height', '1.4'],
        ['letter-spacing', '0.01em'],
      ],
      [['display', 'inline-flex'], ['align-items', 'center'], ['gap', '8px'], ['background-color', pill], ['padding', '5px 14px 5px 10px'], ['border-radius', '999px']],
    ) +
    `>${eduIcon(r.enh, icon, ink, 20)} <span class="cvc-chip-t">${labelHtml(label)}</span></p>`
  );
}

/** «¿Por qué importa?» bajo el título (opcional, generado). */
function whyLine(r: R, why: string | undefined, k: Tone, s: Surf): string {
  if (!why || !why.trim()) return '';
  const ink = readable(s.bg, [k.ink], s.fg);
  return (
    `<p class="cvc-why"${st(r, [['margin', `0 0 ${D(r, 18)}px 0`], ['padding', 0], ['color', s.fg2], ['font-size', r.t.typography.sizeBodyPx], ['line-height', '1.5'], ['max-width', `${r.t.typography.measureCh}ch`]])}>` +
    `<strong${st(r, [['color', ink]])}>${labelHtml('Por qué importa: ')}</strong>${inlineHtml(why)}</p>`
  );
}

/** «¿Cómo lo aplicas?» al pie del bloque (opcional, generado). */
function applyLine(r: R, apply: string | undefined, k: Tone, s: Surf): string {
  if (!apply || !apply.trim()) return '';
  const ink = readable(s.bg, [k.ink], s.fg);
  return (
    `<div class="cvc-apply"${st(r, [['margin', `${D(r, 20)}px 0 0 0`], ['padding', `${D(r, 14)}px 0 0 0`], ['color', s.fg], ['border-top', `1px solid ${k.edge}`]])}>` +
    `<p${st(r, [['margin', 0], ['padding', 0], ['color', s.fg], ['line-height', '1.5'], ['max-width', `${r.t.typography.measureCh}ch`]])}>` +
    `${eduIcon(r.enh, 'flecha', ink, 18)} <strong${st(r, [['color', ink]])}>${labelHtml('Cómo lo aplicas: ')}</strong>${inlineHtml(apply)}</p></div>`
  );
}

type Shape = 'open' | 'tinted' | 'framed';

/** Contenedor del bloque según su forma. */
function block(r: R, type: string, shape: Shape, k: Tone, inner: (s: Surf) => string, cls = ''): string {
  const g = ground(r);
  if (shape === 'open') return componentWrap(r, type, inner(g), g, [], [], cls);
  const s = shape === 'tinted' ? surf(r.t, k.soft) : g;
  return componentWrap(
    r,
    type,
    inner(s),
    s,
    // Figura enmarcada: 16 px a los lados en la base (una tabla de 2 columnas cabe a 390 px dentro de la lámina oscura).
    [['padding', shape === 'tinted' ? `${D(r, 24)}px ${D(r, 24)}px` : `${D(r, 20)}px 16px`], ['border', `1px solid ${k.edge}`]],
    [['border-radius', r.t.shape.radiusLg], ['padding', `clamp(16px, 3vw, ${D(r, 32)}px)`]],
    cls,
  );
}

const why = (c: VcComponent): string | undefined => (c as { why?: string }).why;
const apply = (c: VcComponent): string | undefined => (c as { apply?: string }).apply;

/** Insignia rellena (número de paso / capítulo) en el tono dado. */
function fillBadge(r: R, text: string, k: Tone, px = 36, iconHtml?: string): string {
  return (
    `<div class="cvc-badge"` +
    st(
      r,
      [
        ['width', `${px}px`],
        ['margin', '0 0 8px 0'],
        ['background-color', k.fill],
        ['color', k.onFill],
        ['font-family', r.t.personality.fontNumeral],
        ['font-size', px >= 44 ? r.t.typography.sizeItemPx : r.t.typography.sizeSmallPx],
        ['font-weight', '700'],
        ['line-height', `${px}px`],
        ['text-align', 'center'],
      ],
      [['border-radius', '50%'], ['font-variant-numeric', 'tabular-nums lining-nums']],
    ) +
    `>${iconHtml ?? labelHtml(text)}</div>`
  );
}

// ── Apertura ──
function renderHero(r: R, c: VcHero): string {
  const op = r.opener;
  if (!op) {
    const g = ground(r);
    return componentWrap(r, 'hero', (c.eyebrow ? kicker(r, c.eyebrow, g, { llm: true }) : '') + heading(r, 'h4', c.title, g, 'display') + paragraphs(r, c.lead, g, { role: 'lead', last: true }), g);
  }
  const k = modTn(r);
  const s = surf(r.t, k.soft);
  const ink = readable(s.bg, [k.ink], s.fg);
  const meta =
    `<p class="cvc-meta cvc-progress"${st(r, [['margin', `0 0 ${D(r, 10)}px 0`], ['padding', 0], ['color', ink], ['font-family', r.t.personality.fontMeta], ['font-size', r.t.typography.sizeSmallPx], ['font-weight', '700'], ['line-height', '1.5']])}>` +
    labelHtml(op.progress ?? op.kicker) +
    (op.minutes ? `<span class="cvc-sep"${st(r, [['color', s.fg2]])}>${labelHtml('  ·  ')}</span><span class="cvc-min"${st(r, [['color', ink]], [['white-space', 'nowrap']])}>${eduIcon(r.enh, 'reloj', ink, 18)} ${labelHtml(`~${op.minutes} min`)}</span>` : '') +
    `</p>` +
    // el eyebrow del LLM (tema del capítulo) se conserva como segunda línea meta
    (c.eyebrow && c.eyebrow.trim() ? `<p class="cvc-meta cvc-topic"${st(r, [['margin', `0 0 ${D(r, 12)}px 0`], ['padding', 0], ['color', s.fg2], ['font-size', r.t.typography.sizeSmallPx], ['line-height', '1.4']])}>${inlineHtml(c.eyebrow)}</p>` : '');
  const main =
    heading(r, 'h2', op.title, s, 'display', { margin: `0 0 ${D(r, 14)}px 0` }) +
    (sameText(c.title, op.title) || startsWithTitle(c.title, op.title) ? '' : paragraphs(r, c.title, s, { role: 'statement', weight: 600 })) +
    paragraphs(r, c.lead, s, { role: 'lead', last: true });
  const num = op.numeral ? `<div class="cvc-op-num">${fillBadge(r, String(Number(op.numeral)), k, 52)}</div>` : '';
  const body = `<div class="cvc-op${num ? ' cvc-op-split' : ''}">${num}<div class="cvc-op-lead">${meta}</div><div class="cvc-op-main">${main}</div></div>`;
  return componentWrap(
    r,
    'hero',
    body,
    s,
    [['padding', `${D(r, 28)}px ${D(r, 24)}px`], ['border', `1px solid ${k.edge}`], ['border-top', `6px solid ${k.fill}`]],
    [['border-radius', r.t.shape.radiusLg], ['padding', 'clamp(18px, 3.6vw, 40px)']],
    'cvc-opener',
  );
}

function renderObjectives(r: R, c: VcLearningObjectives): string {
  const k = modTn(r);
  const items = list(c.items, 'learning_objectives.items');
  return block(r, 'learning_objectives', 'framed', k, (s) => {
    const lis = items
      .map(
        (it, i) =>
          `<li class="cvc-obj"${st(r, [['margin', 0], ['padding', `${D(r, 12)}px 0`], ['color', s.fg], ...(i === 0 ? [] : ([['border-top', `1px solid ${r.t.color.border}`]] as Decl[]))])}>` +
          // Labels del shell (countless): sin cifras que no salgan de facts → la insignia lleva un ícono.
          `<div class="cvc-li-n">${r.countless ? fillBadge(r, '', k, 30, eduIcon(r.enh, 'check', k.onFill, 16)) : fillBadge(r, String(i + 1), k, 30)}</div>` +
          `<div class="cvc-li-t"${st(r, [['color', s.fg]])}>${inlineHtml(it)}</div></li>`,
      )
      .join('');
    const title = c.title && !OBJ_KICKER_RE.test(c.title.trim()) ? c.title : r.countless ? 'Al terminar podrás:' : 'Al terminar este capítulo podrás:';
    return chip(r, 'objetivo', 'Objetivos de aprendizaje', k, s) + heading(r, 'h4', title, s, 'item', { margin: `0 0 ${D(r, 8)}px 0` }) + bareList(r, 'ol', lis, items.length >= 4 ? 'cvc-cols2 cvc-objs' : 'cvc-objs');
  });
}

// ── Concepto ──
function renderConcept(r: R, c: VcConceptCards): string {
  const k = tn(r, 'concepto');
  const cards = list(c.cards, 'concept_cards.cards');
  return block(r, 'concept_cards', 'tinted', k, (s) => {
    const ink = readable(s.bg, [k.ink], s.fg);
    const ht = itemTag(c.title, 'x');
    const rows = cards
      .map(
        (cd, i) =>
          `<li class="cvc-term"${st(r, [['margin', 0], ['padding', `${D(r, 14)}px 0`], ['color', s.fg], ...(i === 0 ? [] : ([['border-top', `1px solid ${k.edge}`]] as Decl[]))])}>` +
          `<${ht}${st(r, [['margin', '0 0 4px 0'], ['padding', 0], ['color', ink], ['font-family', r.t.typography.fontHeading], ['font-size', r.t.typography.sizeItemPx], ['font-weight', '700'], ['line-height', '1.3']])}>${inlineHtml(cd.term)}</${ht}>` +
          paragraphs(r, cd.definition, s, { last: true }) +
          `</li>`,
      )
      .join('');
    return chip(r, 'concepto', 'Concepto clave', k, s, { onPanel: true }) + titleIf(r, c.title, s, 'Conceptos clave') + whyLine(r, why(c), k, s) + bareList(r, 'ul', rows, 'cvc-cols2 cvc-terms') + applyLine(r, apply(c), k, s);
  });
}

// ── Proceso ──
function processRail(r: R, steps: { heading: string; body: string }[], k: Tone, s: Surf, ht: HTag): string {
  const lis = steps
    .map(
      (sp, i) =>
        `<li class="cvc-step cvc-rail-i"${st(r, [['margin', `0 0 ${D(r, 18)}px 0`], ['padding', 0], ['color', s.fg]])}>` +
        `<div class="cvc-step-n">${fillBadge(r, String(i + 1), k, 36)}</div>` +
        `<div class="cvc-step-b">${heading(r, ht, stripStepPrefix(sp.heading), s, 'item')}${paragraphs(r, sp.body, s, { last: true })}</div></li>`,
    )
    .join('');
  return bareList(r, 'ol', lis, 'cvc-steps cvc-rail');
}

function renderProcess(r: R, c: VcProcessSteps): string {
  const k = tn(r, 'proceso');
  const sps = list(c.steps, 'process_steps.steps');
  return block(r, 'process_steps', 'open', k, (s) =>
    chip(r, 'proceso', counted(r, 'Proceso paso a paso', sps.length, 'paso', 'pasos'), k, s) + titleIf(r, c.title, s) + whyLine(r, why(c), k, s) + processRail(r, sps, k, s, itemTag(c.title)) + applyLine(r, apply(c), k, s),
  );
}

/** Acordeón cuyos encabezados son pasos («Paso 1: …»): es un proceso → riel visible (nunca escondido). */
function looksLikeSteps(items: { heading: string }[]): boolean {
  return items.length >= 2 && items.filter((it) => STEP_PREFIX_RE.test(it.heading)).length >= Math.max(2, Math.ceil(items.length * 0.6));
}

function renderAccordion(r: R, c: VcAccordion): string {
  const its = list(c.items, 'accordion.items');
  if (looksLikeSteps(its)) {
    return renderProcess(r, { type: 'process_steps', title: c.title, steps: its.map((i) => ({ heading: i.heading, body: i.body })), ...({ why: why(c), apply: apply(c) } as object) } as VcProcessSteps);
  }
  const k = tn(r, 'concepto');
  return block(r, 'accordion', 'open', k, (s) => {
    const ht = itemTag(c.title);
    const rows = its
      .map((it, i) => {
        const h = heading(r, ht, it.heading, s, 'item', { margin: '0' });
        return row(r, reveal(r, 'cvc-acc', h, h, `<div${st(r, [['padding', '10px 0 0 0']])}>${paragraphs(r, it.body, s, { last: true })}</div>`, { keepOpen: i === 0 }), s, { cls: 'cvc-acc-row' });
      })
      .join('');
    return chip(r, 'concepto', 'Para profundizar', k, s) + titleIf(r, c.title, s) + whyLine(r, why(c), k, s) + `<div class="cvc-rows"${st(r, [['border-bottom', `1px solid ${r.t.color.border}`]])}>${rows}</div>` + applyLine(r, apply(c), k, s);
  });
}

function renderTabs(r: R, c: VcTabs): string {
  const k = tn(r, 'concepto');
  return block(r, 'tabs', 'open', k, (s) => chip(r, 'concepto', 'Perspectivas', k, s) + tabsBody(tinted(r, k), c, whyLine(r, why(c), k, s)) + applyLine(r, apply(c), k, s));
}



// ── Recurso visual ──
function renderTimeline(r: R, c: VcTimeline): string {
  const k = tn(r, 'visual');
  const evs = list(c.events, 'timeline.events');
  return block(r, 'timeline', 'framed', k, (s) => chip(r, 'visual', counted(r, 'Línea de tiempo', evs.length, 'hito', 'hitos'), k, s) + timelineBody(tinted(r, k), c, whyLine(r, why(c), k, s)) + applyLine(r, apply(c), k, s));
}

function renderComparison(r: R, c: VcComparison): string {
  const k = tn(r, 'visual');
  return block(r, 'comparison', 'framed', k, (s) => chip(r, 'visual', 'Comparación', k, s) + comparisonBody(tinted(r, k), c, whyLine(r, why(c), k, s)) + applyLine(r, apply(c), k, s));
}

function renderDiagram(r: R, c: VcDiagram): string {
  if (c.kind === 'decision') {
    const k = tn(r, 'decision');
    const r2 = tinted(r, k);
    if (!c.tree || typeof c.tree !== 'object') renderFail('diagram: un árbol de decisión necesita "tree"');
    return block(r, 'diagram', 'open', k, (s) =>
      chip(r, 'decision', 'Decisión', k, s) +
      titleIf(r, c.title, s) +
      whyLine(r, why(c), k, s) +
      (c.caption ? paragraphs(r, c.caption, s, { secondary: true }) : '') +
      `<div class="cvc-dg cvc-dg-decision">${decisionNode(r2, c.tree, s, 1)}</div>` +
      applyLine(r, apply(c), k, s),
    );
  }
  const k = tn(r, 'visual');
  const label = `Diagrama · ${DIAGRAM_KIND_LABEL[c.kind] ?? ''}`;
  return block(r, 'diagram', 'framed', k, (s) => chip(r, 'visual', label, k, s) + nodeDiagramBody(tinted(r, k), c, whyLine(r, why(c), k, s)) + applyLine(r, apply(c), k, s));
}

// ── Error frecuente ──
function renderMyth(r: R, c: VcMythReality): string {
  const k = tn(r, 'error');
  const ok = tn(r, 'ejemplo');
  const pairs = list(c.pairs, 'myth_reality.pairs');
  return block(r, 'myth_reality', 'open', k, (g) => {
    // `reveal`: «Lo correcto» queda tras un botón en ENHANCED (el estudiante piensa primero); en CLEAN_SAFE
    // y sin JS, rótulo + texto siempre visibles (mismo texto en ambos niveles).
    const cell = (kt: Tone, icon: EduIcon, label: string, body: string, extraCls: string, revealIdx?: number) => {
      const s = surf(r.t, kt.soft);
      const ink = readable(s.bg, [kt.ink], s.fg);
      const lead = `<p class="cvc-meta"${st(r, [['margin', '0 0 6px 0'], ['padding', 0], ['color', ink], ['font-size', r.t.typography.sizeSmallPx], ['font-weight', '700']])}>${eduIcon(r.enh, icon, ink, 18)} ${labelHtml(label)}</p>`;
      const content =
        revealIdx === undefined
          ? lead + body
          : reveal(tinted(r, kt), 'cvc-myth', btnLabel(tinted(r, kt), label, s), lead, body, { ariaLabel: `${label}: error ${revealIdx + 1}`, button: true });
      return (
        `<div class="${extraCls}"${st(r, [['background-color', s.bg], ['color', s.fg], ['border', `1px solid ${kt.edge}`], ['margin', `0 0 ${D(r, 10)}px 0`], ['padding', `${D(r, 16)}px ${D(r, 18)}px`]], [['border-radius', r.t.shape.radiusMd]])}>` +
        content +
        `</div>`
      );
    };
    const rows = pairs
      .map((p, i) => {
        const sm = surf(r.t, k.soft);
        const sr = surf(r.t, ok.soft);
        return (
          `<li class="cvc-mr"${st(r, [['margin', `0 0 ${D(r, 8)}px 0`], ['padding', 0], ['color', g.fg]])}>` +
          cell(k, 'error', 'Lo que se suele hacer', paragraphs(r, p.myth, sm, { last: true }), 'cvc-myth-a') +
          cell(ok, 'check', 'Lo correcto', paragraphs(r, p.reality, sr, { last: true, weight: 600 }), 'cvc-myth-b', i) +
          `</li>`
        );
      })
      .join('');
    return chip(r, 'error', 'Error frecuente', k, g) + titleIf(r, c.title, g) + whyLine(r, why(c), k, g) + bareList(r, 'ul', rows) + applyLine(r, apply(c), k, g);
  });
}

// ── Caso ──
function renderCase(r: R, c: VcCaseScenario): string {
  const k = tn(r, 'caso');
  const g = ground(r);
  const hs = surf(r.t, k.soft);
  const ink = readable(g.bg, [k.ink], g.fg);
  const head =
    `<div class="cvc-case-h"${st(r, [['background-color', hs.bg], ['color', hs.fg], ['margin', 0], ['padding', `${D(r, 18)}px ${D(r, 24)}px ${D(r, 14)}px ${D(r, 24)}px`], ['border-bottom', `1px solid ${k.edge}`]])}>` +
    chip(r, 'caso', 'Caso práctico', k, hs, { onPanel: true, margin: '0 0 10px 0' }) +
    heading(r, 'h4', c.title, hs, 'title', { margin: '0' }) +
    `</div>`;
  const qs = list(c.questions, 'case_scenario.questions')
    .map(
      (q, i) =>
        `<li class="cvc-q"${st(r, [['margin', '0 0 10px 0'], ['padding', 0], ['color', g.fg]])}>` +
        `<span class="cvc-q-n"${st(r, [['color', ink], ['font-family', r.t.personality.fontNumeral], ['font-weight', '700']])}>${labelHtml(`${i + 1}.`)}</span> ` +
        `<span class="cvc-q-t">${inlineHtml(q)}</span></li>`,
    )
    .join('');
  const body =
    `<div class="cvc-case-b"${st(r, [['background-color', g.bg], ['color', g.fg], ['margin', 0], ['padding', `${D(r, 20)}px ${D(r, 24)}px ${D(r, 22)}px ${D(r, 24)}px`]])}>` +
    whyLine(r, why(c), k, g) +
    paragraphs(r, c.narrative, g) +
    `<p class="cvc-meta"${st(r, [['margin', `${D(r, 18)}px 0 10px 0`], ['padding', 0], ['color', ink], ['font-size', r.t.typography.sizeSmallPx], ['font-weight', '700']])}>${eduIcon(r.enh, 'repaso', ink, 18)} ${labelHtml('Analiza el caso')}</p>` +
    bareList(r, 'ol', qs, 'cvc-qs') +
    applyLine(r, apply(c), k, g) +
    `</div>`;
  return componentWrap(r, 'case_scenario', head + body, g, [['border', `1px solid ${k.edge}`]], [['border-radius', r.t.shape.radiusLg], ['overflow', 'hidden']], 'cvc-case');
}

// ── Ejemplo / aplicación ──
function renderChecklist(r: R, c: VcChecklist): string {
  const k = tn(r, 'ejemplo');
  const its = list(c.items, 'checklist.items');
  return block(r, 'checklist', 'open', k, (s) => {
    const ink = readable(s.bg, [k.ink], s.fg);
    const items = its
      .map((it, i) => `<li class="cvc-check"${st(r, [['margin', 0], ['padding', `${D(r, 12)}px 0`], ['color', s.fg], ...(i === 0 ? [] : ([['border-top', `1px solid ${r.t.color.border}`]] as Decl[]))])}>${eduIcon(r.enh, 'check', ink, 20)} <span class="cvc-li-t">${inlineHtml(it)}</span></li>`)
      .join('');
    return chip(r, 'ejemplo', 'Lista de verificación', k, s) + titleIf(r, c.title, s) + whyLine(r, why(c), k, s) + bareList(r, 'ul', items) + applyLine(r, apply(c), k, s);
  });
}

function renderWorked(r: R, c: VcWorkedExample): string {
  const k = tn(r, 'ejemplo');
  return block(r, 'worked_example', 'open', k, (g) => {
    const ds = surf(r.t, k.soft);
    const ink = readable(ds.bg, [k.ink], ds.fg);
    const data = list(c.data, 'worked_example.data')
      .map((d) => `<li${st(r, [['margin', '0 0 6px 0'], ['padding', 0], ['color', ds.fg]])}>${eduIcon(r.enh, 'check', ink, 16)} ${inlineHtml(d)}</li>`)
      .join('');
    const dataBand =
      `<div class="cvc-we-facts"${st(r, [['background-color', ds.bg], ['color', ds.fg], ['border', `1px solid ${k.edge}`], ['margin', `0 0 ${D(r, 18)}px 0`], ['padding', `${D(r, 14)}px ${D(r, 18)}px`]], [['border-radius', r.t.shape.radiusMd]])}>` +
      `<p class="cvc-meta"${st(r, [['margin', '0 0 8px 0'], ['padding', 0], ['color', ink], ['font-size', r.t.typography.sizeSmallPx], ['font-weight', '700']])}>${labelHtml('1 · Datos del caso (ilustrativos)')}</p>` +
      bareList(r, 'ul', data, 'cvc-cols2 cvc-we-data') +
      `</div>`;
    const gk = readable(g.bg, [k.ink], g.fg);
    const stepsHead = `<p class="cvc-meta"${st(r, [['margin', '0 0 12px 0'], ['padding', 0], ['color', gk], ['font-size', r.t.typography.sizeSmallPx], ['font-weight', '700']])}>${labelHtml('2 · Resolución paso a paso')}</p>`;
    const steps = processRail(r, list(c.steps, 'worked_example.steps').map((x) => ({ heading: x.action, body: x.detail })), k, g, 'h5');
    const result =
      `<div class="cvc-we-result"${st(r, [['background-color', g.bg], ['color', g.fg], ['border', `2px solid ${gk}`], ['margin', `${D(r, 6)}px 0 0 0`], ['padding', `${D(r, 16)}px ${D(r, 18)}px`]], [['border-radius', r.t.shape.radiusMd]])}>` +
      `<p class="cvc-meta"${st(r, [['margin', '0 0 6px 0'], ['padding', 0], ['color', gk], ['font-size', r.t.typography.sizeSmallPx], ['font-weight', '700']])}>${eduIcon(r.enh, 'logro', gk, 18)} ${labelHtml('3 · Resultado')}</p>` +
      paragraphs(r, c.result, g, { weight: 600, last: !c.takeaway }) +
      (c.takeaway ? `<p${st(r, [['margin', '10px 0 0 0'], ['padding', 0], ['color', g.fg2]])}><strong${st(r, [['color', g.fg]])}>${labelHtml('Para recordar: ')}</strong>${inlineHtml(c.takeaway)}</p>` : '') +
      `</div>`;
    return chip(r, 'ejemplo', 'Ejemplo resuelto', k, g) + heading(r, 'h4', c.title, g, 'title') + whyLine(r, why(c), k, g) + paragraphs(r, c.situation, g) + dataBand + stepsHead + steps + result + applyLine(r, apply(c), k, g);
  });
}

const CALLOUT_EDU: Record<VcCallout['variant'], { role: EduBlockRole; label: string }> = {
  tip: { role: 'ejemplo', label: 'Consejo práctico' },
  warning: { role: 'error', label: 'Atención' },
  info: { role: 'concepto', label: 'Dato clave' },
  example: { role: 'ejemplo', label: 'Ejemplo' },
};

function renderCallout(r: R, c: VcCallout): string {
  if (typeof c.variant !== 'string' || !hasOwn(CALLOUT_EDU, c.variant)) renderFail(`callout.variant desconocido "${String(c.variant)}"`);
  const m = CALLOUT_EDU[c.variant];
  const k = tn(r, m.role);
  return block(r, 'callout', 'tinted', k, (s) =>
    chip(r, m.role as EduIcon, m.label, k, s, { onPanel: true }) + (c.title ? heading(r, 'h5', c.title, s, 'item') : '') + paragraphs(r, c.body, s, { last: true }) + applyLine(r, apply(c), k, s),
  );
}

// ── Reflexión ──
function renderReflection(r: R, c: VcReflection): string {
  const k = tn(r, 'reflexion');
  return block(r, 'reflection', 'tinted', k, (s) => {
    let inner = chip(r, 'reflexion', 'Para reflexionar', k, s, { onPanel: true }) + paragraphs(r, c.prompt, s, { role: 'statement', weight: 600, last: !c.hint });
    if (c.hint) {
      inner += reveal(r, 'cvc-hint', btnLabel(tinted(r, k), 'Pista', s), kicker(r, 'Pista', s, { margin: '0 0 6px 0' }), paragraphs(r, c.hint, s, { last: true, secondary: true }), { ariaLabel: 'Pista para la reflexión', button: true });
    }
    return inner;
  });
}

// ── Estructura: síntesis y repaso (color del módulo) ──
function renderSummary(r: R, c: VcSummaryVisual): string {
  const k = modTn(r);
  const pts = list(c.points, 'summary_visual.points');
  return block(r, 'summary_visual', 'tinted', k, (s) => {
    const ink = readable(s.bg, [k.ink], s.fg);
    const points = pts
      .map(
        (p, i) =>
          `<li class="cvc-pt"${st(r, [['margin', 0], ['padding', `${D(r, 12)}px 0`], ['color', s.fg], ...(i === 0 ? [] : ([['border-top', `1px solid ${k.edge}`]] as Decl[]))])}>` +
          `<div class="cvc-li-n">${eduIcon(r.enh, 'check', ink, 22)}</div><div class="cvc-li-t">${inlineHtml(p)}</div></li>`,
      )
      .join('');
    return (
      chip(r, 'logro', 'Ideas clave del capítulo', k, s, { onPanel: true }) +
      `<div class="cvc-central">${paragraphs(r, c.central, s, { role: 'statement', weight: 700, last: true })}</div>` +
      `<div${st(r, [['margin', `${D(r, 14)}px 0 0 0`]])}>${bareList(r, 'ol', points, 'cvc-pts')}</div>`
    );
  });
}

function renderSelfCheck(r: R, c: VcSelfCheck): string {
  const k = modTn(r);
  const its = list(c.items, 'self_check.items');
  return block(r, 'self_check', 'framed', k, (s) => chip(r, 'repaso', counted(r, 'Comprueba lo aprendido', its.length, 'pregunta', 'preguntas'), k, s) + selfCheckBody(tinted(r, k), c));
}

function renderReveal(r: R, c: VcRevealCards): string {
  const k = modTn(r);
  return block(r, 'reveal_cards', 'open', k, (s) => chip(r, 'repaso', 'Pon a prueba', k, s) + revealCardsBody(tinted(r, k), c));
}

const RENDERERS: { [K in VcComponent['type']]: (r: R, c: Extract<VcComponent, { type: K }>) => string } = {
  hero: renderHero,
  learning_objectives: renderObjectives,
  concept_cards: renderConcept,
  reveal_cards: renderReveal,
  accordion: renderAccordion,
  tabs: renderTabs,
  timeline: renderTimeline,
  process_steps: renderProcess,
  comparison: renderComparison,
  myth_reality: renderMyth,
  case_scenario: renderCase,
  checklist: renderChecklist,
  reflection: renderReflection,
  callout: renderCallout,
  summary_visual: renderSummary,
  self_check: renderSelfCheck,
  worked_example: renderWorked,
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
  return renderWith({ t: theme, enh: ctx.level === 'enhanced', uid: ctx.uid, seq: 0, opener: ctx.opener, countless: !!ctx.countless, mod: ctx.module }, c);
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
      return renderComponent(c, theme, { uid: `${ctx.uid}-${i}`, level: ctx.level, opener: useOpener ? ctx.opener : undefined, module: ctx.module });
    })
    .join('');
  // EV6: las reglas del árbol de decisión solo viajan en labels que lo usan (el resto, byte-idéntico).
  const decision = components.some((c) => !!c && (c as { type?: unknown }).type === 'diagram' && (c as { kind?: unknown }).kind === 'decision');
  const style = enh ? `<style>${scopedStyle(ctx.uid, theme, { decision })}</style>` : '';
  const script = enh ? `<script>${runtimeScript(ctx.uid)}</script>` : '';
  const plateCls = theme.personality && theme.personality.plate ? ' cvc-plate' : '';
  return `<div class="cvc cvc-${ctx.uid}${plateCls}"${ea(r, { 'data-cvc-uid': ctx.uid, 'data-cvc-v': '2' })} lang="es"` + labelRootStyle(theme, enh) + `>${style}${body}${script}</div>`;
}
