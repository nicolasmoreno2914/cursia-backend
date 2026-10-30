// r79.2 · Regla del owner (§13.3): todo monto en USD que llega a la interfaz se MUESTRA con máximo 2 decimales. Solo
// presentación: los cálculos, comparaciones, huellas y montos guardados conservan su precisión interna.
export function usd2(v: unknown): string {
  if (v === null || v === undefined || v === '') return '?';
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return String(v ?? '?');
  const r = Math.round((n + (n >= 0 ? 1e-9 : -1e-9)) * 100) / 100;
  return (Object.is(r, -0) ? 0 : r).toFixed(2);
}
/** Igual que usd2, con coma decimal (textos en español del diseño). */
export function usd2Es(v: unknown): string {
  return usd2(v).replace('.', ',');
}
