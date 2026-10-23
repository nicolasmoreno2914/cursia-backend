/**
 * Cursia V2.1 — R12: intros de las actividades calificables del capítulo.
 *
 * - Actividad H5P: misma receta probada que el video (R8, HD-V21-2): un
 *   iframe `embed.php` diferido, con la URL derivada de `@@PLUGINFILE@@` (sirve
 *   con wwwroot en subcarpeta). V542 I2: el iframe carga el `.h5p` del filearea
 *   `package` (el mismo de view.php; ya NO hay copia en `intro`) → un contenido
 *   y un estado por actividad
 *   y el resizer H5P inline (`CURSIA_IV_INLINE_SCRIPT`, sin h5plib/vNNN).
 *   Con forceclean=1 el iframe y el script se eliminan y queda el bloque de
 *   respaldo con el enlace a la actividad (`$@H5PACTIVITYVIEWBYID*mid@$`).
 * - Actividad SCORM: un párrafo CLEAN_SAFE (Moodle abre el SCO en su página).
 * Sin cifras (las da el label de instrucción, desde facts). Puro.
 */
import type { ResolvedTheme } from '../../modules/theme-engine';
import { contrastRatio } from '../../modules/theme-engine';
import { esc } from '../mbz-common';
import { h5pInlineEmbedSrc, h5pInlineScript, VideoIntroTheme } from '../h5p';

export const ACTIVITY_INTRO_COPY = Object.freeze({
  heading: 'Actividad práctica calificable',
  body: 'Responde dentro de este recuadro. Al terminar, tu resultado queda registrado como la nota de esta actividad.',
  openLink: 'Abrir la actividad práctica',
  scormBody: 'Abre la actividad para practicar lo aprendido en este capítulo. Tu resultado queda registrado como la nota de esta actividad.',
  /** P3: cabecera del marco (texto, sin cifras salvo el número de capítulo de facts). */
  // fix M3: «Práctica del capítulo N · Responde aquí: …» (el número va después de «capítulo», de facts).
  frameHeading: 'Práctica del capítulo {n} · Responde aquí: tu resultado queda registrado como nota',
  frameScormHeading: 'Práctica calificada del capítulo {n}',
  frameFallbackLead: '¿No se ve la actividad? ',
  frameFallbackLink: 'Ábrela en su propia página →',
});

/**
 * EV6 H5P v2 — «Repaso» (Dialog Cards): opcional y SIN nota. Nunca dice «calificable»
 * ni «nota de esta actividad» (ruling Q5: no cuenta para la nota ni para completar el curso).
 */
export const REVIEW_CARDS_INTRO_COPY = Object.freeze({
  frameHeading: 'Repaso del capítulo {n} · Tarjetas opcionales: gira cada una y comprueba si la sabías (no tiene nota)',
  frameFallbackLead: '¿No se ven las tarjetas? ',
  frameFallbackLink: 'Ábrelas en su propia página →',
});

/** Intro del «Repaso»: mismo marco y cargador diferido que la práctica, con el texto del repaso. */
export function reviewCardsIntroHtml(input: { packageFilename: string; title: string; activityMid: number; theme: VideoIntroTheme; frame: ActivityFrameTone }): string {
  const { packageFilename, title, activityMid, theme: t, frame: f } = input;
  if (!PACKAGE_FILENAME_RE.test(packageFilename)) throw new Error(`ACTIVITY_INTRO_INVALID: packageFilename ${packageFilename}`);
  if (typeof title !== 'string' || !title.trim()) throw new Error('ACTIVITY_INTRO_INVALID: title vacío');
  if (!Number.isInteger(activityMid) || activityMid < 1) throw new Error(`ACTIVITY_INTRO_INVALID: activityMid ${activityMid}`);
  checkFrame(t, f);
  const C = REVIEW_CARDS_INTRO_COPY;
  const src = h5pInlineEmbedSrc(packageFilename, 'package');
  return [
    `<div class="cursia-iv cvc-act cvc-review" style="max-width:960px;margin:0 0 16px 0;padding:0;background-color:${t.surface};color:${t.textPrimary};border:1px solid ${f.edge};border-radius:14px;overflow:hidden;">`,
    frameHead(t, f, C.frameHeading),
    `<div class="cursia-iv-inline" style="display:none;margin:0;padding:14px;">`,
    `<iframe title="${esc(title.trim())}" data-cursia-src="${src}" loading="lazy" width="100%" height="520" style="width:100%;border:0;" allowfullscreen="allowfullscreen"></iframe>`,
    `</div>`,
    `<div class="cursia-iv-fallback" style="background-color:${t.surface};color:${t.textPrimary};margin:0;padding:12px 18px 14px 18px;font-size:16px;line-height:1.5;border-top:1px solid ${f.edge};">`,
    `<p class="cursia-iv-open" style="margin:0;color:${t.textSecondary};"><span class="nolink">${esc(C.frameFallbackLead)}</span><a href="$@H5PACTIVITYVIEWBYID*${activityMid}@$" style="color:${f.ink};font-weight:bold;"><span class="nolink">${esc(C.frameFallbackLink)}</span></a></p>`,
    `</div>`,
    `<script>${h5pInlineScript('package')}</script>`,
    `</div>`,
  ].join('\n');
}

/**
 * P3 — marco de la actividad con el tono del módulo del capítulo (moduleTone): la actividad H5P (cuya
 * interfaz no se puede estilar) se lee como «una ventana del curso». ink ≥ 4.5 sobre soft y surface.
 */
export interface ActivityFrameTone {
  ink: string;
  soft: string;
  edge: string;
  chapterNumber: number;
}

function checkFrame(t: VideoIntroTheme, f: ActivityFrameTone): void {
  for (const [k, v] of Object.entries({ ink: f.ink, soft: f.soft, edge: f.edge })) if (!/^#[0-9A-F]{6}$/.test(v)) throw new Error(`ACTIVITY_INTRO_INVALID: frame.${k} ${v}`);
  if (!Number.isInteger(f.chapterNumber) || f.chapterNumber < 1) throw new Error(`ACTIVITY_INTRO_INVALID: frame.chapterNumber ${f.chapterNumber}`);
  if (contrastRatio(f.ink, f.soft) < 4.5 || contrastRatio(f.ink, t.surface) < 4.5 || contrastRatio(t.textPrimary, f.soft) < 4.5) throw new Error('ACTIVITY_INTRO_THEME: el marco no alcanza 4.5:1');
}

function frameHead(t: VideoIntroTheme, f: ActivityFrameTone, text: string): string {
  return (
    `<div class="cvc-act-h" style="background-color:${f.soft};color:${t.textPrimary};margin:0;padding:12px 18px;border-bottom:1px solid ${f.edge};">` +
    `<p class="cvc-meta" style="margin:0;color:${f.ink};font-size:16px;font-weight:700;line-height:1.4;"><span class="nolink">✎  ${esc(text.replace('{n}', String(f.chapterNumber)))}</span></p></div>`
  );
}

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

export function h5pActivityInlineIntroHtml(input: { packageFilename: string; title: string; activityMid: number; theme: VideoIntroTheme; frame?: ActivityFrameTone }): string {
  const { packageFilename, title, activityMid, theme: t } = input;
  if (input.frame) return framedH5pIntro({ ...input, frame: input.frame });
  if (!PACKAGE_FILENAME_RE.test(packageFilename)) throw new Error(`ACTIVITY_INTRO_INVALID: packageFilename ${packageFilename}`);
  if (typeof title !== 'string' || !title.trim()) throw new Error('ACTIVITY_INTRO_INVALID: title vacío');
  if (!Number.isInteger(activityMid) || activityMid < 1) throw new Error(`ACTIVITY_INTRO_INVALID: activityMid ${activityMid}`);
  const C = ACTIVITY_INTRO_COPY;
  const src = h5pInlineEmbedSrc(packageFilename, 'package');
  return [
    `<div class="cursia-iv" style="max-width:960px;margin:0 0 16px 0;padding:0;">`,
    `<div class="cursia-iv-inline" style="display:none;margin:0 0 12px 0;padding:0;">`,
    `<iframe title="${esc(title.trim())}" data-cursia-src="${src}" loading="lazy" width="100%" height="560" style="width:100%;border:0;" allowfullscreen="allowfullscreen"></iframe>`,
    `</div>`,
    `<div class="cursia-iv-fallback" style="background-color:${t.surface};color:${t.textPrimary};border-top:1px solid ${t.border};padding:16px 20px 14px 20px;margin:0;font-size:16px;line-height:1.5;">`,
    `<p class="cvc-meta" style="margin:0 0 6px 0;color:${t.accent};font-size:14px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;">${esc(C.heading)}</p>`,
    `<p style="margin:0 0 10px 0;color:${t.textSecondary};max-width:68ch;">${esc(C.body)}</p>`,
    `<p class="cursia-iv-open" style="margin:0;"><a href="$@H5PACTIVITYVIEWBYID*${activityMid}@$" style="color:${t.accent};font-weight:bold;">${esc(C.openLink)}</a></p>`,
    `</div>`,
    `<script>${h5pInlineScript('package')}</script>`,
    `</div>`,
  ].join('\n');
}

export function scormIntroHtml(theme: VideoIntroTheme, frame?: ActivityFrameTone): string {
  if (frame) {
    checkFrame(theme, frame);
    return (
      `<div class="cvc-act" style="background-color:${theme.surface};color:${theme.textPrimary};border:1px solid ${frame.edge};margin:0;padding:0;font-size:16px;line-height:1.5;">` +
      frameHead(theme, frame, ACTIVITY_INTRO_COPY.frameScormHeading) +
      `<p style="margin:0;padding:12px 18px 14px 18px;color:${theme.textPrimary};"><span class="nolink">${esc(ACTIVITY_INTRO_COPY.scormBody)}</span></p></div>`
    );
  }
  return (
    `<div style="background-color:${theme.surface};color:${theme.textPrimary};border-top:1px solid ${theme.border};padding:16px 20px 14px 20px;margin:0;font-size:16px;line-height:1.5;">` +
    `<p style="margin:0;color:${theme.textPrimary};">${esc(ACTIVITY_INTRO_COPY.scormBody)}</p></div>`
  );
}

/**
 * P3 — H5P enmarcado: cabecera del módulo, el iframe (mismo cargador diferido R8) y al pie el acceso
 * alternativo. Clases cursia-iv / -inline / -open / -fallback intactas (script y QA del navegador).
 */
function framedH5pIntro(input: { packageFilename: string; title: string; activityMid: number; theme: VideoIntroTheme; frame: ActivityFrameTone }): string {
  const { packageFilename, title, activityMid, theme: t, frame: f } = input;
  checkFrame(t, f);
  const C = ACTIVITY_INTRO_COPY;
  const src = h5pInlineEmbedSrc(packageFilename, 'package');
  return [
    `<div class="cursia-iv cvc-act" style="max-width:960px;margin:0 0 16px 0;padding:0;background-color:${t.surface};color:${t.textPrimary};border:1px solid ${f.edge};border-radius:14px;overflow:hidden;">`,
    frameHead(t, f, C.frameHeading),
    `<div class="cursia-iv-inline" style="display:none;margin:0;padding:14px;">`,
    `<iframe title="${esc(title.trim())}" data-cursia-src="${src}" loading="lazy" width="100%" height="560" style="width:100%;border:0;" allowfullscreen="allowfullscreen"></iframe>`,
    `</div>`,
    `<div class="cursia-iv-fallback" style="background-color:${t.surface};color:${t.textPrimary};margin:0;padding:12px 18px 14px 18px;font-size:16px;line-height:1.5;border-top:1px solid ${f.edge};">`,
    `<p class="cursia-iv-open" style="margin:0;color:${t.textSecondary};"><span class="nolink">${esc(C.frameFallbackLead)}</span><a href="$@H5PACTIVITYVIEWBYID*${activityMid}@$" style="color:${f.ink};font-weight:bold;"><span class="nolink">${esc(C.frameFallbackLink)}</span></a></p>`,
    `</div>`,
    `<script>${h5pInlineScript('package')}</script>`,
    `</div>`,
  ].join('\n');
}
