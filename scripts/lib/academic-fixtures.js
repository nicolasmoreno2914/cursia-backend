'use strict';
// Fase 3 — microcurrículos FICTICIOS para las pruebas del Contexto académico (sin proveedores, USD 0).
// Se generan al vuelo en TXT/MD, DOCX (zip mínimo con estilos de título y tablas) y PDF (pdfkit), con bytes
// deterministas (fechas fijas), para que cada formato pase por su lector real.
//
//   consistent    — «Contabilidad de Costos», 64 h (32 acompañamiento + 32 autónomo), 5 unidades vinculadas a 6 RA,
//                   2 competencias, evaluación 100 %, bibliografía, restricciones.
//   inconsistent  — mismas secciones con problemas: total 64 h vs componentes 48 h, pesos 90 %, RA6 sin contenido,
//                   un resultado casi duplicado, dos totales distintos en el documento.
//   minimal       — solo asignatura y una lista de contenidos (todo lo demás debe quedar «missing»).
const JSZip = require('jszip');
const PDFDocument = require('pdfkit');

const FIXED_DATE = new Date('2026-01-15T12:00:00Z');

function blocks(variant = 'consistent') {
  const bad = variant === 'inconsistent';
  if (variant === 'mini') {
    // Curso chico para generar de punta a punta en el E2E (2 unidades × 2 contenidos, 3 RA, 1 competencia, 16 h).
    return [
      { t: 'title', text: 'MICROCURRÍCULO' },
      { t: 'kv', key: 'Asignatura', value: 'Inspección de circuitos hidráulicos' },
      { t: 'kv', key: 'Programa', value: 'Técnico laboral en mantenimiento industrial' },
      { t: 'kv', key: 'Intensidad horaria total', value: '16 horas' },
      { t: 'h', text: 'Perfil del estudiante' },
      { t: 'p', text: 'Técnicos de mantenimiento con experiencia en planta concentradora.' },
      { t: 'h', text: 'Competencias' },
      { t: 'p', text: 'CE1. Mantiene sistemas hidráulicos de planta de forma segura.' },
      { t: 'h', text: 'Resultados de aprendizaje' },
      { t: 'p', text: 'RA1. Reconocer los componentes de un circuito hidráulico y su función.' },
      { t: 'p', text: 'RA2. Medir la presión del circuito en el puerto de prueba con el manómetro.' },
      { t: 'p', text: 'RA3. Ajustar la válvula de alivio al valor de placa del equipo.' },
      { t: 'h', text: 'Contenidos' },
      { t: 'table', rows: [
        ['Unidad', 'Contenidos', 'Horas', 'RA'],
        ['Unidad 1: Componentes del circuito', 'Bombas y actuadores; Lectura de presión en el puerto de prueba', '8', 'RA1, RA2'],
        ['Unidad 2: Ajuste del circuito', 'Válvulas de alivio; Ajuste al valor de placa', '8', 'RA3'],
      ] },
      { t: 'h', text: 'Evaluación' },
      { t: 'li', text: 'Cuestionario de componentes (RA1) — 30 %' },
      { t: 'li', text: 'Práctica de medición y ajuste (RA2, RA3) — 70 %' },
      { t: 'h', text: 'Bibliografía' },
      { t: 'li', text: 'Parr, A. (2011). Hydraulics and Pneumatics. Elsevier.' },
    ];
  }
  if (variant === 'minimal') {
    return [
      { t: 'title', text: 'Guía de la asignatura' },
      { t: 'kv', key: 'Asignatura', value: 'Seguridad y salud en el trabajo' },
      { t: 'h', text: 'Contenidos' },
      { t: 'li', text: 'Marco normativo de la seguridad y salud en el trabajo' },
      { t: 'li', text: 'Identificación de peligros y valoración de riesgos' },
      { t: 'li', text: 'Plan de emergencias' },
    ];
  }
  const out = [
    { t: 'title', text: 'MICROCURRÍCULO' },
    { t: 'table', rows: [
      ['Asignatura', 'Contabilidad de Costos', 'Código', 'CON-204'],
      ['Programa', 'Tecnología en Gestión Contable y Financiera', 'Semestre', 'IV'],
      ['Créditos', '2', 'Modalidad', 'Virtual'],
      ['Intensidad horaria total', '64 horas', 'Semanas', '16'],
    ] },
    { t: 'h', text: '1. Descripción' },
    { t: 'p', text: 'La asignatura desarrolla los fundamentos de la contabilidad de costos para empresas manufactureras y de servicios, con énfasis en la determinación del costo unitario y el uso de la información de costos en la toma de decisiones.' },
    { t: 'h', text: '2. Perfil del estudiante' },
    { t: 'p', text: 'Estudiantes de cuarto semestre de la Tecnología en Gestión Contable y Financiera, con formación en contabilidad general y manejo básico de hojas de cálculo; muchos trabajan en áreas administrativas de pequeñas empresas.' },
    { t: 'h', text: 'Conocimientos previos' },
    { t: 'li', text: 'Contabilidad general (ciclo contable completo)' },
    { t: 'li', text: 'Matemática financiera básica' },
    { t: 'li', text: 'Manejo de hoja de cálculo' },
    { t: 'h', text: '3. Objetivo general' },
    { t: 'p', text: 'Aplicar los sistemas de costeo por órdenes y por procesos para determinar el costo de productos y servicios y apoyar decisiones gerenciales.' },
    { t: 'h', text: '4. Competencias' },
    { t: 'p', text: 'CE1. Determina el costo de los productos y servicios de una organización aplicando la normativa contable vigente.' },
    { t: 'p', text: 'CE2. Analiza la información de costos para apoyar la toma de decisiones gerenciales.' },
    { t: 'h', text: '5. Resultados de aprendizaje' },
    { t: 'p', text: 'RA1. Identificar los elementos del costo (materiales, mano de obra y costos indirectos) y su clasificación.' },
    { t: 'p', text: 'RA2. Calcular el costo de los materiales y de la mano de obra aplicando métodos de valoración de inventarios y la liquidación de la nómina.' },
    { t: 'p', text: 'RA3. Aplicar el sistema de costeo por órdenes de producción en una empresa manufacturera.' },
    { t: 'p', text: 'RA4. Aplicar el sistema de costeo por procesos con producción equivalente.' },
    { t: 'p', text: 'RA5. Analizar el punto de equilibrio y la relación costo-volumen-utilidad para tomar decisiones.' },
    { t: 'p', text: 'RA6. Elaborar un informe de costos que soporte una decisión gerencial.' },
    ...(bad ? [{ t: 'p', text: 'RA7. Aplicar el sistema de costeo por procesos con la producción equivalente.' }] : []),
    { t: 'h', text: '6. Contenidos' },
    { t: 'table', rows: [
      ['Unidad', 'Contenidos', 'Horas', 'RA'],
      ['Unidad 1: Fundamentos de la contabilidad de costos', 'Concepto y objetivos de la contabilidad de costos; Elementos del costo; Clasificación de los costos; Estado de costo de productos vendidos', '12', 'RA1'],
      ['Unidad 2: Costeo de materiales y mano de obra', 'Métodos de valoración de inventarios (PEPS y promedio ponderado); Control de materiales; Liquidación de nómina y prestaciones sociales; Asignación de la mano de obra', '14', 'RA2'],
      ['Unidad 3: Costos indirectos y costeo por órdenes', 'Costos indirectos de fabricación; Tasas predeterminadas; Hoja de costos por orden de producción; Análisis de variaciones', '14', 'RA3'],
      ['Unidad 4: Costeo por procesos', 'Producción equivalente; Informe de cantidades y costos; Costeo por departamentos', '12', bad ? 'RA4, RA7' : 'RA4'],
      ['Unidad 5: Análisis costo-volumen-utilidad', 'Margen de contribución; Punto de equilibrio; Toma de decisiones con información de costos', '12', bad ? 'RA5' : 'RA5, RA6'],
    ] },
    { t: 'h', text: '7. Intensidad horaria' },
    { t: 'kv', key: 'Horas de acompañamiento docente', value: bad ? '24 horas' : '32 horas' },
    { t: 'kv', key: 'Horas de trabajo autónomo', value: bad ? '24 horas' : '32 horas' },
    { t: 'kv', key: 'Horas semanales', value: '4' },
    { t: 'h', text: '8. Metodología' },
    { t: 'p', text: 'Aprendizaje basado en problemas con casos de empresas manufactureras de la región. Cada unidad combina lecturas guiadas, talleres prácticos en hoja de cálculo y la discusión de casos en foros.' },
    { t: 'h', text: '9. Evaluación' },
    { t: 'li', text: 'Taller de elementos del costo (RA1) — 15 %' },
    { t: 'li', text: 'Caso de costeo de materiales y nómina (RA2) — 20 %' },
    { t: 'li', text: 'Proyecto de costeo por órdenes de producción (RA3) — 25 %' },
    { t: 'li', text: bad ? 'Ejercicio de costeo por procesos (RA4) — 5 %' : 'Ejercicio de costeo por procesos (RA4) — 15 %' },
    { t: 'li', text: 'Informe final de costos y punto de equilibrio (RA5, RA6) — 25 %' },
    { t: 'h', text: '10. Bibliografía' },
    { t: 'li', text: 'Polimeni, R., Fabozzi, F., Adelberg, A. y Kole, M. (2018). Contabilidad de costos: conceptos y aplicaciones para la toma de decisiones gerenciales. McGraw-Hill.' },
    { t: 'li', text: 'García Colín, J. (2014). Contabilidad de costos (4.ª ed.). McGraw-Hill.' },
    { t: 'li', text: 'Horngren, C., Datar, S. y Rajan, M. (2012). Contabilidad de costos: un enfoque gerencial. Pearson.' },
    { t: 'li', text: 'Ramírez Padilla, D. (2013). Contabilidad administrativa. McGraw-Hill.' },
    { t: 'h', text: '11. Restricciones institucionales' },
    { t: 'li', text: 'El curso se ofrece en modalidad virtual en el campus Moodle de la institución.' },
    { t: 'li', text: 'Las actividades evaluativas son individuales.' },
  ];
  if (bad) out.push({ t: 'h', text: 'Total de horas' }, { t: 'p', text: '48 horas' });
  return out;
}

function toText(variant, { markdown = false } = {}) {
  const lines = [];
  for (const b of blocks(variant)) {
    if (b.t === 'title') lines.push(markdown ? `# ${b.text}` : b.text);
    else if (b.t === 'h') lines.push('', markdown ? `## ${b.text}` : b.text);
    else if (b.t === 'kv') lines.push(`${b.key}: ${b.value}`);
    else if (b.t === 'p') lines.push(b.text);
    else if (b.t === 'li') lines.push(`- ${b.text}`);
    else if (b.t === 'table') {
      if (markdown) {
        b.rows.forEach((r, i) => { lines.push(`| ${r.join(' | ')} |`); if (i === 0) lines.push(`|${r.map(() => '---').join('|')}|`); });
      } else {
        for (const r of b.rows) {
          // Texto plano: las filas clave | valor de la ficha se escriben como «Clave: valor».
          if (r.length === 4 && !/^Unidad/.test(r[0])) { lines.push(`${r[0]}: ${r[1]}`, `${r[2]}: ${r[3]}`); continue; }
          lines.push(r.join(' | '));
        }
      }
    }
  }
  return Buffer.from(lines.join('\n') + '\n', 'utf8');
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const para = (text, { style = null, list = false } = {}) =>
  `<w:p>${style || list ? `<w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ''}${list ? '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>' : ''}</w:pPr>` : ''}<w:r><w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`;

async function toDocx(variant) {
  const body = blocks(variant).map((b) => {
    if (b.t === 'title') return para(b.text, { style: 'Title' });
    if (b.t === 'h') return para(b.text, { style: 'Heading1' });
    if (b.t === 'kv') return para(`${b.key}: ${b.value}`);
    if (b.t === 'p') return para(b.text);
    if (b.t === 'li') return para(b.text, { list: true });
    if (b.t === 'table') {
      return `<w:tbl><w:tblPr/>${b.rows.map((r) => `<w:tr>${r.map((c) => `<w:tc><w:tcPr/>${c.split('; ').map((x) => para(x)).join('')}</w:tc>`).join('')}</w:tr>`).join('')}</w:tbl>`;
    }
    return '';
  }).join('');
  const zip = new JSZip();
  const opt = { date: FIXED_DATE };
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>', opt);
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>', opt);
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr/></w:body></w:document>`, opt);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

function toPdf(variant) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margin: 56, info: { CreationDate: FIXED_DATE, ModDate: FIXED_DATE, Title: 'Microcurrículo', Producer: 'cursia-fixtures', Creator: 'cursia-fixtures' } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    let page = 1;
    const footer = () => doc.fontSize(8).text('Institución Universitaria Ficticia — Microcurrículo', 56, 740, { lineBreak: false });
    footer();
    doc.x = 56; doc.y = 56;
    const newPageIfNeeded = () => { if (doc.y > 660) { doc.addPage(); page++; footer(); doc.x = 56; doc.y = 56; } };
    for (const b of blocks(variant)) {
      newPageIfNeeded();
      if (b.t === 'title') doc.fontSize(16).text(b.text);
      else if (b.t === 'h') doc.moveDown(0.5).fontSize(12).text(b.text);
      else if (b.t === 'kv') doc.fontSize(10).text(`${b.key}: ${b.value}`);
      else if (b.t === 'p') doc.fontSize(10).text(b.text, { width: 500 });
      else if (b.t === 'li') doc.fontSize(10).text(`• ${b.text}`, { width: 500 });
      else if (b.t === 'table' && b.rows[0][0] === 'Unidad') {
        // PDF: la tabla de contenidos como «Unidad N: título (H horas) — RA» + viñetas (formato común en PDF).
        for (const r of b.rows.slice(1)) {
          newPageIfNeeded();
          doc.fontSize(10).text(`${r[0]} (${r[2]} horas) — ${r[3]}`, { width: 500 });
          for (const c of r[1].split('; ')) doc.text(`• ${c}`, { width: 500 });
        }
      } else if (b.t === 'table') {
        for (const r of b.rows) {
          newPageIfNeeded();
          if (r.length === 4 && !/^Unidad/.test(r[0])) doc.fontSize(10).text(`${r[0]}: ${r[1]}`).text(`${r[2]}: ${r[3]}`);
          else doc.fontSize(10).text(r.join(' | '), { width: 500 });
        }
      }
    }
    doc.end();
  });
}

/** Buffer de cualquier formato: 'txt' | 'md' | 'docx' | 'pdf'. */
async function fixture(variant, format) {
  if (format === 'txt') return toText(variant);
  if (format === 'md') return toText(variant, { markdown: true });
  if (format === 'docx') return toDocx(variant);
  if (format === 'pdf') return toPdf(variant);
  throw new Error(`formato desconocido ${format}`);
}

module.exports = { blocks, fixture, toText, toDocx, toPdf };
