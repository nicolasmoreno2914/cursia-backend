/**
 * R2 — Visual Components: renderer (JSON validado + ResolvedTheme → HTML de label Moodle).
 *
 * Dos niveles sobre EL MISMO markup (§X.1, HD-V21-3):
 *  - CLEAN_SAFE (siempre): HTML semántico + estilos inline que sobreviven forceclean=1
 *    (hex, margin/padding/border, tipografía, max-width…). Todo el contenido visible, en
 *    orden de lectura, en flujo de bloques. Todo elemento que fija `color` está dentro de
 *    (o es) un elemento con `background-color` sólido del tema, elegido para ese color.
 *  - ENHANCED (ctx.level === 'enhanced'): propiedades extra DESPUÉS de las seguras
 *    (grid, radius, shadow, overflow-wrap, font-size fluido), <details open>, aria/ids,
 *    y en renderMovement un <style> con scope + runtime JS (runtime.ts).
 *
 * Determinista: mismo componente + tema + uid → mismos bytes. Sin reloj ni azar.
 * El renderer NO valida longitudes (eso es validateExperience); sí exige estructura y
 * escapa todo texto, así que un input fuera de rango nunca produce HTML inseguro.
 */
import { contrastRatio, ResolvedTheme } from '../theme-engine';
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
} from './schema';
import { escapeHtml, HYPHEN_TABLE, HyphenOpts, inlineHtml, multilineInlineHtml, splitParagraphs } from './text';
import { runtimeScript, scopedStyle } from './runtime';

export type VcRenderLevel = 'enhanced';

export interface VcRenderContext {
  /** Identificador estable del label; [a-z0-9-], 1–64 caracteres. */
  uid: string;
  /** Omitido = solo CLEAN_SAFE. */
  level?: VcRenderLevel;
}

const UID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MIN_CONTRAST = 4.5;

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
}

type Decl = [string, string | number];

function renderFail(msg: string): never {
  throw new Error(`VC_RENDER: ${msg}`);
}

function checkCtx(ctx: VcRenderContext): void {
  if (!ctx || typeof ctx.uid !== 'string' || !UID_RE.test(ctx.uid)) {
    renderFail(`uid inválido "${ctx && ctx.uid}" (se espera [a-z0-9-], 1–64)`);
  }
  if (ctx.level !== undefined && ctx.level !== 'enhanced') renderFail(`level desconocido "${String(ctx.level)}"`);
}

/** Texto legible sobre `bg`: primero los preferidos, luego los neutros del tema. Falla fuerte si nada llega a 4.5. */
function surf(t: ResolvedTheme, bg: string, preferred: string[] = []): Surf {
  const cands = [...preferred, t.color.textPrimary, t.color.textSecondary, t.color.textOnAccent];
  const fg = cands.find((c) => contrastRatio(c, bg) >= MIN_CONTRAST);
  if (!fg) renderFail(`ningún color de texto del tema alcanza ${MIN_CONTRAST}:1 sobre ${bg}`);
  const fg2 = contrastRatio(t.color.textSecondary, bg) >= MIN_CONTRAST ? t.color.textSecondary : fg;
  return { bg, fg, fg2 };
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

/** Atributos solo-ENHANCED (aria/id/role…). */
function ea(r: R, attrs: Record<string, string>): string {
  if (!r.enh) return '';
  return Object.entries(attrs)
    .map(([k, v]) => ` ${k}="${attr(v)}"`)
    .join('');
}

// ─── Primitivas ─────────────────────────────────────────────────────────────

function typo(r: R, px: number, fluid?: string): { safe: Decl[]; enh: Decl[] } {
  return { safe: [['font-size', px]], enh: fluid ? [['font-size', fluid]] : [] };
}

function componentWrap(r: R, type: string, inner: string, s: Surf, extraSafe: Decl[] = [], extraEnh: Decl[] = []): string {
  const ty = r.t.typography;
  return (
    `<div class="cvc-c cvc-t-${type}"` +
    st(
      r,
      [
        ['background-color', s.bg],
        ['color', s.fg],
        ['font-family', ty.fontBody],
        ['font-size', ty.sizeBodyPx],
        ['line-height', String(ty.lineBody)],
        ['margin', '0 0 24px 0'],
        ...extraSafe,
      ],
      [['font-size', ty.enhanced.sizeBodyFluid], ['overflow-wrap', 'anywhere'], ...extraEnh],
    ) +
    `>${inner}</div>`
  );
}

function heading(r: R, tag: 'h2' | 'h3' | 'h4', text: string, s: Surf, opts: { cls?: string; id?: string } = {}): string {
  const ty = r.t.typography;
  const size = tag === 'h2' ? { px: ty.sizeH1Px, fl: ty.enhanced.sizeH1Fluid } : tag === 'h3' ? { px: ty.sizeH3Px, fl: ty.enhanced.sizeH3Fluid } : { px: ty.sizeBodyPx, fl: ty.enhanced.sizeBodyFluid };
  const f = typo(r, size.px, size.fl);
  const cls = opts.cls ? ` class="${opts.cls}"` : '';
  const id = opts.id ? ea(r, { id: opts.id }) : '';
  return (
    `<${tag}${cls}${id}` +
    st(
      r,
      [
        ['margin', tag === 'h4' ? '0 0 8px 0' : '0 0 16px 0'],
        ['padding', 0],
        ['color', s.fg],
        ['font-family', ty.fontHeading],
        ...f.safe,
        ['font-weight', String(ty.weightHeading)],
        ['line-height', String(ty.lineHeading)],
      ],
      f.enh,
    ) +
    `>${inlineHtml(text)}</${tag}>`
  );
}

function paragraphs(r: R, text: string, s: Surf, opts: { secondary?: boolean; px?: number; weight?: number; last?: boolean } = {}): string {
  const ty = r.t.typography;
  const px = opts.px ?? ty.sizeBodyPx;
  const ps = splitParagraphs(text);
  return ps
    .map((p, i) => {
      const safe: Decl[] = [
        ['margin', i === ps.length - 1 && opts.last ? '0' : '0 0 12px 0'],
        ['padding', 0],
        ['color', opts.secondary ? s.fg2 : s.fg],
        ['font-size', px],
        ['line-height', String(ty.lineBody)],
        ['max-width', `${ty.measureCh}ch`],
      ];
      if (opts.weight) safe.push(['font-weight', String(opts.weight)]);
      const enh: Decl[] = px === ty.sizeBodyPx ? [['font-size', ty.enhanced.sizeBodyFluid]] : [];
      return `<p${st(r, safe, enh)}>${multilineInlineHtml(p)}</p>`;
    })
    .join('');
}

/** Badge de metadatos (única excepción de tamaño: sizeMetaPx, clase cvc-meta). Lleva su propio fondo. */
function badge(r: R, text: string, bg: string, fg?: string): string {
  const color = fg ?? surf(r.t, bg).fg;
  return (
    `<span class="cvc-meta"` +
    st(
      r,
      [
        ['background-color', bg],
        ['color', color],
        ['border', `1px solid ${bg}`],
        ['padding', '2px 8px'],
        ['font-size', r.t.typography.sizeMetaPx],
        ['font-weight', '700'],
        ['line-height', '1.5'],
        ['letter-spacing', '0.04em'],
        ['text-transform', 'uppercase'],
      ],
      [['border-radius', '999px'], ['display', 'inline-block']],
    ) +
    `>${escapeHtml(text)}</span>`
  );
}

function badgeLine(r: R, badgeHtml: string): string {
  return `<div${st(r, [['margin', '0 0 8px 0']])}>${badgeHtml}</div>`;
}

type CardTone = 'card' | 'surface' | 'alt' | 'soft';

function cardSurf(r: R, tone: CardTone): { s: Surf; border: string } {
  const c = r.t.color;
  const tn = tone === 'card' ? ({ flat: 'alt', outline: 'surface', tinted: 'soft' } as const)[r.t.variants.card] : tone;
  if (tn === 'alt') return { s: surf(r.t, c.surfaceAlt), border: c.surfaceAlt };
  if (tn === 'soft') return { s: surf(r.t, c.accentSoft), border: c.border };
  return { s: surf(r.t, c.surface), border: c.border };
}

function card(r: R, inner: string, cs: { s: Surf; border: string }, opts: { cls?: string; tag?: 'div' | 'li'; id?: string; border?: string; borderWidth?: number } = {}): string {
  const tag = opts.tag || 'div';
  const bw = opts.borderWidth ?? r.t.shape.borderWidth;
  return (
    `<${tag} class="cvc-card${opts.cls ? ' ' + opts.cls : ''}"${opts.id ? ` id="${attr(opts.id)}"` : ''}` +
    st(
      r,
      [
        ['background-color', cs.s.bg],
        ['color', cs.s.fg],
        ['border', `${bw}px solid ${opts.border || cs.border}`],
        ['margin', '0 0 16px 0'],
        ['padding', '16px 20px'],
      ],
      [['border-radius', r.t.shape.radiusMd], ['box-shadow', `0 1px 2px ${r.t.color.border}`], ['min-width', '0']],
    ) +
    `>${inner}</${tag}>`
  );
}

function grid(r: R, inner: string, minRem = 16): string {
  return (
    `<div class="cvc-grid"` +
    st(
      r,
      [['margin', 0], ['padding', 0]],
      [
        ['display', 'grid'],
        ['grid-template-columns', `repeat(auto-fit,minmax(min(100%,${minRem}rem),1fr))`],
        ['column-gap', '16px'],
      ],
    ) +
    `>${inner}</div>`
  );
}

/**
 * Bloque de revelado. CLEAN_SAFE: etiqueta + cuerpo apilados, siempre visibles.
 * ENHANCED: <details open> (el runtime lo cierra al iniciar; sin JS queda abierto).
 */
function reveal(r: R, cls: string, summaryInner: string, cleanLead: string, body: string, keepOpen = false): string {
  if (!r.enh) return `<div class="${cls}">${cleanLead}${body}</div>`;
  const k = keepOpen ? ' cvc-keep-open' : '';
  return (
    `<details class="${cls} cvc-collapsible${k}" open>` +
    `<summary class="cvc-summary"${st(r, [['margin', '0 0 8px 0']])}>${summaryInner}</summary>` +
    `<div class="cvc-dbody">${body}</div></details>`
  );
}

function titleIf(r: R, title: string | undefined, s: Surf, fallback?: string, id?: string): string {
  const tt = title ?? fallback;
  return tt ? heading(r, 'h3', tt, s, { id }) : '';
}

function list<T>(v: T[] | undefined, what: string): T[] {
  if (!Array.isArray(v) || v.length === 0) renderFail(`${what}: se esperaba una lista no vacía`);
  return v;
}

function glyph(r: R, ch: string, color: string): string {
  return `<span${ea(r, { 'aria-hidden': 'true' })}${st(r, [['color', color], ['font-weight', '700']])}>${ch}</span> `;
}

// ─── Componentes (una función por tipo) ─────────────────────────────────────

function renderHero(r: R, c: VcHero): string {
  const col = r.t.color;
  const solid = r.t.variants.hero === 'solid';
  const s = solid ? surf(r.t, col.accent, [col.textOnAccent]) : surf(r.t, col.accentSoft);
  const eyebrow = c.eyebrow
    ? `<p${st(r, [['margin', '0 0 8px 0'], ['color', s.fg], ['font-size', r.t.typography.sizeSmallPx], ['font-weight', '700'], ['letter-spacing', '0.06em'], ['text-transform', 'uppercase']])}>${inlineHtml(c.eyebrow)}</p>`
    : '';
  const inner = eyebrow + heading(r, 'h2', c.title, s) + paragraphs(r, c.lead, s, { last: true });
  return componentWrap(
    r,
    'hero',
    inner,
    s,
    [['padding', '28px 24px'], ['border', `${r.t.shape.borderWidth}px solid ${solid ? col.accent : col.border}`]],
    [['border-radius', r.t.shape.radiusLg]],
  );
}

function renderLearningObjectives(r: R, c: VcLearningObjectives): string {
  const s = surf(r.t, r.t.color.bg);
  const items = list(c.items, 'learning_objectives.items')
    .map((it) => `<li${st(r, [['margin', '0 0 10px 0'], ['padding', 0], ['color', s.fg]])}>${glyph(r, '✓', r.t.color.accentStrong)}${inlineHtml(it)}</li>`)
    .join('');
  const ul = `<ul${st(r, [['list-style', 'none'], ['margin', 0], ['padding', 0]])}>${items}</ul>`;
  return componentWrap(r, 'learning_objectives', titleIf(r, c.title, s, 'Objetivos de aprendizaje') + ul, s);
}

function renderConceptCards(r: R, c: VcConceptCards): string {
  const s = surf(r.t, r.t.color.bg);
  const cards = list(c.cards, 'concept_cards.cards')
    .map((k) => {
      const cs = cardSurf(r, 'card');
      return card(r, heading(r, 'h4', k.term, cs.s) + paragraphs(r, k.definition, cs.s, { last: true }), cs);
    })
    .join('');
  return componentWrap(r, 'concept_cards', titleIf(r, c.title, s) + grid(r, cards), s);
}

function renderRevealCards(r: R, c: VcRevealCards): string {
  const s = surf(r.t, r.t.color.bg);
  const col = r.t.color;
  const cards = list(c.cards, 'reveal_cards.cards')
    .map((k) => {
      const cs = cardSurf(r, 'surface');
      const front = badgeLine(r, badge(r, 'Frente', cs.s.bg === col.surfaceAlt ? col.surface : col.surfaceAlt)) + paragraphs(r, k.front, cs.s, { weight: 700 });
      const b = badge(r, 'Reverso', col.accent, col.textOnAccent);
      const back = reveal(r, 'cvc-reveal', b, badgeLine(r, b), paragraphs(r, k.back, cs.s, { last: true }));
      return card(r, front + back, cs, { cls: 'cvc-reveal-card' });
    })
    .join('');
  return componentWrap(r, 'reveal_cards', titleIf(r, c.title, s) + grid(r, cards), s);
}

function renderAccordion(r: R, c: VcAccordion): string {
  const s = surf(r.t, r.t.color.bg);
  const items = list(c.items, 'accordion.items')
    .map((it, i) => {
      const cs = cardSurf(r, 'surface');
      const h = heading(r, 'h4', it.heading, cs.s);
      return card(r, reveal(r, 'cvc-acc', h, h, paragraphs(r, it.body, cs.s, { last: true }), i === 0), cs);
    })
    .join('');
  return componentWrap(r, 'accordion', titleIf(r, c.title, s) + items, s);
}

function renderTabs(r: R, c: VcTabs): string {
  const s = surf(r.t, r.t.color.bg);
  const panels = list(c.tabs, 'tabs.tabs')
    .map((tb) => {
      const cs = cardSurf(r, 'surface');
      const id = r.enh ? nextId(r, 'tab') : undefined;
      return card(r, heading(r, 'h4', tb.label, cs.s, { cls: 'cvc-tablabel' }) + paragraphs(r, tb.body, cs.s, { last: true }), cs, {
        cls: 'cvc-tabpanel',
        id,
      });
    })
    .join('');
  return componentWrap(r, 'tabs', titleIf(r, c.title, s) + `<div class="cvc-tabs">${panels}</div>`, s);
}

function renderTimeline(r: R, c: VcTimeline): string {
  const s = surf(r.t, r.t.color.bg);
  const col = r.t.color;
  const events = list(c.events, 'timeline.events')
    .map((ev) => {
      const cs = cardSurf(r, 'surface');
      const marker = `<p${st(r, [['margin', '0 0 4px 0'], ['color', cs.s.fg2], ['font-size', r.t.typography.sizeSmallPx], ['font-weight', '700']])}>${inlineHtml(ev.marker)}</p>`;
      return card(r, marker + heading(r, 'h4', ev.heading, cs.s) + paragraphs(r, ev.body, cs.s, { last: true }), cs, {
        tag: 'li',
        border: col.borderStrong,
      });
    })
    .join('');
  const ol = `<ol${st(r, [['list-style', 'none'], ['margin', 0], ['padding', 0]])}>${events}</ol>`;
  return componentWrap(r, 'timeline', titleIf(r, c.title, s) + ol, s);
}

function renderProcessSteps(r: R, c: VcProcessSteps): string {
  const s = surf(r.t, r.t.color.bg);
  const col = r.t.color;
  const steps = list(c.steps, 'process_steps.steps')
    .map((sp, i) => {
      const cs = cardSurf(r, 'surface');
      const b = badgeLine(r, badge(r, `Paso ${i + 1}`, col.accent, col.textOnAccent));
      return card(r, b + heading(r, 'h4', sp.heading, cs.s) + paragraphs(r, sp.body, cs.s, { last: true }), cs, { tag: 'li' });
    })
    .join('');
  const ol = `<ol${st(r, [['list-style', 'none'], ['margin', 0], ['padding', 0]])}>${steps}</ol>`;
  return componentWrap(r, 'process_steps', titleIf(r, c.title, s) + ol, s);
}

function renderComparison(r: R, c: VcComparison): string {
  const s = surf(r.t, r.t.color.bg);
  const col = r.t.color;
  const ty = r.t.typography;
  const columns = list(c.columns, 'comparison.columns');
  const rows = list(c.rows, 'comparison.rows');
  const head = surf(r.t, col.accent, [col.textOnAccent]);
  const rowHead = surf(r.t, col.surfaceAlt);
  const cell = surf(r.t, col.surface);
  const h: HyphenOpts = HYPHEN_TABLE;
  const cellStyle = (x: Surf, bold: boolean): Decl[] => [
    ['background-color', x.bg],
    ['color', x.fg],
    ['border', `1px solid ${col.borderStrong}`],
    ['padding', '8px 10px'],
    ['font-size', ty.sizeSmallPx],
    ['line-height', '1.5'],
    ['font-weight', bold ? '700' : String(ty.weightBody)],
    ['text-align', 'left'],
    ['vertical-align', 'top'],
  ];
  const titleId = r.enh && c.title ? nextId(r, 'cmp') : undefined;
  const thead =
    `<thead><tr><th scope="col"${st(r, cellStyle(head, true))}>Aspecto</th>` +
    columns.map((cn) => `<th scope="col"${st(r, cellStyle(head, true))}>${inlineHtml(cn, h)}</th>`).join('') +
    '</tr></thead>';
  const tbody =
    '<tbody>' +
    rows
      .map((row) => {
        const cells = list(row.cells, 'comparison.rows[].cells');
        return (
          `<tr><th scope="row"${st(r, cellStyle(rowHead, true))}>${inlineHtml(row.label, h)}</th>` +
          cells.map((v, i) => `<td${ea(r, { 'data-label': columns[i] ?? '' })}${st(r, cellStyle(cell, false))}>${multilineInlineHtml(v, h)}</td>`).join('') +
          '</tr>'
        );
      })
      .join('') +
    '</tbody>';
  const table =
    `<table${titleId ? ea(r, { 'aria-labelledby': titleId }) : ''}` +
    st(r, [['border-collapse', 'collapse'], ['width', '100%'], ['margin', 0]]) +
    `>${thead}${tbody}</table>`;
  return componentWrap(r, 'comparison', titleIf(r, c.title, s, undefined, titleId) + `<div class="cvc-cmp">${table}</div>`, s);
}

function renderMythReality(r: R, c: VcMythReality): string {
  const s = surf(r.t, r.t.color.bg);
  const col = r.t.color;
  const pairs = list(c.pairs, 'myth_reality.pairs')
    .map((p) => {
      const cs = cardSurf(r, 'surface');
      const myth = badgeLine(r, badge(r, 'Mito', col.danger, col.onDanger)) + paragraphs(r, p.myth, cs.s, { weight: 700 });
      const b = badge(r, 'Realidad', col.success, col.onSuccess);
      return card(r, myth + reveal(r, 'cvc-myth', b, badgeLine(r, b), paragraphs(r, p.reality, cs.s, { last: true })), cs);
    })
    .join('');
  return componentWrap(r, 'myth_reality', titleIf(r, c.title, s) + pairs, s);
}

function renderCaseScenario(r: R, c: VcCaseScenario): string {
  const cs = cardSurf(r, 'card');
  const col = r.t.color;
  const qs = list(c.questions, 'case_scenario.questions')
    .map((q) => `<li${st(r, [['margin', '0 0 8px 0'], ['color', cs.s.fg]])}>${inlineHtml(q)}</li>`)
    .join('');
  const inner =
    badgeLine(r, badge(r, 'Caso', col.accent, col.textOnAccent)) +
    heading(r, 'h3', c.title, cs.s) +
    paragraphs(r, c.narrative, cs.s) +
    heading(r, 'h4', 'Preguntas guía', cs.s) +
    `<ol${st(r, [['margin', '0 0 0 24px'], ['padding', 0], ['list-style', 'decimal']])}>${qs}</ol>`;
  const s = surf(r.t, r.t.color.bg);
  return componentWrap(r, 'case_scenario', card(r, inner, cs), s);
}

function renderChecklist(r: R, c: VcChecklist): string {
  const s = surf(r.t, r.t.color.bg);
  const items = list(c.items, 'checklist.items')
    .map((it) => `<li${st(r, [['margin', '0 0 10px 0'], ['padding', 0], ['color', s.fg]])}>${glyph(r, '☐', s.fg)}${inlineHtml(it)}</li>`)
    .join('');
  const ul = `<ul${st(r, [['list-style', 'none'], ['margin', 0], ['padding', 0]])}>${items}</ul>`;
  return componentWrap(r, 'checklist', titleIf(r, c.title, s, 'Lista de verificación') + ul, s);
}

function renderReflection(r: R, c: VcReflection): string {
  const col = r.t.color;
  const cs = cardSurf(r, 'soft');
  let inner = badgeLine(r, badge(r, 'Para reflexionar', col.accent, col.textOnAccent)) + paragraphs(r, c.prompt, cs.s, { weight: 700, last: !c.hint });
  if (c.hint) {
    const b = badge(r, 'Pista', col.info, col.onInfo);
    inner += reveal(r, 'cvc-hint', b, badgeLine(r, b), paragraphs(r, c.hint, cs.s, { last: true }));
  }
  return componentWrap(r, 'reflection', card(r, inner, cs), surf(r.t, col.bg));
}

const CALLOUT_LABEL: Record<VcCallout['variant'], string> = {
  tip: 'Consejo',
  warning: 'Atención',
  info: 'Dato',
  example: 'Ejemplo',
};

function renderCallout(r: R, c: VcCallout): string {
  const col = r.t.color;
  const tone: Record<VcCallout['variant'], [string, string]> = {
    tip: [col.success, col.onSuccess],
    warning: [col.warning, col.onWarning],
    info: [col.info, col.onInfo],
    example: [col.accent, col.textOnAccent],
  };
  const pair = tone[c.variant];
  if (!pair) renderFail(`callout.variant desconocido "${String(c.variant)}"`);
  const cs = r.t.variants.callout === 'tinted' ? cardSurf(r, 'soft') : cardSurf(r, 'surface');
  const inner =
    badgeLine(r, badge(r, CALLOUT_LABEL[c.variant], pair[0], pair[1])) +
    (c.title ? heading(r, 'h4', c.title, cs.s) : '') +
    paragraphs(r, c.body, cs.s, { last: true });
  return componentWrap(r, 'callout', card(r, inner, cs, { border: pair[0], borderWidth: 2 }), surf(r.t, col.bg));
}

function renderSummaryVisual(r: R, c: VcSummaryVisual): string {
  const col = r.t.color;
  const s = surf(r.t, col.bg);
  const center = surf(r.t, col.accent, [col.textOnAccent]);
  const central =
    `<div class="cvc-central"` +
    st(r, [['background-color', center.bg], ['color', center.fg], ['border', `1px solid ${center.bg}`], ['padding', '16px 20px'], ['margin', '0 0 16px 0']], [['border-radius', r.t.shape.radiusMd]]) +
    `>${paragraphs(r, c.central, center, { px: r.t.typography.sizeH3Px, weight: 700, last: true })}</div>`;
  const points = list(c.points, 'summary_visual.points')
    .map((p) => {
      const cs = cardSurf(r, 'card');
      return card(r, paragraphs(r, p, cs.s, { last: true }), cs);
    })
    .join('');
  return componentWrap(r, 'summary_visual', heading(r, 'h3', 'Ideas clave', s) + central + grid(r, points, 14), s);
}

function renderSelfCheck(r: R, c: VcSelfCheck): string {
  const col = r.t.color;
  const s = surf(r.t, col.bg);
  const items = list(c.items, 'self_check.items')
    .map((it, i) => {
      const cs = cardSurf(r, 'surface');
      const q = badgeLine(r, badge(r, `Pregunta ${i + 1}`, cs.s.bg === col.surfaceAlt ? col.surface : col.surfaceAlt)) + paragraphs(r, it.q, cs.s, { weight: 700 });
      const b = badge(r, 'Respuesta', col.success, col.onSuccess);
      return card(r, q + reveal(r, 'cvc-selfcheck', b, badgeLine(r, b), paragraphs(r, it.a, cs.s, { last: true })), cs);
    })
    .join('');
  return componentWrap(r, 'self_check', titleIf(r, c.title, s, 'Repaso rápido') + items, s);
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
};

function renderWith(r: R, c: VcComponent): string {
  if (!c || typeof c !== 'object') renderFail('componente no es un objeto');
  const fn = (RENDERERS as Record<string, (r: R, c: VcComponent) => string>)[c.type];
  if (!fn) renderFail(`tipo de componente desconocido "${String((c as { type?: unknown }).type)}"`);
  return fn(r, c);
}

// ─── API pública ────────────────────────────────────────────────────────────

/** Un componente → HTML (sin <style>/<script>; esos van una vez por label en renderMovement). */
export function renderComponent(c: VcComponent, theme: ResolvedTheme, ctx: VcRenderContext): string {
  checkCtx(ctx);
  return renderWith({ t: theme, enh: ctx.level === 'enhanced', uid: ctx.uid, seq: 0 }, c);
}

/** Un movimiento → cuerpo completo de UN label Moodle. */
export function renderMovement(components: VcComponent[], theme: ResolvedTheme, ctx: VcRenderContext): string {
  checkCtx(ctx);
  if (!Array.isArray(components) || components.length === 0) renderFail('un movimiento necesita al menos un componente');
  const enh = ctx.level === 'enhanced';
  const r: R = { t: theme, enh, uid: ctx.uid, seq: 0 };
  const ty = theme.typography;
  const body = components.map((c, i) => renderComponent(c, theme, { uid: `${ctx.uid}-${i}`, level: ctx.level })).join('');
  const style = enh ? `<style>${scopedStyle(ctx.uid, theme)}</style>` : '';
  const script = enh ? `<script>${runtimeScript(ctx.uid)}</script>` : '';
  return (
    `<div class="cvc cvc-${ctx.uid}"${ea(r, { 'data-cvc-uid': ctx.uid, 'data-cvc-v': '1' })} lang="es"` +
    st(
      r,
      [
        ['background-color', theme.color.bg],
        ['color', theme.color.textPrimary],
        ['font-family', ty.fontBody],
        ['font-size', ty.sizeBodyPx],
        ['line-height', String(ty.lineBody)],
        ['margin', 0],
        ['padding', '16px'],
        ['max-width', '100%'],
      ],
      [['border-radius', theme.shape.radiusLg], ['overflow-wrap', 'anywhere']],
    ) +
    `>${style}${body}${script}</div>`
  );
}
