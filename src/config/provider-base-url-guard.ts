/**
 * r58 (AU1 R3) — guarda de arranque de las URLs base de proveedores (`*_API_BASE_URL`, `VIDEOGEN_API_URL`).
 *
 * Las overrides existen para probar SOLO contra servidores falsos (e2e en 127.0.0.1, staging). En PRODUCCIÓN
 * (el proceso apunta al proyecto Supabase de producción: `pointsToProduction`, la misma detección que el
 * escape DN-1 de Videogen) una override hacia un host que no es el oficial del proveedor mandaría claves
 * reales y contenido de clientes a otro servidor, o llenaría cursos con salidas falsas. Regla:
 *  - producción + override a un host no oficial (o sin https) → el proceso NO arranca
 *    (`PROVIDER_BASE_URL_OVERRIDE_IN_PRODUCTION`), salvo el escape explícito
 *    `ALLOW_PROVIDER_BASE_URL_OVERRIDE_IN_PRODUCTION=true` (se loguea igual);
 *  - fuera de producción → sin cambios (las overrides de los e2e siguen funcionando).
 * El log nunca incluye la URL completa (solo esquema + host: sin credenciales, ruta ni query).
 * Puro salvo `console` (el env se pasa como parámetro).
 */
import { pointsToProduction } from '../modules/dynamic-generation/dynamic-video-delivery';

/** Token del provider de AppModule que corre la guarda al arrancar. */
export const PROVIDER_BASE_URL_GUARD = 'PROVIDER_BASE_URL_GUARD';
export const PROVIDER_BASE_URL_OVERRIDE_IN_PRODUCTION = 'PROVIDER_BASE_URL_OVERRIDE_IN_PRODUCTION';
export const ALLOW_PROVIDER_BASE_URL_OVERRIDE_ENV = 'ALLOW_PROVIDER_BASE_URL_OVERRIDE_IN_PRODUCTION';

/** Variable → hosts oficiales del proveedor (https). */
export const PROVIDER_BASE_URL_OFFICIAL_HOSTS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  ANTHROPIC_API_BASE_URL: ['api.anthropic.com'],
  OPENAI_API_BASE_URL: ['api.openai.com'],
  GAMMA_API_BASE_URL: ['public-api.gamma.app'],
  // Videogen es propio (video-engine.controller.ts): sin default, el host de producción es este.
  VIDEOGEN_API_URL: ['videosb.nomaddi.com'],
});

export interface ProviderBaseUrlFinding {
  env: string;
  /** esquema + host (redactado: sin credenciales, puerto incluido, sin ruta ni query) o `<invalid>`. */
  target: string;
  why: 'unparseable' | 'not_https' | 'non_official_host';
}

/** `scheme://host[:port]` sin credenciales ni ruta; `<invalid>` si no se puede parsear. */
export function redactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}`;
  } catch {
    return '<invalid>';
  }
}

/** Overrides presentes que NO apuntan a un host oficial por https (sin mirar el entorno). */
export function providerBaseUrlFindings(env: Record<string, string | undefined>): ProviderBaseUrlFinding[] {
  const out: ProviderBaseUrlFinding[] = [];
  for (const [key, hosts] of Object.entries(PROVIDER_BASE_URL_OFFICIAL_HOSTS)) {
    const raw = String(env[key] ?? '').trim();
    if (!raw) continue;
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      out.push({ env: key, target: '<invalid>', why: 'unparseable' });
      continue;
    }
    if (u.protocol !== 'https:') out.push({ env: key, target: redactUrl(raw), why: 'not_https' });
    else if (!hosts.includes(u.hostname.toLowerCase()) || u.username || u.password || (u.port && u.port !== '443')) {
      out.push({ env: key, target: redactUrl(raw), why: 'non_official_host' });
    }
  }
  return out;
}

/**
 * Review r1 (M-1): procedencia del texto de IA del worker de servidor. `real` solo si la URL base de Anthropic es la
 * oficial (https, api.anthropic.com, sin puerto ni credenciales) o no está configurada; cualquier otra (un fake local, un
 * proxy de pruebas) → `mock`: lo que genere nunca llega a un paquete final (classifyRunItems → preview). En cualquier
 * entorno (la guarda de arranque solo cubre producción). Sin env: SOLO la URL (el flag de abajo no aplica).
 *
 * Review r2 (m4) — Ruling: una override se declara proveedor REAL solo de forma explícita con
 * `ANTHROPIC_BASE_URL_IS_REAL_PROVIDER=true` (gateway / proxy regional legítimo; el e2e lo pone SOLO al worker que
 * prueba el camino real hacia el paquete final). Fuera de producción el flag basta. En producción el flag se IGNORA
 * (→ mock) salvo que también esté `ALLOW_PROVIDER_BASE_URL_OVERRIDE_IN_PRODUCTION=true` y la override sea https
 * (nunca http en claro con claves reales). Sin el flag, una override sigue siendo `mock` (R2 intacto).
 */
export const ANTHROPIC_BASE_URL_IS_REAL_PROVIDER_ENV = 'ANTHROPIC_BASE_URL_IS_REAL_PROVIDER';

export function anthropicLlmModeForBaseUrl(raw: string | null | undefined, env?: Record<string, string | undefined> | null): 'real' | 'mock' {
  const v = String(raw ?? '').trim();
  if (!v) return 'real';
  const findings = providerBaseUrlFindings({ ANTHROPIC_API_BASE_URL: v });
  if (!findings.length) return 'real';
  if (!env || env[ANTHROPIC_BASE_URL_IS_REAL_PROVIDER_ENV] !== 'true') return 'mock';
  if (pointsToProduction(env as NodeJS.ProcessEnv)) {
    if (env[ALLOW_PROVIDER_BASE_URL_OVERRIDE_ENV] !== 'true') return 'mock';
    if (findings.some((f) => f.why !== 'non_official_host')) return 'mock';
  }
  return 'real';
}

export interface ProviderBaseUrlVerdict {
  production: boolean;
  findings: ProviderBaseUrlFinding[];
  allowed: boolean;
}

export function evaluateProviderBaseUrls(env: Record<string, string | undefined> = process.env): ProviderBaseUrlVerdict {
  const production = pointsToProduction(env as NodeJS.ProcessEnv);
  const findings = production ? providerBaseUrlFindings(env) : [];
  return { production, findings, allowed: env[ALLOW_PROVIDER_BASE_URL_OVERRIDE_ENV] === 'true' };
}

/**
 * Validación de arranque (provider PROVIDER_BASE_URL_GUARD de AppModule: la API y TODOS los workers). Lanza si el
 * proceso es de producción y hay una override no oficial sin el escape explícito. Devuelve el env intacto.
 */
export function assertProviderBaseUrlsSafe<T extends Record<string, any>>(env: T, log: Pick<Console, 'error' | 'warn'> = console): T {
  const v = evaluateProviderBaseUrls(env as Record<string, string | undefined>);
  if (!v.findings.length) return env;
  const detail = v.findings.map((f) => `${f.env}→${f.target} (${f.why})`).join(', ');
  if (v.allowed) {
    log.warn(`[r58] ${ALLOW_PROVIDER_BASE_URL_OVERRIDE_ENV}=true: overrides de proveedor NO oficiales en producción aceptadas: ${detail}`);
    return env;
  }
  const message =
    `${PROVIDER_BASE_URL_OVERRIDE_IN_PRODUCTION}: el proceso apunta a producción y hay URLs base de proveedor que no son las oficiales: ${detail}. ` +
    `Quitar la variable (default = oficial) o, solo si es intencional, ${ALLOW_PROVIDER_BASE_URL_OVERRIDE_ENV}=true.`;
  log.error(`[r58] ${message}`);
  throw new Error(message);
}
