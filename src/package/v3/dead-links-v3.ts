/**
 * Review r1 (M9) — enlaces muertos (`href="#"`, vacío o `javascript:`) en el HTML visible del paquete v3.
 *
 * Un enlace muerto es un token de Moodle que algún saneador viejo convirtió en `#` o un enlace inventado por el
 * modelo. Antes de r1 el validador hacía fallar el re-empaque de cursos ya generados; ahora el builder lo REPARA
 * de forma determinística (quita el enlace y conserva su texto) y solo un token `$@…@$` sin resolver sigue
 * fallando (assertTokensV3 / TOKEN_INVALID). Sin enlaces muertos el XML queda byte a byte igual.
 */
import { xmlEsc } from '../mbz-common';

/** Mismo criterio que el validador (TOKEN_INVALID «enlace muerto»). */
const DEAD_HREF_RE = /\bhref\s*=\s*(["'])\s*(#?|javascript:[^"']*)\s*\1/i;
/**
 * Review r2 (M9): etiqueta de apertura tokenizada por atributos — un valor entre comillas puede traer `>`
 * (`title="a > b"`) sin cortar la etiqueta. Las alternativas empiezan con caracteres disjuntos (sin comillas ni `>` /
 * `"` / `'`), así que el regex es lineal (sin retroceso catastrófico). Una comilla sin cerrar no forma etiqueta: el
 * enlace queda como está (nunca se inventa HTML). Se usa un tokenizador y no `parseHtml` porque el resto del HTML
 * debe quedar byte a byte igual (parsear y re-serializar lo normalizaría).
 */
const ANCHOR_RE = /<a\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/a\s*>/gi;

/** Quita los `<a>` con destino muerto y deja su contenido (texto). */
export function unwrapDeadAnchorsHtml(html: string): { html: string; count: number } {
  let count = 0;
  const out = String(html ?? '').replace(ANCHOR_RE, (whole, attrs: string, inner: string) => {
    if (!DEAD_HREF_RE.test(attrs)) return whole;
    count++;
    return inner;
  });
  return { html: count ? out : String(html ?? ''), count };
}

function unxmlEsc(s: string): string {
  return s.replace(/&(lt|gt|quot|amp);/g, (_m, e: string) => (e === 'lt' ? '<' : e === 'gt' ? '>' : e === 'quot' ? '"' : '&'));
}

/**
 * Repara los enlaces muertos del HTML guardado (escapado con `xmlEsc`) en `<intro>` / `<content>` de un XML de
 * actividad. Solo re-escribe el campo que tenía alguno; el resto del XML no cambia.
 */
export function repairDeadAnchorsInActivityXml(xml: string): { xml: string; count: number } {
  let count = 0;
  const out = xml.replace(/<(intro|content)>([\s\S]*?)<\/\1>/g, (whole, tagName: string, body: string) => {
    if (!/href/i.test(body)) return whole;
    const r = unwrapDeadAnchorsHtml(unxmlEsc(body));
    if (!r.count) return whole;
    count += r.count;
    return `<${tagName}>${xmlEsc(r.html)}</${tagName}>`;
  });
  return { xml: count ? out : xml, count };
}
