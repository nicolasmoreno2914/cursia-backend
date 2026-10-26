/* eslint-disable */
// r75 · Agente E — entorno de la suite: PG descartable, app Nest real (dist/main.js) como proceso hijo, JWT HS256 local.
'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');

const REPO = process.env.REPO;
const OUT = process.env.OUT;
const R = (m) => require(path.join(REPO, 'node_modules', m));
const jwt = R('jsonwebtoken');
const { Client } = R('pg');
const PGPORT = Number(process.env.PGPORT_T);
const APP_PORT = Number(process.env.APP_PORT || 38475);
const JWT_SECRET = crypto.randomBytes(32).toString('hex');
const SERVICE_KEY = 'fake-service-role-key-r75-local-only';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let db;
async function dbConnect() {
  db = new Client({ host: '127.0.0.1', port: PGPORT, user: 'postgres', database: 'v2db' });
  await db.connect();
  return db;
}
const q = async (sql, params) => (await db.query(sql, params)).rows;
const tableExists = async (t) => (await q(`select to_regclass($1) is not null as x`, [`public.${t}`]))[0].x;
const columnExists = async (t, c) => (await q(`select 1 from information_schema.columns where table_schema='public' and table_name=$1 and column_name=$2`, [t, c])).length > 0;

const tokenFor = (u, extra = {}) => jwt.sign({ sub: u.id, email: u.email, role: 'authenticated', aud: 'authenticated', email_verified: true, ...extra }, JWT_SECRET, { algorithm: 'HS256', expiresIn: '4h' });

const BASE = `http://127.0.0.1:${APP_PORT}`;
async function api(method, p, { token, body, headers = {}, raw = false } = {}) {
  const h = { ...headers };
  if (body !== undefined) h['content-type'] = 'application/json';
  if (token) h.authorization = `Bearer ${token}`;
  const url = (p.startsWith('/health') ? BASE : BASE + '/api/v1') + p;
  const res = await fetch(url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  let data = json && json.data !== undefined ? json.data : null;
  // Doble sobre {data:{ok:true,data}} (algunos controllers devuelven {ok:true,data} y el interceptor lo envuelve otra vez):
  // se desenvuelve como hace el FE (60-r75-access-client unwrap) y se cuenta para el reporte.
  let doubleEnvelope = false;
  if (data && typeof data === 'object' && !Array.isArray(data) && data.ok === true && 'data' in data && Object.keys(data).length <= 3) { data = data.data; doubleEnvelope = true; api.doubleEnvelope.add(`${method} ${p.split('?')[0].replace(/[0-9a-f-]{36}|\b\d+\b/g, ':id')}`); }
  return {
    status: res.status, headers: Object.fromEntries(res.headers.entries()), doubleEnvelope,
    data, code: json && json.code, error: json && (json.error || json.message), json, text: raw ? text : undefined,
  };
}

api.doubleEnvelope = new Set();
let app = null;
function appEnv(fakes, extra = {}) {
  return {
    PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C', LC_ALL: 'C',
    NODE_ENV: 'production', NODE_PATH: path.join(REPO, 'node_modules'),
    NODE_OPTIONS: `--require ${JSON.stringify(path.join(REPO, 'test', 'e2e-v2', 'netguard.js'))}`, E2E_NET_LOG: path.join(OUT, 'net-violations.log'),
    DB_HOST: '127.0.0.1', DB_PORT: String(PGPORT), DB_USER: 'postgres', DB_PASS: 'x', DB_NAME: 'v2db', DB_SSL: 'false',
    SUPABASE_URL: fakes.url, SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY, SUPABASE_JWT_SECRET: JWT_SECRET,
    DYNAMIC_COURSE_STRUCTURE: 'true', DYNAMIC_MANIFEST_RULES_VERSION: '2',
    // Sin workers ni proveedores reales: los runs quedan encolados (USD 0).
    DYNAMIC_AUTO_HEAL_ENABLED: 'false', DYNAMIC_AUTO_PACKAGE_ENABLED: 'false',
    CURSIA_ACCOUNT_GUARD: 'enforce', CURSIA_RBAC_MODE: 'enforce', CURSIA_USER_BUDGETS: 'enforce',
    PORT: String(APP_PORT),
    ...extra,
  };
}
async function startApp(fakes, extra = {}, label = 'app') {
  const logFile = path.join(OUT, `${label}.log`);
  const fd = fs.openSync(logFile, 'a');
  const ch = spawn(process.execPath, [path.join(REPO, 'dist', 'main.js')], { cwd: OUT, env: appEnv(fakes, extra), stdio: ['ignore', fd, fd] });
  ch.exited = null; ch.logFile = logFile;
  ch.on('exit', (code, sig) => { ch.exited = { code, sig }; });
  const t0 = Date.now();
  while (Date.now() - t0 < 60000) {
    if (ch.exited) throw new Error(`app terminó al arrancar ${JSON.stringify(ch.exited)}: ${fs.readFileSync(logFile, 'utf8').slice(-1500)}`);
    try { const r = await fetch(`${BASE}/health`); if (r.ok) { app = ch; return ch; } } catch {}
    await sleep(250);
  }
  throw new Error('app no respondió /health en 60 s');
}
async function stopApp() {
  if (!app || app.exited) return;
  app.kill('SIGTERM');
  const t0 = Date.now();
  while (!app.exited && Date.now() - t0 < 15000) await sleep(100);
  if (!app.exited) app.kill('SIGKILL');
  await sleep(200);
}
async function restartApp(fakes, extra, label) { await stopApp(); return startApp(fakes, extra, label); }

module.exports = { REPO, OUT, PGPORT, APP_PORT, JWT_SECRET, SERVICE_KEY, sleep, dbConnect, q, tableExists, columnExists, tokenFor, api, startApp, stopApp, restartApp, appEnv, getApp: () => app };
