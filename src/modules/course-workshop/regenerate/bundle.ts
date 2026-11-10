/**
 * r107 B10 · Fase 3 — el RESULTADO producido como un archivo del Taller (artifact `workshop_regen_result`, solo
 * servidor, atado a la aprobación que lo pagó): un zip determinista con `result.json` (todo lo que no es binario) y los
 * binarios aparte (`bin/<campo>`). El trabajo de aplicar lo descarga, verifica su sha256 contra el plan y lo vuelve a
 * validar en el motor antes de insertarlo.
 */
import JSZip = require('jszip');
import { createHash } from 'crypto';
import { ProducedRegen } from './types';
import type { ProducedChapter, ProducedModule } from './chapter-types';

const BIN_FIELDS = ['h5p', 'pdf', 'cover', 'mp3'] as const;
const DATE = new Date(Date.UTC(2026, 0, 1));
export const REGEN_BUNDLE_VERSION = 1;
export const sha256Hex = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** r107 B11: binarios ANIDADOS (capítulo / módulo producido: `chapters.0.presentation.pdf`) → `bin/<ruta>`. */
function stripBins(v: unknown, path: string, z: JSZip): unknown {
  if (Buffer.isBuffer(v)) {
    z.file(`bin/${path}`, v, { date: DATE, createFolders: false, binary: true });
    return { bin: path, bytes: v.length, sha256: sha256Hex(v) };
  }
  if (Array.isArray(v)) return v.map((x, i) => stripBins(x, `${path}.${i}`, z));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, stripBins(x, `${path}.${k}`, z)]));
  return v;
}
async function restoreBins(v: unknown, z: JSZip): Promise<unknown> {
  if (v && typeof v === 'object' && !Array.isArray(v) && typeof (v as any).bin === 'string' && typeof (v as any).sha256 === 'string' && Object.keys(v as object).length === 3) {
    const f = z.file(`bin/${(v as any).bin}`);
    if (!f) throw new Error(`falta el binario ${(v as any).bin}`);
    const b = await f.async('nodebuffer');
    if (sha256Hex(b) !== (v as any).sha256) throw new Error(`el binario ${(v as any).bin} no coincide con su huella`);
    return b;
  }
  if (Array.isArray(v)) return Promise.all(v.map((x) => restoreBins(x, z)));
  if (v && typeof v === 'object') return Object.fromEntries(await Promise.all(Object.entries(v as Record<string, unknown>).map(async ([k, x]) => [k, await restoreBins(x, z)])));
  return v;
}

export async function encodeProduced(p: ProducedRegen | ProducedChapter | ProducedModule): Promise<Buffer> {
  const z = new JSZip();
  const meta: Record<string, unknown> = { bundleVersion: REGEN_BUNDLE_VERSION };
  for (const [k, v] of Object.entries(p)) {
    if ((BIN_FIELDS as readonly string[]).includes(k) && Buffer.isBuffer(v)) {
      z.file(`bin/${k}`, v, { date: DATE, createFolders: false, binary: true });
      meta[k] = { bin: k, bytes: v.length, sha256: sha256Hex(v) };
    } else if (v && typeof v === 'object' && !Buffer.isBuffer(v)) meta[k] = stripBins(v, k, z);
    else meta[k] = v;
  }
  z.file('result.json', JSON.stringify(meta), { date: DATE, createFolders: false });
  return z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}

export async function decodeProduced(buf: Buffer): Promise<ProducedRegen> {
  const z = await JSZip.loadAsync(buf);
  const rj = z.file('result.json');
  if (!rj) throw new Error('el resultado no trae result.json');
  const meta = JSON.parse(await rj.async('string')) as Record<string, any>;
  if (meta.bundleVersion !== REGEN_BUNDLE_VERSION) throw new Error(`versión de resultado desconocida (${meta.bundleVersion})`);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (k === 'bundleVersion') continue;
    if (v && typeof v === 'object' && typeof (v as any).bin === 'string') {
      const f = z.file(`bin/${(v as any).bin}`);
      if (!f) throw new Error(`falta el binario ${k}`);
      const b = await f.async('nodebuffer');
      if (sha256Hex(b) !== (v as any).sha256) throw new Error(`el binario ${k} no coincide con su huella`);
      out[k] = b;
    } else out[k] = v && typeof v === 'object' ? await restoreBins(v, z) : v;
  }
  return out as unknown as ProducedRegen;
}

/** Lo verificable del resultado (sin binarios): va a la vista del ítem y a su huella. */
const chapterSummary = (c: ProducedChapter) => ({ number: c.chapterNumber, title: c.title, libroWords: (c.libroMd.match(/[\p{L}\p{N}]+/gu) || []).length, scorm: { rooms: c.scorm.rooms, mechanics: c.scorm.roomAssignment }, video: c.video ? { youtubeId: c.video.youtubeId, interactions: c.video.interactions, durationSec: c.video.durationSec } : null, presentation: c.presentation ? { slideCount: c.presentation.slideCount, pdfSha256: sha256Hex(c.presentation.pdf) } : null, pages: { video: !!c.videoPageHtml, game: !!c.gamePageHtml } });

export function producedSummary(p: ProducedRegen | ProducedChapter | ProducedModule): Record<string, unknown> {
  if (p.kind === 'chapter') return { kind: p.kind, ...chapterSummary(p) };
  if (p.kind === 'module') return { kind: p.kind, moduleNumber: p.moduleNumber, title: p.title, chapters: p.chapters.map(chapterSummary), exam: p.exam ? { giftSha256: sha256Hex(Buffer.from(p.exam.gift)) } : null };
  switch (p.kind) {
    case 'scorm_v2': return { kind: p.kind, rooms: p.rooms, mechanics: p.roomAssignment, htmlSha256: sha256Hex(Buffer.from(p.html)), manifestSha256: sha256Hex(Buffer.from(p.manifestXml)) };
    case 'h5p_practice': return { kind: p.kind, h5pType: p.h5pType, mainLibrary: p.mainLibrary, questions: p.questions, h5pSha256: sha256Hex(p.h5p) };
    case 'video': return { kind: p.kind, container: p.container, youtubeId: p.youtubeId, durationSec: p.durationSec, interactions: p.interactions, scenes: p.scenes, script: p.script.slice(0, 20_000), videogenJobId: p.videogenJobId, payloadSha256: sha256Hex(p.h5p ?? Buffer.from(p.hvpJson ?? '')) };
    case 'presentation': return { kind: p.kind, slideCount: p.slideCount, cover: { width: p.width, height: p.height, sha256: sha256Hex(p.cover) }, pdfSha256: sha256Hex(p.pdf), language: p.language, generationId: p.generationId };
    case 'libro_pdf': return { kind: p.kind, chapters: p.chapters, pdfSha256: sha256Hex(p.pdf), previousSha1: p.previousSha1 };
    case 'audio': return { kind: p.kind, audio: p.audio, durationSec: p.durationSec, bitrateKbps: p.bitrateKbps, channels: p.channels, chapters: p.chapters, scriptWords: p.scriptWords, mp3Sha256: sha256Hex(p.mp3) };
  }
  return {};
}
