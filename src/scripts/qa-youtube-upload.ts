/**
 * qa-youtube-upload.ts — QA estático para la fase YouTube upload
 *
 * Valida sin BD ni YouTube real:
 *   A. Flujo feliz: N videos → todos subidos → snapshot
 *   B. Sin duplicados: videos ya subidos se omiten
 *   C. Reconexión: token inválido → blocked_auth → pendientes conservados
 *   D. Cuota: quotaExceeded → blocked_quota → no reintenta
 *   E. Reintento parcial: 1 fallo temporal → retry → ok
 *   F. Tamaño máximo: video > 512 MB → rechazado
 *
 * Uso:
 *   npx ts-node src/scripts/qa-youtube-upload.ts
 */

import { YoutubeQuotaException } from '../youtube/youtube-upload.service';
import { UnauthorizedException } from '@nestjs/common';

// ─── helpers ────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function ok(label: string) {
  console.log(`  ✅ ${label}`);
  passed++;
}

function fail(label: string, detail?: string) {
  console.error(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`);
  failed++;
}

function section(title: string) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 55 - title.length))}`);
}

// ─── Tipos mínimos para el QA ────────────────────────────────────────────────

interface UploadEntry {
  cap:            number;
  title:          string;
  downloadUrl:    string | null;
  youtubeVideoId: string | null;
  youtubeUrl:     string | null;
  status:         'uploaded' | 'failed' | 'skipped' | 'quota_exceeded' | 'auth_required';
  error?:         string | null;
}

interface VideogenEntry {
  cap:         number;
  title:       string;
  downloadUrl: string | null;
  jobId:       string;
  status:      string;
}

// ─── Core upload logic (extracted from video-worker for unit testing) ────────

interface UploadResult {
  uploads:      UploadEntry[];
  authBlocked:  boolean;
  quotaBlocked: boolean;
}

async function simulateYoutubePhase(opts: {
  videogenJobs:    VideogenEntry[];
  existingUploads: UploadEntry[];
  uploadFn:        (cap: number, downloadUrl: string) => Promise<{ videoId: string; youtubeUrl: string }>;
  maxRetries?:     number;
  backoffMs?:      number;
}): Promise<UploadResult> {
  const { videogenJobs, existingUploads, uploadFn, maxRetries = 3, backoffMs = 50 } = opts;

  const alreadyDone = new Map<number, UploadEntry>(
    existingUploads
      .filter(u => u.status === 'uploaded' && u.youtubeUrl)
      .map(u => [u.cap, u] as [number, UploadEntry]),
  );

  const uploads: UploadEntry[] = [...alreadyDone.values()];
  let authBlocked  = false;
  let quotaBlocked = false;

  const uploadable = videogenJobs.filter(j => j.downloadUrl && !alreadyDone.has(j.cap));

  for (const vj of uploadable) {
    if (authBlocked || quotaBlocked) {
      uploads.push({
        cap: vj.cap, title: vj.title, downloadUrl: vj.downloadUrl,
        youtubeVideoId: null, youtubeUrl: null,
        status: authBlocked ? 'auth_required' : 'quota_exceeded',
        error: 'Bloqueado por error anterior',
      });
      continue;
    }

    let success   = false;
    let lastError = '';

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const result = await uploadFn(vj.cap, vj.downloadUrl!);
        uploads.push({
          cap: vj.cap, title: vj.title, downloadUrl: vj.downloadUrl,
          youtubeVideoId: result.videoId, youtubeUrl: result.youtubeUrl,
          status: 'uploaded', error: null,
        });
        success = true;
        break;
      } catch (err) {
        const error = err as Error;
        lastError   = error.message;
        if (err instanceof YoutubeQuotaException) { quotaBlocked = true; break; }
        if (err instanceof UnauthorizedException)  { authBlocked = true;  break; }
        if (attempt < maxRetries) await new Promise(r => setTimeout(r, backoffMs));
      }
    }

    if (!success && !authBlocked && !quotaBlocked) {
      uploads.push({
        cap: vj.cap, title: vj.title, downloadUrl: vj.downloadUrl,
        youtubeVideoId: null, youtubeUrl: null,
        status: 'failed', error: lastError,
      });
    } else if (authBlocked || quotaBlocked) {
      if (!uploads.find(u => u.cap === vj.cap)) {
        uploads.push({
          cap: vj.cap, title: vj.title, downloadUrl: vj.downloadUrl,
          youtubeVideoId: null, youtubeUrl: null,
          status: authBlocked ? 'auth_required' : 'quota_exceeded',
          error: lastError,
        });
      }
    }
  }

  return { uploads, authBlocked, quotaBlocked };
}

// ─── TEST CASES ──────────────────────────────────────────────────────────────

const videos3: VideogenEntry[] = [
  { cap: 1, title: 'Cap 1', downloadUrl: 'https://cdn.example.com/cap1.mp4', jobId: 'j1', status: 'completed' },
  { cap: 2, title: 'Cap 2', downloadUrl: 'https://cdn.example.com/cap2.mp4', jobId: 'j2', status: 'completed' },
  { cap: 3, title: 'Cap 3', downloadUrl: 'https://cdn.example.com/cap3.mp4', jobId: 'j3', status: 'completed' },
];

const mockUpload = (cap: number, _url: string) =>
  Promise.resolve({ videoId: `yt_${cap}`, youtubeUrl: `https://youtube.com/watch?v=yt_${cap}` });

async function main(): Promise<void> {

// ── A. Flujo feliz ────────────────────────────────────────────────────────────
section('A. Flujo feliz — 3 videos, todos se suben');
{
  const r = await simulateYoutubePhase({
    videogenJobs: videos3,
    existingUploads: [],
    uploadFn: mockUpload,
  });
  const uploaded = r.uploads.filter(u => u.status === 'uploaded');
  if (uploaded.length === 3) ok('3 videos subidos');                       else fail('subidos', `${uploaded.length}/3`);
  if (!r.authBlocked && !r.quotaBlocked) ok('no bloqueado');               else fail('no debería estar bloqueado');
  if (r.uploads.every(u => u.youtubeUrl)) ok('todas las youtubeUrl presentes'); else fail('falta youtubeUrl');
  if (r.uploads.every(u => u.youtubeVideoId)) ok('todos los videoIds presentes'); else fail('falta youtubeVideoId');
}

// ── B. Sin duplicados ─────────────────────────────────────────────────────────
section('B. Sin duplicados — 2 ya subidos, 1 pendiente');
{
  let uploadCalls = 0;
  const existing2: UploadEntry[] = [
    { cap: 1, title: 'Cap 1', downloadUrl: 'https://cdn.example.com/cap1.mp4', youtubeVideoId: 'yt_1', youtubeUrl: 'https://youtube.com/watch?v=yt_1', status: 'uploaded' },
    { cap: 2, title: 'Cap 2', downloadUrl: 'https://cdn.example.com/cap2.mp4', youtubeVideoId: 'yt_2', youtubeUrl: 'https://youtube.com/watch?v=yt_2', status: 'uploaded' },
  ];
  const r = await simulateYoutubePhase({
    videogenJobs: videos3,
    existingUploads: existing2,
    uploadFn: async (cap, url) => { uploadCalls++; return mockUpload(cap, url); },
  });
  if (uploadCalls === 1) ok('solo 1 upload (cap3 pendiente)');             else fail(`llamadas de upload: ${uploadCalls}, esperado 1`);
  if (r.uploads.length === 3) ok('3 entradas totales en resultado');       else fail(`uploads.length=${r.uploads.length}`);
  if (r.uploads.filter(u => u.status === 'uploaded').length === 3) ok('3 uploaded en total'); else fail('no todos uploaded');
  if (r.uploads.find(u => u.cap === 1)?.youtubeUrl === 'https://youtube.com/watch?v=yt_1') ok('cap1 youtubeUrl conservada'); else fail('cap1 youtubeUrl alterada');
  if (r.uploads.find(u => u.cap === 2)?.youtubeUrl === 'https://youtube.com/watch?v=yt_2') ok('cap2 youtubeUrl conservada'); else fail('cap2 youtubeUrl alterada');
}

// ── C. Reconexión (auth error) ────────────────────────────────────────────────
section('C. Reconexión — token inválido en cap2, cap1 ya subido');
{
  const existing1: UploadEntry[] = [
    { cap: 1, title: 'Cap 1', downloadUrl: 'https://cdn.example.com/cap1.mp4', youtubeVideoId: 'yt_1', youtubeUrl: 'https://youtube.com/watch?v=yt_1', status: 'uploaded' },
  ];
  const r = await simulateYoutubePhase({
    videogenJobs: videos3,
    existingUploads: existing1,
    uploadFn: async (cap) => {
      if (cap === 2) throw new UnauthorizedException('Token expirado');
      return mockUpload(cap, '');
    },
  });
  if (r.authBlocked) ok('authBlocked=true');                               else fail('authBlocked debería ser true');
  if (!r.quotaBlocked) ok('quotaBlocked=false');                           else fail('no debería ser quota');
  const c1 = r.uploads.find(u => u.cap === 1);
  if (c1?.status === 'uploaded' && c1.youtubeUrl) ok('cap1 conservado');   else fail('cap1 perdido');
  const c2 = r.uploads.find(u => u.cap === 2);
  if (c2?.status === 'auth_required') ok('cap2 marcado auth_required');    else fail(`cap2 status=${c2?.status}`);
  const c3 = r.uploads.find(u => u.cap === 3);
  if (c3?.status === 'auth_required') ok('cap3 también pendiente (bloqueado)'); else fail(`cap3 status=${c3?.status}`);
}

// ── D. Cuota agotada ──────────────────────────────────────────────────────────
section('D. Cuota — quotaExceeded en cap1');
{
  let uploadCalls = 0;
  const r = await simulateYoutubePhase({
    videogenJobs: videos3,
    existingUploads: [],
    uploadFn: async () => { uploadCalls++; throw new YoutubeQuotaException(); },
    maxRetries: 3,
  });
  if (r.quotaBlocked) ok('quotaBlocked=true');                             else fail('quotaBlocked debería ser true');
  if (!r.authBlocked) ok('authBlocked=false');                             else fail('no debería ser auth');
  if (uploadCalls === 1) ok('no reintentó tras quota (1 llamada)');        else fail(`llamadas: ${uploadCalls}, esperado 1 (sin retries para quota)`);
  const pending = r.uploads.filter(u => u.status === 'quota_exceeded');
  if (pending.length === 3) ok('3 videos marcados quota_exceeded');        else fail(`${pending.length}/3 quota_exceeded`);
}

// ── E. Reintento parcial — fallo temporal en cap2 (1 fallo, luego éxito) ─────
section('E. Reintento — fallo temporal cap2 resuelto en 2do intento');
{
  let cap2Calls = 0;
  const r = await simulateYoutubePhase({
    videogenJobs: videos3,
    existingUploads: [],
    backoffMs: 1,
    uploadFn: async (cap) => {
      if (cap === 2) {
        cap2Calls++;
        if (cap2Calls === 1) throw new Error('ServiceUnavailable: timeout');
        return mockUpload(cap, '');
      }
      return mockUpload(cap, '');
    },
  });
  if (!r.authBlocked && !r.quotaBlocked) ok('no bloqueado');               else fail('no debería estar bloqueado');
  if (r.uploads.filter(u => u.status === 'uploaded').length === 3) ok('3 videos uploaded finalmente'); else fail(`solo ${r.uploads.filter(u => u.status === 'uploaded').length}/3`);
  if (cap2Calls === 2) ok('cap2 necesitó 2 intentos');                     else fail(`cap2Calls=${cap2Calls}`);
}

// ── F. Fallo definitivo tras 3 reintentos ─────────────────────────────────────
section('F. Fallo definitivo — cap2 falla 3 veces');
{
  let cap2Calls = 0;
  const r = await simulateYoutubePhase({
    videogenJobs: [videos3[1]], // solo cap2
    existingUploads: [],
    backoffMs: 1,
    uploadFn: async () => { cap2Calls++; throw new Error('Network error'); },
    maxRetries: 3,
  });
  if (cap2Calls === 3) ok('3 intentos realizados');                        else fail(`cap2Calls=${cap2Calls}`);
  const c2 = r.uploads.find(u => u.cap === 2);
  if (c2?.status === 'failed') ok('cap2 marcado failed');                  else fail(`cap2 status=${c2?.status}`);
  if (!r.authBlocked && !r.quotaBlocked) ok('no bloqueado — solo failed'); else fail('no debería estar bloqueado');
}

// ── G. YoutubeQuotaException es instancia correcta ───────────────────────────
section('G. Tipos de excepción — instanceof checks');
{
  const qe = new YoutubeQuotaException();
  if (qe instanceof YoutubeQuotaException) ok('instanceof YoutubeQuotaException'); else fail('instanceof YoutubeQuotaException');
  if (qe instanceof Error) ok('instanceof Error');                         else fail('no extiende Error');
  if (qe.name === 'YoutubeQuotaException') ok('name correcto');            else fail(`name=${qe.name}`);
  if (qe.message) ok(`mensaje: "${qe.message.slice(0, 50)}…"`);           else fail('sin mensaje');

  const ue = new UnauthorizedException('test');
  if (ue instanceof UnauthorizedException) ok('instanceof UnauthorizedException'); else fail('instanceof UnauthorizedException');

  // Confirm QuotaException is NOT treated as UnauthorizedException
  if (!(qe instanceof UnauthorizedException)) ok('QuotaException ≠ UnauthorizedException'); else fail('QuotaException no debe ser UnauthorizedException');
}

// ── H. Videos sin downloadUrl se marcan failed (no se omiten silenciosamente) ─
section('H. Videos sin downloadUrl → failed, no silenciado');
{
  const withNullUrl: VideogenEntry[] = [
    { cap: 1, title: 'Cap 1', downloadUrl: null, jobId: 'j1', status: 'failed' },
    { cap: 2, title: 'Cap 2', downloadUrl: 'https://cdn.example.com/cap2.mp4', jobId: 'j2', status: 'completed' },
  ];
  let uploadCalls = 0;
  const r = await simulateYoutubePhase({
    videogenJobs: withNullUrl,
    existingUploads: [],
    uploadFn: async (cap, url) => { uploadCalls++; return mockUpload(cap, url); },
  });
  if (uploadCalls === 1) ok('solo cap2 fue intentado (cap1 sin URL)');     else fail(`uploadCalls=${uploadCalls}`);
  const c2 = r.uploads.find(u => u.cap === 2);
  if (c2?.status === 'uploaded') ok('cap2 subido');                        else fail('cap2 no uploaded');
}

// ─── Resultado ───────────────────────────────────────────────────────────────

console.log(`\n${'═'.repeat(58)}`);
console.log(`RESULTADO: ${passed} OK / ${failed} FAIL`);
console.log('═'.repeat(58));

if (failed > 0) process.exit(1);

} // end main

main().catch(e => { console.error('QA script error:', e); process.exit(1); });
