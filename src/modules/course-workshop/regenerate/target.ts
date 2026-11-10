/**
 * r107 B10 · Fase 3 — QUÉ se rehace: la actividad destino resuelta contra el inventario de ESTE paquete, con lo
 * verificable del «antes» (salas y mecánicas del juego, tipo de la práctica H5P, video de YouTube y preguntas, PDF y
 * portada de la presentación, archivo y duración del audio). Sin red ni base: lee del paquete.
 *
 * Una actividad que el Taller no sabe rehacer con seguridad queda `unavailable` con el motivo (nunca se adivina).
 */
import JSZip = require('jszip');
import { createHash } from 'crypto';
import { WorkshopActivity, WorkshopCourse, WorkshopFile } from '../course-model';
import { xmlUnescape } from '../../visual-design/preview-extract';
import { mp3DurationSeconds } from '../../../package/audio';
import { pdfPageCount } from '../../../package/presentation';
import { RegenOperation, RegenTarget, SCORM_V2_ROOMS, SCORM_V2_TEMPLATE_IDS } from './types';

export type Reader = (entry: string) => Promise<Buffer | null>;
const sha1 = (b: Buffer | string) => createHash('sha1').update(b).digest('hex');

/**
 * Marca de cada plantilla del motor SCORM v2 en el HTML de su sala: la clase EXCLUSIVA de esa plantilla en la salida de
 * su renderizador (`SV2_ROOM_RENDERERS[id].html`, 06b-scorm-templates.js). check-r107-regenerate (R0) verifica que cada
 * marca siga saliendo SOLO del renderizador de su plantilla con el ejecutor vendorizado.
 */
export const SCORM_V2_ROOM_MARKERS: Readonly<Record<string, string>> = Object.freeze({
  equipar_escena: 'sv2-figure',
  decision_consecuencia: 'sv2-consequence',
  sopa_letras: 'sv2-ws-data',
  crucigrama: 'sv2-crossword-grid',
  ruleta_preguntas: 'sv2-wheel',
  multicamino: 'sv2-mc-node',
  armar_proceso: 'sv2-sequence',
});

/** Salas de un juego SCORM v2 (HTML del SCO) con la plantilla de cada una (null = no reconocida). */
export function scormV2Rooms(html: string): Array<string | null> {
  const marks = [...html.matchAll(/<div class="sv2-room" id="sv2-room-(\d+)"/g)];
  const rooms: Array<string | null> = [];
  for (let i = 0; i < marks.length; i++) {
    const start = marks[i].index ?? 0;
    // La última sala termina donde empieza el informe (o el script): el CSS y el JS del SCO no cuentan.
    const tail = [html.indexOf('id="sv2-report"', start), html.indexOf('<script', start)].filter((x) => x > start);
    const end = i + 1 < marks.length ? marks[i + 1].index ?? html.length : tail.length ? Math.min(...tail) : html.length;
    const seg = html.slice(start, end);
    const hits = Object.entries(SCORM_V2_ROOM_MARKERS).filter(([, cls]) => new RegExp(`class="(?:[^"]*\\s)?${cls}(?:\\s[^"]*)?"`).test(seg)).map(([id]) => id);
    rooms.push(hits.length === 1 ? hits[0] : null);
  }
  return rooms;
}

export const hasPendingMarker = (s: string): boolean => /⚠️\s*Pendiente/.test(s);

/** Mecánicas pedidas en el texto del docente (nombre de la plantilla: «sopa de letras», «crucigrama»…). */
const MECHANIC_WORDS: Array<[string, RegExp]> = [
  ['equipar_escena', /equipar\s+la\s+escena/i],
  ['decision_consecuencia', /decisi[oó]n\s+(?:con|y)\s+consecuencia/i],
  ['sopa_letras', /sopa\s+de\s+letras/i],
  ['crucigrama', /crucigrama/i],
  ['ruleta_preguntas', /ruleta/i],
  ['multicamino', /multicamino|varios\s+caminos/i],
  ['armar_proceso', /armar\s+(?:el\s+)?proceso|ordenar\s+(?:los\s+)?pasos/i],
];
export function mechanicsFromText(text: string): string[] {
  return MECHANIC_WORDS.filter(([, re]) => re.test(text || '')).map(([id]) => id);
}

const H5P_TYPE_BY_LIBRARY: Record<string, string> = {
  'H5P.QuestionSet': 'questionset', 'H5P.DragText': 'dragtext', 'H5P.Blanks': 'blanks', 'H5P.BranchingScenario': 'branchingscenario', 'H5P.SingleChoiceSet': 'singlechoiceset',
};

export async function h5pJsonOf(buf: Buffer): Promise<{ mainLibrary: string; content: any } | null> {
  try {
    const z = await JSZip.loadAsync(buf);
    const hj = z.file('h5p.json');
    const cj = z.file('content/content.json');
    if (!hj) return null;
    const h = JSON.parse(await hj.async('string'));
    return { mainLibrary: String(h.mainLibrary ?? ''), content: cj ? JSON.parse(await cj.async('string')) : null };
  } catch {
    return null;
  }
}

export const YOUTUBE_ID_IN_URL = /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([A-Za-z0-9_-]{11})/;

const fileOf = (a: WorkshopActivity, area: string, re: RegExp): WorkshopFile | undefined => a.files.find((f) => f.filearea === area && re.test(f.filename) && f.filename !== '.');

export interface RegenTargetInput {
  course: WorkshopCourse;
  read: Reader;
  op: RegenOperation;
  moduleId: number;
  /** Texto del pedido (mecánica pedida para el juego). */
  instruction?: string;
  audioTarget?: 'welcome' | 'audiobook' | null;
}

export type RegenTargetResult = { target: RegenTarget; expect: { contenthashes: string[]; jsonSha1?: string | null } } | { unavailable: string };

export async function regenTargetOf(i: RegenTargetInput): Promise<RegenTargetResult> {
  const a = i.course.activities.find((x) => x.moduleId === i.moduleId);
  if (!a || a.missingFolder) return { unavailable: 'La actividad ya no está en el paquete.' };
  const chapterNumber = a.placement.scope === 'chapter' ? a.placement.chapterNumber : null;
  const chapterTitle = chapterNumber !== null ? i.course.chapters.find((c) => c.number === chapterNumber)?.title ?? `Capítulo ${chapterNumber}` : '';
  const blob = async (f: WorkshopFile | undefined) => (f && f.blobPresent ? i.read(f.blobEntry) : null);
  switch (i.op) {
    case 'regenerate_scorm': {
      if (chapterNumber === null) return { unavailable: 'El juego no está dentro de un capítulo: no se sabe de qué tema rehacerlo.' };
      if (a.modname === 'scorm') {
        const html = fileOf(a, 'content', /^index\.html?$/i);
        const mf = fileOf(a, 'content', /^imsmanifest\.xml$/i);
        if (!html || !mf) return { unavailable: 'El juego SCORM no trae su index.html e imsmanifest.xml: el Taller no puede reemplazarlo con seguridad.' };
        const pkg = fileOf(a, 'package', /\.zip$/i);
        const htmlBuf = await blob(html);
        const text = htmlBuf ? htmlBuf.toString('utf8') : '';
        const rooms = scormV2Rooms(text);
        const v2Original = rooms.length === SCORM_V2_ROOMS && rooms.every((r): r is string => r !== null);
        const asked = mechanicsFromText(i.instruction ?? '');
        const mechanics = asked.length ? asked : v2Original ? (rooms as string[]) : [...SCORM_V2_TEMPLATE_IDS];
        return {
          target: {
            op: 'regenerate_scorm', engine: 'scorm_v2', moduleId: a.moduleId, chapterNumber, title: a.title, chapterTitle,
            mechanics, mechanicsSource: asked.length ? 'request' : v2Original ? 'original' : 'default',
            roomsBefore: rooms.length ? rooms.length : null, pendingBefore: hasPendingMarker(text),
          },
          expect: { contenthashes: [html.contenthash, mf.contenthash, ...(pkg ? [pkg.contenthash] : [])] },
        };
      }
      if (a.modname === 'h5pactivity' && a.role === 'game') {
        const p = fileOf(a, 'package', /\.h5p$/i);
        const b = await blob(p);
        const hj = b ? await h5pJsonOf(b) : null;
        if (!p || !hj) return { unavailable: 'La práctica H5P no trae un paquete .h5p legible.' };
        const t = H5P_TYPE_BY_LIBRARY[hj.mainLibrary];
        if (!t || a.kind === 'review_cards') return { unavailable: `La actividad usa ${hj.mainLibrary || 'un tipo H5P desconocido'}${a.kind === 'review_cards' ? ' (el «Repaso» se arma con el mazo del capítulo)' : ''}: el Taller rehace prácticas de tipo cuestionario, arrastrar palabras, completar o caso ramificado.` };
        return { target: { op: 'regenerate_scorm', engine: 'h5p_practice', moduleId: a.moduleId, chapterNumber, title: a.title, chapterTitle, h5pType: t, mainLibrary: hj.mainLibrary }, expect: { contenthashes: [p.contenthash] } };
      }
      return { unavailable: `«${a.title}» no es un juego SCORM ni una práctica H5P.` };
    }
    case 'regenerate_video': {
      if (chapterNumber === null) return { unavailable: 'El video no está dentro de un capítulo: no se sabe de qué tema rehacerlo.' };
      if (a.modname === 'h5pactivity') {
        const p = fileOf(a, 'package', /\.h5p$/i);
        const b = await blob(p);
        const hj = b ? await h5pJsonOf(b) : null;
        if (!p || !hj || hj.mainLibrary !== 'H5P.InteractiveVideo') return { unavailable: 'El video no es un H5P.InteractiveVideo legible.' };
        const url = String(hj.content?.interactiveVideo?.video?.files?.[0]?.path ?? '');
        const yt = YOUTUBE_ID_IN_URL.exec(url)?.[1] ?? null;
        if (!yt) return { unavailable: 'El video del curso no está publicado en YouTube: el Taller rehace videos que se entregan por YouTube.' };
        const xs = Array.isArray(hj.content?.interactiveVideo?.assets?.interactions) ? hj.content.interactiveVideo.assets.interactions : [];
        const qs = xs.filter((x: any) => !/^H5P\.Text\b/.test(String(x?.action?.library ?? ''))).length;
        const advanced = xs.some((x: any) => /^H5P\.Text\b/.test(String(x?.action?.library ?? '')));
        return { target: { op: 'regenerate_video', moduleId: a.moduleId, chapterNumber, title: a.title, chapterTitle, container: 'h5pactivity', delivery: 'youtube', youtubeIdBefore: yt, questionsBefore: qs, advanced }, expect: { contenthashes: [p.contenthash] } };
      }
      if (a.modname === 'hvp') {
        const x = await i.read(`${a.dir}/hvp.xml`);
        const m = x ? /<json_content>([\s\S]*?)<\/json_content>/.exec(x.toString('utf8')) : null;
        let j: any = null;
        try { j = m ? JSON.parse(xmlUnescape(m[1])) : null; } catch { j = null; }
        if (!j) return { unavailable: 'El video H5P (hvp) no trae un contenido legible.' };
        const url = String(j?.interactiveVideo?.video?.files?.[0]?.path ?? '');
        const yt = YOUTUBE_ID_IN_URL.exec(url)?.[1] ?? null;
        if (!yt) return { unavailable: 'El video del curso está embebido como archivo, no en YouTube: el Taller rehace videos que se entregan por YouTube.' };
        const qs = Array.isArray(j?.interactiveVideo?.assets?.interactions) ? j.interactiveVideo.assets.interactions.length : 0;
        return { target: { op: 'regenerate_video', moduleId: a.moduleId, chapterNumber, title: a.title, chapterTitle, container: 'hvp', delivery: 'youtube', youtubeIdBefore: yt, questionsBefore: qs, advanced: false }, expect: { contenthashes: [], jsonSha1: sha1(m![1]) } };
      }
      return { unavailable: `«${a.title}» no es un video interactivo.` };
    }
    case 'regenerate_gamma': {
      if (chapterNumber === null) return { unavailable: 'La presentación no está dentro de un capítulo.' };
      const pdf = fileOf(a, 'intro', /\.pdf$/i);
      const png = fileOf(a, 'intro', /\.png$/i);
      if (a.role !== 'presentation' || !pdf || !png) return { unavailable: 'Esta actividad no es una presentación de Gamma con su PDF y su portada en el paquete (los cursos anteriores la enlazaban afuera): el Taller no la puede rehacer.' };
      const b = await blob(pdf);
      let slides: number | null = null;
      try { slides = b ? pdfPageCount(b) : null; } catch { slides = null; }
      return { target: { op: 'regenerate_gamma', moduleId: a.moduleId, chapterNumber, title: a.title, chapterTitle, pdfFile: pdf.filename, coverFile: png.filename, slidesBefore: slides }, expect: { contenthashes: [pdf.contenthash, png.contenthash] } };
    }
    case 'regenerate_audio': {
      const isBook = a.kind === 'audiobook' || a.role === 'audio';
      const isWelcome = a.kind === 'welcome_audio';
      if (!isBook && !isWelcome) return { unavailable: `«${a.title}» no es el audio de bienvenida ni el audiolibro.` };
      const mp3s = a.files.filter((f) => f.filename !== '.' && /\.mp3$/i.test(f.filename));
      if (mp3s.length !== 1) return { unavailable: mp3s.length ? `El audio viene en ${mp3s.length} archivos: el Taller rehace audios de un solo archivo.` : 'La actividad no trae su archivo de audio en el paquete (se entrega aparte): no hay qué reemplazar.' };
      const b = await blob(mp3s[0]);
      let dur: number | null = null;
      try { dur = b ? mp3DurationSeconds(b) : null; } catch { dur = null; }
      const chapters = isBook ? i.course.chapters.map((c) => c.number) : [];
      if (isBook && !chapters.length) return { unavailable: 'El curso no tiene capítulos reconocibles: no se sabe qué narrar.' };
      return { target: { op: 'regenerate_audio', moduleId: a.moduleId, title: a.title, audio: isBook ? 'audiobook' : 'welcome', chapters, file: mp3s[0].filename, durationBefore: dur }, expect: { contenthashes: [mp3s[0].contenthash] } };
    }
  }
  return { unavailable: 'Operación fuera del catálogo de la Fase 3.' };
}
