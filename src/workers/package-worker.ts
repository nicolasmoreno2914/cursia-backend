import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { ArtifactsService } from '../modules/artifacts/artifacts.service';
import { Artifact } from '../modules/artifacts/entities/artifact.entity';
import { ProductionJobsService } from '../modules/production-jobs/production-jobs.service';
import { ProductionJob } from '../modules/production-jobs/entities/production-job.entity';
import { MbzBuilderService, HvpEntry, MbzBuildResult } from '../package/mbz-builder.service';
import { EventsService } from '../events/events.service';
import * as JSZip from 'jszip';
import { createHash as nodeCrypto_createHash } from 'crypto';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function readPositiveInt(envKey: string, fallback: number): number {
  const raw = Number(process.env[envKey] ?? fallback);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

function isTrueEnv(envKey: string): boolean {
  return String(process.env[envKey] || '').toLowerCase() === 'true';
}

// ─────────────────────────────────────────────────────────────────────────────
// Artifact download helpers
// ─────────────────────────────────────────────────────────────────────────────

async function downloadArtifactJson(
  artifactsService: ArtifactsService,
  ownerId: string,
  artifactId: string,
  logger: Logger,
): Promise<Record<string, any> | null> {
  try {
    const urlRes = await artifactsService.getDownloadUrl(artifactId, ownerId, 3600);
    const url    = urlRes.url;
    if (!url) { logger.warn(`[PackageWorker] No URL for artifact ${artifactId}`); return null; }
    const res = await fetch(url);
    if (!res.ok) { logger.warn(`[PackageWorker] Artifact ${artifactId} download HTTP ${res.status}`); return null; }
    return res.json() as Promise<Record<string, any>>;
  } catch (e) {
    logger.warn(`[PackageWorker] Artifact ${artifactId} download error: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

async function downloadArtifactBuffer(
  artifactsService: ArtifactsService,
  ownerId: string,
  artifactId: string,
  logger: Logger,
): Promise<Buffer | null> {
  try {
    const urlRes = await artifactsService.getDownloadUrl(artifactId, ownerId, 3600);
    const url    = urlRes.url;
    if (!url) return null;
    const res = await fetch(url);
    if (!res.ok) return null;
    const ab = await res.arrayBuffer();
    return Buffer.from(ab);
  } catch (e) {
    logger.warn(`[PackageWorker] Buffer artifact ${artifactId} error: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

async function findExistingMbzFinalArtifact(
  artifactsService: ArtifactsService,
  ownerId: string,
  courseId: string,
): Promise<Artifact | null> {
  try {
    const list = await artifactsService.findAll(ownerId, { courseId, type: 'mbz_final' });
    if (!list?.length) return null;
    list.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    const candidate = list[0];
    if (candidate.sizeBytes !== null && candidate.sizeBytes <= 0) return null;
    return candidate;
  } catch { return null; }
}

// ─────────────────────────────────────────────────────────────────────────────
// Fase 3.1 — Deep MBZ content validation
// ─────────────────────────────────────────────────────────────────────────────

const EMPTY_SHA1 = 'da39a3ee5e6b4b0d3255bfef95601890afd80709';
const MIN_SIZE_BYTES = 50_000;

// ── Interfaces ────────────────────────────────────────────────────────────────

interface MbzActivityCounts {
  // Structural
  sections:        number;
  h5p:             number;
  scorm:           number;
  quiz:            number;
  label:           number;
  page:            number;
  forum:           number;
  totalActivities: number;
  totalFiles:      number;
  // Quiz depth
  questionsTotal:      number;
  quizWithQuestions:   number;
  quizEmpty:           number;
  // H5P depth
  h5pWithVideo:        number;
  h5pWithInteractions: number;
  h5pEmpty:            number;
  // SCORM depth
  scormWithPackage:    number;
  scormWithQuestions:  number;
  scormPlaceholder:    number;
  scormEmpty:          number;
  // Sentinel scan
  sentinelsFound:      number;
  // Dynamic profile
  expectedChapters:    number;
  expectedScorm:       number;
  expectedQuizzes:     number;
  expectedQuestionsMin: number;
  validationProfile:   string;
}

interface MbzValidationResult {
  status:   'passed' | 'warning' | 'failed';
  errors:   string[];
  warnings: string[];
  counts:   MbzActivityCounts;
  checksumSha256: string;
}

// ── Profile: dynamic thresholds from courseData ────────────────────────────────

interface ValidationProfile {
  profile:             'standard_9_chapter' | 'small_course' | 'unknown_legacy';
  chapters:            number;
  modules:             number;
  expectedScorm:       number;
  expectedH5p:         number;
  expectedQuizzes:     number;
  expectedQuestionsMin: number;
  minScormFail:        number;
  minQuizFail:         number;
  minActivitiesFail:   number;
  minSectionsFail:     number;
}

function computeValidationProfile(courseData: Record<string, any>): ValidationProfile {
  const caps    = Array.isArray(courseData.caps) ? courseData.caps : [];
  const mods    = Array.isArray(courseData.mods) ? courseData.mods : [];
  const chapters = caps.length > 0 ? caps.length
                 : mods.length > 0 ? mods.length * 3
                 : 9; // fallback for legacy
  const modules  = mods.length > 0 ? mods.length : Math.max(1, Math.ceil(chapters / 3));

  const expectedScorm       = chapters;
  const expectedH5p         = chapters;
  const expectedQuizzes     = modules + 1;                         // per-module + final
  const expectedQuestionsMin = modules * 8 + 15;                   // 8/module + 15 final (generous min)

  const profile: ValidationProfile['profile'] = chapters <= 4
    ? 'small_course'
    : chapters >= 9 ? 'standard_9_chapter'
    : 'unknown_legacy';

  return {
    profile,
    chapters,
    modules,
    expectedScorm,
    expectedH5p,
    expectedQuizzes,
    expectedQuestionsMin,
    minScormFail:      Math.max(1, Math.ceil(expectedScorm    * 0.5)),
    minQuizFail:       Math.max(1, Math.ceil(expectedQuizzes  * 0.5)),
    minActivitiesFail: Math.max(10, chapters * 3),
    minSectionsFail:   Math.max(3,  modules  + 2),
  };
}

// ── Sentinel scan ──────────────────────────────────────────────────────────────
// Scans activity XML files for content artifacts that must not appear in a
// final Moodle backup (unresolved sentinels, temporary Moodle URLs, etc.).

async function scanForSentinels(zip: JSZip): Promise<{ errors: string[]; warnings: string[]; found: number }> {
  const errors:   string[] = [];
  const warnings: string[] = [];
  let found = 0;

  // Only scan primary activity files — skip auxiliary XMLs that are boilerplate
  const AUX_SUFFIXES = new Set([
    '/roles.xml','/calendar.xml','/grade_history.xml','/competencies.xml',
    '/filters.xml','/completion.xml','/comments.xml','/xapistate.xml',
    '/posts.xml','/subscribers.xml','/discussions.xml',
  ]);
  const paths = Object.keys(zip.files).filter(p => {
    if (zip.files[p].dir) return false;
    if (!p.startsWith('activities/')) return false;
    if (!p.endsWith('.xml')) return false;
    return !AUX_SUFFIXES.has(p.substring(p.lastIndexOf('/')));
  });

  let hvpSentinelCount   = 0;
  let draftfileCount     = 0;
  let objectObjectCount  = 0;
  let localhostCount     = 0;

  for (const p of paths) {
    let text: string;
    try { text = await zip.files[p].async('text'); } catch { continue; }
    if (/<!--\s*HVP:\d+\s*-->/.test(text))          { hvpSentinelCount++;  found++; }
    if (/draftfile\.php/.test(text))                 { draftfileCount++;   found++; }
    if (/\[object Object\]/.test(text))              { objectObjectCount++; found++; }
    if (/127\.0\.0\.1|localhost(?:[\/:])/.test(text)){ localhostCount++;   found++; }
  }

  if (hvpSentinelCount  > 0) errors  .push(`Sentinel HVP sin reemplazar en ${hvpSentinelCount} actividad(es) — H5P no inyectado`);
  if (draftfileCount    > 0) errors  .push(`URL temporal draftfile.php en ${draftfileCount} actividad(es) — no funciona en export`);
  if (objectObjectCount > 0) errors  .push(`"[object Object]" visible en ${objectObjectCount} actividad(es) — error de serialización`);
  if (localhostCount    > 0) warnings.push(`URL local (localhost/127.0.0.1) en ${localhostCount} actividad(es)`);

  return { errors, warnings, found };
}

// ── Quiz question depth ────────────────────────────────────────────────────────
// Counts actual question_instance entries per quiz to catch empty quizzes.

async function validateQuizDepth(
  zip: JSZip,
  profile: ValidationProfile,
): Promise<{ questionsTotal: number; quizWithQuestions: number; quizEmpty: number; errors: string[]; warnings: string[] }> {
  const errors:   string[] = [];
  const warnings: string[] = [];
  let questionsTotal   = 0;
  let quizWithQuestions = 0;
  let quizEmpty         = 0;

  const quizPaths = Object.keys(zip.files).filter(
    p => !zip.files[p].dir && /^activities\/quiz_\d+\/quiz\.xml$/.test(p),
  );

  for (const qp of quizPaths) {
    let text: string;
    try { text = await zip.files[qp].async('text'); } catch { continue; }
    const count = (text.match(/<question_instance id="/g) || []).length;
    if (count === 0) {
      quizEmpty++;
    } else {
      quizWithQuestions++;
      questionsTotal += count;
    }
  }

  if (quizEmpty > 0) {
    errors.push(`${quizEmpty} quiz(zes) sin preguntas — evalución vacía no es válida`);
  }
  if (questionsTotal < profile.expectedQuestionsMin && questionsTotal > 0) {
    warnings.push(
      `Preguntas totales: ${questionsTotal} (mínimo esperado ${profile.expectedQuestionsMin} para ${profile.profile})`,
    );
  }
  if (questionsTotal < Math.floor(profile.expectedQuestionsMin * 0.5) && questionsTotal > 0) {
    errors.push(
      `Preguntas totales muy bajas: ${questionsTotal} (fallando con menos del 50% del mínimo ${profile.expectedQuestionsMin})`,
    );
  }

  return { questionsTotal, quizWithQuestions, quizEmpty, errors, warnings };
}

// ── H5P content depth ────────────────────────────────────────────────────────
// Parses <json_content> inside hvp.xml to verify video URL and interactions.

async function validateH5PDepth(
  zip: JSZip,
): Promise<{ h5pWithVideo: number; h5pWithInteractions: number; h5pEmpty: number; errors: string[]; warnings: string[] }> {
  const errors:   string[] = [];
  const warnings: string[] = [];
  let h5pWithVideo        = 0;
  let h5pWithInteractions = 0;
  let h5pEmpty            = 0;

  const hvpPaths = Object.keys(zip.files).filter(
    p => !zip.files[p].dir && /^activities\/hvp_\d+\/hvp\.xml$/.test(p),
  );

  for (const hp of hvpPaths) {
    let text: string;
    try { text = await zip.files[hp].async('text'); } catch { continue; }

    const jcMatch = text.match(/<json_content>([\s\S]*?)<\/json_content>/);
    if (!jcMatch) { h5pEmpty++; continue; }

    // XML-unescape the JSON string
    const jsonText = jcMatch[1]
      .replace(/&amp;/g,  '&')
      .replace(/&lt;/g,   '<')
      .replace(/&gt;/g,   '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g,  "'");

    let hasVideo        = false;
    let hasInteractions = false;

    try {
      const hvpData = JSON.parse(jsonText) as Record<string, any>;
      const flat    = JSON.stringify(hvpData);

      // Detect YouTube or other video sources
      hasVideo = /https?:\/\/(?:www\.)?(?:youtube\.com\/watch|youtu\.be\/|vimeo\.com\/)/.test(flat);

      // Detect interactions array
      const iv = hvpData?.interactiveVideo ?? hvpData?.params?.interactiveVideo;
      const interactions = iv?.assets?.interactions ?? iv?.interactions ?? [];
      hasInteractions = Array.isArray(interactions) && interactions.length > 0;

    } catch { /* invalid JSON → treat as empty */ }

    if (!hasVideo && !hasInteractions) {
      h5pEmpty++;
    } else {
      if (hasVideo)        h5pWithVideo++;
      if (hasInteractions) h5pWithInteractions++;
    }
  }

  if (h5pEmpty > 0 && hvpPaths.length > 0) {
    const pct = Math.round(h5pEmpty / hvpPaths.length * 100);
    if (pct >= 50) {
      errors.push(`${h5pEmpty}/${hvpPaths.length} actividades H5P están vacías (${pct}%) — videos no generados correctamente`);
    } else {
      warnings.push(`${h5pEmpty}/${hvpPaths.length} actividades H5P sin video o interacciones`);
    }
  }

  return { h5pWithVideo, h5pWithInteractions, h5pEmpty, errors, warnings };
}

// ── SCORM package depth ────────────────────────────────────────────────────────
// Verifies each SCORM activity has a real package (non-empty SHA1 + file in ZIP).

async function validateScormDepth(
  zip: JSZip,
): Promise<{ scormWithPackage: number; scormWithQuestions: number; scormPlaceholder: number; scormEmpty: number; errors: string[]; warnings: string[] }> {
  const errors:   string[] = [];
  const warnings: string[] = [];
  let scormWithPackage  = 0;
  let scormWithQuestions = 0;
  let scormPlaceholder  = 0;
  let scormEmpty        = 0;

  const scormPaths = Object.keys(zip.files).filter(
    p => !zip.files[p].dir && /^activities\/scorm_\d+\/scorm\.xml$/.test(p),
  );

  for (const sp of scormPaths) {
    let text: string;
    try { text = await zip.files[sp].async('text'); } catch { continue; }

    const hashMatch = text.match(/<sha1hash>([^<]+)<\/sha1hash>/);
    const hash      = hashMatch ? hashMatch[1].trim() : '';

    if (!hash || hash === EMPTY_SHA1) {
      scormEmpty++;
      continue;
    }

    const pkgPath = `files/${hash.substring(0, 2)}/${hash}`;
    if (!zip.files[pkgPath]) {
      scormEmpty++;
      continue;
    }

    scormWithPackage++;

    // Inspect inner SCORM ZIP to detect real quiz vs placeholder
    try {
      const pkgData  = await zip.files[pkgPath].async('nodebuffer');
      const innerZip = await JSZip.loadAsync(pkgData);
      const indexFile = innerZip.files['index.html'];
      if (indexFile) {
        const indexHtml = await indexFile.async('text');
        const sizeBytes = Buffer.byteLength(indexHtml, 'utf8');
        const hasGameEngine = /scormEngine:game_v1/.test(indexHtml);
        const hasLegacyQuiz = /scormEngine:quiz_v1/.test(indexHtml);
        const hasInteractions = /PREGUNTAS\s*=/.test(indexHtml) && /endGame|checkSala|checkSeq|checkCk/.test(indexHtml);
        const hasScoreTracking = /cmi\.core\.score\.raw/.test(indexHtml) && /passed|failed/.test(indexHtml);
        const isAutoComplete = /LMSSetValue\(['"]\S+['"]\s*,\s*['"]completed['"]/.test(indexHtml);
        if ((hasGameEngine || hasLegacyQuiz) && hasInteractions && hasScoreTracking && !isAutoComplete) {
          scormWithQuestions++;
        } else if (isAutoComplete || /Completar actividad/.test(indexHtml) || sizeBytes < 4000) {
          scormPlaceholder++;
        }
      }
    } catch {
      // Inner ZIP unreadable — package counted but content unknown
    }
  }

  if (scormEmpty > 0) {
    const pct = Math.round(scormEmpty / scormPaths.length * 100);
    if (pct >= 50) {
      errors.push(`${scormEmpty}/${scormPaths.length} SCORMs sin paquete binario (${pct}%) — actividades no funcionales`);
    } else {
      warnings.push(`${scormEmpty}/${scormPaths.length} SCORMs sin paquete binario`);
    }
  }
  if (scormPlaceholder > 0) {
    const pct = Math.round(scormPlaceholder / scormPaths.length * 100);
    const msg = `${scormPlaceholder}/${scormPaths.length} SCORMs son placeholder (sin motor interactivo real)`;
    if (pct >= 50) errors.push(msg); else warnings.push(msg);
  }

  return { scormWithPackage, scormWithQuestions, scormPlaceholder, scormEmpty, errors, warnings };
}

// ── Main validator ────────────────────────────────────────────────────────────

async function validateFinalMoodlePackage(
  buffer: Buffer,
  buildResult: MbzBuildResult,
  courseData: Record<string, any>,
  logger: Logger,
  mode: 'full' | 'base' = 'full',
): Promise<MbzValidationResult> {
  const errors:   string[] = [];
  const warnings: string[] = [];

  // Compute SHA-256 checksum of the MBZ buffer
  const checksumSha256 = nodeCrypto_createHash('sha256').update(buffer).digest('hex');

  // Determine expected counts from course structure
  const profile = computeValidationProfile(courseData);

  const counts: MbzActivityCounts = {
    sections: 0, h5p: 0, scorm: 0, quiz: 0, label: 0, page: 0, forum: 0,
    totalActivities: 0, totalFiles: 0,
    questionsTotal: 0, quizWithQuestions: 0, quizEmpty: 0,
    h5pWithVideo: 0, h5pWithInteractions: 0, h5pEmpty: 0,
    scormWithPackage: 0, scormWithQuestions: 0, scormPlaceholder: 0, scormEmpty: 0,
    sentinelsFound: 0,
    expectedChapters:    profile.chapters,
    expectedScorm:       profile.expectedScorm,
    expectedQuizzes:     profile.expectedQuizzes,
    expectedQuestionsMin: profile.expectedQuestionsMin,
    validationProfile:   profile.profile,
  };

  // ── Step 1: Basic checks ────────────────────────────────────────────────────
  if (!buildResult.hasMoodleBackupXml) {
    errors.push('moodle_backup.xml no encontrado en el paquete');
  }
  if (buildResult.sizeBytes < MIN_SIZE_BYTES) {
    errors.push(`Paquete demasiado pequeño: ${Math.round(buildResult.sizeBytes / 1024)} KB (mínimo ${Math.round(MIN_SIZE_BYTES / 1024)} KB)`);
  }

  // ── Step 2: ZIP inspection ──────────────────────────────────────────────────
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch (e) {
    errors.push(`ZIP inválido — no se puede abrir el paquete: ${e instanceof Error ? e.message : String(e)}`);
    return {
      status: 'failed', errors, warnings, counts, checksumSha256,
    };
  }

  counts.totalFiles = Object.keys(zip.files).filter(k => !zip.files[k].dir).length;

  if (!zip.files['files.xml']) {
    warnings.push('files.xml no encontrado en el paquete');
  }

  // Parse moodle_backup.xml for structural activity counts
  const backupFile = zip.files['moodle_backup.xml'];
  if (backupFile) {
    const xmlText = await backupFile.async('text');
    counts.sections = (xmlText.match(/<section id="/g) || []).length;
    const modMatches = xmlText.match(/<modulename>([^<]+)<\/modulename>/g) || [];
    for (const m of modMatches) {
      const name = m.replace(/<\/?modulename>/g, '').toLowerCase().trim();
      counts.totalActivities++;
      if      (name === 'hvp')   counts.h5p++;
      else if (name === 'scorm') counts.scorm++;
      else if (name === 'quiz')  counts.quiz++;
      else if (name === 'label') counts.label++;
      else if (name === 'page')  counts.page++;
      else if (name === 'forum') counts.forum++;
    }
  } else {
    errors.push('moodle_backup.xml ausente al inspeccionar estructura ZIP');
  }

  // ── Step 3: Structural thresholds (dynamic) ─────────────────────────────────
  if (counts.sections < profile.minSectionsFail) {
    warnings.push(`Secciones insuficientes: ${counts.sections} (mínimo ${profile.minSectionsFail} para perfil ${profile.profile})`);
  }
  if (counts.scorm < profile.minScormFail) {
    errors.push(`SCORMs insuficientes: ${counts.scorm}/${profile.expectedScorm} esperados (mínimo ${profile.minScormFail})`);
  } else if (counts.scorm < profile.expectedScorm) {
    warnings.push(`SCORMs incompletos: ${counts.scorm}/${profile.expectedScorm}`);
  }
  if (counts.quiz < profile.minQuizFail) {
    errors.push(`Quizzes insuficientes: ${counts.quiz}/${profile.expectedQuizzes} esperados (mínimo ${profile.minQuizFail})`);
  } else if (counts.quiz < profile.expectedQuizzes) {
    warnings.push(`Quizzes incompletos: ${counts.quiz}/${profile.expectedQuizzes}`);
  }
  if (counts.h5p === 0 && mode === 'full') {
    warnings.push('Sin actividades H5P — videos interactivos no incluidos');
  }
  if (counts.totalActivities < profile.minActivitiesFail) {
    errors.push(`Actividades totales insuficientes: ${counts.totalActivities} (mínimo ${profile.minActivitiesFail})`);
  }

  // ── Step 4: Sentinel scan ───────────────────────────────────────────────────
  const sentinelResult = await scanForSentinels(zip);
  errors.push(...sentinelResult.errors);
  warnings.push(...sentinelResult.warnings);
  counts.sentinelsFound = sentinelResult.found;

  // ── Step 5: Quiz question depth ─────────────────────────────────────────────
  const quizResult = await validateQuizDepth(zip, profile);
  errors.push(...quizResult.errors);
  warnings.push(...quizResult.warnings);
  counts.questionsTotal    = quizResult.questionsTotal;
  counts.quizWithQuestions = quizResult.quizWithQuestions;
  counts.quizEmpty         = quizResult.quizEmpty;

  // ── Step 6: H5P content depth (skipped in base mode) ───────────────────────
  if (counts.h5p > 0 && mode === 'full') {
    const h5pResult = await validateH5PDepth(zip);
    errors.push(...h5pResult.errors);
    warnings.push(...h5pResult.warnings);
    counts.h5pWithVideo        = h5pResult.h5pWithVideo;
    counts.h5pWithInteractions = h5pResult.h5pWithInteractions;
    counts.h5pEmpty            = h5pResult.h5pEmpty;
  }

  // ── Step 7: SCORM package depth ─────────────────────────────────────────────
  const scormResult = await validateScormDepth(zip);
  errors.push(...scormResult.errors);
  warnings.push(...scormResult.warnings);
  counts.scormWithPackage  = scormResult.scormWithPackage;
  counts.scormWithQuestions = scormResult.scormWithQuestions;
  counts.scormPlaceholder  = scormResult.scormPlaceholder;
  counts.scormEmpty        = scormResult.scormEmpty;

  // ── Step 8: Mock content detection (P3, skipped in base mode) ──────────────
  // Detects courses packaged with simulated video/YouTube URLs (dev/test mode).
  // Always a warning — never a blocking error — so mock courses can still be downloaded.
  if (mode === 'full') {
  const MOCK_URL_PATTERNS = [
    /youtube\.com\/watch\?v=mock_/i,
    /mock-cdn\.cursia\.local/i,
    /watch\?v=mock_cap\d/i,
  ];
  let mockActivityCount = 0;
  for (const [filename, file] of Object.entries(zip.files)) {
    if ((file as any).dir || !filename.startsWith('activities/')) continue;
    const content = await (file as any).async('text').catch(() => '');
    if (MOCK_URL_PATTERNS.some(re => re.test(content))) mockActivityCount++;
  }
  if (mockActivityCount > 0) {
    warnings.push(
      `Este curso usa videos simulados para pruebas. No es una versión final para estudiantes. ` +
      `(${mockActivityCount} actividad(es) con contenido mock)`
    );
  }
  } // end mode === 'full' mock scan

  // ── Determine status ─────────────────────────────────────────────────────────
  const status: 'passed' | 'warning' | 'failed' =
    errors.length   > 0 ? 'failed'  :
    warnings.length > 0 ? 'warning' :
    'passed';

  logger.log(
    `[PackageWorker] MBZ validation (F3.1) → ${status} [${profile.profile}] | ` +
    `sections=${counts.sections} scorm=${counts.scorm}(pkg:${counts.scormWithPackage},game:${counts.scormWithQuestions},ph:${counts.scormPlaceholder}) ` +
    `quiz=${counts.quiz}(q:${counts.questionsTotal}) ` +
    `h5p=${counts.h5p}(vid:${counts.h5pWithVideo},int:${counts.h5pWithInteractions}) ` +
    `sentinels=${counts.sentinelsFound} totalAct=${counts.totalActivities}` +
    (errors.length   ? ` | ERR: ${errors.join('; ')}`   : '') +
    (warnings.length ? ` | WARN: ${warnings.join('; ')}` : ''),
  );

  return { status, errors, warnings, counts, checksumSha256 };
}

// ─────────────────────────────────────────────────────────────────────────────
// Core job handler
// ─────────────────────────────────────────────────────────────────────────────

async function handlePackageJob(
  job: ProductionJob,
  jobsService: ProductionJobsService,
  artifactsService: ArtifactsService,
  mbzBuilder: MbzBuilderService,
  eventsService: EventsService,
  workerId: string,
  leaseSeconds: number,
  heartbeatMs: number,
  logger: Logger,
): Promise<void> {
  const jobId    = job.id;
  const payload  = (job.inputPayload ?? {}) as Record<string, any>;
  const rawCourseId = job.frontendCourseId || String(job.courseId ?? 'unknown');
  const options  = (payload.options ?? {}) as Record<string, any>;
  const parentJobId = payload?.metadata?.parentJobId ?? null;
  const isBaseMode = (job.executionMode ?? '') === 'backend_package_base';

  let leaseLost = false;
  let finalized = false;

  const sendHeartbeat = async () => {
    if (finalized || leaseLost) return;
    try {
      const ok = await jobsService.heartbeatWorkerJob(jobId, workerId, leaseSeconds);
      if (!ok) { leaseLost = true; logger.warn(`[PackageWorker] Lease lost for job ${jobId}`); }
    } catch { leaseLost = true; }
  };

  const heartbeatTimer = setInterval(() => { void sendHeartbeat(); }, heartbeatMs);

  const updateProgress = async (phase: string, message: string) => {
    if (leaseLost) return;
    await jobsService.updatePackageWorkerProgress(jobId, workerId, phase, message).catch(() => {});
  };

  const trackEvent = async (eventType: string, extra: Record<string, any> = {}) =>
    eventsService.trackBackendEvent({
      userId: job.ownerId,
      eventType,
      courseId: rawCourseId,
      jobId,
      parentJobId,
      component: 'package',
      provider: 'internal',
      model: 'mbz_builder_v1',
      mode: 'real',
      costType: extra.costType ?? 'unknown',
      estimatedCostUsd: extra.estimatedCostUsd,
      costSource: extra.costSource ?? 'not_tracked',
      units: extra.units,
      unitType: extra.unitType,
      failed: extra.failed ?? false,
      errorMessage: extra.errorMessage ?? null,
      metadata: {
        workerId,
        ...extra.metadata,
      },
    });

  try {
    const marked = await jobsService.markPackageWorkerRunning(jobId, workerId);
    if (!marked) { logger.warn(`[PackageWorker] Job ${jobId} no longer owned by ${workerId}`); return; }
    await trackEvent('package_generation_started', {
      units: 1,
      unitType: 'per_operation',
    });

    await sendHeartbeat();
    if (leaseLost) return;

    // ── Step 1: Restore-first — check existing artifact ─────────────────────
    await updateProgress('checking_existing_package', 'Verificando paquete existente…');

    if (!isBaseMode) {
      const existingMbz = await findExistingMbzFinalArtifact(artifactsService, job.ownerId, rawCourseId);
      if (existingMbz) {
        logger.log(`[PackageWorker] mbz_final artifact already exists (${existingMbz.id}) — marking completed`);
        finalized = true;
        await jobsService.completePackageWorkerJob(jobId, workerId, {
          mbzFinal: {
            status:     'skipped_existing',
            artifactId: existingMbz.id,
            sizeBytes:  existingMbz.sizeBytes,
            filename:   existingMbz.filename,
            humanMessage: 'Paquete Moodle ya guardado.',
          },
        });
        return;
      }
    }

    // ── Step 2: Download required artifacts ──────────────────────────────────
    await updateProgress('preparing_package', 'Descargando datos del curso…');

    const contentSnapshotId   = payload.contentSnapshotArtifactId as string;
    const h5pSnapshotId       = payload.h5pSnapshotArtifactId    as string | null ?? null;
    const audioWelcomeId      = payload.audioWelcomeArtifactId   as string | null ?? null;
    const audiobookId         = payload.audiobookArtifactId       as string | null ?? null;

    if (!contentSnapshotId) {
      throw new Error('contentSnapshotArtifactId is required but missing from job payload');
    }

    const contentSnapshot = await downloadArtifactJson(artifactsService, job.ownerId, contentSnapshotId, logger);
    if (!contentSnapshot) throw new Error('No se pudo descargar el contenido del curso');

    const D = contentSnapshot.D as Record<string, any> ?? {};
    const F = contentSnapshot.F as Record<string, string> ?? {};
    if (!Object.keys(F).length) throw new Error('El contenido del curso está vacío — regenera el contenido');

    await sendHeartbeat();
    if (leaseLost) return;

    // H5P data (optional, skipped in base mode)
    let hvpData: Record<number, HvpEntry> | undefined;
    if (h5pSnapshotId && !isBaseMode) {
      const h5pSnapshot = await downloadArtifactJson(artifactsService, job.ownerId, h5pSnapshotId, logger);
      if (h5pSnapshot?.MEDIA_HVP && typeof h5pSnapshot.MEDIA_HVP === 'object') {
        hvpData = {} as Record<number, HvpEntry>;
        for (const [k, v] of Object.entries(h5pSnapshot.MEDIA_HVP as Record<string, any>)) {
          const capN = parseInt(k);
          if (!isNaN(capN) && v && typeof v === 'object') {
            hvpData[capN] = v as HvpEntry;
          }
        }
        logger.log(`[PackageWorker] H5P data loaded: ${Object.keys(hvpData).length} caps`);
      }
    }

    // Audio buffers (optional, skipped in base mode)
    let audioWelcome: Buffer | null = null;
    let audiobook:    Buffer | null = null;
    if (!isBaseMode) {
      if (audioWelcomeId) {
        audioWelcome = await downloadArtifactBuffer(artifactsService, job.ownerId, audioWelcomeId, logger);
        if (audioWelcome) logger.log(`[PackageWorker] Welcome audio: ${audioWelcome.length} bytes`);
      }
      if (audiobookId) {
        audiobook = await downloadArtifactBuffer(artifactsService, job.ownerId, audiobookId, logger);
        if (audiobook) logger.log(`[PackageWorker] Audiobook: ${audiobook.length} bytes`);
      }
    }

    await sendHeartbeat();
    if (leaseLost) return;

    // ── Step 3: Build MBZ ────────────────────────────────────────────────────
    await updateProgress('preparing_package', 'Preparando paquete Moodle…');
    logger.log(`[PackageWorker] Building MBZ for job ${jobId}: F=${Object.keys(F).length} files, hvp=${Object.keys(hvpData ?? {}).length} caps`);

    const buildResult = await mbzBuilder.buildMbz({
      courseData:    D,
      courseFiles:   F,
      audioWelcome,
      audiobook,
      hvpData,
      moodleVersion: options.moodleVersion ?? '4.1',
    });

    if (leaseLost) return;

    // ── Step 4: Validate (basic + deep) ─────────────────────────────────────
    await updateProgress('validating_package', 'Validando paquete Moodle…');

    if (!buildResult.buffer?.length) {
      throw new Error('El paquete generado está vacío — no se pudo construir el ZIP Moodle');
    }

    logger.log(`[PackageWorker] MBZ built: ${buildResult.filename}, ${buildResult.sizeBytes} bytes, ${buildResult.activityCount} activities`);

    // Deep quality validation — counts SCORM, quizzes, sections, H5P, sentinels
    const validation = await validateFinalMoodlePackage(buildResult.buffer, buildResult, D, logger, isBaseMode ? 'base' : 'full');

    if (validation.status === 'failed') {
      const errSummary = validation.errors.join(' | ');
      throw new Error(`Paquete Moodle no pasa criterios mínimos de calidad: ${errSummary}`);
    }

    if (validation.status === 'warning') {
      logger.warn(`[PackageWorker] MBZ validation warnings for job ${jobId}: ${validation.warnings.join(' | ')}`);
    }

    // ── Step 5: Upload mbz_final artifact ────────────────────────────────────
    await updateProgress('uploading_package', 'Guardando paquete Moodle…');
    await sendHeartbeat();
    if (leaseLost) {
      logger.warn(`[PackageWorker] Skipping mbz_final upload for job ${jobId} because the job was cancelled`);
      return;
    }

    const courseName  = String(D.nombre ?? 'curso').replace(/[^a-zA-Z0-9_\-]/g, '_');
    const timestamp   = new Date().toISOString().replace(/[:.]/g, '-');
    const fileSuffix  = isBaseMode ? 'base' : 'final';
    const filename    = `${courseName}_${fileSuffix}_${timestamp}.mbz`;
    const storagePath = `${job.ownerId}/${rawCourseId}/package/${filename}`;

    const artifact = await artifactsService.uploadBufferArtifact({
      ownerId:    job.ownerId,
      courseId:   rawCourseId,
      jobId:      jobId,
      type:       isBaseMode ? 'mbz_content_base' : 'mbz_final',
      filename,
      storagePath,
      buffer:     buildResult.buffer,
      mimeType:   'application/vnd.moodle.backup',
      metadata: {
        completionLevel:    'complete',
        validationOk:       true,
        validationStatus:   validation.status,
        validationErrors:   validation.errors,
        validationWarnings: validation.warnings,
        counts:             validation.counts,
        checksumSha256:     validation.checksumSha256,
        validatedAt:        new Date().toISOString(),
        validatorVersion:   '3.1',
        validationProfile:  validation.counts.validationProfile,
        expectedCounts: {
          chapters:     validation.counts.expectedChapters,
          scorm:        validation.counts.expectedScorm,
          quizzes:      validation.counts.expectedQuizzes,
          questionsMin: validation.counts.expectedQuestionsMin,
        },
        generatedBy:     isBaseMode ? 'backend_package_base' : 'backend_package',
        workerVersion:   '3.1',
        activityCount:   buildResult.activityCount,
        hasH5P:          Object.keys(hvpData ?? {}).length > 0,
        hasWelcomeAudio: !!audioWelcome,
        hasAudiobook:    !!audiobook,
        courseName:      D.nombre ?? null,
        filename:        buildResult.filename,
        generatedAt:     new Date().toISOString(),
      },
      storageBucket:   'cursia-artifacts',
      storageProvider: 'supabase',
    });

    if (leaseLost) return;

    await sendHeartbeat();
    if (leaseLost) return;

    finalized = true;
    const outputKey = isBaseMode ? 'mbzBase' : 'mbzFinal';
    const humanMsg  = validation.status === 'warning'
      ? `Paquete Moodle listo con advertencias: ${validation.warnings[0] ?? ''}`
      : isBaseMode ? 'Curso base listo.' : 'Paquete Moodle listo.';
    const completed = await jobsService.completePackageWorkerJob(jobId, workerId, {
      [outputKey]: {
        status:            'completed',
        artifactId:        artifact.id,
        sizeBytes:         buildResult.sizeBytes,
        filename:          buildResult.filename,
        activityCount:     buildResult.activityCount,
        validationStatus:  validation.status,
        validationWarnings: validation.warnings,
        humanMessage:      humanMsg,
      },
    });

    if (!completed) logger.warn(`[PackageWorker] Job ${jobId} could not be completed — ownership changed`);
    else {
      await trackEvent('package_generation_completed', {
        units: buildResult.sizeBytes,
        unitType: 'bytes',
        metadata: {
          artifactId: artifact.id,
          sizeBytes: buildResult.sizeBytes,
          activityCount: buildResult.activityCount,
          hasH5P: Object.keys(hvpData ?? {}).length > 0,
          hasWelcomeAudio: !!audioWelcome,
          hasAudiobook: !!audiobook,
        },
      });
      logger.log(`[PackageWorker] Job ${jobId} completed. artifact=${artifact.id}`);
    }

  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (leaseLost) { logger.warn(`[PackageWorker] Job ${jobId} ended after lease loss: ${message}`); return; }
    await jobsService.failPackageWorkerJob(jobId, workerId, message, true);
    await trackEvent('package_generation_failed', {
      failed: true,
      errorMessage: message,
      units: 1,
      unitType: 'per_operation',
    });
    logger.error(`[PackageWorker] Job ${jobId} failed: ${message}`);
  } finally {
    finalized = true;
    clearInterval(heartbeatTimer);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Bootstrap
// ─────────────────────────────────────────────────────────────────────────────

async function bootstrap() {
  const logger = new Logger('PackageWorker');
  const app    = await NestFactory.createApplicationContext(AppModule, { logger: ['log','warn','error'] });

  const jobsService      = app.get(ProductionJobsService);
  const artifactsService = app.get(ArtifactsService);
  const mbzBuilder       = app.get(MbzBuilderService);
  const eventsService    = app.get(EventsService);

  const workerId     = process.env.PACKAGE_WORKER_ID     || `package-worker-${process.pid}`;
  const pollMs       = readPositiveInt('PACKAGE_WORKER_POLL_MS',       10000);
  const leaseSeconds = readPositiveInt('PACKAGE_WORKER_LEASE_SECONDS', 300);
  const heartbeatMs  = readPositiveInt('PACKAGE_WORKER_HEARTBEAT_MS',  30000);
  const dryRun       = isTrueEnv('PACKAGE_WORKER_DRY_RUN');

  let shuttingDown = false;
  let idlePolls    = 0;
  const activeJobs = new Set<Promise<void>>();

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.warn(`Received ${signal}; waiting for ${activeJobs.size} active job(s)`);
    await Promise.allSettled(Array.from(activeJobs));
    await app.close();
    logger.log('Package worker stopped');
    process.exit(0);
  };

  process.on('SIGINT',  () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  logger.log(`Package worker started (workerId=${workerId}, pollMs=${pollMs}, leaseSeconds=${leaseSeconds}, dryRun=${dryRun})`);

  while (!shuttingDown) {
    const claimed = await jobsService.claimNextBackendPackageJob(workerId, leaseSeconds);

    if (!claimed) {
      idlePolls++;
      if (idlePolls === 1 || idlePolls % 6 === 0) logger.log('No backend_package jobs found');
      await sleep(pollMs);
      continue;
    }

    idlePolls = 0;
    logger.log(`Claimed package job ${claimed.id}`);

    if (dryRun) {
      logger.log(`[PackageWorker] Dry-run: simulating job ${claimed.id}`);
      await sleep(3000);
      await jobsService.completePackageWorkerJob(claimed.id, workerId, {
        mbzFinal: { status:'completed', humanMessage:'Paquete Moodle listo (dry-run).' },
      });
      await eventsService.trackBackendEvent({
        userId: claimed.ownerId,
        eventType: 'package_generation_completed',
        courseId: claimed.frontendCourseId || String(claimed.courseId ?? 'unknown'),
        jobId: claimed.id,
        parentJobId: claimed.inputPayload?.metadata?.parentJobId ?? null,
        component: 'package',
        provider: 'internal',
        model: 'mbz_builder_v1',
        mode: 'dry_run',
        costType: 'mock_zero',
        estimatedCostUsd: 0,
        costSource: 'mock_zero',
        units: 1,
        unitType: 'per_operation',
        metadata: { workerId, dryRun: true },
      });
      logger.log(`[PackageWorker] Dry-run completed for job ${claimed.id}`);
      continue;
    }

    const promise = handlePackageJob(
      claimed, jobsService, artifactsService, mbzBuilder, eventsService,
      workerId, leaseSeconds, heartbeatMs, logger,
    )
      .catch(error => {
        logger.error(`Unhandled package worker error for job ${claimed.id}: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => { activeJobs.delete(promise); });

    activeJobs.add(promise);
    await sleep(500);
  }
}

bootstrap().catch(error => {
  const logger = new Logger('PackageWorker');
  logger.error(`Fatal package worker bootstrap error: ${error instanceof Error ? error.stack || error.message : String(error)}`);
  process.exit(1);
});
