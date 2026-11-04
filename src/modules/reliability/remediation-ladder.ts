// ─────────────────────────────────────────────────────────────────────────────
// r98 — ESCALERA DE REMEDIACIÓN de un fallo determinista conocido (sin migración: output_summary.remediation).
//
// Incidente (prod run 4c6a9f71): `audiobook_chapter` falló 6 veces con AUDIOBOOK_LANGUAGE_NOT_NEUTRAL. Cada reintento
// (automático y manual) repitió EXACTAMENTE la misma llamada con el mismo prompt, y el validador rechazó lo mismo.
// Principios del dueño: (1) si conocemos el error, el sistema hace algo DISTINTO solo; (2) el creador del curso nunca
// necesita a un admin; (3) cero intervención por curso.
//
// Huella (fingerprint) = tipo de item + código estable + regla del clasificador + códigos internos del validador
// (ordenados). NUNCA el texto libre del mensaje (cambia en cada intento: bloque, término, cifras).
//
// Escalones (por huella; un fallo con OTRA huella reinicia la cuenta; los transitorios A / C / esperas no cuentan):
//   1.ª vez  → observe:  comportamiento de siempre (backoff / auto-heal).
//   2.ª vez  → feedback: rung 1 — el próximo intento CAMBIA su entrada: los hallazgos del validador vuelven al prompt
//                         (output_summary.remediation.feedback; scheduler → brief pedagógico, worker del audiolibro).
//   3.ª vez  → accept:   rung 2 — SOLO validadores de calidad no críticos (DEGRADABLE_CODES): el próximo intento acepta
//                         la salida con una marca de calidad (output_summary.quality) y el curso sigue y se empaqueta.
//              exhausted si la huella no es degradable.
//   4.ª vez+ → exhausted: rung 3 — sin más reintentos automáticos con esa huella: `failed` con un motivo claro para el
//                         usuario; el DUEÑO puede reintentar desde su pantalla (owner-retry.ts), sin admin.
// Gasto: los intentos extra (≤ MAX_LADDER_GRANTS por huella) pasan por los guards de siempre (presupuesto de la parte,
// tope del run, autorización vigente). Ninguna aprobación nueva.
// Puro salvo el reloj.
// ─────────────────────────────────────────────────────────────────────────────
import type { FailureVerdict } from './failure-classifier';
import { FAILURE_CODE_SOURCES } from './failure-classifier';
import { redactErrorExcerpt } from './attempt-log';

export const REMEDIATION_KEY = 'remediation';
export const QUALITY_KEY = 'quality';
/** Intentos concedidos por la escalera (rung 1 + rung 2) por huella. Tope duro. */
export const MAX_LADDER_GRANTS = 2;
export const REMEDIATION_FEEDBACK_MAX = 1200;
export const REMEDIATION_FINDINGS_MAX = 10;
export const REMEDIATION_PREVIOUS_MAX = 5;

/**
 * Lista EXPLÍCITA y corta de validadores que pueden degradar a «aceptado con marca de calidad» (rung 2). Solo calidad
 * de redacción no crítica, y solo donde la aceptación está cableada de verdad:
 *  - LANGUAGE_NOT_NEUTRAL: scheduler.prevalidateV3 (contenido + artifacts v3, revalida con la estructura intacta) y el
 *    ejecutor (45-dynamic-generation-executor.js: lo de idioma pasa a blando);
 *  - AUDIOBOOK_LANGUAGE_NOT_NEUTRAL: generateSectionScript (audio-scripts.ts).
 * NUNCA: JSON inválido, campos/archivos faltantes, estructura, veracidad (CONTENT_TRUTH / FABRICATED_DATA), banco de
 * examen, paquete, presupuesto… (cualquier código fuera de esta lista termina en rung 3).
 */
export const DEGRADABLE_CODES: readonly string[] = Object.freeze(['LANGUAGE_NOT_NEUTRAL', 'AUDIOBOOK_LANGUAGE_NOT_NEUTRAL']);

/** Motivo para el usuario/admin cuando la escalera se agotó (rung 3). */
export const REMEDIATION_EXHAUSTED_REASON =
  'falla repetida con la misma causa; reintentar igual no lo arregla. Ya se probó corregir el pedido automáticamente; puedes reintentar esta parte desde tu pantalla.';
export const REMEDIATION_EXHAUSTED_CODE = 'remediation_exhausted';

export type LadderAction = 'observe' | 'feedback' | 'accept' | 'exhausted';

export interface RemediationState {
  v: 1;
  fingerprint: string;
  code: string;
  rule: string;
  itemType: string | null;
  innerCodes: string[];
  /** Fallos CONSECUTIVOS (deterministas) con esta huella. */
  count: number;
  /** 0 observar · 1 feedback · 2 aceptar con marca · 3 agotada. */
  rung: 0 | 1 | 2 | 3;
  firstAt: string;
  lastAt: string;
  /** Hallazgos del validador (del mensaje, recortados y sin secretos). */
  findings: string[];
  /** Texto que el próximo intento agrega a su prompt (rung ≥ 1). */
  feedback: string | null;
  /** Códigos que el próximo intento puede aceptar con marca de calidad (rung 2). */
  acceptCodes: string[];
  /** Intentos concedidos por la escalera para esta huella (≤ MAX_LADDER_GRANTS). */
  grants: number;
  /** Escalones probados con su resultado (para el reporte de desarrollo). */
  tried: Array<{ rung: number; at: string; outcome: string }>;
  /** Último mensaje de error (recortado y sin secretos): solo para el reporte. */
  sampleError: string | null;
  /** rung 3: error exacto (≤ 500) que agotó la escalera — los barridos automáticos lo comparan. */
  exhaustedError?: string | null;
  exhaustedAt?: string | null;
  /** Desenlace al completar la parte (recordItemCompleted): 'accepted' (rung 2) | 'completed'. */
  outcome?: string | null;
  /** Huellas anteriores de esta parte (resumen acotado). */
  previous?: Array<{ fingerprint: string; count: number; rung: number; lastAt: string }>;
}

/**
 * Códigos que YA cambian su entrada en cada reintento con una escalera propia (no los toca esta escalera): audio de un
 * segmento (escalera A2 de r67: instructions → split, output_summary.audioRetryStrategy) y la repetición del guion del
 * audiolibro (descarta y regenera solo los bloques implicados).
 */
export const SELF_ADAPTIVE_CODES: readonly string[] = Object.freeze([
  'AUDIO_WPM_OUT_OF_RANGE', 'AUDIOBOOK_SEGMENT_DUPLICATE', 'TTS_AUDIO_INVALID', 'AUDIO_STRATEGIES_EXHAUSTED', 'AUDIOBOOK_SCRIPT_REPETITION',
]);

/** ¿El veredicto describe un fallo DETERMINISTA (misma entrada → mismo rechazo)? */
export function isDeterministicVerdict(v: Pick<FailureVerdict, 'class' | 'strategy' | 'humanReason'> & { code?: string }): boolean {
  if (v.code && SELF_ADAPTIVE_CODES.includes(v.code)) return false;
  if (v.class === 'B') return true;
  if (v.class !== 'D') return false;
  if (v.strategy === 'wait_provider') return false;
  return !['budget', 'config', 'duplicate_charge'].includes(String(v.humanReason ?? ''));
}

/** Huella normalizada: tipo + código + regla + códigos internos (ordenados). Nunca el texto libre. */
export function failureFingerprintOf(v: Pick<FailureVerdict, 'code' | 'rule' | 'innerCodes'>, itemType: string | null | undefined): string {
  const inner = [...new Set((v.innerCodes ?? []).map(String))].sort();
  return [String(itemType ?? '-'), v.code, v.rule, inner.join(',')].join('|').slice(0, 200);
}

/** Hallazgos del validador desde el mensaje (después del primer «: »; separados por «; » o « | »). */
export function findingsOfError(error: string): string[] {
  const s = String(redactErrorExcerpt(error) ?? '');
  const idx = s.search(/:\s/);
  const body = idx >= 0 ? s.slice(idx + 2) : s;
  // «… no está en español neutro: X; Y» → la lista va después del último «: » de la cabecera.
  const tail = /no está en español neutro:\s*(.*)$/.exec(body)?.[1] ?? body;
  return tail.split(/;\s+|\s\|\s/).map((x) => x.trim()).filter(Boolean).slice(0, REMEDIATION_FINDINGS_MAX).map((x) => x.slice(0, 160));
}

/** Texto que se agrega al prompt del próximo intento (rung 1). */
export function feedbackFor(code: string, innerCodes: readonly string[], findings: readonly string[]): string {
  const codes = new Set([code, ...innerCodes]);
  const list = findings.length ? findings.join('; ') : '(sin detalle)';
  const lines: string[] = ['CORRECCIÓN OBLIGATORIA (el intento anterior fue rechazado dos veces por la misma causa):'];
  if ([...codes].some((c) => /LANGUAGE_NOT_NEUTRAL$/.test(c))) {
    lines.push(`- Escribe en español latinoamericano neutro (tuteo «tú»; sin voseo, sin «vosotros», sin regionalismos). Evita estos términos: ${list}; si son parte del contenido del curso, cítalos entre comillas.`);
  } else if ([...codes].some((c) => /^(CONTENT_TRUTH|FABRICATED_DATA|OUTDATED_CLAIM|QUANTITY_CLAIM)/.test(c))) {
    lines.push(`- No uses cifras, fechas, estudios ni datos que no estén en la fuente. Hallazgos: ${list}.`);
  } else {
    lines.push(`- El validador (${[...codes].join(', ')}) rechazó: ${list}. Corrige exactamente esos puntos.`);
  }
  return lines.join('\n').slice(0, REMEDIATION_FEEDBACK_MAX);
}

export function remediationOf(os: Record<string, any> | null | undefined): RemediationState | null {
  const r = os?.[REMEDIATION_KEY];
  return r && typeof r === 'object' && typeof r.fingerprint === 'string' ? (r as RemediationState) : null;
}

/** ¿Todos los códigos de la huella son degradables? */
export function isDegradableFingerprint(code: string, innerCodes: readonly string[]): boolean {
  const codes = innerCodes.length ? innerCodes : [code];
  return codes.length > 0 && codes.every((c) => DEGRADABLE_CODES.includes(c));
}

export interface LadderStep {
  state: RemediationState;
  action: LadderAction;
  /** ¿Conceder un intento extra para el escalón (rung 1/2)? */
  grant: boolean;
}

/**
 * Próximo estado de la escalera ante un fallo. null = el fallo no es determinista (no toca la escalera).
 * `retryable` = el emisor dice que otro intento puede servir; `paidUncertain` = riesgo de pago incierto (nunca se
 * conceden intentos extra: esos los decide la conciliación).
 */
export function ladderStep(
  prev: RemediationState | null,
  verdict: Pick<FailureVerdict, 'class' | 'strategy' | 'humanReason' | 'code' | 'rule' | 'innerCodes' | 'paidRisk'>,
  itemType: string | null | undefined,
  error: string,
  now: Date,
  opts: { retryable: boolean },
): LadderStep | null {
  if (!isDeterministicVerdict(verdict)) return null;
  const fp = failureFingerprintOf(verdict, itemType);
  const at = now.toISOString();
  const inner = [...new Set((verdict.innerCodes ?? []).map(String))].sort();
  const same = prev && prev.fingerprint === fp && !prev.outcome;
  const previous = prev && !same
    ? [...(prev.previous ?? []), { fingerprint: prev.fingerprint, count: prev.count, rung: prev.rung, lastAt: prev.lastAt }].slice(-REMEDIATION_PREVIOUS_MAX)
    : prev?.previous ?? [];
  const count = same ? prev!.count + 1 : 1;
  const findings = findingsOfError(error);
  const degradable = isDegradableFingerprint(verdict.code, inner);
  let rung: RemediationState['rung'];
  let action: LadderAction;
  if (count <= 1) { rung = 0; action = 'observe'; }
  else if (count === 2) { rung = 1; action = 'feedback'; }
  else if (count === 3 && degradable) { rung = 2; action = 'accept'; }
  else { rung = 3; action = 'exhausted'; }
  const grantsUsed = same ? prev!.grants : 0;
  const canGrant = opts.retryable && verdict.paidRisk !== 'uncertain' && grantsUsed < MAX_LADDER_GRANTS;
  const grant = (action === 'feedback' || action === 'accept') && canGrant;
  const tried = [...(same ? prev!.tried ?? [] : [])];
  // El escalón anterior falló con la misma huella → su resultado queda registrado.
  if (same && prev!.rung >= 1 && prev!.rung <= 2) tried.push({ rung: prev!.rung, at, outcome: 'failed_same_fingerprint' });
  if (action === 'exhausted') tried.push({ rung: 3, at, outcome: 'exhausted' });
  const state: RemediationState = {
    v: 1,
    fingerprint: fp,
    code: verdict.code,
    rule: verdict.rule,
    itemType: itemType ?? null,
    innerCodes: inner,
    count,
    rung,
    firstAt: same ? prev!.firstAt : at,
    lastAt: at,
    findings,
    feedback: rung >= 1 ? feedbackFor(verdict.code, inner, findings) : null,
    acceptCodes: rung === 2 ? (inner.length ? inner : [verdict.code]).filter((c) => DEGRADABLE_CODES.includes(c)) : rung === 3 && same ? prev!.acceptCodes ?? [] : [],
    grants: grantsUsed + (grant ? 1 : 0),
    tried: tried.slice(-10),
    sampleError: redactErrorExcerpt(error),
    ...(action === 'exhausted' ? { exhaustedError: String(error ?? '').slice(0, 500), exhaustedAt: at } : {}),
    ...(previous.length ? { previous } : {}),
  };
  return { state, action, grant };
}

/** rung 3 vigente para ESTE error: ningún barrido automático lo reabre (el dueño sí, a mano). */
export function remediationBlocksAuto(os: Record<string, any> | null | undefined, error: string | null | undefined): boolean {
  const r = remediationOf(os);
  return !!r && r.rung === 3 && !r.outcome && typeof r.exhaustedError === 'string' && r.exhaustedError === String(error ?? '').slice(0, 500);
}

/** Códigos que el intento ACTUAL puede aceptar con marca de calidad (rung 2 vigente). */
export function acceptCodesOf(os: Record<string, any> | null | undefined): Set<string> {
  const r = remediationOf(os);
  if (!r || r.outcome || r.rung !== 2) return new Set();
  return new Set((r.acceptCodes ?? []).filter((c) => DEGRADABLE_CODES.includes(c)));
}

/** Feedback para el prompt del intento actual (rung ≥ 1 sin completar), o null. */
export function remediationFeedbackOf(os: Record<string, any> | null | undefined): string | null {
  const r = remediationOf(os);
  if (!r || r.outcome || r.rung < 1 || typeof r.feedback !== 'string' || !r.feedback.trim()) return null;
  return r.feedback.slice(0, REMEDIATION_FEEDBACK_MAX);
}

/** Marca de calidad de una aceptación de rung 2 (output_summary.quality.warnings[]). */
export function qualityAcceptance(codes: readonly string[], findings: readonly string[], now: Date, fingerprint: string | null): Record<string, any> {
  return { code: 'quality_accepted', codes: [...codes], findings: findings.slice(0, REMEDIATION_FINDINGS_MAX).map((f) => String(redactErrorExcerpt(f) ?? '').slice(0, 160)), fingerprint, rung: 2, at: now.toISOString() };
}

/** output_summary.quality con la marca nueva agregada (acotado a 20). */
export function withQualityWarning(prev: unknown, w: Record<string, any>): Record<string, any> {
  const q = prev && typeof prev === 'object' && !Array.isArray(prev) ? { ...(prev as Record<string, any>) } : {};
  const ws = Array.isArray(q.warnings) ? [...q.warnings] : [];
  ws.push(w);
  return { ...q, degraded: true, warnings: ws.slice(-20) };
}

// ─── Señal sistémica «Falla común» (agregada, no por curso) ─────────────────

export const COMMON_FAILURE_MIN_COURSES = 3;
export const COMMON_FAILURE_WINDOW_HOURS = 24;
export const COMMON_FAILURE_QUIET_HOURS = 72;

export interface CommonFailureRow {
  courseId: number;
  runId: string;
  itemKey: string;
  itemType: string | null;
  remediation: RemediationState;
}

export interface CommonFailureSignal {
  fingerprint: string;
  code: string;
  rule: string;
  itemType: string | null;
  firstSeen: string;
  lastSeen: string;
  courses: number[];
  runs: string[];
  /** Courses distintos dentro de la mejor ventana de 24 h. */
  coursesInWindow: number;
  samples: Array<{ error: string | null; findings: string[] }>;
  rungs: Array<{ rung: number; outcome: string; count: number }>;
  source: { file: string; fn: string; hint: string } | null;
  status: 'active' | 'resolved';
  resolvedBy: 'admin' | 'quiet_72h' | null;
  resolvedAt: string | null;
  report: string;
}

/** Texto para el reporte: sin secretos (redactErrorExcerpt) y sin emails (solo ids en el reporte). */
export function sanitizeForReport(v: unknown, max = 300): string {
  return String(redactErrorExcerpt(v) ?? '')
    .replace(/\b((?:access_|refresh_|id_)?token|key|secret|password|signature)\s*[:=]\s*[^\s"',;]+/gi, '$1=[redacted]')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]').replace(/\s+/g, ' ').slice(0, max);
}

const ms = (s: string | null | undefined) => { const t = Date.parse(String(s ?? '')); return Number.isFinite(t) ? t : NaN; };

/**
 * Agrupa por huella las partes con escalera (de cualquier run) y devuelve las que tocaron ≥ 3 cursos distintos dentro
 * de 24 h. `resolutions`: huella → fecha de la marca «resuelto» de un admin (si hay ocurrencias DESPUÉS, vuelve a estar
 * activa). Sin ocurrencias en 72 h → resuelta sola.
 */
export function commonFailureSignals(rows: readonly CommonFailureRow[], resolutions: ReadonlyMap<string, string>, now: Date = new Date()): CommonFailureSignal[] {
  const by = new Map<string, CommonFailureRow[]>();
  for (const r of rows) {
    const rem = r.remediation;
    if (!rem || typeof rem.fingerprint !== 'string' || !Number.isFinite(ms(rem.lastAt))) continue;
    by.set(rem.fingerprint, [...(by.get(rem.fingerprint) ?? []), r]);
  }
  const out: CommonFailureSignal[] = [];
  const windowMs = COMMON_FAILURE_WINDOW_HOURS * 3_600_000;
  for (const [fp, list] of by) {
    const occ = list.map((r) => ({ c: r.courseId, t: ms(r.remediation.lastAt) })).sort((a, b) => a.t - b.t);
    let best = 0;
    for (let i = 0; i < occ.length; i++) {
      const set = new Set<number>();
      for (let j = i; j < occ.length && occ[j].t - occ[i].t <= windowMs; j++) set.add(occ[j].c);
      best = Math.max(best, set.size);
    }
    if (best < COMMON_FAILURE_MIN_COURSES) continue;
    const first = Math.min(...list.map((r) => ms(r.remediation.firstAt)).filter(Number.isFinite));
    const last = Math.max(...occ.map((o) => o.t));
    const head = list[0].remediation;
    const rungMap = new Map<string, { rung: number; outcome: string; count: number }>();
    for (const r of list) {
      const rem = r.remediation;
      const outcome = rem.outcome ? (rem.outcome === 'accepted' ? 'aceptado con marca de calidad' : 'completado tras corregir el pedido')
        : rem.rung === 3 ? 'agotado (falló igual)' : rem.rung === 2 ? 'aceptación pendiente' : rem.rung === 1 ? 'reintento con correcciones pendiente' : 'observando';
      const k = `${rem.rung}|${outcome}`;
      const e = rungMap.get(k) ?? { rung: rem.rung, outcome, count: 0 };
      e.count++;
      rungMap.set(k, e);
    }
    const resolvedAdmin = resolutions.get(fp) ?? null;
    const adminOk = resolvedAdmin && ms(resolvedAdmin) >= last;
    const quiet = now.getTime() - last > COMMON_FAILURE_QUIET_HOURS * 3_600_000;
    const sig: CommonFailureSignal = {
      fingerprint: fp,
      code: head.code,
      rule: head.rule,
      itemType: head.itemType ?? list[0].itemType ?? null,
      firstSeen: new Date(Number.isFinite(first) ? first : occ[0].t).toISOString(),
      lastSeen: new Date(last).toISOString(),
      courses: [...new Set(list.map((r) => r.courseId))].sort((a, b) => a - b),
      runs: [...new Set(list.map((r) => r.runId))],
      coursesInWindow: best,
      samples: list.slice(-3).map((r) => ({ error: r.remediation.sampleError ? sanitizeForReport(r.remediation.sampleError) : null, findings: (r.remediation.findings ?? []).slice(0, 5).map((f) => sanitizeForReport(f, 160)) })),
      rungs: [...rungMap.values()].sort((a, b) => a.rung - b.rung),
      source: FAILURE_CODE_SOURCES[head.code] ?? (head.innerCodes ?? []).map((c) => FAILURE_CODE_SOURCES[c]).find(Boolean) ?? null,
      status: adminOk || quiet ? 'resolved' : 'active',
      resolvedBy: adminOk ? 'admin' : quiet ? 'quiet_72h' : null,
      resolvedAt: adminOk ? resolvedAdmin : quiet ? new Date(last + COMMON_FAILURE_QUIET_HOURS * 3_600_000).toISOString() : null,
      report: '',
    };
    sig.report = commonFailureReport(sig);
    out.push(sig);
  }
  return out.sort((a, b) => ms(b.lastSeen) - ms(a.lastSeen));
}

/** Reporte listo para pegar en una sesión de desarrollo (Markdown). Solo ids; mensajes recortados y sin secretos. */
export function commonFailureReport(s: Omit<CommonFailureSignal, 'report'>): string {
  const L: string[] = [];
  L.push(`## Falla común (bug probable): ${s.courses.length} cursos con la misma falla ${s.code}`);
  L.push('');
  L.push(`- Huella: \`${s.fingerprint}\``);
  L.push(`- Código: ${s.code} · validador/regla: ${s.rule} · tipo de parte: ${s.itemType ?? '-'}`);
  L.push(`- Visto por primera vez: ${s.firstSeen} · última vez: ${s.lastSeen}`);
  L.push(`- Cursos afectados (${s.courses.length}; ${s.coursesInWindow} dentro de 24 h): ${s.courses.join(', ')}`);
  L.push(`- Runs: ${s.runs.join(', ')}`);
  L.push(`- Dónde se emite: ${s.source ? `src/${s.source.file} — ${s.source.fn}` : '(sin mapa: agregar el código a FAILURE_CODE_SOURCES en src/modules/reliability/failure-classifier.ts)'}`);
  L.push('- Escalones de remediación probados:');
  for (const r of s.rungs) L.push(`  - rung ${r.rung}: ${r.outcome} (${r.count})`);
  L.push('- Ejemplos (recortados, sin secretos):');
  s.samples.forEach((x, i) => {
    L.push(`  ${i + 1}. ${sanitizeForReport(x.error ?? '')}`);
    if (x.findings.length) L.push(`     hallazgos: ${sanitizeForReport(x.findings.join(' · '))}`);
  });
  L.push(`- Punto de partida sugerido: ${s.source ? s.source.hint : `buscar dónde se emite ${s.code} (grep -rn "${s.code}" src) y por qué el mismo pedido falla igual en varios cursos`}.`);
  L.push(`- Estado: ${s.status === 'resolved' ? `resuelto (${s.resolvedBy === 'admin' ? 'marcado por un admin' : 'sin apariciones en 72 h'})` : 'activo'}`);
  return L.join('\n');
}
