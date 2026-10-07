#!/usr/bin/env node
/* eslint-disable */
// LOOP 8.6C · nginx de STAGING: 40 MB solo en /academic-context/extract(-advanced). Corre la auto-prueba del script
// (bloque de producción y redirect intactos, misma proxy_pass, idempotente) y verifica que deploy-staging.yml lo llama
// solo para api-staging, y que el workflow de PRODUCCIÓN no lo llama. Sin red, USD 0.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const REPO = path.resolve(__dirname, '..');
let failed = 0;
const ok = (c, m) => { console.log(`${c ? '✅' : '❌'} ${m}`); if (!c) failed++; };
const r = spawnSync('python3', [path.join(REPO, 'scripts/staging-nginx-extract-limit.py'), '--self-test'], { encoding: 'utf8' });
process.stdout.write(r.stdout || '');
ok(r.status === 0, 'auto-prueba del script de nginx');
const stg = fs.readFileSync(path.join(REPO, '.github/workflows/deploy-staging.yml'), 'utf8');
const prod = fs.readFileSync(path.join(REPO, '.github/workflows/deploy.yml'), 'utf8');
ok(/sudo python3 scripts\/staging-nginx-extract-limit\.py api-staging\.cursia\.nomaddi\.com 40m\n/.test(stg), 'deploy-staging.yml lo aplica a api-staging con 40m');
ok(!/staging-nginx-extract-limit/.test(prod), 'deploy.yml (producción) NO lo llama');
const step = stg.slice(stg.indexOf('[6b3]'), stg.indexOf('[6c]'));
ok(!step.includes("'"), 'el paso no rompe el bloque remoto entre comillas simples');
console.log(failed ? `\n${failed} fallas` : '\nOK');
process.exit(failed ? 1 : 0);
