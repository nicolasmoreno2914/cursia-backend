/**
 * EV6 (T3) — certificado nativo de Moodle: una INSIGNIA DE CURSO (core_badges) que Moodle
 * otorga sola al completar el curso. Sin plugins externos (Moodle core no trae un módulo de
 * certificados; la insignia es el mecanismo nativo: el estudiante la ve en su perfil y la
 * descarga como PNG «horneado» Open Badges).
 *
 * Forma del XML = `badges.xml` de un backup real de Moodle 4.5 (scratchpad r18/badge-ref).
 * Restauración (`restore_badges_structure_step`, backup/moodle2/restore_stepslib.php):
 *  - el parámetro del criterio de curso se llama `course_{id}` con el id del curso DEL BACKUP
 *    (1 en los paquetes Cursia: `<course id="1">`, `original_course_id` = 1); la restauración
 *    lo reescribe como `course_{id nuevo}` (process_parameter, BADGE_CRITERIA_TYPE_COURSE);
 *  - la imagen va en `files.xml` con component `badges`, filearea `badgeimage`,
 *    itemid = id de la insignia en el backup y contextid = `original_course_contextid` (2: NO
 *    puede coincidir con `original_system_contextid`, o la imagen se restaura en el de sistema);
 *    `restore_load_included_files` carga siempre el componente `badges` (sin inforef) y
 *    `after_execute` → add_related_files('badges', 'badgeimage', 'badge') la reasigna.
 *    Moodle usa f1.png (100 px), f2.png (35 px) y f3.png (512 px; la que se «hornea»).
 *  - OJO: Moodle SIEMPRE restaura la insignia con status = BADGE_STATUS_INACTIVE (0), aunque el
 *    XML diga 1 (decisión de core). Quien administra el curso debe pulsar «Habilitar acceso»
 *    en Insignias del curso una vez tras restaurar; desde ese momento se otorga automáticamente.
 *
 * PURO y DETERMINÍSTICO: la imagen se rasteriza con aritmética en coma flotante IEEE (solo
 * +, −, ×, ÷, sqrt, min/max, round) y se codifica con `encodePng` (deflate nivel 9).
 */
import type { ResolvedTheme } from '../../modules/theme-engine';
import { safeActivityName, xmlEsc } from '../mbz-common';
import { encodePng } from './synthetic-media';

const NULL = '$@NULL@$';

/** Id de la insignia dentro del backup (itemid de los archivos `badgeimage`). */
export const COURSE_BADGE_BACKUP_ID = 1;
/** Emisor por defecto: el backend no recibe (hoy) el nombre de la institución. */
export const COURSE_BADGE_DEFAULT_ISSUER = 'Cursia';
/** Tamaños que Moodle genera en `process_new_icon` (lib/gdlib.php). */
export const COURSE_BADGE_IMAGE_SIZES: ReadonlyArray<{ filename: string; size: number }> = [
  { filename: 'f1.png', size: 100 },
  { filename: 'f2.png', size: 35 },
  { filename: 'f3.png', size: 512 },
];
/** BADGE_CRITERIA_TYPE_OVERALL / BADGE_CRITERIA_TYPE_COURSE / BADGE_CRITERIA_AGGREGATION_ALL (lib/badgeslib.php). */
export const BADGE_CRITERIA_TYPE_OVERALL = 0;
export const BADGE_CRITERIA_TYPE_COURSE = 4;
export const BADGE_CRITERIA_AGGREGATION_ALL = 1;

export const COURSE_BADGE_MESSAGE_SUBJECT = '¡Felicitaciones! Obtuviste tu certificado';
export const COURSE_BADGE_MESSAGE =
  'Completaste el curso y obtuviste el certificado «%badgename%». Lo encuentras en tu perfil, en Insignias, y puedes descargarlo desde ahí.';

export interface CourseBadgeInput {
  courseTitle: string;
  /** `<course id>` del backup (el que la restauración remapea). */
  courseBackupId: number;
  /** true → el curso tiene evaluación final (y la completion la exige). */
  hasFinalExam: boolean;
  ts: number;
  issuerName?: string;
}

export function courseBadgeName(courseTitle: string): string {
  const title = String(courseTitle ?? '').trim();
  if (!title) throw new Error('COURSE_BADGE_INVALID: título del curso vacío');
  // safeActivityName puede agregar «…» tras cortar: 254 + 1 ≤ 255 (badge.name es varchar 255).
  return safeActivityName(`Certificado: ${title}`, 254);
}

export function courseBadgeDescription(courseTitle: string, hasFinalExam: boolean): string {
  const title = String(courseTitle ?? '').trim();
  return hasFinalExam
    ? `Otorgado al completar el curso «${title}» y aprobar la evaluación final.`
    : `Otorgado al completar el curso «${title}».`;
}

/** `badges.xml` raíz con UNA insignia de curso: criterio global ALL + completion del curso. */
export function courseBadgeXml(p: CourseBadgeInput): string {
  if (!Number.isInteger(p.courseBackupId) || p.courseBackupId < 1) throw new Error(`COURSE_BADGE_INVALID: courseBackupId ${p.courseBackupId}`);
  if (!Number.isInteger(p.ts) || p.ts <= 0) throw new Error('COURSE_BADGE_INVALID: ts');
  const issuer = String(p.issuerName ?? COURSE_BADGE_DEFAULT_ISSUER).trim() || COURSE_BADGE_DEFAULT_ISSUER;
  const id = COURSE_BADGE_BACKUP_ID;
  const cid = p.courseBackupId;
  return `<?xml version="1.0" encoding="UTF-8"?>
<badges>
  <badge id="${id}">
    <name>${xmlEsc(courseBadgeName(p.courseTitle))}</name>
    <description>${xmlEsc(courseBadgeDescription(p.courseTitle, p.hasFinalExam))}</description>
    <timecreated>${p.ts}</timecreated>
    <timemodified>${p.ts}</timemodified>
    <usercreated>0</usercreated>
    <usermodified>0</usermodified>
    <issuername>${xmlEsc(safeActivityName(issuer, 254))}</issuername>
    <issuerurl></issuerurl>
    <issuercontact></issuercontact>
    <expiredate>${NULL}</expiredate>
    <expireperiod>${NULL}</expireperiod>
    <type>2</type>
    <courseid>${cid}</courseid>
    <message>${xmlEsc(COURSE_BADGE_MESSAGE)}</message>
    <messagesubject>${xmlEsc(COURSE_BADGE_MESSAGE_SUBJECT)}</messagesubject>
    <attachment>1</attachment>
    <notification>0</notification>
    <status>1</status>
    <nextcron>${NULL}</nextcron>
    <version></version>
    <language>es</language>
    <imageauthorname>${NULL}</imageauthorname>
    <imageauthoremail>${NULL}</imageauthoremail>
    <imageauthorurl>${NULL}</imageauthorurl>
    <imagecaption>${xmlEsc(courseBadgeName(p.courseTitle))}</imagecaption>
    <criteria>
      <criterion id="1">
        <badgeid>${id}</badgeid>
        <criteriatype>${BADGE_CRITERIA_TYPE_OVERALL}</criteriatype>
        <method>${BADGE_CRITERIA_AGGREGATION_ALL}</method>
        <description></description>
        <descriptionformat>1</descriptionformat>
        <parameters>
        </parameters>
      </criterion>
      <criterion id="2">
        <badgeid>${id}</badgeid>
        <criteriatype>${BADGE_CRITERIA_TYPE_COURSE}</criteriatype>
        <method>${BADGE_CRITERIA_AGGREGATION_ALL}</method>
        <description></description>
        <descriptionformat>1</descriptionformat>
        <parameters>
          <parameter id="1">
            <critid>2</critid>
            <name>course_${cid}</name>
            <value>${cid}</value>
            <criteriatype>${BADGE_CRITERIA_TYPE_COURSE}</criteriatype>
          </parameter>
        </parameters>
      </criterion>
    </criteria>
    <alignments>
    </alignments>
    <relatedbadges>
    </relatedbadges>
    <manual_awards>
    </manual_awards>
    <tags>
    </tags>
  </badge>
</badges>`;
}

// ─── Imagen ────────────────────────────────────────────────────────────────

type Rgb = [number, number, number];

function hexRgb(hex: string, what: string): Rgb {
  const m = /^#([0-9A-Fa-f]{6})$/.exec(String(hex ?? '').trim());
  if (!m) throw new Error(`COURSE_BADGE_INVALID: color ${what} no es #RRGGBB (${String(hex)})`);
  const v = m[1];
  return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)];
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const vx = bx - ax;
  const vy = by - ay;
  const t = clamp01(((px - ax) * vx + (py - ay) * vy) / (vx * vx + vy * vy));
  const dx = px - (ax + vx * t);
  const dy = py - (ay + vy * t);
  return Math.sqrt(dx * dx + dy * dy);
}

/** Distancia con signo a una cinta: rectángulo orientado de a→b con media anchura hw y punta en V. */
function ribbonDist(px: number, py: number, ax: number, ay: number, bx: number, by: number, hw: number, notch: number): number {
  const vx = bx - ax;
  const vy = by - ay;
  const len = Math.sqrt(vx * vx + vy * vy);
  const ux = vx / len;
  const uy = vy / len;
  const rx = px - ax;
  const ry = py - ay;
  const along = rx * ux + ry * uy;
  const across = rx * -uy + ry * ux;
  const aAbs = across < 0 ? -across : across;
  // Punta en V: el largo disponible se acorta en el centro de la cinta.
  const end = len - notch * (1 - clamp01(aAbs / hw));
  const dAlong = Math.max(-along, along - end);
  const dAcross = aAbs - hw;
  if (dAlong > 0 && dAcross > 0) return Math.sqrt(dAlong * dAlong + dAcross * dAcross);
  return Math.max(dAlong, dAcross);
}

/**
 * PNG RGBA cuadrada (fondo transparente): medalla con el acento del tema, aro interior y
 * visto (✓) en `textOnAccent` (contraste garantizado por el Theme Engine) y dos cintas en
 * `accentStrong`. Sin texto: el título del curso NO va en la imagen.
 */
export function renderCourseBadgePng(theme: Pick<ResolvedTheme, 'color'>, size: number): Buffer {
  if (!Number.isInteger(size) || size < 16 || size > 1024) throw new Error(`COURSE_BADGE_INVALID: tamaño ${size}`);
  const accent = hexRgb(theme.color.accent, 'accent');
  const strong = hexRgb(theme.color.accentStrong, 'accentStrong');
  const on = hexRgb(theme.color.textOnAccent, 'textOnAccent');
  const shapes: Array<{ rgb: Rgb; alpha: number; dist: (x: number, y: number) => number }> = [
    { rgb: strong, alpha: 1, dist: (x, y) => ribbonDist(x, y, 0.4, 0.62, 0.29, 0.95, 0.075, 0.06) },
    { rgb: strong, alpha: 1, dist: (x, y) => ribbonDist(x, y, 0.6, 0.62, 0.71, 0.95, 0.075, 0.06) },
    { rgb: strong, alpha: 1, dist: (x, y) => Math.sqrt((x - 0.5) * (x - 0.5) + (y - 0.42) * (y - 0.42)) - 0.37 },
    { rgb: accent, alpha: 1, dist: (x, y) => Math.sqrt((x - 0.5) * (x - 0.5) + (y - 0.42) * (y - 0.42)) - 0.34 },
    {
      rgb: on,
      alpha: 0.85,
      dist: (x, y) => {
        const r = Math.sqrt((x - 0.5) * (x - 0.5) + (y - 0.42) * (y - 0.42)) - 0.28;
        return (r < 0 ? -r : r) - 0.012;
      },
    },
    {
      rgb: on,
      alpha: 1,
      dist: (x, y) => Math.min(segDist(x, y, 0.37, 0.43, 0.46, 0.52), segDist(x, y, 0.46, 0.52, 0.64, 0.33)) - 0.038,
    },
  ];
  // Premultiplicado en coma flotante; cobertura AA = clamp(0.5 − distancia en píxeles).
  const n = size * size;
  const pr = new Float64Array(n);
  const pg = new Float64Array(n);
  const pb = new Float64Array(n);
  const pa = new Float64Array(n);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const x = (px + 0.5) / size;
      const y = (py + 0.5) / size;
      const i = py * size + px;
      for (const sh of shapes) {
        const cov = clamp01(0.5 - sh.dist(x, y) * size) * sh.alpha;
        if (cov <= 0) continue;
        pr[i] = sh.rgb[0] * cov + pr[i] * (1 - cov);
        pg[i] = sh.rgb[1] * cov + pg[i] * (1 - cov);
        pb[i] = sh.rgb[2] * cov + pb[i] * (1 - cov);
        pa[i] = cov + pa[i] * (1 - cov);
      }
    }
  }
  const out = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) {
    const a = pa[i];
    if (a <= 0) continue;
    out[i * 4] = Math.round(pr[i] / a);
    out[i * 4 + 1] = Math.round(pg[i] / a);
    out[i * 4 + 2] = Math.round(pb[i] / a);
    out[i * 4 + 3] = Math.round(a * 255);
  }
  return encodePng(size, size, 4, out);
}

/** Las tres imágenes que Moodle espera para la insignia (f1/f2/f3). */
export function courseBadgeImages(theme: Pick<ResolvedTheme, 'color'>): Array<{ filename: string; size: number; png: Buffer }> {
  return COURSE_BADGE_IMAGE_SIZES.map((x) => ({ ...x, png: renderCourseBadgePng(theme, x.size) }));
}
