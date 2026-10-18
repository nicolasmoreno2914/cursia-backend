/* eslint-disable */
// T4/T5 (r57) — fixtures genéricos de entrega (Tarea) y archivos de trabajo. Sin red, sin proveedores, determinístico.
'use strict';
const path = require('path');
const crypto = require('crypto');
const JSZip = require('jszip');
const PF = require('./v21-packaging-fixtures');

const ZIP_DATE = new Date(Date.UTC(2026, 0, 1, 0, 0, 0));
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

/** Curso de ejemplo de Fase 2: 4 AA (60/30/120 práctica/90) en 5 capítulos, examen por módulo y final. */
const APP_MODULES = [
  { examEnabled: true, chapters: [{ video: true, activity: true, application: 60 }, { video: false, activity: true, application: 30 }, { practice: true, activity: true, application: 120 }] },
  { examEnabled: false, chapters: [{ video: true, activity: true }, { video: false, activity: false, application: 90 }] },
];

function courseInput(distRoot, o = {}) {
  return PF.packagingInput(distRoot, { engine: 'h5p', finalExam: true, courseId: o.courseId || 640, modules: o.modules || APP_MODULES, ...(o.moodleVersion ? { moodleVersion: o.moodleVersion } : {}) });
}

function clone(input) {
  return {
    ...input,
    assessmentProfile: JSON.parse(JSON.stringify(input.assessmentProfile)),
    contents: { ...input.contents, ...(input.contents.practiceFiles ? { practiceFiles: new Map([...input.contents.practiceFiles].map(([k, v]) => [k, Buffer.from(v)])) } : {}) },
  };
}

function withProfile(input, profile, practiceFiles) {
  const c = { ...input, assessmentProfile: JSON.parse(JSON.stringify(profile)), contents: { ...input.contents } };
  delete c.contents.practiceFiles;
  if (practiceFiles && practiceFiles.size) c.contents.practiceFiles = practiceFiles;
  return c;
}

/**
 * Perfil con entrega como Tarea. `graded` + `category: 'applications'` → pesos 25/20/35/20 (práctica / AA / módulo /
 * final); en «practice» o formativa, los pesos del perfil base.
 */
function deliveryProfile(base, o = {}) {
  const graded = o.graded !== false;
  const category = o.category || 'applications';
  const own = graded && category === 'applications';
  const w = base.categoryWeights;
  return {
    ...JSON.parse(JSON.stringify(base)),
    categoryWeights: own ? { ...w, practice: 25, moduleExams: 35, finalExam: 20, applications: 20 } : { ...w },
    applicationDelivery: {
      mode: o.mode || 'assign',
      ...(o.chapterModes ? { chapterModes: o.chapterModes } : {}),
      submission: { onlineText: true, file: true, maxFiles: 3, maxBytes: 10 * 1024 * 1024, fileTypes: ['.pdf', '.docx', '.xlsx'], ...(o.submission || {}) },
      dueOffsetDays: o.dueOffsetDays === undefined ? 14 : o.dueOffsetDays,
      grading: graded ? { graded: true, maxGrade: o.maxGrade || 100, gradepass: o.gradepass === undefined ? 60 : o.gradepass, category, rubric: o.rubric !== false } : { graded: false },
    },
  };
}

/** DOCX mínimo válido (Word / LibreOffice lo abren): una página con título y consigna. */
async function minimalDocx(title, lines) {
  const p = (t, bold) => `<w:p><w:r>${bold ? '<w:rPr><w:b/></w:rPr>' : ''}<w:t xml:space="preserve">${t.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</w:t></w:r></w:p>`;
  const files = [
    ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'],
    ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'],
    ['word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${p(title, true)}${lines.map((l) => p(l)).join('')}</w:body></w:document>`],
  ];
  const z = new JSZip();
  for (const [n, d] of files) z.file(n, d, { date: ZIP_DATE, createFolders: false });
  return z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/** Recursos de muestra (formas válidas) para validación pura. */
function sampleResources(chapterId) {
  return [
    { id: 'taller-datos', chapterId, title: 'Datos del taller', instructions: 'Completa la columna Total.', relation: 'application', source: { kind: 'artifact', artifactId: 'aaaaaaaa-0000-4000-8000-000000000001', filename: 'datos-taller.xlsx', mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', bytes: 1200, sha256: 'a'.repeat(64) } },
    { id: 'plantilla-informe', chapterId, title: 'Plantilla del informe', instructions: '', relation: 'application', source: { kind: 'artifact', artifactId: 'aaaaaaaa-0000-4000-8000-000000000002', filename: 'plantilla-informe.docx', mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', bytes: 900, sha256: 'b'.repeat(64) } },
    { id: 'guia-lectura', chapterId, title: 'Guía de lectura', instructions: 'Léela antes del taller.', relation: 'chapter', source: { kind: 'artifact', artifactId: 'aaaaaaaa-0000-4000-8000-000000000003', filename: 'guia-lectura.pdf', mimetype: 'application/pdf', bytes: 700, sha256: 'c'.repeat(64) } },
    { id: 'ventas-csv', chapterId, title: 'Ventas del trimestre', instructions: '', relation: 'application', source: { kind: 'table', format: 'csv', filename: 'ventas.csv', columns: ['Mes', 'Ventas'], rows: [['Enero', 120], ['Febrero', 95]] } },
  ];
}

/**
 * Curso con archivos de trabajo: en la 1.ª AA un XLSX, un DOCX (subidos, de la AA), un PDF (subido, del capítulo) y un
 * CSV de tabla (de la AA); en la 2.ª AA un XLSX generado de tabla (de la AA). Devuelve el insumo del builder y los bytes.
 */
async function withPracticeFiles(distRoot, input, profile, appChapterIds) {
  const PFILES = require(path.join(distRoot, 'package/v3/practice-files.js'));
  const MEDIA = require(path.join(distRoot, 'package/v3/synthetic-media.js'));
  const xlsx = await PFILES.tableToXlsx(['Producto', 'Cantidad', 'Precio unitario', 'Total'], [['Cuaderno', 12, 3.5, null], ['Lápiz', 40, 0.8, null], ['Carpeta', 7, 2.25, null]]);
  const docx = await minimalDocx('Plantilla del informe', ['1. Situación', '2. Análisis', '3. Propuesta']);
  const pdf = MEDIA.syntheticPdf(2);
  const up = (id, chapterId, title, instructions, relation, filename, mimetype, buf, n) => ({
    id, chapterId, title, instructions, relation,
    source: { kind: 'artifact', artifactId: `aaaaaaaa-0000-4000-8000-00000000000${n}`, filename, mimetype, bytes: buf.length, sha256: sha(buf) },
  });
  const [c1, c2] = appChapterIds;
  const resources = [
    up('taller-datos', c1, 'Datos del taller', 'Completa la columna Total y guarda el archivo con tu nombre.', 'application', 'datos-taller.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', xlsx, 1),
    up('plantilla-informe', c1, 'Plantilla del informe', 'Escribe tu informe sobre esta plantilla.', 'application', 'plantilla-informe.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', docx, 2),
    up('guia-lectura', c1, 'Guía de lectura', 'Léela antes del taller.', 'chapter', 'guia-lectura.pdf', 'application/pdf', pdf, 3),
    { id: 'ventas-csv', chapterId: c1, title: 'Ventas del trimestre', instructions: 'Ábrelo en una hoja de cálculo.', relation: 'application', source: { kind: 'table', format: 'csv', filename: 'ventas.csv', columns: ['Mes', 'Ventas'], rows: [['Enero', 120], ['Febrero', 95], ['Marzo', 133]] } },
    { id: 'inventario', chapterId: c2, title: 'Inventario de la bodega', instructions: 'Calcula el valor total del inventario.', relation: 'application', source: { kind: 'table', format: 'xlsx', filename: 'inventario.xlsx', columns: ['Artículo', 'Unidades', 'Costo'], rows: [['Caja', 30, 1.2], ['Cinta', 12, 0.5]] } },
  ];
  const files = new Map([['taller-datos', xlsx], ['plantilla-informe', docx], ['guia-lectura', pdf]]);
  const prof = { ...JSON.parse(JSON.stringify(profile)), practiceResources: resources };
  return { input: withProfile(input, prof, files), bytes: { xlsx, docx, pdf } };
}

module.exports = { APP_MODULES, courseInput, clone, withProfile, deliveryProfile, minimalDocx, sampleResources, withPracticeFiles, sha };
