#!/usr/bin/env node
/* eslint-disable */
// LOOP 8.6A · Interpretación de requisitos explícitos: documento → lectura gratuita → extractor → requirements[].
// Solo interpretación: nada restringe todavía el diseño. Sin red, sin proveedores, USD 0.
//
//   Casos sintéticos (scripts/fixtures/requirements-synthetic/cases.json, propios, NO son documentos reales):
//     metas duras: 100 % de detección de requisitos explícitos y 0 obligatorios inventados; alcance, clasificación,
//     compuestos, alternativas, condiciones y asignaturas.
//   Documentos reales (opcional, fuera del repo: REQUIREMENTS_CORPUS_DIR=…/validation/requisitos-8.6): se MIDE
//     (detección, falsos positivos/negativos, ambiguos) con sus anotaciones gold/*.json; se exige 0 obligatorios inventados.
//
// Uso: node scripts/check-loop86-requirements.js [path/to/dist] [--report=archivo.json] [--table]
'use strict';
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const distRoot = path.resolve(process.cwd(), args.find((a) => !a.startsWith('--')) || 'dist');
const reportArg = (args.find((a) => a.startsWith('--report=')) || '').slice(9);
const showTable = args.includes('--table');
const load = (rel) => {
  try { return require(path.join(distRoot, rel)); } catch (e) { console.error(`❌ No se pudo cargar ${rel} (¿npm run build?): ${e.message}`); process.exit(1); }
};
const RX = load('modules/academic-context/requirements/requirements-extractor.js');
const TS = load('modules/academic-context/extract/text-sources.js');

const strip = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const normScope = (s) => {
  const x = s || { level: 'course' };
  const o = { level: x.level };
  for (const k of ['each', 'index', 'chapterKind']) if (x[k] !== undefined) o[k] = x[k];
  if (x.subject) o.subject = strip(x.subject);
  if (x.unit !== undefined) o.index = x.unit;
  return JSON.stringify(o);
};
const tol = (g) => (g.kind === 'target_hours' ? 0.5 : 0);

/** ¿El predicho p coincide con el esperado g? (detección: tipo, valor, modo, máximo, forma, tipo de evaluación, opción, condición). */
function detects(g, p) {
  if (g.kind !== p.kind) return false;
  if (g.kind === 'structure') { if (g.shape && JSON.stringify(g.shape) !== JSON.stringify(p.shape)) return false; }
  else if (!g.anyValue && g.value !== undefined && g.value !== null && (p.value === null || Math.abs(g.value - p.value) > tol(g))) return false;
  if (g.mode && g.mode !== p.mode) return false;
  if (g.valueMax !== undefined && g.valueMax !== p.valueMax) return false;
  if (g.kind === 'evaluations' && g.evaluationType && (p.evaluationType || 'any') !== g.evaluationType) return false;
  if (g.option && strip(p.optionId || '') !== strip(g.option)) return false;
  if (g.condition) {
    if (!p.condition) return false;
    if (g.condition.modeled === false && p.condition.modeled !== false) return false;
    if (g.condition.field && (p.condition.field !== g.condition.field || p.condition.value !== g.condition.value)) return false;
  }
  return true;
}
function hitsMustNot(n, p) {
  if (n.kind !== p.kind) return false;
  if (!n.anyValue && n.value !== undefined && n.value !== null && (p.value === null || Math.abs(n.value - p.value) > tol(n))) return false;
  if (n.shape && JSON.stringify(n.shape) !== JSON.stringify(p.shape)) return false;
  if (n.mode && n.mode !== p.mode) return false;
  if (n.scope && normScope(n.scope) !== normScope(p.scope)) return false;
  if (n.evaluationType && (p.evaluationType || 'any') !== n.evaluationType) return false;
  if ((n.obligation || 'required') !== p.obligation) return false;
  if (n.active === true && !p.active) return false;
  if (n.confidenceHigh && p.confidence !== 'high') return false;
  return true;
}
const describe = (r) => {
  if (!r) return '—';
  const v = r.kind === 'structure' ? (r.shape ? `${r.shape.length}×${r.shape[0]}` : '?') : r.mode === 'range' ? `${r.value}–${r.valueMax}` : `${r.value}`;
  const sc = r.scope ? JSON.parse(normScope(r.scope)) : { level: 'course' };
  const scope = sc.level === 'module' ? (sc.each ? 'por módulo' : `módulo ${sc.index}`) : sc.level === 'chapter' ? `por capítulo${sc.chapterKind === 'practice' ? ' de práctica' : ''}` : sc.level === 'subject' ? `asignatura ${r.scope.subject}` : sc.level === 'outcome' ? 'por resultado' : sc.level === 'unit' ? (sc.each ? 'por unidad' : `unidad ${sc.index}`) : sc.level === 'structure' ? 'estructura' : 'curso';
  const et = r.evaluationType && r.evaluationType !== 'any' ? ` ${r.evaluationType === 'partial' ? 'parciales' : 'final'}` : '';
  const opt = r.optionId || r.option ? ` [opción ${r.optionId || r.option}]` : '';
  const cond = r.condition ? ` [condición${r.condition.modeled === false ? ' no modelada' : `: ${r.condition.field} ${r.condition.op || '='} ${r.condition.value}`}]` : '';
  return { text: `${r.kind} ${r.mode || ''} ${v}${et}${opt}${cond}`.replace(/\s+/g, ' ').trim(), scope };
};

/** Evalúa una extracción contra una anotación. */
function evaluate(id, gold, x) {
  const preds = x.requirements;
  const rows = [];
  const used = new Set();
  const stats = { expected: 0, detected: 0, classOk: 0, scopeOk: 0, fn: [], fp: [], invented: [], reviewFp: [], ambiguous: 0, informative: 0, mustNotHits: [] };
  for (const g of gold.must) {
    stats.expected++;
    const p = preds.find((q) => !used.has(q.id) && detects(g, q)) || null;
    if (p) used.add(p.id);
    const classOk = p ? (g.obligation || 'required') === p.obligation : false;
    const scopeOk = p ? normScope(g.scope) === normScope(p.scope) : false;
    if (p) { stats.detected++; if (classOk) stats.classOk++; if (scopeOk) stats.scopeOk++; } else stats.fn.push(g);
    const d = describe(p);
    rows.push({ caso: id, esperado: `${describe(g).text} · ${g.obligation || 'required'} · ${describe(g).scope}`, detectado: p ? d.text : '—', clasificacion: p ? `${p.obligation}${p.confidence === 'medium' ? ' · revisa esta lectura' : ''}` : '—', alcance: p ? d.scope : '—', resultado: !p ? 'NO DETECTADO' : classOk && scopeOk ? 'OK' : !classOk ? 'clasificación incorrecta' : 'alcance incorrecto' });
  }
  for (const g of gold.optional || []) {
    if (g.alternativeGroup) continue;
    const p = preds.find((q) => !used.has(q.id) && detects(g, q));
    if (p) used.add(p.id);
    rows.push({ caso: id, esperado: `(opcional) ${describe(g).text} · ${describe(g).scope}`, detectado: p ? describe(p).text : '—', clasificacion: p ? `${p.obligation}${p.confidence === 'medium' ? ' · revisa esta lectura' : ''}` : '—', alcance: p ? describe(p).scope : '—', resultado: p ? 'aceptable' : 'no leído (aceptable)' });
  }
  for (const n of gold.must_not || []) {
    const p = preds.find((q) => hitsMustNot(n, q));
    if (p) {
      stats.mustNotHits.push({ n, p });
      (p.confidence === 'high' ? stats.invented : stats.reviewFp).push(p);
    }
    rows.push({ caso: id, esperado: `NO: ${n.kind}${n.anyValue ? '' : ' ' + (n.value ?? '')} (${n.why})`, detectado: p ? describe(p).text : '—', clasificacion: p ? `${p.obligation}${p.confidence === 'medium' ? ' · revisa esta lectura' : ''}` : '—', alcance: p ? describe(p).scope : '—', resultado: p ? (p.confidence === 'high' ? 'FALSO POSITIVO (obligatorio inventado)' : 'falso positivo marcado para revisar') : 'OK (no se convirtió en requisito)' });
  }
  for (const p of preds) {
    if (p.confidence === 'medium') stats.ambiguous++;
    if (used.has(p.id) || stats.mustNotHits.some((h) => h.p === p)) continue;
    if (p.obligation === 'informative') { stats.informative++; continue; }
    stats.fp.push(p);
    if (p.obligation === 'required' && p.confidence === 'high') stats.invented.push(p);
    else if (p.obligation === 'required') stats.reviewFp.push(p);
    rows.push({ caso: id, esperado: '(nada)', detectado: describe(p).text, clasificacion: `${p.obligation}${p.confidence === 'medium' ? ' · revisa esta lectura' : ''}`, alcance: describe(p).scope, resultado: p.obligation === 'required' && p.confidence === 'high' ? 'FALSO POSITIVO (obligatorio inventado)' : 'falso positivo (no obligatorio)' });
  }
  return { rows, stats };
}

/** Grupos (compuestos «all» y alternativas «oneOf»), activos sin elegir nada y activos tras cada elección. */
function checkGroupsAndSelections(id, title, c, x) {
  const out = { groupsOk: 0, groupsExpected: 0, selectOk: 0, selectExpected: 0 };
  for (const g of c.groups || []) {
    out.groupsExpected++;
    let ok = false;
    if (g.relation === 'all') {
      ok = x.groups.some((G) => {
        if (G.relation !== 'all') return false;
        const kinds = G.requirementIds.map((rid) => (x.requirements.find((r) => r.id === rid) || {}).kind).sort();
        if (JSON.stringify(kinds) !== JSON.stringify([...g.kinds].sort())) return false;
        if (g.total !== undefined) {
          const st = G.requirementIds.map((rid) => x.requirements.find((r) => r.id === rid)).find((r) => r && r.kind === 'structure');
          return !!st && RX.structureTotal(st) === g.total;
        }
        return true;
      });
    } else {
      ok = x.groups.some((G) => G.relation === 'oneOf' && JSON.stringify(G.options.map((o) => o.id).sort()) === JSON.stringify([...g.options].sort())
        && G.options.every((o) => o.requirementIds.every((rid) => { const r = x.requirements.find((q) => q.id === rid); return r && !r.active; })));
    }
    if (ok) out.groupsOk++; else fail(`${id} ${title}: grupo ${g.relation} esperado no reconstruido (${JSON.stringify(x.groups.map((G) => [G.relation, G.label]))})`);
  }
  if (c.expectActive !== undefined) {
    const act = RX.requirementsFor(x, {}).filter((r) => r.obligation === 'required');
    if (act.length !== c.expectActive) fail(`${id} ${title}: ${act.length} requisitos obligatorios activos sin elegir nada (esperado ${c.expectActive})`);
  }
  for (const se of [...(c.select ? [c.select] : []), ...(c.selects || [])]) {
    out.selectExpected++;
    const sel = { ...(se.subject ? { subject: se.subject } : {}), ...(se.options ? { options: se.options } : {}), ...(se.facts ? { facts: se.facts } : {}) };
    const act = RX.requirementsFor(x, sel);
    let ok = true;
    for (const [kind, values] of Object.entries(se.expectActiveValues || {})) {
      const got = act.filter((r) => r.kind === kind).map((r) => r.value).sort((a, b) => a - b);
      if (JSON.stringify(got) !== JSON.stringify([...values].sort((a, b) => a - b))) { ok = false; fail(`${id} ${title}: con ${JSON.stringify(sel)} aplica ${kind}=${JSON.stringify(got)} (esperado ${JSON.stringify(values)})`); }
    }
    if (se.expectStructureTotal !== undefined) {
      const tots = act.filter((r) => r.kind === 'structure').map((r) => RX.structureTotal(r));
      if (JSON.stringify(tots) !== JSON.stringify([se.expectStructureTotal])) { ok = false; fail(`${id} ${title}: con ${JSON.stringify(sel)} la estructura activa suma ${JSON.stringify(tots)} capítulos (esperado ${se.expectStructureTotal})`); }
    }
    if (ok) out.selectOk++;
  }
  return out;
}

let failures = 0;
const fail = (m) => { failures++; console.log(`❌ ${m}`); };
const report = { synthetic: [], real: [], generatedAt: new Date().toISOString(), extractorVersion: RX.REQUIREMENTS_EXTRACTOR_VERSION };

// ── Sintéticos ──
const cases = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/requirements-synthetic/cases.json'), 'utf8'));
const synth = { expected: 0, detected: 0, classOk: 0, scopeOk: 0, invented: 0, review: 0, fn: 0, groupsOk: 0, groupsExpected: 0, selectOk: 0, selectExpected: 0 };
for (const c of cases) {
  const doc = TS.readText(Buffer.from(c.text, 'utf8'), 'text/plain');
  const x = RX.extractRequirements(doc.lines, c.id);
  const { rows, stats } = evaluate(c.id, c, x);
  report.synthetic.push(...rows);
  synth.expected += stats.expected; synth.detected += stats.detected; synth.classOk += stats.classOk; synth.scopeOk += stats.scopeOk;
  synth.invented += stats.invented.length; synth.review += stats.reviewFp.length; synth.fn += stats.fn.length;
  const bad = rows.filter((r) => !/^(OK|aceptable|no leído)/.test(r.resultado));
  for (const r of bad) fail(`${c.id} ${c.title}: ${r.esperado} → ${r.detectado} [${r.clasificacion} · ${r.alcance}] ${r.resultado}`);
  const gs = checkGroupsAndSelections(c.id, c.title, c, x);
  synth.groupsOk += gs.groupsOk; synth.groupsExpected += gs.groupsExpected; synth.selectOk += gs.selectOk; synth.selectExpected += gs.selectExpected;
}
const pct = (a, b) => (b ? `${Math.round((a / b) * 1000) / 10} %` : '—');
console.log(`\nSintéticos (${cases.length} casos propios, no reales):`);
console.log(`  detección ${synth.detected}/${synth.expected} (${pct(synth.detected, synth.expected)}) · clasificación ${pct(synth.classOk, synth.detected)} · alcance ${pct(synth.scopeOk, synth.detected)} · grupos ${synth.groupsOk}/${synth.groupsExpected} · elecciones ${synth.selectOk}/${synth.selectExpected}`);
console.log(`  obligatorios inventados: ${synth.invented} · falsos positivos marcados para revisar: ${synth.review}`);
if (synth.detected !== synth.expected) fail(`sintéticos: detección ${synth.detected}/${synth.expected} (meta 100 %)`);
if (synth.invented) fail(`sintéticos: ${synth.invented} obligatorios inventados (meta 0)`);

// ── Reales (fuera del repo) ──
const corpus = process.env.REQUIREMENTS_CORPUS_DIR;
if (corpus && fs.existsSync(path.join(corpus, 'gold'))) {
  const tot = { groupsOk: 0, groupsExpected: 0, selectOk: 0, selectExpected: 0, docs: 0, expected: 0, detected: 0, classOk: 0, scopeOk: 0, fp: 0, fn: 0, invented: 0, review: 0, ambiguous: 0, informative: 0, mustNot: 0, mustNotHit: 0 };
  const perDoc = [];
  (async () => {
    for (const f of fs.readdirSync(path.join(corpus, 'gold')).filter((x) => /^R\d+\.json$/.test(x)).sort()) {
      const gold = JSON.parse(fs.readFileSync(path.join(corpus, 'gold', f), 'utf8'));
      const buf = fs.readFileSync(path.join(corpus, 'docs', gold.doc));
      let doc;
      let overLimit = false;
      try { doc = await TS.readDocument(buf, gold.doc); } catch (e) {
        // Un archivo por encima del tope del lector se lee igual con el mismo lector (sin el tope) para MEDIR la
        // interpretación, y se informa aparte: con ese tamaño no se podría subir.
        if (!/supera \d+ MB/.test(e.message)) { fail(`${f}: no se pudo leer ${gold.doc}: ${e.message}`); continue; }
        overLimit = true;
        const mt = TS.sniffMediaType(buf, gold.doc);
        doc = mt === 'application/pdf' ? await TS.readPdf(buf) : await TS.readDocx(buf);
      }
      const x = RX.extractRequirements(doc.lines, f.replace('.json', ''));
      const id = f.replace('.json', '');
      const { rows, stats } = evaluate(id, gold, x);
      report.real.push(...rows);
      tot.docs++; tot.expected += stats.expected; tot.detected += stats.detected; tot.classOk += stats.classOk; tot.scopeOk += stats.scopeOk;
      tot.fp += stats.fp.length + stats.mustNotHits.length; tot.fn += stats.fn.length; tot.invented += stats.invented.length; tot.review += stats.reviewFp.length;
      tot.ambiguous += stats.ambiguous; tot.informative += stats.informative; tot.mustNot += (gold.must_not || []).length; tot.mustNotHit += stats.mustNotHits.length;
      perDoc.push({ id, overLimit, bytes: buf.length, lines: doc.lines.length, requirements: x.requirements.length, multiCourse: x.multiCourse, ignored: x.ignored.length, expected: stats.expected, detected: stats.detected, fp: stats.fp.length + stats.mustNotHits.length, fn: stats.fn.length, invented: stats.invented.length, ambiguous: stats.ambiguous, informative: stats.informative });
      const gs = checkGroupsAndSelections(id, gold.type || '', gold, x);
      tot.groupsOk += gs.groupsOk; tot.groupsExpected += gs.groupsExpected; tot.selectOk += gs.selectOk; tot.selectExpected += gs.selectExpected;
      for (const p of stats.invented) fail(`${id}: obligatorio inventado ${describe(p).text} («${p.source.quote.slice(0, 120)}»)`);
    }
    report.realSummary = { ...tot, perDoc };
    console.log(`\nDocumentos reales (${tot.docs}, fuera del repo):`);
    console.log(`  requisitos explícitos esperados ${tot.expected} · detectados ${tot.detected} (${pct(tot.detected, tot.expected)}) · clasificación ${pct(tot.classOk, tot.detected)} · alcance ${pct(tot.scopeOk, tot.detected)}`);
    console.log(`  alternativas y compuestos ${tot.groupsOk}/${tot.groupsExpected} · elecciones ${tot.selectOk}/${tot.selectExpected}`);
    if (tot.detected !== tot.expected) fail(`reales: detección ${tot.detected}/${tot.expected}`);
    console.log(`  falsos positivos ${tot.fp} (trampas tocadas ${tot.mustNotHit}/${tot.mustNot}) · falsos negativos ${tot.fn} · obligatorios inventados ${tot.invented} · marcados para revisar ${tot.review} · ambiguos (confianza media) ${tot.ambiguous} · datos informativos ${tot.informative}`);
    for (const d of perDoc) console.log(`   ${d.id}: ${d.lines} líneas · ${d.requirements} leídos · esperados ${d.expected} · detectados ${d.detected} · FP ${d.fp} · FN ${d.fn} · inventados ${d.invented}${d.multiCourse ? ' · varias asignaturas' : ''}${d.overLimit ? ` · ⚠ ${(d.bytes / 1048576).toFixed(1)} MB: el lector lo rechaza (límite ${TS.MAX_DOCUMENT_BYTES / 1048576} MB)` : ''}`);
    finish();
  })();
} else {
  console.log('\n(Sin REQUIREMENTS_CORPUS_DIR: documentos reales no medidos.)');
  finish();
}

function finish() {
  if (showTable) {
    console.log('\n| Caso | Requisito esperado | Detectado por Cursia | Clasificación | Alcance | Resultado |\n|---|---|---|---|---|---|');
    for (const r of [...report.synthetic, ...report.real]) console.log(`| ${r.caso} | ${r.esperado} | ${r.detectado} | ${r.clasificacion} | ${r.alcance} | ${r.resultado} |`);
  }
  if (reportArg) fs.writeFileSync(reportArg, JSON.stringify(report, null, 2));
  console.log(`\n${failures ? `${failures} fallas` : 'OK'}`);
  process.exit(failures ? 1 : 0);
}
