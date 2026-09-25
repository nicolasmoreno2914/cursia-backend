#!/usr/bin/env node
/* eslint-disable */
// DN-1 — entrega final del video V2 por YouTube Unlisted (sin DB, sin red
// externa), sobre los módulos COMPILADOS de dist/. Todo lo de Google/YouTube/
// Videogen es FALSO: `fetch` global se reemplaza por un router que solo
// conoce hosts inventados y los endpoints de Google simulados; cualquier otra
// URL lanza.
//
//  P  Política por run: resolveRunVideoDelivery / frozenRunVideoGate /
//     DYNAMIC_ALLOW_VIDEOGEN_DIRECT (solo 'true' exacto).
//  F  Preflight (evaluateYoutubePreflight / lightYoutubePreflight): matriz de
//     TODOS los reasons, orden y keys de checks, nunca tokens ni errores crudos.
//  S  Servicio real DynamicYoutubePreflightService (YoutubeTokenService real con
//     cifrado AES-GCM real) contra Google falso.
//  U  YoutubeUploadService.uploadFromUrl real contra Google falso →
//     classifyYoutubeUploadError: auth / quota / download / transient / ambiguous.
//  V  deliveryViewOf (estado legible por la UI) y youtubeDeliveryProblems (packaging).
//  W  dynamic-item-worker.processItem con scheduler en memoria:
//     preflight antes del envío → 0 envíos; fallos de subida después de
//     completed_local → 0 re-envíos a Videogen, retry = solo re-subida,
//     completed con id+url; ambigua → nunca re-sube sola; resolución explícita.
//
// Usage: node scripts/check-dynamic-youtube-delivery.js [path/to/dist]

const path = require('path');
const crypto = require('crypto');

const distRoot = path.resolve(process.cwd(), process.argv[2] || 'dist');
function loadDist(rel) {
  const abs = path.join(distRoot, rel);
  try {
    return require(abs);
  } catch (err) {
    console.error(`❌ No se pudo cargar el módulo compilado en ${abs}`);
    console.error(`   (¿corriste "npm run build" antes? — dist/ no se versiona)`);
    console.error(`   ${err.message}`);
    process.exit(1);
  }
}

require('reflect-metadata');
const { Logger } = require('@nestjs/common');
Logger.overrideLogger(false);

const D = loadDist('modules/dynamic-generation/dynamic-video-delivery.js');
const Y = loadDist('modules/dynamic-generation/dynamic-youtube.js');
const worker = loadDist('workers/dynamic-item-worker.js');
const { YoutubeTokenService } = loadDist('youtube/youtube-token.service.js');
const { YoutubeUploadService, YoutubeUploadTransportError, YoutubeQuotaException } = loadDist('youtube/youtube-upload.service.js');
const { mergeOutputSummary } = loadDist('modules/dynamic-generation/scheduler.service.js');

let passes = 0;
let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    passes++;
    console.log(`✅ ${name}`);
  } catch (err) {
    failures++;
    console.error(`❌ ${name}\n   ${err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n   ') : err}`);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function eq(a, b, msg) { assert(JSON.stringify(a) === JSON.stringify(b), `${msg}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); }

async function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    return await fn();
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

const OWNER = 'aa2fa9a1-afb1-4b01-8646-94a0cb272b57';
const SECRET_TOKEN_MARKER = 'ya29.SECRET-ACCESS-TOKEN';
const RAW_GOOGLE_ERROR = 'invalid_grant: Token has been expired or revoked (RAW-GOOGLE-TEXT)';
const KEYS = ['connected', 'oauth_valid', 'refresh_usable', 'channel_resolved', 'upload_permission', 'privacy_unlisted'];

// ─────────────────────────────────────────────────────────────────────────────
// Google/YouTube/Videogen falsos (router de fetch)
// ─────────────────────────────────────────────────────────────────────────────
const realFetch = global.fetch;
const G = {
  tokenCalls: 0, channelCalls: 0, initCalls: 0, putCalls: 0, downloads: 0,
  // refresh_token → comportamiento del endpoint de token
  refresh: new Map(),
  // access_token → respuesta de channels.list
  channels: new Map(),
  initPlan: [], // cola de respuestas del POST resumable: 'ok' | status number | 'network'
  putPlan: [],  // cola de respuestas del PUT: 'ok' | 'noid' | status number | 'network' | {quota:true}
  downloadPlan: [], // 'ok' | status number
  videoSeq: 0,
};
function json(status, obj, headers = {}) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', ...headers } });
}
global.fetch = async (input, init = {}) => {
  const url = String(input);
  const method = (init.method || 'GET').toUpperCase();
  if (url === 'https://oauth2.googleapis.com/token' && method === 'POST') {
    G.tokenCalls++;
    const rt = new URLSearchParams(String(init.body)).get('refresh_token');
    const b = G.refresh.get(rt);
    if (b && b.ok) return json(200, { access_token: b.accessToken, expires_in: 3599 });
    return json(400, { error: 'invalid_grant', error_description: RAW_GOOGLE_ERROR });
  }
  if (url.startsWith('https://www.googleapis.com/youtube/v3/channels')) {
    G.channelCalls++;
    const tok = String((init.headers || {}).Authorization || '').replace(/^Bearer /, '');
    const c = G.channels.get(tok);
    if (c === 'http500') return json(500, { error: { message: 'backendError RAW-GOOGLE-TEXT' } });
    if (!c) return json(200, { items: [] });
    return json(200, { items: [{ id: c.id, snippet: { title: c.title, thumbnails: { default: { url: c.thumb } } } }] });
  }
  if (url.startsWith('https://fake-videogen.local/download/')) {
    G.downloads++;
    const p = G.downloadPlan.shift() || 'ok';
    if (p !== 'ok') return new Response('nf', { status: p });
    return new Response(Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42'), Buffer.alloc(4096, 7)]), { status: 200 });
  }
  if (url.startsWith('https://www.googleapis.com/upload/youtube/v3/videos') && method === 'POST') {
    G.initCalls++;
    const p = G.initPlan.shift() || 'ok';
    if (p === 'network') throw new TypeError('fetch failed (ECONNRESET, fake)');
    if (p === 'quota') return json(403, { error: { errors: [{ reason: 'quotaExceeded' }] } });
    if (p === 'forbidden') return json(403, { error: { errors: [{ reason: 'forbidden' }] } });
    if (typeof p === 'number') return new Response(`err ${p}`, { status: p });
    return new Response('', { status: 200, headers: { location: 'https://fake-upload.local/session/1' } });
  }
  if (url.startsWith('https://fake-upload.local/session/') && method === 'PUT') {
    G.putCalls++;
    const p = G.putPlan.shift() || 'ok';
    if (p === 'network') throw new TypeError('fetch failed (socket hang up, fake)');
    if (p === 'noid') return json(200, { kind: 'youtube#video' });
    if (p === 'quota') return json(403, { error: { errors: [{ reason: 'rateLimitExceeded' }] } });
    if (typeof p === 'number') return new Response(`err ${p}`, { status: p });
    G.videoSeq++;
    return json(200, { id: `YtFake${String(G.videoSeq).padStart(5, '0')}` });
  }
  if (url.startsWith('https://fake-storage.local/')) {
    return new Response('# Capítulo\n\nTexto del capítulo.', { status: 200 });
  }
  throw new Error('red no esperada en el check: ' + url);
};

// Token service REAL (cifrado AES-256-GCM real con un secreto de test).
process.env.YOUTUBE_TOKEN_SECRET = crypto.randomBytes(32).toString('hex');
const tokens = new YoutubeTokenService();
tokens.onModuleInit();
function conn({ status = 'active', scopes = 'youtube.upload,youtube.readonly', refreshToken = 'rt-good', channelId = 'UCstored0000000000000000' } = {}) {
  const { encrypted, iv } = tokens.encryptRefreshToken(refreshToken);
  return { id: 1, userId: OWNER, status, scopes, encryptedRefreshToken: encrypted, tokenIv: iv, channelId, channelTitle: 'Canal guardado', channelThumbnailUrl: null };
}
G.refresh.set('rt-good', { ok: true, accessToken: `${SECRET_TOKEN_MARKER}-good` });
G.refresh.set('rt-nochannel', { ok: true, accessToken: `${SECRET_TOKEN_MARKER}-nochannel` });
G.refresh.set('rt-ch500', { ok: true, accessToken: `${SECRET_TOKEN_MARKER}-ch500` });
G.channels.set(`${SECRET_TOKEN_MARKER}-good`, { id: 'UCgood000000000000000000', title: 'Canal Nomaddi (fake)', thumb: 'https://yt3.fake/thumb.jpg' });
G.channels.set(`${SECRET_TOKEN_MARKER}-ch500`, 'http500');

async function main() {
  // ── P. Política por run ────────────────────────────────────────────────────
  await check('P resolveRunVideoDelivery: sin video o mock → la config (default videogen_direct), sin preflight', () =>
    withEnv({ DYNAMIC_VIDEO_DELIVERY: undefined, DYNAMIC_ALLOW_VIDEOGEN_DIRECT: undefined }, async () => {
      for (const [videoCount, videoMode] of [[0, 'real'], [0, 'mock'], [3, 'mock'], [3, undefined]]) {
        eq(D.resolveRunVideoDelivery({ videoCount, videoMode, configured: 'videogen_direct' }), { ok: true, strategy: 'videogen_direct', requiresYoutubePreflight: false }, `${videoCount}/${videoMode}`);
      }
      eq(D.resolveRunVideoDelivery({ videoCount: 3, videoMode: 'mock', configured: 'youtube' }), { ok: true, strategy: 'youtube', requiresYoutubePreflight: false }, 'mock + youtube config: sin preflight (sin gasto)');
    }));

  await check('P resolveRunVideoDelivery: video + real → youtube por default (con preflight); videogen_direct explícito solo con DYNAMIC_ALLOW_VIDEOGEN_DIRECT=true', async () => {
    const r = (env, configured) => withEnv(env, async () => D.resolveRunVideoDelivery({ videoCount: 2, videoMode: 'real', configured }));
    eq(await r({ DYNAMIC_VIDEO_DELIVERY: undefined, DYNAMIC_ALLOW_VIDEOGEN_DIRECT: undefined }, 'videogen_direct'), { ok: true, strategy: 'youtube', requiresYoutubePreflight: true }, 'sin config → youtube');
    eq(await r({ DYNAMIC_VIDEO_DELIVERY: undefined, DYNAMIC_ALLOW_VIDEOGEN_DIRECT: 'true' }, 'videogen_direct'), { ok: true, strategy: 'youtube', requiresYoutubePreflight: true }, 'sin config + permiso → igual youtube (default)');
    eq(await r({ DYNAMIC_VIDEO_DELIVERY: 'youtube' }, 'youtube'), { ok: true, strategy: 'youtube', requiresYoutubePreflight: true }, 'config youtube');
    const off = await r({ DYNAMIC_VIDEO_DELIVERY: 'videogen_direct', DYNAMIC_ALLOW_VIDEOGEN_DIRECT: undefined }, 'videogen_direct');
    assert(off.ok === false && off.code === 'video_delivery_not_youtube' && /^video_delivery_not_youtube: /.test(off.message), 'videogen_direct sin permiso → video_delivery_not_youtube: ' + JSON.stringify(off));
    for (const v of ['TRUE', '1', 'yes', ' true', 'false', '']) {
      const x = await r({ DYNAMIC_VIDEO_DELIVERY: 'videogen_direct', DYNAMIC_ALLOW_VIDEOGEN_DIRECT: v }, 'videogen_direct');
      assert(x.ok === false, `permiso "${v}" no debe habilitar videogen_direct`);
    }
    eq(await r({ DYNAMIC_VIDEO_DELIVERY: 'videogen_direct', DYNAMIC_ALLOW_VIDEOGEN_DIRECT: 'true' }, 'videogen_direct'), { ok: true, strategy: 'videogen_direct', requiresYoutubePreflight: false }, 'escape de staging ON');
  });

  await check('P frozenRunVideoGate (reabrir/retry/regenerar/fromRun): estrategia congelada, gate solo si hay trabajo de video real', () =>
    withEnv({ DYNAMIC_ALLOW_VIDEOGEN_DIRECT: undefined }, async () => {
      eq(D.frozenRunVideoGate({ videoWork: 0, videoMode: 'real', strategy: 'youtube' }), { ok: true, strategy: 'youtube', requiresYoutubePreflight: false }, 'sin trabajo de video');
      eq(D.frozenRunVideoGate({ videoWork: 1, videoMode: 'mock', strategy: 'videogen_direct' }), { ok: true, strategy: 'videogen_direct', requiresYoutubePreflight: false }, 'mock');
      eq(D.frozenRunVideoGate({ videoWork: 1, videoMode: 'real', strategy: 'youtube' }), { ok: true, strategy: 'youtube', requiresYoutubePreflight: true }, 'youtube real');
      const b = D.frozenRunVideoGate({ videoWork: 1, videoMode: 'real', strategy: 'videogen_direct' });
      assert(b.ok === false && b.code === 'video_delivery_not_youtube', 'videogen_direct real sin permiso');
      await withEnv({ DYNAMIC_ALLOW_VIDEOGEN_DIRECT: 'true' }, async () => {
        eq(D.frozenRunVideoGate({ videoWork: 1, videoMode: 'real', strategy: 'videogen_direct' }).ok, true, 'con permiso');
      });
    }));

  // ── F. Preflight (DI) ─────────────────────────────────────────────────────
  const fdeps = (c, { tokenOk = true, channel = { id: 'UCx', title: 'T', thumbnail: null } } = {}) => ({
    getConnection: async () => c,
    getAccessToken: async () => { if (!tokenOk) throw new Error(RAW_GOOGLE_ERROR); return SECRET_TOKEN_MARKER; },
    listMyChannel: async () => channel,
  });
  const matrix = [
    { label: 'sin conexión', c: null, reason: 'no_connection', fail: ['connected', 'oauth_valid', 'refresh_usable', 'channel_resolved', 'upload_permission'] },
    { label: 'revocada', c: { status: 'revoked', scopes: 'youtube.upload' }, reason: 'no_connection', fail: ['connected', 'oauth_valid', 'refresh_usable', 'channel_resolved', 'upload_permission'] },
    { label: 'reauth_required', c: { status: 'reauth_required', scopes: 'youtube.upload' }, reason: 'reauth_required', fail: ['oauth_valid', 'refresh_usable', 'channel_resolved'] },
    { label: 'refresh falla', c: { status: 'active', scopes: 'youtube.upload' }, o: { tokenOk: false }, reason: 'token_refresh_failed', fail: ['refresh_usable', 'channel_resolved'] },
    { label: 'sin canal', c: { status: 'active', scopes: 'youtube.upload' }, o: { channel: null }, reason: 'channel_unresolved', fail: ['channel_resolved'] },
    { label: 'sin scope de subida', c: { status: 'active', scopes: 'youtube.readonly' }, reason: 'missing_upload_scope', fail: ['upload_permission'] },
    { label: 'scopes null', c: { status: 'active', scopes: null }, reason: 'missing_upload_scope', fail: ['upload_permission'] },
    { label: 'OK (scope URL completa)', c: { status: 'active', scopes: 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly' }, reason: undefined, fail: [] },
    { label: 'OK', c: { status: 'active', scopes: 'youtube.upload,youtube.readonly' }, reason: undefined, fail: [] },
  ];
  for (const m of matrix) {
    await check(`F preflight ${m.label} → ${m.reason ? `reason ${m.reason}` : 'ok'}; checks en orden fijo; sin tokens ni error crudo`, async () => {
      const r = await Y.evaluateYoutubePreflight(fdeps(m.c, m.o), OWNER);
      eq(r.checks.map((x) => x.key), KEYS, 'keys y orden');
      eq(r.checks.filter((x) => !x.ok).map((x) => x.key), m.fail, 'checks fallidos');
      eq(r.ok, m.fail.length === 0, 'ok');
      eq(r.reason, m.reason, 'reason');
      assert(r.checks.find((x) => x.key === 'privacy_unlisted').ok === true, 'privacy_unlisted siempre true');
      // channel = el que devolvió channels.list SOLO si channel_resolved (aunque falle otro check, p.ej. el scope).
      if (r.checks.find((x) => x.key === 'channel_resolved').ok) eq(r.channel, { id: 'UCx', title: 'T', thumbnail: null }, 'canal');
      else assert(r.channel === null, 'channel null si no se resolvió');
      const s = JSON.stringify(r);
      assert(!s.includes(SECRET_TOKEN_MARKER) && !s.includes('RAW-GOOGLE') && !s.includes('invalid_grant'), 'filtró token/error crudo: ' + s);
      if (!r.ok) assert(D.YOUTUBE_PREFLIGHT_REASONS.includes(r.reason), 'reason fuera del contrato');
    });
  }

  await check('F lightYoutubePreflight (worker): mismos reasons, sin channels.list', async () => {
    let listed = 0;
    const L = (c, tokenOk = true) => Y.lightYoutubePreflight({ getConnection: async () => c, getAccessToken: async () => { if (!tokenOk) throw new Error('x'); return 't'; } }, OWNER);
    eq((await L(null)).reason, 'no_connection', 'sin conexión');
    eq((await L({ status: 'revoked' })).reason, 'no_connection', 'revocada');
    eq((await L({ status: 'reauth_required' })).reason, 'reauth_required', 'reauth');
    eq((await L({ status: 'active', scopes: 'youtube.upload' }, false)).reason, 'token_refresh_failed', 'refresh');
    eq((await L({ status: 'active', scopes: 'youtube.readonly' })).reason, 'missing_upload_scope', 'scope');
    const ok = await L({ status: 'active', scopes: 'youtube.upload' });
    assert(ok.ok === true && ok.connection.status === 'active', 'ok');
    eq(listed, 0, 'no llama channels.list');
  });

  await check('F resolveYoutubeConnectionFor: hoy la conexión del owner (institutionId es punto de extensión, sin efecto)', async () => {
    const calls = [];
    const src = { getConnection: async (id) => { calls.push(id); return { userId: id }; } };
    eq(await Y.resolveYoutubeConnectionFor(src, OWNER), { userId: OWNER }, 'owner');
    eq(await Y.resolveYoutubeConnectionFor(src, OWNER, { institutionId: 42 }), { userId: OWNER }, 'con institución');
    eq(calls, [OWNER, OWNER], 'siempre por owner');
  });

  // ── S. Servicio real contra Google falso ──────────────────────────────────
  const svcFor = (c) => new Y.DynamicYoutubePreflightService({ getConnection: async () => c }, tokens);
  await check('S DynamicYoutubePreflightService real (cifrado real, Google falso): OK con canal verificado por channels.list', async () => {
    const r = await svcFor(conn()).check(OWNER);
    eq(r, {
      ok: true,
      channel: { id: 'UCgood000000000000000000', title: 'Canal Nomaddi (fake)', thumbnail: 'https://yt3.fake/thumb.jpg' },
      checks: KEYS.map((key) => ({ key, ok: true })),
    }, 'resultado');
  });
  for (const [label, c, reason] of [
    ['refresh rechazado por Google', conn({ refreshToken: 'rt-revoked' }), 'token_refresh_failed'],
    ['cuenta sin canal', conn({ refreshToken: 'rt-nochannel' }), 'channel_unresolved'],
    ['channels.list 500', conn({ refreshToken: 'rt-ch500' }), 'channel_unresolved'],
    ['sin scope youtube.upload', conn({ scopes: 'youtube.readonly' }), 'missing_upload_scope'],
    ['reauth_required', conn({ status: 'reauth_required' }), 'reauth_required'],
    ['sin conexión', null, 'no_connection'],
  ]) {
    await check(`S servicio real: ${label} → ${reason}, sin tokens ni error crudo de Google`, async () => {
      const r = await svcFor(c).check(OWNER);
      eq(r.ok, false, 'ok');
      eq(r.reason, reason, 'reason');
      const s = JSON.stringify(r);
      assert(!s.includes(SECRET_TOKEN_MARKER) && !s.includes('RAW-GOOGLE') && !s.includes('invalid_grant') && !s.includes('rt-'), 'filtró: ' + s);
    });
  }

  // ── U. Upload real → clasificación ────────────────────────────────────────
  const uploader = new YoutubeUploadService(tokens);
  const up = () => uploader.uploadFromUrl(conn(), { downloadUrl: 'https://fake-videogen.local/download/j1', title: 'T', privacyStatus: 'unlisted' });
  async function kindOf(plan) {
    G.initPlan = plan.init || []; G.putPlan = plan.put || []; G.downloadPlan = plan.download || [];
    try { await up(); return 'ok'; } catch (e) { return Y.classifyYoutubeUploadError(e); }
  }
  await check('U subida OK → id', async () => eq(await kindOf({}), 'ok', 'ok'));
  for (const [label, plan, kind] of [
    ['init 401', { init: [401] }, 'auth'],
    ['init 403 forbidden', { init: ['forbidden'] }, 'auth'],
    ['init 403 quotaExceeded', { init: ['quota'] }, 'quota'],
    ['PUT 403 rateLimitExceeded', { put: ['quota'] }, 'quota'],
    ['PUT 401', { put: [401] }, 'auth'],
    ['descarga del MP4 404', { download: [404] }, 'download'],
    ['init 503', { init: [503] }, 'transient'],
    ['init red caída', { init: ['network'] }, 'transient'],
    ['PUT 500 (respuesta explícita)', { put: [500] }, 'transient'],
    ['PUT 503 (respuesta explícita)', { put: [503] }, 'transient'],
    ['PUT sin respuesta (red)', { put: ['network'] }, 'ambiguous'],
    ['PUT 200 sin id', { put: ['noid'] }, 'ambiguous'],
    ['PUT 400', { put: [400] }, 'ambiguous'],
  ]) {
    await check(`U ${label} → ${kind}`, async () => eq(await kindOf(plan), kind, label));
  }
  await check('U YoutubeUploadTransportError sigue siendo ServiceUnavailableException (legacy intacto) y un Error desconocido es ambiguous', () => {
    const { ServiceUnavailableException } = require('@nestjs/common');
    const e = new YoutubeUploadTransportError('x', 'upload', 503);
    assert(e instanceof ServiceUnavailableException, 'instanceof');
    eq(Y.classifyYoutubeUploadError(new Error('boom')), 'ambiguous', 'desconocido');
    eq(Y.classifyYoutubeUploadError(new YoutubeQuotaException()), 'quota', 'quota antes que ServiceUnavailable');
  });

  // ── V. Vista de entrega y requisito de packaging ─────────────────────────
  await check('V deliveryViewOf: estados legibles para la UI (youtube)', () => {
    const v = (itemStatus, os, error = null) => D.deliveryViewOf({ strategy: 'youtube', itemStatus, error, outputSummary: os }).state;
    eq(v('pending', {}), 'pending', 'pending');
    eq(v('running', { external: { videogenJobId: 'j' } }), 'rendering', 'rendering');
    eq(v('running', { delivery: 'completed_local', external: { videogenJobId: 'j' } }), 'completed_local', 'completed_local');
    eq(v('running', { delivery: 'uploading_youtube', youtubeUploadStartedAt: 'x' }), 'uploading_youtube', 'uploading');
    eq(v('completed', { delivery: 'completed', youtubeVideoId: 'dQw4w9WgXcQ', youtubeUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }), 'completed', 'completed');
    eq(v('failed', { delivery: 'blocked_auth' }, 'youtube_blocked_auth: x'), 'blocked_auth', 'blocked_auth');
    eq(v('retrying', { delivery: 'blocked_quota' }), 'blocked_quota', 'blocked_quota');
    eq(v('retrying', { delivery: 'upload_failed' }), 'upload_failed', 'upload_failed');
    eq(v('failed', { delivery: 'ambiguous', youtubeUploadStartedAt: 'x' }, 'ambiguous_youtube_upload: y'), 'ambiguous', 'ambiguous');
    eq(v('failed', { delivery: 'uploading_youtube', youtubeUploadStartedAt: 'x' }, 'ambiguous_youtube_upload: legacy 5B.2.A'), 'ambiguous', 'ambiguous (fila 5B.2.A)');
    eq(v('failed', {}, 'youtube_preflight_failed:no_connection: x'), 'blocked_auth', 'bloqueado antes del envío');
    const amb = D.deliveryViewOf({ strategy: 'youtube', itemStatus: 'failed', error: 'ambiguous_youtube_upload: y', outputSummary: { delivery: 'ambiguous' } });
    eq(amb.actions, ['resolve_ambiguous'], 'acción ambigua');
    const auth = D.deliveryViewOf({ strategy: 'youtube', itemStatus: 'failed', error: 'e', outputSummary: { delivery: 'blocked_auth', youtubeBlockDetail: 'reconectá' } });
    eq([auth.detail, auth.actions], ['reconectá', ['reconnect_youtube', 'retry_upload']], 'detalle/acciones auth');
    for (const s of D.VIDEO_DELIVERY_VIEW_STATES) assert(typeof s === 'string', 'estado');
    eq(D.VIDEO_DELIVERY_VIEW_STATES, ['pending', 'rendering', 'completed_local', 'uploading_youtube', 'completed', 'blocked_auth', 'blocked_quota', 'upload_failed', 'ambiguous'], 'contrato de estados');
  });

  await check('V youtubeDeliveryProblems: completed + id + URL válida del mismo id + delivery completed; si no → keys', () => {
    const id = 'dQw4w9WgXcQ';
    const good = { delivery: 'completed', youtubeVideoId: id, youtubeUrl: `https://www.youtube.com/watch?v=${id}` };
    eq(D.youtubeDeliveryProblems('video:c1', 'completed', good), [], 'ok');
    eq(D.youtubeDeliveryProblems('video:c1', 'completed', { delivery: 'completed', external: { youtubeVideoId: id, youtubeUrl: `https://youtu.be/${id}` } }), [], 'ok desde external');
    eq(D.youtubeDeliveryProblems('video:c1', 'failed', good), ['video:c1:youtube_not_completed'], 'no completed');
    eq(D.youtubeDeliveryProblems('video:c1', 'completed', { delivery: 'completed' }), ['video:c1:missing_youtube_video_id', 'video:c1:missing_youtube_url'], 'sin id/url');
    eq(D.youtubeDeliveryProblems('video:c1', 'completed', { ...good, youtubeUrl: `https://www.youtube.com/watch?v=${id}&token=x` }), ['video:c1:invalid_youtube_url'], 'firmada');
    eq(D.youtubeDeliveryProblems('video:c1', 'completed', { ...good, youtubeVideoId: 'aaaaaaaaaaa' }), ['video:c1:invalid_youtube_url'], 'id distinto');
    eq(D.youtubeDeliveryProblems('video:c1', 'completed', { ...good, delivery: 'completed_local' }), ['video:c1:youtube_delivery_not_completed'], 'delivery');
  });

  // ── W. Worker con scheduler en memoria ────────────────────────────────────
  await runWorkerChecks();

  global.fetch = realFetch;
  console.log(`\n${passes} ok, ${failures} fail`);
  if (failures > 0) {
    console.error('❌ Entrega de video DN-1 (YouTube) rota.');
    process.exit(1);
  }
  console.log('✅ DN-1 OK (política, preflight, clasificación de subida, vista UI, packaging, worker).');
}

// ─────────────────────────────────────────────────────────────────────────────
// W — worker
// ─────────────────────────────────────────────────────────────────────────────
function makeItem(n, outputSummary = {}) {
  return {
    itemRunId: `ir-${n}`, runId: 'run-1', courseId: 1, frontendCourseId: 'fc', artifactCourseId: 'fc',
    manifestId: 7, blueprintId: 3, blueprintNumber: 1, itemKey: `video:ch${n}`, type: 'video', rulesVersion: 2,
    moduleId: 'm1', chapterId: `ch${n}`, moduleNumber: 1, chapterNumber: n, idempotencyKey: `idem-${n}`,
    generation: 1, dependsOn: [`content:ch${n}`], attempt: 1, outputSummary,
    dependencyArtifacts: [{ type: 'dynamic_content_md', artifactId: `art-${n}` }],
    blueprint: { course: { title: 'Curso' }, chapter: { title: `Cap ${n}` } },
  };
}

/** Mundo en memoria: output_summary por item (merge real de mergeOutputSummary), llamadas y estado del item. */
function makeWorld({ videoDelivery = 'youtube', videoMode = 'real' } = {}) {
  const store = new Map(); // itemRunId → output_summary
  const calls = { batchCreate: 0, getVideoStatus: 0, failItem: [], completeItem: [], uploads: [], getConnection: 0, getAccessToken: 0 };
  const yt = {
    connection: { userId: OWNER, status: 'active', scopes: 'youtube.upload,youtube.readonly' },
    tokenOk: true,
    uploadPlan: [], // 'ok' | Error
  };
  let seq = 0;
  const deps = {
    scheduler: {
      heartbeatItem: async () => true,
      failItem: async (id, ex, error, retryable, ownerId, opts) => { calls.failItem.push({ id, error, retryable, opts }); return true; },
      recordItemExternal: async (id, ex, patch) => {
        const m = mergeOutputSummary(store.get(id) ?? {}, patch);
        if (!m.ok) return false;
        store.set(id, m.merged);
        return true;
      },
      completeItem: async (id, ex, out) => {
        calls.completeItem.push({ id, out });
        const m = mergeOutputSummary(store.get(id) ?? {}, out.summary ?? {});
        store.set(id, m.merged);
        return true;
      },
    },
    dataSource: {
      query: async (sql, params) => {
        if (/from public\.production_jobs/.test(sql)) {
          const ip = { videoMode };
          if (videoDelivery) ip.videoDelivery = videoDelivery;
          return [{ owner_id: OWNER, video_mode: videoMode, input_payload: ip }];
        }
        if (/from public\.generation_item_runs/.test(sql)) return [{ output_summary: store.get(params[0]) ?? {} }];
        throw new Error('query no esperada: ' + sql);
      },
    },
    artifacts: {
      getDownloadUrl: async (id) => ({ url: `https://fake-storage.local/${id}` }),
      uploadJsonArtifact: async (p) => ({ id: `video-artifact-${p.storagePath}` }),
    },
    videogen: {
      batchCreate: async (jobs) => { calls.batchCreate++; return { batch_id: 'b1', jobs: [{ job_id: `vg-${jobs[0].client_reference_id}` }] }; },
      getVideoStatus: async (jobId) => { calls.getVideoStatus++; return { job_id: jobId, status: 'completed_local', download_url: `https://fake-videogen.local/download/${jobId}`, error: null }; },
      getVideoCost: async () => ({ estimated_total_cost: 0.94 }),
    },
    logger: { log() {}, warn() {}, error() {}, debug() {} },
    executorId: 'exec-1', leaseSeconds: 60, heartbeatMs: 60_000,
    videoTimeoutMin: 1, videoPollMs: 1, mockScenario: 'success', mockResolvePolls: 1,
    youtubeUploadMaxTries: 3, youtubeUploadRetryBaseMs: 1, youtubeQuotaRetrySeconds: 7200,
    youtube: {
      getConnection: async () => { calls.getConnection++; return yt.connection; },
      getAccessToken: async () => { calls.getAccessToken++; if (!yt.tokenOk) throw new Error(RAW_GOOGLE_ERROR); return SECRET_TOKEN_MARKER; },
      uploadFromUrl: async (c, opts) => {
        calls.uploads.push(opts);
        const p = yt.uploadPlan.shift() || 'ok';
        if (p !== 'ok') throw p;
        seq++;
        const videoId = `YtW${String(seq).padStart(8, '0')}`;
        return { videoId, youtubeUrl: `https://www.youtube.com/watch?v=${videoId}` };
      },
    },
  };
  /** Simula el re-claim del scheduler (retry automático o explícito): el item vuelve con su output_summary. */
  const reclaim = (n) => worker.processItem(deps, makeItem(n, store.get(`ir-${n}`) ?? {}));
  return { deps, calls, yt, store, reclaim };
}

const ENV = { DYNAMIC_COURSE_STRUCTURE: 'true', DYNAMIC_V2_ALLOWED_OWNERS: undefined, DYNAMIC_REAL_VIDEO_OWNERS: OWNER, VIDEOGEN_API_KEY: 'k', DYNAMIC_ALLOW_VIDEOGEN_DIRECT: undefined };
const { UnauthorizedException, BadRequestException } = require('@nestjs/common');
const transient = () => new YoutubeUploadTransportError('Fallo al subir video a YouTube: HTTP 503', 'upload', 503);
const initNetwork = () => new YoutubeUploadTransportError('No se pudo iniciar la subida a YouTube: fetch failed', 'init');
const putNetwork = () => new YoutubeUploadTransportError('Fallo al subir video a YouTube: socket hang up', 'upload');

function assertCompleted(w, n, msg) {
  const done = w.calls.completeItem.find((c) => c.id === `ir-${n}`);
  assert(done, `${msg}: no completó`);
  const s = done.out.summary;
  assert(/^[A-Za-z0-9_-]{11}$/.test(s.youtubeVideoId) && s.youtubeUrl === `https://www.youtube.com/watch?v=${s.youtubeVideoId}` && s.delivery === 'completed', `${msg}: completed sin id/url: ${JSON.stringify(s)}`);
}

async function runWorkerChecks() {
  await check('W happy path youtube real: 1 envío a Videogen, preflight liviano antes, 1 subida Unlisted, completed con id+url', () =>
    withEnv(ENV, async () => {
      const w = makeWorld();
      await worker.processItem(w.deps, makeItem(1));
      eq(w.calls.batchCreate, 1, 'batchCreate');
      eq(w.calls.uploads.length, 1, 'uploads');
      eq(w.calls.uploads[0].privacyStatus, 'unlisted', 'privacy');
      assert(w.calls.getAccessToken >= 2, 'refresh antes del envío y antes de la subida');
      eq(w.calls.failItem, [], 'failItem');
      assertCompleted(w, 1, 'happy');
    }));

  for (const [label, setup, reason] of [
    ['sin conexión', (w) => { w.yt.connection = null; }, 'no_connection'],
    ['conexión revocada', (w) => { w.yt.connection = { ...w.yt.connection, status: 'revoked' }; }, 'no_connection'],
    ['reauth_required', (w) => { w.yt.connection = { ...w.yt.connection, status: 'reauth_required' }; }, 'reauth_required'],
    ['refresh del token falla', (w) => { w.yt.tokenOk = false; }, 'token_refresh_failed'],
    ['sin scope de subida', (w) => { w.yt.connection = { ...w.yt.connection, scopes: 'youtube.readonly' }; }, 'missing_upload_scope'],
  ]) {
    await check(`W preflight antes del envío: ${label} → 0 envíos a Videogen, sin marcador, failed no-reintentable youtube_preflight_failed:${reason}`, () =>
      withEnv(ENV, async () => {
        const w = makeWorld();
        setup(w);
        await worker.processItem(w.deps, makeItem(2));
        eq(w.calls.batchCreate, 0, 'batchCreate (gasto)');
        eq(w.calls.uploads.length, 0, 'uploads');
        assert(!(w.store.get('ir-2') || {}).externalSubmitStartedAt, 'marcó externalSubmitStartedAt');
        eq(w.calls.failItem.length, 1, 'failItem');
        const f = w.calls.failItem[0];
        assert(f.retryable === false && f.error.startsWith(`youtube_preflight_failed:${reason}: `), 'error: ' + f.error);
        assert(!f.error.includes(SECRET_TOKEN_MARKER) && !f.error.includes('RAW-GOOGLE'), 'filtró token/error crudo');
        // Vista UI
        eq(D.deliveryViewOf({ strategy: 'youtube', itemStatus: 'failed', error: f.error, outputSummary: w.store.get('ir-2') || {} }).state, 'blocked_auth', 'vista');
      }));
  }

  await check('W videogen_direct real sin DYNAMIC_ALLOW_VIDEOGEN_DIRECT → 0 envíos, video_delivery_not_youtube; con el permiso → envía (staging)', () =>
    withEnv(ENV, async () => {
      const w = makeWorld({ videoDelivery: null });
      await worker.processItem(w.deps, makeItem(3));
      eq(w.calls.batchCreate, 0, 'batchCreate sin permiso');
      assert(w.calls.failItem[0] && w.calls.failItem[0].retryable === false && /^video_delivery_not_youtube: /.test(w.calls.failItem[0].error), 'error');
      await withEnv({ DYNAMIC_ALLOW_VIDEOGEN_DIRECT: 'true' }, async () => {
        const w2 = makeWorld({ videoDelivery: 'videogen_direct' });
        await worker.processItem(w2.deps, makeItem(4));
        eq(w2.calls.batchCreate, 1, 'batchCreate con permiso');
        eq(w2.calls.uploads.length, 0, 'sin YouTube');
        eq(w2.calls.completeItem.length, 1, 'completed');
      });
    }));

  await check('W run mock youtube: sin preflight real ni red (publicador mock), completa', () =>
    withEnv({ ...ENV, DYNAMIC_REAL_VIDEO_OWNERS: undefined }, async () => {
      const w = makeWorld({ videoMode: 'mock' });
      w.yt.connection = null; // aunque no haya conexión: mock no la usa
      await worker.processItem(w.deps, makeItem(5));
      eq([w.calls.batchCreate, w.calls.uploads.length, w.calls.getConnection], [0, 0, 0], 'sin Videogen/YouTube reales');
      eq(w.calls.completeItem.length, 1, 'completed');
    }));

  // Fallos DESPUÉS de completed_local: nunca re-envío a Videogen; retry = solo subida.
  const afterLocal = [
    {
      label: 'auth (401) → blocked_auth (failed, sin reintento automático); reconecta + retry explícito → solo re-sube → completed',
      plan: [new UnauthorizedException('YouTube rechazó el token RAW-GOOGLE-TEXT')],
      expect: { delivery: 'blocked_auth', retryable: false, errPrefix: 'youtube_blocked_auth: ' },
    },
    {
      label: 'refresh falla justo antes de subir → blocked_auth sin marcar la subida',
      plan: [],
      before: (w) => { w.yt.tokenOkAfterSubmit = true; },
      expect: { delivery: 'blocked_auth', retryable: false, errPrefix: 'youtube_blocked_auth: ' },
      breakTokenAfterRender: true,
    },
    {
      label: 'cuota → blocked_quota (retrying con espera larga); re-claim → solo re-sube → completed',
      plan: [new YoutubeQuotaException()],
      expect: { delivery: 'blocked_quota', retryable: true, errPrefix: 'youtube_blocked_quota: ', retryAfter: 7200 },
    },
    {
      label: '5xx ×3 en el mismo reclamo (paridad legacy: 3 intentos) → upload_failed retryable; re-claim → completed',
      plan: [transient(), transient(), transient()],
      expect: { delivery: 'upload_failed', retryable: true, errPrefix: 'youtube_upload_failed: ', uploadsFirst: 3 },
    },
    {
      label: 'red caída al iniciar ×3 → upload_failed retryable; re-claim → completed',
      plan: [initNetwork(), initNetwork(), initNetwork()],
      expect: { delivery: 'upload_failed', retryable: true, errPrefix: 'youtube_upload_failed: ', uploadsFirst: 3 },
    },
    {
      label: 'descarga del MP4 falla → upload_failed retryable (sin reintentos en el reclamo); re-claim → completed',
      plan: [new BadRequestException('No se pudo descargar el video desde Videogen: HTTP 502')],
      expect: { delivery: 'upload_failed', retryable: true, errPrefix: 'youtube_upload_failed: ', uploadsFirst: 1 },
    },
  ];
  let n = 10;
  for (const t of afterLocal) {
    n++;
    const itemN = n;
    await check(`W después de completed_local: ${t.label}; 0 re-envíos a Videogen, MP4/URL de Videogen intactos`, () =>
      withEnv(ENV, async () => {
        const w = makeWorld();
        w.yt.uploadPlan = [...t.plan];
        if (t.breakTokenAfterRender) {
          // El token funciona para el envío y falla justo antes de la subida.
          let n2 = 0;
          w.deps.youtube.getAccessToken = async () => { w.calls.getAccessToken++; n2++; if (n2 > 1) throw new Error(RAW_GOOGLE_ERROR); return 't'; };
        }
        await worker.processItem(w.deps, makeItem(itemN));
        eq(w.calls.batchCreate, 1, 'batchCreate (1 solo render)');
        const os1 = w.store.get(`ir-${itemN}`);
        eq(os1.delivery, t.expect.delivery, 'delivery');
        assert(os1.videogenDownloadUrl === `https://fake-videogen.local/download/vg-idem-${itemN}` && os1.external.videogenJobId === `vg-idem-${itemN}`, 'MP4/URL de Videogen preservados');
        assert(!os1.youtubeUploadStartedAt, 'marcador de subida limpio (no ambiguo)');
        eq(w.calls.completeItem.length, 0, 'no completó');
        const f = w.calls.failItem[w.calls.failItem.length - 1];
        assert(f && f.retryable === t.expect.retryable && f.error.startsWith(t.expect.errPrefix), 'failItem: ' + JSON.stringify(f));
        assert(!f.error.includes('RAW-GOOGLE') && !f.error.includes(SECRET_TOKEN_MARKER), 'filtró texto crudo/token: ' + f.error);
        if (t.expect.retryAfter) eq(f.opts && f.opts.retryAfterSeconds, t.expect.retryAfter, 'espera de cuota');
        if (t.expect.uploadsFirst !== undefined) eq(w.calls.uploads.length, t.expect.uploadsFirst, 'intentos en el reclamo');
        // Retry (automático o explícito): solo la subida.
        const statusBefore = w.calls.getVideoStatus;
        w.yt.uploadPlan = [];
        if (t.breakTokenAfterRender) w.deps.youtube.getAccessToken = async () => 't';
        await w.reclaim(itemN);
        eq(w.calls.batchCreate, 1, 'batchCreate tras el retry (sin re-envío)');
        eq(w.calls.getVideoStatus, statusBefore, 'sin re-poll a Videogen');
        assertCompleted(w, itemN, 'tras el retry');
      }));
  }

  await check('W 5xx ×2 y OK al 3er intento del MISMO reclamo → completed sin pasar por retrying', () =>
    withEnv(ENV, async () => {
      const w = makeWorld();
      w.yt.uploadPlan = [transient(), transient()];
      await worker.processItem(w.deps, makeItem(30));
      eq([w.calls.batchCreate, w.calls.uploads.length, w.calls.failItem.length], [1, 3, 0], 'batch/uploads/fails');
      assertCompleted(w, 30, 'mismo reclamo');
    }));

  await check('W subida ambigua (PUT sin respuesta): marcador queda, delivery ambiguous, failed no-reintentable; re-claim NUNCA re-sube', () =>
    withEnv(ENV, async () => {
      const w = makeWorld();
      w.yt.uploadPlan = [putNetwork()];
      await worker.processItem(w.deps, makeItem(40));
      const os = w.store.get('ir-40');
      assert(os.delivery === 'ambiguous' && os.youtubeUploadStartedAt, 'estado ambiguo con marcador: ' + JSON.stringify(os));
      const f = w.calls.failItem[0];
      assert(f.retryable === false && f.error.startsWith('ambiguous_youtube_upload: '), 'failItem');
      await w.reclaim(40);
      eq([w.calls.uploads.length, w.calls.batchCreate], [1, 1], 're-claim: 0 subidas y 0 envíos nuevos');
      assert(w.calls.failItem[1] && w.calls.failItem[1].error.startsWith('ambiguous_youtube_upload: '), 'sigue ambigua');
      eq(D.deliveryViewOf({ strategy: 'youtube', itemStatus: 'failed', error: f.error, outputSummary: os }).actions, ['resolve_ambiguous'], 'acción UI');
    }));

  await check('W subida ambigua (2xx sin id) → ambigua, nunca un segundo video', () =>
    withEnv(ENV, async () => {
      const w = makeWorld();
      w.yt.uploadPlan = [new YoutubeUploadTransportError('Fallo al subir video a YouTube: YouTube no devolvió ID del video', 'upload')];
      await worker.processItem(w.deps, makeItem(41));
      eq(w.calls.uploads.length, 1, '1 sola subida');
      eq(w.store.get('ir-41').delivery, 'ambiguous', 'ambigua');
    }));

  await check('W resolución confirm_existing (forma que escribe RunsService.resolveYoutubeUpload) → finaliza SIN subir ni enviar', () =>
    withEnv(ENV, async () => {
      const w = makeWorld();
      w.yt.uploadPlan = [putNetwork()];
      await worker.processItem(w.deps, makeItem(42));
      const os = w.store.get('ir-42');
      w.store.set('ir-42', { ...os, delivery: 'completed_local', youtubeUploadStartedAt: null, external: { ...os.external, youtubeVideoId: 'dQw4w9WgXcQ', youtubeUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' } });
      await w.reclaim(42);
      eq([w.calls.uploads.length, w.calls.batchCreate], [1, 1], 'sin subidas ni envíos nuevos');
      const done = w.calls.completeItem.find((c) => c.id === 'ir-42');
      assert(done && done.out.summary.youtubeVideoId === 'dQw4w9WgXcQ', 'completed con el id confirmado');
    }));

  await check('W resolución authorize_reupload → exactamente UNA subida más → completed; 0 envíos a Videogen', () =>
    withEnv(ENV, async () => {
      const w = makeWorld();
      w.yt.uploadPlan = [putNetwork()];
      await worker.processItem(w.deps, makeItem(43));
      const os = w.store.get('ir-43');
      w.store.set('ir-43', { ...os, delivery: 'completed_local', youtubeUploadStartedAt: null });
      await w.reclaim(43);
      eq([w.calls.uploads.length, w.calls.batchCreate], [2, 1], '1 subida más, 0 envíos');
      assertCompleted(w, 43, 'reupload');
    }));
}

main().catch((err) => {
  console.error('❌ Error inesperado:', err);
  process.exit(1);
});
