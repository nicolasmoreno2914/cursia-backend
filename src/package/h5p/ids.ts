// Cursia V2.1 / R7-core — subContentId determinístico (UUIDv5, RFC 4122 §4.3).
//
// R0 probó que un subContentId no-UUID (`q1`, `q2`…) rompe la agregación de
// intentos de mod_h5pactivity (nota equivocada). Con UUID: 1 intento, nota
// correcta. El id se deriva de item_key + índice + h5pProfileVersion para que
// regenerar el mismo ítem produzca los mismos ids (el reporte por interacción
// sigue siendo comparable).
import { createHash } from 'crypto';

/** Namespace fijo de Cursia para los subContentId H5P. NUNCA cambiarlo. */
export const CURSIA_H5P_UUID_NAMESPACE = '81ee0752-b41e-4906-8d17-adf92734544a';

// Solo minúsculas: el validador H5P de Moodle (h5p.classes.php) elimina en silencio cualquier otro formato.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isUuid(value: unknown): boolean {
  return typeof value === 'string' && UUID_RE.test(value);
}

function uuidToBytes(uuid: string): Buffer {
  if (!isUuid(uuid)) throw new Error(`H5P_UUID_INVALID_NAMESPACE: ${uuid}`);
  return Buffer.from(uuid.replace(/-/g, ''), 'hex');
}

function bytesToUuid(b: Buffer): string {
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** UUID versión 5 (SHA-1) de `name` (UTF-8) en `namespace`. */
export function uuidV5(name: string, namespace: string): string {
  if (typeof name !== 'string') throw new Error('H5P_UUID_INVALID_NAME');
  const hash = createHash('sha1').update(uuidToBytes(namespace)).update(Buffer.from(name, 'utf8')).digest();
  const b = Buffer.from(hash.subarray(0, 16));
  b[6] = (b[6] & 0x0f) | 0x50; // versión 5
  b[8] = (b[8] & 0x3f) | 0x80; // variante RFC 4122
  return bytesToUuid(b);
}

/**
 * subContentId = UUIDv5(CURSIA_H5P_UUID_NAMESPACE, `${itemKey}#${index}#p${profileVersion}`).
 */
export function h5pSubContentId(itemKey: string, index: number, profileVersion: number): string {
  if (typeof itemKey !== 'string' || itemKey.trim() === '') {
    throw new Error('H5P_SUBCONTENT_ID_INVALID: itemKey vacío');
  }
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(`H5P_SUBCONTENT_ID_INVALID: index ${index}`);
  }
  if (!Number.isInteger(profileVersion) || profileVersion < 1) {
    throw new Error(`H5P_SUBCONTENT_ID_INVALID: profileVersion ${profileVersion}`);
  }
  return uuidV5(`${itemKey}#${index}#p${profileVersion}`, CURSIA_H5P_UUID_NAMESPACE);
}
