/**
 * Cascada de `regenerateItem` (regeneración explícita DENTRO de un run), por
 * rulesVersion. Función pura sobre los items del Manifest congelado.
 *
 * v1/v2 (Fase 8, sin cambios): content:<ch> → REGENERATE scorm:<ch> + exam:<m>;
 * video:<ch> → STALE_NO_AUTO. Ningún otro tipo encadena.
 *
 * v3 (V2.1 fix round 1, review G2 I2) — mismas reglas que el plan de
 * invalidación v3 (plan-v3.ts), aplicadas a "la salida de X cambió":
 *  - content:<ch> →
 *      REGENERATE (LLM, generación nueva `pending`): experience:<ch>,
 *        activity:<ch>, exam:<m>, final_exam;
 *      STALE_NO_AUTO (proveedor, nunca se regenera solo; artifacts `stale`
 *        con motivo ⇒ aviso visible en el empaque): presentation:<ch>,
 *        video:<ch>, audiobook_chapter:<ch>; y video_interactions:<ch>, que
 *        describe el video vigente — como el video queda STALE (no cambia),
 *        sus interacciones también (misma regla que el plan v3).
 *  - video:<ch> → REGENERATE video_interactions:<ch> (describen un video nuevo).
 *  - course_intro → STALE_NO_AUTO audio_welcome (TTS).
 *  - course_plan: no encadena (misma regla que v2: el plan no regenera los content).
 *  - resto: sin cascada.
 * Solo se incluyen keys que existen en el Manifest.
 */
export interface CascadeItem {
  key: string;
  type: string;
  moduleId?: string | null;
  chapterId?: string | null;
}

export interface RegenerationCascade {
  regenerate: string[];
  stale: string[];
}

export function regenerationCascade(rulesVersion: number, items: readonly CascadeItem[], mItem: CascadeItem): RegenerationCascade {
  const has = (key: string) => items.some((it) => it.key === key);
  const pick = (keys: Array<string | null>) => keys.filter((k): k is string => !!k && has(k));
  const ch = mItem.chapterId;
  if (rulesVersion !== 3) {
    if (mItem.type !== 'content' || !ch) return { regenerate: [], stale: [] };
    return {
      regenerate: pick([`scorm:${ch}`, mItem.moduleId ? `exam:${mItem.moduleId}` : null]),
      stale: pick([`video:${ch}`]),
    };
  }
  if (mItem.type === 'content' && ch) {
    const finalExam = items.find((it) => it.type === 'final_exam')?.key ?? null;
    return {
      regenerate: pick([`experience:${ch}`, `activity:${ch}`, mItem.moduleId ? `exam:${mItem.moduleId}` : null, finalExam]),
      stale: pick([`presentation:${ch}`, `video:${ch}`, `video_interactions:${ch}`, `audiobook_chapter:${ch}`]),
    };
  }
  if (mItem.type === 'video' && ch) return { regenerate: pick([`video_interactions:${ch}`]), stale: [] };
  if (mItem.type === 'course_intro') {
    return { regenerate: [], stale: pick([items.find((it) => it.type === 'audio_welcome')?.key ?? null]) };
  }
  return { regenerate: [], stale: [] };
}
