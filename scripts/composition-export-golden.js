#!/usr/bin/env node
/* eslint-disable */
// T3 (r57) — huellas de compatibilidad de la composición por necesidad: dry-run COMPLETO (distribuidor, Manifest
// materializado, FinOps, proyección) de los fixtures de composición SIN `learningPlan.composition`. Se calculan con el
// build ANTERIOR a T3 (BE 5ec26c8) y check-composition-formats.js C8 exige que el build actual dé las mismas.
// Sin red, sin IA, sin DB.
//
// Uso: node scripts/composition-export-golden.js <distRoot> [--write]
'use strict';

const path = require('path');
const fs = require('fs');
const C = require('./lib/composition-fixtures');

function digests(distRoot) {
  const P = C.load(distRoot, 'modules/pedagogy/index.js');
  const out = {};
  const fixedShape = { noContentAdditions: true, sources: {} };
  for (const fx of [...C.COURSES, ...C.VIDEO_40H]) {
    const s = C.plainStructure(C.structureOf(fx));
    const variants = {
      noPlan: { profile: C.profileOf(fx, { learningPlan: false }), req: fixedShape },
      planNoComposition: { profile: C.profileOf(fx, { composition: null }), req: fixedShape },
      planNoCompositionRecommended: { profile: C.profileOf(fx, { composition: null, designPreferences: { audiovisual: 'recommended' } }), req: fixedShape },
      planNoCompositionFree: { profile: C.profileOf(fx, { composition: null }), req: null },
    };
    for (const [k, v] of Object.entries(variants)) {
      const dr = P.runPedagogyDryRun({ structure: s, profile: v.profile, activityTypeRules: 2, requirementConstraints: v.req });
      out[`${fx.id}.${k}`] = C.sha(dr);
    }
  }
  return out;
}

if (require.main === module) {
  const distRoot = path.resolve(process.cwd(), process.argv.slice(2).find((a) => !a.startsWith('--')) || 'dist');
  const d = digests(distRoot);
  if (process.argv.includes('--write')) {
    const file = path.join(__dirname, 'fixtures', 'composition', 'golden-off.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // r79.1: re-fijado A PROPÓSITO con el costo del nivel de 120 reforzado (11 unidades); con el costo anterior, las 44
    // huellas de BE 5ec26c8 siguen iguales byte a byte (verificado al hacer el cambio).
    fs.writeFileSync(file, JSON.stringify({ computedWith: 'BE 5ec26c8 (antes de T3); r79.1: costo del nivel de 120 reforzado', digests: d }, null, 2) + '\n');
    console.log(`escrito ${file} (${Object.keys(d).length} huellas)`);
  } else console.log(JSON.stringify(d, null, 2));
}

module.exports = { digests };
