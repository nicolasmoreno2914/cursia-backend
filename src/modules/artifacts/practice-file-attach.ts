/**
 * r58 (I4-2) · Validación de un archivo de trabajo AL ADJUNTARLO (antes solo al empaquetar).
 *
 * Dos puntos:
 *  1. `POST /artifacts` con `type = practice_file`: la declaración (nombre con extensión permitida, mimetype de esa
 *     extensión, tamaño 1 B–20 MB, sha256) y los BYTES que quedaron en Storage (mismo tamaño, mismo sha256, firma del
 *     formato: PDF, OOXML/ODF, imagen, texto). Un archivo que no cumple se rechaza con un mensaje claro en el panel, no
 *     días después en el empaque.
 *  2. Guardar el perfil de evaluación: cada `practiceResources[].source.kind = 'artifact'` debe apuntar a un artifact del
 *     dueño, de tipo practice_file, con el mismo tamaño y sha256 que declara el perfil (lo que el servidor verificó en 1).
 * El empaque conserva su validación (resolvePracticeFiles: sha256/tamaño/firma) como red final.
 */
import { createHash } from 'crypto';
import { PRACTICE_FILE_MIMETYPES, PRACTICE_RESOURCE_LIMITS, extensionOf } from '../course-profiles/application-delivery';
import { sniffMatchesExtension } from '../../package/v3/practice-files';

export const PRACTICE_FILE_TYPE = 'practice_file';
/** 400: la declaración o los bytes del archivo de trabajo no cumplen (rechazo de cliente, no reintentable). */
export const PRACTICE_FILE_INVALID_CODE = 'practice_file_invalid';
/** 503: no se pudieron leer los bytes de Storage para verificarlos (reintentable: volver a adjuntar). */
export const PRACTICE_FILE_UNVERIFIABLE_CODE = 'practice_file_unverifiable';
/** 400 al guardar el perfil: un archivo de trabajo no coincide con su artifact. */
export const PRACTICE_FILE_ATTACH_MISMATCH_CODE = 'PRACTICE_FILE_ATTACH_MISMATCH';

const SHA256_RE = /^[0-9a-f]{64}$/;
const FILENAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,118}\.[a-z0-9]{2,5}$/u;

export interface PracticeFileDeclaration {
  filename?: string | null;
  mime_type?: string | null;
  size_bytes?: number | null;
  checksum_sha256?: string | null;
}

/** Errores de la declaración (sin leer bytes). Mensajes en español, para mostrar tal cual en el panel. */
export function practiceFileDeclarationErrors(d: PracticeFileDeclaration): string[] {
  const errors: string[] = [];
  const fn = typeof d.filename === 'string' ? d.filename : '';
  const ext = extensionOf(fn);
  if (!fn || !FILENAME_RE.test(fn)) errors.push('nombre de archivo inválido (sin carpetas; letras, números, espacio, punto, guion y guion bajo, con extensión)');
  if (!(ext in PRACTICE_FILE_MIMETYPES)) errors.push(`extensión no permitida (${ext || 'sin extensión'}); permitidas: ${Object.keys(PRACTICE_FILE_MIMETYPES).join(' ')}`);
  else if (d.mime_type !== PRACTICE_FILE_MIMETYPES[ext]) errors.push(`el tipo ${JSON.stringify(d.mime_type ?? null)} no corresponde a ${ext} (debe ser ${PRACTICE_FILE_MIMETYPES[ext]})`);
  const n = d.size_bytes;
  if (!(typeof n === 'number' && Number.isInteger(n) && n >= 1)) errors.push('tamaño inválido (el archivo está vacío o falta el tamaño)');
  else if (n > PRACTICE_RESOURCE_LIMITS.fileBytesMax) errors.push(`el archivo supera ${Math.round(PRACTICE_RESOURCE_LIMITS.fileBytesMax / (1024 * 1024))} MB`);
  if (typeof d.checksum_sha256 !== 'string' || !SHA256_RE.test(d.checksum_sha256)) errors.push('falta la huella sha256 del archivo (64 hex en minúsculas)');
  return errors;
}

/** Errores de los BYTES que quedaron en Storage contra la declaración. Devuelve también el sha256 medido. */
export async function practiceFileBytesErrors(d: PracticeFileDeclaration, bytes: Buffer): Promise<{ errors: string[]; sha256: string; size: number }> {
  const errors: string[] = [];
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (bytes.length !== d.size_bytes) errors.push(`el archivo subido tiene ${bytes.length} bytes y se declararon ${d.size_bytes}`);
  if (sha256 !== d.checksum_sha256) errors.push('el archivo subido no es el que se eligió (sha256 distinto)');
  const ext = extensionOf(String(d.filename ?? ''));
  if (!(await sniffMatchesExtension(ext, bytes))) errors.push(`el contenido no es un ${ext} válido (el archivo está dañado o tiene otra extensión)`);
  return { errors, sha256, size: bytes.length };
}

/** Errores al guardar el perfil: cada archivo de trabajo subido contra su fila de artifact (null = no existe / no es del dueño). */
export function practiceResourceAttachErrors(
  resources: ReadonlyArray<{ id: string; source: { kind: string; artifactId?: string; filename?: string; bytes?: number; sha256?: string } }> | null | undefined,
  rows: ReadonlyMap<string, { type: string; size_bytes: number | string | null; checksum_sha256: string | null; filename: string | null } | null>,
): Array<{ path: string; code: string; message: string }> {
  const out: Array<{ path: string; code: string; message: string }> = [];
  (resources ?? []).forEach((r, i) => {
    if (!r || r.source?.kind !== 'artifact' || !r.source.artifactId) return;
    const p = `practiceResources[${i}].source.artifactId`;
    const row = rows.get(r.source.artifactId) ?? null;
    const add = (message: string) => out.push({ path: p, code: PRACTICE_FILE_ATTACH_MISMATCH_CODE, message: `${r.id}: ${message}` });
    if (!row) return add('el archivo adjunto no existe o no es tuyo; vuelve a adjuntarlo');
    if (row.type !== PRACTICE_FILE_TYPE) return add(`el artifact no es un archivo de trabajo (${row.type})`);
    if (row.size_bytes !== null && row.size_bytes !== undefined && Number(row.size_bytes) !== r.source.bytes) add(`tamaño ${r.source.bytes} ≠ ${row.size_bytes} del archivo adjunto`);
    if (row.checksum_sha256 && row.checksum_sha256 !== r.source.sha256) add('sha256 distinto del archivo adjunto');
    if (row.filename && r.source.filename && extensionOf(row.filename) !== extensionOf(r.source.filename)) add(`extensión ${extensionOf(r.source.filename)} ≠ ${extensionOf(row.filename)} del archivo adjunto`);
  });
  return out;
}
