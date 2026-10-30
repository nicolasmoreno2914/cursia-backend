#!/usr/bin/env node
/* eslint-disable */
// Cursia r55 (R7/R8) — «Repaso» (H5P.Dialogcards) y TODO .h5p del curso SOLO CONTENIDO. Checks PUROS (sin DB,
// sin red, sin Moodle, sin proveedores).
//
// Contexto (audit-1353/reports/dialogcards-diagnosis.md): hasta el builder 3.13.0 el «Repaso», el caso ramificado y
// el QuestionSet 1.21 llevaban sus carpetas «delta» (clausura PARCIAL de dependencias). En Moodle 4.5 una clausura
// parcial de una librería ya instalada cuelga `H5PValidator::isValidPackage` (upgradeOnly) cuando un proceso PHP
// despliega varios paquetes con dueños de permisos distintos; a un docente nunca le servía.
//
//  1. .mbz v3 con «Repaso» + caso ramificado + QuestionSet 1.21: cada .h5p = exactamente h5p.json + content/…
//     (BS: + content/images/*), h5p.json.preloadedDependencies = principal + clausura de runtime del perfil v3.
//  2. «Repaso» sin nota: sin grade item, grade 0, enabletracking 0, completion 2 por vista, nunca criterio del curso.
//  3. mbz-validator-v3 limpio; summary.restore = requisito del sitio (pack v3), no «restaurar como administrador».
//  4. Negativos: carpeta H5P.Dialogcards-1.9 sola → H5P_LIBRARIES + H5P_PARTIAL_LIBRARY_CLOSURE; clausura COMPLETA
//     de librerías → H5P_LIBRARIES pero NO H5P_PARTIAL_LIBRARY_CLOSURE; principal en otra minor → H5P_LIBRARIES.
//  5. Determinismo: mismo input ⇒ mismo sha256 de cada .h5p y del .mbz.
//
// Uso: npm run build && node scripts/check-review-cards-content-only.js

const path = require('path');
const crypto = require('crypto');
const JSZip = require('jszip');

const ROOT = path.resolve(__dirname, '..');
const distRoot = path.join(ROOT, 'dist');
const L = (rel) => require(path.join(distRoot, rel));
require('reflect-metadata');
global.fetch = async (u) => {
  throw new Error(`NETWORK FORBIDDEN in check: ${u}`);
};

const h = L('package/h5p/index.js');
const B = L('package/dynamic-mbz-builder-v3.js');
const V = L('package/v3/mbz-validator-v3.js');
const PF = require('./lib/v21-packaging-fixtures');

let passed = 0;
let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`✅ ${name}`);
  } catch (err) {
    failures++;
    console.error(`❌ ${name}\n   ${err && err.stack ? err.stack.split('\n').slice(0, 3).join('\n   ') : err}`);
  }
}
const assert = (c, m) => { if (!c) throw new Error(m); };
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); };
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const key = (d) => `${d.machineName} ${d.majorVersion}.${d.minorVersion}`;

const CFG = { engine: 'h5p', finalExam: true, activityTypeRules: 2, reviewCards: true, chapterObjectives: ['Decidir cómo atender un reclamo', 'Escuchar al cliente', 'Identificar partes', 'Identificar partes'] };

async function pkgOf(z, filesXml, dir) {
  const inf = await z.file(`${dir}/inforef.xml`).async('string');
  const ids = [...inf.matchAll(/<id>(\d+)<\/id>/g)].map((x) => x[1]);
  const b = [...filesXml.matchAll(/<file id="(\d+)">[\s\S]*?<\/file>/g)].find((x) => ids.includes(x[1]) && x[0].includes('<filearea>package</filearea>') && x[0].includes('<component>mod_h5pactivity</component>'));
  const hash = /<contenthash>([0-9a-f]+)<\/contenthash>/.exec(b[0])[1];
  return { hash, blob: await z.file(`files/${hash.slice(0, 2)}/${hash}`).async('nodebuffer') };
}

/** Reemplaza el blob de un .h5p (y su contenthash/filesize en files.xml) por `next`. */
async function swapH5p(mbz, oldHash, next) {
  const z = await JSZip.loadAsync(mbz);
  const sha1 = crypto.createHash('sha1').update(next).digest('hex');
  let fx = await z.file('files.xml').async('string');
  fx = fx.replace(/<file id="\d+">[\s\S]*?<\/file>/g, (blk) => (blk.includes(`<contenthash>${oldHash}</contenthash>`)
    ? blk.replace(`<contenthash>${oldHash}</contenthash>`, `<contenthash>${sha1}</contenthash>`).replace(/<filesize>\d+<\/filesize>/, `<filesize>${next.length}</filesize>`)
    : blk));
  z.file('files.xml', fx);
  z.file(`files/${sha1.slice(0, 2)}/${sha1}`, next);
  return z.generateAsync({ type: 'nodebuffer' });
}

(async () => {
  const input = PF.packagingInput(distRoot, CFG);
  const built = await B.buildDynamicMbzV3(input);
  const z = await JSZip.loadAsync(built.mbz);
  const filesXml = await z.file('files.xml').async('string');
  const mb = await z.file('moodle_backup.xml').async('string');
  const acts = [];
  for (const m of mb.matchAll(/<moduleid>(\d+)<\/moduleid>\s*<sectionid>\d+<\/sectionid>\s*<modulename>(\w+)<\/modulename>[\s\S]*?<directory>([^<]+)<\/directory>/g)) {
    const mod = await z.file(`${m[3]}/module.xml`).async('string');
    acts.push({ mid: Number(m[1]), modname: m[2], dir: m[3], idnumber: /<idnumber>([^<]*)<\/idnumber>/.exec(mod)[1], module: mod });
  }
  const reviews = acts.filter((a) => /:review_cards$/.test(a.idnumber));
  // Segundo curso (reglas 1): la actividad por defecto es QuestionSet 1.21.
  const builtQs = await B.buildDynamicMbzV3(PF.packagingInput(distRoot, { engine: 'h5p', finalExam: true }));
  const h5pActs = acts.filter((a) => a.modname === 'h5pactivity');

  await check('fixture: el curso trae «Repaso», caso ramificado y QuestionSet 1.21', async () => {
    assert(reviews.length >= 1, 'sin «Repaso»');
    const mains = new Set([...built.summary.h5pPackages, ...builtQs.summary.h5pPackages].map((p) => p.mainLibrary));
    for (const m of ['H5P.Dialogcards', 'H5P.BranchingScenario', 'H5P.QuestionSet', 'H5P.InteractiveVideo']) assert(mains.has(m), `falta ${m}`);
  });

  await check('todo .h5p del curso es solo contenido (h5p.json + content/…, BS + content/images/*); dependencias = clausura de runtime del perfil v3', async () => {
    for (const a of h5pActs) {
      const { blob } = await pkgOf(z, filesXml, a.dir);
      const hz = await JSZip.loadAsync(blob);
      const names = Object.keys(hz.files).filter((n) => !hz.files[n].dir);
      const extra = names.filter((n) => n !== 'h5p.json' && !n.startsWith('content/'));
      eq(extra, [], `${a.idnumber}: carpetas de librería`);
      const hj = JSON.parse(await hz.file('h5p.json').async('string'));
      const content = names.filter((n) => n.startsWith('content/') && n !== 'content/content.json');
      if (hj.mainLibrary === 'H5P.BranchingScenario') assert(content.every((n) => /^content\/images\/[a-z0-9-]+\.(png|jpe?g)$/.test(n)), `${a.idnumber}: imágenes del caso`);
      else eq(content, [], `${a.idnumber}: archivos de contenido`);
      const main = h.CURSIA_H5P_PROFILE_V3.mainLibraries[hj.mainLibrary];
      eq(key(hj.preloadedDependencies[0]), key(main), `${a.idnumber}: principal = perfil v3`);
      const runtime = h.profileRuntimeDependencies(h.CURSIA_H5P_PROFILE_V3, hj.mainLibrary).map(key);
      for (const r of runtime) assert(hj.preloadedDependencies.map(key).includes(r), `${a.idnumber}: falta ${r} en h5p.json`);
      const v3 = new Set(h.CURSIA_H5P_PROFILE_V3.libraries.map(key));
      for (const d of hj.preloadedDependencies) assert(v3.has(key(d)), `${a.idnumber}: ${key(d)} fuera del pack v3`);
    }
  });

  await check('«Repaso»: H5P.Dialogcards 1.9, h5p.json = clausura de runtime exacta de DC en v3, ≈ KB (no ≈ 98 KB)', async () => {
    for (const a of reviews) {
      const { blob } = await pkgOf(z, filesXml, a.dir);
      assert(blob.length < 20000, `${a.idnumber}: ${blob.length} bytes`);
      const hj = JSON.parse(await (await JSZip.loadAsync(blob)).file('h5p.json').async('string'));
      eq(hj.mainLibrary, 'H5P.Dialogcards', 'principal');
      const want = h.profileRuntimeDependencies(h.CURSIA_H5P_PROFILE_V3, 'H5P.Dialogcards').map(key).sort();
      eq(hj.preloadedDependencies.map(key).sort(), [...new Set([...want, 'H5P.Dialogcards 1.9'])].sort(), 'dependencias');
    }
  });

  await check('«Repaso» pedagógico: sin grade item, grade 0, enabletracking 0, completion 2 por vista (sin nota), nunca criterio; fuera del gradebook', async () => {
    const comp = await z.file('completion.xml').async('string');
    eq([...comp.matchAll(/<criteriatype>(\d+)<\/criteriatype>/g)].map((m) => m[1]), ['6'], 'criterios del curso: solo la nota final');
    const critMids = [...comp.matchAll(/<moduleinstance>(\d+)<\/moduleinstance>/g)].map((x) => Number(x[1]));
    for (const r of reviews) {
      assert(!/<grade_item /.test(await z.file(`${r.dir}/grades.xml`).async('string')), `${r.idnumber}: grade item`);
      const hx = await z.file(`${r.dir}/h5pactivity.xml`).async('string');
      assert(/<grade>0<\/grade>/.test(hx) && /<enabletracking>0<\/enabletracking>/.test(hx), `${r.idnumber}: grade 0 / tracking 0`);
      for (const [t, v] of [['completion', '2'], ['completionview', '1'], ['completionpassgrade', '0'], ['completiongradeitemnumber', '$@NULL@$']]) {
        eq(new RegExp(`<${t}>([^<]*)</${t}>`).exec(r.module)[1], v, `${r.idnumber}: ${t}`);
      }
      assert(!critMids.includes(r.mid), `${r.idnumber}: criterio`);
    }
  });

  await check('mbz-validator-v3 limpio; summary.restore = requisito del sitio (Cursia H5P Library Pack v3), sin «restaurar como administrador»', async () => {
    const v = await V.validateMbzV3(built.mbz, built.expectations);
    assert(v.ok, JSON.stringify(v.issues.slice(0, 6)));
    eq(built.summary.restore && built.summary.restore.as, 'site_library_pack', 'as');
    eq(built.summary.restore.libraryPack, 'v3', 'pack');
    assert(/Cursia H5P Library Pack v3/.test(built.summary.restore.note) && /cualquier docente/.test(built.summary.restore.note) && !/como administrador o gestor/.test(built.summary.restore.note), built.summary.restore.note);
    eq(built.summary.h5pProfileVersion, 3, 'perfil del paquete');
    eq(B.DYNAMIC_MBZ_BUILDER_VERSION_V3, '3.19.0', 'builder'); // r79.1 (tipos de Actividad); r78 (Libro Guía en línea); r77: 3.17.0; r60 (Moodle mínimo); r58 I3: 3.15.1
  });

  // ── Negativos del validador ──
  const rv = reviews[0];
  const { hash: rvHash, blob: rvBlob } = await pkgOf(z, filesXml, rv.dir);
  const store = h.openH5pLibraryStore(h.CURSIA_H5P_PROFILE_V3);
  // Carpetas del store versionado (solo deltas); las demás de la clausura, con un library.json mínimo (sin deps):
  // el validador solo lee library.json, así el caso «clausura completa» no depende de librerías fuera del repo.
  const refByDir = new Map(h.CURSIA_H5P_PROFILE_V3.libraries.map((l) => [h.h5pLibraryDirName(l), l]));
  const withDirs = async (dirs) => {
    const hz = await JSZip.loadAsync(rvBlob);
    for (const d of dirs) {
      const files = store.libraryFiles(d);
      if (files && files['library.json']) {
        for (const [rel, data] of Object.entries(files)) hz.file(`${d}/${rel}`, data);
      } else {
        const ref = refByDir.get(d);
        assert(ref, `${d} fuera del perfil v3`);
        hz.file(`${d}/library.json`, JSON.stringify({ title: ref.machineName, machineName: ref.machineName, majorVersion: ref.majorVersion, minorVersion: ref.minorVersion, patchVersion: ref.patchVersion, runnable: 0 }));
      }
    }
    return hz.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  };

  await check('negativo: «Repaso» con la carpeta H5P.Dialogcards-1.9 sola (la delta de ≤ 3.13.0) → H5P_LIBRARIES + H5P_PARTIAL_LIBRARY_CLOSURE', async () => {
    const bad = await swapH5p(built.mbz, rvHash, await withDirs(['H5P.Dialogcards-1.9']));
    const v = await V.validateMbzV3(bad, built.expectations);
    const mine = v.issues.filter((i) => i.where === rv.idnumber).map((i) => i.code);
    assert(mine.includes('H5P_LIBRARIES') && mine.includes('H5P_PARTIAL_LIBRARY_CLOSURE'), JSON.stringify(v.issues.slice(0, 6)));
  });

  await check('negativo: «Repaso» con la clausura COMPLETA (runtime + editor) → H5P_LIBRARIES (no content-only) pero NO H5P_PARTIAL_LIBRARY_CLOSURE', async () => {
    const full = h.CURSIA_H5P_PROFILE_V3.closureByMain['H5P.Dialogcards'].full.map(h.h5pLibraryDirName);
    const bad = await swapH5p(built.mbz, rvHash, await withDirs(full));
    const v = await V.validateMbzV3(bad, built.expectations);
    const mine = v.issues.filter((i) => i.where === rv.idnumber).map((i) => i.code);
    assert(mine.includes('H5P_LIBRARIES') && !mine.includes('H5P_PARTIAL_LIBRARY_CLOSURE'), JSON.stringify(v.issues.filter((i) => i.where === rv.idnumber)));
  });

  await check('negativo: «Repaso» que declara H5P.Dialogcards 1.8 (otra minor, fuera del pack) → H5P_LIBRARIES', async () => {
    const hz = await JSZip.loadAsync(rvBlob);
    const hj = JSON.parse(await hz.file('h5p.json').async('string'));
    hj.preloadedDependencies[0].minorVersion = 8;
    hz.file('h5p.json', JSON.stringify(hj));
    const bad = await swapH5p(built.mbz, rvHash, await hz.generateAsync({ type: 'nodebuffer' }));
    const v = await V.validateMbzV3(bad, built.expectations);
    assert(v.issues.some((i) => i.code === 'H5P_LIBRARIES' && i.where === rv.idnumber), JSON.stringify(v.issues.slice(0, 4)));
  });

  await check('negativo: QuestionSet con su carpeta delta H5P.QuestionSet-1.21 (formato ≤ 3.13.0) → H5P_LIBRARIES + H5P_PARTIAL_LIBRARY_CLOSURE', async () => {
    const zq = await JSZip.loadAsync(builtQs.mbz);
    const fq = await zq.file('files.xml').async('string');
    const mbq = await zq.file('moodle_backup.xml').async('string');
    let qs = null;
    for (const m of mbq.matchAll(/<modulename>h5pactivity<\/modulename>[\s\S]*?<directory>([^<]+)<\/directory>/g)) {
      const mod = await zq.file(`${m[1]}/module.xml`).async('string');
      const idn = /<idnumber>([^<]*)<\/idnumber>/.exec(mod)[1];
      if (!/:activity$/.test(idn)) continue;
      const { hash, blob } = await pkgOf(zq, fq, m[1]);
      const hj = JSON.parse(await (await JSZip.loadAsync(blob)).file('h5p.json').async('string'));
      if (hj.mainLibrary === 'H5P.QuestionSet') { qs = { idnumber: idn, hash, blob }; break; }
    }
    assert(qs, 'sin QuestionSet en el fixture');
    eq(Object.keys((await JSZip.loadAsync(qs.blob)).files).filter((n) => n !== 'h5p.json' && !n.startsWith('content')), [], 'QuestionSet 1.21 solo contenido');
    assert((await V.validateMbzV3(builtQs.mbz, builtQs.expectations)).ok, 'curso con QuestionSet limpio');
    eq(builtQs.summary.restore && builtQs.summary.restore.as, 'site_library_pack', 'QuestionSet 1.21 ⇒ requisito pack v3');
    const hz = await JSZip.loadAsync(qs.blob);
    for (const [rel, data] of Object.entries(store.libraryFiles('H5P.QuestionSet-1.21'))) hz.file(`H5P.QuestionSet-1.21/${rel}`, data);
    const bad = await swapH5p(builtQs.mbz, qs.hash, await hz.generateAsync({ type: 'nodebuffer' }));
    const v = await V.validateMbzV3(bad, builtQs.expectations);
    const mine = v.issues.filter((i) => i.where === qs.idnumber).map((i) => i.code);
    assert(mine.includes('H5P_LIBRARIES') && mine.includes('H5P_PARTIAL_LIBRARY_CLOSURE'), JSON.stringify(v.issues.slice(0, 6)));
  });

  await check('determinismo: mismo input ⇒ mismo sha256 de cada .h5p y del .mbz', async () => {
    const again = await B.buildDynamicMbzV3(PF.packagingInput(distRoot, CFG));
    eq(sha256(again.mbz), sha256(built.mbz), '.mbz');
    eq(again.summary.h5pPackages.map((p) => p.sha1), built.summary.h5pPackages.map((p) => p.sha1), '.h5p');
  });

  console.log(`\n${passed} ok, ${failures} fallos`);
  process.exit(failures ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
