#!/usr/bin/env node
/* eslint-disable */
// LOOP 8.6B · Genera la fixture del harness del frontend (src/js/__harness__/fixtures/requirements-backend-v1.json)
// con la salida REAL de document-requirements.ts sobre documentos SINTÉTICOS. Regenerarla si cambia el contrato.
//   node scripts/gen-requirements-fe-fixture.js <ruta-al-frontend> [path/to/dist]
'use strict';
const fs = require('fs');
const path = require('path');

const fe = process.argv[2];
if (!fe) { console.error('uso: node scripts/gen-requirements-fe-fixture.js <ruta-al-frontend> [path/to/dist]'); process.exit(1); }
const dist = path.resolve(process.cwd(), process.argv[3] || 'dist');
const D = path.join(dist, 'modules/academic-context');
const RX = require(path.join(D, 'requirements/requirements-extractor.js'));
const DR = require(path.join(D, 'requirements/document-requirements.js'));
const TS = require(path.join(D, 'extract/text-sources.js'));

const ex = (t) => RX.extractRequirements(TS.readText(Buffer.from(t, 'utf8'), 'text/plain').lines, 'D1');
// Documentos SINTÉTICOS (los mismos de check-loop86b-requirements-readonly.js).
const SML = 'Tamaños de curso\nTAMAÑO HORAS ESTRUCTURA\nS\n1 h/sem\n20–22 h 3 módulos\n× 3 capítulos\nM\n2 h/sem\n40–44 h 3 módulos\n× 4 capítulos\nL\n3 h/sem\n60–66 h 4 módulos\n× 5 capítulos\nLa institución elegirá un tamaño por asignatura.';
const FULL = 'El curso deberá tener 4 módulos con 5 capítulos por módulo. Cada capítulo tendrá 2 videos. Cada módulo tendrá una Actividad de Aplicación. Se realizarán 3 evaluaciones parciales y 1 evaluación final. La intensidad horaria total será de 64 horas.';
const AT = '2026-10-07T00:00:00.000Z';

const docs = [{ id: 'D1', name: 'propuesta-tamaños (sintético).txt', sha256: 's1' }];
const e1 = DR.storedEntry(docs, ex(SML), AT);
const gid = e1.extraction.groups.find((g) => g.relation === 'oneOf').id;
const viewNone = DR.buildRequirementsView([e1], null, docs);
const viewM = DR.buildRequirementsView([e1], { key: e1.key, options: { [gid]: 'M' } }, docs);
const design = (shape, targetHours, hoursSource) => ({
  modules: shape.map((n) => ({ examEnabled: true, chapters: Array.from({ length: n }, (_, i) => ({ kind: 'content', proposed: false, videoEnabled: true, activityEnabled: true, applicationMinutes: i === 0 ? 60 : null, hours: 3 })) })),
  evaluations: shape.length + 1, targetHours, hoursSource, structureByTeacher: false, audiovisualByTeacher: false, applicationByTeacher: false,
});
const applyingM = viewM.items.filter((i) => i.applies);
const docs2 = [{ id: 'D1', name: 'microcurrículo (sintético).docx', sha256: 's2' }];
const e2 = DR.storedEntry(docs2, ex(FULL), AT);
const viewFull = DR.buildRequirementsView([e2], null, docs2);

const out = {
  _note: 'Salida REAL del backend (document-requirements.ts) sobre documentos SINTÉTICOS. Regenerar con orbia-backend: node scripts/gen-requirements-fe-fixture.js <frontend>.',
  viewNone,
  viewM,
  checksMet: DR.compareRequirements(applyingM, design([4, 4, 4], 42, 'proposed')),
  checksTeacherHours: DR.compareRequirements(applyingM, design([4, 4, 4], 48, 'adjusted')),
  checksCursiaStructure: DR.compareRequirements(applyingM, design([5, 5, 5, 5], 64, 'proposed')),
  viewFull,
  checksFull: DR.compareRequirements(viewFull.items.filter((i) => i.applies), design([5, 5, 5, 5], 64, 'document')),
  viewStale: DR.buildRequirementsView([e1], null, [{ sha256: 'otro' }]),
  viewEmpty: DR.buildRequirementsView([DR.storedEntry(docs, ex('Curso de introducción.'), AT)], null, docs),
};
const target = path.join(path.resolve(fe), 'src/js/__harness__/fixtures/requirements-backend-v1.json');
fs.writeFileSync(target, JSON.stringify(out, null, 1) + '\n');
console.log(`fixture escrita: ${target}`);
