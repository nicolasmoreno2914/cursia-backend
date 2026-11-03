// ─────────────────────────────────────────────────────────────────────────────
// r83 (incidente #91, 2026-11-02) — resiliencia del TTS del audiolibro.
//
// Ese día OpenAI cortó conexiones a mitad del cuerpo (`TypeError: terminated`) y 7 de 9 capítulos terminaron en
// `provider_reconciliation_required` / hold_for_human: cada corte mataba el intento, quedaba como gasto incierto y
// había UN solo reenvío por item. Este módulo reúne las piezas puras / de disco del arreglo:
//  - política de reintento POR SEGMENTO dentro del mismo intento (qué errores, cuántos, backoff);
//  - breaker por proceso: cortes repetidos en una ventana → el proveedor se ve enfermo, el item se devuelve sin
//    consumir intento (acotado) en vez de quemar intentos;
//  - spool local de los MP3 ya pagados: se escriben a disco ANTES de subirlos, así un fallo del Storage nunca tira un
//    audio pagado (el próximo intento lo re-sube desde el spool sin volver a pagar). TTL + limpieza al guardar;
//  - tamaño de segmento del audiolibro (más chico = menos exposición y menos costo perdido por corte).
// Sin secretos en nada de lo que se guarda (solo ids de operación, tamaños, tiempos, hashes).
// ─────────────────────────────────────────────────────────────────────────────
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ProviderCallError, TtsStreamError } from './provider-clients';

type Env = Record<string, string | undefined>;

function intEnv(env: Env, key: string, dflt: number, min: number, max: number): number {
  const raw = env[key];
  if (raw === undefined || String(raw).trim() === '') return dflt;
  const n = Number(raw);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

// ─── Reintento por segmento ──────────────────────────────────────────────────

/**
 * Reintentos de UN segmento dentro del mismo intento tras un corte / stall / timeout / red / 5xx incierto (además del
 * envío original). 0 = política anterior (r62: el primer corte termina el intento y va a reconciliación) — kill switch.
 */
export const TTS_SEGMENT_RETRIES_DEFAULT = 2;
export const TTS_SEGMENT_RETRIES_ENV = 'OPENAI_TTS_SEGMENT_RETRIES';
export function ttsSegmentRetries(env: Env): number {
  return intEnv(env, TTS_SEGMENT_RETRIES_ENV, TTS_SEGMENT_RETRIES_DEFAULT, 0, 5);
}

/** Backoff base entre reintentos del segmento (ms): base × 3^(n-1) con jitter ±20 %, tope 60 s. */
export const TTS_SEGMENT_BACKOFF_MS_DEFAULT = 3000;
export const TTS_SEGMENT_BACKOFF_ENV = 'OPENAI_TTS_SEGMENT_BACKOFF_MS';
export function ttsSegmentBackoffMs(env: Env, retryNumber: number, rnd: () => number = Math.random): number {
  const base = intEnv(env, TTS_SEGMENT_BACKOFF_ENV, TTS_SEGMENT_BACKOFF_MS_DEFAULT, 0, 60_000);
  const raw = Math.min(60_000, base * Math.pow(3, Math.max(0, retryNumber - 1)));
  return Math.round(raw * (0.8 + 0.4 * rnd()));
}

/** Statuses HTTP que prueban «no cobrado» (r62 K2): se manejan como siempre (fallo A del item, reserva liberada). */
const KNOWN_NOT_CHARGED = new Set([429, 503, 529]);

/**
 * ¿El error de la llamada TTS es un resultado DESCONOCIDO que se puede reintentar en el mismo intento, contando la
 * llamada perdida como cobrada (posible duplicado)? Corte / stall / timeout / red (TtsStreamError) y 5xx o 408/409
 * inciertos. Nunca un 4xx definitivo ni un 429/503/529 (resultado conocido sin cobro, camino de siempre).
 */
export function isRetryableTtsUncertain(err: unknown): boolean {
  if (err instanceof TtsStreamError) return true;
  if (!(err instanceof ProviderCallError)) return false;
  if (err.status === null) return err.retryable;
  if (KNOWN_NOT_CHARGED.has(err.status)) return false;
  return err.status >= 500 || err.status === 408 || err.status === 409;
}

/** Evidencia sin secretos de un fallo incierto (para output_summary.ttsCuts y el ledger). */
export function ttsFailureEvidence(err: unknown): Record<string, unknown> {
  if (err instanceof TtsStreamError) return err.evidence();
  if (err instanceof ProviderCallError) return { kind: 'http', responseStatus: err.status, message: err.message.slice(0, 200) };
  return { kind: 'unknown', message: (err instanceof Error ? err.message : String(err)).slice(0, 200) };
}

/** Causa del ledger (ambiguous-resend.ts) para la liquidación «cobrada, posible duplicado». */
export function ttsAmbiguityCause(err: unknown): 'connection_cut' | 'timeout_presumed_charged' | 'unknown_result' {
  if (err instanceof TtsStreamError) return err.kind === 'timeout' || err.kind === 'stall' ? 'timeout_presumed_charged' : 'connection_cut';
  return 'unknown_result';
}

// ─── Breaker por proceso (proveedor enfermo) ─────────────────────────────────

export const TTS_BREAKER_CUTS_ENV = 'OPENAI_TTS_BREAKER_CUTS';
export const TTS_BREAKER_WINDOW_ENV = 'OPENAI_TTS_BREAKER_WINDOW_MS';
export const TTS_BREAKER_RETRY_AFTER_ENV = 'OPENAI_TTS_BREAKER_RETRY_AFTER_S';
export const TTS_BREAKER_MAX_HANDBACKS_ENV = 'OPENAI_TTS_BREAKER_MAX_HANDBACKS';

export interface TtsBreakerConfig { cuts: number; windowMs: number; retryAfterSeconds: number; maxHandbacks: number }
export function ttsBreakerConfig(env: Env): TtsBreakerConfig {
  return {
    cuts: intEnv(env, TTS_BREAKER_CUTS_ENV, 3, 0, 100), // 0 = breaker apagado
    windowMs: intEnv(env, TTS_BREAKER_WINDOW_ENV, 10 * 60_000, 1000, 24 * 3600_000),
    retryAfterSeconds: intEnv(env, TTS_BREAKER_RETRY_AFTER_ENV, 300, 1, 6 * 3600),
    maxHandbacks: intEnv(env, TTS_BREAKER_MAX_HANDBACKS_ENV, 4, 0, 50),
  };
}

/** Cortes inciertos de TTS recientes en ESTE proceso (el worker de proveedores es serial: una ventana compartida). */
export class TtsCutBreaker {
  private cuts: number[] = [];
  record(now = Date.now()): void { this.cuts.push(now); if (this.cuts.length > 200) this.cuts.splice(0, this.cuts.length - 200); }
  count(windowMs: number, now = Date.now()): number { this.cuts = this.cuts.filter((t) => now - t <= windowMs); return this.cuts.length; }
  tripped(cfg: TtsBreakerConfig, now = Date.now()): boolean { return cfg.cuts > 0 && this.count(cfg.windowMs, now) >= cfg.cuts; }
  /** Tras devolver el item se arranca de cero: el próximo claim (pasada la espera) vuelve a medir. */
  reset(): void { this.cuts = []; }
}
export const TTS_CUT_BREAKER = new TtsCutBreaker();

export const TTS_PROVIDER_UNHEALTHY = 'tts_provider_unhealthy';
export const TTS_CHUNK_CUT_EXHAUSTED = 'tts_chunk_cut_exhausted';
export const AUDIO_SEGMENT_UPLOAD_FAILED = 'audio_segment_upload_failed';

// ─── Tamaño de segmento del audiolibro ───────────────────────────────────────

/** Segmentos del audiolibro (antes 3900): llamadas de ~15–20 s, la mitad de exposición y de costo perdido por corte. */
export const AUDIOBOOK_TTS_SEGMENT_CHARS_DEFAULT = 2000;
export const AUDIOBOOK_TTS_SEGMENT_CHARS_LEGACY = 3900;
export const AUDIOBOOK_TTS_SEGMENT_CHARS_ENV = 'AUDIOBOOK_TTS_SEGMENT_CHARS';
export function audiobookSegmentChars(env: Env): number {
  return intEnv(env, AUDIOBOOK_TTS_SEGMENT_CHARS_ENV, AUDIOBOOK_TTS_SEGMENT_CHARS_DEFAULT, 500, AUDIOBOOK_TTS_SEGMENT_CHARS_LEGACY);
}
/**
 * Tamaño EFECTIVO para un item: el que quedó fijado en su output_summary; un item que ya tiene segmentos pagados de
 * antes de r83 (sin el campo) sigue con 3900 — cambiar el corte cambiaría las claves y obligaría a repagar.
 */
export function effectiveSegmentChars(outputSummary: Record<string, any> | null | undefined, env: Env): number {
  const os = outputSummary ?? {};
  const pinned = Number(os.audioSegmentChars);
  if (Number.isInteger(pinned) && pinned >= 500 && pinned <= AUDIOBOOK_TTS_SEGMENT_CHARS_LEGACY) return pinned;
  const hasPaid = Object.keys((os.audioSegments ?? {}) as object).length > 0 || Object.keys((os.audioSplitParts ?? {}) as object).length > 0;
  return hasPaid ? AUDIOBOOK_TTS_SEGMENT_CHARS_LEGACY : audiobookSegmentChars(env);
}

// ─── Spool local de MP3 pagados ──────────────────────────────────────────────

export const TTS_SPOOL_DIR_ENV = 'TTS_SPOOL_DIR';
export const TTS_SPOOL_TTL_HOURS_ENV = 'TTS_SPOOL_TTL_HOURS';
export function ttsSpoolDir(env: Env): string {
  const v = (env[TTS_SPOOL_DIR_ENV] ?? '').trim();
  return v || path.join(os.tmpdir(), 'cursia-tts-spool');
}
export function ttsSpoolTtlMs(env: Env): number {
  return intEnv(env, TTS_SPOOL_TTL_HOURS_ENV, 72, 1, 24 * 30) * 3600_000;
}

/** Metadatos de un MP3 pagado en el spool (sin secretos). */
export interface TtsSpoolMeta {
  itemRunId: string;
  segKey: string;
  textSha: string;
  strategy: string;
  audioSha: string;
  bytes: number;
  requestId: string | null;
  reservationKey: string;
  rawSeconds: number | null;
  chars: number;
  model: string;
  segIndex: number;
  attempt: number;
  /** La reserva de la llamada ya quedó liquidada con el cargo medido. */
  settled: boolean;
  at: string;
}

function safePart(s: string): string { return String(s).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 120); }
function sha256(b: Buffer | string): string { return createHash('sha256').update(b).digest('hex'); }

export class TtsSpool {
  constructor(readonly dir: string) {}

  private itemDir(itemRunId: string): string { return path.join(this.dir, safePart(itemRunId)); }
  /** Clave por item / segmento / texto / estrategia: otro texto u otra estrategia nunca reutiliza el audio. */
  private base(m: Pick<TtsSpoolMeta, 'itemRunId' | 'segKey' | 'textSha' | 'strategy'>): string {
    return path.join(this.itemDir(m.itemRunId), `${safePart(m.segKey)}.${safePart(m.textSha.slice(0, 16))}.${safePart(m.strategy)}`);
  }

  /** Escribe audio + meta (atómico por rename). Lanza si el disco falla (el caller decide). */
  write(meta: Omit<TtsSpoolMeta, 'audioSha' | 'bytes' | 'at'>, audio: Buffer): TtsSpoolMeta {
    const full: TtsSpoolMeta = { ...meta, audioSha: sha256(audio), bytes: audio.length, at: new Date().toISOString() };
    const b = this.base(full);
    fs.mkdirSync(path.dirname(b), { recursive: true, mode: 0o700 });
    const tmp = `${b}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(`${tmp}.mp3`, audio, { mode: 0o600 });
    fs.renameSync(`${tmp}.mp3`, `${b}.mp3`);
    this.writeMeta(full);
    return full;
  }

  private writeMeta(meta: TtsSpoolMeta): void {
    const b = this.base(meta);
    const tmp = `${b}.${process.pid}.${Date.now()}.json.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(meta), { mode: 0o600 });
    fs.renameSync(tmp, `${b}.json`);
  }

  markSettled(meta: TtsSpoolMeta): TtsSpoolMeta {
    const m = { ...meta, settled: true };
    this.writeMeta(m);
    return m;
  }

  /** Audio guardado y VERIFICADO (sha) del segmento; corrupto o ausente → null (y se borra lo corrupto). */
  read(k: Pick<TtsSpoolMeta, 'itemRunId' | 'segKey' | 'textSha' | 'strategy'>): { meta: TtsSpoolMeta; audio: Buffer } | null {
    const b = this.base(k);
    let meta: TtsSpoolMeta;
    let audio: Buffer;
    try {
      meta = JSON.parse(fs.readFileSync(`${b}.json`, 'utf8'));
      audio = fs.readFileSync(`${b}.mp3`);
    } catch {
      return null;
    }
    if (sha256(audio) !== meta.audioSha || meta.textSha !== k.textSha) { this.remove(k); return null; }
    return { meta, audio };
  }

  remove(k: Pick<TtsSpoolMeta, 'itemRunId' | 'segKey' | 'textSha' | 'strategy'>): void {
    const b = this.base(k);
    for (const f of [`${b}.mp3`, `${b}.json`]) { try { fs.unlinkSync(f); } catch { /* ya no está */ } }
  }

  /** Metadatos de todo lo que el item tiene en el spool (con su audio presente). */
  list(itemRunId: string): TtsSpoolMeta[] {
    const d = this.itemDir(itemRunId);
    let names: string[] = [];
    try { names = fs.readdirSync(d); } catch { return []; }
    const out: TtsSpoolMeta[] = [];
    for (const n of names) {
      if (!n.endsWith('.json') || n.endsWith('.tmp')) continue;
      try {
        const m = JSON.parse(fs.readFileSync(path.join(d, n), 'utf8')) as TtsSpoolMeta;
        if (fs.existsSync(path.join(d, n.replace(/\.json$/, '.mp3')))) out.push(m);
      } catch { /* meta ilegible: la limpia el TTL */ }
    }
    return out;
  }

  /** Borra lo más viejo que el TTL (y directorios vacíos). Nunca lanza. → archivos borrados. */
  sweep(ttlMs: number, now = Date.now()): number {
    let removed = 0;
    let items: string[] = [];
    try { items = fs.readdirSync(this.dir); } catch { return 0; }
    for (const it of items) {
      const d = path.join(this.dir, it);
      let files: string[] = [];
      try { files = fs.readdirSync(d); } catch { continue; }
      for (const f of files) {
        const p = path.join(d, f);
        try { if (now - fs.statSync(p).mtimeMs > ttlMs) { fs.unlinkSync(p); removed++; } } catch { /* carrera */ }
      }
      try { if (!fs.readdirSync(d).length) fs.rmdirSync(d); } catch { /* no vacío */ }
    }
    return removed;
  }
}

let lastSweep = 0;
/** Spool del entorno; barre por TTL como mucho una vez por hora por proceso. */
export function ttsSpoolFor(env: Env, now = Date.now()): TtsSpool {
  const s = new TtsSpool(ttsSpoolDir(env));
  if (now - lastSweep > 3600_000) { lastSweep = now; s.sweep(ttsSpoolTtlMs(env), now); }
  return s;
}
