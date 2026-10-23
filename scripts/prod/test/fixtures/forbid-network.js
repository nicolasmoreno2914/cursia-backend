'use strict';
// SOLO TESTS: precargado con `node -r` para PROBAR que un proceso no abre
// ninguna conexión de red ni carga el driver `pg`. Si lo intenta, sale con
// código 97 (socket) o 98 (pg) y un marcador en stderr.
const net = require('net');
const Module = require('module');

net.Socket.prototype.connect = function forbiddenConnect() {
  process.stderr.write('FORBIDDEN_NETWORK_CONNECT\n');
  process.exit(97);
};

// V2_TEST_ALLOW_PG_LOAD=1: los verify/audit existentes hacen require('pg') al
// cargar el módulo (sin conectar); para ellos solo se prohíbe la red.
const allowPg = process.env.V2_TEST_ALLOW_PG_LOAD === '1';
const origLoad = Module._load;
Module._load = function guardedLoad(request, ...rest) {
  if (request === 'pg' && !allowPg) {
    process.stderr.write('FORBIDDEN_PG_LOAD\n');
    process.exit(98);
  }
  return origLoad.call(this, request, ...rest);
};
