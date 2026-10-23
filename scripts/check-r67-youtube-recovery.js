#!/usr/bin/env node
/* eslint-disable */
// r67 (Tarea B + escenarios YouTube de la Tarea C: 4, 5, 6, 7, 8, 9, 14 y las partes YouTube de 15) — clasificación
// EXACTA por el reason del proveedor y subidas REANUDABLES sin duplicados. USD 0, sin red externa: un Google FALSO
// (endpoint OAuth + videos.insert resumable + consulta de estado + channels.list + descarga del MP4) en 127.0.0.1, y
// `fetch` reescribe SOLO los hosts de Google a ese fake (cualquier otro host → error). PG16 descartable con el
// SchedulerService / RunsService REALES (lease, skip locked, marcador antes de contactar a YouTube). Correr con
// netguard: NODE_OPTIONS=--require test/e2e-v2/netguard.js. Contra dist/ (npm run build).
//
// Cada escenario cuenta: sesiones videos.insert creadas, videos creados en el canal falso, bytes recibidos por PUT y
// llamadas a Videogen (siempre 0: la fase de subida nunca vuelve a pagar el render).
//
// Usage: node scripts/check-r67-youtube-recovery.js [--pure-only] [path/to/dist]
const fs = require('fs');
const os = require('os');
const net = require('net');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const args = process.argv.slice(2);
const PURE_ONLY = args.includes('--pure-only');
const distArg = args.find((a) => !a.startsWith('--'));
const REPO = path.resolve(__dirname, '..');
const distRoot = path.resolve(process.cwd(), distArg || 'dist');
function loadDist(rel) {
  try {
    return require(path.join(distRoot, rel));
  } catch (err) {
    console.error(`❌ No se pudo cargar ${rel} desde ${distRoot} (¿npm run build?): ${err.message}`);
    process.exit(1);
  }
}
require('reflect-metadata');
const { Logger } = require('@nestjs/common');
const YAE = loadDist('youtube/youtube-api-error.js');
const YUS = loadDist('youtube/youtube-upload.service.js');
const { YoutubeTokenService } = loadDist('youtube/youtube-token.service.js');
const DY = loadDist('modules/dynamic-generation/dynamic-youtube.js');
const DVD = loadDist('modules/dynamic-generation/dynamic-video-delivery.js');
const IW = loadDist('workers/dynamic-item-worker.js');
const RS = loadDist('modules/reliability/recovery-state.js');
const FC = loadDist('modules/reliability/failure-classifier.js');
const RUNS = loadDist('modules/dynamic-generation/runs.service.js');

const LOGS = [];
const capLogger = { log: (m) => LOGS.push(String(m)), warn: (m) => LOGS.push(String(m)), error: (m) => LOGS.push(String(m)), debug: () => {} };
Logger.overrideLogger({ log: capLogger.log, warn: capLogger.warn, error: capLogger.error, debug: () => {}, verbose: () => {} });

let passes = 0;
let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    passes++;
    console.log(`✅ ${name}`);
  } catch (err) {
    failures++;
    console.error(`❌ ${name}`);
    console.error(`   ${err && err.stack ? err.stack.split('\n').slice(0, 7).join('\n   ') : err}`);
  }
}
function assert(c, m) { if (!c) throw new Error(m); }
function eq(a, b, m) {
  const x = JSON.stringify(a);
  const y = JSON.stringify(b);
  if (x !== y) throw new Error(`${m}: esperado ${y}, encontrado ${x}`);
}
async function rejects(p) { try { await p; } catch (e) { return e; } throw new Error('no lanzó'); }

// ─── secretos FALSOS (para verificar que nunca salen en logs / errores / DB / DTO) ───────────────────────────────
const ACCESS_TOKEN = 'ya29.SECRET-r67-access-token-0123456789';
const REFRESH_TOKEN = '1//SECRET-r67-refresh-token';
const UPLOAD_ID_PREFIX = 'SECRETUPLOADIDr67x';
const SECRET_MARKERS = [ACCESS_TOKEN, 'SECRET-r67', UPLOAD_ID_PREFIX, '/upload/session/'];
function assertNoSecrets(text, label) {
  const s = typeof text === 'string' ? text : JSON.stringify(text);
  for (const m of SECRET_MARKERS) assert(!s.includes(m), `${label}: filtró «${m}» → ${s.slice(Math.max(0, s.indexOf(m) - 120), s.indexOf(m) + 80)}`);
  assert(!/Bearer\s+ya29/.test(s), `${label}: filtró una cabecera Authorization`);
}

// ─── MP4 sintético con caja mvhd (60 s) ────────────────────────────────────────────────────────────────────────
function box(type, payload) { const b = Buffer.alloc(8); b.writeUInt32BE(8 + payload.length, 0); b.write(type, 4, 'ascii'); return Buffer.concat([b, payload]); }
function syntheticMp4(bytes = 300_000, seed = 'r67') {
  const mvhd = Buffer.alloc(100);
  mvhd.writeUInt32BE(1000, 12); // timescale
  mvhd.writeUInt32BE(60_000, 16); // duration → 60 s
  const head = Buffer.concat([box('ftyp', Buffer.from('isom\0\0\x02\0isommp41', 'binary')), box('moov', box('mvhd', mvhd))]);
  const fill = Buffer.alloc(Math.max(16, bytes - head.length - 8));
  let x = parseInt(crypto.createHash('sha256').update(seed).digest('hex').slice(0, 8), 16) || 1;
  for (let i = 0; i < fill.length; i++) { x = (Math.imul(x, 1103515245) + 12345) >>> 0; fill[i] = (x >>> 16) & 0xff; }
  return Buffer.concat([head, box('mdat', fill)]);
}
const MP4 = syntheticMp4();

// ─── Google FALSO en 127.0.0.1 ──────────────────────────────────────────────────────────────────────────────────
function newGoogle() {
  const G = {
    tokenPlan: [], tokenCalls: 0, channelPlan: [], channelCalls: 0, initPlan: [], initCalls: 0, sessionsCreated: 0,
    sessions: new Map(), putPlan: [], statusPlan: [], dataPuts: 0, statusQueries: 0, bytesPut: 0, videos: [], contiguityErrors: 0,
    downloads: 0, held: [], authOnPut: 0,
  };
  const json = (res, status, obj, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(obj)); };
  const gErr = (res, status, reason, domain = 'youtube.video') => json(res, status, { error: { code: status, message: `fake ${reason} SECRET-r67 Bearer ${ACCESS_TOKEN}`, errors: [{ reason, domain, message: `fake ${reason}` }] } });
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (req.method === 'POST' && u.pathname === '/token') {
      G.tokenCalls++;
      const p = G.tokenPlan.shift() || 'ok';
      req.resume();
      req.on('end', () => {
        if (p === 'ok') return json(res, 200, { access_token: ACCESS_TOKEN, expires_in: 3599 });
        if (p === 'invalid_grant') return json(res, 400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' });
        if (p === 'invalid_client') return json(res, 401, { error: 'invalid_client', error_description: 'The OAuth client was not found.' });
        if (p === '503') { res.writeHead(503, { 'content-type': 'text/html' }); return res.end('<html>Service Unavailable</html>'); }
        if (p === 'nonjson') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<html>login</html>'); }
        if (p === 'reset') return req.socket.destroy();
        if (p === 'hang') return; // nunca responde (el timeout del cliente corta)
        throw new Error('tokenPlan ' + p);
      });
      return;
    }
    if (req.method === 'GET' && u.pathname === '/youtube/v3/channels') {
      G.channelCalls++;
      const p = G.channelPlan.shift() || 'ok';
      if (p === 'ok') return json(res, 200, { items: [{ id: 'UCfakeR67channel000000000', snippet: { title: 'Canal falso' } }] });
      if (p === 'quota') return gErr(res, 403, 'quotaExceeded', 'youtube.quota');
      return gErr(res, 403, p);
    }
    if (req.method === 'GET' && u.pathname.startsWith('/dl/')) {
      G.downloads++;
      res.writeHead(200, { 'content-type': 'video/mp4' });
      return res.end(MP4);
    }
    if (req.method === 'POST' && u.pathname === '/upload/youtube/v3/videos') {
      G.initCalls++;
      assert(String(req.headers.authorization || '') === `Bearer ${ACCESS_TOKEN}`, 'init sin Authorization');
      const p = G.initPlan.shift() || 'ok';
      req.resume();
      req.on('end', () => {
        if (p === 'ok') {
          const id = `${UPLOAD_ID_PREFIX}${++G.sessionsCreated}`;
          G.sessions.set(id, { total: Number(req.headers['x-upload-content-length']), received: 0, complete: false, videoId: null, expired: false });
          res.writeHead(200, { location: `${BASE}/upload/session/${id}?upload_id=${id}`, 'x-guploader-uploadid': id });
          return res.end('');
        }
        if (p === 'network') return req.socket.destroy();
        if (typeof p === 'number') { res.writeHead(p, { 'content-type': 'text/plain' }); return res.end(`err ${p}`); }
        return gErr(res, p.status, p.reason, p.domain);
      });
      return;
    }
    const m = /^\/upload\/session\/([A-Za-z0-9]+)$/.exec(u.pathname);
    if (req.method === 'PUT' && m) {
      const s = G.sessions.get(m[1]);
      if (!s) { req.resume(); return gErr(res, 404, 'notFound'); }
      if (req.headers.authorization) G.authOnPut++;
      const cr = String(req.headers['content-range'] || '');
      const sq = /^bytes \*\/(\d+)$/.exec(cr);
      if (sq) {
        G.statusQueries++;
        req.resume();
        const sp = G.statusPlan.shift() || 'ok';
        if (sp === 'reset') return req.socket.destroy();
        if (s.expired) return gErr(res, 404, 'notFound');
        if (s.complete) return json(res, 201, { kind: 'youtube#video', id: s.videoId });
        if (s.received > 0) { res.writeHead(308, { range: `bytes=0-${s.received - 1}` }); return res.end(''); }
        res.writeHead(308); return res.end('');
      }
      G.dataPuts++;
      let start = 0;
      const rm = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(cr);
      if (rm) start = Number(rm[1]);
      if (start !== s.received) G.contiguityErrors++;
      const p = G.putPlan.shift() || 'ok';
      let got = 0;
      let cut = false;
      req.on('data', (c) => {
        if (cut) return;
        if (p && typeof p === 'object' && p.cutAfter !== undefined && got + c.length >= p.cutAfter) {
          const take = p.cutAfter - got;
          got += take; G.bytesPut += take; s.received = start + got;
          cut = true;
          if (p.hold) { G.held.push(() => req.socket.destroy()); req.pause(); return; }
          return req.socket.destroy();
        }
        got += c.length; G.bytesPut += c.length;
      });
      req.on('end', () => {
        if (cut) return;
        if (p === 'ok' || p === 'complete_then_cut') {
          s.received = start + got;
          if (s.received === s.total) {
            s.complete = true;
            s.videoId = `YtR67${String(++VIDEO_SEQ).padStart(6, '0')}`;
            G.videos.push(s.videoId);
          }
          if (p === 'complete_then_cut') return req.socket.destroy();
          if (s.complete) return json(res, 201, { kind: 'youtube#video', id: s.videoId });
          res.writeHead(308, { range: `bytes=0-${s.received - 1}` }); return res.end('');
        }
        if (typeof p === 'number') { res.writeHead(p, { 'content-type': 'text/plain' }); return res.end(`err ${p}`); }
        return gErr(res, p.status, p.reason, p.domain);
      });
      return;
    }
    res.writeHead(404); res.end('?');
  });
  return { G, srv };
}
let BASE = '';
// Ids de video únicos en TODA la corrida (el ledger de cuota es idempotente por videoId).
let VIDEO_SEQ = 0;
const google = newGoogle();
const G = google.G;
function resetGoogle() {
  for (const k of ['tokenPlan', 'channelPlan', 'initPlan', 'putPlan', 'statusPlan']) G[k] = [];
  for (const k of ['tokenCalls', 'channelCalls', 'initCalls', 'dataPuts', 'statusQueries', 'bytesPut', 'contiguityErrors', 'downloads', 'authOnPut']) G[k] = 0;
  G.sessionsCreated = 0; G.sessions.clear(); G.videos = []; G.held = [];
}

// Solo los hosts de Google se reescriben al fake; cualquier otro host fuera de loopback → error (además del netguard).
const realFetch = global.fetch;
global.fetch = (input, init) => {
  let url = String(typeof input === 'string' ? input : input.url);
  if (url === 'https://oauth2.googleapis.com/token') url = `${BASE}/token`;
  else if (url.startsWith('https://www.googleapis.com/')) url = BASE + url.slice('https://www.googleapis.com'.length);
  else if (!/^http:\/\/127\.0\.0\.1:\d+\//.test(url)) return Promise.reject(new Error('red no esperada en el check: ' + url.slice(0, 60)));
  return realFetch(url, init);
};

process.env.YOUTUBE_TOKEN_SECRET = crypto.randomBytes(32).toString('hex');
const tokens = new YoutubeTokenService();
tokens.onModuleInit();
tokens.refreshTimeoutMs = 300;
const uploader = new YUS.YoutubeUploadService(tokens);
function connection() {
  const { encrypted, iv } = tokens.encryptRefreshToken(REFRESH_TOKEN);
  return { id: 1, userId: OWNER, status: 'active', scopes: 'youtube.upload,youtube.readonly', encryptedRefreshToken: encrypted, tokenIv: iv, channelId: 'UCfakeR67channel000000000' };
}
/** Publicador REAL (mismo cableado que el bootstrap del worker), sobre el Google falso. */
function realPublisher() {
  return {
    getConnection: async () => connection(),
    getAccessToken: (c) => tokens.getAccessToken(c.encryptedRefreshToken, c.tokenIv),
    uploadFromUrl: (c, o) => uploader.uploadFromUrl(c, o),
    resumable: true,
    sealSecret: (p) => tokens.encryptSecret(p),
    openSecret: (e, iv) => tokens.decryptSecret(e, iv),
    probeChannel: async (c) => DY.probeYoutubeChannel(await tokens.getAccessToken(c.encryptedRefreshToken, c.tokenIv)),
  };
}
const OWNER = '11111111-2222-4333-8444-555555555555';

// ════════════════════════════════════════════════════════════════════════════
async function pureChecks() {
  const I = (phase, httpStatus, reason) => ({ phase, httpStatus, reason, domain: null, message: null, requestId: null });
  await check('B2 puro: tabla reason → decisión (doc oficial; nunca solo por status)', () => {
    const k = (i) => DY.classifyYoutubeErrorInfo(i);
    const table = [
      [I('init', 403, 'quotaExceeded'), 'quota_project'],
      [I('upload', 403, 'quotaExceeded'), 'quota_project'],
      [I('init', 400, 'uploadLimitExceeded'), 'quota_channel'],
      [I('init', 403, 'uploadLimitExceeded'), 'quota_channel'],
      [I('init', 403, 'rateLimitExceeded'), 'rate_limited'],
      [I('upload', 403, 'userRateLimitExceeded'), 'rate_limited'],
      [I('refresh', 400, 'invalid_grant'), 'auth_definitive'],
      [I('refresh', 401, 'invalid_client'), 'auth_definitive'],
      [I('refresh', 401, null), 'auth_definitive'],
      [I('refresh', 400, 'algo_desconocido'), 'auth_definitive'],
      [I('refresh', null, 'network'), 'transient'],
      [I('refresh', null, 'timeout'), 'transient'],
      [I('refresh', 503, null), 'transient'],
      [I('refresh', 200, 'non_json'), 'transient'],
      [I('refresh', 200, 'no_access_token'), 'transient'],
      [I('refresh', 503, 'invalid_grant'), 'auth_definitive'],
      [I('init', 403, 'insufficientPermissions'), 'permission'],
      [I('init', 401, 'youtubeSignupRequired'), 'permission'],
      [I('init', 403, 'channelSuspended'), 'permission'],
      [I('init', 403, 'channelNotFound'), 'permission'],
      [I('init', 403, 'authenticatedUserNotChannel'), 'permission'],
      [I('init', 403, 'forbiddenPrivacySetting'), 'permission'],
      [I('init', 403, 'motivoRaroNoDocumentado'), 'permission'],
      [I('init', 403, 'forbidden'), 'auth_uncertain'],
      [I('init', 403, null), 'auth_uncertain'],
      [I('init', 401, null), 'auth_uncertain'],
      [I('upload', 401, null), 'auth_uncertain'],
      [I('init', 503, null), 'transient'],
      [I('init', 500, 'backendError'), 'transient'],
      [I('init', 429, null), 'transient'],
      [I('init', null, 'network'), 'transient'],
      [I('init', 200, 'no_location'), 'transient'],
      [I('init', 400, 'invalidTitle'), 'rejected'],
      [I('init', 400, null), 'rejected'],
      [I('upload', 503, null), 'transient'],
      [I('upload', null, 'network'), 'ambiguous'],
      [I('upload', null, 'timeout'), 'ambiguous'],
      [I('upload', 200, 'no_video_id'), 'ambiguous'],
      [I('upload', 400, null), 'ambiguous'],
      [I('status', 404, 'notFound'), 'session_expired'],
      [I('status', 410, null), 'session_expired'],
      [I('status', null, 'network'), 'ambiguous'],
      [I('channel', 403, 'quotaExceeded'), 'quota_project'],
      [I('channel', null, 'network'), 'transient'],
    ];
    for (const [info, want] of table) eq(k(info), want, `${info.phase}/${info.httpStatus}/${info.reason}`);
  });

  await check('B2 puro: excepciones sin error estructurado (fakes viejos) → clasificación gruesa de siempre, auth = humano; nunca ambiguo antes de contactar a YouTube', () => {
    const { UnauthorizedException, BadRequestException } = require('@nestjs/common');
    const f = (e, c) => DY.classifyYoutubeFailure(e, { contactedYoutube: c });
    eq([f(new UnauthorizedException('x'), true).kind, f(new UnauthorizedException('x'), true).human], ['auth_definitive', true], 'auth');
    eq(f(new YUS.YoutubeQuotaException(), true).kind, 'quota_project', 'quota');
    eq(f(new BadRequestException('x'), false).kind, 'download', 'download');
    eq(f(new YUS.YoutubeUploadTransportError('x', 'upload'), true).kind, 'ambiguous', 'corte');
    eq(f(new YUS.YoutubeUploadTransportError('x', 'upload'), false).kind, 'download', 'antes de contactar: nunca ambiguo');
    eq(f(new YUS.YoutubeUploadTransportError('x', 'upload', 503), true).kind, 'transient', '5xx explícito');
    eq(f(new Error('boom'), true).kind, 'ambiguous', 'desconocido a mitad de la subida');
    eq(DY.classifyYoutubeUploadError(new YUS.YoutubeUploadTransportError('x', 'refresh')), 'transient', 'grueso: refresh transitorio');
  });

  await check('B4 puro: ventanas de cuota 1 h/3 h/6 h/12 h/24 h… y sondas de auth 5 min/30 min/2 h → humano (acotado)', () => {
    eq([1, 2, 3, 4, 5, 6, 9].map(IW.youtubeQuotaWindowSeconds), [3600, 10800, 21600, 43200, 86400, 86400, 86400], 'cuota');
    eq([1, 2, 3, 4].map(IW.youtubeAuthProbeDelaySeconds), [300, 1800, 7200, null], 'sondas');
  });

  await check('B1 puro: saneado de texto del proveedor (Bearer, ya29, 1//, URLs con upload_id, cadenas tipo token) y requestId solo como hash', () => {
    const t = YAE.sanitizeProviderText(`Bearer ${ACCESS_TOKEN} at http://h/upload/session/${UPLOAD_ID_PREFIX}9?upload_id=${UPLOAD_ID_PREFIX}9 refresh ${REFRESH_TOKEN} ${'A'.repeat(50)}`);
    assertNoSecrets(t, 'saneado');
    assert(!t.includes('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'), 'cadena larga');
    const rid = YAE.safeRequestIdOf({ get: () => `${UPLOAD_ID_PREFIX}1` });
    assert(/^[0-9a-f]{16}$/.test(rid) && !rid.includes(UPLOAD_ID_PREFIX), 'requestId hash');
    eq([YUS.rangeNextOffset('bytes=0-99999'), YUS.rangeNextOffset(null), YUS.rangeNextOffset('basura')], [100000, 0, 0], 'Range');
  });

  await check('B3 puro: la sesión resumable nunca sale en un DTO (progressOutputSummary / item reclamado) — solo present/createdAt/bytes', () => {
    const os = { delivery: 'uploading_youtube', youtubeSession: { uriEnc: 'CIPHER', iv: 'IV', createdAt: 't', bytes: 5, sha256: 'h' } };
    const out = RUNS.progressOutputSummary(os);
    eq(out.youtubeSession, { present: true, createdAt: 't', bytes: 5 }, 'sin uriEnc/iv');
    assert(!JSON.stringify(out).includes('CIPHER') && !JSON.stringify(out).includes('"IV"'), 'sin cifrado');
    eq(RUNS.stripYoutubeSessionSecret({ a: 1 }), { a: 1 }, 'sin sesión: intacto');
  });

  await check('B4 puro: máquina de estados — sonda de auth / límite del canal = waiting_external_quota; clasificador con reglas explícitas para los códigos nuevos', () => {
    const now = new Date();
    const v = RS.recoveryStateOf({ status: 'retrying', error: 'youtube_auth_probe: x', next_retry_at: new Date(now.getTime() + 300e3), output_summary: { delivery: 'blocked_auth', youtubeAuthProbe: { failures: 1 } } }, now);
    eq([v.state, v.reason, v.automatic], ['waiting_external_quota', 'youtube_auth_probe', true], 'sonda');
    const c = RS.recoveryStateOf({ status: 'retrying', error: 'youtube_blocked_quota: x', output_summary: { delivery: 'blocked_quota', youtubeQuotaScope: 'channel', youtubeChannelLimitUntil: new Date(now.getTime() + 3600e3).toISOString() } }, now);
    eq([c.state, c.reason], ['waiting_external_quota', 'youtube_channel_limit'], 'canal');
    const cl = (e) => FC.classifyFailure({ source: 'video_worker', itemType: 'video', error: e });
    eq([cl('youtube_auth_probe: x').class, cl('youtube_auth_probe: x').unclassified], ['A', false], 'probe');
    eq([cl('youtube_upload_unconfirmed: x').class, cl('youtube_upload_unconfirmed: x').unclassified], ['A', false], 'unconfirmed');
    eq([cl('youtube_upload_rejected: x').class, cl('youtube_upload_rejected: x').humanReason], ['D', 'config'], 'rejected');
  });
}

// ════════════════════════════════════════════════════════════════════════════
// S — servicio REAL (YoutubeUploadService + YoutubeTokenService) contra el Google falso por HTTP
async function serviceChecks() {
  const dl = `${BASE}/dl/s1`;
  const up = (extra = {}) => uploader.uploadFromUrl(connection(), { downloadUrl: dl, title: 'T', privacyStatus: 'unlisted', ...extra });
  const kindOf = async (fn) => { const e = await rejects(fn()); return { e, d: DY.classifyYoutubeFailure(e, { contactedYoutube: true }) }; };

  for (const [plan, wantKind, wantReason] of [
    ['invalid_grant', 'auth_definitive', 'invalid_grant'],
    ['invalid_client', 'auth_definitive', 'invalid_client'],
    ['503', 'transient', null],
    ['nonjson', 'transient', 'non_json'],
    ['reset', 'transient', 'network'],
    ['hang', 'transient', 'timeout'],
  ]) {
    await check(`6 refresh «${plan}» → ${wantKind} (phase=refresh${wantReason ? `, reason=${wantReason}` : ''}); 0 sesiones, sin tokens en el error ni en el log`, async () => {
      resetGoogle(); LOGS.length = 0;
      G.tokenPlan = [plan];
      const { e, d } = await kindOf(() => up());
      eq([d.kind, d.info && d.info.phase], [wantKind, 'refresh'], 'decisión');
      if (wantReason) eq(d.info.reason, wantReason, 'reason');
      if (plan === '503') eq(d.info.httpStatus, 503, 'status');
      eq([G.initCalls, G.sessionsCreated, G.bytesPut], [0, 0, 0], 'no contactó videos.insert');
      assertNoSecrets(JSON.stringify(d.info) + e.message + LOGS.join('\n'), 'refresh');
    });
  }

  for (const [label, init, kind] of [
    ['403 quotaExceeded', { status: 403, reason: 'quotaExceeded', domain: 'youtube.quota' }, 'quota_project'],
    ['400 uploadLimitExceeded (doc)', { status: 400, reason: 'uploadLimitExceeded' }, 'quota_channel'],
    ['403 uploadLimitExceeded', { status: 403, reason: 'uploadLimitExceeded' }, 'quota_channel'],
    ['403 rateLimitExceeded', { status: 403, reason: 'rateLimitExceeded', domain: 'usageLimits' }, 'rate_limited'],
    ['403 forbidden', { status: 403, reason: 'forbidden' }, 'auth_uncertain'],
    ['403 insufficientPermissions', { status: 403, reason: 'insufficientPermissions' }, 'permission'],
    ['401 youtubeSignupRequired', { status: 401, reason: 'youtubeSignupRequired' }, 'permission'],
    ['400 invalidTitle', { status: 400, reason: 'invalidTitle' }, 'rejected'],
    ['503 sin cuerpo', 503, 'transient'],
    ['red caída', 'network', 'transient'],
  ]) {
    await check(`S init ${label} → ${kind}; youtubeLastError estructurado (phase/httpStatus/reason/domain/requestId), 0 sesiones, 0 bytes, sin secretos`, async () => {
      resetGoogle(); LOGS.length = 0;
      G.initPlan = [init];
      const { e, d } = await kindOf(() => up({ resumable: { onSessionCreated: async () => { throw new Error('no debería crearse'); } } }));
      eq(d.kind, kind, 'decisión');
      eq(d.info.phase, 'init', 'fase');
      if (typeof init === 'object') eq([d.info.httpStatus, d.info.reason], [init.status, init.reason], 'status/reason');
      eq([G.sessionsCreated, G.bytesPut, G.dataPuts], [0, 0, 0], 'nada subido');
      assertNoSecrets(JSON.stringify(d.info) + e.message + LOGS.join('\n'), 'init');
    });
  }

  await check('7 S corte a mitad del PUT → consulta de estado (308, Range) → reanuda desde Range; 1 sesión, 1 video, bytes = tamaño (sin solapes), 0 bytes re-enviados', async () => {
    resetGoogle(); LOGS.length = 0;
    G.putPlan = [{ cutAfter: 100_000 }];
    let saved = null;
    const r = await up({ resumable: { onSessionCreated: async (s) => { saved = s; } } });
    eq([r.outcome, G.sessionsCreated, G.videos.length, G.bytesPut, G.dataPuts, G.statusQueries, G.contiguityErrors], ['resumed', 1, 1, MP4.length, 2, 1, 0], 'reanudación');
    eq(r.videoId, G.videos[0], 'id');
    assert(saved && saved.bytes === MP4.length && /^[0-9a-f]{64}$/.test(saved.sha256), 'sesión entregada al worker antes del primer byte');
    assertNoSecrets(LOGS.join('\n') + JSON.stringify(r), 'logs/resultado');
  });

  await check('8 S subida COMPLETA con la respuesta perdida → consulta de estado 201 → confirma el videoId; CERO re-subida (1 PUT de datos, bytes = tamaño)', async () => {
    resetGoogle();
    G.putPlan = ['complete_then_cut'];
    const r = await up({ resumable: { onSessionCreated: async () => {} } });
    eq([r.videoId, G.sessionsCreated, G.videos.length, G.dataPuts, G.bytesPut, G.statusQueries], [G.videos[0], 1, 1, 1, MP4.length, 1], 'confirmado sin re-subir');
  });

  await check('8 S sesión guardada de una subida que ya terminó → solo la consulta de estado (201), 0 sesiones nuevas, 0 bytes', async () => {
    resetGoogle();
    G.putPlan = ['complete_then_cut'];
    G.statusPlan = ['reset'];
    let saved = null;
    const e = await rejects(up({ resumable: { onSessionCreated: async (s) => { saved = s; } } }));
    eq(DY.classifyYoutubeFailure(e, { contactedYoutube: true }).kind, 'ambiguous', 'la consulta inmediata falló → ambiguo (con sesión)');
    const before = { s: G.sessionsCreated, b: G.bytesPut, p: G.dataPuts };
    const r = await up({ resumable: { session: saved, onSessionCreated: async () => { throw new Error('no debería abrir otra'); } } });
    eq([r.outcome, r.bytesSent, G.sessionsCreated - before.s, G.bytesPut - before.b, G.dataPuts - before.p, G.videos.length], ['confirmed_existing', 0, 0, 0, 0, 1], 'cero re-subida');
  });

  await check('S sesión vencida (404) → YoutubeSessionExpiredError (el worker decide); MP4 distinto al de la sesión → nunca reanuda (mismatch)', async () => {
    resetGoogle();
    G.putPlan = [{ cutAfter: 50_000 }];
    G.statusPlan = ['reset'];
    let saved = null;
    await rejects(up({ resumable: { onSessionCreated: async (s) => { saved = s; } } }));
    G.sessions.get([...G.sessions.keys()][0]).expired = true;
    const e = await rejects(up({ resumable: { session: saved, onSessionCreated: async () => {} } }));
    eq(DY.classifyYoutubeFailure(e, { contactedYoutube: true }).kind, 'session_expired', '404');
    const e2 = await rejects(up({ resumable: { session: { ...saved, sha256: 'f'.repeat(64) }, onSessionCreated: async () => {} } }));
    eq(DY.classifyYoutubeFailure(e2, { contactedYoutube: true }).kind, 'session_mismatch', 'mismatch');
    eq(G.sessionsCreated, 1, 'nunca una sesión nueva sola');
  });

  await check('S sesión que no se pudo persistir → se aborta ANTES del primer byte (0 bytes, sin video)', async () => {
    resetGoogle();
    const e = await rejects(up({ resumable: { onSessionCreated: async () => { throw new Error('db caída'); } } }));
    assert(e instanceof YUS.YoutubeSessionPersistError, 'persist error');
    eq([G.sessionsCreated, G.dataPuts, G.bytesPut, G.videos.length], [1, 0, 0, 0], 'sin bytes');
  });

  await check('S modo legacy (sin resumable): mismo flujo de siempre — corte del PUT = ambiguo, sin consulta de estado', async () => {
    resetGoogle();
    G.putPlan = [{ cutAfter: 10_000 }];
    const e = await rejects(up());
    eq([DY.classifyYoutubeUploadError(e), G.statusQueries], ['ambiguous', 0], 'legacy');
  });
}

// ════════════════════════════════════════════════════════════════════════════
function findPgBin() {
  for (const d of [process.env.PG_BIN, '/opt/homebrew/opt/postgresql@16/bin', '/opt/homebrew/bin', '/usr/lib/postgresql/16/bin'].filter(Boolean)) {
    const pg = path.join(d, 'postgres');
    if (fs.existsSync(pg) && /\b16\./.test(spawnSync(pg, ['--version'], { encoding: 'utf8' }).stdout || '')) return d;
  }
  throw new Error('No encontré Postgres 16 (setear PG_BIN)');
}
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => ([5570, 8099].includes(port) ? freePort().then(resolve, reject) : resolve(port))); });
  });
}
function cleanEnv(extra) {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C', LC_ALL: 'C' };
  for (const [k, v] of Object.entries(extra || {})) if (v !== undefined && v !== null) env[k] = String(v);
  return env;
}
const CONTEXT = { nombre: 'Curso r67 YT', sector: 'Minería', pais: 'Chile', contexto: 'Planta', nivel: 'Intermedio', tono: 'cercano' };
const CONTENT_MD = (t) => `# ${t}\n\nLa bomba de engranajes mueve el aceite a presión constante. El técnico revisa ruido, temperatura y caudal en cada turno.\n\n## Mantenimiento\n\nSe cambia el filtro y se registra la presión.`;

async function dbChecks() {
  const { Client } = require('pg');
  const { DataSource } = require('typeorm');
  const { startStorage } = require(path.join(REPO, 'test/e2e-v2/fakes.js'));
  const snap = loadDist('modules/course-blueprints/blueprint-snapshot.js');
  const { CourseBlueprintsService } = loadDist('modules/course-blueprints/course-blueprints.service.js');
  const { GenerationManifestsService } = loadDist('modules/generation-manifests/generation-manifests.service.js');
  const { RunsService } = loadDist('modules/dynamic-generation/runs.service.js');
  const { SchedulerService } = loadDist('modules/dynamic-generation/scheduler.service.js');
  const { ArtifactsService } = loadDist('modules/artifacts/artifacts.service.js');
  const { Artifact } = loadDist('modules/artifacts/entities/artifact.entity.js');
  const ATT = loadDist('modules/reliability/attempt-log.js');
  const F = loadDist('modules/finops/index.js');

  const pgBin = findPgBin();
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-r67yt-pg16-'));
  const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-r67yt-cwd-'));
  const ROLE = 'postgres.r67ytlocaltest1';
  const DB = 'r67ytdb';
  let started = false;
  const pg = (bin, a) => spawnSync(path.join(pgBin, bin), a, { env: cleanEnv(), encoding: 'utf8' });
  let ds = null;
  const storage = startStorage();
  try {
    let r = pg('initdb', ['-D', dataDir, '-U', 'postgres', '--auth=trust', '-E', 'UTF8', '--locale=C']);
    if (r.status !== 0) throw new Error('initdb falló: ' + r.stderr);
    r = pg('pg_ctl', ['-D', dataDir, '-l', path.join(dataDir, 'server.log'), '-w', '-o', `-p ${port} -k ${dataDir} -c listen_addresses=127.0.0.1`, 'start']);
    if (r.status !== 0) throw new Error('pg_ctl start falló: ' + r.stderr + r.stdout);
    started = true;
    console.log(`\nPostgres ${pgBin} en 127.0.0.1:${port}`);
    const withClient = async (db, fn) => { const c = new Client({ host: '127.0.0.1', port, user: 'postgres', database: db }); await c.connect(); try { return await fn(c); } finally { await c.end(); } };
    await withClient('postgres', async (c) => { await c.query(`create database ${DB}`); await c.query(`create role "${ROLE}" superuser login`); });
    const localEnv = (extra) => ({ DB_HOST: '127.0.0.1', DB_PORT: port, DB_USER: ROLE, DB_PASS: 'x', DB_NAME: DB, DB_SSL: 'false', ...extra });
    const runScript = (script, env) => {
      const res = spawnSync(process.execPath, [path.join(REPO, script)], { cwd: tmpCwd, env: cleanEnv(env), encoding: 'utf8', timeout: 120000 });
      return { code: res.status, out: (res.stdout || '') + (res.stderr || '') };
    };
    await withClient(DB, async (c) => {
      for (const f of ['scripts/prod/test/fixtures/legacy-baseline.sql', 'supabase-migration-dynamic-course-structure.sql',
        'supabase-migration-course-blueprints.sql', 'supabase-migration-generation-manifests.sql']) await c.query(fs.readFileSync(path.join(REPO, f), 'utf8'));
    });
    { const res = runScript('scripts/migrate-production-jobs-constraints.js', localEnv({})); assert(res.code === 0, `constraints: ${res.out}`); }
    await withClient(DB, async (c) => {
      for (const f of ['supabase-migration-dynamic-generation.sql', 'supabase-migration-v21-blueprint-profiles.sql']) await c.query(fs.readFileSync(path.join(REPO, f), 'utf8'));
    });
    for (const s of ['scripts/migrate-dynamic-generation-v2.js', 'scripts/migrate-invalidation.js', 'scripts/migrate-v21-manifest-v3.js',
      'scripts/migrate-v21-finops.js', 'scripts/verify-v21-finops-schema.js', 'scripts/migrate-rel-recovery.js']) {
      const res = runScript(s, localEnv({ MIGRATION_ENV: 'staging' }));
      assert(res.code === 0, `${s}: exit ${res.code}\n${res.out.slice(-2000)}`);
    }
    await new Promise((res) => storage.srv.listen(0, '127.0.0.1', res));
    const storageUrl = `http://127.0.0.1:${storage.srv.address().port}`;
    Object.assign(process.env, {
      DYNAMIC_COURSE_STRUCTURE: 'true', DYNAMIC_REAL_VIDEO_OWNERS: OWNER, DYNAMIC_MANIFEST_RULES_VERSION: '3', DYNAMIC_VIDEO_DELIVERY: 'youtube',
      DYNAMIC_PROVIDER_WORKER_ENABLED: 'true', DYNAMIC_ALLOW_VIDEO_PREVIEW: 'true', SUPER_ADMIN_EMAILS: 'admin@cursia.test',
      SUPABASE_URL: storageUrl, SUPABASE_SERVICE_ROLE_KEY: 'fake-service-role-local-only', VIDEOGEN_API_KEY: 'sk-r67yt-videogen-fake',
      // Proveedores de los OTROS items (que el harness da por completados): claves FALSAS y bases a un puerto muerto
      // de loopback — cualquier llamada accidental falla local, nunca sale a la red.
      GAMMA_API_KEY: 'sk-r67yt-gamma-fake', GAMMA_THEME_V21_LIGHT_DEFAULT: 'theme-r67-light', GAMMA_THEME_V21_DARK_DEFAULT: 'theme-r67-dark',
      OPENAI_API_KEY: 'sk-r67yt-openai-fake', ANTHROPIC_API_KEY: 'sk-r67yt-anthropic-fake',
      GAMMA_API_BASE_URL: 'http://127.0.0.1:9', OPENAI_API_BASE_URL: 'http://127.0.0.1:9', ANTHROPIC_API_BASE_URL: 'http://127.0.0.1:9',
    });
    process.env.R67_ORPHAN_SWEEP_SINCE = new Date(Date.now() - 60_000).toISOString();
    for (const k of ['DYNAMIC_V2_ALLOWED_OWNERS', 'ALLOW_UNOWNED_COURSES', 'DYNAMIC_ALLOW_VIDEOGEN_DIRECT', 'FINOPS_KILL_SWITCH', 'FINOPS_PROVIDER_ALLOWLIST', 'DYNAMIC_AUTO_HEAL_POLICY']) delete process.env[k];

    ds = new DataSource({ type: 'postgres', host: '127.0.0.1', port, username: 'postgres', database: DB, entities: [Artifact], synchronize: false });
    await ds.initialize();
    ATT.resetRelSchemaCache();
    const blueprints = new CourseBlueprintsService(ds);
    const manifests = new GenerationManifestsService(ds, blueprints);
    const ledger = new F.FinopsLedgerService(ds);
    const budget = new F.FinopsBudgetService(ds, ledger);
    const ytPreflight = { async check() { return { ok: true }; } };
    const runs = new RunsService(ds, manifests, {}, ytPreflight, budget);
    const runs2 = new RunsService(ds, manifests, {}, ytPreflight, budget);
    const sched = new SchedulerService(ds, runs);
    const sched2 = new SchedulerService(ds, runs2);
    const artifacts = new ArtifactsService(ds.getRepository(Artifact), { get: (k) => process.env[k] });

    async function makeCourse(title) {
      const [course] = await ds.query(`insert into public.courses (owner_id, title, structure_version) values ($1, $2, 'dynamic') returning id`, [OWNER, title]);
      const cid = course.id;
      const m1 = crypto.randomUUID(); const c1 = crypto.randomUUID();
      const s2 = snap.buildBlueprintSnapshotV2(
        { id: cid, title, finalExam: false, activityEngine: 'h5p' },
        [{ id: m1, position: 0, title: 'M1', objective: null, exam_enabled: false }],
        [{ id: c1, module_id: m1, position: 0, title: 'Bombas', objective: null, video_enabled: true, activity_enabled: false }],
      );
      for (const m of s2.modules) {
        await ds.query(`insert into public.course_modules (id, course_id, position, title) values ($1, $2, $3, $4)`, [m.id, cid, m.position, m.title]);
        for (const c of m.chapters) {
          await ds.query(`insert into public.course_chapters (id, course_id, module_id, position, title, video_enabled, activity_enabled) values ($1, $2, $3, $4, $5, $6, $7)`,
            [c.id, cid, m.id, c.position, c.title, c.videoEnabled, c.activityEnabled]);
        }
      }
      await ds.query(
        `insert into public.course_blueprints (course_id, blueprint_number, schema_version, snapshot_json, snapshot_sha256, structure_counter_at_lock, module_count, chapter_count)
         values ($1, 1, 2, $2::jsonb, $3, 0, 1, 1)`, [cid, snap.canonicalJsonV2(s2), snap.snapshotSha256V2(s2)]);
      await manifests.getOrCreate(cid, OWNER, 1);
      return { cid, c1, m1 };
    }
    const itemRow = async (runId, key) => (await ds.query(`select * from public.generation_item_runs where job_id = $1 and item_key = $2 order by generation desc limit 1`, [runId, key]))[0];
    const jobRow = async (runId) => (await ds.query(`select * from public.production_jobs where id = $1`, [runId]))[0];
    async function seedCompleted(runId, key, type, body, mime) {
      const row = await itemRow(runId, key);
      const p = `${OWNER}/dynamic/r67yt/${runId}/${key.replace(/[^A-Za-z0-9._-]/g, '_')}.${type}`;
      storage.blobs.set(`cursia-artifacts/${p}`, Buffer.from(body));
      await ds.query(
        `insert into public.artifacts (owner_id, course_id, job_id, type, storage_provider, storage_bucket, storage_path, filename, mime_type, metadata, module_id, chapter_id, manifest_id, manifest_item_key, item_run_id)
         values ($1, $2, $3, $4, 'supabase', 'cursia-artifacts', $5, 'f', $6, '{}'::jsonb, $7, $8, $9, $10, $11)`,
        [OWNER, String(row.course_id), runId, type, p, mime, row.module_id, row.chapter_id, row.manifest_id, key, row.id]);
      await ds.query(`update public.generation_item_runs set status = 'completed', finished_at = now() where id = $1`, [row.id]);
    }
    /**
     * Run real + youtube con el video del cap. 1 YA RENDERIZADO (completed_local): solo queda la fase de subida.
     * El run nace en modo mock (sin Videogen ni costos) y se pasa a real/youtube para el publicador REAL — el harness
     * solo necesita la fase de entrega; Videogen es un stub que cuenta llamadas (siempre 0).
     */
    async function freshRun(title) {
      const K = await makeCourse(title);
      let rid;
      try {
        rid = (await runs.startRun(K.cid, OWNER, 1, { ...CONTEXT, videoMode: 'mock' })).run.id;
      } catch (e) {
        const est = e.getResponse && e.getResponse().estimateId;
        assert(est, `startRun: ${e.message}`);
        await budget.adminAuthorize({ courseId: K.cid, estimateId: est, authorizedBudget: '500', approvedBy: 'admin@cursia.test' });
        rid = (await runs.startRun(K.cid, OWNER, 1, { ...CONTEXT, videoMode: 'mock' })).run.id;
      }
      await ds.query(`update public.production_jobs set input_payload = coalesce(input_payload, '{}'::jsonb) || '{"videoMode":"real","videoDelivery":"youtube"}'::jsonb where id = $1`, [rid]);
      const items = await ds.query(`select item_key, type from public.generation_item_runs where job_id = $1`, [rid]);
      const vKey = `video:${K.c1}`;
      assert(items.some((i) => i.item_key === vKey), `sin item video: ${JSON.stringify(items)}`);
      const viKey = items.find((i) => i.type === 'video_interactions')?.item_key ?? null;
      await seedCompleted(rid, `content:${K.c1}`, 'dynamic_content_md', CONTENT_MD('Bombas'), 'text/markdown');
      // Todo lo demás completado salvo el video y sus interacciones (dependiente).
      await ds.query(`update public.generation_item_runs set status = 'completed', finished_at = now() where job_id = $1 and item_key <> all($2::text[]) and status <> 'completed'`, [rid, [vKey, viKey].filter(Boolean)]);
      const vRow = await itemRow(rid, vKey);
      await ds.query(`update public.generation_item_runs set output_summary = $2::jsonb, status = 'pending' where id = $1`, [vRow.id, JSON.stringify({
        external: { videogenJobId: `vg-${vRow.id.slice(0, 8)}`, mode: 'real', durationSec: 60, durationSource: 'videogen_status' },
        videogenStatus: 'completed_local', videogenDownloadUrl: `${BASE}/dl/${vRow.id}`, delivery: 'completed_local', costUsd: 0.5,
      })]);
      return { ...K, rid, vKey, viKey, vId: vRow.id };
    }
    const VG = { batchCreate: 0, getVideoStatus: 0, getVideoCost: 0 };
    const videogen = {
      async batchCreate() { VG.batchCreate++; throw new Error('Videogen NO debe llamarse en la fase de subida'); },
      async getVideoStatus() { VG.getVideoStatus++; throw new Error('Videogen NO debe llamarse en la fase de subida'); },
      async getVideoCost() { VG.getVideoCost++; return { estimated_total_cost: 0.5 }; },
    };
    const workerDeps = (over = {}) => ({
      scheduler: sched, dataSource: ds, artifacts, videogen, logger: capLogger, executorId: 'r67-yt-worker-A', leaseSeconds: 120, heartbeatMs: 3_600_000,
      videoTimeoutMin: 1, videoPollMs: 5, mockScenario: 'success', mockResolvePolls: 1,
      youtube: realPublisher(), youtubeUploadMaxTries: 3, youtubeUploadRetryBaseMs: 1,
      finops: ledger, budget,
      ...over,
    });
    const claimVideo = (R, s = sched, executorId = 'r67-yt-worker-A') => s.claimNextItem({ executorId, types: ['video'], leaseSeconds: 120, runId: R.rid });
    /** Adelanta el reloj de la espera del item (next_retry_at y las marcas propias de cuota) y lo procesa con un claim real. */
    async function step(R, over = {}, s = sched, executorId = 'r67-yt-worker-A') {
      await ds.query(
        `update public.generation_item_runs set next_retry_at = now() - interval '1 second',
                output_summary = case when output_summary ? 'youtubeQuotaBlockedUntil' and output_summary->>'youtubeQuotaBlockedUntil' is not null
                                       then jsonb_set(output_summary, '{youtubeQuotaBlockedUntil}', to_jsonb((now() - interval '1 second')::text)) else output_summary end
          where id = $1 and status = 'retrying'`, [R.vId]);
      await ds.query(
        `update public.generation_item_runs set output_summary = jsonb_set(output_summary, '{youtubeChannelLimitUntil}', to_jsonb((now() - interval '1 second')::text))
          where id = $1 and output_summary->>'youtubeChannelLimitUntil' is not null`, [R.vId]);
      const item = await claimVideo(R, s, executorId);
      assert(item && item.itemKey === R.vKey, `claim: ${item && item.itemKey}`);
      assert(!JSON.stringify(item.outputSummary).includes('"uriEnc"'), 'el item reclamado no trae la sesión cifrada');
      await IW.processItem(workerDeps({ scheduler: s, executorId, ...over }), item);
      return itemRow(R.rid, R.vKey);
    }
    const near = (d, secs, tol = 10) => d && Math.abs(new Date(d).getTime() - (Date.now() + secs * 1000)) <= tol * 1000;
    function counts() { return { sessions: G.sessionsCreated, videos: G.videos.length, bytes: G.bytesPut, vg: VG.batchCreate + VG.getVideoStatus }; }
    function assertCounts(c0, want, label) {
      const c = counts();
      eq({ sessions: c.sessions - c0.sessions, videos: c.videos - c0.videos, bytes: c.bytes - c0.bytes, vg: c.vg - c0.vg }, want, `${label} (sesiones/videos/bytes/Videogen)`);
    }
    async function assertCompletedOnce(R, label) {
      const row = await itemRow(R.rid, R.vKey);
      eq(row.status, 'completed', `${label}: completed`);
      const os = row.output_summary;
      assert(/^[A-Za-z0-9_-]{11}$/.test(os.youtubeVideoId) && G.videos.includes(os.youtubeVideoId), `${label}: id ${os.youtubeVideoId}`);
      eq([os.delivery, os.youtubeSession ?? null, os.youtubeAuthProbe ?? null], ['completed', null, null], `${label}: delivery y sesión limpia`);
      const ytLedger = await ds.query(`select count(*)::int as n from public.generation_cost_events where item_run_id = $1 and provider = 'youtube'`, [R.vId]);
      assert(ytLedger[0].n >= 1, `${label}: ledger de cuota de YouTube`);
      return row;
    }
    async function assertNoSecretsInDb(R, label) {
      const rows = await ds.query(`select output_summary::text as os, coalesce(error, '') as error from public.generation_item_runs where job_id = $1`, [R.rid]);
      const atts = await ds.query(`select coalesce(string_agg(error, ' '), '') as e from public.generation_item_attempts where item_run_id = $1`, [R.vId]).catch(() => [{ e: '' }]);
      assertNoSecrets(rows.map((r) => r.os + r.error).join('\n') + (atts[0] && atts[0].e), `${label}: DB`);
      const dto = await runs.getRun(R.cid, OWNER, 1, R.rid);
      assertNoSecrets(JSON.stringify(dto), `${label}: DTO`);
      assert(!JSON.stringify(dto).includes('"uriEnc"'), `${label}: DTO sin la sesión cifrada`);
      assertNoSecrets(LOGS.join('\n'), `${label}: logs`);
    }
    async function assertNoOrphans(R, label) {
      const orph = await ds.query(`select item_key from public.generation_item_runs where job_id = $1 and status = 'failed' and next_retry_at is null and attention_reason is null`, [R.rid]);
      eq(orph.map((o) => o.item_key), [], `sin huérfanos (${label})`);
    }
    const notPackaged = async (R, label) => {
      const j = await jobRow(R.rid);
      assert(j.worker_status !== 'completed' && !(j.output_summary && j.output_summary.autoPackage && j.output_summary.autoPackage.eligibleAt), `${label}: sin paquete parcial (${j.worker_status})`);
    };

    // ═══ 4 — cuota del proyecto agotada (403 quotaExceeded) ═══════════════════════════════════════════════════════
    await check('4 cuota agotada (403 quotaExceeded): espera PERSISTENTE (retrying, next_retry_at = +1 h, sin consumir intentos), gate global; sonda channels.list con cuota agotada → sigue esperando (+3 h) SIN videos.insert; repuesta → 1 subida; 0 Videogen', async () => {
      resetGoogle(); LOGS.length = 0;
      const R = await freshRun('r67yt cuota');
      const c0 = counts();
      G.initPlan = [{ status: 403, reason: 'quotaExceeded', domain: 'youtube.quota' }];
      let row = await step(R);
      eq([row.status, row.output_summary.delivery, row.output_summary.youtubeQuotaScope, row.attempt_count], ['retrying', 'blocked_quota', 'project', 0], 'espera');
      assert(near(row.next_retry_at, 3600) && near(row.output_summary.youtubeQuotaBlockedUntil, 3600), `+1 h: ${row.next_retry_at}`);
      eq([row.output_summary.youtubeLastError.phase, row.output_summary.youtubeLastError.httpStatus, row.output_summary.youtubeLastError.reason, row.output_summary.youtubeLastError.domain], ['init', 403, 'quotaExceeded', 'youtube.quota'], 'error estructurado');
      eq(row.output_summary.youtubeDecision.kind, 'quota_project', 'decisión');
      eq(RS.recoveryStateOf(row).state, 'waiting_external_quota', 'estado');
      assert(await IW.youtubeQuotaGateUntil(ds, new Date()), 'gate global cerrado');
      assertCounts(c0, { sessions: 0, videos: 0, bytes: 0, vg: 0 }, 'tras el rechazo');
      const init0 = G.initCalls;
      G.channelPlan = ['quota'];
      row = await step(R);
      eq([row.status, row.output_summary.youtubeQuotaWaits, G.initCalls - init0], ['retrying', 2, 0], 'la sonda ve la cuota agotada: sin videos.insert');
      assert(near(row.next_retry_at, 10800), `+3 h: ${row.next_retry_at}`);
      await notPackaged(R, 'esperando cuota');
      row = await step(R);
      await assertCompletedOnce(R, 'cuota repuesta');
      assertCounts(c0, { sessions: 1, videos: 1, bytes: MP4.length, vg: 0 }, 'total');
      await assertNoSecretsInDb(R, 'cuota');
    });

    // ═══ 5 — límite de subidas del canal (400 uploadLimitExceeded) ════════════════════════════════════════════════
    await check('5 límite del canal (400 uploadLimitExceeded): blocked_quota alcance canal (no cierra el gate global del proyecto), espera +1 h; luego sube 1 vez; 0 Videogen', async () => {
      resetGoogle();
      const R = await freshRun('r67yt canal');
      const c0 = counts();
      G.initPlan = [{ status: 400, reason: 'uploadLimitExceeded' }];
      let row = await step(R);
      eq([row.status, row.output_summary.delivery, row.output_summary.youtubeQuotaScope, row.output_summary.youtubeQuotaBlockedUntil], ['retrying', 'blocked_quota', 'channel', null], 'canal');
      assert(near(row.output_summary.youtubeChannelLimitUntil, 3600), 'ventana +1 h');
      eq(row.output_summary.youtubeDecision.kind, 'quota_channel', 'decisión');
      eq(await IW.youtubeQuotaGateUntil(ds, new Date()), null, 'gate global abierto (es del canal)');
      eq(RS.recoveryStateOf(row).reason, 'youtube_channel_limit', 'estado');
      const ch0 = G.channelCalls;
      row = await step(R);
      await assertCompletedOnce(R, 'canal');
      eq(G.channelCalls - ch0, 0, 'el límite del canal no se sondea con channels.list (no lo refleja)');
      assertCounts(c0, { sessions: 1, videos: 1, bytes: MP4.length, vg: 0 }, 'total');
    });

    // ═══ 6 — OAuth inválido vs refresh con red caída ══════════════════════════════════════════════════════════════
    await check('6a invalid_grant en el refresh → auth DEFINITIVO: failed, attention config, blocked_auth humano, sin sondas; dependiente bloqueado; 0 sesiones, 0 Videogen', async () => {
      resetGoogle();
      const R = await freshRun('r67yt invalid_grant');
      const c0 = counts();
      G.tokenPlan = ['invalid_grant'];
      const row = await step(R);
      eq([row.status, row.attention_reason, row.output_summary.delivery, row.output_summary.youtubeAuthProbe ?? null], ['failed', 'config', 'blocked_auth', null], 'humano');
      eq([row.output_summary.youtubeLastError.phase, row.output_summary.youtubeLastError.reason, row.output_summary.youtubeDecision.human], ['refresh', 'invalid_grant', true], 'estructurado');
      assert(/^youtube_blocked_auth: /.test(row.error), row.error);
      if (R.viKey) eq((await itemRow(R.rid, R.viKey)).status, 'blocked', 'video_interactions bloqueado');
      assertCounts(c0, { sessions: 0, videos: 0, bytes: 0, vg: 0 }, 'nada subido');
      await assertNoOrphans(R, 'invalid_grant');
      await assertNoSecretsInDb(R, 'invalid_grant');
    });

    for (const [label, plan] of [['red caída (socket cortado)', ['reset']], ['5xx', ['503']], ['sin JSON', ['nonjson']], ['timeout', ['hang']]]) {
      await check(`6b refresh con ${label} → TRANSITORIO (no auth): upload_failed reintentable, sin «reconecta»; el reintento sube 1 vez; 0 Videogen`, async () => {
        resetGoogle();
        const R = await freshRun(`r67yt refresh ${plan[0]}`);
        const c0 = counts();
        G.tokenPlan = plan.slice();
        let row = await step(R);
        eq([row.status, row.output_summary.delivery, row.attention_reason], ['retrying', 'upload_failed', null], 'transitorio');
        assert(/^youtube_upload_failed: /.test(row.error) && !/blocked_auth/.test(row.error), row.error);
        eq([row.output_summary.youtubeLastError.phase, row.output_summary.youtubeDecision.kind], ['refresh', 'transient'], 'estructurado');
        row = await step(R);
        await assertCompletedOnce(R, 'tras el refresh transitorio');
        assertCounts(c0, { sessions: 1, videos: 1, bytes: MP4.length, vg: 0 }, 'total');
      });
    }

    await check('6c R1-bis (hipótesis b): el 2.º refresh, DENTRO de uploadFromUrl, falla con 5xx → transitorio, reintento en el mismo reclamo → 1 subida (antes: blocked_auth humano)', async () => {
      resetGoogle();
      const R = await freshRun('r67yt refresh interno');
      const c0 = counts();
      G.tokenPlan = ['ok', '503'];
      await step(R);
      await assertCompletedOnce(R, 'refresh interno');
      assertCounts(c0, { sessions: 1, videos: 1, bytes: MP4.length, vg: 0 }, 'total');
    });

    // ═══ 403 forbidden: sonda → OK → reabre SOLO la subida ═════════════════════════════════════════════════════════
    await check('B4 403 forbidden (incierto) → espera persistente con sonda a los 5 min (waiting_external_quota); sonda OK (preflight + channels.list) → reabre SOLO la subida → 1 video; 0 Videogen', async () => {
      resetGoogle();
      const R = await freshRun('r67yt forbidden');
      const c0 = counts();
      G.initPlan = [{ status: 403, reason: 'forbidden' }];
      let row = await step(R);
      eq([row.status, row.output_summary.delivery, row.output_summary.youtubeAuthProbe.failures, row.attention_reason], ['retrying', 'blocked_auth', 1, null], 'sonda programada');
      assert(near(row.next_retry_at, 300), `+5 min: ${row.next_retry_at}`);
      assert(/^youtube_auth_probe: /.test(row.error), row.error);
      eq([RS.recoveryStateOf(row).state, RS.recoveryStateOf(row).reason], ['waiting_external_quota', 'youtube_auth_probe'], 'estado');
      if (R.viKey) eq((await itemRow(R.rid, R.viKey)).status, 'pending', 'dependiente sin bloquear durante la espera');
      const ch0 = G.channelCalls;
      row = await step(R);
      eq(G.channelCalls - ch0, 1, 'sonda channels.list');
      await assertCompletedOnce(R, 'sonda OK');
      assertCounts(c0, { sessions: 1, videos: 1, bytes: MP4.length, vg: 0 }, 'total');
      if (R.viKey) {
        const vi = await itemRow(R.rid, R.viKey);
        const deps = await ds.query(`select item_key, status from public.generation_item_runs where job_id = $1 and item_key = any($2::text[])`, [R.rid, vi.depends_on]);
        eq([vi.status, deps.every((d) => d.status === 'completed'), deps.some((d) => d.item_key === R.vKey)], ['pending', true, true], 'video_interactions listo (todas sus dependencias, incluido el video, completed)');
      }
    });

    await check('B4 15 403 forbidden ×4 → sondas a 5 min / 30 min / 2 h y luego HUMANO (failed, config, sin bucle); retry manual → SOLO la subida → 1 video; dependiente desbloqueado; 0 Videogen', async () => {
      resetGoogle();
      const R = await freshRun('r67yt forbidden agotado');
      const c0 = counts();
      const delays = [];
      for (let i = 0; i < 4; i++) {
        G.initPlan = [{ status: 403, reason: 'forbidden' }];
        const row = await step(R);
        if (i < 3) {
          eq(row.status, 'retrying', `sonda ${i + 1}`);
          delays.push(Math.round((new Date(row.next_retry_at).getTime() - Date.now()) / 60000));
        } else {
          eq([row.status, row.attention_reason, row.output_summary.delivery, row.output_summary.youtubeDecision.human, row.output_summary.youtubeDecision.probesExhausted], ['failed', 'config', 'blocked_auth', true, true], 'humano tras 3 sondas');
        }
      }
      eq(delays, [5, 30, 120], 'ventanas de las sondas (min)');
      assertCounts(c0, { sessions: 0, videos: 0, bytes: 0, vg: 0 }, 'ninguna sesión creada');
      await assertNoOrphans(R, 'agotado');
      await notPackaged(R, 'humano');
      if (R.viKey) eq((await itemRow(R.rid, R.viKey)).status, 'blocked', 'dependiente bloqueado');
      await runs.retryItem(R.cid, OWNER, 1, R.rid, R.vKey, false, false, undefined, { id: OWNER, email: 'owner@cursia.test' });
      if (R.viKey) eq((await itemRow(R.rid, R.viKey)).status, 'pending', 'dependiente desbloqueado por la reapertura');
      await step(R);
      await assertCompletedOnce(R, 'retry manual');
      assertCounts(c0, { sessions: 1, videos: 1, bytes: MP4.length, vg: 0 }, 'total');
    });

    await check('B2 403 insufficientPermissions → HUMANO inmediato (permisos; sin sondas); 0 sesiones, 0 Videogen', async () => {
      resetGoogle();
      const R = await freshRun('r67yt permisos');
      const c0 = counts();
      G.initPlan = [{ status: 403, reason: 'insufficientPermissions' }];
      const row = await step(R);
      eq([row.status, row.attention_reason, row.output_summary.youtubeDecision.kind, row.output_summary.youtubeAuthProbe ?? null], ['failed', 'config', 'permission', null], 'humano');
      assertCounts(c0, { sessions: 0, videos: 0, bytes: 0, vg: 0 }, 'nada');
      await assertNoOrphans(R, 'permisos');
    });

    await check('B2 rateLimitExceeded → transitorio con backoff (nunca espera de cuota ni humano): 2.º intento del mismo reclamo sube 1 vez', async () => {
      resetGoogle();
      const R = await freshRun('r67yt rate');
      const c0 = counts();
      G.initPlan = [{ status: 403, reason: 'rateLimitExceeded', domain: 'usageLimits' }];
      await step(R);
      await assertCompletedOnce(R, 'rate');
      assertCounts(c0, { sessions: 1, videos: 1, bytes: MP4.length, vg: 0 }, 'total');
    });

    // ═══ 7 — fallo de conexión durante la subida ══════════════════════════════════════════════════════════════════
    await check('7 corte a mitad del PUT → consulta de estado 308 → reanuda desde Range en el MISMO reclamo: 1 sesión, 1 video, bytes = tamaño, outcome resumed; sesión guardada CIFRADA antes del primer byte', async () => {
      resetGoogle(); LOGS.length = 0;
      const R = await freshRun('r67yt corte');
      const c0 = counts();
      G.putPlan = [{ cutAfter: 120_000 }];
      const row = await step(R);
      await assertCompletedOnce(R, 'corte');
      eq([row.output_summary.youtubeUploadOutcome, G.contiguityErrors], ['resumed', 0], 'reanudado');
      assert(row.output_summary.youtubeBytesSent >= MP4.length - 120_000, 'bytes intentados registrados');
      assertCounts(c0, { sessions: 1, videos: 1, bytes: MP4.length, vg: 0 }, 'total');
      await assertNoSecretsInDb(R, 'corte');
    });

    // ═══ 8 — subida completada con la respuesta perdida ═══════════════════════════════════════════════════════════
    await check('8 subida completa con respuesta perdida y consulta inmediata caída → retrying (youtube_upload_unconfirmed, sesión cifrada guardada); el reintento consulta la MISMA sesión → 201 → confirma el videoId con CERO re-subida', async () => {
      resetGoogle(); LOGS.length = 0;
      const R = await freshRun('r67yt respuesta perdida');
      const c0 = counts();
      G.putPlan = ['complete_then_cut'];
      G.statusPlan = ['reset'];
      let row = await step(R);
      eq([row.status, row.output_summary.delivery, row.output_summary.youtubeStatusChecks], ['retrying', 'uploading_youtube', 1], 'consulta diferida');
      assert(/^youtube_upload_unconfirmed: /.test(row.error), row.error);
      const sess = row.output_summary.youtubeSession;
      assert(sess && sess.uriEnc && sess.iv && sess.bytes === MP4.length && !JSON.stringify(sess).includes(UPLOAD_ID_PREFIX), 'sesión cifrada (nunca en claro)');
      eq(tokens.decryptSecret(sess.uriEnc, sess.iv).includes(UPLOAD_ID_PREFIX), true, 'descifrable con la clave de los tokens');
      assert(near(row.next_retry_at, 60), 'consulta en 60 s');
      const after1 = counts();
      const puts0 = G.dataPuts;
      row = await step(R);
      await assertCompletedOnce(R, 'confirmado');
      eq(row.output_summary.youtubeUploadOutcome, 'confirmed_existing', 'outcome');
      eq([G.sessionsCreated - after1.sessions, G.bytesPut - after1.bytes, G.dataPuts - puts0], [0, 0, 0], 'CERO re-subida en el reintento');
      assertCounts(c0, { sessions: 1, videos: 1, bytes: MP4.length, vg: 0 }, 'total');
      await assertNoSecretsInDb(R, 'respuesta perdida');
    });

    await check('15 consulta de estado que nunca responde → 5 consultas diferidas (60 s, 120 s, …) y luego HUMANO (ambiguo); nunca una sesión nueva ni bytes re-enviados', async () => {
      resetGoogle();
      const R = await freshRun('r67yt consultas agotadas');
      G.putPlan = ['complete_then_cut'];
      G.statusPlan = Array.from({ length: 10 }, () => 'reset');
      let row = await step(R);
      const c0 = counts();
      const waits = [];
      for (let i = 0; i < 5; i++) {
        if (i > 0) row = await step(R);
        eq(row.status, 'retrying', `consulta ${i + 1}`);
        waits.push(Math.round((new Date(row.next_retry_at).getTime() - Date.now()) / 1000 / 60));
      }
      row = await step(R);
      eq([row.status, row.output_summary.delivery, row.output_summary.youtubeDecision.human], ['failed', 'ambiguous', true], 'humano');
      assert(/^ambiguous_youtube_upload: /.test(row.error), row.error);
      eq(waits, [1, 2, 4, 8, 16], 'esperas acotadas entre consultas (min)');
      assertCounts(c0, { sessions: 0, videos: 0, bytes: 0, vg: 0 }, 'sin re-subida');
      eq(G.videos.length, 1, 'el video que sí terminó es el único');
      await assertNoOrphans(R, 'consultas agotadas');
    });

    await check('B3/F1 sesión vencida (404) DESPUÉS de enviar bytes → AMBIGUO humano (la subida pudo completarse del lado de Google): NUNCA una sesión nueva ni un segundo video', async () => {
      resetGoogle();
      const R = await freshRun('r67yt vencida con bytes');
      const c0 = counts();
      G.putPlan = [{ cutAfter: 40_000 }];
      G.statusPlan = ['reset'];
      let row = await step(R);
      eq(row.status, 'retrying', 'unconfirmed');
      assert(row.output_summary.youtubePutStartedAt, 'hubo PUT de bytes');
      for (const s of G.sessions.values()) s.expired = true;
      row = await step(R);
      eq([row.status, row.output_summary.delivery], ['failed', 'ambiguous'], 'ambiguo humano, sin re-subir');
      assertCounts(c0, { sessions: 1, videos: 0, bytes: 40_000, vg: 0 }, 'una sola sesión, ningún segundo PUT');
    });

    await check('B3 sesión vencida (404) SIN bytes enviados (sesión creada, nunca empezó el PUT) → borra la sesión y abre UNA nueva; 1 video total', async () => {
      resetGoogle();
      const R = await freshRun('r67yt vencida sin bytes');
      const c0 = counts();
      G.putPlan = [{ cutAfter: 40_000 }];
      G.statusPlan = ['reset'];
      let row = await step(R);
      eq(row.status, 'retrying', 'unconfirmed');
      // Emula «la sesión se guardó y el proceso murió antes del primer PUT»: sin marca de bytes (el fake nunca creó el video).
      await ds.query(`update public.generation_item_runs set output_summary = output_summary - 'youtubePutStartedAt' where id = $1`, [R.vId]);
      for (const s of G.sessions.values()) s.expired = true;
      row = await step(R);
      await assertCompletedOnce(R, 'tras vencer sin bytes');
      assert(row.output_summary.youtubeSessionExpiredAt, 'vencimiento registrado');
      assertCounts(c0, { sessions: 2, videos: 1, bytes: 40_000 + MP4.length, vg: 0 }, 'total');
    });

    await check('F9 marca de PUT presente pero sesión ilegible y youtubeUploadStartedAt limpio → AMBIGUO humano (nunca una subida nueva)', async () => {
      resetGoogle();
      const R = await freshRun('r67yt sesion ilegible');
      await ds.query(`update public.generation_item_runs set output_summary = output_summary || jsonb_build_object('youtubePutStartedAt', now()::text, 'youtubeSession', jsonb_build_object('uriEnc', 'roto', 'iv', 'x'), 'youtubeUploadProtocol', 'r67_resumable') - 'youtubeUploadStartedAt' where id = $1`, [R.vId]);
      const c0 = counts();
      const row = await step(R);
      eq([row.status, row.output_summary.delivery], ['failed', 'ambiguous'], 'ambiguo humano');
      assertCounts(c0, { sessions: 0, videos: 0, bytes: 0, vg: 0 }, 'nada enviado');
    });

    await check('B3 marcador VIEJO (sin protocolo r67, sin sesión) → sigue siendo ambiguo humano (nunca re-sube sola); marcador r67 sin sesión ni bytes → sesión nueva segura', async () => {
      resetGoogle();
      const R = await freshRun('r67yt marcador viejo');
      await ds.query(`update public.generation_item_runs set output_summary = output_summary || jsonb_build_object('youtubeUploadStartedAt', now()::text, 'delivery', 'uploading_youtube') where id = $1`, [R.vId]);
      const c0 = counts();
      let row = await step(R);
      eq([row.status, row.output_summary.delivery], ['failed', 'ambiguous'], 'ambiguo humano');
      assertCounts(c0, { sessions: 0, videos: 0, bytes: 0, vg: 0 }, 'nada');
      const R2 = await freshRun('r67yt marcador r67');
      await ds.query(`update public.generation_item_runs set output_summary = output_summary || jsonb_build_object('youtubeUploadStartedAt', now()::text, 'delivery', 'uploading_youtube', 'youtubeUploadProtocol', 'r67_resumable') where id = $1`, [R2.vId]);
      row = await step(R2);
      await assertCompletedOnce(R2, 'r67 sin bytes');
      assertCounts(c0, { sessions: 1, videos: 1, bytes: MP4.length, vg: 0 }, 'total');
    });

    // ═══ 9 — reinicio del worker a mitad de la subida ═════════════════════════════════════════════════════════════
    await check('9 worker A muere a mitad del PUT (lease vencida) → worker B retoma: consulta la sesión guardada (308) y reanuda desde Range; A, al volver, no registra nada (lease perdida); 1 sesión, 1 video, 0 Videogen', async () => {
      resetGoogle();
      const R = await freshRun('r67yt reinicio');
      const c0 = counts();
      G.putPlan = [{ cutAfter: 150_000, hold: true }];
      const itemA = await claimVideo(R, sched, 'r67-yt-worker-A');
      const pA = IW.processItem(workerDeps({ executorId: 'r67-yt-worker-A' }), itemA);
      for (let i = 0; i < 200 && G.held.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
      assert(G.held.length === 1, 'A quedó colgado a mitad del PUT');
      const mid = await itemRow(R.rid, R.vKey);
      assert(mid.output_summary.youtubeSession && mid.output_summary.youtubePutStartedAt, 'sesión y marca de bytes persistidas ANTES del PUT');
      await ds.query(`update public.generation_item_runs set lease_until = now() - interval '1 second' where id = $1`, [R.vId]);
      // El barrido de leases vencidas (dentro del claim) lo pasa a retrying; el siguiente claim de B lo toma.
      eq(await claimVideo(R, sched2, 'r67-yt-worker-B'), null, 'el claim que barre la lease vencida no lo entrega de inmediato (backoff)');
      eq((await itemRow(R.rid, R.vKey)).status, 'retrying', 'lease vencida → retrying');
      const row = await step(R, { executorId: 'r67-yt-worker-B' }, sched2, 'r67-yt-worker-B');
      await assertCompletedOnce(R, 'B retoma');
      eq(row.output_summary.youtubeUploadOutcome, 'resumed', 'B reanudó');
      G.held.shift()();
      await pA;
      const fin = await itemRow(R.rid, R.vKey);
      eq([fin.status, fin.output_summary.youtubeVideoId], ['completed', row.output_summary.youtubeVideoId], 'A no pisó nada');
      assertCounts(c0, { sessions: 1, videos: 1, bytes: MP4.length, vg: 0 }, 'total');
    });

    // ═══ 14 — dos workers sobre la misma tarea ════════════════════════════════════════════════════════════════════
    await check('14 dos workers reclaman a la vez → uno solo obtiene el item; un worker con un item viejo (sin lease) nunca contacta a YouTube; 1 sesión, 1 video', async () => {
      resetGoogle();
      const R = await freshRun('r67yt dos workers');
      const c0 = counts();
      const [a, b] = await Promise.all([claimVideo(R, sched, 'r67-yt-worker-A'), claimVideo(R, sched2, 'r67-yt-worker-B')]);
      eq([!!a, !!b].filter(Boolean).length, 1, 'un solo claim');
      const win = a || b;
      const winner = a ? 'r67-yt-worker-A' : 'r67-yt-worker-B';
      const loser = a ? 'r67-yt-worker-B' : 'r67-yt-worker-A';
      const init0 = G.initCalls;
      await Promise.all([
        IW.processItem(workerDeps({ executorId: winner }), win),
        IW.processItem(workerDeps({ executorId: loser }), { ...win }),
      ]);
      await assertCompletedOnce(R, 'dos workers');
      eq(G.initCalls - init0, 1, 'un solo videos.insert');
      assertCounts(c0, { sessions: 1, videos: 1, bytes: MP4.length, vg: 0 }, 'total');
    });
  } finally {
    if (ds) await ds.destroy().catch(() => {});
    await new Promise((res) => storage.srv.close(() => res())).catch(() => {});
    if (started) pg('pg_ctl', ['-D', dataDir, '-m', 'immediate', 'stop']);
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(tmpCwd, { recursive: true, force: true });
  }
}

async function main() {
  await new Promise((res) => google.srv.listen(0, '127.0.0.1', res));
  BASE = `http://127.0.0.1:${google.srv.address().port}`;
  try {
    await pureChecks();
    await serviceChecks();
    if (!PURE_ONLY) await dbChecks();
  } finally {
    for (const h of G.held) try { h(); } catch { /* */ }
    google.srv.closeAllConnections && google.srv.closeAllConnections();
    await new Promise((res) => google.srv.close(() => res()));
    global.fetch = realFetch;
  }
  console.log(`\n${passes} OK, ${failures} con fallas`);
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
