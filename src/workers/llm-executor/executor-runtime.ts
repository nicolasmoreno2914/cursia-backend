import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import { LLM_WORKER_MAX_TOKENS_CAP } from './server-llm';

/** Exam-bank D: tokens de salida estimados por llamada del banco en el worker (el navegador usa 3.500). */
export const EXAM_BANK_WORKER_OUTPUT_EST = 7000;
/** max_tokens de esas llamadas: ~1,7× lo estimado (salida real medida ≈ 0,95× lo estimado). FinOps reserva cada llamada
 *  a max_tokens: 12.000 (no el tope de 16.000) para no inflar las reservas pendientes ni el límite por parte. */
export const EXAM_BANK_WORKER_MAX_TOKENS = 12000;

/**
 * Loop 4 — corre el MISMO código de generación que el navegador (copia en vendor/dynamic-executor, sincronizada con
 * campuscloud-gen por scripts/sync-dynamic-executor-vendor.js y verificada en el gate) dentro del worker del backend.
 * Mismos prompts, validadores y reparaciones dirigidas: la calidad no cambia por mover la parte al servidor.
 *
 * Aislamiento: un contexto vm NUEVO por parte (ningún estado de un item se filtra a otro); los scripts se compilan
 * una sola vez por proceso. El código del ejecutor no tiene red: `fetch` solo resuelve artifacts de dependencia
 * (`srv://<id>`), cualquier otra URL falla; la IA entra únicamente por `api()` (server-llm.ts).
 */

/** Mismos archivos (y orden) que carga el ejecutor del navegador en la E2E, sin 04-api.js (api() la da el servidor). */
export const EXECUTOR_VENDOR_FILES = [
  '05-libro.js', '06-scorms.js', '06b-scorm-templates.js', '42-scorm-templates-ui.js', '07-examenes.js', '08-downloads.js',
  '44-dynamic-prompt-builders.js', '46-dynamic-context-package.js', '24-backend-client.js', '45-dynamic-generation-executor.js',
] as const;

export function executorVendorDir(): string {
  // dist/workers/llm-executor → raíz del repo → vendor/dynamic-executor (también desde src con ts-node).
  return path.resolve(__dirname, '..', '..', '..', 'vendor', 'dynamic-executor');
}

let compiled: vm.Script[] | null = null;
function scripts(dir = executorVendorDir()): vm.Script[] {
  if (compiled) return compiled;
  compiled = EXECUTOR_VENDOR_FILES.map((f) => new vm.Script(fs.readFileSync(path.join(dir, f), 'utf8'), { filename: `vendor/dynamic-executor/${f}` }));
  return compiled;
}

export interface ExecutorRuntimeDeps {
  /** api() con el contrato de 04-api.js (server-llm.ts). */
  api: (...args: any[]) => Promise<string>;
  /** Texto de un artifact de dependencia (ya verificado que pertenece al curso del item). */
  artifactText: (artifactId: string) => Promise<string | null>;
  ownerId: string;
  logger: { log(m: string): void; warn(m: string): void; error(m: string): void };
}

export interface ExecutorRunResult {
  ok: boolean;
  artifacts?: Array<{ type: string; content: string; filename: string; mimeType: string }>;
  summary?: Record<string, unknown>;
  error?: string;
  retryable?: boolean;
  draft?: { type: string; content: string; filename: string; mimeType: string };
  draftClear?: boolean;
}

export interface ExecutorRuntime {
  run(item: unknown): Promise<ExecutorRunResult>;
  /** Mismo mapeo de errores que el navegador (_dynMapApiError). */
  mapError(e: unknown): { retryable: boolean; msg: string; itemOnly?: boolean; runPaused?: boolean };
  examBankDraftSupported(item: unknown): boolean;
  /**
   * O2b: campo del fail que lleva el borrador de ESTE item según su tipo y el anuncio del claim
   * (`examBankDraftArtifactId` para exam/final_exam, `applicationDraftArtifactId` para application_activity),
   * o null si el claim no anuncia soporte. Mismo criterio que el navegador (dynDraftFieldFor).
   */
  draftFailField(item: unknown): 'examBankDraftArtifactId' | 'applicationDraftArtifactId' | null;
}

export function createExecutorRuntime(deps: ExecutorRuntimeDeps): ExecutorRuntime {
  const mem = new Map<string, string>();
  const noop = () => undefined;
  const stubEl = (): any => ({
    addEventListener: noop, removeEventListener: noop, appendChild: noop, insertBefore: noop, removeChild: noop,
    classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
    style: {}, dataset: {}, children: [], options: [], querySelector: () => null, querySelectorAll: () => [],
    setAttribute: noop, getAttribute: () => null, remove: noop, focus: noop, click: noop,
    disabled: false, textContent: '', innerHTML: '', value: '', checked: false,
  });
  // Sin backend del navegador (CURSIA_BACKEND_ENABLED vacío): el cliente HTTP del frontend nunca se usa acá.
  const local = new Map<string, string>();
  const ctx: Record<string, any> = {
    document: {
      getElementById: () => stubEl(), querySelector: () => stubEl(), querySelectorAll: () => [],
      createElement: () => stubEl(), addEventListener: noop, body: stubEl(), documentElement: stubEl(), head: stubEl(), readyState: 'complete',
    },
    navigator: { userAgent: 'cursia-llm-worker' },
    localStorage: { getItem: (k: string) => (local.has(k) ? local.get(k)! : null), setItem: (k: string, v: string) => { local.set(k, String(v)); }, removeItem: (k: string) => { local.delete(k); }, key: () => null, get length() { return local.size; } },
    location: { hostname: 'llm-worker.local', href: 'https://llm-worker.local/', origin: 'https://llm-worker.local', protocol: 'https:' },
    alert: noop, confirm: () => false, prompt: () => null, addEventListener: noop,
    URL, URLSearchParams, AbortController, TextEncoder, TextDecoder,
    GEN_STOPPED: false,
    SEL: { scormTemplates: 'auto' },
    D: {},
    console: { log: (...a: any[]) => deps.logger.log(a.join(' ')), info: (...a: any[]) => deps.logger.log(a.join(' ')), warn: (...a: any[]) => deps.logger.warn(a.join(' ')), error: (...a: any[]) => deps.logger.error(a.join(' ')) },
    setTimeout, clearTimeout, setInterval, clearInterval, Promise, Date, Math, JSON,
    sessionStorage: {
      getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
      setItem: (k: string, v: string) => { mem.set(k, String(v)); },
      removeItem: (k: string) => { mem.delete(k); },
      key: (i: number) => [...mem.keys()][i] ?? null,
      get length() { return mem.size; },
    },
    SB_USER: { id: deps.ownerId },
    __serverApi: deps.api,
    __serverDownloadUrl: async (id: string) => ({ ok: true, url: 'srv://' + id }),
    __serverFetch: async (url: string) => {
      const u = String(url);
      if (!u.startsWith('srv://')) throw new Error('llm-worker: el ejecutor no tiene red (' + u.slice(0, 60) + ')');
      const text = await deps.artifactText(u.slice(6));
      if (text === null) return { ok: false, status: 404, text: async () => '', json: async () => null };
      return { ok: true, status: 200, text: async () => text, json: async () => JSON.parse(text) };
    },
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  ctx.self = ctx;
  vm.createContext(ctx);
  for (const s of scripts()) s.runInContext(ctx);
  // Los archivos del frontend definen sus propios `api` / `artifactDownloadUrl` / `fetch` del navegador al cargar
  // (24-backend-client.js): acá SIEMPRE ganan los del servidor.
  const serverGlobals: Record<string, unknown> = {
    api: ctx.__serverApi,
    artifactDownloadUrl: ctx.__serverDownloadUrl,
    fetch: ctx.__serverFetch,
    // 24-backend-client.js resuelve los artifacts con su propia función interna (HTTP del navegador): acá, Storage.
    openArtifactJsonById: async (id: string) => {
      if (!id) return { ok: false, error: 'missing_artifact_id' };
      const text = await deps.artifactText(String(id));
      if (text === null) return { ok: false, error: 'artifact_not_found' };
      try { return { ok: true, json: JSON.parse(text) }; } catch { return { ok: false, error: 'json_parse_failed' }; }
    },
  };
  // El ciclo del ejecutor del navegador (claim/heartbeat/complete por HTTP) NUNCA corre acá: si algo lo llamara,
  // falla fuerte (lo maneja el worker).
  for (const name of ['backendDynClaim', 'backendDynComplete', 'backendDynFail', 'backendDynHeartbeat', 'backendDynGetRun', 'backendDynReleaseLease', 'backendDynStartRun', 'dynArtifactUpload']) {
    serverGlobals[name] = () => { throw new Error(`llm-worker: ${name} no se usa en el servidor`); };
  }
  Object.assign(ctx, serverGlobals);
  ctx.DYN_LLM_BACKOFF_BASE_MS = Number(process.env.DYNAMIC_LLM_WORKER_BACKOFF_MS || 2000);
  // Loop 9 (fix M4): el MISMO interruptor del modo banco que tiene el navegador (DYN_EXAM_BANK_MODE_ENABLED). Encendido
  // por defecto; DYNAMIC_LLM_WORKER_EXAM_BANK=off vuelve al GIFT de siempre (apagado de emergencia; lo usa la E2E).
  if (String(process.env.DYNAMIC_LLM_WORKER_EXAM_BANK || '').trim().toLowerCase() === 'off') ctx.DYN_EXAM_BANK_MODE_ENABLED = false;
  // Exam-bank D (#1353): el tope de 3.500 tokens estimados por llamada del banco existe por el corte de 100 s de
  // Cloudflare en el proxy del NAVEGADOR (#583, 524). El worker llama a Anthropic DIRECTO con streaming (sin ese corte;
  // timeout total 15 min): partes de ≤ 7.000 tokens estimados con max_tokens 12.000 (≤ LLM_WORKER_MAX_TOKENS_CAP; ~1,7×
  // de margen contra el corte por max_tokens). Mismas preguntas y mismas reglas; menos llamadas (el prefijo del
  // capítulo se paga una vez por llamada). El navegador sigue con 3.500 / 8.000.
  ctx.DYN_EXAM_BANK_MAX_OUTPUT_EST = EXAM_BANK_WORKER_OUTPUT_EST;
  ctx.DYN_EXAM_BANK_CALL_MAX_TOKENS = Math.min(EXAM_BANK_WORKER_MAX_TOKENS, LLM_WORKER_MAX_TOKENS_CAP);
  const runner = vm.runInContext('(function (j) { return _dynRunItem(JSON.parse(j)); })', ctx) as (j: string) => Promise<ExecutorRunResult>;
  return {
    run: (item) => runner(JSON.stringify(item)),
    mapError: (e) => ctx._dynMapApiError(e),
    examBankDraftSupported: (item) => {
      try { return !!ctx.dynExamBankDraftSupported(JSON.parse(JSON.stringify(item))); } catch { return false; }
    },
    draftFailField: (item) => {
      try {
        const f = ctx.dynDraftFieldFor(JSON.parse(JSON.stringify(item)));
        return f === 'examBankDraftArtifactId' || f === 'applicationDraftArtifactId' ? f : null;
      } catch { return null; }
    },
  };
}

/** Para tests: fuerza recompilar (otro directorio de vendor). */
export function resetExecutorScriptsForTests(): void {
  compiled = null;
}
