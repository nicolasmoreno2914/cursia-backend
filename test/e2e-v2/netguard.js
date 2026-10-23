// Preload (NODE_OPTIONS=--require) para el app Nest y los workers del E2E:
// cualquier conexión TCP/TLS a algo que no sea loopback se BLOQUEA y se
// registra en $E2E_NET_LOG. No es código de producto: solo instrumentación.
// r58: la implementación vive en scripts/lib/netguard.js (la misma barrera que usa el driver offline).
'use strict';
require('../../scripts/lib/netguard').installSocketGuard({ allowLoopback: true, logFile: process.env.E2E_NET_LOG });
