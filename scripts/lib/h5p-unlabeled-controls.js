/* eslint-disable */
// UX #5 (r18) — assert de compuerta: ningún control VISIBLE dentro del contenido H5P puede
// quedar sin texto visible Y sin icono. Un aria-label solo no alcanza cuando el botón no
// muestra nada (caso H5P.QuestionSet 1.20 + H5P.Question 1.5 con tema: «Pregunta siguiente»
// era un CTA primario azul vacío, con aria-label pero sin texto ni icono).
//
// `UNLABELED_CONTROLS_EXPR` es una EXPRESIÓN JS que se evalúa en un ámbito donde existen
// `w` (window del contenido H5P) y `d` (su document) — así la usan `inH5p(...)` de
// scripts/check-v21-h5p-player.js y test/e2e-v2/browser-qa-v3.js — y devuelve la lista de
// controles en falta: [] = OK.
//
// ALCANCE (fix round 1, M-4): solo `button` y `[role=button]`. NO cubre enlaces (`a`, p. ej. los puntos de
// progreso de QuestionSet 1.21, que son visuales legítimos con aria-label), inputs, `[role=tab]`, sliders
// ni otros controles: no es una cobertura completa de «todo control interactivo». Ampliar el selector
// exige reglas propias por tipo (un punto de progreso no lleva texto a propósito).
// Falsos negativos conocidos (M-3 b/c, sin casos hoy): texto oculto con font-size 0, color transparente o
// text-indent cuenta como texto visible; un glifo ::before cuenta como icono aunque su fuente no cargue.
//
// Visible = con rect > 1 px, sin display:none, con visibility computada ≠ hidden (se hereda: un control
// dentro de un ancestro visibility:hidden ya da hidden, salvo que él mismo se fuerce a visible, y entonces
// SÍ se ve) y sin opacity 0 en él NI en ningún ancestro (fix round 1, M-3: la opacidad no se hereda en
// el estilo computado, p. ej. un contenedor a mitad de una transición de fundido).
// Texto visible = innerText no vacío. Icono = <svg>/<img> visible dentro del control, o un
// pseudo-elemento ::before/::after (del control o de un descendiente) con un glifo
// (content ≠ none/normal/"") o con una imagen url(...) de fondo o de máscara, o una imagen
// url(...) de fondo en el propio control. Un degradado (sin url) no es un icono.
'use strict';

const UNLABELED_CONTROLS_EXPR = `(function(w,d){
  var shown=function(e){if(!e||!e.getClientRects().length)return false;var s=w.getComputedStyle(e);if(s.display==='none'||s.visibility==='hidden')return false;for(var a=e;a&&a.nodeType===1;a=a.parentElement){if(parseFloat(w.getComputedStyle(a).opacity)===0)return false;}var r=e.getBoundingClientRect();return r.width>1&&r.height>1;};
  var url=function(v){return !!v&&/url\\(/.test(v);};
  var pseudoIcon=function(e,p){var s=w.getComputedStyle(e,p);var c=s.content;if(!c||c==='none'||c==='normal')return false;if(s.display==='none'||s.visibility==='hidden')return false;var glyph=c!=='""'&&c!=="''";return glyph||url(s.backgroundImage)||url(s.maskImage)||url(s.webkitMaskImage);};
  var hasIcon=function(e){if(url(w.getComputedStyle(e).backgroundImage))return true;var all=[e].concat([].slice.call(e.querySelectorAll('*')));for(var i=0;i<all.length;i++){var x=all[i];var t=String(x.tagName).toLowerCase();if(x!==e&&(t==='svg'||t==='img')&&shown(x))return true;if(pseudoIcon(x,'::before')||pseudoIcon(x,'::after'))return true;}return false;};
  return [].slice.call(d.querySelectorAll('button,[role=button]')).filter(shown).filter(function(e){return !(e.innerText||'').trim()&&!hasIcon(e);}).map(function(e){var r=e.getBoundingClientRect();return {tag:e.tagName,cls:String(e.className).slice(0,120),aria:e.getAttribute('aria-label')||'',title:e.getAttribute('title')||'',w:Math.round(r.width),h:Math.round(r.height)};});
})(w,d)`;

module.exports = { UNLABELED_CONTROLS_EXPR };
