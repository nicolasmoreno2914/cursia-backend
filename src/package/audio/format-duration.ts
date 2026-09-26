/**
 * format-duration.ts
 *
 * Formato de duración en español (`§E`: strings de UI del shell). Regla dura
 * del brief: estas cadenas **solo** se construyen a partir de una duración
 * MEDIDA (`mp3DurationSeconds`), nunca de una estimación o de lo que pidió el
 * LLM — el shell no puede afirmar minutos que no verificó.
 */

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** "1 min 02 s" / "8 min 31 s" — redondeado al segundo más cercano. */
export function formatDurationEs(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new RangeError(`formatDurationEs: duración inválida (${seconds})`);
  }
  const total = Math.round(seconds);
  const minutes = Math.floor(total / 60);
  const secs = total % 60;
  return `${minutes} min ${pad2(secs)} s`;
}

/** "≈ 9 min" — redondeado al minuto más cercano. */
export function formatDurationShortEs(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new RangeError(`formatDurationShortEs: duración inválida (${seconds})`);
  }
  // Fix round 1 (M3): un audio de menos de medio minuto nunca se anuncia como "≈ 0 min".
  const minutes = seconds > 0 ? Math.max(1, Math.round(seconds / 60)) : 0;
  return `≈ ${minutes} min`;
}
