// Cursia V2.1 / R8 — intro inline del video interactivo (HD-V21-2, §X.2).
//
// Receta probada en R0: el intro de la PROPIA actividad h5pactivity
// (showdescription=1) lleva
//   <iframe src="/h5p/embed.php?url=@@PLUGINFILE@@/<file>&component=mod_h5pactivity">
// con una copia del .h5p en el filearea `intro` (mismo hash que `package`).
// Moodle resuelve @@PLUGINFILE@@ al mostrar y el tracking xAPI usa el contexto
// del módulo ⇒ el video se responde inline en la página del curso y califica.
//
// Nivel CLEAN_SAFE (§X.1): con forceclean=1 el iframe y el <script> se eliminan,
// así que SIEMPRE hay un bloque visible fuera del iframe con:
//   - "Abrir el video interactivo" → $@H5PACTIVITYVIEWBYID*<mid>@$ (se resuelve al restaurar);
//   - "Ver el video en YouTube" (class="nomediaplugin": el filtro multimedia no
//     incrusta un segundo reproductor).
// Solo hex, fondo sólido, margin/padding/border, flujo de bloques; nada depende
// de iframe, aria ni display.
//
// Carga diferida y sin rutas fijas (review G4 I2/I3):
// - El iframe NO lleva `src`: la URL va en `data-cursia-src` y un script inline
//   (namespaced `window.CursiaIV`, idempotente) la asigna cuando el iframe se
//   acerca al viewport (IntersectionObserver; sin IO ⇒ inmediato). Así el curso
//   no arranca N reproductores + N YouTube a la vez.
// - En la propia view.php de la actividad (Moodle ya muestra su reproductor
//   principal) el script ELIMINA el bloque inline antes de cargarlo: nunca hay
//   dos instancias guardando estado xAPI sobre el mismo contexto.
// - Sin JS el bloque inline queda oculto (display:none) y el enlace visible es
//   el camino a la actividad.
// - La URL del embed se deriva del plugin URL reescrito por Moodle:
//   "@@PLUGINFILE@@/../../../../h5p/embed.php" = <wwwroot>/h5p/embed.php también
//   con wwwroot en subcarpeta (pluginfile.php/<ctx>/mod_h5pactivity/intro/../../../../).
// - La lógica del h5p-resizer (MIT, H5P) va inline: no depende de h5plib/vNNN.
import { esc } from '../../mbz-common';

/** Del filearea intro (pluginfile.php/<ctx>/mod_h5pactivity/intro) a <wwwroot>: 4 niveles. */
export const H5P_EMBED_FROM_PLUGINFILE = '@@PLUGINFILE@@/../../../../h5p/embed.php';

/**
 * Script inline (sin `<`, `>` ni `&` para sobrevivir cualquier escape): cargador
 * diferido + resizer H5P (port de h5p-resizer.js, MIT © Joubel; respeta
 * window.h5pResizerInitialized para no duplicarse con el de Moodle).
 */
export const CURSIA_IV_INLINE_SCRIPT = String.raw`(function(w,d){var C=w.CursiaIV;if(!C){C=w.CursiaIV={v:1};` +
  String.raw`C.resizer=function(){if(w.h5pResizerInitialized||!w.postMessage||!w.addEventListener){return}w.h5pResizerInitialized=true;` +
  String.raw`var H={hello:function(f,x,r){f.style.width='100%';f.getBoundingClientRect();var rs=function(){if(f.contentWindow){r('resize')}else{w.removeEventListener('resize',rs)}};w.addEventListener('resize',rs,false);r('hello')},` +
  String.raw`prepareResize:function(f,x,r){if(f.clientHeight!==x.scrollHeight||x.scrollHeight!==x.clientHeight){f.style.height=x.clientHeight+'px';r('resizePrepared')}},` +
  String.raw`resize:function(f,x){f.style.height=x.scrollHeight+'px'}};` +
  String.raw`w.addEventListener('message',function(e){var x=e.data;if(!x||x.context!=='h5p'||!H[x.action]){return}var fs=d.getElementsByTagName('iframe'),f=null;for(var i=0;i!==fs.length;i++){if(fs[i].contentWindow===e.source){f=fs[i];break}}if(!f){return}H[x.action](f,x,function(a,p){p=p||{};p.action=a;p.context='h5p';e.source.postMessage(p,e.origin)})},false)};` +
  String.raw`C.load=function(f){if(!f.getAttribute('src')){f.setAttribute('src',f.getAttribute('data-cursia-src'))}};` +
  String.raw`C.scan=function(){var onView=/\/mod\/h5pactivity\/view\.php$/.test(w.location.pathname);var bs=d.querySelectorAll('.cursia-iv-inline');` +
  String.raw`for(var i=0;i!==bs.length;i++){var b=bs[i];if(b.getAttribute('data-cursia-done')){continue}b.setAttribute('data-cursia-done','1');var root=b.parentNode;var f=b.querySelector('iframe[data-cursia-src]');` +
  String.raw`if(onView){root.removeChild(b);var o=root.querySelector('.cursia-iv-open');if(o){o.style.display='none'}continue}if(!f){continue}b.style.display='block';` +
  String.raw`if('IntersectionObserver' in w){(function(f){var io=new w.IntersectionObserver(function(es){for(var j=0;j!==es.length;j++){if(es[j].isIntersecting){io.disconnect();C.load(f)}}},{rootMargin:'400px 0px'});io.observe(f)})(f)}else{C.load(f)}}}}` +
  String.raw`C.resizer();C.scan()})(window,document);`;

export interface VideoIntroTheme {
  surface: string;
  border: string;
  textPrimary: string;
  textSecondary: string;
  accent: string;
}

/** Paleta neutra por defecto (contraste AA sobre `surface`). Compatible con ThemeColorTokens (R1). */
export const VIDEO_INTRO_DEFAULT_THEME: Readonly<VideoIntroTheme> = Object.freeze({
  surface: '#F4F6FA',
  border: '#D0D7E2',
  textPrimary: '#1B2430',
  textSecondary: '#4A5565',
  accent: '#1F5FBF',
});

const HEX_RE = /^#[0-9A-Fa-f]{6}$/;
const PACKAGE_FILENAME_RE = /^[a-z0-9][a-z0-9._-]{0,120}\.h5p$/;
const YOUTUBE_ID_RE = /^[A-Za-z0-9_-]{11}$/;

export const VIDEO_INTRO_COPY = Object.freeze({
  heading: 'Video interactivo calificable',
  body:
    'Durante el video aparecerán preguntas que pausan la reproducción. Respóndelas y, al llegar al final, envía tus respuestas: así queda registrada tu nota de esta actividad.',
  openLink: 'Abrir el video interactivo',
  youtubeLink: 'Ver el video en YouTube',
  youtubeNote: '(solo el video, sin preguntas ni nota)',
});

export interface VideoInlineIntroInput {
  packageFilename: string;
  title: string;
  activityMid: number;
  youtubeId: string;
  theme?: Partial<VideoIntroTheme>;
}

/** Nombre de archivo determinístico del .h5p a partir del item_key (`video:ch3` → `cursia-video-ch3.h5p`). */
export function videoPackageFilename(itemKey: string): string {
  const slug = String(itemKey || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!slug) throw new Error(`VIDEO_PACKAGE_FILENAME_INVALID: itemKey vacío o sin caracteres válidos (${JSON.stringify(itemKey)})`);
  const name = `cursia-${slug}.h5p`.replace(/^cursia-cursia-/, 'cursia-');
  if (!PACKAGE_FILENAME_RE.test(name)) throw new Error(`VIDEO_PACKAGE_FILENAME_INVALID: ${name}`);
  return name;
}

function resolveTheme(theme?: Partial<VideoIntroTheme>): VideoIntroTheme {
  const t: VideoIntroTheme = { ...VIDEO_INTRO_DEFAULT_THEME, ...(theme || {}) };
  for (const [k, v] of Object.entries(t)) {
    if (typeof v !== 'string' || !HEX_RE.test(v)) {
      throw new Error(`VIDEO_INTRO_INVALID: theme.${k} debe ser un color hex #RRGGBB (recibido ${JSON.stringify(v)})`);
    }
  }
  return t;
}

/**
 * HTML del intro (formato HTML, introformat=1). Puro y determinístico.
 * No lleva números de preguntas ni de nota: esos vienen de los facts más adelante.
 */
export function videoInlineIntroHtml(input: VideoInlineIntroInput): string {
  const { packageFilename, title, activityMid, youtubeId } = input || ({} as VideoInlineIntroInput);
  const errs: string[] = [];
  if (typeof packageFilename !== 'string' || !PACKAGE_FILENAME_RE.test(packageFilename)) {
    errs.push(`packageFilename inválido (${JSON.stringify(packageFilename)}; [a-z0-9._-] y .h5p)`);
  }
  if (typeof title !== 'string' || !title.trim() || /[<>]/.test(title)) errs.push('title vacío o con HTML');
  if (!Number.isInteger(activityMid) || activityMid <= 0) errs.push(`activityMid debe ser un entero > 0 (recibido ${String(activityMid)})`);
  if (typeof youtubeId !== 'string' || !YOUTUBE_ID_RE.test(youtubeId)) errs.push(`youtubeId inválido (${JSON.stringify(youtubeId)})`);
  if (errs.length) throw new Error(`VIDEO_INTRO_INVALID: ${errs.join('; ')}`);
  const t = resolveTheme(input.theme);
  const C = VIDEO_INTRO_COPY;
  const src = `${H5P_EMBED_FROM_PLUGINFILE}?url=@@PLUGINFILE@@/${packageFilename}&amp;component=mod_h5pactivity`;
  const yt = `https://www.youtube.com/watch?v=${youtubeId}`;
  const viewToken = `$@H5PACTIVITYVIEWBYID*${activityMid}@$`;
  return [
    `<div class="cursia-iv" style="max-width:960px;margin:0 0 16px 0;padding:0;">`,
    // Oculto hasta que el script lo active (sin JS ⇒ solo el bloque de respaldo).
    `<div class="cursia-iv-inline" style="display:none;margin:0 0 12px 0;padding:0;">`,
    `<iframe title="${esc(title.trim())}" data-cursia-src="${src}" loading="lazy" width="100%" height="560" style="width:100%;border:0;" allowfullscreen="allowfullscreen"></iframe>`,
    `</div>`,
    `<div class="cursia-iv-fallback" style="background-color:${t.surface};color:${t.textPrimary};border:1px solid ${t.border};border-left:4px solid ${t.accent};padding:12px 16px;margin:0;font-size:15px;line-height:1.5;">`,
    `<p style="margin:0 0 6px 0;color:${t.textPrimary};"><strong>${esc(C.heading)}</strong></p>`,
    `<p style="margin:0 0 10px 0;color:${t.textPrimary};">${esc(C.body)}</p>`,
    `<p class="cursia-iv-open" style="margin:0 0 6px 0;"><a href="${viewToken}" style="color:${t.accent};font-weight:bold;">${esc(C.openLink)}</a></p>`,
    `<p style="margin:0;color:${t.textSecondary};"><a class="nomediaplugin" href="${yt}" style="color:${t.textSecondary};">${esc(C.youtubeLink)}</a> ${esc(C.youtubeNote)}</p>`,
    `</div>`,
    `<script>${CURSIA_IV_INLINE_SCRIPT}</script>`,
    `</div>`,
  ].join('\n');
}
