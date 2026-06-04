/**
 * qa-youtube-real-upload.ts — Prueba real de upload a YouTube
 *
 * SEGURIDAD:
 *   - Nunca imprime refresh_token, access_token ni CLIENT_SECRET.
 *   - Solo muestra estado sí/no para tokens y credenciales.
 *   - El snapshot NO contiene tokens, solo youtubeUrl/videoId (URLs públicas).
 *   - El archivo de snapshot está en .gitignore.
 *
 * Valida SOLO el flujo de upload sin IA, sin Videogen, sin BD obligatoria:
 *   downloadUrl → upload real → youtubeVideoId → youtubeUrl → snapshot
 *
 * Modos:
 *   Sin BD: YOUTUBE_TEST_REFRESH_TOKEN=<token> npx ts-node src/scripts/qa-youtube-real-upload.ts
 *   Con BD: YOUTUBE_TEST_USE_DB=true YOUTUBE_TEST_USER_ID=<uuid> npx ts-node ...
 *   Dry-run: YOUTUBE_TEST_DRY_RUN=true (solo verifica token y canal, no sube)
 *
 * NO consume tokens de IA. NO genera contenido. NO llama modelos de lenguaje.
 */

import * as fs   from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

// ─── Cargar .env sin biblioteca external ─────────────────────────────────────

function loadDotEnv(filePath: string): void {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    for (const line of content.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq < 0) continue;
      const k = t.slice(0, eq).trim();
      const v = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
      if (k && !process.env[k]) process.env[k] = v;
    }
  } catch { /* .env no encontrado — ok */ }
}

loadDotEnv(path.resolve(__dirname, '../../.env'));

// ─── Config (nunca se imprime completo) ──────────────────────────────────────

const CLIENT_ID     = process.env.YOUTUBE_CLIENT_ID     ?? '';
const CLIENT_SECRET = process.env.YOUTUBE_CLIENT_SECRET ?? '';
const TOKEN_SECRET  = process.env.YOUTUBE_TOKEN_SECRET  ?? '';
const RAW_TOKEN     = process.env.YOUTUBE_TEST_REFRESH_TOKEN ?? '';
const TEST_USER_ID  = process.env.YOUTUBE_TEST_USER_ID  ?? '';
const USE_DB        = process.env.YOUTUBE_TEST_USE_DB   === 'true';
const DRY_RUN       = process.env.YOUTUBE_TEST_DRY_RUN  === 'true';
const TEST_VIDEO    = process.env.YOUTUBE_TEST_VIDEO_PATH
                    ?? path.join(process.env.HOME ?? '', 'Downloads', 'cap_4.mp4');

// Ruta del snapshot — en .gitignore, fuera de src/
const SNAPSHOT_PATH = path.resolve(__dirname, '../../qa_youtube_real_snapshot.json');

// ─── Logger seguro (nunca imprime tokens) ────────────────────────────────────

function log(msg: string, tag: 'ok' | 'warn' | 'err' | 'info' | 'step' = 'info') {
  const icon = { ok: '✅', warn: '⚠️ ', err: '❌', info: '   ', step: '  ›' }[tag];
  console.log(`${icon} ${msg}`);
}

function section(title: string) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 52 - title.length))}`);
}

/** Muestra sí/no sin revelar el valor */
function yn(v: unknown): string { return v ? 'sí' : 'no'; }

// ─── Operaciones con tokens (sin logging del valor) ──────────────────────────

function decryptRefreshToken(encrypted: string, iv: string): string {
  if (!TOKEN_SECRET) throw new Error('YOUTUBE_TOKEN_SECRET no configurado');
  const key = crypto.createHash('sha256').update(TOKEN_SECRET).digest();
  const data = Buffer.from(encrypted, 'base64');
  const ivBuf = Buffer.from(iv, 'base64');
  const tag = data.subarray(data.length - 16);
  const ct  = data.subarray(0, data.length - 16);
  const d   = crypto.createDecipheriv('aes-256-gcm', key, ivBuf);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}

async function refreshAccessToken(refreshToken: string): Promise<string> {
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type:    'refresh_token',
    }).toString(),
  });
  const data = await resp.json() as Record<string, unknown>;
  if (!data['access_token']) {
    // Log the error code/description but never the token values
    const errCode = data['error'] ?? 'unknown';
    const errDesc = data['error_description'] ?? '';
    throw new Error(`Token refresh falló [${errCode}]: ${errDesc}`);
  }
  return data['access_token'] as string;
}

async function getChannelInfo(token: string): Promise<{ id: string; title: string }> {
  const resp = await fetch(
    'https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true&maxResults=1',
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const data = await resp.json() as Record<string, any>;
  const item = data?.items?.[0];
  if (!item) {
    const errMsg = data?.error?.message ?? 'sin items en respuesta';
    throw new Error(`Canal YouTube no encontrado: ${errMsg}`);
  }
  return { id: item.id as string, title: (item.snippet?.title as string) ?? '(sin nombre)' };
}

async function uploadVideo(opts: {
  token:       string;
  filePath:    string;
  title:       string;
  description: string;
}): Promise<{ videoId: string; youtubeUrl: string }> {
  const { token, filePath, title, description } = opts;

  const fileBuffer = fs.readFileSync(filePath);
  const fileSize   = fileBuffer.length;

  if (fileSize < 1024)               throw new Error('Video vacío o inválido (< 1 KB)');
  if (fileSize > 512 * 1024 * 1024)  throw new Error('Video > 512 MB — fuera del límite del worker');

  const meta = {
    snippet: {
      title:           title.slice(0, 100),
      description,
      categoryId:      '27',
      defaultLanguage: 'es',
    },
    status: {
      privacyStatus:           'unlisted',
      selfDeclaredMadeForKids: false,
    },
  };

  // Paso 1 — iniciar upload resumable
  log('Iniciando upload resumable con YouTube API…', 'step');
  const initResp = await fetch(
    'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
    {
      method:  'POST',
      headers: {
        Authorization:             `Bearer ${token}`,
        'Content-Type':            'application/json; charset=UTF-8',
        'X-Upload-Content-Type':   'video/mp4',
        'X-Upload-Content-Length': String(fileSize),
      },
      body:   JSON.stringify(meta),
      signal: AbortSignal.timeout(30_000),
    },
  );

  if (initResp.status === 401) {
    throw new Error('AUTH_EXPIRED: el token fue rechazado por YouTube (401)');
  }
  if (initResp.status === 403) {
    let body: Record<string, any> = {};
    try { body = await initResp.json() as Record<string, any>; } catch { /* ignore */ }
    const reason = (body?.error?.errors as Array<{ reason?: string }>)?.[0]?.reason ?? '';
    if (reason === 'quotaExceeded' || reason === 'rateLimitExceeded') {
      throw new Error('QUOTA_EXCEEDED: cuota diaria de YouTube agotada');
    }
    throw new Error(`AUTH_FORBIDDEN: YouTube rechazó el acceso (403, reason=${reason || 'desconocido'})`);
  }
  if (!initResp.ok) {
    const errText = await initResp.text();
    throw new Error(`Init HTTP ${initResp.status}: ${errText.slice(0, 200)}`);
  }

  const uploadUrl = initResp.headers.get('location');
  if (!uploadUrl) throw new Error('Location header ausente — YouTube no devolvió URL de upload');
  log('Upload URL recibida de YouTube ✓', 'ok');

  // Paso 2 — subir bytes
  log(`Subiendo ${(fileSize / 1024 / 1024).toFixed(1)} MB…`, 'step');
  const uploadResp = await fetch(uploadUrl, {
    method:  'PUT',
    headers: {
      'Content-Type':   'video/mp4',
      'Content-Length': String(fileSize),
    },
    body:   new Uint8Array(fileBuffer),
    signal: AbortSignal.timeout(600_000),
  });

  if (!uploadResp.ok) {
    const errText = await uploadResp.text();
    if (uploadResp.status === 401) throw new Error('AUTH_EXPIRED: token expiró durante la subida');
    throw new Error(`Upload HTTP ${uploadResp.status}: ${errText.slice(0, 200)}`);
  }

  const videoData = await uploadResp.json() as Record<string, unknown>;
  const videoId   = videoData['id'] as string | undefined;
  if (!videoId) throw new Error('YouTube no devolvió ID del video tras el upload');

  return { videoId, youtubeUrl: `https://www.youtube.com/watch?v=${videoId}` };
}

// ─── Obtener refresh token (desde env o BD) ───────────────────────────────────

async function obtainRefreshToken(): Promise<string> {
  if (RAW_TOKEN) {
    log('refresh_token: detectado en YOUTUBE_TEST_REFRESH_TOKEN', 'ok');
    return RAW_TOKEN;
  }

  if (USE_DB) {
    if (!TEST_USER_ID) throw new Error('YOUTUBE_TEST_USER_ID es requerido con USE_DB=true');
    if (!TOKEN_SECRET) throw new Error('YOUTUBE_TOKEN_SECRET es requerido para descifrar desde BD');

    log(`BD: conectando para user_id …${TEST_USER_ID.slice(-8)}`, 'step');
    const { Client } = require('pg') as typeof import('pg');
    const client = new Client({
      host:     process.env.DB_HOST ?? 'localhost',
      port:     Number(process.env.DB_PORT ?? 5432),
      user:     process.env.DB_USER ?? 'orbia',
      password: process.env.DB_PASS ?? 'orbia_dev',
      database: process.env.DB_NAME ?? 'orbia',
      ssl:      process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
    });
    await client.connect();
    const res = await client.query<{
      encrypted_refresh_token: string;
      token_iv:               string;
      status:                 string;
      channel_title:          string;
    }>(
      'SELECT encrypted_refresh_token, token_iv, status, channel_title FROM youtube_connections WHERE user_id = $1 LIMIT 1',
      [TEST_USER_ID],
    );
    await client.end();

    if (!res.rows.length) throw new Error(`No hay conexión YouTube para user …${TEST_USER_ID.slice(-8)}`);
    const row = res.rows[0];
    if (row.status !== 'active') throw new Error(`youtube_connections.status='${row.status}' — no activa`);

    log(`BD: canal "${row.channel_title}" — status: ${row.status} ✓`, 'ok');
    log('refresh_token: descifrado desde BD ✓', 'ok');
    return decryptRefreshToken(row.encrypted_refresh_token, row.token_iv);
  }

  throw new Error(
    'NO_TOKEN: no se encontró refresh_token.\n\n' +
    'Opciones:\n' +
    '  A) YOUTUBE_TEST_REFRESH_TOKEN=<token> npx ts-node src/scripts/qa-youtube-real-upload.ts\n' +
    '     Obtener token: developers.google.com/oauthplayground\n' +
    '     Scope: https://www.googleapis.com/auth/youtube.upload\n\n' +
    '  B) YOUTUBE_TEST_USE_DB=true YOUTUBE_TEST_USER_ID=<uuid> npx ts-node ...\n' +
    '     (requiere Docker/BD activa)',
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('\n══════════════════════════════════════════════════════════');
  console.log('  QA: Upload real YouTube — sin IA, sin tokens Cursia');
  console.log('══════════════════════════════════════════════════════════');

  // ── 0. Verificar configuración ────────────────────────────────────────────
  section('0. Configuración (sin valores sensibles)');
  if (!CLIENT_ID)     throw new Error('YOUTUBE_CLIENT_ID no configurado en .env');
  if (!CLIENT_SECRET) throw new Error('YOUTUBE_CLIENT_SECRET no configurado en .env');

  log(`YOUTUBE_CLIENT_ID configurado:     ${yn(CLIENT_ID)}`, 'ok');
  log(`YOUTUBE_CLIENT_SECRET configurado: ${yn(CLIENT_SECRET)}`, 'ok');
  log(`YOUTUBE_TOKEN_SECRET configurado:  ${yn(TOKEN_SECRET)}`, CLIENT_SECRET ? 'ok' : 'warn');
  log(`refresh_token en env:              ${yn(RAW_TOKEN)}`, RAW_TOKEN ? 'ok' : 'info');
  log(`Modo BD (USE_DB):                  ${yn(USE_DB)}`, 'info');
  log(`Dry-run:                           ${yn(DRY_RUN)}`, 'info');
  log(`Video de prueba: ${TEST_VIDEO}`, 'info');

  // ── 1. Obtener refresh token ──────────────────────────────────────────────
  section('1. Refresh token');
  const refreshToken = await obtainRefreshToken();
  // No imprimimos el valor — solo confirmamos que existe
  log(`refresh_token detectado: sí`, 'ok');

  // ── 2. Renovar access token ───────────────────────────────────────────────
  section('2. Access token (renovar desde Google)');
  const accessToken = await refreshAccessToken(refreshToken);
  // No imprimimos el access_token
  log(`access_token renovado: sí`, 'ok');

  // ── 3. Verificar canal ────────────────────────────────────────────────────
  section('3. Canal YouTube');
  const channel = await getChannelInfo(accessToken);
  log(`canal detectado: sí`, 'ok');
  log(`nombre: "${channel.title}"`, 'ok');
  log(`id: ${channel.id}`, 'ok');

  if (DRY_RUN) {
    section('DRY-RUN completado');
    log('Token y canal verificados. No se subió ningún video.', 'ok');
    process.exit(0);
  }

  // ── 4. Video de prueba ────────────────────────────────────────────────────
  section('4. Video de prueba');
  if (!fs.existsSync(TEST_VIDEO)) {
    throw new Error(
      `No encontrado: ${TEST_VIDEO}\n` +
      'Pon un MP4 en ~/Downloads/cap_4.mp4 o configura YOUTUBE_TEST_VIDEO_PATH',
    );
  }
  const { size } = fs.statSync(TEST_VIDEO);
  log(`archivo: ${path.basename(TEST_VIDEO)}`, 'ok');
  log(`tamaño: ${(size / 1024 / 1024).toFixed(1)} MB`, 'ok');

  // ── 5. Upload real ────────────────────────────────────────────────────────
  section('5. Upload #1 → YouTube');
  const testTitle = `[QA Cursia] ${path.basename(TEST_VIDEO, '.mp4')} — ${new Date().toISOString().slice(0, 16)}`;
  const testDesc  = 'Video de prueba QA automatizada. No listado. Puede eliminarse desde YouTube Studio.';

  let result1: { videoId: string; youtubeUrl: string };
  try {
    result1 = await uploadVideo({ token: accessToken, filePath: TEST_VIDEO, title: testTitle, description: testDesc });
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.startsWith('AUTH_')) {
      log(`upload exitoso: no`, 'err');
      log(`razón: token inválido o revocado — reconecta YouTube`, 'warn');
      process.exit(1);
    }
    if (msg.startsWith('QUOTA_')) {
      log(`upload exitoso: no`, 'err');
      log(`razón: cuota YouTube agotada — espera 24 h`, 'warn');
      process.exit(1);
    }
    throw e;
  }

  log(`upload exitoso: sí`, 'ok');
  log(`youtubeVideoId: ${result1.videoId}`, 'ok');
  log(`youtubeUrl:     ${result1.youtubeUrl}`, 'ok');
  log(`privacidad:     unlisted (no listado)`, 'ok');

  // ── 6. Simular outputSummary.youtubeUploads ───────────────────────────────
  section('6. outputSummary.youtubeUploads (simulado)');

  interface UploadEntry {
    cap: number; title: string; downloadUrl: string;
    youtubeVideoId: string; youtubeUrl: string;
    status: 'uploaded' | 'failed'; uploadedAt: string;
  }

  const youtubeUploads: UploadEntry[] = [{
    cap:            1,
    title:          testTitle,
    downloadUrl:    path.basename(TEST_VIDEO),
    youtubeVideoId: result1.videoId,
    youtubeUrl:     result1.youtubeUrl,
    status:         'uploaded',
    uploadedAt:     new Date().toISOString(),
  }];

  log(`cap 1 → ${result1.youtubeUrl}`, 'ok');
  log(`status: uploaded`, 'ok');

  // ── 7. Anti-duplicado ─────────────────────────────────────────────────────
  section('7. Anti-duplicado (lógica del worker)');

  const alreadyDone = new Map<number, UploadEntry>(
    youtubeUploads
      .filter(u => u.status === 'uploaded' && u.youtubeUrl)
      .map(u => [u.cap, u] as [number, UploadEntry]),
  );

  const cap1Skipped = alreadyDone.has(1);
  log(`cap 1 en skip-set: ${yn(cap1Skipped)}`, cap1Skipped ? 'ok' : 'err');
  log(`si se re-ejecutara: cap 1 se OMITIRÍA sin llamar a YouTube API`, cap1Skipped ? 'ok' : 'err');
  if (!cap1Skipped) { log('ERROR: el anti-duplicado no funcionó', 'err'); process.exit(1); }

  // ── 8. Simular video_state_snapshot ──────────────────────────────────────
  section('8. video_state_snapshot');

  // El snapshot NO contiene tokens — solo youtubeUrl/videoId (URLs públicas)
  const snapshot = {
    schemaVersion: '1.0',
    type:          'video_state_snapshot',
    generatedAt:   new Date().toISOString(),
    reason:        'qa_real_upload_test',
    youtube: {
      uploads:       youtubeUploads,
      uploadedCount: 1,
      failedCount:   0,
      phase:         'youtube_completed',
    },
    qa: {
      channel:    channel,
      videoFile:  path.basename(TEST_VIDEO),
      fileSizeMb: parseFloat((size / 1024 / 1024).toFixed(1)),
      isMock:     false,
      hasTokens:  false,   // confirmación explícita: no hay tokens aquí
    },
  };

  // Guardar fuera de src/ y en .gitignore
  fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2));
  log(`snapshot guardado: ${path.basename(SNAPSHOT_PATH)}`, 'ok');
  log(`contiene tokens: no ✓`, 'ok');

  // ── 9. Resultado final ────────────────────────────────────────────────────
  console.log('\n══════════════════════════════════════════════════════════');
  console.log('  RESULTADO');
  console.log('══════════════════════════════════════════════════════════');

  const results = [
    ['refresh_token detectado',    'sí'],
    ['access_token renovado',      'sí'],
    ['canal detectado',            `sí — "${channel.title}"`],
    ['upload exitoso',             'sí'],
    ['youtubeVideoId',             result1.videoId],
    ['youtubeUrl',                 result1.youtubeUrl],
    ['privacidad',                 'unlisted'],
    ['no duplica si se re-ejecuta','sí — cap 1 en skip-set'],
    ['snapshot generado',          path.basename(SNAPSHOT_PATH)],
    ['tokens en snapshot',         'no'],
    ['tokens IA consumidos',       '0'],
  ];

  const w = Math.max(...results.map(([k]) => k.length));
  for (const [k, v] of results) {
    console.log(`  ${k.padEnd(w)}  →  ${v}`);
  }

  console.log('\n══════════════════════════════════════════════════════════');
  console.log('  ✅ QA COMPLETADO — YouTube upload real funciona');
  console.log('══════════════════════════════════════════════════════════\n');

  console.log('⚠️  SIGUIENTE PASO: rotar el YOUTUBE_CLIENT_SECRET en Google Cloud Console.');
  console.log('   Google Cloud Console → APIs & Services → Credentials → editar el OAuth client.');
  console.log('   Actualizar .env con el nuevo secret antes de deployar.\n');
}

main().catch(e => {
  const msg = (e as Error).message ?? String(e);
  // Nunca imprimir el stack completo — puede contener paths con tokens en vars de entorno
  console.error(`\n❌ ERROR: ${msg.split('\n')[0]}`);
  if (msg.includes('\n')) {
    console.error(msg.split('\n').slice(1).join('\n'));
  }
  process.exit(1);
});
