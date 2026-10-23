// ════ Fase 6 (R2) — Context Package + plan de conceptos del curso (puro) ════
// Spec: docs/superpowers/specs/2026-09-25-cursia-v2-rules-v2-and-context-package-design.md §3–§4.
//
// Reglas duras:
//   - TODO en este archivo es puro: sin DOM, sin `window`, sin D/F/SEL, sin
//     red, sin reloj, sin Math.random. Corre igual en el navegador y en un
//     `vm` de Node (harness).
//   - El paquete se DERIVA de inputs congelados por run (courseContext,
//     orden del Manifest por UUID, artifact course_plan del run): mismos
//     inputs → mismo paquete → mismo sha256 (canonicalJson). Nunca va dentro
//     del Manifest (Ruling B) — tiene su propia versión (contextPackageVersion).
//   - Validación estricta del plan: nunca se acepta un plan parcial.
//
// Forma de `manifest` que recibe dynBuildContextPackage (ver
// dynPackageManifestFromClaim, que la arma desde el ClaimedItem):
//   { course: { title, objective },
//     modules: [ { id, title, objective,
//                  chapters: [ { id, title, objective } ] } ] }   // en ORDEN del Manifest

var DYN_CONTEXT_PACKAGE_VERSION = 1;
var DYN_ACCUMULATED_CONCEPTS_CAP = 40;

// Límites del plan (plan R2 ítem 1): ≤12 conceptos, summary ≤ 400 chars.
var DYN_PLAN_LIMITS = {
  summaryMax: 400,
  listMax: 12,
  itemMax: 120
};

// Límites del sidecar context_summary (resumen REAL del capítulo generado).
var DYN_CONTEXT_SUMMARY_LIMITS = {
  summaryMax: 800,
  conceptsMax: 12,
  keyTermsMax: 15,
  itemMax: 120
};

// ── canonicalJson: claves ordenadas, sin espacios, determinístico ──
// Rechaza (throw) valores no representables de forma estable: undefined
// dentro de arrays, funciones, NaN/Infinity. Claves con valor undefined en
// objetos se omiten (igual que JSON.stringify).
function dynCanonicalJson(value) {
  if (value === null) return 'null';
  var t = typeof value;
  if (t === 'string' || t === 'boolean') return JSON.stringify(value);
  if (t === 'number') {
    if (!isFinite(value)) throw new Error('dynCanonicalJson: número no finito');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(function (v) {
      if (v === undefined || typeof v === 'function') throw new Error('dynCanonicalJson: valor no serializable en array');
      return dynCanonicalJson(v);
    }).join(',') + ']';
  }
  if (t === 'object') {
    var keys = Object.keys(value).filter(function (k) { return value[k] !== undefined; }).sort();
    return '{' + keys.map(function (k) {
      if (typeof value[k] === 'function') throw new Error('dynCanonicalJson: función en clave ' + k);
      return JSON.stringify(k) + ':' + dynCanonicalJson(value[k]);
    }).join(',') + '}';
  }
  throw new Error('dynCanonicalJson: tipo no soportado ' + t);
}

// ── SHA-256 puro (UTF-8), síncrono ──
// Implementación propia (FIPS 180-4) para que el paquete sea derivable de
// forma síncrona y sin depender de SubtleCrypto (no disponible en todo vm /
// contexto no seguro). El harness la verifica contra node:crypto.
function _dynUtf8Bytes(str) {
  var out = [];
  for (var i = 0; i < str.length; i++) {
    var c = str.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
      var c2 = str.charCodeAt(i + 1);
      if (c2 >= 0xdc00 && c2 <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
        i++;
      } else {
        c = 0xfffd;
      }
    } else if (c >= 0xd800 && c <= 0xdfff) {
      c = 0xfffd;
    }
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return out;
}

var _DYN_SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
];

function dynSha256Hex(str) {
  var bytes = _dynUtf8Bytes(String(str));
  var bitLenHi = Math.floor((bytes.length * 8) / 0x100000000);
  var bitLenLo = (bytes.length * 8) >>> 0;
  bytes.push(0x80);
  while ((bytes.length % 64) !== 56) bytes.push(0);
  bytes.push((bitLenHi >>> 24) & 255, (bitLenHi >>> 16) & 255, (bitLenHi >>> 8) & 255, bitLenHi & 255);
  bytes.push((bitLenLo >>> 24) & 255, (bitLenLo >>> 16) & 255, (bitLenLo >>> 8) & 255, bitLenLo & 255);

  var h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  var w = new Array(64);
  for (var off = 0; off < bytes.length; off += 64) {
    for (var i = 0; i < 16; i++) {
      w[i] = ((bytes[off + i * 4] << 24) | (bytes[off + i * 4 + 1] << 16) | (bytes[off + i * 4 + 2] << 8) | bytes[off + i * 4 + 3]) >>> 0;
    }
    for (i = 16; i < 64; i++) {
      var x = w[i - 15], y = w[i - 2];
      var s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      var s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    var a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
    for (i = 0; i < 64; i++) {
      var S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      var ch = (e & f) ^ (~e & g);
      var t1 = (hh + S1 + ch + _DYN_SHA256_K[i] + w[i]) >>> 0;
      var S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      var maj = (a & b) ^ (a & c) ^ (b & c);
      var t2 = (S0 + maj) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
  }
  return h.map(function (v) { return ('00000000' + v.toString(16)).slice(-8); }).join('');
}

// ════ Plan de conceptos del curso (course_plan) ════
// Forma: { chapters: { <chapterUuid>: { summary, concepts_introduced[],
//          concepts_assumed[], key_terms[] } },
//          modules:  { <moduleUuid>: { summary } } }
// Estricto: TODOS los UUID del outline presentes, NINGUNO extra, arrays de
// strings no vacíos, tamaños acotados. Devuelve {ok, errors[]} — nunca
// "arregla" ni completa en silencio.
function _dynIsNonEmptyString(v) { return typeof v === 'string' && v.trim().length > 0; }

function _dynCheckStringList(errors, where, v, maxItems, maxLen, allowEmpty) {
  if (!Array.isArray(v)) { errors.push(where + ': debe ser un array de strings'); return; }
  if (!allowEmpty && v.length === 0) errors.push(where + ': no puede estar vacío');
  if (v.length > maxItems) errors.push(where + ': máximo ' + maxItems + ' elementos (tiene ' + v.length + ')');
  for (var i = 0; i < v.length; i++) {
    if (!_dynIsNonEmptyString(v[i])) { errors.push(where + '[' + i + ']: debe ser un string no vacío'); continue; }
    if (v[i].length > maxLen) errors.push(where + '[' + i + ']: máximo ' + maxLen + ' caracteres');
  }
}

function dynValidateCoursePlan(plan, outline) {
  var errors = [];
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
    return { ok: false, errors: ['el plan debe ser un objeto JSON'] };
  }
  if (!plan.chapters || typeof plan.chapters !== 'object' || Array.isArray(plan.chapters)) errors.push('falta el objeto "chapters"');
  if (!plan.modules || typeof plan.modules !== 'object' || Array.isArray(plan.modules)) errors.push('falta el objeto "modules"');
  if (errors.length) return { ok: false, errors: errors };
  var L = DYN_PLAN_LIMITS;
  var expectedCh = {};
  var expectedMod = {};
  var practiceCh = {};
  (outline || []).forEach(function (mo) {
    expectedMod[mo.id] = true;
    (mo.chapters || []).forEach(function (c) { expectedCh[c.id] = true; if (c.kind === 'practice') practiceCh[c.id] = true; });
  });
  if (!Object.keys(expectedCh).length) errors.push('el outline no tiene capítulos');
  Object.keys(expectedMod).forEach(function (id) {
    var m = plan.modules[id];
    if (!m || typeof m !== 'object') { errors.push('falta el módulo ' + id); return; }
    if (!_dynIsNonEmptyString(m.summary)) errors.push('modules.' + id + '.summary: string no vacío requerido');
    else if (m.summary.length > L.summaryMax) errors.push('modules.' + id + '.summary: máximo ' + L.summaryMax + ' caracteres');
  });
  Object.keys(plan.modules).forEach(function (id) {
    if (!expectedMod[id]) errors.push('módulo desconocido en el plan: ' + id);
  });
  Object.keys(expectedCh).forEach(function (id) {
    var c = plan.chapters[id];
    if (!c || typeof c !== 'object') { errors.push('falta el capítulo ' + id); return; }
    var w = 'chapters.' + id;
    if (!_dynIsNonEmptyString(c.summary)) errors.push(w + '.summary: string no vacío requerido');
    else if (c.summary.length > L.summaryMax) errors.push(w + '.summary: máximo ' + L.summaryMax + ' caracteres');
    // Motor de carga horaria: un capítulo de práctica no introduce conceptos nuevos (lista vacía admitida).
    _dynCheckStringList(errors, w + '.concepts_introduced', c.concepts_introduced, L.listMax, L.itemMax, !!practiceCh[id]);
    _dynCheckStringList(errors, w + '.concepts_assumed', c.concepts_assumed, L.listMax, L.itemMax, true);
    _dynCheckStringList(errors, w + '.key_terms', c.key_terms, L.listMax, L.itemMax, false);
  });
  Object.keys(plan.chapters).forEach(function (id) {
    if (!expectedCh[id]) errors.push('capítulo desconocido en el plan: ' + id);
  });
  return { ok: errors.length === 0, errors: errors };
}

// Quita un fence ```json … ``` envolvente si el modelo lo agregó.
function _dynStripJsonFence(raw) {
  return String(raw == null ? '' : raw).trim().replace(/^```[a-zA-Z_ ]*\n?/, '').replace(/\n?```\s*$/, '').trim();
}

// Parsea + valida. Devuelve {ok, plan?, errors[]}. Solo se quedan las claves
// conocidas (chapters/modules y sus campos) para que el artifact congelado
// no arrastre texto extra del modelo.
function dynParseCoursePlan(raw, outline) {
  var obj;
  try {
    obj = JSON.parse(_dynStripJsonFence(raw));
  } catch (e) {
    return { ok: false, errors: ['JSON inválido: ' + ((e && e.message) || String(e))] };
  }
  var v = dynValidateCoursePlan(obj, outline);
  if (!v.ok) return { ok: false, errors: v.errors };
  var plan = { chapters: {}, modules: {} };
  (outline || []).forEach(function (mo) {
    plan.modules[mo.id] = { summary: obj.modules[mo.id].summary.trim() };
    (mo.chapters || []).forEach(function (c) {
      var pc = obj.chapters[c.id];
      plan.chapters[c.id] = {
        summary: pc.summary.trim(),
        concepts_introduced: pc.concepts_introduced.map(function (s) { return s.trim(); }),
        concepts_assumed: pc.concepts_assumed.map(function (s) { return s.trim(); }),
        key_terms: pc.key_terms.map(function (s) { return s.trim(); })
      };
    });
  });
  return { ok: true, plan: plan, errors: [] };
}

// ════ Manifest para el paquete, desde el ClaimedItem ════
// Orden: blueprint.outline (orden del Manifest, armado por el scheduler desde
// el snapshot congelado). Objetivos: `objective` del outline si el backend lo
// incluye (contrato v2 esperado); si la clave no viene, se toma del bloque
// module/chapter/moduleChapters del mismo claim (mismo snapshot congelado) y,
// si tampoco está, null. Nunca lee la estructura viva.
function dynPackageManifestFromClaim(item) {
  var bp = (item && item.blueprint) || {};
  var ctx = (item && item.context && item.context.courseContext) || {};
  var outline = bp.outline || [];
  var curMod = bp.module || null;
  var modCh = bp.moduleChapters || [];
  function hasKey(o, k) { return o && Object.prototype.hasOwnProperty.call(o, k); }
  function objOrNull(v) { return (typeof v === 'string' && v.trim()) ? v : null; }
  return {
    course: {
      title: ctx.nombre || (bp.course && bp.course.title) || '',
      objective: objOrNull(ctx.obj)
    },
    modules: outline.map(function (mo) {
      var mObj = hasKey(mo, 'objective') ? mo.objective
        : (curMod && curMod.id === mo.id ? curMod.objective : null);
      return {
        id: mo.id,
        title: mo.title || '',
        objective: objOrNull(mObj),
        chapters: (mo.chapters || []).map(function (c) {
          var cObj = null;
          if (hasKey(c, 'objective')) cObj = c.objective;
          else {
            var mc = modCh.filter(function (x) { return x.id === c.id; })[0];
            if (mc) cObj = mc.objective;
            else if (bp.chapter && bp.chapter.id === c.id) cObj = bp.chapter.objective;
          }
          return Object.assign({ id: c.id, title: c.title || '', objective: objOrNull(cObj) }, c.kind === 'practice' ? { kind: 'practice' } : {});
        })
      };
    })
  };
}

// ════ dynBuildContextPackage (spec §4) ════
// Devuelve { contextPackage, canonicalJson, contextPackageSha256 }.
// Lanza (fail loud) si el capítulo no existe en el Manifest o el plan no lo
// cubre — nunca arma un paquete parcial.
function dynBuildContextPackage(manifest, courseContext, plan, chapterId) {
  if (!manifest || !Array.isArray(manifest.modules)) throw new Error('dynBuildContextPackage: manifest inválido');
  if (!plan || !plan.chapters || !plan.modules) throw new Error('dynBuildContextPackage: plan inválido');
  var flat = [];
  manifest.modules.forEach(function (mo) {
    (mo.chapters || []).forEach(function (c) { flat.push({ module: mo, chapter: c }); });
  });
  var idx = -1;
  for (var i = 0; i < flat.length; i++) { if (flat[i].chapter.id === chapterId) { idx = i; break; } }
  if (idx < 0) throw new Error('dynBuildContextPackage: capítulo ' + chapterId + ' no está en el Manifest');
  flat.forEach(function (f) {
    if (!plan.chapters[f.chapter.id]) throw new Error('dynBuildContextPackage: el plan no cubre el capítulo ' + f.chapter.id);
  });
  var cur = flat[idx];
  var pc = plan.chapters[cur.chapter.id];
  var pm = plan.modules[cur.module.id];
  if (!pm) throw new Error('dynBuildContextPackage: el plan no cubre el módulo ' + cur.module.id);

  // accumulated_concepts: concepts_introduced planeados de TODOS los
  // capítulos anteriores (orden del curso), dedup case/espacio-insensible
  // quedándose con la ocurrencia MÁS RECIENTE, capado a los N más recientes,
  // devuelto en orden del curso (viejo → nuevo).
  var seen = {};
  var newestFirst = [];
  for (var j = idx - 1; j >= 0 && newestFirst.length < DYN_ACCUMULATED_CONCEPTS_CAP; j--) {
    // Motor de carga horaria: un capítulo de práctica no introduce conceptos (aunque el plan los traiga).
    var list = flat[j].chapter.kind === 'practice' ? [] : (plan.chapters[flat[j].chapter.id].concepts_introduced || []);
    for (var k = list.length - 1; k >= 0 && newestFirst.length < DYN_ACCUMULATED_CONCEPTS_CAP; k--) {
      var concept = String(list[k]).trim();
      var key = concept.toLowerCase().replace(/\s+/g, ' ');
      if (!concept || seen[key]) continue;
      seen[key] = true;
      newestFirst.push(concept);
    }
  }
  var accumulated = newestFirst.reverse();

  // Motor de carga horaria: el capítulo anterior / siguiente de un capítulo de contenido es otro de CONTENIDO
  // (la práctica no enseña conceptos: no es «el capítulo anterior» del que se continúa).
  var prev = null;
  for (var pi = idx - 1; pi >= 0; pi--) if (flat[pi].chapter.kind !== 'practice') { prev = flat[pi]; break; }
  var next = null;
  for (var ni = idx + 1; ni < flat.length; ni++) if (flat[ni].chapter.kind !== 'practice') { next = flat[ni]; break; }
  var course = manifest.course || {};
  var ctx = courseContext || {};

  var pkg = {
    contextPackageVersion: DYN_CONTEXT_PACKAGE_VERSION,
    chapterId: cur.chapter.id,
    moduleId: cur.module.id,
    course: {
      title: course.title || ctx.nombre || '',
      objective: (course.objective !== undefined ? course.objective : (ctx.obj || null)) || null
    },
    module: {
      title: cur.module.title || '',
      objective: cur.module.objective || null,
      summary: pm.summary
    },
    chapter: {
      title: cur.chapter.title || '',
      objective: cur.chapter.objective || null,
      concepts_introduced: (pc.concepts_introduced || []).slice(),
      concepts_assumed: (pc.concepts_assumed || []).slice(),
      key_terms: (pc.key_terms || []).slice()
    },
    previous_chapter_summary: prev ? plan.chapters[prev.chapter.id].summary : null,
    accumulated_concepts: accumulated,
    next_chapter: next ? { title: next.chapter.title || '', objective: next.chapter.objective || null } : null
  };
  var canonical = dynCanonicalJson(pkg);
  return { contextPackage: pkg, canonicalJson: canonical, contextPackageSha256: dynSha256Hex(canonical) };
}

// ════ Sidecar context_summary ════
// El LLM cierra el capítulo con:
//   ```json context_summary
//   { "summary": "...", "concepts_introduced": [...], "key_terms": [...] }
//   ```
// I2 (fix wave review-rv2): el bloque se busca en CUALQUIER posición (el
// modelo a veces agrega un cierre después, o usa un ```json genérico), no
// solo como lo último del texto. Reglas:
//   - se parsean los bloques con fence (``` al inicio de línea);
//   - si el ÚLTIMO bloque quedó SIN cerrar, la respuesta está truncada
//     (típicamente max_tokens): status 'truncated' → el ejecutor falla el
//     item retryable, nunca lo completa;
//   - el sidecar es el ÚLTIMO bloque cerrado que esté rotulado
//     context_summary, o un ```json (o sin lenguaje) cuyo JSON sea un objeto
//     context_summary ({summary, concepts_introduced, key_terms} o
//     {"context_summary": {...}}). Un ```json genérico con otro contenido
//     (p.ej. un ejemplo de código del capítulo) NO es el sidecar y se queda;
//   - se quita el sidecar (y cualquier otro bloque rotulado context_summary
//     anterior: nunca es prosa) y NADA más: el texto que siga al bloque se
//     conserva como parte del capítulo; solo se recortan espacios sobrantes.

// Bloques con fence de `src`: [{start, end, info, body, closed}] (offsets en
// `src`; `end` incluye la línea de cierre). Un cierre ``` pegado a la última
// línea del cuerpo también cierra el bloque.
function _dynFencedBlocks(src) {
  var blocks = [];
  var re = /[^\n]*(?:\n|$)/g;
  var open = null;
  var m;
  while ((m = re.exec(src)) && m[0] !== '') {
    var lineStart = m.index;
    var lineEnd = m.index + m[0].length;
    var line = m[0].replace(/\r?\n$/, '').replace(/\r$/, '');
    if (!open) {
      var op = /^ {0,3}```(.*)$/.exec(line);
      if (op) open = { start: lineStart, info: op[1].trim(), bodyStart: lineEnd };
      continue;
    }
    if (/^ {0,3}```[ \t]*$/.test(line)) {
      blocks.push({ start: open.start, end: lineEnd, info: open.info, body: src.slice(open.bodyStart, lineStart), closed: true });
      open = null;
    } else if (/```[ \t]*$/.test(line)) {
      var glued = src.slice(open.bodyStart, lineStart) + line.replace(/```[ \t]*$/, '');
      blocks.push({ start: open.start, end: lineEnd, info: open.info, body: glued, closed: true });
      open = null;
    }
  }
  if (open) blocks.push({ start: open.start, end: src.length, info: open.info, body: src.slice(open.bodyStart), closed: false });
  return blocks;
}

function _dynIsLabeledSidecar(block) {
  return /(^|[\s:])context_summary\b/i.test(block.info);
}

// Objeto context_summary dentro del cuerpo de un bloque, o null. Acepta la
// forma directa o envuelta {"context_summary": {...}}.
function _dynContextSummaryObject(body) {
  var obj;
  try { obj = JSON.parse(String(body).trim()); } catch (e) { return null; }
  if (obj && typeof obj === 'object' && !Array.isArray(obj) && obj.context_summary && typeof obj.context_summary === 'object' && !Array.isArray(obj.context_summary)) {
    obj = obj.context_summary;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  if (!('summary' in obj) || !('concepts_introduced' in obj || 'key_terms' in obj)) return null;
  return obj;
}

function _dynIsSidecarBlock(block) {
  if (!block.closed) return false;
  if (_dynIsLabeledSidecar(block)) return true;
  if (block.info !== '' && !/^json\b/i.test(block.info)) return false;
  return _dynContextSummaryObject(block.body) !== null;
}

// Quita [start,end) de `src` uniendo lo de antes y lo de después con un
// párrafo en blanco; solo se recortan espacios en los bordes del corte.
function _dynCutBlock(src, start, end) {
  var before = src.slice(0, start).replace(/\s+$/, '');
  var after = src.slice(end).replace(/^\s+/, '').replace(/\s+$/, '');
  if (!after) return before;
  if (!before) return after;
  return before + '\n\n' + after;
}

function dynValidateContextSummary(obj) {
  var errors = [];
  var L = DYN_CONTEXT_SUMMARY_LIMITS;
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, errors: ['context_summary debe ser un objeto'] };
  if (!_dynIsNonEmptyString(obj.summary)) errors.push('summary: string no vacío requerido');
  else if (obj.summary.length > L.summaryMax) errors.push('summary: máximo ' + L.summaryMax + ' caracteres');
  _dynCheckStringList(errors, 'concepts_introduced', obj.concepts_introduced, L.conceptsMax, L.itemMax, false);
  _dynCheckStringList(errors, 'key_terms', obj.key_terms, L.keyTermsMax, L.itemMax, false);
  return { ok: errors.length === 0, errors: errors };
}

function _dynNormalizeContextSummary(obj) {
  return {
    summary: obj.summary.trim(),
    concepts_introduced: obj.concepts_introduced.map(function (s) { return s.trim(); }),
    key_terms: obj.key_terms.map(function (s) { return s.trim(); })
  };
}

// Devuelve { markdown, contextSummary|null, status: 'present'|'missing'|'invalid'|'truncated', errors[] }.
// `markdown` SIEMPRE sale sin el bloque sidecar cuando éste está presente
// (aunque sea inválido), para que nunca llegue JSON crudo al Libro Guía. Con
// status 'truncated' el markdown es lo anterior al fence abierto (solo
// informativo: el ejecutor NO lo sube).
function dynExtractContextSummary(text) {
  var src = String(text == null ? '' : text);
  var blocks = _dynFencedBlocks(src);
  var last = blocks.length ? blocks[blocks.length - 1] : null;
  if (last && !last.closed) {
    return {
      markdown: src.slice(0, last.start).replace(/\s+$/, '').replace(/^\s+/, ''),
      contextSummary: null,
      status: 'truncated',
      errors: ['respuesta truncada: el bloque ```' + (last.info || '') + ' del final quedó sin cerrar (probable límite de tokens)']
    };
  }
  var idx = -1;
  for (var i = blocks.length - 1; i >= 0; i--) {
    if (_dynIsSidecarBlock(blocks[i])) { idx = i; break; }
  }
  if (idx < 0) {
    return { markdown: src.trim(), contextSummary: null, status: 'missing', errors: ['no se encontró el bloque ```json context_summary```'] };
  }
  var sidecar = blocks[idx];
  // Cortes de atrás hacia adelante (los offsets de los anteriores no cambian):
  // el sidecar y cualquier bloque rotulado context_summary previo.
  var md = src;
  for (var j = blocks.length - 1; j >= 0; j--) {
    if (j === idx || (j < idx && _dynIsLabeledSidecar(blocks[j]))) md = _dynCutBlock(md, blocks[j].start, blocks[j].end);
  }
  md = md.replace(/^\s+/, '');
  var obj;
  try { obj = JSON.parse(String(sidecar.body).trim()); } catch (e) {
    return { markdown: md, contextSummary: null, status: 'invalid', errors: ['JSON inválido en context_summary: ' + ((e && e.message) || String(e))] };
  }
  if (obj && typeof obj === 'object' && !Array.isArray(obj) && obj.context_summary && typeof obj.context_summary === 'object' && !Array.isArray(obj.context_summary)) {
    obj = obj.context_summary;
  }
  var v = dynValidateContextSummary(obj);
  if (!v.ok) return { markdown: md, contextSummary: null, status: 'invalid', errors: v.errors };
  return { markdown: md, contextSummary: _dynNormalizeContextSummary(obj), status: 'present', errors: [] };
}

// Para la respuesta del reintento dirigido (solo el sidecar): acepta el
// bloque rotulado, un fence ```json genérico o el JSON pelado.
function dynParseContextSummaryOnly(text) {
  var src = String(text == null ? '' : text).trim();
  var blocks = _dynFencedBlocks(src).filter(function (b) { return b.closed; });
  var body = null;
  for (var i = blocks.length - 1; i >= 0 && body === null; i--) {
    if (_dynIsSidecarBlock(blocks[i]) || /^json\b/i.test(blocks[i].info) || blocks[i].info === '') body = blocks[i].body;
  }
  if (body === null) body = _dynStripJsonFence(src);
  var obj;
  try { obj = JSON.parse(String(body).trim()); } catch (e) {
    return { ok: false, contextSummary: null, errors: ['JSON inválido: ' + ((e && e.message) || String(e))] };
  }
  if (obj && typeof obj === 'object' && !Array.isArray(obj) && obj.context_summary && typeof obj.context_summary === 'object') obj = obj.context_summary;
  var v = dynValidateContextSummary(obj);
  if (!v.ok) return { ok: false, contextSummary: null, errors: v.errors };
  return { ok: true, contextSummary: _dynNormalizeContextSummary(obj), errors: [] };
}

// ════ "Bibliografía sugerida" de las intros (I3, fix wave review-rv2) ════
// Regla ÚNICA y tolerante, IDÉNTICA (source + flags) a
// SUGGESTED_BIBLIOGRAPHY_HEADING_RE del backend (orbia-backend
// src/package/dynamic-mbz-builder.ts), que la usa al empaquetar: una línea
// (trim) con marcador markdown opcional (#…######) + "Bibliografía sugerida"
// + cualquier texto ("— 5 a 8 referencias", "(APA)", ":" …). La validación
// del ejecutor usa esta misma extracción, así una intro que el builder no
// sabría separar falla (retryable) al GENERARSE, no al empaquetar.
var DYN_SUGGESTED_BIBLIOGRAPHY_HEADING_RE = /^(#{1,6})?[ \t]*Bibliograf[ií]a sugerida.*$/i;

// Sección "Bibliografía sugerida" sin su encabezado: desde la PRIMERA línea
// que cumple la regla hasta el próximo encabezado de igual o mayor nivel
// (sin marcador: hasta el próximo encabezado). null si no está o queda vacía.
// Misma lógica, línea por línea, que extractSuggestedBibliographyMd (backend).
function dynExtractSuggestedBibliographyMd(md) {
  var lines = String(md == null ? '' : md).split(/\r?\n/);
  var start = -1;
  for (var i = 0; i < lines.length; i++) {
    if (DYN_SUGGESTED_BIBLIOGRAPHY_HEADING_RE.test(lines[i].trim())) { start = i; break; }
  }
  if (start < 0) return null;
  var marker = lines[start].trim().match(DYN_SUGGESTED_BIBLIOGRAPHY_HEADING_RE)[1];
  var level = marker ? marker.length : 6;
  var out = [];
  for (var k = start + 1; k < lines.length; k++) {
    var h = lines[k].match(/^(#{1,6})\s+/);
    if (h && h[1].length <= level) break;
    out.push(lines[k]);
  }
  var body = out.join('\n').trim();
  return body ? body : null;
}
