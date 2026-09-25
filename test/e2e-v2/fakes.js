// Servidores falsos del E2E (todo en 127.0.0.1):
//  - Supabase Storage (mismos endpoints que usa el backend y el shim del navegador).
//  - Videogen (batch-create / status / costs) → completed_local + download_url https LOCAL.
//  - Servidor https local (cert autofirmado) que sirve el "MP4" de cada job.
//  - Google (OAuth + YouTube Data API v3) para la fase YouTube (DN-1).
'use strict';
const http = require('http');
const https = require('https');
const fs = require('fs');
const crypto = require('crypto');

function startStorage() {
  const blobs = new Map(); // "bucket/path" → Buffer
  const log = [];
  const srv = http.createServer((rq, rs) => {
    const chunks = [];
    rq.on('data', (c) => chunks.push(c));
    rq.on('end', () => {
      const u = new URL(rq.url, 'http://x');
      const p = decodeURIComponent(u.pathname);
      const body = Buffer.concat(chunks);
      log.push(`${rq.method} ${p}`);
      let m;
      if (rq.method === 'POST' && (m = p.match(/^\/storage\/v1\/object\/sign\/(.+)$/))) {
        if (!blobs.has(m[1])) { rs.writeHead(404, { 'content-type': 'application/json' }); return rs.end('{"error":"not found"}'); }
        rs.writeHead(200, { 'content-type': 'application/json' });
        return rs.end(JSON.stringify({ signedURL: `/object/sign/${m[1]}?token=t`, signedUrl: `/object/sign/${m[1]}?token=t` }));
      }
      if (rq.method === 'GET' && (m = p.match(/^\/storage\/v1\/object\/sign\/(.+)$/))) {
        if (!blobs.has(m[1])) { rs.writeHead(404); return rs.end('nf'); }
        rs.writeHead(200);
        return rs.end(blobs.get(m[1]));
      }
      if ((rq.method === 'HEAD' || rq.method === 'GET') && (m = p.match(/^\/storage\/v1\/object\/authenticated\/(.+)$/))) {
        if (!blobs.has(m[1])) { rs.writeHead(404); return rs.end(); }
        rs.writeHead(200, { 'content-length': String(blobs.get(m[1]).length) });
        return rs.end(rq.method === 'GET' ? blobs.get(m[1]) : undefined);
      }
      if ((rq.method === 'POST' || rq.method === 'PUT') && (m = p.match(/^\/storage\/v1\/object\/(.+)$/))) {
        if (blobs.has(m[1]) && String(rq.headers['x-upsert']) !== 'true') {
          rs.writeHead(400, { 'content-type': 'application/json' });
          return rs.end('{"statusCode":"409","error":"Duplicate","message":"The resource already exists"}');
        }
        blobs.set(m[1], body);
        rs.writeHead(200, { 'content-type': 'application/json' });
        return rs.end(JSON.stringify({ Key: m[1] }));
      }
      if (rq.method === 'DELETE' && (m = p.match(/^\/storage\/v1\/object\/(.+)$/))) {
        blobs.delete(m[1]);
        rs.writeHead(200);
        return rs.end('{}');
      }
      rs.writeHead(400);
      rs.end('unsupported');
    });
  });
  return { srv, blobs, log };
}

function startVideogen(apiKey, getHttpsBase) {
  const jobs = new Map(); // job_id → {ref, title, content_txt, polls, chapter_number}
  const submissions = []; // {client_reference_id, job_id, title, content_txt}
  const badAuth = [];
  let seq = 0;
  const srv = http.createServer((rq, rs) => {
    const chunks = [];
    rq.on('data', (c) => chunks.push(c));
    rq.on('end', () => {
      const p = new URL(rq.url, 'http://x').pathname;
      const json = (code, obj) => { rs.writeHead(code, { 'content-type': 'application/json' }); rs.end(JSON.stringify(obj)); };
      if (rq.headers.authorization !== `Bearer ${apiKey}`) { badAuth.push(`${rq.method} ${p}`); return json(401, { error: 'bad key' }); }
      let m;
      if (rq.method === 'POST' && p === '/api/external/videos/batch-create') {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        const out = [];
        for (const v of body.videos || []) {
          const job_id = `vgjob-${++seq}-${crypto.createHash('sha256').update(String(v.client_reference_id)).digest('hex').slice(0, 8)}`;
          jobs.set(job_id, { ref: v.client_reference_id, title: v.title, content_txt: v.content_txt, polls: 0, chapter_number: v.chapter_number });
          submissions.push({ client_reference_id: v.client_reference_id, job_id, title: v.title, content_txt: v.content_txt, chapter_number: v.chapter_number });
          out.push({ job_id, chapter_number: v.chapter_number, status: 'queued', client_reference_id: v.client_reference_id });
        }
        return json(200, { batch_id: `vgbatch-${seq}`, jobs: out });
      }
      if (rq.method === 'GET' && (m = p.match(/^\/api\/external\/videos\/([^/]+)\/status$/))) {
        const j = jobs.get(decodeURIComponent(m[1]));
        if (!j) return json(404, { error: 'job not found' });
        j.polls++;
        if (j.polls < 2) return json(200, { job_id: m[1], chapter_number: j.chapter_number, status: 'processing', progress: 50, client_reference_id: j.ref, download_url: null });
        return json(200, { job_id: m[1], chapter_number: j.chapter_number, status: 'completed_local', progress: 100, client_reference_id: j.ref,
          download_url: `${getHttpsBase()}/api/videos/${m[1]}/download` });
      }
      if (rq.method === 'GET' && (m = p.match(/^\/api\/costs\/videos\/([^/]+)$/))) {
        if (!jobs.has(decodeURIComponent(m[1]))) return json(404, { error: 'job not found' });
        return json(200, { job_id: m[1], estimated_total_cost: 0.42, breakdown: { fake: 0.42 } });
      }
      json(404, { error: `unhandled ${rq.method} ${p}` });
    });
  });
  return { srv, jobs, submissions, badAuth };
}

function startHttpsVideos(tlsDir, videogen) {
  const downloads = [];
  const srv = https.createServer({ key: fs.readFileSync(`${tlsDir}/key.pem`), cert: fs.readFileSync(`${tlsDir}/cert.pem`) }, (rq, rs) => {
    const m = new URL(rq.url, 'https://x').pathname.match(/^\/api\/videos\/([^/]+)\/download$/);
    if (!m || !videogen.jobs.has(m[1])) { rs.writeHead(404); return rs.end('nf'); }
    downloads.push(m[1]);
    rs.writeHead(200, { 'content-type': 'video/mp4' });
    // ≥ 1 KB: YoutubeUploadService (legacy) rechaza archivos < 1024 bytes como vacíos (fase YouTube, DN-1).
    rs.end(Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42'), Buffer.from(`fake-mp4:${m[1]}`), Buffer.alloc(4096, 0)]));
  });
  return { srv, downloads };
}

// Google FALSO (DN-1): OAuth token (refresh), channels.list mine=true y subida
// resumable de YouTube. Registra cada llamada; `initPlan` programa respuestas
// del POST de inicio ('ok' | status HTTP) para probar reintentos.
function startGoogle() {
  const g = { refresh: new Map(), channels: new Map(), initPlan: [], calls: [], uploads: [], seq: 0, base: null };
  const srv = http.createServer((rq, rs) => {
    const chunks = [];
    rq.on('data', (c) => chunks.push(c));
    rq.on('end', () => {
      const u = new URL(rq.url, 'http://x');
      const body = Buffer.concat(chunks);
      const json = (code, obj, headers = {}) => { rs.writeHead(code, { 'content-type': 'application/json', ...headers }); rs.end(JSON.stringify(obj)); };
      g.calls.push(`${rq.method} ${u.pathname}`);
      if (rq.method === 'POST' && u.pathname === '/token') {
        const rt = new URLSearchParams(body.toString('utf8')).get('refresh_token');
        const at = g.refresh.get(rt);
        return at ? json(200, { access_token: at, expires_in: 3599 }) : json(400, { error: 'invalid_grant', error_description: 'fake revoked' });
      }
      const auth = String(rq.headers.authorization || '').replace(/^Bearer /, '');
      if (rq.method === 'GET' && u.pathname === '/youtube/v3/channels') {
        const c = g.channels.get(auth);
        return json(200, { items: c ? [{ id: c.id, snippet: { title: c.title, thumbnails: { default: { url: c.thumb } } } }] : [] });
      }
      if (rq.method === 'POST' && u.pathname === '/upload/youtube/v3/videos') {
        if (!g.channels.get(auth)) return json(401, { error: { message: 'bad token' } });
        const p = g.initPlan.shift() || 'ok';
        if (typeof p === 'number') { rs.writeHead(p); return rs.end(`fake ${p}`); }
        const meta = JSON.parse(body.toString('utf8') || '{}');
        const n = ++g.seq;
        g.uploads.push({ n, title: meta.snippet && meta.snippet.title, privacyStatus: meta.status && meta.status.privacyStatus, bytes: 0, videoId: null });
        rs.writeHead(200, { location: `${g.base}/upload-session/${n}` });
        return rs.end();
      }
      let m;
      if (rq.method === 'PUT' && (m = u.pathname.match(/^\/upload-session\/(\d+)$/))) {
        const up = g.uploads.find((x) => x.n === Number(m[1]));
        if (!up) return json(404, { error: 'no session' });
        up.bytes = body.length;
        up.videoId = `YtE2E${String(up.n).padStart(6, '0')}`;
        return json(200, { id: up.videoId, kind: 'youtube#video' });
      }
      json(404, { error: `unhandled ${rq.method} ${u.pathname}` });
    });
  });
  return { srv, g };
}

async function listen(srv) {
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return srv.address().port;
}

async function startFakes({ tlsDir, videogenKey }) {
  const storage = startStorage();
  let httpsBase = null;
  const videogen = startVideogen(videogenKey, () => httpsBase);
  const vids = startHttpsVideos(tlsDir, videogen);
  const google = startGoogle();
  const sp = await listen(storage.srv);
  const vp = await listen(videogen.srv);
  const hp = await listen(vids.srv);
  const gp = await listen(google.srv);
  httpsBase = `https://127.0.0.1:${hp}`;
  google.g.base = `http://127.0.0.1:${gp}`;
  return {
    storageUrl: `http://127.0.0.1:${sp}`,
    videogenUrl: `http://127.0.0.1:${vp}`,
    googleUrl: google.g.base,
    httpsBase,
    storage, videogen, vids, google: google.g,
    close: async () => { for (const s of [storage.srv, videogen.srv, vids.srv, google.srv]) await new Promise((r) => s.close(() => r())); },
  };
}

module.exports = { startFakes };
