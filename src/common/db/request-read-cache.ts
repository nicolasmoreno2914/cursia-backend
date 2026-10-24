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
 *   - la PRIMERA lectura del ámbito (y la primera después de cada escritura) viaja junto con las lecturas que este mismo
 *     ámbito hizo la vez anterior y que solo dependen del curso y del usuario (lectura anticipada), en UN solo viaje y por
 *     la MISMA conexión que esa lectura iba a usar (consultas de solo lectura encadenadas en una consulta simple). Solo se
 *     usan si el código pide exactamente la misma consulta: el resultado es el mismo que habría leído un instante después.
 *     r71 fix (incidente de producción): antes la anticipada abría hasta 3 conexiones EXTRA en paralelo por petición; con
 *     pool 5 por proceso el pooler de Supabase (modo sesión) rechazaba los clientes de más al instante y la petición (y
 *     las vecinas, p. ej. GET /modules) daba 500. Ahora una petición con caché nunca usa más conexiones a la vez que sin
 *     caché: la anticipada no pide conexión propia, y si el viaje combinado falla se lee lo pedido solo, como siempre.
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
  /** createQueryRunner del DataSource SIN el envoltorio (la lectura anticipada usa la conexión de la lectura que la dispara). */
  runner: (() => any) | null;
}

type ParamRef = { ref: 'course' | 'owner' } | { v: string | number | boolean | null };
interface Template { sql: string; params: ParamRef[] }

const als = new AsyncLocalStorage<Scope>();
/** Lecturas aprendidas por ámbito (proceso). Solo SQL fijo con parámetros curso / usuario / constantes simples. */
const templates = new Map<string, Map<string, Template>>();
const MAX_TEMPLATES_PER_SCOPE = 120;
/** Tope de lecturas anticipadas en un mismo viaje (el viaje es uno solo; esto acota el tamaño de la respuesta). */
const MAX_BATCH = 60;

const READ_RE = /^\s*select\b/i;
const NOT_CACHEABLE_RE = /\bfor\s+(update|share|no\s+key\s+update)\b|pg_advisory|nextval\s*\(|set_config\s*\(|pg_sleep|now\s*\(\s*\)|clock_timestamp|random\s*\(/i;
const INSTALLED = Symbol.for('cursia.requestReadCache');
const MISS = Symbol('cursia.requestReadCache.miss');
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

/** Valor de un parámetro como literal SQL, igual que lo manda pg como texto (null / booleano / número / texto corto). */
function literal(v: unknown): string | null {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'boolean') return v ? "'true'" : "'false'";
  if (typeof v === 'number') return Number.isFinite(v) ? `'${String(v)}'` : null;
  if (typeof v === 'string') {
    if (v.includes('\u0000')) return null;
    const body = v.replace(/'/g, "''");
    return v.includes('\\') ? ` E'${body.replace(/\\/g, '\\\\')}'` : `'${body}'`;
  }
  return null;
}

/**
 * `sql` con $1…$n reemplazados por literales, o null si no es seguro (strings E'…', dollar quoting, `;`, un $n sin
 * valor o un valor que no es simple). Recorre el texto respetando literales, identificadores y comentarios.
 */
export function inlineParams(sql: string, params: unknown[]): string | null {
  let out = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    if (c === "'") {
      if (i > 0 && /[eEuUbBxXnN]/.test(sql[i - 1]) && (i < 2 || !/[A-Za-z0-9_]/.test(sql[i - 2]))) return null;
      let j = i + 1;
      for (;;) {
        if (j >= n) return null;
        if (sql[j] === "'") { if (sql[j + 1] === "'") { j += 2; continue; } break; }
        j++;
      }
      out += sql.slice(i, j + 1); i = j + 1; continue;
    }
    if (c === '"') { const j = sql.indexOf('"', i + 1); if (j < 0) return null; out += sql.slice(i, j + 1); i = j + 1; continue; }
    if (c === '-' && sql[i + 1] === '-') { const j = sql.indexOf('\n', i); const e = j < 0 ? n : j; out += sql.slice(i, e); i = e; continue; }
    if (c === '/' && sql[i + 1] === '*') { const j = sql.indexOf('*/', i + 2); if (j < 0 || sql.slice(i + 2, j).includes('/*')) return null; out += sql.slice(i, j + 2); i = j + 2; continue; }
    if (c === ';' || c === '\\') return null;
    if (c === '$') {
      const m = /^\$(\d+)(?![A-Za-z0-9_$])/.exec(sql.slice(i, i + 12));
      if (!m || (i > 0 && /[A-Za-z0-9_]/.test(sql[i - 1]))) return null; // dollar quoting o identificador con $
      const k = Number(m[1]);
      if (k < 1 || k > params.length) return null;
      const l = literal(params[k - 1]);
      if (l === null) return null;
      out += l; i += m[0].length; continue;
    }
    out += c; i++;
  }
  return out;
}

/**
 * La lectura `sql`/`params` que pide el código, más las anticipadas, en UN viaje por UNA conexión (la que esta lectura iba
 * a usar). Si no hay nada que anticipar o no se puede combinar, la lectura va sola (como sin caché). Si el viaje combinado
 * falla, se olvida lo aprendido (se vuelve a aprender) y la lectura se repite sola: el error de una anticipada nunca llega
 * al código.
 */
function readWithPrefetch(s: Scope, sql: string, params: unknown[] | undefined, key: string): Promise<unknown> {
  s.prefetched = true;
  const m = templates.get(s.name);
  const main = inlineParams(sql, params || []);
  const extra: { key: string; text: string }[] = [];
  if (m && m.size && main !== null && s.runner) {
    const seen = new Set([key]);
    for (const t of m.values()) {
      if (extra.length >= MAX_BATCH) break;
      const ps = t.params.map((p) => ('ref' in p ? s.refs[p.ref] : p.v));
      const k = keyOf(t.sql, ps);
      if (seen.has(k) || s.cache.has(k)) continue;
      const text = inlineParams(t.sql, ps);
      if (text === null) continue;
      seen.add(k);
      extra.push({ key: k, text });
    }
  }
  if (!extra.length) return s.orig(sql, params);
  const runner = s.runner!;
  const batch = (async () => {
    const qr = runner();
    try {
      const conn = await qr.connect();
      const raw = await conn.query([main, ...extra.map((e) => e.text)].join('\n;\n'));
      const results = Array.isArray(raw) ? raw : [raw];
      if (results.length !== extra.length + 1 || results.some((r: any) => !r || !Array.isArray(r.rows))) throw new Error('lectura combinada: resultados inesperados');
      return results.map((r: any) => r.rows);
    } finally {
      await qr.release();
    }
  })();
  const fallback = () => { templates.delete(s.name); return s.orig(sql, params); };
  // Una anticipada que no llegó se marca MISS (no un error): quien la pida la lee sola en ese momento.
  extra.forEach((e, i) => { s.cache.set(e.key, batch.then((rows) => rows[i + 1], () => MISS)); });
  // Solo después de soltar la conexión del viaje combinado (o de repetir la lectura sola): nunca dos a la vez.
  return batch.then((rows) => rows[0], fallback);
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
  ds[INSTALLED] = { origQuery, origRunner };
  ds.query = function (sql: string, params?: unknown[], queryRunner?: unknown) {
    const s = als.getStore();
    if (!s || queryRunner || typeof sql !== 'string') return origQuery(sql, params, queryRunner);
    if (!READ_RE.test(sql) || NOT_CACHEABLE_RE.test(sql)) {
      invalidate(s);
      return origQuery(sql, params).finally(() => invalidate(s));
    }
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
    const key = keyOf(sql, params);
    const hit = s.cache.get(key);
    if (hit) {
      return hit.then((r) => {
        if (r !== MISS) return copy(r);
        if (s.cache.get(key) === hit) s.cache.delete(key);
        return ds.query(sql, params);
      });
    }
    // La primera lectura del ámbito (o después de escribir) lleva consigo las anticipadas, por su misma conexión.
    const p = s.prefetched ? origQuery(sql, params) : readWithPrefetch(s, sql, params, key);
    p.then(() => learn(s, sql, params), () => { if (s.cache.get(key) === p) s.cache.delete(key); }); // solo se aprende lo que funcionó
    s.cache.set(key, p);
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
  return als.run({ name, refs, cache: new Map(), prefetched: false, orig: inst.origQuery, runner: inst.origRunner }, fn);
}

/** Para pruebas: olvida lo aprendido. */
export function resetRequestReadCacheTemplates(): void {
  templates.clear();
}
