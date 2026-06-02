import { Injectable } from '@nestjs/common';

export interface ContentGenerationInputPayload {
  courseId: string;
  frontendJobId?: string | null;
  executionMode?: string;
  contentConfig?: {
    model?: string;
    maxRetriesPerFile?: number;
  };
  courseData: Record<string, any>;
  options?: Record<string, any>;
  metadata?: Record<string, any>;
}

export interface ContentGenerationProgressEvent {
  phase: 'libro' | 'paginas' | 'scorms' | 'examenes';
  done: number;
  total: number;
  file: string;
  message: string;
}

export interface ContentGenerationCallbacks {
  onProgress?: (event: ContentGenerationProgressEvent) => void | Promise<void>;
}

export interface GeneratedCourseContentSummary {
  mode: 'template';
  generatedAt: string;
  durationMs: number;
  fileCount: number;
  filesGenerated: number;
  phases: Array<{
    phase: 'libro' | 'paginas' | 'scorms' | 'examenes';
    generated: number;
    total: number;
  }>;
  progressMap: Record<string, { done: number; total: number }>;
  lastFile: string | null;
  errors: string[];
}

export interface GeneratedCourseContentResult {
  D: Record<string, any>;
  F: Record<string, string>;
  summary: GeneratedCourseContentSummary;
}

type PhaseKey = 'libro' | 'paginas' | 'scorms' | 'examenes';

interface NormalizedModule {
  n: string;
  caps: string[];
}

interface NormalizedChapter {
  n: number;
  t: string;
  moduleNumber: number;
  moduleName: string;
}

interface NormalizedCourseData {
  nombre: string;
  comp: string;
  pais: string;
  ciudad: string;
  sector: string;
  mid: string;
  lms: string;
  nivel: string;
  tono: string;
  contexto: string;
  obj: string;
  horas: number;
  pal: Record<string, string>;
  mods: NormalizedModule[];
  caps: NormalizedChapter[];
  prevCourse: Record<string, any>;
}

const DEFAULT_PALETTE = {
  accent: '#E67E22',
  m1: '#2457C5',
  m1a: '#4A7DFF',
  m2: '#0F766E',
  m2a: '#14B8A6',
  m3: '#7C3AED',
  m3a: '#A78BFA',
};

const PHASE_TOTALS: Record<PhaseKey, number> = {
  libro: 15,
  paginas: 21,
  scorms: 18,
  examenes: 4,
};

function escapeHtml(value: any): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function slugSafe(value: string, fallback: string): string {
  const clean = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return clean || fallback;
}

function normalizeText(value: any, fallback: string): string {
  const text = String(value ?? '').trim();
  return text || fallback;
}

function normalizeHours(value: any): number {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return 24;
  return Math.max(1, Math.round(num));
}

function buildNormalizedModules(rawModules: any[]): NormalizedModule[] {
  const modules: NormalizedModule[] = [];

  for (let index = 0; index < 3; index += 1) {
    const rawModule = rawModules[index] || {};
    const moduleName = normalizeText(rawModule.n, `Modulo ${index + 1}`);
    const rawCaps = Array.isArray(rawModule.caps) ? rawModule.caps : [];
    const caps: string[] = [];

    for (let capIndex = 0; capIndex < 3; capIndex += 1) {
      const defaultCap = `Capitulo ${(index * 3) + capIndex + 1}`;
      caps.push(normalizeText(rawCaps[capIndex], defaultCap));
    }

    modules.push({ n: moduleName, caps });
  }

  return modules;
}

function buildNormalizedCourseData(rawCourseData: Record<string, any>): NormalizedCourseData {
  const mods = buildNormalizedModules(Array.isArray(rawCourseData?.mods) ? rawCourseData.mods : []);
  const caps: NormalizedChapter[] = [];

  mods.forEach((mod, moduleIndex) => {
    mod.caps.forEach((capTitle, capIndex) => {
      caps.push({
        n: (moduleIndex * 3) + capIndex + 1,
        t: capTitle,
        moduleNumber: moduleIndex + 1,
        moduleName: mod.n,
      });
    });
  });

  return {
    nombre: normalizeText(rawCourseData?.nombre, 'Curso Cursia'),
    comp: normalizeText(rawCourseData?.comp, 'Competencia principal del curso'),
    pais: normalizeText(rawCourseData?.pais, 'Colombia'),
    ciudad: normalizeText(rawCourseData?.ciudad, 'Bogota'),
    sector: normalizeText(rawCourseData?.sector, 'Formacion'),
    mid: normalizeText(rawCourseData?.mid, 'MID'),
    lms: normalizeText(rawCourseData?.lms, 'Moodle'),
    nivel: normalizeText(rawCourseData?.nivel, 'basico'),
    tono: normalizeText(rawCourseData?.tono, 'practico'),
    contexto: normalizeText(
      rawCourseData?.contexto,
      'Curso generado para una experiencia de aprendizaje virtual estructurada.',
    ),
    obj: normalizeText(
      rawCourseData?.obj,
      'Desarrollar competencias aplicadas para resolver situaciones reales del sector.',
    ),
    horas: normalizeHours(rawCourseData?.horas),
    pal: { ...DEFAULT_PALETTE, ...(rawCourseData?.pal || {}) },
    mods,
    caps,
    prevCourse:
      rawCourseData?.prevCourse && typeof rawCourseData.prevCourse === 'object'
        ? rawCourseData.prevCourse
        : {},
  };
}

function toBackendCourseState(normalized: NormalizedCourseData): Record<string, any> {
  return {
    nombre: normalized.nombre,
    comp: normalized.comp,
    pais: normalized.pais,
    ciudad: normalized.ciudad,
    sector: normalized.sector,
    mid: normalized.mid,
    lms: normalized.lms,
    nivel: normalized.nivel,
    tono: normalized.tono,
    contexto: normalized.contexto,
    obj: normalized.obj,
    horas: normalized.horas,
    pal: normalized.pal,
    mods: normalized.mods.map((mod) => ({ n: mod.n, caps: [...mod.caps] })),
    caps: normalized.caps.map((cap) => ({
      n: cap.n,
      t: cap.t,
      m: cap.moduleNumber,
      mn: cap.moduleName,
    })),
    prevCourse: normalized.prevCourse,
  };
}

function compileBookHtml(normalized: NormalizedCourseData): string {
  const chapterSections = normalized.caps
    .map((cap) => {
      return `
        <section class="chapter">
          <div class="eyebrow">Capitulo ${cap.n} · Modulo ${cap.moduleNumber}</div>
          <h3>${escapeHtml(cap.t)}</h3>
          <p>Este capitulo desarrolla contenidos introductorios, conceptos clave, pasos de aplicacion y una breve practica guiada para ${escapeHtml(normalized.sector)}.</p>
          <ul>
            <li>Objetivo aplicado al contexto de ${escapeHtml(normalized.pais)}.</li>
            <li>Checklist de conceptos y buenas practicas.</li>
            <li>Actividad sugerida para transferir el aprendizaje al trabajo real.</li>
          </ul>
        </section>`;
    })
    .join('\n');

  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(normalized.nombre)} - Libro guia completo</title>
  <style>
    body{font-family:Arial,sans-serif;background:#08111c;color:#e5eef8;margin:0;padding:32px;line-height:1.6}
    main{max-width:960px;margin:0 auto}
    h1,h2,h3{margin:0 0 12px}
    .hero,.module,.chapter,.closing{background:#0f1d2d;border:1px solid rgba(255,255,255,.08);border-radius:16px;padding:24px;margin-bottom:16px}
    .eyebrow{font-size:12px;text-transform:uppercase;letter-spacing:1px;color:#8fb5e0;margin-bottom:8px}
    ul{margin:0;padding-left:20px}
  </style>
</head>
<body>
  <main>
    <section class="hero">
      <div class="eyebrow">Libro guia del curso</div>
      <h1>${escapeHtml(normalized.nombre)}</h1>
      <p>${escapeHtml(normalized.obj)}</p>
      <p><strong>Sector:</strong> ${escapeHtml(normalized.sector)} · <strong>Pais:</strong> ${escapeHtml(normalized.pais)} · <strong>Duracion:</strong> ${normalized.horas} horas</p>
    </section>
    ${normalized.mods
      .map((mod, index) => {
        return `
          <section class="module">
            <div class="eyebrow">Modulo ${index + 1}</div>
            <h2>${escapeHtml(mod.n)}</h2>
            <ul>${mod.caps.map((cap) => `<li>${escapeHtml(cap)}</li>`).join('')}</ul>
          </section>`;
      })
      .join('\n')}
    ${chapterSections}
    <section class="closing">
      <div class="eyebrow">Cierre</div>
      <h2>Bibliografia y continuidad</h2>
      <p>Este material resume el contenido base del curso y queda listo para futuras fases del pipeline SaaS.</p>
    </section>
  </main>
</body>
</html>`;
}

function createBookIntroMarkdown(normalized: NormalizedCourseData): string {
  return `# ${normalized.nombre}

## Panorama del curso

- Sector: ${normalized.sector}
- Pais: ${normalized.pais}
- Nivel: ${normalized.nivel}
- Duracion estimada: ${normalized.horas} horas

## Objetivo general

${normalized.obj}

## Enfoque metodologico

Este curso esta pensado para una experiencia virtual guiada, con lectura, practica y evaluacion progresiva.`;
}

function createModuleMarkdown(normalized: NormalizedCourseData, mod: NormalizedModule, index: number): string {
  return `# Modulo ${index + 1}: ${mod.n}

## Resultado esperado

Al finalizar este modulo, el participante podra aplicar aprendizajes concretos en escenarios de ${normalized.sector}.

## Capitulos del modulo

${mod.caps.map((cap, capIndex) => `- Capitulo ${(index * 3) + capIndex + 1}: ${cap}`).join('\n')}
`;
}

function createChapterMarkdown(normalized: NormalizedCourseData, cap: NormalizedChapter): string {
  return `# Capitulo ${cap.n}: ${cap.t}

## Contexto

Este capitulo conecta el modulo ${cap.moduleNumber} (${cap.moduleName}) con situaciones frecuentes del sector ${normalized.sector} en ${normalized.pais}.

## Objetivos de aprendizaje

- Comprender la idea central del tema.
- Reconocer decisiones y errores frecuentes.
- Aplicar una secuencia simple de trabajo en escenarios reales.

## Desarrollo

1. Introduccion al tema y vocabulario base.
2. Explicacion paso a paso con ejemplos.
3. Cierre con checklist de aplicacion.
`;
}

function createBibliographyMarkdown(normalized: NormalizedCourseData): string {
  return `# Bibliografia y recursos

- Referencias introductorias del sector ${normalized.sector}.
- Normativa y buenas practicas aplicables en ${normalized.pais}.
- Recursos de profundizacion para seguir aprendiendo despues del curso.

## Recomendacion final

Usa este libro guia como apoyo para videos, actividades y evaluaciones.`;
}

function createSimplePage(title: string, body: string, eyebrow?: string): string {
  return `<div style="background:#0f1d2d;border-radius:18px;padding:28px 30px;color:#e5eef8;font-family:Arial,sans-serif;">
  ${eyebrow ? `<div style="font-size:12px;text-transform:uppercase;letter-spacing:1px;color:#8fb5e0;margin-bottom:10px;">${escapeHtml(eyebrow)}</div>` : ''}
  <h2 style="margin:0 0 12px;">${escapeHtml(title)}</h2>
  ${body}
</div>`;
}

function createScormIndex(normalized: NormalizedCourseData, cap: NormalizedChapter): string {
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>SCORM Capitulo ${cap.n}</title>
  <style>
    body{font-family:Arial,sans-serif;background:#08111c;color:#e5eef8;margin:0;padding:24px}
    .card{max-width:880px;margin:0 auto;background:#0f1d2d;border-radius:18px;padding:24px}
  </style>
</head>
<body>
  <div class="card" id="scorm-cap-${cap.n}">
    <p style="font-size:12px;text-transform:uppercase;color:#8fb5e0;">SCORM listo para futura activacion</p>
    <h1>Capitulo ${cap.n}: ${escapeHtml(cap.t)}</h1>
    <p>Este recurso contiene una version backend-compatible del contenido base para ${escapeHtml(normalized.nombre)}.</p>
    <ol>
      <li>Repasa la idea principal del capitulo.</li>
      <li>Relaciona el contenido con tu contexto laboral.</li>
      <li>Continua luego hacia actividades y evaluacion.</li>
    </ol>
  </div>
</body>
</html>`;
}

function createScormManifest(cap: NormalizedChapter): string {
  const identifier = `scorm-cap-${cap.n}-${slugSafe(cap.t, `cap-${cap.n}`)}`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<manifest identifier="${identifier}" version="1.0"
  xmlns="http://www.imsglobal.org/xsd/imscp_v1p1"
  xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_v1p3">
  <organizations default="ORG-${cap.n}">
    <organization identifier="ORG-${cap.n}">
      <title>Capitulo ${cap.n}: ${escapeHtml(cap.t)}</title>
      <item identifier="ITEM-${cap.n}" identifierref="RES-${cap.n}">
        <title>Capitulo ${cap.n}: ${escapeHtml(cap.t)}</title>
      </item>
    </organization>
  </organizations>
  <resources>
    <resource identifier="RES-${cap.n}" type="webcontent" adlcp:scormType="sco" href="scorm_cap${cap.n}_index.html">
      <file href="scorm_cap${cap.n}_index.html" />
    </resource>
  </resources>
</manifest>`;
}

function createGiftQuestions(title: string, prompts: string[]): string {
  return prompts
    .map((prompt, index) => {
      return `::${title} ${index + 1}::${prompt} {
=Opcion correcta
~Distractor 1
~Distractor 2
~Distractor 3
}`;
    })
    .join('\n\n');
}

async function emitProgress(
  callbacks: ContentGenerationCallbacks | undefined,
  event: ContentGenerationProgressEvent,
): Promise<void> {
  if (!callbacks?.onProgress) return;
  await callbacks.onProgress(event);
}

export async function generateCourseContent(
  inputPayload: ContentGenerationInputPayload,
  callbacks?: ContentGenerationCallbacks,
): Promise<GeneratedCourseContentResult> {
  if (!inputPayload || typeof inputPayload !== 'object') {
    throw new Error('inputPayload is required');
  }

  if (!inputPayload.courseData || typeof inputPayload.courseData !== 'object') {
    throw new Error('inputPayload.courseData is required');
  }

  const startedAt = Date.now();
  const normalized = buildNormalizedCourseData(inputPayload.courseData);
  const D = toBackendCourseState(normalized);
  const F: Record<string, string> = {};

  const progressMap: Record<string, { done: number; total: number }> = {
    libro: { done: 0, total: PHASE_TOTALS.libro },
    paginas: { done: 0, total: PHASE_TOTALS.paginas },
    scorms: { done: 0, total: PHASE_TOTALS.scorms },
    examenes: { done: 0, total: PHASE_TOTALS.examenes },
  };

  let lastFile: string | null = null;

  async function addFile(
    phase: PhaseKey,
    file: string,
    content: string,
    message: string,
  ): Promise<void> {
    F[file] = content;
    progressMap[phase].done += 1;
    lastFile = file;
    await emitProgress(callbacks, {
      phase,
      done: progressMap[phase].done,
      total: progressMap[phase].total,
      file,
      message,
    });
  }

  await addFile('libro', 'libro_inicio.md', createBookIntroMarkdown(normalized), 'Libro: portada e introduccion');
  for (let index = 0; index < normalized.mods.length; index += 1) {
    await addFile(
      'libro',
      `libro_mod${index + 1}.md`,
      createModuleMarkdown(normalized, normalized.mods[index], index),
      `Libro: modulo ${index + 1}`,
    );
  }
  for (const cap of normalized.caps) {
    await addFile(
      'libro',
      `libro_cap${cap.n}.md`,
      createChapterMarkdown(normalized, cap),
      `Libro: capitulo ${cap.n}`,
    );
  }
  await addFile('libro', 'libro_biblio.md', createBibliographyMarkdown(normalized), 'Libro: bibliografia');
  await addFile('libro', 'libro_guia_completo.html', compileBookHtml(normalized), 'Libro: compilado HTML');

  await addFile(
    'paginas',
    'seccion0_bienvenida.html',
    createSimplePage(
      'Bienvenida al curso',
      `<p>Te damos la bienvenida a <strong>${escapeHtml(normalized.nombre)}</strong>, un recorrido formativo orientado al sector ${escapeHtml(normalized.sector)}.</p>
       <p>Exploraras tres modulos, nueve capitulos y una experiencia pensada para avanzar paso a paso.</p>`,
      'Inicio',
    ),
    'Pagina: bienvenida',
  );
  await addFile(
    'paginas',
    'seccion0_audio_bienvenida.html',
    createSimplePage(
      'Audio de bienvenida',
      `<p>Esta pagina queda lista para enlazar el audio de bienvenida cuando la fase de audio este activa.</p>
       <audio controls style="width:100%;"><source src="#audio" type="audio/mpeg" />Tu navegador no soporta audio.</audio>`,
      'Audio',
    ),
    'Pagina: audio bienvenida',
  );
  await addFile(
    'paginas',
    'seccion0_introduccion_completa.html',
    createSimplePage(
      'Introduccion completa',
      `<p><strong>Objetivo:</strong> ${escapeHtml(normalized.obj)}</p>
       <p><strong>Contexto:</strong> ${escapeHtml(normalized.contexto)}</p>
       <ul>${normalized.mods.map((mod, index) => `<li>Modulo ${index + 1}: ${escapeHtml(mod.n)}</li>`).join('')}</ul>`,
      'Introduccion',
    ),
    'Pagina: introduccion completa',
  );
  await addFile(
    'paginas',
    'seccion0_introduccion.html',
    createSimplePage(
      'Que aprenderas',
      `<ul>${normalized.caps.map((cap) => `<li>Capitulo ${cap.n}: ${escapeHtml(cap.t)}</li>`).join('')}</ul>`,
      'Aprendizaje esperado',
    ),
    'Pagina: introduccion breve',
  );
  await addFile(
    'paginas',
    'seccion0_metodologia.html',
    createSimplePage(
      'Metodologia del curso',
      `<ol>
         <li>Explora el contenido base y toma notas.</li>
         <li>Relaciona conceptos con situaciones reales de ${escapeHtml(normalized.sector)}.</li>
         <li>Completa evaluaciones por unidad y cierre final.</li>
       </ol>`,
      'Metodologia',
    ),
    'Pagina: metodologia',
  );
  await addFile(
    'paginas',
    'seccion1_ruta_aprendizaje.html',
    createSimplePage(
      'Ruta de aprendizaje',
      normalized.mods
        .map((mod, index) => {
          return `<div style="margin-bottom:12px;"><strong>Modulo ${index + 1}: ${escapeHtml(mod.n)}</strong><ul>${mod.caps.map((cap) => `<li>${escapeHtml(cap)}</li>`).join('')}</ul></div>`;
        })
        .join(''),
      'Ruta',
    ),
    'Pagina: ruta de aprendizaje',
  );
  await addFile(
    'paginas',
    'seccion1_libro_guia.html',
    createSimplePage(
      'Libro guia del curso',
      `<p>Esta pagina presenta el libro guia generado en backend para consulta, exportacion y futuras fases del pipeline.</p>
       <p><a href="#libro-guia" target="_blank" rel="noopener">Abrir libro guia</a></p>`,
      'Libro',
    ),
    'Pagina: libro guia',
  );
  await addFile(
    'paginas',
    'seccion1_audiolibro.html',
    createSimplePage(
      'Audiolibro del curso',
      `<p>Placeholder backend para enlazar el audiolibro cuando la fase de audio este disponible.</p>
       <audio controls style="width:100%;"><source src="#audio" type="audio/mpeg" />Tu navegador no soporta audio.</audio>`,
      'Audiolibro',
    ),
    'Pagina: audiolibro',
  );

  for (const cap of normalized.caps) {
    await addFile(
      'paginas',
      `cap${cap.n}_video_interactivo.html`,
      createSimplePage(
        `Video interactivo del capitulo ${cap.n}`,
        `<p>Placeholder backend para el recurso multimedia del capitulo <strong>${cap.n}: ${escapeHtml(cap.t)}</strong>.</p>
         <p>Estado actual: contenido base generado, multimedia pendiente de futuras fases.</p>`,
        `Capitulo ${cap.n}`,
      ),
      `Pagina: video placeholder capitulo ${cap.n}`,
    );
  }

  for (let unit = 1; unit <= 3; unit += 1) {
    const mod = normalized.mods[unit - 1];
    await addFile(
      'paginas',
      `examen_unidad${unit}_descripcion.html`,
      createSimplePage(
        `Evaluacion de unidad ${unit}`,
        `<p>Esta evaluacion cubre los capitulos de <strong>${escapeHtml(mod.n)}</strong>.</p>
         <ul>${mod.caps.map((cap) => `<li>${escapeHtml(cap)}</li>`).join('')}</ul>
         <p><a href="#exam-unit-${unit}">Ir al examen de unidad</a></p>`,
        `Unidad ${unit}`,
      ),
      `Pagina: descripcion examen unidad ${unit}`,
    );
  }
  await addFile(
    'paginas',
    'examen_final_descripcion.html',
    createSimplePage(
      'Examen final del curso',
      `<p>Evaluacion integradora de los tres modulos.</p>
       <p><a href="#exam-final">Ir al examen final</a></p>`,
      'Cierre',
    ),
    'Pagina: descripcion examen final',
  );

  for (const cap of normalized.caps) {
    await addFile(
      'scorms',
      `scorm_cap${cap.n}_index.html`,
      createScormIndex(normalized, cap),
      `SCORM: index capitulo ${cap.n}`,
    );
    await addFile(
      'scorms',
      `scorm_cap${cap.n}_manifest.xml`,
      createScormManifest(cap),
      `SCORM: manifest capitulo ${cap.n}`,
    );
  }

  for (let unit = 1; unit <= 3; unit += 1) {
    const mod = normalized.mods[unit - 1];
    await addFile(
      'examenes',
      `examen_unidad${unit}.gift`,
      createGiftQuestions(
        `Examen Unidad ${unit}`,
        mod.caps.map((cap) => `Pregunta base sobre ${cap}`),
      ),
      `Examen: unidad ${unit}`,
    );
  }
  await addFile(
    'examenes',
    'examen_final.gift',
    createGiftQuestions(
      'Examen Final',
      normalized.caps.slice(0, 9).map((cap) => `Pregunta integradora sobre ${cap.t}`),
    ),
    'Examen: final',
  );

  const summary: GeneratedCourseContentSummary = {
    mode: 'template',
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    fileCount: Object.keys(F).length,
    filesGenerated: Object.keys(F).length,
    phases: (Object.keys(progressMap) as PhaseKey[]).map((phase) => ({
      phase,
      generated: progressMap[phase].done,
      total: progressMap[phase].total,
    })),
    progressMap,
    lastFile,
    errors: [],
  };

  return { D, F, summary };
}

@Injectable()
export class ContentGenerationService {
  async generateCourseContent(
    inputPayload: ContentGenerationInputPayload,
    callbacks?: ContentGenerationCallbacks,
  ): Promise<GeneratedCourseContentResult> {
    return generateCourseContent(inputPayload, callbacks);
  }
}
