import { AsyncLocalStorage } from 'async_hooks';

/**
 * r71 (rendimiento) · Lecturas de UNA petición, sin viajes repetidos a la base.
 *
 * GET /prebrief arma «Cursia recomienda» + la propuesta: ~60 lecturas SECUENCIALES (el mismo perfil académico 6 veces, el
 * formato 5, los valores fijados 4…). Contra Postgres local son ~70 ms; contra el pooler remoto de Supabase cada viaje
 * cuesta ~150 ms y la pantalla esperaba 10–12 s. Dentro de un ámbito (`withRequestReadCache`):
 *   - una lectura (`select …`) por DataSource.query con el mismo SQL y parámetros se pide UNA vez y se reutiliza (cada
 *     llamador recibe su propia copia: nadie ve lo que otro modificó);
 *   - cualquier escritura (por DataSource.query o por un QueryRunner que escribió, al soltarse) vacía lo leído: nada
 *     viejo se reutiliza después de un cambio;
 *   - al empezar (y después de cada escritura) se piden EN PARALELO, con pocas conexiones, las lecturas que este mismo
 *     ámbito hizo la vez anterior y que solo dependen del curso y del usuario (lectura anticipada). Solo se usan si el
 *     código pide exactamente la misma consulta: el resultado es el mismo que habría leído un instante después.
 * Fuera de un ámbito (y en los QueryRunner) todo sigue igual. Sin dependencias, sin cambios de contrato.
 * CURSIA_READ_CACHE=off lo apaga (sin redeploy de código).
 */

type QueryFn = (sql: string, params?: unknown[], queryRunner?: unknown) => Promise<any>;

interface Scope {
  name: string;
  refs: { course: unknown; owner: unknown };
  cache: Map<string, Promise<unknown>>;
  prefetched: boolean;
  orig: QueryFn;
}

type ParamRef = { ref: 'course' | 'owner' } | { v: string | number | boolean | null };
interface Template { sql: string; params: ParamRef[] }

const als = new AsyncLocalStorage<Scope>();
/** Lecturas aprendidas por ámbito (proceso). Solo SQL fijo con parámetros curso / usuario / constantes simples. */
const templates = new Map<string, Map<string, Template>>();
const MAX_TEMPLATES_PER_SCOPE = 120;
/** Conexiones que usa la lectura anticipada (el pool de la API es chico: deja lugar a las demás peticiones). */
const PREFETCH_CONCURRENCY = 3;

const READ_RE = /^\s*select\b/i;
const NOT_CACHEABLE_RE = /\bfor\s+(update|share|no\s+key\s+update)\b|pg_advisory|nextval\s*\(|set_config\s*\(|pg_sleep|now\s*\(\s*\)|clock_timestamp|random\s*\(/i;
const INSTALLED = Symbol.for('cursia.requestReadCache');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const keyOf = (sql: string, params?: unknown[]) => `${sql}\u0000${JSON.stringify(params === undefined ? [] : params)}`;

/** Copia profunda de filas de pg (objetos, arreglos, fechas, Buffer). */
function copy<T>(x: T): T {
  if (x === null || typeof x !== 'object') return x;
  if (x instanceof Date) return new Date(x.getTime()) as any;
  if (Buffer.isBuffer(x)) return Buffer.from(x) as any;
  if (Array.isArray(x)) return x.map(copy) as any;
  const out: any = {};
  for (const k of Object.keys(x as any)) out[k] = copy((x as any)[k]);
  return out;
}

function invalidate(s: Scope) {
  s.cache.clear();
  s.prefetched = false;
}

function learn(s: Scope, sql: string, params?: unknown[]) {
  const ps: ParamRef[] = [];
  for (const p of params || []) {
    if (p !== null && p !== undefined && (p === s.refs.course || String(p) === String(s.refs.course)) && (typeof p === 'number' || typeof p === 'string')) ps.push({ ref: 'course' });
    else if (s.refs.owner && p === s.refs.owner) ps.push({ ref: 'owner' });
    else if (p === null || typeof p === 'boolean' || (typeof p === 'string' && p.length <= 40 && !UUID_RE.test(p))) ps.push({ v: p as any });
    else return; // depende de algo leído antes (ids, textos): no se anticipa
  }
  let m = templates.get(s.name);
  if (!m) { m = new Map(); templates.set(s.name, m); }
  const k = keyOf(sql, ps as any);
  if (!m.has(k) && m.size < MAX_TEMPLATES_PER_SCOPE) m.set(k, { sql, params: ps });
}

function prefetch(s: Scope) {
  s.prefetched = true;
  const m = templates.get(s.name);
  if (!m || !m.size) return;
  const queue: (() => void)[] = [];
  let active = 0;
  const next = () => { while (active < PREFETCH_CONCURRENCY && queue.length) { active++; queue.shift()!(); } };
  for (const t of m.values()) {
    const params = t.params.map((p) => ('ref' in p ? s.refs[p.ref] : p.v));
    const key = keyOf(t.sql, params);
    if (s.cache.has(key)) continue;
    const p = new Promise((resolve, reject) => {
      queue.push(() => { s.orig(t.sql, params).then(resolve, reject).finally(() => { active--; next(); }); });
    });
    p.catch(() => { if (s.cache.get(key) === p) s.cache.delete(key); }); // un error se repite al pedirla de verdad
    s.cache.set(key, p);
  }
  next();
}

const METADATA_SQL = 'select metadata from public.courses where id = $1';
const META_ONE = /metadata\s*->\s*'([A-Za-z0-9_]+)'\s+as\s+([A-Za-z_][A-Za-z0-9_]*)/g;
const META_RE = /^\s*select\s+(metadata\s*->\s*'[A-Za-z0-9_]+'\s+as\s+[A-Za-z_][A-Za-z0-9_]*\s*(,\s*metadata\s*->\s*'[A-Za-z0-9_]+'\s+as\s+[A-Za-z_][A-Za-z0-9_]*\s*)*)from\s+public\.courses\s+where\s+id\s*=\s*\$1\s*$/i;
/** [[clave, alias]…] si la consulta solo proyecta claves de courses.metadata por id; si no, null. */
export function metadataProjection(sql: string): [string, string][] | null {
  const m = META_RE.exec(sql);
  if (!m) return null;
  const out: [string, string][] = [];
  let x: RegExpExecArray | null;
  META_ONE.lastIndex = 0;
  while ((x = META_ONE.exec(m[1]))) out.push([x[1], x[2]]);
  return out.length ? out : null;
}

/** Instala el caché en el DataSource (idempotente). Sin un ámbito activo no cambia nada. */
export function installRequestReadCache(ds: any): void {
  if (!ds || ds[INSTALLED] || typeof ds.query !== 'function') return;
  const origQuery: QueryFn = ds.query.bind(ds);
  const origRunner = typeof ds.createQueryRunner === 'function' ? ds.createQueryRunner.bind(ds) : null;
  ds[INSTALLED] = { origQuery };
  ds.query = function (sql: string, params?: unknown[], queryRunner?: unknown) {
    const s = als.getStore();
    if (!s || queryRunner || typeof sql !== 'string') return origQuery(sql, params, queryRunner);
    if (!READ_RE.test(sql) || NOT_CACHEABLE_RE.test(sql)) {
      invalidate(s);
      return origQuery(sql, params).finally(() => invalidate(s));
    }
    if (!s.prefetched) prefetch(s);
    // `select metadata -> 'k' as a[, …] from public.courses where id = $1` (una clave por consulta, ~10 por petición): se
    // sirven de UNA lectura de courses.metadata (mismo valor: jsonb -> devuelve el subárbol tal cual, o null).
    const mk = metadataProjection(sql);
    if (mk && params && params.length === 1) {
      return ds.query(METADATA_SQL, params).then((rows: any[]) => rows.map((r) => {
        const md = r && r.metadata && typeof r.metadata === 'object' ? r.metadata : {};
        const out: any = {};
        for (const [k, a] of mk) out[a] = md[k] === undefined ? null : md[k];
        return out;
      }));
    }
    learn(s, sql, params);
    const key = keyOf(sql, params);
    let p = s.cache.get(key);
    if (!p) {
      p = origQuery(sql, params);
      const pp = p;
      pp.catch(() => { if (s.cache.get(key) === pp) s.cache.delete(key); });
      s.cache.set(key, p);
    }
    return p.then(copy);
  };
  if (origRunner) {
    ds.createQueryRunner = function (...a: unknown[]) {
      const qr = origRunner(...a);
      const s = als.getStore();
      if (!s || !qr || typeof qr.query !== 'function') return qr;
      // Un QueryRunner que escribió (o abrió una transacción) vacía lo leído al soltarse.
      let wrote = false;
      const q0 = qr.query.bind(qr);
      qr.query = (sql: string, ...rest: unknown[]) => { if (typeof sql !== 'string' || !READ_RE.test(sql) || NOT_CACHEABLE_RE.test(sql)) { wrote = true; invalidate(s); } return q0(sql, ...rest); };
      const st0 = typeof qr.startTransaction === 'function' ? qr.startTransaction.bind(qr) : null;
      if (st0) qr.startTransaction = (...x: unknown[]) => { wrote = true; return st0(...x); };
      const rel0 = qr.release.bind(qr);
      qr.release = (...x: unknown[]) => { if (wrote) invalidate(s); return rel0(...x); };
      return qr;
    };
  }
}

/** Corre `fn` con lecturas compartidas para (curso, usuario). Un ámbito anidado reutiliza el de afuera. */
export function withRequestReadCache<T>(ds: any, name: string, refs: { course: unknown; owner: unknown }, fn: () => Promise<T>): Promise<T> {
  // Interruptor (diagnóstico / emergencia): CURSIA_READ_CACHE=off vuelve al comportamiento de antes.
  if (String(process.env.CURSIA_READ_CACHE || '').toLowerCase() === 'off') return fn();
  installRequestReadCache(ds);
  const cur = als.getStore();
  const inst = ds && ds[INSTALLED];
  if (cur || !inst) return fn();
  return als.run({ name, refs, cache: new Map(), prefetched: false, orig: inst.origQuery }, fn);
}

/** Para pruebas: olvida lo aprendido. */
export function resetRequestReadCacheTemplates(): void {
  templates.clear();
}
