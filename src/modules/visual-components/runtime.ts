/**
 * R2 — Visual Components: capa ENHANCED por label (un <style> con scope + un runtime JS).
 *
 * Ambos son aditivos: con forceclean=1 Moodle elimina <style>/<script> (§X.1) y el
 * contenido CLEAN_SAFE queda completo y visible. El runtime:
 *  - vive en window.CursiaVC con versión (VC_RUNTIME_VERSION): un label más nuevo redefine
 *    el runtime si la página ya tenía uno más viejo;
 *  - es idempotente (data-cvc-ready) y solo actúa dentro de SU label: lo encuentra por
 *    document.currentScript (su propio padre) y, si no, por [data-cvc-uid] — si hay uids
 *    repetidos en la página, inicializa cada uno igual;
 *  - convierte .cvc-tabs apilados en un tablist ARIA con nombre accesible (flechas,
 *    Home/End, Enter/Espacio); genera ids si faltan (p. ej. tras re-editar en TinyMCE);
 *  - cierra los <details class="cvc-collapsible"> (vienen `open`): revelado;
 *  - para comparaciones apiladas (> 2 columnas) construye la tabla completa en una región
 *    desplazable accesible; el CSS muestra la tabla en pantallas anchas y la versión
 *    apilada en angostas.
 * Oculta contenido SOLO después de inicializar. Sin JS todo queda visible.
 */
import { ResolvedTheme } from '../theme-engine';

export const VC_RUNTIME_VERSION = 3;

/**
 * R14-A — capa ENHANCED de «CURSIA V2 DESIGN LANGUAGE V1». El layout (columnas, eje de la
 * línea de tiempo, numerales en columna, botones de revelado) vive SOLO aquí: sin este
 * <style> (forceclean) todo queda en una columna legible. Las columnas responden al ancho
 * REAL del label (container queries), no al viewport: Moodle angosta la columna de contenido.
 * `!important` solo donde hay que anular un valor base inline de CLEAN_SAFE.
 */
/**
 * R14-A (review I1) — familias con lámina (oscuras): las láminas de labels CONSECUTIVOS se
 * funden en una superficie continua (sin el hueco ni el separador de Moodle entre actividades;
 * radio solo en los extremos). Solo afecta contenedores que tienen una .cvc-plate; si el tema
 * de Moodle no coincide con los selectores, no pasa nada (mejora progresiva).
 */
export function plateJoinStyle(): string {
  const L = 'li.activity:has(.cvc-plate)';
  return [
    `${L}{margin-top:0!important;padding-top:0!important;border:0!important}`,
    `${L} .activity-item{padding-top:0!important;padding-bottom:0!important;border:0!important}`,
    `${L} .activity-altcontent{margin-top:0!important}`,
    `${L}+${L} .cvc-plate{border-top-left-radius:0!important;border-top-right-radius:0!important}`,
    `${L}:has(+${L}) .cvc-plate{border-bottom-left-radius:0!important;border-bottom-right-radius:0!important}`,
  ].join('\n');
}

/**
 * EV6 — árbol de decisión: dos columnas reales desde 600 px (nivel 1) y 960 px (nivel 2) del ancho
 * del label; más angosto, las ramas quedan apiladas como en CLEAN_SAFE. La pregunta raíz se centra
 * y las píldoras ↙/↘ miran al centro, como conectores de un árbol.
 */
export function decisionStyle(S: string, c: ResolvedTheme['color']): string {
  const cols = (d: number) =>
    `${S} .cvc-dt-d${d}>.cvc-dt-branches{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));column-gap:28px;align-items:start}` +
    `${S} .cvc-dt-d${d}>.cvc-dt-branches>.cvc-dt-br{border-left:0!important;padding-left:0!important;margin-bottom:0!important}` +
    `${S} .cvc-dt-d${d}>.cvc-dt-branches>.cvc-dt-yes>.cvc-dt-pill{text-align:right}`;
  return [
    `${S} .cvc-dt-pair{table-layout:fixed}`,
    // conector decorativo (texto alternativo vacío: el lector dice «Sí», no «flecha»). Los «:» del rótulo
    // quedan VISIBLES (fix round 4): ningún texto de un label se oculta, en ningún nivel.
    `${S} .cvc-dt-yes>.cvc-dt-pill>.cvc-dt-lbl::before{content:"\\2199";content:"\\2199" / "";margin-right:.4em;color:inherit}`,
    `${S} .cvc-dt-no>.cvc-dt-pill>.cvc-dt-lbl::before{content:"\\2198";content:"\\2198" / "";margin-right:.4em;color:inherit}`,
    `${S} .cvc-dt-d1>.cvc-dt-q{text-align:center}`,
    `@container (min-width:600px){${S} .cvc-dt-d1>.cvc-dt-q{max-width:36rem;margin-left:auto!important;margin-right:auto!important}${cols(1)}}`,
    `@container (min-width:960px){${cols(2)}}`,
  ].join('\n');
}

/** P3 — reglas del sistema educativo (compartidas con el shell). Sin ellas todo queda en una columna legible. */
export function eduStyle(S: string, c: ResolvedTheme['color']): string[] {
  return [
    `${S} .cvc-ic{display:inline-block;vertical-align:-0.22em;flex:none}`,
    `${S} .cvc-chip .cvc-ic{display:block}`,
    `${S} .cvc-chip+h4,${S} .cvc-chip+h5{margin-top:2px!important}`,
    `${S} .cvc-chip{margin-bottom:14px!important}`,
    `${S} p.cvc-chip{width:max-content;max-width:100%}`,
    // riel del proceso: conector vertical entre insignias
    `${S} .cvc-rail>li{position:relative}`,
    `${S} .cvc-rail>li:not(:last-child)::before{content:"";position:absolute;left:17px;top:44px;bottom:-12px;width:2px;background-color:${c.border}}`,
    `${S} .cvc-rail .cvc-step-b h4,${S} .cvc-rail .cvc-step-b h5{margin-top:5px!important}`,
    `${S} .cvc-obj{align-items:start!important}`,
    `${S} .cvc-obj .cvc-badge{margin:0!important}`,
    `${S} .cvc-obj .cvc-li-t{padding-top:3px}`,
    `${S} .cvc-pt{grid-template-columns:2.25rem minmax(0,1fr)!important}`,
    `${S} .cvc-pt .cvc-ic{margin-top:2px}`,
    `${S} .cvc-check{grid-template-columns:2rem minmax(0,1fr)!important;align-items:start!important}`,
    `${S} .cvc-check .cvc-ic{margin-top:4px}`,
    `${S} .cvc-mr>div{margin:0!important}`,
    `${S} .cvc-mr{gap:12px;margin-bottom:12px!important;display:grid}`,
    `${S} .cvc-case{overflow:hidden}`,
    `${S} .cvc-op-num .cvc-badge{margin:0!important}`,
    // ruta del capítulo: pasos con ícono, en fila desde 560 px
    `${S} .cvc-route-steps{display:flex;flex-direction:column;gap:6px}`,
    `${S} .cvc-route-steps>li{display:flex;align-items:center;gap:10px;margin:0!important}`,
    // riel del módulo
    `${S} .cvc-mrail>li{display:grid;grid-template-columns:2.5rem minmax(0,1fr);align-items:center;column-gap:10px}`,
    `${S} .cvc-mrail>li .cvc-badge{margin:0!important}`,
    `${S} .cvc-mrail>li{position:relative}`,
    `${S} .cvc-mrail>li:not(:last-child)::before{content:"";position:absolute;left:calc(1.25rem - 1px);top:40px;bottom:-8px;width:2px;background-color:${c.border}}`,
    `${S} .cvc-facts-row{display:flex;flex-wrap:wrap;gap:8px 20px}`,
    `${S} .cvc-facts-row>span{display:inline-flex;align-items:center;gap:6px}`,
    `@container (min-width:600px){` +
      `${S} .cvc-cols2.cvc-terms>li:nth-child(2),${S} .cvc-cols2.cvc-objs>li:nth-child(2){border-top:0!important}` +
      `${S} .cvc-mr{grid-template-columns:repeat(2,minmax(0,1fr))}` +
      `${S} .cvc-route-steps{flex-direction:row;flex-wrap:wrap;align-items:center;gap:8px 10px}` +
      `${S} .cvc-route-steps>li:not(:last-child)::after{content:"\\2192";content:"\\2192" / "";margin-left:4px;color:${c.borderStrong};font-weight:700}` +
      `}`,
  ];
}

export function scopedStyle(uid: string, theme: ResolvedTheme, opts: { decision?: boolean } = {}): string {
  const S = `.cvc-${uid}`;
  const c = theme.color;
  const p = theme.personality;
  const ground = p && p.plate ? c.bg : c.surface;
  const panel = p && p.plate ? c.surface : c.surfaceAlt;
  const rs = theme.shape.radiusSm;
  return [
    `${S}{container-type:inline-size}`,
    p && p.plate ? plateJoinStyle() : '',
    `${S},${S} *,${S} *::before,${S} *::after{box-sizing:border-box}`,
    `${S} .cvc-c:nth-last-child(1 of .cvc-c){margin-bottom:0!important}`,
    `${S} .cvc-num{white-space:nowrap}`,
    `${S} .cvc-cmp table,${S} .cvc-cmp-full table{overflow-wrap:normal;word-break:normal}`,
    p && p.ruleBetween ? `${S} .cvc-c+.cvc-c:not(.cvc-t-summary_visual):not(.cvc-t-reflection):not(.cvc-t-callout){border-top:1px solid ${c.border};padding-top:40px}` : '',
    `${S} a{color:${c.accentStrong};text-decoration:underline;text-underline-offset:.18em}`,
    // revelado: summary sin marcador nativo
    `${S} summary{cursor:pointer;list-style:none}`,
    `${S} summary::-webkit-details-marker{display:none}`,
    // acordeón: fila con control circular + / −
    `${S} .cvc-acc>summary{display:flex;align-items:center;justify-content:space-between;gap:16px;min-height:44px}`,
    `${S} .cvc-acc>summary::after{content:"+";flex:none;display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;` +
      `border:1px solid ${c.borderStrong};border-radius:50%;font-size:20px;line-height:1;color:${c.textPrimary};transition:transform .2s ease,background-color .15s ease}`,
    `${S} .cvc-acc[open]>summary::after{content:"\\2212"}`,
    `${S} .cvc-acc>summary:hover::after{background-color:${panel}}`,
    // botón-píldora de revelado (Ver respuesta / Ver la realidad / Ver una pista)
    `${S} summary.cvc-btn{display:inline-flex;align-items:center;gap:10px;min-height:44px;padding:8px 18px;border:1px solid ${c.borderStrong};` +
      `border-radius:999px;background-color:${ground};transition:border-color .15s ease,background-color .15s ease}`,
    `${S} summary.cvc-btn::after{content:"+";font-weight:700;color:${c.accentStrong}}`,
    `${S} details[open]>summary.cvc-btn::after{content:"\\2212"}`,
    `${S} summary.cvc-btn:hover{border-color:${c.accentStrong}}`,
    `${S} details[open]>summary.cvc-btn{margin-bottom:12px!important}`,
    `${S} summary:focus-visible,${S} [role="tab"]:focus-visible,${S} [role="tabpanel"]:focus-visible,${S} .cvc-scroll:focus-visible{outline:3px solid ${c.accentStrong};outline-offset:3px}`,
    // tabs: barra subrayada, sin rellenos
    `${S} .cvc-tablist{display:flex;flex-wrap:wrap;gap:4px 24px;margin:0 0 4px 0;padding:0;border-bottom:1px solid ${c.border}}`,
    `${S} [role="tab"]{font:inherit;font-size:17px;font-weight:600;line-height:1.3;min-height:44px;padding:10px 0;margin:0 0 -1px 0;` +
      `border:0;border-bottom:3px solid transparent;border-radius:0;background-color:transparent;color:${c.textSecondary};cursor:pointer;transition:color .15s ease,border-color .15s ease}`,
    `${S} [role="tab"]:hover{color:${c.textPrimary}}`,
    `${S} [role="tab"][aria-selected="true"]{color:${c.textPrimary};border-bottom-color:${c.accent}}`,
    `${S} .cvc-tabpanel{border-top:0!important}`,
    // línea de tiempo: marcador sobre el eje
    `${S} .cvc-axis{position:relative}`,
    `${S} .cvc-axis::before{content:"";position:absolute;left:0;top:10px;bottom:10px;width:2px;background-color:${c.borderStrong}}`,
    `${S} .cvc-ev{position:relative}`,
    `${S} .cvc-ev::before{content:"";position:absolute;left:-9px;top:.3em;width:16px;height:16px;border-radius:50%;background-color:${c.accent};box-shadow:0 0 0 4px ${ground}}`,
    `${S} .cvc-ev:last-child{padding-bottom:0!important}`,
    // numerales en columna (proceso, objetivos, puntos, checklist)
    `${S} .cvc-step{display:grid;grid-template-columns:2.75rem minmax(0,1fr);column-gap:8px;align-items:start}`,
    `${S} .cvc-step .cvc-num,${S} .cvc-step .cvc-badge{margin:0!important}`,
    // Edu EV4: tarjetas de aprendizaje y panel de objetivos
    `${S} .cvc-obj,${S} .cvc-pt{display:grid;grid-template-columns:2.75rem minmax(0,1fr);align-items:baseline}`,
    `${S} .cvc-obj .cvc-li-n,${S} .cvc-pt .cvc-li-n{margin:0!important}`,
    `${S} .cvc-check{display:grid;grid-template-columns:2rem minmax(0,1fr);align-items:baseline}`,
    `${S} .cvc-q{display:grid;grid-template-columns:1.75rem minmax(0,1fr);align-items:baseline}`,
    `${S} .cvc-grid>*,${S} .cvc-cols2>*{min-width:0}`,
    `${S} .cvc-cards{display:grid;grid-template-columns:minmax(0,1fr);gap:16px}`,
    `${S} .cvc-cards>li{margin:0!important}`,
    // Edu Phase A — diagramas (layout SOLO acá: sin <style> todo queda como lista/tabla legible)
    `${S} .cvc-dg-flow .cvc-dg-step{position:relative}`,
    `${S} .cvc-dg-flow .cvc-dg-step:not(:last-child)::after{content:"\\2193";position:absolute;left:50%;bottom:-1.3em;transform:translateX(-50%);color:${c.accentStrong};font-weight:700;line-height:1}`,
    `${S} .cvc-dg-flow .cvc-dg-step:not(:last-child){margin-bottom:1.6em!important}`,
    `${S} .cvc-dg-ring{display:block;width:140px;height:140px;margin:0 auto 16px auto}`,
    `${S} .cvc-dg-hierarchy .cvc-dg-root{text-align:center;max-width:28rem;margin-left:auto!important;margin-right:auto!important;position:relative}`,
    // jerarquía angosta: árbol indentado (línea a la izquierda + rama por hijo)
    // (la línea del árbol es un ::before, no un border-left: el Visual System prohíbe franjas laterales > 1px)
    `${S} .cvc-dg-kids{display:grid;gap:12px;position:relative;margin-left:12px!important;padding-left:18px!important}`,
    `${S} .cvc-dg-kids::before{content:"";position:absolute;left:0;top:0;bottom:1.4em;width:2px;background-color:${c.borderStrong}}`,
    `${S} .cvc-dg-kids>li{margin:0!important;position:relative}`,
    `${S} .cvc-dg-kids>li::before{content:"";position:absolute;left:-20px;top:1.4em;width:18px;height:2px;background-color:${c.borderStrong}}`,
    `${S} .cvc-dg-matrix table{table-layout:fixed}`,
    opts.decision ? decisionStyle(S, c) : '',
    `${S} .cvc-we-result{margin-bottom:0!important}`,
    // apertura de capítulo
    `${S} .cvc-op-num .cvc-num,${S} .cvc-op-num .cvc-badge{margin:0!important}`,
    // comparación: tabla completa construida por el runtime
    `${S} .cvc-scroll{overflow-x:auto;max-width:100%}`,
    `${S} .cvc-cmp-full table{border-collapse:collapse;width:100%;min-width:34rem}`,
    `${S} .cvc-cmp-full th,${S} .cvc-cmp-full td{border:0;border-bottom:1px solid ${c.border};padding:12px 14px;font-size:16px;line-height:1.5;text-align:left;vertical-align:top;background-color:${ground};color:${c.textPrimary}}`,
    `${S} .cvc-cmp-full thead th{background-color:${panel};color:${c.textPrimary};border-bottom-color:${c.borderStrong};font-weight:700}`,
    `${S} .cvc-cmp-full tbody th{font-weight:700}`,
    `${S}.cvc-js .cvc-cmp-full+.cvc-cmp-stack{display:none}`,
    // columnas según el ancho real del label
    `@container (min-width:600px){` +
      `${S} .cvc-cols2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));column-gap:40px}` +
      `${S} .cvc-cards{grid-template-columns:repeat(2,minmax(0,1fr))}` +
      `${S} .cvc-obj-panel .cvc-cols2>li:nth-child(2){border-top:0!important}` +
      `${S} .cvc-step{grid-template-columns:3.5rem minmax(0,1fr)}` +
      `${S} .cvc-dg-flow:not(.cvc-dg-long) .cvc-dg-list{display:flex;align-items:stretch;gap:12px 36px}` +
      `${S} .cvc-dg-flow:not(.cvc-dg-long) .cvc-dg-step,${S} .cvc-dg-flow:not(.cvc-dg-long) .cvc-dg-step:not(:last-child){flex:1 1 0;min-width:0;margin:0!important}` +
      `${S} .cvc-dg-flow:not(.cvc-dg-long) .cvc-dg-step:not(:last-child)::after{content:"\\2192";left:auto;right:-26px;bottom:auto;top:50%;transform:translateY(-50%)}` +
      `${S} .cvc-dg-cycle{display:grid;grid-template-columns:180px minmax(0,1fr);column-gap:32px;align-items:center}` +
      `${S} .cvc-dg-ring{width:180px;height:180px;margin:0}` +
      `${S} .cvc-dg-kids{grid-template-columns:repeat(auto-fit,minmax(10rem,1fr));gap:30px 12px;margin-left:0!important;padding-left:0!important;padding-top:14px!important;border-top:2px solid ${c.borderStrong}}` +
      `${S} .cvc-dg-kids::before{display:none}` +
      `${S} .cvc-dg-kids>li::before{left:50%;top:-16px;width:2px;height:14px}` +
      `${S} .cvc-dg-hierarchy .cvc-dg-root::after{content:"";position:absolute;left:50%;bottom:-14px;width:2px;height:12px;background-color:${c.borderStrong}}` +
      `${S} .cvc-mr{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));column-gap:40px;align-items:start}` +
      `${S} .cvc-op-split{display:grid;grid-template-columns:auto minmax(0,1fr);grid-template-areas:"num lead" "num main";column-gap:clamp(20px,3vw,40px)}` +
      `${S} .cvc-op-split>.cvc-op-num{grid-area:num}` +
      `${S} .cvc-op-split>.cvc-op-lead{grid-area:lead}` +
      `${S} .cvc-op-split>.cvc-op-main{grid-area:main}` +
      `}`,
    `@container (max-width:599px){${S}.cvc-js .cvc-cmp-full{display:none}${S}.cvc-js .cvc-cmp-full+.cvc-cmp-stack{display:block}${S} .cvc-cmp th,${S} .cvc-cmp td{padding:8px 8px 8px 0}}`,
    `${S} .cvc-dbody{animation:cvc-${uid}-in .22s cubic-bezier(.22,1,.36,1)}`,
    `@keyframes cvc-${uid}-in{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}`,
    `@media (prefers-reduced-motion:reduce){${S} *,${S} *::before,${S} *::after{animation:none!important;transition:none!important}}`,
    `${S} .cvc-tabpanel[hidden]{display:none}`,
    // P3 — sistema visual educativo 2.0
    ...eduStyle(S, c),
    `${S} .cvc-t-timeline .cvc-ev::before{background-color:${theme.blocks.visual.ink}}`,
    `${S} .cvc-t-tabs [role="tab"][aria-selected="true"]{border-bottom-color:${theme.blocks.concepto.ink}}`,
    `${S} summary.cvc-btn::after{color:inherit}`,
    `${S} :where(h2,h4,h5){text-wrap:balance}`,
    `${S} :where(p){text-wrap:pretty}`,
  ]
    .filter(Boolean)
    .join('\n');
}

/** Runtime compartido (versionado) + init del label `uid`. */
export function runtimeScript(uid: string): string {
  return (
    '(function(w,d,u,s){' +
    `var V=${VC_RUNTIME_VERSION},N=w.CursiaVC=w.CursiaVC||{};` +
    'if(!N.init||(N.v|0)<V){N.v=V;N.seq=N.seq||0;' +
    // ids estables si faltan
    'N.id=function(e,p){if(!e.id){N.seq++;e.id=p+"-"+N.seq}return e.id};' +
    'N.tabs=function(box,uid){' +
    'var ps=[].slice.call(box.children).filter(function(e){return e.classList.contains("cvc-tabpanel")});' +
    'if(ps.length<2)return;' +
    'var l=d.createElement("div");l.className="cvc-tablist";l.setAttribute("role","tablist");' +
    'var lb=box.getAttribute("data-cvc-labelledby");' +
    'if(lb&&d.getElementById(lb))l.setAttribute("aria-labelledby",lb);else l.setAttribute("aria-label",box.getAttribute("data-cvc-label")||"Pesta\\u00f1as");' +
    'var bs=ps.map(function(p,i){' +
    'var pid=N.id(p,"cvc-"+uid+"-tab");' +
    'var lab=p.querySelector(".cvc-tablabel");var b=d.createElement("button");' +
    'b.type="button";b.id=pid+"-tab";b.setAttribute("role","tab");b.setAttribute("aria-controls",pid);' +
    'b.textContent=lab?lab.textContent:String(i+1);' +
    'p.setAttribute("role","tabpanel");p.setAttribute("aria-labelledby",b.id);p.tabIndex=0;if(lab)lab.hidden=true;' +
    'b.addEventListener("click",function(){sel(i,false)});' +
    'b.addEventListener("keydown",function(e){var n=null,k=e.key,L=ps.length;' +
    'if(k==="ArrowRight")n=(i+1)%L;else if(k==="ArrowLeft")n=(i-1+L)%L;else if(k==="Home")n=0;else if(k==="End")n=L-1;' +
    'if(n!==null){e.preventDefault();sel(n,true)}});' +
    'l.appendChild(b);return b});' +
    'function sel(n,f){for(var j=0;j<ps.length;j++){var on=j===n;bs[j].setAttribute("aria-selected",on?"true":"false");' +
    'bs[j].tabIndex=on?0:-1;ps[j].hidden=!on}if(f)bs[n].focus()}' +
    'box.insertBefore(l,ps[0]);sel(0,false)};' +
    // comparación apilada → tabla completa en región desplazable
    'N.cmp=function(stack){' +
    'var rows=[].slice.call(stack.querySelectorAll(".cvc-cmp-row"));if(!rows.length)return;' +
    'var t=d.createElement("table"),th=d.createElement("thead"),hr=d.createElement("tr"),tb=d.createElement("tbody");' +
    'var h0=d.createElement("th");h0.scope="col";h0.textContent="Aspecto";hr.appendChild(h0);' +
    '[].slice.call(rows[0].querySelectorAll(".cvc-cmp-col")).forEach(function(c){var h=d.createElement("th");h.scope="col";' +
    'h.textContent=c.textContent.replace(/:\\s*$/,"");hr.appendChild(h)});th.appendChild(hr);t.appendChild(th);' +
    'rows.forEach(function(row){var tr=d.createElement("tr"),rh=d.createElement("th"),lab=row.querySelector(".cvc-cmp-label");' +
    'rh.scope="row";rh.textContent=lab?lab.textContent:"";tr.appendChild(rh);' +
    '[].slice.call(row.querySelectorAll(".cvc-cmp-val")).forEach(function(v){var td=d.createElement("td");' +
    'for(var k=0;k<v.childNodes.length;k++)td.appendChild(v.childNodes[k].cloneNode(true));tr.appendChild(td)});tb.appendChild(tr)});' +
    't.appendChild(tb);var reg=d.createElement("div");reg.className="cvc-cmp-full cvc-scroll";reg.setAttribute("role","region");' +
    'reg.tabIndex=0;reg.setAttribute("aria-label","Comparaci\\u00f3n en tabla");reg.appendChild(t);stack.parentNode.insertBefore(reg,stack)};' +
    'N.initRoot=function(r){' +
    'if(!r||r.getAttribute("data-cvc-ready")==="1")return;' +
    'r.setAttribute("data-cvc-ready","1");r.classList.add("cvc-js");var uid=r.getAttribute("data-cvc-uid")||"x";' +
    'var ds=r.querySelectorAll("details.cvc-collapsible");' +
    'for(var i=0;i<ds.length;i++){if(!ds[i].classList.contains("cvc-keep-open"))ds[i].open=false}' +
    'var ts=r.querySelectorAll(".cvc-tabs");for(var t=0;t<ts.length;t++)N.tabs(ts[t],uid);' +
    'var cs=r.querySelectorAll(".cvc-cmp-stack");for(var c=0;c<cs.length;c++)N.cmp(cs[c])};' +
    'N.init=function(id,sc){' +
    'var p=sc&&sc.parentNode;' +
    'if(p&&p.getAttribute&&p.getAttribute("data-cvc-uid")===id){N.initRoot(p);return}' +
    'var all=d.querySelectorAll(\'[data-cvc-uid="\'+id+\'"]\');for(var i=0;i<all.length;i++)N.initRoot(all[i])}' +
    '}' +
    'N.init(u,s)' +
    `})(window,document,"${uid}",document.currentScript);`
  );
}
