// EV6 H5P v2 — H5P.Dialogcards 1.9: «Repaso» opcional, NO calificable (sin xAPI:
// prueba H5P2 en Moodle 4.5 — 0 intentos, nota vacía). Completion por vista.
//
// Sin contrato LLM: se arma de forma DETERMINÍSTICA desde el artifact
// `experience` ya validado, en el orden de la experiencia (movimientos en el
// orden canónico, componentes y tarjetas en orden):
//   concept_cards {term → frente, definition → reverso}
//   reveal_cards  {front → frente, back → reverso}
//   self_check    {q → frente, a → reverso}
// 4–12 tarjetas: con menos de 4 no hay actividad (null, nunca un mazo de 1–3);
// con más de 12 se toman las 12 primeras.
import { applyH5pL10n } from '../l10n';
import { H5pBuiltContent, escapeText, h5pTitle, isPlainObject } from './common';

export const DIALOG_CARDS_LIMITS = Object.freeze({ minCards: 4, maxCards: 12 });

/** Orden canónico de los movimientos (= VC_MOVEMENT_IDS de visual-components/schema.ts). */
export const DIALOG_CARDS_MOVEMENT_ORDER: readonly string[] = Object.freeze([
  'opening',
  'deepening',
  'synthesis',
  'closing',
  'video_primer',
  'self_check',
]);

export interface DialogCard {
  front: string;
  back: string;
  /** Tipo de componente de la experiencia del que salió (trazabilidad). */
  source: 'concept_cards' | 'reveal_cards' | 'self_check';
}

// Invisibles / uso privado (no llegan al HTML), igual criterio que visual-components/text.ts.
const INVISIBLE_RE = /[­​-‏‪-‮⁠-⁤﻿-]/g;

function clean(s: unknown): string {
  return typeof s === 'string' ? s.replace(INVISIBLE_RE, '').replace(/\s+/g, ' ').trim() : '';
}

/** Tarjetas (texto plano, con `**énfasis**` intacto) en el orden de la experiencia. Pura. */
export function dialogCardsFromExperience(experience: unknown): DialogCard[] {
  const out: DialogCard[] = [];
  if (!isPlainObject(experience) || !isPlainObject(experience.movements)) return out;
  const mv = experience.movements as Record<string, unknown>;
  for (const id of DIALOG_CARDS_MOVEMENT_ORDER) {
    const comps = mv[id];
    if (!Array.isArray(comps)) continue;
    for (const c of comps) {
      if (!isPlainObject(c)) continue;
      const push = (front: unknown, back: unknown, source: DialogCard['source']) => {
        const f = clean(front);
        const b = clean(back);
        if (f && b) out.push({ front: f, back: b, source });
      };
      if (c.type === 'concept_cards' && Array.isArray(c.cards)) for (const k of c.cards) isPlainObject(k) && push(k.term, k.definition, 'concept_cards');
      if (c.type === 'reveal_cards' && Array.isArray(c.cards)) for (const k of c.cards) isPlainObject(k) && push(k.front, k.back, 'reveal_cards');
      if (c.type === 'self_check' && Array.isArray(c.items)) for (const k of c.items) isPlainObject(k) && push(k.q, k.a, 'self_check');
    }
  }
  return out;
}

/** Texto plano → HTML de Dialog Cards (tags p, br, strong, em): escapa y convierte `**x**` en <strong>. */
function cardHtml(s: string): string {
  const esc = escapeText(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\*\*/g, '');
  return `<p style="text-align: center;">${esc}</p>`;
}

export interface DialogCardsFromExperienceInput {
  /** Título del capítulo (el de la actividad se arma como «Repaso: …»). */
  chapterTitle: string;
  experience: unknown;
}

/**
 * Contenido H5P.Dialogcards desde la experiencia, o null si hay menos de 4 tarjetas.
 * Determinístico: misma experiencia ⇒ mismo contenido. Sin subContentIds (DC no tiene sub-contenidos).
 */
export function buildDialogCardsFromExperience(input: DialogCardsFromExperienceInput): (H5pBuiltContent & { cards: DialogCard[] }) | null {
  if (!input || typeof input.chapterTitle !== 'string' || !input.chapterTitle.trim()) {
    throw new Error('H5P_DIALOG_CARDS_INVALID: chapterTitle vacío');
  }
  const all = dialogCardsFromExperience(input.experience);
  if (all.length < DIALOG_CARDS_LIMITS.minCards) return null;
  const cards = all.slice(0, DIALOG_CARDS_LIMITS.maxCards);
  const title = h5pTitle(`Repaso: ${input.chapterTitle}`);
  const content = applyH5pL10n('H5P.Dialogcards', {
    title: `<p>${escapeText(title)}</p>`,
    mode: 'normal',
    description: '<p>Lee el frente, piensa tu respuesta y gira la tarjeta para comprobarla.</p>',
    dialogs: cards.map((c) => ({ text: cardHtml(c.front), answer: cardHtml(c.back), tips: { front: '', back: '' } })),
    behaviour: {
      enableRetry: true,
      disableBackwardsNavigation: false,
      scaleTextNotCard: false,
      randomCards: false,
      maxProficiency: 5,
      quickProgression: false,
    },
  });
  return { mainLibrary: 'H5P.Dialogcards', title, content, subContentIds: [], maxScore: 0, cards };
}
