/**
 * Cursia V2.1 — R12: intros de las actividades calificables del capítulo.
 *
 * - Actividad H5P: misma receta probada que el video (R8, HD-V21-2): el
 *   `.h5p` también en el filearea `intro` y un iframe `embed.php` diferido,
 *   con la URL derivada de `@@PLUGINFILE@@` (sirve con wwwroot en subcarpeta)
 *   y el resizer H5P inline (`CURSIA_IV_INLINE_SCRIPT`, sin h5plib/vNNN).
 *   Con forceclean=1 el iframe y el script se eliminan y queda el bloque de
 *   respaldo con el enlace a la actividad (`$@H5PACTIVITYVIEWBYID*mid@$`).
 * - Actividad SCORM: un párrafo CLEAN_SAFE (Moodle abre el SCO en su página).
 * Sin cifras (las da el label de instrucción, desde facts). Puro.
 */
import type { ResolvedTheme } from '../../modules/theme-engine';
import { contrastRatio } from '../../modules/theme-engine';
import { esc } from '../mbz-common';
import { CURSIA_IV_INLINE_SCRIPT, H5P_EMBED_FROM_PLUGINFILE, VideoIntroTheme } from '../h5p';

export const ACTIVITY_INTRO_COPY = Object.freeze({
  heading: 'Actividad práctica calificable',
  body: 'Responde dentro de este recuadro. Al terminar, tu resultado queda registrado como la nota de esta actividad.',
  openLink: 'Abrir la actividad práctica',
  scormBody: 'Abre la actividad para practicar lo aprendido en este capítulo. Tu resultado queda registrado como la nota de esta actividad.',
});

const PACKAGE_FILENAME_RE = /^[a-z0-9][a-z0-9._-]{0,120}\.h5p$/;

function pick(t: ResolvedTheme, bg: string, cands: string[]): string {
  const ok = cands.find((c) => contrastRatio(c, bg) >= 4.5);
  if (!ok) throw new Error(`ACTIVITY_INTRO_THEME: ningún color legible sobre ${bg}`);
  return ok;
}

/** Colores del bloque de respaldo (R8 `VideoIntroTheme`) desde el tema resuelto, con contraste ≥ 4.5 verificado. */
export function introThemeFrom(t: ResolvedTheme): VideoIntroTheme {
  const c = t.color;
  const surface = c.surface;
  return {
    surface,
    border: c.border,
    textPrimary: pick(t, surface, [c.textPrimary, c.textSecondary]),
    textSecondary: pick(t, surface, [c.textSecondary, c.textPrimary]),
    accent: pick(t, surface, [c.accentStrong, c.accent, c.textPrimary]),
  };
}

/** Nombre del `.h5p` de la actividad: `activity:<uuid>` → `cursia-activity-<uuid>.h5p`. */
export function activityPackageFilename(itemKey: string): string {
  const slug = String(itemKey || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const name = `cursia-${slug}.h5p`;
  if (!slug || !PACKAGE_FILENAME_RE.test(name)) throw new Error(`ACTIVITY_PACKAGE_FILENAME_INVALID: ${JSON.stringify(itemKey)}`);
  return name;
}

export function h5pActivityInlineIntroHtml(input: { packageFilename: string; title: string; activityMid: number; theme: VideoIntroTheme }): string {
  const { packageFilename, title, activityMid, theme: t } = input;
  if (!PACKAGE_FILENAME_RE.test(packageFilename)) throw new Error(`ACTIVITY_INTRO_INVALID: packageFilename ${packageFilename}`);
  if (typeof title !== 'string' || !title.trim()) throw new Error('ACTIVITY_INTRO_INVALID: title vacío');
  if (!Number.isInteger(activityMid) || activityMid < 1) throw new Error(`ACTIVITY_INTRO_INVALID: activityMid ${activityMid}`);
  const C = ACTIVITY_INTRO_COPY;
  const src = `${H5P_EMBED_FROM_PLUGINFILE}?url=@@PLUGINFILE@@/${packageFilename}&amp;component=mod_h5pactivity`;
  return [
    `<div class="cursia-iv" style="max-width:960px;margin:0 0 16px 0;padding:0;">`,
    `<div class="cursia-iv-inline" style="display:none;margin:0 0 12px 0;padding:0;">`,
    `<iframe title="${esc(title.trim())}" data-cursia-src="${src}" loading="lazy" width="100%" height="560" style="width:100%;border:0;" allowfullscreen="allowfullscreen"></iframe>`,
    `</div>`,
    `<div class="cursia-iv-fallback" style="background-color:${t.surface};color:${t.textPrimary};border:1px solid ${t.border};border-left:4px solid ${t.accent};padding:12px 16px;margin:0;font-size:16px;line-height:1.5;">`,
    `<p style="margin:0 0 6px 0;color:${t.textPrimary};"><strong>${esc(C.heading)}</strong></p>`,
    `<p style="margin:0 0 10px 0;color:${t.textPrimary};">${esc(C.body)}</p>`,
    `<p class="cursia-iv-open" style="margin:0;"><a href="$@H5PACTIVITYVIEWBYID*${activityMid}@$" style="color:${t.accent};font-weight:bold;">${esc(C.openLink)}</a></p>`,
    `</div>`,
    `<script>${CURSIA_IV_INLINE_SCRIPT}</script>`,
    `</div>`,
  ].join('\n');
}

export function scormIntroHtml(theme: VideoIntroTheme): string {
  return (
    `<div style="background-color:${theme.surface};color:${theme.textPrimary};border:1px solid ${theme.border};padding:12px 16px;margin:0;font-size:16px;line-height:1.5;">` +
    `<p style="margin:0;color:${theme.textPrimary};">${esc(ACTIVITY_INTRO_COPY.scormBody)}</p></div>`
  );
}
