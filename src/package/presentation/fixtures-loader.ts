/**
 * R9 — carga de las fixtures de los 9 capítulos de Gamma de V1 (metadata
 * committeada en scripts/fixtures/v21-presentation-v1-fixtures.json; los
 * blobs reales NO se commitean — ver r9-core-gamma.md "Fixtures").
 *
 * Cuando el scratch de la sesión de auditoría está presente (misma máquina
 * que corrió el audit, `scratchpad/v21audit/mbz/files/<h[:2]>/<h>`) se leen
 * los bytes reales de los 9 PDFs/PNGs de V1. Si no está (CI, otra máquina, o
 * el scratch ya se limpió) todo cae a las fixtures sintéticas — nunca falla
 * por esto, nunca inventa un tamaño o hash.
 */
import * as fs from 'fs';
import * as path from 'path';
import { syntheticOnePagePdf, syntheticOnePxPng } from './synthetic-fixtures';

export interface V1FixtureFileMeta {
  sha1: string;
  bytes: number;
  filename: string;
}

export interface V1FixtureChapter {
  pdf: V1FixtureFileMeta;
  cover: V1FixtureFileMeta;
}

interface FixturesManifest {
  schemaVersion: number;
  chapters: Record<string, V1FixtureChapter>;
}

const MANIFEST_PATH = path.resolve(__dirname, '../../../scripts/fixtures/v21-presentation-v1-fixtures.json');

let manifestCache: FixturesManifest | null = null;
function loadManifest(): FixturesManifest {
  if (manifestCache) return manifestCache;
  const raw = fs.readFileSync(MANIFEST_PATH, 'utf8');
  manifestCache = JSON.parse(raw) as FixturesManifest;
  return manifestCache;
}

export function v1FixtureChapterNumbers(): number[] {
  return Object.keys(loadManifest().chapters)
    .map((n) => parseInt(n, 10))
    .sort((a, b) => a - b);
}

export function v1FixtureMeta(chapterNumber: number): V1FixtureChapter | null {
  return loadManifest().chapters[String(chapterNumber)] ?? null;
}

/**
 * Candidatos de directorio del scratch de auditoría, en orden de prioridad:
 * solo el override explícito `V21_AUDIT_MBZ_DIR` (fix round 1, M9: ningún
 * path de sesión hardcodeado en src/). Se usa solo si `fs.existsSync`.
 */
function auditMbzDirCandidates(): string[] {
  const candidates: string[] = [];
  if (process.env.V21_AUDIT_MBZ_DIR) candidates.push(process.env.V21_AUDIT_MBZ_DIR);
  return candidates;
}

export function locateAuditMbzDir(): string | null {
  for (const dir of auditMbzDirCandidates()) {
    if (dir && fs.existsSync(path.join(dir, 'files.xml'))) return dir;
  }
  return null;
}

function readBlobBySha1(mbzDir: string, sha1: string): Buffer | null {
  const p = path.join(mbzDir, 'files', sha1.slice(0, 2), sha1);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p);
}

export interface V1ChapterBytes {
  pdfBytes: Buffer;
  coverBytes: Buffer;
  /** true si son los bytes reales de V1 leídos del scratch; false si son sintéticos. */
  real: boolean;
  meta: V1FixtureChapter | null;
}

/**
 * Bytes de PDF+portada para un capítulo. Usa el blob real de V1 cuando el
 * scratch de auditoría está disponible; si no, fixtures sintéticas.
 */
export function loadV1ChapterBytes(chapterNumber: number): V1ChapterBytes {
  const meta = v1FixtureMeta(chapterNumber);
  const mbzDir = locateAuditMbzDir();

  if (meta && mbzDir) {
    const pdfBytes = readBlobBySha1(mbzDir, meta.pdf.sha1);
    const coverBytes = readBlobBySha1(mbzDir, meta.cover.sha1);
    if (pdfBytes && coverBytes) {
      return { pdfBytes, coverBytes, real: true, meta };
    }
  }

  return {
    pdfBytes: syntheticOnePagePdf(),
    coverBytes: syntheticOnePxPng(),
    real: false,
    meta,
  };
}
