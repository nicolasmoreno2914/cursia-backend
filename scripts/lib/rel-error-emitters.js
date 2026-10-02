'use strict';

// ══════════════════════════════════════════════════════════════════════════
// REL R1 — inventario de los códigos de error que el backend (y, si se pasa su
// ruta, el ejecutor del navegador) EMITEN hoy. Lo usa
// scripts/check-rel-failure-classes.js para exigir que cada código emitido
// tenga una regla EXPLÍCITA en src/modules/reliability/failure-classifier.ts.
//
// Fuentes que se escanean:
//   1. Emisores de fallo de items (backend): `failItem(…, …, MSG`,
//      `failItemDetailed(…, …, MSG`, `applyItemFailure(qr, …, MSG`,
//      `fail(deps, item, MSG` (worker de proveedores), `failJob(…, …, …, MSG`
//      (empaque) y `blockItemForBudget` (presupuesto). MSG se resuelve:
//      literal / template / concatenación / ternario / constante del repo /
//      variable local (TODAS sus asignaciones en la función envolvente, ramas
//      incluidas; una sola no resoluble deja la variable sin resolver) / helper
//      conocido (FN_CODES). Lo que no se puede resolver tiene que figurar en
//      DYNAMIC_EMITTERS (con los códigos que puede producir) o el check falla:
//      un emisor nuevo nunca queda sin clasificar en silencio.
//   2. Códigos de validación (internos de `v3_payload_invalid`, de
//      `presentation_artifact_invalid`, del banco de examen…): literales
//      `code: 'X'` en los validadores que alimentan fallos de items.
//   3. Códigos del empaque (scope package): `new XError('CODE…` en los
//      builders/validadores del .mbz.
//   4. (Con --fe; obligatorio en CI con --require-fe) el ejecutor del navegador
//      (45-dynamic-generation-executor.js): cada `error:`/`msg:`, el 1er argumento de
//      todo helper `*fail*(` y el 3º de `backendDynFail(`; un literal (', ", `) da su
//      texto; cualquier otra expresión sale como `__expr__` y el check la exige en su
//      lista revisada (texto exacto) o falla.
// Puro (solo lee archivos).
// ══════════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.ts$/.test(p) && !/\.d\.ts$/.test(p) && !/\.spec\.ts$/.test(p)) out.push(p);
  }
  return out;
}

/** Quita comentarios // y /* *\/ conservando los saltos de línea (los números de línea siguen valiendo). */
function stripComments(src) {
  let out = '';
  let i = 0;
  let quote = null;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (quote) {
      out += c;
      if (c === '\\') { out += n ?? ''; i += 2; continue; }
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; out += c; i++; continue; }
    if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && n === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') out += '\n'; i++; }
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Lee los argumentos de una llamada a partir del índice del '(' (respeta paréntesis, llaves, corchetes y strings). */
function readArgs(src, openIdx) {
  const args = [];
  let depth = 0;
  let cur = '';
  let quote = null;
  let tplDepth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      cur += c;
      if (c === '\\') { cur += src[i + 1] ?? ''; i++; continue; }
      if (quote === '`' && c === '$' && src[i + 1] === '{') { tplDepth++; }
      if (quote === '`' && c === '}' && tplDepth > 0) { tplDepth--; continue; }
      if (c === quote && tplDepth === 0) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; cur += c; continue; }
    if (c === '(' || c === '{' || c === '[') {
      depth++;
      if (depth === 1 && c === '(') continue;
      cur += c;
      continue;
    }
    if (c === ')' || c === '}' || c === ']') {
      depth--;
      if (depth === 0) { if (cur.trim()) args.push(cur.trim()); return args; }
      cur += c;
      continue;
    }
    if (c === ',' && depth === 1) { args.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  return args;
}

const lineOf = (src, idx) => src.slice(0, idx).split('\n').length;

/** Constantes string del repo: `const NAME = 'x'` / `` `x` `` / 'a' + 'b' (primer operando). */
function collectConstants(files) {
  const map = new Map();
  const re = /(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*(?::\s*[A-Za-z<>\[\]| ]+)?=\s*\n?\s*(['"`])((?:\\.|(?!\2)[^\\])*)\2/g;
  for (const f of files) {
    const src = stripComments(fs.readFileSync(f, 'utf8'));
    let m;
    while ((m = re.exec(src))) if (!map.has(m[1])) map.set(m[1], m[3]);
  }
  return map;
}

/** Primer token de código de un texto: `code: …`, `code …`, `code` solo. */
function leadingToken(text) {
  const m = /^\s*([A-Za-z][A-Za-z0-9_]*)/.exec(text);
  return m ? m[1] : null;
}

// Helpers de mensajes cuyo primer token es un código fijo (verificado contra su cuerpo: `fnBodyMustMention`).
const FN_CODES = {
  notReady: { codes: ['provider_not_ready'], mention: 'PROVIDER_NOT_READY' },
  reconciliationMessage: { codes: ['provider_reconciliation_required'], mention: 'PROVIDER_RECONCILIATION_REQUIRED' },
  drainHandbackMessage: { codes: ['worker_draining'], mention: 'WORKER_DRAINING' },
  durationUnmeasurableMessage: { codes: ['video_duration_unmeasurable'], mention: 'VIDEO_DURATION_UNMEASURABLE' },
  durationUnmeasuredMessage: { codes: ['video_duration_unmeasured'], mention: 'VIDEO_DURATION_UNMEASURED' },
  v3ValidationErrorMessage: { codes: ['v3_payload_invalid'], mention: 'V3_PAYLOAD_INVALID' },
};

/**
 * Emisores con mensaje DINÁMICO que el resolvedor no puede leer: archivo (relativo a src/) +
 * expresión normalizada (sin espacios) → códigos que puede producir. Revisados a mano; si el
 * código cambia de forma, la expresión deja de coincidir y el check vuelve a fallar.
 */
const DYNAMIC_EMITTERS = {
  // Portada de Gamma: CoverError.code (pdf-cover.ts) o el default.
  'workers/provider-real/real-providers.ts#`${code}:${errinstanceofError?err.message:String(err)}`': ['GAMMA_COVER_RENDER_FAILED', 'GAMMA_COVER_RASTERIZER_UNAVAILABLE'],
  // AudioScriptError.message = `${code}: …` (audio-scripts.ts) o el default.
  'workers/provider-real/real-providers.ts#errinstanceofAudioScriptError?err.message:`AUDIO_WELCOME_TEXT_MISSING:course_intronoesJSON(${errinstanceofError?err.message:String(err)})`': ['AUDIO_WELCOME_TEXT_MISSING', 'AUDIOBOOK_CONTENT_EMPTY', 'AUDIOBOOK_SCRIPT_TOO_SHORT'],
  'workers/provider-real/real-providers.ts#err.message': ['AUDIO_WELCOME_TEXT_MISSING', 'AUDIOBOOK_CONTENT_EMPTY', 'AUDIOBOOK_SCRIPT_TOO_SHORT'],
  // blockYoutubeDelivery(state: 'blocked_auth' | 'blocked_quota'): quota sale antes por blockYoutubeQuota.
  'workers/dynamic-item-worker.ts#`youtube_${state}:${detail}`': ['youtube_blocked_auth'],
  // fail() del worker de proveedores reenvía el mensaje de SUS callers (que se escanean uno por uno).
  'workers/provider-real/real-providers.ts#message': [],
  // Endpoint del ejecutor del navegador: el texto lo arma el ejecutor (sección 4, --fe).
  'modules/dynamic-generation/executor.controller.ts#dto.error': [],
  // Empaque: errMessage(err) de cualquier builder/validador → familias de PACKAGE (sección 3 del escaneo).
  'workers/dynamic-package-worker.ts#message': ['PACKAGE_BUILDER_ERROR'],
  // prevalidateV3 (scheduler): pre.message = v3ValidationErrorMessage(…) o los códigos de contexto.
  'modules/dynamic-generation/scheduler.service.ts#pre.message': ['v3_payload_invalid'],
  // failItemDetailed(…, error, …) dentro de failItem (reenvío del mismo mensaje del caller).
  'modules/dynamic-generation/scheduler.service.ts#error': [],
  'modules/dynamic-generation/scheduler.service.ts#msg': ['unknown_error'],
  'modules/dynamic-generation/item-transitions.ts#LEASE_EXPIRED_ERROR': ['lease_expired'],
  // runtime guard de presupuesto (finops-worker-hooks.ts): msg = budget_exceeded / provider_reconciliation_required.
  'workers/finops-worker-hooks.ts#msg': ['budget_exceeded'],
};

/** Normaliza una expresión para la clave de DYNAMIC_EMITTERS. */
const norm = (s) => String(s).replace(/\s+/g, '');

function stripSlice(expr) {
  let e = expr.trim();
  for (;;) {
    const m = /^([\s\S]*?)\.slice\([^()]*\)$/.exec(e);
    if (m) { e = m[1].trim(); continue; }
    if (/^\(([\s\S]*)\)$/.test(e)) {
      const inner = e.slice(1, -1);
      if (readArgs('(' + inner + ')', 0).length === 1) { e = inner.trim(); continue; }
    }
    break;
  }
  return e;
}

/** Divide `a ? b : c` en el nivel superior (o null). */
function splitTernary(expr) {
  let depth = 0;
  let quote = null;
  let q = -1;
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
    if (quote) { if (c === '\\') { i++; continue; } if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (depth === 0 && c === '?' && expr[i + 1] !== '?' && expr[i + 1] !== '.' && q < 0) q = i;
    else if (depth === 0 && c === ':' && q >= 0) return [expr.slice(q + 1, i).trim(), expr.slice(i + 1).trim()];
  }
  return null;
}

/** Primer operando de `a + b + …` en el nivel superior. */
function firstConcatOperand(expr) {
  let depth = 0;
  let quote = null;
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
    if (quote) { if (c === '\\') { i++; continue; } if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (depth === 0 && c === '+') return expr.slice(0, i).trim();
  }
  return expr.trim();
}

/**
 * Inicio de la función que contiene `idx` (fix round 1, I2): la llave de apertura de la función
 * ENVOLVENTE MÁS EXTERNA (método de clase, `function`, arrow) — sobre-inclusivo a propósito: incluir de más
 * solo agrega asignaciones a revisar, nunca esconde una. Se calcula con la pila de llaves (saltando strings y
 * templates); los bloques de control (if/for/while/switch/try/catch/else) y el cuerpo de la clase no cuentan.
 */
function functionStartBefore(src, idx) {
  const stack = [];
  let i = 0;
  const tplStack = []; // profundidad de llaves al entrar a cada ${ … } de un template
  let quote = null;
  while (i < idx) {
    const c = src[i];
    if (quote) {
      if (c === '\\') { i += 2; continue; }
      if (quote === '`' && c === '$' && src[i + 1] === '{') { tplStack.push(stack.length); stack.push(-1); quote = null; i += 2; continue; }
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; i++; continue; }
    if (c === '{') stack.push(i);
    else if (c === '}') {
      stack.pop();
      if (tplStack.length && tplStack[tplStack.length - 1] === stack.length) { tplStack.pop(); quote = '`'; }
    }
    i++;
  }
  for (const pos of stack) {
    if (pos < 0) continue;
    const lineStart = src.lastIndexOf('\n', pos - 1) + 1;
    const header = src.slice(lineStart, pos);
    if (/\bclass\b/.test(header)) continue;
    if (/^\s*(?:\}\s*)?(?:if|for|while|switch|catch|else|try|do|finally)\b/.test(header) || /\b(?:if|for|while|switch|catch)\s*\(/.test(header)) continue;
    if (/=>\s*$|\bfunction\b|\)\s*(?::\s*[^{}()=;]+)?\s*$/.test(header)) return lineStart;
  }
  return 0;
}

/**
 * Resuelve una expresión de mensaje a códigos. Devuelve { codes: string[] } o { unresolved: true }.
 * ctx = { src, idx, consts, file }.
 */
function resolveExpr(expr, ctx, depthGuard = 0) {
  if (depthGuard > 6) return { unresolved: true };
  let e = stripSlice(expr);
  const tern = splitTernary(e);
  if (tern) {
    const a = resolveExpr(tern[0], ctx, depthGuard + 1);
    const b = resolveExpr(tern[1], ctx, depthGuard + 1);
    if (a.unresolved || b.unresolved) return { unresolved: true };
    return { codes: [...a.codes, ...b.codes] };
  }
  e = firstConcatOperand(e);
  e = stripSlice(e);
  const lit = /^(['"])((?:\\.|(?!\1)[^\\])*)\1$/.exec(e);
  if (lit) { const t = leadingToken(lit[2]); return t ? { codes: [t] } : { unresolved: true }; }
  if (e.startsWith('`')) {
    const body = e.slice(1, -1);
    const lead = /^\$\{\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\}/.exec(body);
    if (lead) {
      const v = ctx.consts.get(lead[1]);
      if (v !== undefined) { const t = leadingToken(v); return t ? { codes: [t] } : { unresolved: true }; }
      return { unresolved: true };
    }
    if (body.startsWith('${')) return { unresolved: true };
    const t = leadingToken(body);
    return t ? { codes: [t] } : { unresolved: true };
  }
  const call = /^([A-Za-z_][A-Za-z0-9_]*)\(/.exec(e);
  if (call) {
    const fc = FN_CODES[call[1]];
    return fc ? { codes: [...fc.codes] } : { unresolved: true };
  }
  if (/^[A-Z][A-Z0-9_]*$/.test(e) && ctx.consts.has(e)) {
    const v = ctx.consts.get(e);
    if (v.startsWith('${')) return resolveExpr('`' + v + '`', ctx, depthGuard + 1);
    const t = leadingToken(v);
    return t ? { codes: [t] } : { unresolved: true };
  }
  if (/^[a-z][A-Za-z0-9_]*$/.test(e)) {
    // Variable local (fix round 1, I2): TODAS las asignaciones `const|let|var e = …` / `e = …` entre el inicio
    // de la función que contiene la llamada y la llamada (ramas if/else/switch incluidas). Se unen los códigos de
    // todas; si ALGUNA no se puede resolver, la variable entera queda sin resolver (el gate falla).
    const region = ctx.src.slice(functionStartBefore(ctx.src, ctx.idx), ctx.idx);
    const re = new RegExp(`(?:^|[^.\\w])${e}\\s*(?::\\s*[A-Za-z<>\\[\\]| ]+?\\s*)?=(?![=>])\\s*`, 'g');
    let m;
    const codes = [];
    let found = 0;
    while ((m = re.exec(region))) {
      found++;
      const rest = region.slice(m.index + m[0].length);
      // Hasta el ';' (o fin de línea sin continuación) de nivel superior.
      let depth = 0; let quote = null; let end = rest.length;
      for (let i = 0; i < rest.length; i++) {
        const c = rest[i];
        if (quote) { if (c === '\\') { i++; continue; } if (c === quote) quote = null; continue; }
        if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
        if ('([{'.includes(c)) depth++;
        else if (')]}'.includes(c)) { if (depth === 0) { end = i; break; } depth--; }
        else if (depth === 0 && c === ';') { end = i; break; }
      }
      const r = resolveExpr(rest.slice(0, end), ctx, depthGuard + 1);
      if (r.unresolved) return { unresolved: true };
      codes.push(...r.codes);
    }
    if (found > 0) return { codes: [...new Set(codes)] };
  }
  return { unresolved: true };
}

/** Emisores de fallo de items del backend. */
const EMITTER_PATTERNS = [
  { re: /\.failItem\(/g, msgArg: 2 },
  { re: /(?<![\w.])failItemDetailed\(|\.failItemDetailed\(/g, msgArg: 2 },
  { re: /(?<![\w.])applyItemFailure\(/g, msgArg: 2 },
  { re: /(?<![\w.])fail\(\s*deps\s*,/g, msgArg: 2 },
  { re: /(?<![\w.])failJob\(/g, msgArg: 3 },
];

function isDefinition(src, idx) {
  const lineStart = src.lastIndexOf('\n', idx) + 1;
  const prefix = src.slice(lineStart, idx);
  return /\b(function|async)\s*$/.test(prefix) || /^\s*(async\s+)?$/.test(prefix) && /^\s*(async\s+)?[A-Za-z]+\($/.test(src.slice(lineStart, idx + 1)) && /\)\s*:\s*Promise/.test(src.slice(idx, idx + 600));
}

/** Escanea src/ del backend. Devuelve { emitters: [{file,line,expr,codes|null}], fnMentions: [{fn, ok}] }. */
function scanBackendEmitters(repoRoot) {
  const srcRoot = path.join(repoRoot, 'src');
  const files = walk(srcRoot);
  const consts = collectConstants(files);
  const emitters = [];
  for (const f of files) {
    const rel = path.relative(srcRoot, f).split(path.sep).join('/');
    if (rel.startsWith('modules/reliability/')) continue;
    const src = stripComments(fs.readFileSync(f, 'utf8'));
    for (const p of EMITTER_PATTERNS) {
      p.re.lastIndex = 0;
      let m;
      while ((m = p.re.exec(src))) {
        const open = m.index + m[0].lastIndexOf('(');
        if (isDefinition(src, m.index + (m[0].startsWith('.') ? 1 : 0))) continue;
        const args = readArgs(src, open);
        if (args.length <= p.msgArg) continue;
        // Firma de un método (parámetros tipados), no una llamada.
        if (args.some((a) => /^[A-Za-z_]+\??\s*:\s*[A-Za-z{]/.test(a) && !/^['"`]/.test(a))) continue;
        const expr = args[p.msgArg];
        const key = `${rel}#${norm(stripSlice(expr))}`;
        let codes = null;
        if (Object.prototype.hasOwnProperty.call(DYNAMIC_EMITTERS, key)) codes = DYNAMIC_EMITTERS[key];
        else {
          const r = resolveExpr(expr, { src, idx: m.index, consts, file: rel });
          if (!r.unresolved) codes = r.codes;
        }
        emitters.push({ file: rel, line: lineOf(src, m.index), expr: norm(stripSlice(expr)), key, codes });
      }
    }
    // Runtime guard de presupuesto: blockItemForBudget → budget_exceeded (scheduler lo antepone siempre).
    if (/\bblockItemForBudget\(/.test(src) && rel === 'modules/dynamic-generation/scheduler.service.ts') {
      emitters.push({ file: rel, line: 0, expr: 'blockItemForBudget', key: `${rel}#blockItemForBudget`, codes: ['budget_exceeded'] });
    }
  }
  // Cada helper de FN_CODES debe mencionar su constante en el cuerpo (si no, FN_CODES miente).
  const fnMentions = [];
  const all = files.map((f) => stripComments(fs.readFileSync(f, 'utf8'))).join('\n');
  for (const [fn, spec] of Object.entries(FN_CODES)) {
    const re = new RegExp(`function\\s+${fn}\\s*\\([^)]*\\)[^{]*\\{([\\s\\S]{0,600})`);
    const m = re.exec(all);
    fnMentions.push({ fn, ok: !!m && m[1].includes(spec.mention) });
  }
  return { emitters, fnMentions, constants: consts };
}

/** Archivos de validadores cuyos `code: 'X'` terminan como códigos de fallo de items. */
const VALIDATION_CODE_FILES = [
  'modules/course-shell/v3-validation.ts',
  'modules/course-shell/intro-schemas.ts',
  'modules/course-shell/final-exam.ts',
  'modules/course-shell/activity-type.ts',
  'modules/visual-components/validate.ts',
  'modules/visual-components/pedagogy.ts',
  'package/h5p/types/branching-scenario.ts',
  'package/v3/exam-validator-v3.ts',
];

function scanValidationCodes(repoRoot) {
  const out = new Map();
  for (const rel of VALIDATION_CODE_FILES) {
    const f = path.join(repoRoot, 'src', rel);
    if (!fs.existsSync(f)) { out.set(`__missing_file__:${rel}`, rel); continue; }
    const src = stripComments(fs.readFileSync(f, 'utf8'));
    const re = /\bcode\s*:\s*'([A-Z][A-Z0-9_]+)'/g;
    let m;
    while ((m = re.exec(src))) if (!out.has(m[1])) out.set(m[1], rel);
    // Helpers de error del banco de examen: err('EXAM_BANK_…' / issue('…' / push({ code: …
    const re2 = /\b(?:err|issue|fail|bad|e)\(\s*'([A-Z][A-Z0-9_]{3,})'/g;
    while ((m = re2.exec(src))) if (!out.has(m[1])) out.set(m[1], rel);
  }
  return out;
}

/** Códigos de error del empaque (`new XError('CODE…` / `new XError(\`CODE: …`) en builders y validadores del .mbz. */
const PACKAGE_CODE_DIRS = ['package', 'modules/dynamic-packaging', 'modules/course-shell', 'modules/visual-components'];

function scanPackageCodes(repoRoot) {
  const out = new Map();
  for (const d of PACKAGE_CODE_DIRS) {
    for (const f of walk(path.join(repoRoot, 'src', d))) {
      const rel = path.relative(path.join(repoRoot, 'src'), f).split(path.sep).join('/');
      const src = stripComments(fs.readFileSync(f, 'utf8'));
      const re = /new\s+[A-Za-z]*Error\(\s*['"`]([A-Z][A-Z0-9]*_[A-Z0-9_]+)\b/g;
      let m;
      while ((m = re.exec(src))) if (!out.has(m[1])) out.set(m[1], rel);
    }
  }
  return out;
}

/**
 * Valor de una propiedad/argumento a partir de `from` hasta el `,` / `}` / `)` de nivel superior.
 */
function readValue(src, from) {
  let depth = 0; let quote = null; let tpl = 0;
  for (let i = from; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === '\\') { i++; continue; }
      if (quote === '`' && c === '$' && src[i + 1] === '{') { tpl++; i++; continue; }
      if (quote === '`' && c === '}' && tpl > 0) { tpl--; continue; }
      if (c === quote && tpl === 0) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) { if (depth === 0) return src.slice(from, i).trim(); depth--; }
    else if (depth === 0 && (c === ',' || c === ';')) return src.slice(from, i).trim();
  }
  return src.slice(from).trim();
}

/**
 * Texto inicial LITERAL de una expresión de mensaje del navegador, o null si no empieza con un literal:
 * '…' / "…" / `…` (hasta el primer ${…}), y `'a' + x` (primer operando literal).
 */
function literalLead(expr) {
  const e = firstConcatOperand(stripSlice(expr));
  let m = /^(['"])((?:\\.|(?!\1)[^\\])*)\1$/.exec(e);
  if (m) return m[2];
  m = /^`((?:\\.|[^`\\$]|\$(?!\{))*)/.exec(e);
  if (m && e.endsWith('`')) return m[1];
  return null;
}

/**
 * Ejecutor del navegador (solo lectura): mensajes de fallo y errorCode (fix round 1, I3). Cada valor de
 * `error:`, el 1er argumento de `fail(` y el 3º de `backendDynFail(` es o un LITERAL (comillas simples,
 * dobles o backtick: se devuelve su texto inicial) o una EXPRESIÓN (`__expr__ …`), que el check exige
 * cubrir con FE_EXPR_SAMPLES (si no, el gate falla). Definiciones (`function fail(`) se saltean.
 */
function scanFrontendExecutor(file) {
  const src = stripComments(fs.readFileSync(file, 'utf8'));
  const out = [];
  const push = (idx, value) => {
    if (!value) return;
    const lead = literalLead(value);
    out.push({ line: lineOf(src, idx), text: lead !== null ? lead : `__expr__ ${value.replace(/\s+/g, ' ').slice(0, 200)}` });
  };
  let m;
  // `error:` (resultado {ok:false}) y `msg:` (excepciones que _dynMapApiError convierte en el error del item).
  const reErr = /\b(?:error|msg)\s*:\s*/g;
  while ((m = reErr.exec(src))) push(m.index, readValue(src, m.index + m[0].length));
  // Cualquier helper de fallo (`fail(`, `failWithDraft(`, `_dynFail(`…): 1er argumento; `backendDynFail(`: 3º.
  const reFail = /(?<![\w.$])([A-Za-z_$][\w$]*)\(/g;
  while ((m = reFail.exec(src))) {
    const name = m[1];
    if (!/fail/i.test(name) || /^(?:failed|failures?)$/i.test(name)) continue;
    const pre = src.slice(Math.max(0, m.index - 12), m.index);
    if (/function\s*$/.test(pre)) continue;
    const args = readArgs(src, m.index + m[0].length - 1);
    const at = name === 'backendDynFail' ? 2 : 0;
    if (args.length > at) push(m.index, args[at]);
  }
  const reCode = /\berrorCode\s*:\s*(['"`])([A-Za-z0-9_]+)\1/g;
  while ((m = reCode.exec(src))) out.push({ line: lineOf(src, m.index), text: `__errorCode__ ${m[2]}` });
  const reCodeExpr = /\berrorCode\s*:\s*(?!['"`])([^,}\n]+)/g;
  while ((m = reCodeExpr.exec(src))) out.push({ line: lineOf(src, m.index), text: `__expr__ errorCode:${m[1].trim()}` });
  return out;
}

/** api() del navegador (04-api.js): mensajes `msg: '…'` que el ejecutor reenvía como error del item. */
function scanFrontendApi(file) {
  const src = stripComments(fs.readFileSync(file, 'utf8'));
  const out = [];
  const re = /\bmsg\s*:\s*(['"])((?:\\.|(?!\1)[^\\])*)\1/g;
  let m;
  while ((m = re.exec(src))) {
    // Escapes \uXXXX del archivo → texto real (el mensaje que ve el clasificador).
    const text = m[2].replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
    out.push({ line: lineOf(src, m.index), text });
  }
  return out;
}

module.exports = {
  scanFrontendApi,
  literalLead,
  functionStartBefore,
  stripComments,
  readArgs,
  resolveExpr,
  scanBackendEmitters,
  scanValidationCodes,
  scanPackageCodes,
  scanFrontendExecutor,
  FN_CODES,
  DYNAMIC_EMITTERS,
  VALIDATION_CODE_FILES,
};
