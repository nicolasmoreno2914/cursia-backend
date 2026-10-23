// V2.1 R13 (fix round 1) — clasificación de intentos de red salientes por proveedor
// pagado, para MEDIR (no afirmar por construcción) "0 llamadas reales" en todo el gate:
// logs de netguard (app, workers, regresión), fetch del navegador simulado y
// requests de Chrome registrados por CDP.
'use strict';
const fs = require('fs');

const PROVIDERS = ['anthropic', 'openai', 'gamma', 'videogen', 'google_youtube_api'];

/** host (+ path opcional, para Chrome) → proveedor pagado o null. */
function providerOf(host, pathname) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  const p = String(pathname || '');
  if (/(^|\.)anthropic\.com$/.test(h)) return 'anthropic';
  if (/(^|\.)openai\.com$/.test(h)) return 'openai';
  if (/gamma/.test(h)) return 'gamma';
  if (/videogen|(^|\.)videosb\.nomaddi\.com$/.test(h)) return 'videogen';
  // YouTube Data API / subida / OAuth. Los hosts de reproducción (youtube.com, ytimg,
  // googlevideo, ggpht) NO son la API pagada/cuota.
  if (h === 'oauth2.googleapis.com' || h === 'accounts.google.com' || h === 'youtube.googleapis.com') return 'google_youtube_api';
  if (h === 'www.googleapis.com' && (!p || /^\/(upload\/)?youtube\//.test(p) || /oauth/.test(p))) return 'google_youtube_api';
  return null;
}

function emptyCounts() { return Object.fromEntries(PROVIDERS.map((k) => [k, 0])); }

/** Lee un log de netguard ("… proc=X BLOCKED host") → {total, byProvider, otherHosts, byProc}. */
function countNetguardLog(file) {
  const out = { total: 0, byProvider: emptyCounts(), otherHosts: {}, byProc: {} };
  if (!file || !fs.existsSync(file)) return { ...out, missing: true };
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = /(?:proc=(\S+) )?BLOCKED (\S+)/.exec(line);
    if (!m) continue;
    out.total++;
    out.byProc[m[1] || '?'] = (out.byProc[m[1] || '?'] || 0) + 1;
    const pv = providerOf(m[2]);
    if (pv) out.byProvider[pv]++;
    else out.otherHosts[m[2]] = (out.otherHosts[m[2]] || 0) + 1;
  }
  return out;
}

/** Lista de URLs (fetch bloqueados del navegador simulado, requests de Chrome) → conteo por proveedor. */
function countUrls(urls) {
  const out = { total: 0, byProvider: emptyCounts(), otherHosts: {} };
  for (const u of urls || []) {
    let url;
    try { url = new URL(u); } catch (e) { continue; }
    out.total++;
    const pv = providerOf(url.hostname, url.pathname);
    if (pv) out.byProvider[pv]++;
    else out.otherHosts[url.hostname] = (out.otherHosts[url.hostname] || 0) + 1;
  }
  return out;
}

module.exports = { PROVIDERS, providerOf, countNetguardLog, countUrls, emptyCounts };
