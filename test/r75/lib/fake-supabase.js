/* eslint-disable */
// r75 · Agente E — Supabase falso en 127.0.0.1: Auth Admin API (crear/invitar/banear) + Storage (firmar URLs).
// Guarda cada request (para verificar que la contraseña temporal SOLO viaja al proveedor y nunca a logs/DB/auditoría).
'use strict';
const http = require('http');
const crypto = require('crypto');

function startFakeSupabase({ serviceKey }) {
  const users = new Map(); // id → user
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let json = null;
      try { json = body ? JSON.parse(body) : null; } catch {}
      requests.push({ method: req.method, url: req.url, body: json, auth: !!req.headers.authorization, apikey: req.headers.apikey === serviceKey });
      const send = (s, o) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
      const okKey = req.headers.apikey === serviceKey || String(req.headers.authorization || '') === `Bearer ${serviceKey}`;
      const u = new URL(req.url, 'http://x');
      if (u.pathname.startsWith('/auth/v1/')) {
        if (!okKey) return send(401, { msg: 'invalid service key' });
        if (req.method === 'POST' && (u.pathname === '/auth/v1/admin/users' || u.pathname === '/auth/v1/invite')) {
          const email = String((json && json.email) || '').toLowerCase();
          if ([...users.values()].some((x) => x.email === email)) return send(422, { code: 'email_exists', msg: 'A user with this email address has already been registered' });
          const id = crypto.randomUUID();
          const user = { id, email, aud: 'authenticated', role: 'authenticated', email_confirmed_at: json && json.email_confirm ? new Date().toISOString() : null, user_metadata: (json && (json.user_metadata || json.data)) || {}, created_at: new Date().toISOString(), last_sign_in_at: null, banned_until: null };
          users.set(id, user);
          if (startFakeSupabase.onUserCreated) startFakeSupabase.onUserCreated(user);
          return send(200, u.pathname === '/auth/v1/invite' ? user : user);
        }
        const m = u.pathname.match(/^\/auth\/v1\/admin\/users\/([0-9a-f-]{36})$/);
        if (m) {
          const user = users.get(m[1]);
          if (req.method === 'GET') return user ? send(200, user) : send(404, { msg: 'User not found' });
          if (req.method === 'PUT') {
            if (!user) return send(404, { msg: 'User not found' });
            if (json && json.ban_duration) user.banned_until = json.ban_duration === 'none' ? null : new Date(Date.now() + 876000 * 3600e3).toISOString();
            return send(200, user);
          }
        }
        if (req.method === 'GET' && u.pathname === '/auth/v1/admin/users') return send(200, { users: [...users.values()] });
        return send(404, { msg: 'not found (fake)' });
      }
      if (u.pathname.startsWith('/storage/v1/object/sign/')) {
        if (!okKey) return send(401, { msg: 'invalid service key' });
        const p = u.pathname.slice('/storage/v1/object/sign/'.length);
        return send(200, { signedURL: `/object/sign/${p}?token=fake-signed-${crypto.randomBytes(6).toString('hex')}` });
      }
      if (u.pathname.startsWith('/storage/v1/')) return send(200, {});
      send(404, { msg: 'not found (fake)' });
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}`, users, requests, close: () => new Promise((r) => server.close(r)),
  })));
}
module.exports = { startFakeSupabase };
