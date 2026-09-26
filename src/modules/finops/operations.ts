/**
 * V2.1 RF-a — mapa item type → operaciones con costo (audit §N.2 + §W.3).
 * Cubre los item types de rulesVersion 3 más `scorm` (v1/v2).
 */
import { FinopsError } from './errors';

export const FINOPS_ITEM_TYPES = [
  'course_plan',
  'course_intro',
  'module_intro',
  'content',
  'experience',
  'presentation',
  'video',
  'video_interactions',
  'activity',
  'exam',
  'final_exam',
  'audio_welcome',
  'audiobook_chapter',
  'scorm',
] as const;
export type FinopsItemType = (typeof FINOPS_ITEM_TYPES)[number];

/** Operaciones (en orden) que dispara la generación de un item. */
export const ITEM_TYPE_OPERATIONS: Readonly<Record<FinopsItemType, readonly string[]>> = {
  course_plan: ['llm.course_plan'],
  course_intro: ['llm.course_intro'],
  module_intro: ['llm.module_intro'],
  content: ['llm.content'],
  experience: ['llm.experience'],
  presentation: ['gamma.generate'],
  video: ['videogen.render', 'youtube.upload'],
  video_interactions: ['llm.video_interactions'],
  activity: ['llm.activity'],
  exam: ['llm.exam'],
  final_exam: ['llm.final_exam'],
  audio_welcome: ['tts.audio_welcome'],
  audiobook_chapter: ['llm.audiobook_script', 'tts.audiobook_chapter'],
  scorm: ['llm.scorm'],
};

/** Familia de operación → proveedor. */
const FAMILY_PROVIDER: Readonly<Record<string, string>> = {
  llm: 'anthropic',
  tts: 'openai',
  gamma: 'gamma',
  videogen: 'videogen',
  youtube: 'youtube',
  package: 'cursia',
  render: 'cursia',
};

const PROVIDER_FAMILY: Readonly<Record<string, string>> = {
  anthropic: 'llm',
  openai: 'tts',
  gamma: 'gamma',
  videogen: 'videogen',
  youtube: 'youtube',
  cursia: 'package',
  mock: 'mock',
};

export function isFinopsItemType(t: unknown): t is FinopsItemType {
  return typeof t === 'string' && (FINOPS_ITEM_TYPES as readonly string[]).includes(t);
}

export function operationsForItemType(itemType: string): readonly string[] {
  if (!isFinopsItemType(itemType)) throw new FinopsError('UNKNOWN_ITEM_TYPE', `item type sin mapa de costos: ${itemType}`);
  return ITEM_TYPE_OPERATIONS[itemType];
}

export function providerOfOperation(operation: string): string | null {
  const fam = String(operation).split('.')[0];
  return FAMILY_PROVIDER[fam] ?? null;
}

/** Familia de operación por proveedor ('anthropic' → 'llm'); fallback: el propio proveedor. */
export function familyOfProvider(provider: string): string {
  return PROVIDER_FAMILY[provider] ?? provider;
}

/**
 * Operación de un item para un proveedor dado (p.ej. audiobook_chapter +
 * anthropic → 'llm.audiobook_script'). null si ese item no usa ese proveedor.
 */
export function operationForItem(itemType: string, provider: string): string | null {
  if (!isFinopsItemType(itemType)) return null;
  return ITEM_TYPE_OPERATIONS[itemType].find((op) => providerOfOperation(op) === provider) ?? null;
}
