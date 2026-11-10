/* eslint-disable */
// r107 B11 · fixture V1 armado con el BUILDER REAL (`MbzBuilderService.buildMbz`, la ruta backend del V1): 3 módulos ×
// 3 capítulos con el patrón completo por capítulo ([📊 Presentación Cap N] → [📖 Capítulo N] → [🎥 hvp] → [🎯 Practicar —
// Cap N] → [🎮 scorm]), exámenes GIFT por unidad + final, Libro Guía HTML con portada, índice y una página por sección
// (formato de buildLibroHTML). Contenido sintético (sin IA, sin red, USD 0). `opts.hvp=false` / `opts.gamma=false` dan
// las variantes viejas del V1.
'use strict';
const path = require('path');

const MODS = [
  { n: 'Fundamentos del servicio', caps: ['Escucha activa', 'Preguntas que ayudan', 'Cierre de la conversación'] },
  { n: 'Casos difíciles', caps: ['Clientes molestos', 'Reclamos por escrito', 'Seguimiento del caso'] },
  { n: 'Mejora continua', caps: ['Indicadores del servicio', 'Retroalimentación del equipo', 'Plan de mejora'] },
];
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const PARA = 'El equipo revisa cada caso con datos concretos del servicio, compara alternativas y deja registrado lo que funcionó para aplicarlo en la siguiente atención con el cliente.';

function libroHtml(mods) {
  let toc = '<div class="te"><span class="tt">Presentación del libro guía</span><span class="td"></span></div>';
  let body = '';
  let n = 0;
  mods.forEach((m, mi) => {
    toc += `<div class="te tm"><span class="tt"><strong>MÓDULO ${mi + 1} – ${esc(m.n)}</strong></span><span class="td"></span></div>`;
    body += `<div class="page"><div class="pg-hd"><div class="pg-hd-l">Libro Guía · Curso</div></div><h1>Módulo ${mi + 1}: ${esc(m.n)}</h1><p>${PARA}</p><div class="pg-ft">Libro Guía · Curso</div></div>`;
    m.caps.forEach((c) => {
      n++;
      toc += `<div class="te tc"><span class="tt">Capítulo ${n}: ${esc(c)}</span><span class="td"></span></div>`;
      body += `<div class="page"><div class="pg-hd"><div class="pg-hd-l">Libro Guía · Curso</div></div><h1>Capítulo ${n}: ${esc(c)}</h1><h2>${n}.1 Idea central</h2><p>${PARA} ${PARA}</p><h2>${n}.2 Práctica</h2><p>${PARA}</p><div class="pg-ft">Libro Guía · Curso</div></div>`;
    });
  });
  toc += '<div class="te"><span class="tt">Recursos y Bibliografía</span><span class="td"></span></div>';
  body += `<div class="page"><h1>Recursos y Bibliografía</h1><p>${PARA}</p></div>`;
  return `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><title>Libro Guía</title><style>.page{padding:2cm}</style></head><body><div class="page"><div class="cover"><h1>Libro Guía</h1></div><div class="toc-w">${toc}</div></div>${body}</body></html>`;
}

const page = (t) => `<div style="background:#0A1628;border-radius:20px;padding:32px;color:#E2E6F3;font-family:'Segoe UI',Arial,sans-serif;"><h2 style="color:#E2E6F3;">${esc(t)}</h2><p style="color:#E2E6F3;">${PARA}</p></div>`;
const game = (n) => `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Juego ${n}</title></head><body><div id="g">Juego del capítulo ${n}</div><script>window.salas=[1,2,3,4,5];function iniciar(){return true}</script></body></html>`;
const gift = (u, k) => Array.from({ length: k }, (_, i) => `::U${u}-${String(i + 1).padStart(2, '0')}::¿Qué conviene revisar en el caso ${i + 1}? {\n  =Los datos del caso\n  ~La opinión de otro\n  ~El resultado de otro año\n  ~Un dato sin fuente\n}`).join('\n\n');
const hvpJson = (n) => ({ interactiveVideo: { video: { files: [{ path: `https://www.youtube.com/watch?v=Vid${n}abcdef`, mime: 'video/YouTube' }], startScreenOptions: {} }, assets: { interactions: [
  { action: { library: 'H5P.MultiChoice 1.16', params: { question: '<p>¿Qué muestra el video?</p>', answers: [{ text: 'El caso del cliente', correct: true }, { text: 'Otro tema', correct: false }], behaviour: { type: 'auto' } } }, duration: { from: 30, to: 40 } },
] } } });

async function v1BuilderCourse(DIST, opts = {}) {
  const { MbzBuilderService } = require(path.join(DIST, 'package/mbz-builder.service.js'));
  const SM = require(path.join(DIST, 'package/v3/synthetic-media.js'));
  const withHvp = opts.hvp !== false;
  const withGamma = opts.gamma !== false;
  const caps = MODS.flatMap((m) => m.caps).map((t, i) => ({ n: i + 1, t }));
  const F = {
    'seccion0_bienvenida.html': page('Bienvenida'), 'seccion0_introduccion.html': page('Qué aprenderás'), 'seccion0_metodologia.html': page('Metodología'),
    'seccion1_ruta_aprendizaje.html': page('Ruta de aprendizaje'), 'seccion1_libro_guia.html': page('Libro Guía') + '<p><a href="#libro-guia">Descargar Libro Guía</a></p>',
    'libro_guia_completo.html': libroHtml(MODS),
    'seccion1_audiolibro.html': page('Audiolibro') + '<audio controls><source src="audiolibro.mp3" type="audio/mpeg"></audio>',
    'examen_final_descripcion.html': page('Examen final'), 'examen_final.gift': gift('F', 10),
  };
  for (const c of caps) {
    F[`cap${c.n}_video_interactivo.html`] = page(`Video del capítulo ${c.n}`);
    F[`cap${c.n}_descripcion_actividad.html`] = page(`Juego del capítulo ${c.n}`);
    F[`scorm_cap${c.n}_index.html`] = game(c.n);
  }
  for (const u of [1, 2, 3]) { F[`examen_unidad${u}_descripcion.html`] = page(`Examen unidad ${u}`); F[`examen_unidad${u}.gift`] = gift(u, 6); }
  const hvpData = {}; const gammaData = {}; const gammaPdfs = {}; const gammaSlideImages = {};
  for (const c of caps) {
    if (withHvp) hvpData[c.n] = { hvpJson: hvpJson(c.n), capName: c.t, youtubeUrl: `https://www.youtube.com/watch?v=Vid${c.n}abcdef` };
    if (withGamma) { gammaData[c.n] = { embedUrl: 'https://gamma.app/embed/x', viewUrl: 'https://gamma.app/docs/x', pdfStatus: 'ok' }; gammaPdfs[c.n] = SM.syntheticPdf(10); gammaSlideImages[c.n] = SM.syntheticCoverPng(1600, 900, '#0F766E'); }
  }
  const svc = new MbzBuilderService();
  const realNow = Date.now;
  Date.now = () => Date.UTC(2026, 0, 1); // determinista
  try {
    const r = await svc.buildMbz({ courseData: { nombre: 'Servicio al cliente', mods: MODS, caps, sector: 'Comercio', pais: 'Colombia', tono: 'cercano', pal: {} }, courseFiles: F, hvpData, gammaData, gammaPdfs, gammaSlideImages, audiobook: opts.audiobook === false ? null : SM.syntheticMp3(90), moodleVersion: '4.5' });
    return r.buffer;
  } finally { Date.now = realNow; }
}

module.exports = { v1BuilderCourse, MODS };
