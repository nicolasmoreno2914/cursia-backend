#!/usr/bin/env node
// r84 · IPv4 primero en todos los procesos (USD 0, sin red externa). Corre contra dist/ (npm run build antes).
const fs = require('fs');
const path = require('path');
const dns = require('dns');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅ ' + m); } else { fail++; console.log('❌ ' + m); } };

const nf = require(path.join(__dirname, '..', 'dist', 'common', 'net-family.js'));

ok(nf.resolveOutboundDnsOrder({}) === 'ipv4first', 'sin variable → ipv4first');
ok(nf.resolveOutboundDnsOrder({ OUTBOUND_DNS_ORDER: ' VERBATIM ' }) === 'verbatim', 'verbatim (mayúsculas/espacios) → verbatim');
ok(nf.resolveOutboundDnsOrder({ OUTBOUND_DNS_ORDER: 'ipv6first' }) === 'ipv6first', 'ipv6first respetado');
ok(nf.resolveOutboundDnsOrder({ OUTBOUND_DNS_ORDER: 'basura' }) === 'ipv4first', 'valor desconocido → ipv4first');

ok(dns.getDefaultResultOrder() === 'ipv4first', 'al importar el módulo el proceso queda en ipv4first');
ok(nf.applyOutboundDnsOrder({ OUTBOUND_DNS_ORDER: 'verbatim' }) === 'verbatim' && dns.getDefaultResultOrder() === 'verbatim', 'kill switch verbatim aplica');
nf.applyOutboundDnsOrder({});

// Resolución real (local, sin red): un nombre con A y AAAA devuelve IPv4 primero.
dns.lookup('localhost', { all: true }, (err, addrs) => {
  if (!err && addrs.some((a) => a.family === 6)) ok(addrs[0].family === 4, 'localhost (A+AAAA) → IPv4 primero');
  else console.log('ℹ️  localhost sin AAAA en este equipo: se omite la prueba de orden real');

  // Cada entry point compilado importa net-family ANTES que cualquier otro módulo.
  const entries = ['main.js', ...['brand-extraction', 'audio', 'content', 'dynamic-item', 'dynamic-provider', 'dynamic-llm',
    'dynamic-package', 'full-course', 'h5p', 'gamma', 'package', 'video'].map((w) => `workers/${w}-worker.js`)];
  for (const e of entries) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'dist', e), 'utf8');
    const firstReq = (src.match(/require\(["']([^"']+)["']\)/) || [])[1] || '';
    ok(/common\/net-family$/.test(firstReq), `${e}: primer require = net-family (${firstReq || 'ninguno'})`);
  }
  console.log(`\nRESULTADO r84: ${pass} OK / ${fail} FALLAS`);
  process.exit(fail ? 1 : 0);
});
