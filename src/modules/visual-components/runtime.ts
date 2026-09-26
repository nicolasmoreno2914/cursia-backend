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

export const VC_RUNTIME_VERSION = 2;

export function scopedStyle(uid: string, theme: ResolvedTheme): string {
  const S = `.cvc-${uid}`;
  const c = theme.color;
  const r = theme.shape.radiusSm;
  return [
    `${S},${S} *,${S} *::before,${S} *::after{box-sizing:border-box}`,
    `${S} .cvc-grid>*{min-width:0}`,
    `${S} a{color:${c.accentStrong};text-decoration:underline}`,
    `${S} summary{cursor:pointer;list-style:none;display:block}`,
    `${S} summary::-webkit-details-marker{display:none}`,
    `${S} summary>h4,${S} summary>h5{display:inline}`,
    `${S} summary::after{content:" +";font-weight:700}`,
    `${S} details[open]>summary::after{content:" \\2212"}`,
    `${S} summary:focus-visible,${S} [role="tab"]:focus-visible,${S} [role="tabpanel"]:focus-visible,${S} .cvc-scroll:focus-visible{outline:3px solid ${c.accentStrong};outline-offset:2px}`,
    `${S} .cvc-tablist{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 12px 0;padding:0}`,
    `${S} [role="tab"]{font:inherit;font-size:16px;font-weight:700;line-height:1.3;min-height:44px;padding:10px 16px;margin:0;` +
      `border:1px solid ${c.borderStrong};border-radius:${r}px;background-color:${c.surface};color:${c.textPrimary};cursor:pointer;` +
      `transition:background-color .15s ease,color .15s ease}`,
    `${S} [role="tab"][aria-selected="true"]{background-color:${c.accent};color:${c.textOnAccent};border-color:${c.accent}}`,
    `${S} .cvc-scroll{overflow-x:auto;max-width:100%}`,
    `${S} .cvc-cmp-full table{border-collapse:collapse;width:100%;min-width:32rem}`,
    `${S} .cvc-cmp-full th,${S} .cvc-cmp-full td{border:1px solid ${c.borderStrong};padding:8px 10px;font-size:16px;line-height:1.5;text-align:left;vertical-align:top}`,
    `${S} .cvc-cmp-full thead th{background-color:${c.accent};color:${c.textOnAccent}}`,
    `${S} .cvc-cmp-full tbody th{background-color:${c.surfaceAlt};color:${c.textPrimary}}`,
    `${S} .cvc-cmp-full td{background-color:${c.surface};color:${c.textPrimary}}`,
    `@media (max-width:719px){${S} .cvc-cmp-full{display:none}}`,
    `@media (min-width:720px){${S}.cvc-js .cvc-cmp-stack{display:none}}`,
    `${S} .cvc-dbody{animation:cvc-${uid}-in .2s ease-out}`,
    `@keyframes cvc-${uid}-in{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}`,
    `@media (max-width:640px){${S} .cvc-cmp th,${S} .cvc-cmp td{padding:6px}}`,
    `@media (prefers-reduced-motion:reduce){${S} *,${S} *::before,${S} *::after{animation:none!important;transition:none!important}}`,
  ].join('\n');
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
