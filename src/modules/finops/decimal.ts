/**
 * V2.1 RF-a — aritmética de dinero en punto fijo (escala 10, igual que
 * NUMERIC(20,10) en la base). Nunca floats para montos: un monto es un string
 * decimal ("0.0123400000") y las cuentas se hacen con BigInt escalado 1e10.
 *
 * Puro: sin DB, sin reloj, sin aleatoriedad.
 */
import { FinopsError } from './errors';

export const MONEY_SCALE = 10;
const SCALE = 10n ** BigInt(MONEY_SCALE);

/** Monto o cantidad decimal: string ("1.25") o number finito. */
export type DecimalLike = string | number | bigint;

const DEC_RE = /^([+-])?(\d+)(?:\.(\d+))?$/;

/** Convierte a BigInt escalado 1e10. Redondea half-up (lejos del cero) si trae más de 10 decimales. */
export function toScaled(v: DecimalLike, what = 'valor'): bigint {
  if (typeof v === 'bigint') return v * SCALE;
  let s: string;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new FinopsError('INVALID_DECIMAL', `${what} no es un número finito: ${v}`);
    s = Math.abs(v) >= 1e21 || /e/i.test(String(v)) ? v.toFixed(MONEY_SCALE + 2) : String(v);
  } else if (typeof v === 'string') {
    s = v.trim();
  } else {
    throw new FinopsError('INVALID_DECIMAL', `${what} no es decimal: ${JSON.stringify(v)}`);
  }
  const m = DEC_RE.exec(s);
  if (!m) throw new FinopsError('INVALID_DECIMAL', `${what} no es decimal: ${JSON.stringify(v)}`);
  const neg = m[1] === '-';
  const intPart = BigInt(m[2]);
  const frac = m[3] || '';
  let fracScaled: bigint;
  if (frac.length <= MONEY_SCALE) {
    fracScaled = BigInt((frac + '0'.repeat(MONEY_SCALE)).slice(0, MONEY_SCALE) || '0');
  } else {
    fracScaled = BigInt(frac.slice(0, MONEY_SCALE));
    if (Number(frac[MONEY_SCALE]) >= 5) fracScaled += 1n;
  }
  const abs = intPart * SCALE + fracScaled;
  return neg ? -abs : abs;
}

/** BigInt escalado → string con exactamente 10 decimales ("-0.5000000000"). */
export function fromScaled(x: bigint): string {
  const neg = x < 0n;
  const abs = neg ? -x : x;
  const int = abs / SCALE;
  const frac = (abs % SCALE).toString().padStart(MONEY_SCALE, '0');
  return `${neg && abs !== 0n ? '-' : ''}${int.toString()}.${frac}`;
}

export function normalizeDecimal(v: DecimalLike, what?: string): string {
  return fromScaled(toScaled(v, what));
}

export function addDec(...vals: DecimalLike[]): string {
  let acc = 0n;
  for (const v of vals) acc += toScaled(v);
  return fromScaled(acc);
}

export function subDec(a: DecimalLike, b: DecimalLike): string {
  return fromScaled(toScaled(a) - toScaled(b));
}

export function cmpDec(a: DecimalLike, b: DecimalLike): -1 | 0 | 1 {
  const x = toScaled(a);
  const y = toScaled(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Divide redondeando half-up lejos del cero. */
function divRound(n: bigint, d: bigint): bigint {
  if (d === 0n) throw new FinopsError('INVALID_DECIMAL', 'división por cero');
  const neg = (n < 0n) !== (d < 0n);
  const an = n < 0n ? -n : n;
  const ad = d < 0n ? -d : d;
  let q = an / ad;
  if ((an % ad) * 2n >= ad) q += 1n;
  return neg ? -q : q;
}

/** a × b (ambos decimales), resultado a escala 10. */
export function mulDec(a: DecimalLike, b: DecimalLike): string {
  return fromScaled(divRound(toScaled(a) * toScaled(b), SCALE));
}

/** qty × unitPrice / unitSize, redondeado a escala 10 una sola vez (sin error acumulado). */
export function priceLine(qty: DecimalLike, unitPrice: DecimalLike, unitSize: DecimalLike): string {
  const q = toScaled(qty, 'cantidad');
  const p = toScaled(unitPrice, 'unit_price');
  const u = toScaled(unitSize, 'unit_size');
  if (u <= 0n) throw new FinopsError('INVALID_DECIMAL', `unit_size debe ser > 0 (${unitSize})`);
  // (q/S)·(p/S)/(u/S) = q·p/(u·S) → escalado: q·p/u
  return fromScaled(divRound(q * p, u));
}

export function isZeroDec(v: DecimalLike): boolean {
  return toScaled(v) === 0n;
}
