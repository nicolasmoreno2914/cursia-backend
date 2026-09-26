/**
 * R2 — Visual Components: capa ENHANCED por label (un <style> con scope + un runtime JS).
 *
 * Ambos son aditivos: con forceclean=1 Moodle elimina <style>/<script> (§X.1) y el
 * contenido CLEAN_SAFE queda completo y visible. El runtime:
 *  - vive en window.CursiaVC, es idempotente (data-cvc-ready) y solo actúa dentro de
 *    [data-cvc-uid="<uid>"];
 *  - convierte .cvc-tabs apilados en un tablist ARIA (flechas, Home/End, Enter/Espacio);
 *  - cierra los <details class="cvc-collapsible"> (que vienen `open` en el markup) para
 *    convertirlos en revelado; sin JS todo queda abierto y visible.
 * Oculta paneles SOLO después de inicializar.
 */
import { ResolvedTheme } from '../theme-engine';

export function scopedStyle(uid: string, theme: ResolvedTheme): string {
  const S = `.cvc-${uid}`;
  const c = theme.color;
  const r = theme.shape.radiusSm;
  return [
    `${S},${S} *,${S} *::before,${S} *::after{box-sizing:border-box}`,
    `${S} summary{cursor:pointer;list-style:none;display:block}`,
    `${S} summary::-webkit-details-marker{display:none}`,
    `${S} summary>h4{display:inline}`,
    `${S} summary::after{content:" +";font-weight:700}`,
    `${S} details[open]>summary::after{content:" \\2212"}`,
    `${S} summary:focus-visible,${S} [role="tab"]:focus-visible,${S} [role="tabpanel"]:focus-visible{outline:3px solid ${c.accentStrong};outline-offset:2px}`,
    `${S} .cvc-tablist{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 12px 0;padding:0}`,
    `${S} [role="tab"]{font:inherit;font-size:16px;font-weight:700;line-height:1.3;min-height:44px;padding:10px 16px;margin:0;` +
      `border:1px solid ${c.borderStrong};border-radius:${r}px;background-color:${c.surface};color:${c.textPrimary};cursor:pointer;` +
      `transition:background-color .15s ease,color .15s ease}`,
    `${S} [role="tab"][aria-selected="true"]{background-color:${c.accent};color:${c.textOnAccent};border-color:${c.accent}}`,
    `${S} .cvc-dbody{animation:cvc-${uid}-in .2s ease-out}`,
    `@keyframes cvc-${uid}-in{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}`,
    `@media (max-width:640px){${S} .cvc-cmp th,${S} .cvc-cmp td{padding:6px}}`,
    `@media (prefers-reduced-motion:reduce){${S} *,${S} *::before,${S} *::after{animation:none!important;transition:none!important}}`,
  ].join('\n');
}

/** Runtime compartido (se define una vez por página) + init del label `uid`. */
export function runtimeScript(uid: string): string {
  return (
    '(function(w,d,u){' +
    'var N=w.CursiaVC=w.CursiaVC||{v:1};' +
    'if(!N.init){' +
    'N.tabs=function(box){' +
    'var ps=[].slice.call(box.children).filter(function(e){return e.classList.contains("cvc-tabpanel")});' +
    'if(ps.length<2)return;' +
    'var l=d.createElement("div");l.className="cvc-tablist";l.setAttribute("role","tablist");' +
    'var bs=ps.map(function(p,i){' +
    'var lab=p.querySelector(".cvc-tablabel");var b=d.createElement("button");' +
    'b.type="button";b.id=p.id+"-tab";b.setAttribute("role","tab");b.setAttribute("aria-controls",p.id);' +
    'b.textContent=lab?lab.textContent:String(i+1);' +
    'p.setAttribute("role","tabpanel");p.setAttribute("aria-labelledby",b.id);p.tabIndex=0;if(lab)lab.hidden=true;' +
    'b.addEventListener("click",function(){s(i,false)});' +
    'b.addEventListener("keydown",function(e){var n=null,k=e.key,L=ps.length;' +
    'if(k==="ArrowRight")n=(i+1)%L;else if(k==="ArrowLeft")n=(i-1+L)%L;else if(k==="Home")n=0;else if(k==="End")n=L-1;' +
    'if(n!==null){e.preventDefault();s(n,true)}});' +
    'l.appendChild(b);return b});' +
    'function s(n,f){for(var j=0;j<ps.length;j++){var on=j===n;bs[j].setAttribute("aria-selected",on?"true":"false");' +
    'bs[j].tabIndex=on?0:-1;ps[j].hidden=!on}if(f)bs[n].focus()}' +
    'box.insertBefore(l,ps[0]);s(0,false)};' +
    'N.init=function(id){' +
    'var r=d.querySelector(\'[data-cvc-uid="\'+id+\'"]\');' +
    'if(!r||r.getAttribute("data-cvc-ready")==="1")return;' +
    'r.setAttribute("data-cvc-ready","1");r.classList.add("cvc-js");' +
    'var ds=r.querySelectorAll("details.cvc-collapsible");' +
    'for(var i=0;i<ds.length;i++){if(!ds[i].classList.contains("cvc-keep-open"))ds[i].open=false}' +
    'var ts=r.querySelectorAll(".cvc-tabs");for(var t=0;t<ts.length;t++)N.tabs(ts[t])}' +
    '}' +
    'N.init(u)' +
    `})(window,document,"${uid}");`
  );
}
