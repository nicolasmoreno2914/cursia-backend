import { Injectable, Logger } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';

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
  tokensUsed?: { input: number; output: number };
}

export interface ContentGenerationCallbacks {
  onProgress?: (event: ContentGenerationProgressEvent) => void | Promise<void>;
}

export interface GeneratedCourseContentSummary {
  mode: 'claude' | 'template';
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
  tokensInput: number;
  tokensOutput: number;
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
  moduleHex: string;
  moduleAc: string;
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
  libro:    14,
  paginas:  28,  // 6 intro + 9 video + 9 desc actividad + 4 desc examen
  scorms:    9,  // 9 actividades IA (manifests son determinísticos, no se cuentan)
  examenes:  4,
};

const DEFAULT_MODEL = 'claude-sonnet-4-5';
const MAX_RETRIES   = 3;

const LIBRO_CONCURRENCY   = 3;
const PAGINAS_CONCURRENCY = 3;
const SCORM_CONCURRENCY   = 3;
const EXAMEN_CONCURRENCY  = 3;

// ── Concurrency helpers ────────────────────────────────────────────────────────

function createLimiter(concurrency: number) {
  let running = 0;
  const queue: Array<() => void> = [];
  return function limit<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const attempt = () => {
        running++;
        fn().then(resolve, reject).finally(() => {
          running--;
          if (queue.length > 0) queue.shift()!();
        });
      };
      if (running < concurrency) attempt();
      else queue.push(attempt);
    });
  };
}

type TaskResult<T> = { ok: true; value: T } | { ok: false; error: Error };

async function gatherParallel<T>(
  tasks: Array<() => Promise<T>>,
  concurrency: number,
): Promise<Array<TaskResult<T>>> {
  const limit = createLimiter(concurrency);
  const results: Array<TaskResult<T>> = tasks.map(() => ({ ok: false as const, error: new Error('pending') }));
  await Promise.all(
    tasks.map((fn, i) =>
      limit(async () => {
        try {
          results[i] = { ok: true, value: await fn() };
        } catch (err) {
          results[i] = { ok: false, error: err instanceof Error ? err : new Error(String(err)) };
        }
      })
    )
  );
  return results;
}

function escapeHtml(value: any): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── SCORM game engine helpers ─────────────────────────────────────────────────

function safeJsonEmbed(obj: unknown): string {
  return JSON.stringify(obj)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e');
}

type ScormMechanic = 'quiz_clasico' | 'checklist' | 'secuencia_pro';

type ScormPregunta = {
  q: string;
  opts?: string[];
  correct?: string;
  fb?: string;
  scenario?: string;
  items?: Array<{ label: string; required: boolean }>;
  steps?: Array<{ id: string; label: string; order: number }>;
  tolerance?: number;
};

type ScormSala = { name: string; preguntas: ScormPregunta[] };

type ScormGameData = {
  gameName: string;
  tagline: string;
  emoji: string;
  scenario: { location: string; character: string; intro: string };
  salas: ScormSala[];
};

function selectScormMechanic(cap: NormalizedChapter): ScormMechanic {
  const mechs: ScormMechanic[] = ['quiz_clasico', 'checklist', 'secuencia_pro'];
  return mechs[(cap.n - 1) % mechs.length];
}

function buildScormDataPrompt(D: NormalizedCourseData, ctx: string, cap: NormalizedChapter): string {
  const mech = selectScormMechanic(cap);
  const mechInstr = mech === 'quiz_clasico'
    ? `Mecánica: QUIZ CLÁSICO. Cada pregunta: "q" (enunciado), "opts": array 4 strings (primera=correcta, otras 3 distractores plausibles), "correct": string igual al primer elemento de opts, "fb": feedback 1-2 líneas. Opcional: "scenario": oración de contexto situacional antes de la pregunta.`
    : mech === 'checklist'
    ? `Mecánica: CHECKLIST CRÍTICO. Cada pregunta: "q" (nombre del protocolo a verificar), "items": array 6-8 objetos {"label":string,"required":boolean} (mínimo 4 required), "fb": feedback sobre los pasos obligatorios.`
    : `Mecánica: SECUENCIA DE PROCESO. Cada pregunta: "q" (procedimiento a ordenar), "steps": array 5-7 objetos {"id":"s1","label":"texto del paso","order":N} con orden 1..N correcto (el motor los mezcla al renderizar), "fb": feedback sobre el orden correcto, "tolerance": 0.`;

  return `${ctx}

Genera las interacciones para una actividad gamificada SCORM de práctica.
Capítulo ${cap.n}: "${cap.t}" | Módulo ${cap.moduleNumber}: "${cap.moduleName}" | Sector: ${D.sector} | País: ${D.pais}

${mechInstr}

RESPONDE SOLO con JSON válido, sin texto adicional:
{
  "gameName": "Nombre narrativo con metáfora fuerte — NUNCA 'Quiz de…' ni 'Evaluación de…'",
  "tagline": "Subtítulo motivador 5-9 palabras",
  "emoji": "emoji representativo del tema",
  "scenario": {
    "location": "Lugar específico del sector y país",
    "character": "Nombre y rol del protagonista",
    "intro": "2-3 oraciones: contexto real, problema urgente, misión del aprendiz"
  },
  "salas": [
    {"name": "Nombre evocador de la sala", "preguntas": [ /* 4 preguntas con el formato indicado */ ]},
    {"name": "...", "preguntas": [ /* 4 preguntas */ ]},
    {"name": "...", "preguntas": [ /* 4 preguntas */ ]}
  ]
}

REGLAS:
- Contenido basado en el capítulo, módulo, sector y país — NUNCA de exámenes externos
- Lenguaje profesional del sector, situaciones realistas de ${D.pais}
- gameName narrativo, nunca "Quiz de ${cap.t}" ni "Evaluación del capítulo"
- Sin texto fuera del JSON`;
}

function parseScormGameData(raw: string, cap: NormalizedChapter): ScormGameData {
  const fallback: ScormGameData = {
    gameName: `Práctica — ${cap.t}`,
    tagline: `Refuerzo del capítulo ${cap.n}`,
    emoji: '🎮',
    scenario: { location: '', character: '', intro: '' },
    salas: Array.from({ length: 3 }, (_, i) => ({
      name: `Sala ${i + 1}`,
      preguntas: [{
        q: `Pregunta de práctica sobre ${cap.t}`,
        opts: ['Respuesta A', 'Respuesta B', 'Respuesta C', 'Respuesta D'],
        correct: 'Respuesta A',
        fb: 'Revisa el capítulo para más detalles.',
      }],
    })),
  };
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return fallback;
    const data = JSON.parse(match[0]) as ScormGameData;
    if (!Array.isArray(data.salas) || data.salas.length === 0) return fallback;
    return data;
  } catch {
    return fallback;
  }
}

// Returns null if content is acceptable, or a reason string if placeholder detected
function isScormPlaceholder(data: ScormGameData): string | null {
  const MARKERS = ['Respuesta A', 'Respuesta B', 'Pregunta de práctica', 'Revisa el capítulo para más detalles'];
  const salas = data.salas ?? [];
  if (salas.length < 3) return `solo ${salas.length} sala(s) (mínimo 3)`;
  for (let i = 0; i < salas.length; i++) {
    const pqs = salas[i]?.preguntas ?? [];
    if (pqs.length < 3) return `sala ${i + 1} tiene ${pqs.length} pregunta(s) (mínimo 3)`;
    const txt = JSON.stringify(pqs);
    for (const m of MARKERS) {
      if (txt.includes(m)) return `sala ${i + 1} contiene placeholder "${m}"`;
    }
  }
  return null;
}

// ── Normalise raw course data from the frontend payload ─────────────────────
function buildNormalizedCourseData(raw: Record<string, any>): NormalizedCourseData {
  const rawMods: any[] = Array.isArray(raw.mods) ? raw.mods : [];
  const rawCaps: any[] = Array.isArray(raw.caps) ? raw.caps : [];

  const pal = raw.pal ?? DEFAULT_PALETTE;
  const modHexes  = [pal.m1  ?? DEFAULT_PALETTE.m1,  pal.m2  ?? DEFAULT_PALETTE.m2,  pal.m3  ?? DEFAULT_PALETTE.m3];
  const modAcs    = [pal.m1a ?? DEFAULT_PALETTE.m1a, pal.m2a ?? DEFAULT_PALETTE.m2a, pal.m3a ?? DEFAULT_PALETTE.m3a];

  const mods: NormalizedModule[] = rawMods.map((m: any) => ({
    n: String(m.n ?? m.name ?? ''),
    caps: Array.isArray(m.caps) ? m.caps.map(String) : [],
  }));

  const caps: NormalizedChapter[] = rawCaps.map((c: any, idx: number) => {
    const modIdx = Math.floor(idx / 3);
    return {
      n:          Number(c.n ?? idx + 1),
      t:          String(c.t ?? c.title ?? ''),
      moduleNumber: modIdx + 1,
      moduleName:   mods[modIdx]?.n ?? `Módulo ${modIdx + 1}`,
      moduleHex:    modHexes[modIdx] ?? DEFAULT_PALETTE.m1,
      moduleAc:     modAcs[modIdx]   ?? DEFAULT_PALETTE.m1a,
    };
  });

  return {
    nombre:     String(raw.nombre   ?? raw.title ?? ''),
    comp:       String(raw.comp     ?? ''),
    pais:       String(raw.pais     ?? raw.country ?? 'Colombia'),
    ciudad:     String(raw.ciudad   ?? ''),
    sector:     String(raw.sector   ?? ''),
    mid:        String(raw.mid      ?? ''),
    lms:        String(raw.lms      ?? ''),
    nivel:      String(raw.nivel    ?? 'Básico'),
    tono:       String(raw.tono     ?? 'Conversacional y cercano'),
    contexto:   String(raw.contexto ?? 'Universitario'),
    obj:        String(raw.obj      ?? raw.objetivo ?? ''),
    horas:      Number(raw.horas    ?? 80),
    pal,
    mods,
    caps,
    prevCourse: raw.prevCourse ?? {},
  };
}

// ── Build the course context string (equivalent to ctx() in frontend) ────────
function buildCourseContext(D: NormalizedCourseData): string {
  let s = `Curso: "${D.nombre}" | Sector: ${D.sector} | País: ${D.pais} | Ciudad: ${D.ciudad}`;
  s += `\nContexto educativo: ${D.contexto}`;
  s += `\nNivel de conocimiento: ${D.nivel} | Tono: ${D.tono}`;
  if (D.prevCourse?.caps?.length) {
    s += `\nSECUENCIA CURRICULAR: Este curso es la continuación de "${D.prevCourse.nombre}".`;
    s += `\nTemas YA CUBIERTOS por el estudiante (NO repetir, construir sobre ellos): ${D.prevCourse.caps.join(' | ')}`;
    s += `\nAsegúrate de que los nuevos temas profundicen o avancen desde los anteriores.`;
  }
  s += `\nObjetivo: ${D.obj}`;
  s += `\nCompetencia: ${D.comp}`;
  s += `\nEstructura: 3 módulos · 9 capítulos`;
  D.mods.forEach((m, i) => {
    s += `\nMódulo ${i + 1}: ${m.n}`;
    m.caps.forEach((cap, ci) => { s += ` | Cap ${i * 3 + ci + 1}: ${cap}`; });
  });
  return s;
}

// ── System prompts ────────────────────────────────────────────────────────────
function buildLibroSystemPrompt(D: NormalizedCourseData): string {
  return `Eres diseñador instruccional experto de CampusCloud. Generas libros guía para cursos virtuales. REGLAS: (1) Cada concepto lleva ejemplo concreto del sector y país — NUNCA genérico. (2) PROHIBIDO: "en el mundo actual", "es fundamental entender", "cabe destacar", "en la era digital", "hoy en día". (3) Cada sección 250-400 palabras con dato numérico real. (4) Tono: ${D.tono}. (5) Tutear al estudiante. (6) Actividades concretas y accionables con pasos numerados. (7) Incluir mínimo 1 tabla comparativa por capítulo. (8) Caso con empresa real y datos específicos. (9) Glosario con 8-12 términos por capítulo. (10) TABLAS MARKDOWN — REGLA CRÍTICA: si una celda contiene la barra vertical | (por ejemplo en fórmulas matemáticas como |f(x)|), escápala como \\| para que no rompa la tabla. Solo Markdown limpio sin explicaciones adicionales, sin bloques de código.`;
}

function buildHtmlSystemPrompt(D: NormalizedCourseData): string {
  const p = D.pal;
  return `Eres desarrollador de e-learning de CampusCloud. Generas fragmentos HTML para Moodle con estilos SOLO inline.\n\nREGLA CERO — CRÍTICA: NUNCA uses <style> ni <script>. Moodle los elimina. Todo CSS va en style="" inline directamente en cada elemento.\n\nREGLAS OBLIGATORIAS:\n(1) WRAPPER: primer elemento raíz SIEMPRE: <div style="background:#0A1628;border-radius:20px;padding:32px;color:#E2E6F3;font-family:'Segoe UI',Arial,sans-serif;box-sizing:border-box;width:100%;max-width:100%;overflow-x:hidden;">\n(2) COLOR en cada <h1><h2><h3><p><span><li><td><th>: style="color:#E2E6F3"\n(3) FONT-FAMILY en cada elemento: font-family:'Segoe UI',Arial,sans-serif\n(4) TABLAS: <table style="width:100%;border-collapse:collapse;table-layout:auto;"> cada <th>/<td> con padding:10px 14px;color:#E2E6F3 · SIN min-width fijo en celdas\n(5) FLEX: display:flex;flex-wrap:wrap;gap:16px — cards: flex:1 1 240px;max-width:100% · NUNCA flex-nowrap ni flex sin wrap\n(6) COLORES: M1=${p.m1}, M2=${p.m2}, M3=${p.m3}, Acento=${p.accent}. Texto siempre #E2E6F3\n(7) BOTONES: display:inline-block;padding:12px 24px;border-radius:10px;color:#fff;text-decoration:none;word-break:keep-all · NUNCA white-space:nowrap en móvil\n(8) TIPOGRAFÍA: h1 máx 32px · h2 máx 24px · h3 máx 20px · cuerpo 13-15px\n\nPROHIBIDO ABSOLUTO: <style> <script> · table-layout:fixed · height fijo · position:fixed · position:absolute · color oscuro sobre fondo oscuro · font-size > 36px · width con valor px mayor a 100 · min-width > 280px · padding-bottom:56% (truco aspect-ratio) · overflow:hidden en contenedores padres\n\nPLACEHOLDERS: href="#scorm-cap-N" · href="#exam-unit-N" · href="#exam-final" · href="#libro-guia" — CONSERVAR sin modificar.\n\nENTREGA SOLO HTML, sin markdown. Empieza con <div directamente.`;
}

function buildGiftSystemPrompt(): string {
  return `Eres experto en evaluación educativa de CampusCloud. Generas exámenes GIFT para Moodle.\n\nTIPOS SOPORTADOS: Selección múltiple · Verdadero/Falso · Emparejamiento · Completar · Numérica\n\nREGLAS:\n(1) Selección múltiple: 4 opciones, misma longitud, 1 "=" + 3 "~"\n(2) V/F: ::ID::Enunciado. {TRUE} o {FALSE}\n(3) Emparejamiento: mínimo 4 pares "=Término -> Definición"\n(4) Completar: =respuesta =Variante =sin_tilde\n(5) Numérica: {#valor:tolerancia}\n(6) Preguntas sobre contenido REAL del sector y país\n(7) SOLO GIFT puro, sin texto explicativo ni bloques \`\`\``;
}

function buildScormSystemPrompt(): string {
  return 'Eres diseñador de juegos educativos de CampusCloud. Generas JSON de contenido para actividades SCORM gamificadas.\n\nREGLAS:\n(1) Responde SOLO con JSON válido — sin texto adicional, sin bloques ```\n(2) Contenido basado en el sector, país y tema del capítulo — NUNCA reutilices preguntas de exámenes\n(3) Lenguaje profesional del sector, situaciones realistas y verificables\n(4) Nombres creativos con metáforas del sector — NUNCA "Quiz de…" ni "Evaluación del capítulo"\n(5) Feedback explicativo y formativo, no solo "Correcto" o "Incorrecto"\n(6) Para secuencia_pro: steps en el orden correcto (order:1..N); el motor los mezclará al renderizar\n(7) Para checklist: al menos 4 items required de 8 totales';
}

// ── Prompts por tipo de archivo ────────────────────────────────────────────────
function buildLibroPrompt(type: string, D: NormalizedCourseData, ctx: string, modIdx?: number, capIdx?: number): string {
  const s = Math.random();
  if (type === 'ini') {
    return `${ctx}\n\nGenera SOLO las siguientes secciones del Libro Guía:\n\n## Presentación del Libro Guía\n3 párrafos: bienvenida al curso, contexto del sector ${D.sector} en ${D.pais}, qué encontrará el estudiante.\n\n## Información General del Curso\nTabla con: Nombre del curso, Unidad de competencia, Modalidad, Estructura (3 módulos · 9 capítulos · 80 horas), Año ${new Date().getFullYear()}.\n\n## Competencias a Desarrollar\n6 competencias concretas como bullets, cada una iniciando con verbo de acción (Diseñar, Aplicar, Utilizar, Analizar, Identificar, Estructurar).\n\nSemilla:${s}`;
  }
  if (type === 'mod' && modIdx !== undefined) {
    const m = D.mods[modIdx];
    return `${ctx}\n\nGenera la PRESENTACIÓN DEL MÓDULO ${modIdx + 1} — "${m.n}":\n- Descripción motivadora (2 párrafos, enfoque en ${D.sector} en ${D.pais}, tuteando al estudiante)\n- Tabla: Capítulo | Tema central | Horas aprox (8h cada uno)\nTotal del módulo: 24 horas.\nSemilla:${s}`;
  }
  if (type === 'cap' && capIdx !== undefined) {
    const cap = D.caps[capIdx];
    const modName = D.mods[cap.moduleNumber - 1]?.n ?? '';
    return `${ctx}\n\nGenera el CAPÍTULO ${cap.n} COMPLETO: "${cap.t}"\nMódulo ${cap.moduleNumber}: ${modName}\n\nIncluye:\n1. Secciones ${cap.n}.1 a ${cap.n}.5 — 250-400 palabras c/u, ejemplos reales de ${D.sector} en ${D.pais}, datos numéricos verificables\n2. Mínimo 1 tabla comparativa con datos del sector\n3. ■ Caso ${D.pais}: empresa real del sector aplicando el tema (en cursiva, con datos numéricos)\n4. ✏ Actividad de Apoyo ${cap.n}.1: ejercicio concreto con pasos numerados\n   ■■ Nota: actividad de apoyo, opcional, no subir a Moodle.\n5. ✏ Actividad de Apoyo ${cap.n}.2: segundo ejercicio práctico con pasos numerados\n   ■■ Nota: actividad de apoyo, opcional, no subir a Moodle.\n6. ■ Glosario del Capítulo: 8-12 términos con definición clara de 1-2 líneas cada uno\n\nNO generes portada ni tabla de contenido. Empieza directamente con # Capítulo...\nSemilla:${s}`;
  }
  if (type === 'bib') {
    return `${ctx}\n\nGenera la sección de EVALUACIÓN Y BIBLIOGRAFÍA:\n- Tabla evaluativa: foros 15% / quices 20% / talleres 25% / proyecto 30% / autoevaluación 10%\n- Criterios: 3.0/5.0, 80% actividades, proyecto mín 3.0\n- 6 libros reales sobre ${D.sector}\n- Normativa legal aplicable en ${D.pais} al sector ${D.sector}\n- 6 plataformas de formación gratuita del sector\n- 5 recursos digitales útiles\nSemilla:${s}`;
  }
  return `${ctx}\n\nGenera contenido de libro guía para: ${type}\nSemilla:${s}`;
}

function buildBienvenidaPrompt(D: NormalizedCourseData, ctx: string): string {
  const p = D.pal;
  return `${ctx}\n\nGenera seccion0_bienvenida.html — página de bienvenida al curso "${D.nombre}".\n\nESTRUCTURA (5 bloques, en orden, sin CTA al inicio):\n\n(1) HERO: div background:linear-gradient(160deg,#0A1A28,#0E2337,#12284A);border-radius:20px;padding:56px 44px;margin-bottom:12px\n  - Badge pill "${D.sector.toUpperCase()} · ${D.pais.toUpperCase()}" background:${p.accent}\n  - h1 dos líneas: primera blanca "Bienvenido a" · segunda color:${p.accent} "${D.nombre}"\n  - p motivador 15px, 2 líneas, color:rgba(226,230,243,0.55)\n\n(2) DATOS DEL CURSO: 4 chips en flex-wrap con datos concretos del curso (${D.horas}h totales, 3 módulos, 9 capítulos, nivel ${D.nivel})\n\n(3) QUÉ APRENDERÁS: 6 competencias del sector, grid 2 columnas, cada card con emoji + título bold + descripción breve\n\n(4) RECORRIDO DEL CURSO: 3 módulos con colores ${p.m1}, ${p.m2}, ${p.m3}, cada uno con sus 3 capítulos como bullets\nMódulos: ${D.mods.map((m, i) => `M${i + 1}: ${m.n} (${m.caps.join(', ')})`).join(' | ')}\n\n(5) CTA: "Ir al primer módulo" href="#scorm-cap-1" background:${p.accent}\n\nNUNCA sesskey. FRAGMENTO HTML sin DOCTYPE.`;
}

function buildVideoInteractivoPrompt(D: NormalizedCourseData, ctx: string, cap: NormalizedChapter): string {
  return `${ctx}\n\nGenera cap${cap.n}_video_interactivo.html. Cap ${cap.n}: "${cap.t}". Módulo ${cap.moduleNumber}: ${cap.moduleName}. Color módulo: ${cap.moduleHex}.\n\nESTRUCTURA EXACTA — en este orden:\n\n(1) HEADER: div background:rgba(255,255,255,0.04);border-radius:14px;padding:20px 24px;margin-bottom:16px\n  - Badge "MÓDULO ${cap.moduleNumber} · CAPÍTULO ${cap.n}" background:${cap.moduleHex};color:#fff;display:inline-block;padding:4px 12px;border-radius:20px;font-size:11px;font-weight:700\n  - h2 "${cap.t}" font-size:22px;font-weight:800;color:#E2E6F3\n  - Párrafo descripción motivadora del tema (2 líneas), color:rgba(226,230,243,0.75)\n\n(2) INSTRUCCIONES: div border-left:3px solid ${cap.moduleHex};padding:16px 20px;margin-bottom:16px\n  - 3 instrucciones en <ol style="margin:0;padding-left:20px;color:#E2E6F3;">\n\n(3) VIDEO PENDIENTE — PLACEHOLDER ESTÁTICO (NO usar padding-bottom:56%, NO position:absolute, NO height:0):\n  <div style="width:100%;min-height:200px;background:rgba(255,255,255,0.04);border-radius:12px;border:2px dashed rgba(255,255,255,0.15);display:flex;align-items:center;justify-content:center;flex-direction:column;gap:12px;margin-bottom:20px;box-sizing:border-box;">\n    <span style="font-size:40px;opacity:0.5;">▶</span>\n    <span style="color:rgba(226,230,243,0.5);font-size:14px;">Video en preparación</span>\n  </div>\n  CRÍTICO: NO insertes iframe. NO uses src con URL. NO uses position:absolute.\n\n(4) TEMAS CUBIERTOS: 5-6 chips en display:flex;flex-wrap:wrap;gap:8px;margin-bottom:20px\n  Cada chip: <span style="background:rgba(255,255,255,0.07);border-radius:16px;padding:6px 14px;font-size:13px;color:#E2E6F3;">\n\n(5) CTA FINAL — botón fluido:\n  <a href="#scorm-cap-${cap.n}" style="display:inline-block;background:${cap.moduleHex};color:#fff;padding:12px 24px;border-radius:10px;text-decoration:none;font-weight:700;font-size:15px;">🎮 Practicar ahora →</a>\n\nNUNCA sesskey. FRAGMENTO HTML sin DOCTYPE.`;
}

function buildScormDescPrompt(D: NormalizedCourseData, ctx: string, cap: NormalizedChapter): string {
  const mech = selectScormMechanic(cap);
  const mechLabel = mech === 'quiz_clasico' ? 'Quiz Clásico' : mech === 'checklist' ? 'Checklist Crítico' : 'Secuencia de Proceso';
  const mechDesc  = mech === 'quiz_clasico'
    ? 'preguntas de opción múltiple con feedback inmediato sobre el tema del capítulo'
    : mech === 'checklist'
    ? 'verificación de protocolos y procedimientos paso a paso'
    : 'ordenar correctamente los pasos de un procedimiento del sector';
  return `${ctx}\n\nGenera cap${cap.n}_descripcion_actividad.html. Cap ${cap.n}: "${cap.t}". Módulo ${cap.moduleNumber}.\n\nCOLORES: cap.hex=${cap.moduleHex} (fondos y border-left solamente) · cap.ac=${cap.moduleAc} (números y badges destacados)\nREGLA: NUNCA cap.hex como color de texto directo.\n\nESTRUCTURA:\n(1) Contenedor raíz: <div style="background:#0B1929;border-radius:20px;padding:28px;box-sizing:border-box;width:100%;max-width:100%;overflow:hidden;font-family:'Segoe UI',Arial,sans-serif;">\n(2) Badge: <span style="display:inline-block;background:${cap.moduleHex};color:#fff;padding:4px 14px;border-radius:20px;font-size:11px;font-weight:700;text-transform:uppercase;margin-bottom:16px;">🎮 ACTIVIDAD INTERACTIVA · CAPÍTULO ${cap.n}</span>\n(3) Título h2 "${cap.t}" + Descripción: qué practica el aprendiz en esta actividad gamificada (2 párrafos). Mecánica: ${mechLabel} — ${mechDesc}. NUNCA usar palabras "evaluación", "examen" ni "prueba". Usar: "actividad de práctica", "refuerzo", "caso práctico".\n(4) STATS — 4 chips en flex-wrap:\n    <div style="display:flex;flex-wrap:wrap;gap:12px;margin:20px 0;">\n    Cada chip: <div style="background:rgba(255,255,255,0.06);border-radius:10px;padding:12px 16px;min-width:80px;text-align:center;">\n      Número grande color:${cap.moduleAc} · label pequeño color:rgba(226,230,243,0.6)\n    Valores: "3" SALAS · "3" VIDAS · "70%" PARA APROBAR · "∞" INTENTOS\n(5) DINÁMICA — 2 cards en flex-wrap:\n    Cada card: <div style="flex:1 1 180px;background:rgba(255,255,255,0.04);border-left:3px solid ${cap.moduleHex};border-radius:8px;padding:14px;">\n    Card 1: qué hace el aprendiz (mecánica ${mechLabel})\n    Card 2: cómo se califica (+10 pts por respuesta correcta, 3 vidas, 70% para aprobar)\n(6) CTA: <a href="#scorm-cap-${cap.n}" style="display:inline-block;background:${cap.moduleAc};color:#000;padding:12px 24px;border-radius:10px;text-decoration:none;font-weight:700;">▶ Iniciar Actividad →</a>\n\nNUNCA sesskey. NUNCA "evaluación", "examen", "prueba". FRAGMENTO HTML sin DOCTYPE.`;
}

function buildExamenDescPrompt(D: NormalizedCourseData, ctx: string, unitNum: number): string {
  const p = D.pal;
  const mod = D.mods[unitNum - 1];
  const modHex = unitNum === 1 ? p.m1 : unitNum === 2 ? p.m2 : p.m3;
  return `${ctx}\n\nGenera examen_unidad${unitNum}_descripcion.html para el módulo ${unitNum}: "${mod?.n ?? ''}".\n\nESTRUCTURA:\n(1) HERO: badge "📝 EXAMEN UNIDAD ${unitNum}" background:${modHex} · h2 · p descriptivo\n(2) STATS: "25" PREGUNTAS · "45" MIN · "70%" APROBACIÓN · "3" INTENTOS\n(3) Temas evaluados: los 3 capítulos del módulo como bullets\n(4) Recomendaciones de preparación (2-3 tips)\n(5) CTA: <a href="#exam-unit-${unitNum}">Ir al Examen →</a> background:${modHex}\n\nMódulo: ${mod?.caps?.join(', ') ?? ''}\nNUNCA sesskey. FRAGMENTO HTML sin DOCTYPE.`;
}

function buildExamenFinalDescPrompt(D: NormalizedCourseData, ctx: string): string {
  const p = D.pal;
  return `${ctx}\n\nGenera examen_final_descripcion.html para el curso "${D.nombre}".\n\nESTRUCTURA:\n(1) HERO: badge "🏆 EVALUACIÓN FINAL DEL CURSO" background:${p.m2} · h2 "Examen Final: ${D.nombre}" · p descriptivo\n(2) STATS tabla 4 celdas: "50" PREGUNTAS · "90" MINUTOS · "70%" APROBACIÓN · "1" INTENTO\n(3) CONTENIDO POR MÓDULO: 3 filas con badge + nombre módulo + 3 temas evaluados\nMódulos: ${D.mods.map((m, i) => `M${i + 1}: ${m.n} — ${m.caps.join(', ')}`).join(' | ')}\n(4) Recomendaciones (3 cards)\n(5) CTA: <a href="#exam-final">🏆 Ir al Examen Final →</a> background:linear-gradient(135deg,${p.m2},${p.accent})\n\nNUNCA sesskey. FRAGMENTO HTML sin DOCTYPE.`;
}

function buildRutaAprendizajePrompt(D: NormalizedCourseData, ctx: string): string {
  const p = D.pal;
  return `${ctx}\n\nGenera seccion1_ruta_aprendizaje.html — ruta de aprendizaje del curso "${D.nombre}".\n\nLAYOUT OBLIGATORIO — sigue exactamente esta estructura:\n\n(1) WRAPPER RAÍZ: <div style="background:#0A1628;border-radius:20px;padding:24px;box-sizing:border-box;width:100%;max-width:100%;overflow-x:hidden;font-family:'Segoe UI',Arial,sans-serif;color:#E2E6F3;">\n\n(2) TÍTULO: <h2 style="color:#E2E6F3;font-size:22px;margin:0 0 20px;">Ruta de Aprendizaje</h2>\n\n(3) MÓDULOS — 3 bloques VERTICALES en columna, usando display:flex;flex-direction:column;gap:16px\n    Cada módulo es una tarjeta: <div style="background:rgba(255,255,255,0.05);border-left:4px solid COLOR_MODULO;border-radius:12px;padding:18px 20px;">\n    Dentro: badge de color (pill pequeño), nombre del módulo en h3, y los 3 capítulos como lista <ol> con números del 1 al 9 globales.\n    Colores: M1=${p.m1}, M2=${p.m2}, M3=${p.m3}\n\n(4) RECURSOS — al final, 4 chips en flex-wrap: Libro Guía · Audiolibro · Videos Interactivos · Actividades Gamificadas\n    Cada chip: <span style="display:inline-block;background:rgba(255,255,255,0.08);border-radius:20px;padding:6px 14px;font-size:13px;margin:4px;">\n\nPROHIBIDO en esta página: grid con columnas fijas · flex-direction:row en módulos · position:absolute · anchos en px · min-width > 200px\n\nMódulos: ${D.mods.map((m, i) => `M${i + 1}: ${m.n} — ${m.caps.join(' | ')}`).join(' | ')}\n\nNUNCA sesskey. FRAGMENTO HTML sin DOCTYPE.`;
}

function buildLibroGuiaPrompt(D: NormalizedCourseData, ctx: string): string {
  const p = D.pal;
  return `${ctx}\n\nGenera seccion1_libro_guia.html — página de presentación del Libro Guía del curso "${D.nombre}".\n\nIncluye: descripción del libro, qué contiene (${D.horas}h de contenido, 3 módulos, 9 capítulos con casos reales, glosarios, actividades), beneficios clave, y CTA: <a href="#libro-guia">📚 Descargar Libro Guía →</a> background:${p.m1}\n\nNUNCA sesskey. FRAGMENTO HTML sin DOCTYPE.`;
}

function buildAudioBienvenidaPrompt(D: NormalizedCourseData, ctx: string): string {
  const p = D.pal;
  return `${ctx}\n\nGenera seccion0_audio_bienvenida.html — página del audio de bienvenida del curso "${D.nombre}".\n\nESTRUCTURA (4 bloques):\n(1) HERO: badge "🎧 Audio de Bienvenida" background:${p.accent} · h1 motivador 2 líneas · p bienvenida del instructor en ${D.sector}\n(2) REPRODUCTOR: tarjeta con <audio controls style="width:100%;height:48px;border-radius:10px;accent-color:${p.accent}"><source src="#audio" type="audio/mpeg">Tu navegador no soporta audio.</audio>\n(3) QUÉ ESCUCHARÁS: 4 bullets con los temas del audio (presentación instructor, estructura módulos, metodología, perfil egresado)\n(4) CTA: "Comenzar Módulo 1" href="#scorm-cap-1" background:${p.accent}\n\nNUNCA escribas "Próximamente". FRAGMENTO HTML sin DOCTYPE.`;
}

function buildAudiolibropPrompt(D: NormalizedCourseData, ctx: string): string {
  const p = D.pal;
  return `${ctx}\n\nGenera seccion1_audiolibro.html — página del audiolibro del curso "${D.nombre}".\n\nIncluye: header con badge "📻 Audiolibro del Curso" · descripción motivadora · <audio controls style="width:100%;"><source src="#audio" type="audio/mpeg">Tu navegador no soporta audio.</audio> · beneficios de escuchar el audiolibro · CTA para continuar al curso.\n\nColor acento: ${p.accent}. NUNCA escribas "Próximamente". FRAGMENTO HTML sin DOCTYPE.`;
}

function buildGiftPrompt(D: NormalizedCourseData, ctx: string, unitNum: number | 'final'): string {
  if (unitNum === 'final') {
    const topics = D.caps.map(c => c.t).join(', ');
    return `${ctx}\n\nGenera el EXAMEN FINAL del curso "${D.nombre}" en formato GIFT para Moodle.\n\n50 preguntas integrando los 3 módulos. Distribución:\n- Módulo 1 (${D.mods[0]?.n}): 17 preguntas\n- Módulo 2 (${D.mods[1]?.n}): 17 preguntas\n- Módulo 3 (${D.mods[2]?.n}): 16 preguntas\n\nVariedad: 30 selección múltiple + 10 V/F + 5 emparejamiento + 5 completar\nTodos sobre: ${topics}\nPaís: ${D.pais}, Sector: ${D.sector}\nIDs: ::EF-01:: ... ::EF-50::\nSOLO GIFT puro.`;
  }
  const mod = D.mods[unitNum - 1];
  const caps = mod?.caps ?? [];
  return `${ctx}\n\nGenera el EXAMEN UNIDAD ${unitNum} — "${mod?.n ?? ''}" en formato GIFT para Moodle.\n\n25 preguntas sobre: ${caps.join(' | ')}\nVariedad: 15 selección múltiple + 5 V/F + 3 emparejamiento + 2 completar\nPaís: ${D.pais}, Sector: ${D.sector}\nIDs: ::U${unitNum}-01:: ... ::U${unitNum}-25::\nSOLO GIFT puro.`;
}

// ── Main generation function ──────────────────────────────────────────────────
export async function generateCourseContent(
  inputPayload: ContentGenerationInputPayload,
  callbacks?: ContentGenerationCallbacks,
): Promise<GeneratedCourseContentResult> {
  const logger = new Logger('ContentGeneration');

  if (!inputPayload?.courseData) throw new Error('inputPayload.courseData is required');

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    logger.warn('ANTHROPIC_API_KEY not set — falling back to template generation');
    return generateFromTemplates(inputPayload, callbacks);
  }

  const anthropic  = new Anthropic({ apiKey, timeout: 120_000 });
  const model      = inputPayload.contentConfig?.model ?? DEFAULT_MODEL;
  const maxRetries = inputPayload.contentConfig?.maxRetriesPerFile ?? MAX_RETRIES;
  const startedAt  = Date.now();
  const normalized = buildNormalizedCourseData(inputPayload.courseData);
  const D          = normalized;
  const F: Record<string, string> = {};
  const errors: string[] = [];

  let totalTokensInput  = 0;
  let totalTokensOutput = 0;

  const progressMap: Record<PhaseKey, { done: number; total: number }> = {
    libro:    { done: 0, total: PHASE_TOTALS.libro },
    paginas:  { done: 0, total: PHASE_TOTALS.paginas },
    scorms:   { done: 0, total: PHASE_TOTALS.scorms },
    examenes: { done: 0, total: PHASE_TOTALS.examenes },
  };

  let lastFile: string | null = null;

  // ── Helper: call Claude with retry ─────────────────────────────────────────
  async function callClaude(
    system: string,
    user: string,
    maxTokens: number,
    label: string,
  ): Promise<string> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const response = await anthropic.messages.create({
          model,
          max_tokens: maxTokens,
          system,
          messages: [{ role: 'user', content: user }],
        });
        const text = response.content[0].type === 'text' ? response.content[0].text : '';
        totalTokensInput  += response.usage.input_tokens;
        totalTokensOutput += response.usage.output_tokens;
        return text;
      } catch (err: any) {
        const isRetryable = err?.status === 429 || err?.status >= 500;
        if (attempt < maxRetries && isRetryable) {
          const wait = Math.min(2000 * Math.pow(2, attempt), 30000);
          logger.warn(`[${label}] attempt ${attempt + 1} failed (${err?.status}), retrying in ${wait}ms`);
          await new Promise(r => setTimeout(r, wait));
        } else {
          throw err;
        }
      }
    }
    throw new Error(`All retries exhausted for ${label}`);
  }

  // ── Helper: add file with progress ─────────────────────────────────────────
  async function addFile(phase: PhaseKey, filename: string, content: string, message: string): Promise<void> {
    F[filename] = content;
    progressMap[phase].done += 1;
    lastFile = filename;
    await callbacks?.onProgress?.({
      phase,
      done:  progressMap[phase].done,
      total: progressMap[phase].total,
      file:  filename,
      message,
      tokensUsed: { input: totalTokensInput, output: totalTokensOutput },
    });
  }

  const ctx = buildCourseContext(D);
  const sysL = buildLibroSystemPrompt(D);
  const sysH = buildHtmlSystemPrompt(D);
  const sysG = buildGiftSystemPrompt();
  const sysS = buildScormSystemPrompt();

  // ════════════════════════════════════════════════════════════════
  // FASE 1: LIBRO GUÍA — 14 archivos, concurrencia 3
  // ════════════════════════════════════════════════════════════════

  const libroTaskDefs = [
    {
      filename: 'libro_inicio.md',
      fn: () => callClaude(sysL, buildLibroPrompt('ini', D, ctx), 4096, 'libro_inicio'),
      message: 'Libro: portada e introducción',
      fallback: `# Introducción\nContenido del curso ${D.nombre}`,
    },
    ...D.mods.map((mod, mi) => ({
      filename: `libro_mod${mi + 1}.md`,
      fn: () => callClaude(sysL, buildLibroPrompt('mod', D, ctx, mi), 2048, `libro_mod${mi + 1}`),
      message: `Libro: módulo ${mi + 1}`,
      fallback: `# Módulo ${mi + 1}: ${mod.n}\n\nContenido del módulo.`,
    })),
    ...D.caps.map((cap, ci) => ({
      filename: `libro_cap${cap.n}.md`,
      fn: () => callClaude(sysL, buildLibroPrompt('cap', D, ctx, undefined, ci), 8192, `libro_cap${cap.n}`),
      message: `Libro: capítulo ${cap.n}`,
      fallback: `# Capítulo ${cap.n}: ${cap.t}\n\nContenido del capítulo.`,
    })),
    {
      filename: 'libro_biblio.md',
      fn: () => callClaude(sysL, buildLibroPrompt('bib', D, ctx), 2048, 'libro_biblio'),
      message: 'Libro: evaluación y bibliografía',
      fallback: `# Evaluación y Bibliografía\nRecursos del curso ${D.nombre}`,
    },
  ];

  const libroResults = await gatherParallel(libroTaskDefs.map(t => t.fn), LIBRO_CONCURRENCY);

  for (let i = 0; i < libroTaskDefs.length; i++) {
    const { filename, message, fallback } = libroTaskDefs[i];
    const result = libroResults[i];
    if (!result.ok) {
      errors.push(`${filename}: ${(result as { ok: false; error: Error }).error.message}`);
      await addFile('libro', filename, fallback, `${message} (fallback)`);
    } else {
      await addFile('libro', filename, result.value, message);
    }
  }

  // ════════════════════════════════════════════════════════════════
  // FASE 2: PÁGINAS HTML
  // ════════════════════════════════════════════════════════════════

  const htmlPages: Array<{ filename: string; prompt: () => Promise<string>; message: string }> = [
    {
      filename: 'seccion0_bienvenida.html',
      prompt: async () => callClaude(sysH, buildBienvenidaPrompt(D, ctx), 8192, 'bienvenida'),
      message: 'Página: bienvenida',
    },
    {
      filename: 'seccion0_audio_bienvenida.html',
      prompt: async () => callClaude(sysH, buildAudioBienvenidaPrompt(D, ctx), 4096, 'audio_bienvenida'),
      message: 'Página: audio bienvenida',
    },
    {
      filename: 'seccion0_metodologia.html',
      prompt: async () => callClaude(sysH,
        `${ctx}\n\nGenera seccion0_metodologia.html — cómo funciona el curso "${D.nombre}".\n4 cards 2×2: 🎬 Videos Interactivos · 📖 Libro Guía · 🎮 Actividades Gamificadas · ✅ Exámenes por Módulo.\nAbajo: flujo de aprendizaje en 4 pasos. NUNCA escribir "H5P", "SCORM". FRAGMENTO HTML sin DOCTYPE.`,
        4096, 'metodologia'),
      message: 'Página: metodología',
    },
    {
      filename: 'seccion1_ruta_aprendizaje.html',
      prompt: async () => callClaude(sysH, buildRutaAprendizajePrompt(D, ctx), 4096, 'ruta_aprendizaje'),
      message: 'Página: ruta de aprendizaje',
    },
    {
      filename: 'seccion1_libro_guia.html',
      prompt: async () => callClaude(sysH, buildLibroGuiaPrompt(D, ctx), 4096, 'libro_guia_desc'),
      message: 'Página: libro guía',
    },
    {
      filename: 'seccion1_audiolibro.html',
      prompt: async () => callClaude(sysH, buildAudiolibropPrompt(D, ctx), 4096, 'audiolibro_desc'),
      message: 'Página: audiolibro',
    },
  ];

  // Páginas por capítulo
  for (const cap of D.caps) {
    htmlPages.push({
      filename: `cap${cap.n}_video_interactivo.html`,
      prompt: async () => {
        const c = cap; // capture
        return callClaude(sysH, buildVideoInteractivoPrompt(D, ctx, c), 8192, `video_cap${c.n}`);
      },
      message: `Página: video capítulo ${cap.n}`,
    });
  }

  // Descripciones de actividades SCORM
  for (const cap of D.caps) {
    htmlPages.push({
      filename: `cap${cap.n}_descripcion_actividad.html`,
      prompt: async () => {
        const c = cap;
        return callClaude(sysH, buildScormDescPrompt(D, ctx, c), 4096, `scorm_desc_cap${c.n}`);
      },
      message: `Página: actividad capítulo ${cap.n}`,
    });
  }

  // Descripciones de exámenes de unidad
  for (let unit = 1; unit <= 3; unit++) {
    const u = unit;
    htmlPages.push({
      filename: `examen_unidad${u}_descripcion.html`,
      prompt: async () => callClaude(sysH, buildExamenDescPrompt(D, ctx, u), 4096, `examen_desc_${u}`),
      message: `Página: descripción examen unidad ${u}`,
    });
  }

  // Examen final descripción
  htmlPages.push({
    filename: 'examen_final_descripcion.html',
    prompt: async () => callClaude(sysH, buildExamenFinalDescPrompt(D, ctx), 4096, 'examen_final_desc'),
    message: 'Página: descripción examen final',
  });

  // ── Páginas: correr en paralelo, escribir en orden de definición ───────────
  const paginaResults = await gatherParallel(
    htmlPages.map(page => async () => {
      let html = await page.prompt();
      html = html.replace(/<style[\s\S]*?<\/style>/gi, '');
      html = html.replace(/<script[\s\S]*?<\/script>/gi, '');
      html = html.replace(/^```html\s*/i, '').replace(/\s*```$/, '');
      return html;
    }),
    PAGINAS_CONCURRENCY,
  );

  for (let i = 0; i < htmlPages.length; i++) {
    const { filename, message } = htmlPages[i];
    const result = paginaResults[i];
    if (!result.ok) {
      errors.push(`${filename}: ${(result as { ok: false; error: Error }).error.message}`);
      const fallback = `<div style="background:#0A1628;border-radius:20px;padding:32px;color:#E2E6F3;font-family:'Segoe UI',Arial,sans-serif;"><p style="color:#E2E6F3;">${escapeHtml(filename)}</p></div>`;
      await addFile('paginas', filename, fallback, `${message} (fallback)`);
    } else {
      await addFile('paginas', filename, result.value, message);
    }
  }

  // ════════════════════════════════════════════════════════════════
  // FASE 3: SCORMs — 9 actividades IA, concurrencia 3
  // Manifests son determinísticos — van directo a F sin evento de progreso.
  // Un fallo tras retry es fatal (no hay fallback: propaga error al job).
  // ════════════════════════════════════════════════════════════════
  const scormTaskResults = await gatherParallel(
    D.caps.map(cap => async () => {
      const mechanic = selectScormMechanic(cap);
      const scormPrompt = buildScormDataPrompt(D, ctx, cap);
      let raw = '';

      // Attempt 1: API call (retry on API error)
      try {
        raw = await callClaude(sysS, scormPrompt, 6000, `scorm_cap${cap.n}`);
      } catch (firstErr: any) {
        logger.warn(`[scorm_cap${cap.n}] attempt 1 failed (${firstErr.message}), retrying after 5s`);
        await new Promise(r => setTimeout(r, 5000));
        try {
          raw = await callClaude(sysS, scormPrompt, 6000, `scorm_cap${cap.n}_retry`);
        } catch (retryErr: any) {
          throw new Error(`SCORM cap ${cap.n} falló tras 2 intentos: ${retryErr.message}`);
        }
      }

      // Parse and validate content quality
      let data = parseScormGameData(raw, cap);
      const placeholderReason = isScormPlaceholder(data);
      if (placeholderReason) {
        logger.warn(`[scorm_cap${cap.n}] placeholder detectado (${placeholderReason}) — reintentando con prompt reforzado`);
        await new Promise(r => setTimeout(r, 3000));
        const reinforcedPrompt = scormPrompt + `\n\n⚠️ RECHAZO PREVIO: El intento anterior devolvió contenido placeholder (${placeholderReason}). Preguntas genéricas como "Pregunta de práctica sobre..." y opciones "Respuesta A/B/C/D" NO son aceptables. GENERA contenido REAL y ESPECÍFICO sobre "${cap.t}" en el sector ${D.sector}, ${D.pais}. Cada pregunta debe citar conceptos técnicos reales con opciones que sean términos del campo profesional. Mínimo 3 salas con mínimo 3 preguntas cada una.`;
        let retryRaw = '';
        try {
          retryRaw = await callClaude(sysS, reinforcedPrompt, 6000, `scorm_cap${cap.n}_content_retry`);
        } catch (retryErr: any) {
          throw new Error(`SCORM cap ${cap.n}: placeholder + retry API falló: ${retryErr.message}`);
        }
        const retryData = parseScormGameData(retryRaw, cap);
        const retryPlaceholder = isScormPlaceholder(retryData);
        if (retryPlaceholder) {
          throw new Error(`SCORM cap ${cap.n}: contenido placeholder tras 2 generaciones (${retryPlaceholder})`);
        }
        data = retryData;
      }

      return { cap, data, mechanic };
    }),
    SCORM_CONCURRENCY,
  );

  for (let i = 0; i < scormTaskResults.length; i++) {
    const result = scormTaskResults[i];
    if (!result.ok) throw (result as { ok: false; error: Error }).error;
    const { cap, data, mechanic } = result.value;
    await addFile('scorms', `scorm_cap${cap.n}_index.html`, createScormGameHtml(cap, data, mechanic), `SCORM: cap ${cap.n}`);
    F[`scorm_cap${cap.n}_manifest.xml`] = createScormManifest(cap);
  }

  // ════════════════════════════════════════════════════════════════
  // FASE 4: EXÁMENES GIFT — 3 unidades + final, concurrencia 3
  // Fallback a gift vacío si IA falla (no es fatal para el job).
  // ════════════════════════════════════════════════════════════════
  type ExamenTask = { filename: string; content: string; message: string; error?: string };

  const examenTaskDefs: Array<{ fn: () => Promise<ExamenTask> }> = [
    ...([1, 2, 3] as const).map(u => ({
      fn: async (): Promise<ExamenTask> => {
        const filename = `examen_unidad${u}.gift`;
        try {
          const gift = await callClaude(sysG, buildGiftPrompt(D, ctx, u), 4096, `examen_u${u}`);
          return { filename, content: gift.trim(), message: `Examen: unidad ${u}` };
        } catch (e: any) {
          return { filename, content: createFallbackGift(u, D), message: `Examen: unidad ${u} (fallback)`, error: e.message };
        }
      },
    })),
    {
      fn: async (): Promise<ExamenTask> => {
        try {
          const gift = await callClaude(sysG, buildGiftPrompt(D, ctx, 'final'), 6144, 'examen_final');
          return { filename: 'examen_final.gift', content: gift.trim(), message: 'Examen: final' };
        } catch (e: any) {
          return { filename: 'examen_final.gift', content: createFallbackGift('final', D), message: 'Examen: final (fallback)', error: e.message };
        }
      },
    },
  ];

  const examenResults = await gatherParallel(examenTaskDefs.map(t => t.fn), EXAMEN_CONCURRENCY);

  for (let i = 0; i < examenResults.length; i++) {
    const result = examenResults[i];
    if (!result.ok) throw (result as { ok: false; error: Error }).error;
    const { filename, content, message, error } = result.value;
    if (error) errors.push(`${filename}: ${error}`);
    await addFile('examenes', filename, content, message);
  }

  // Also generate the compiled book HTML
  const libroHtmlContent = compileBookHtml(normalized, F);
  F['libro_guia_completo.html'] = libroHtmlContent;

  const summary: GeneratedCourseContentSummary = {
    mode: 'claude',
    generatedAt: new Date().toISOString(),
    durationMs:  Date.now() - startedAt,
    fileCount:   Object.keys(F).length,
    filesGenerated: Object.keys(F).length,
    phases: (['libro', 'paginas', 'scorms', 'examenes'] as PhaseKey[]).map(phase => ({
      phase,
      generated: progressMap[phase].done,
      total:     progressMap[phase].total,
    })),
    progressMap,
    lastFile,
    errors,
    tokensInput:  totalTokensInput,
    tokensOutput: totalTokensOutput,
  };

  logger.log(`Content generation complete: ${Object.keys(F).length} files, ${totalTokensInput}/${totalTokensOutput} tokens, ${errors.length} errors`);

  return { D: inputPayload.courseData, F, summary };
}

// ── Template fallbacks (kept for when Claude is unavailable) ─────────────────
function generateFromTemplates(
  inputPayload: ContentGenerationInputPayload,
  callbacks?: ContentGenerationCallbacks,
): Promise<GeneratedCourseContentResult> {
  const logger = new Logger('ContentGeneration');
  logger.warn('Using template generation (no ANTHROPIC_API_KEY)');

  const startedAt = Date.now();
  const normalized = buildNormalizedCourseData(inputPayload.courseData);
  const F: Record<string, string> = {};
  const progressMap = {
    libro:    { done: 0, total: PHASE_TOTALS.libro },
    paginas:  { done: 0, total: PHASE_TOTALS.paginas },
    scorms:   { done: 0, total: PHASE_TOTALS.scorms },
    examenes: { done: 0, total: PHASE_TOTALS.examenes },
  };
  let lastFile: string | null = null;

  async function addFile(phase: PhaseKey, filename: string, content: string, message: string) {
    F[filename] = content;
    progressMap[phase].done += 1;
    lastFile = filename;
    await callbacks?.onProgress?.({ phase, done: progressMap[phase].done, total: progressMap[phase].total, file: filename, message });
  }

  return (async () => {
    await addFile('libro', 'libro_inicio.md', createBookIntroMarkdown(normalized), 'Libro: portada e introduccion');
    for (let i = 0; i < normalized.mods.length; i++) {
      await addFile('libro', `libro_mod${i + 1}.md`, createModuleMarkdown(normalized, normalized.mods[i], i), `Libro: modulo ${i + 1}`);
    }
    for (const cap of normalized.caps) {
      await addFile('libro', `libro_cap${cap.n}.md`, createChapterMarkdown(normalized, cap), `Libro: capitulo ${cap.n}`);
    }
    await addFile('libro', 'libro_biblio.md', `# Evaluación y Bibliografía\n\nRecursos para ${normalized.nombre}`, 'Libro: biblio');

    for (const fn of ['seccion0_bienvenida.html','seccion0_audio_bienvenida.html','seccion0_metodologia.html']) {
      await addFile('paginas', fn, createSimplePage(normalized.nombre, `<p>Sección de bienvenida e introducción al curso.</p><audio controls style="width:100%;"><source src="#audio" type="audio/mpeg"/>Tu navegador no soporta audio.</audio>`, 'Bienvenida'), `Pagina: ${fn}`);
    }
    await addFile('paginas', 'seccion1_ruta_aprendizaje.html', createSimplePage('Ruta de Aprendizaje', `<p>Estructura del curso: 3 módulos, 9 capítulos.</p>`), 'Pagina: ruta');
    await addFile('paginas', 'seccion1_libro_guia.html', createSimplePage('Libro Guía', `<p>Libro guía completo del curso.</p><a href="#libro-guia" style="color:#4A7DFF;">Descargar PDF</a>`), 'Pagina: libro guia');
    await addFile('paginas', 'seccion1_audiolibro.html', createSimplePage('Audiolibro', `<p>Audiolibro del curso.</p><audio controls style="width:100%;"><source src="#audio" type="audio/mpeg"/>Tu navegador no soporta audio.</audio>`, 'Audiolibro'), 'Pagina: audiolibro');

    for (const cap of normalized.caps) {
      const vp = `<div style="background:#0A1628;border-radius:20px;padding:24px;color:#E2E6F3;font-family:'Segoe UI',Arial,sans-serif;box-sizing:border-box;width:100%;max-width:100%;overflow-x:hidden;"><h2 style="color:#E2E6F3;font-size:20px;margin:0 0 16px;">Capítulo ${cap.n}: ${escapeHtml(cap.t)}</h2><div style="width:100%;min-height:200px;background:rgba(255,255,255,0.04);border-radius:12px;border:2px dashed rgba(255,255,255,0.15);display:flex;align-items:center;justify-content:center;flex-direction:column;gap:12px;margin-bottom:20px;box-sizing:border-box;"><span style="font-size:40px;opacity:0.5;">▶</span><span style="color:rgba(226,230,243,0.5);font-size:14px;">Video en preparación</span></div></div>`;
      await addFile('paginas', `cap${cap.n}_video_interactivo.html`, vp, `Pagina: video cap ${cap.n}`);
      await addFile('paginas', `cap${cap.n}_descripcion_actividad.html`,
        createSimplePage(`Actividad Capítulo ${cap.n}`, `<p>Actividad gamificada: ${escapeHtml(cap.t)}</p><a href="#scorm-cap-${cap.n}" style="color:#4A7DFF;">Iniciar actividad →</a>`, `Capítulo ${cap.n}`),
        `Pagina: descripcion cap ${cap.n}`);
    }
    for (let unit = 1; unit <= 3; unit++) {
      const mod = normalized.mods[unit - 1];
      await addFile('paginas', `examen_unidad${unit}_descripcion.html`,
        createSimplePage(`Evaluacion de unidad ${unit}`, `<p>Esta evaluacion cubre los capitulos de <strong>${escapeHtml(mod.n)}</strong>.</p><ul>${mod.caps.map(cap => `<li>${escapeHtml(cap)}</li>`).join('')}</ul><p><a href="#exam-unit-${unit}" style="color:#4A7DFF;">Ir al examen →</a></p>`, `Unidad ${unit}`),
        `Pagina: descripcion examen unidad ${unit}`);
    }
    await addFile('paginas', 'examen_final_descripcion.html', createSimplePage('Examen Final', `<p>Evaluacion integradora.</p><p><a href="#exam-final" style="color:#4A7DFF;">Ir al examen final →</a></p>`, 'Cierre'), 'Pagina: examen final desc');

    for (const cap of normalized.caps) {
      await addFile('scorms', `scorm_cap${cap.n}_index.html`,   createScormIndex(normalized, cap), `SCORM: index cap ${cap.n}`);
      await addFile('scorms', `scorm_cap${cap.n}_manifest.xml`, createScormManifest(cap),          `SCORM: manifest cap ${cap.n}`);
    }

    for (let unit = 1; unit <= 3; unit++) {
      await addFile('examenes', `examen_unidad${unit}.gift`, createFallbackGift(unit, normalized), `Examen: unidad ${unit}`);
    }
    await addFile('examenes', 'examen_final.gift', createFallbackGift('final', normalized), 'Examen: final');

    F['libro_guia_completo.html'] = compileBookHtml(normalized, F);

    return {
      D: inputPayload.courseData,
      F,
      summary: {
        mode: 'template' as const,
        generatedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
        fileCount: Object.keys(F).length,
        filesGenerated: Object.keys(F).length,
        phases: (['libro','paginas','scorms','examenes'] as PhaseKey[]).map(p => ({ phase: p, generated: progressMap[p].done, total: progressMap[p].total })),
        progressMap,
        lastFile,
        errors: [],
        tokensInput: 0,
        tokensOutput: 0,
      },
    };
  })();
}

// ── Template helpers ──────────────────────────────────────────────────────────
function createSimplePage(title: string, body: string, eyebrow?: string): string {
  return `<div style="background:#0f1d2d;border-radius:18px;padding:28px 30px;color:#e5eef8;font-family:Arial,sans-serif;">
  ${eyebrow ? `<div style="font-size:12px;text-transform:uppercase;letter-spacing:1px;color:#8fb5e0;margin-bottom:10px;">${escapeHtml(eyebrow)}</div>` : ''}
  <h2 style="margin:0 0 12px;color:#e5eef8;">${escapeHtml(title)}</h2>
  ${body}
</div>`;
}

function createBookIntroMarkdown(D: NormalizedCourseData): string {
  return `# ${D.nombre}\n\n## Presentación\n\nBienvenido al curso ${D.nombre}. Este libro guía es tu referencia principal.\n\n## Información General\n\n| Campo | Valor |\n|-------|-------|\n| Curso | ${D.nombre} |\n| Sector | ${D.sector} |\n| País | ${D.pais} |\n| Duración | ${D.horas} horas |\n| Estructura | 3 módulos · 9 capítulos |\n\n## Competencias\n\n${D.mods.map(m => `- Aplicar los conceptos de ${m.n}`).join('\n')}\n`;
}

function createModuleMarkdown(D: NormalizedCourseData, mod: NormalizedModule, idx: number): string {
  return `# Módulo ${idx + 1}: ${mod.n}\n\n${mod.caps.map((cap, ci) => `## Capítulo ${idx * 3 + ci + 1}: ${cap}\n\nContenido del capítulo sobre ${cap} aplicado al sector ${D.sector} en ${D.pais}.\n`).join('\n')}\n`;
}

function createChapterMarkdown(D: NormalizedCourseData, cap: NormalizedChapter): string {
  return `# Capítulo ${cap.n}: ${cap.t}\n\n## Introducción\n\nEste capítulo cubre ${cap.t} aplicado al sector ${D.sector} en ${D.pais}.\n\n## Contenido Principal\n\nDesarrollo del tema con ejemplos prácticos del sector.\n\n## Glosario\n\n- **Término 1**: Definición relevante al sector.\n- **Término 2**: Definición relevante al sector.\n`;
}

function compileBookHtml(D: NormalizedCourseData, F: Record<string, string>): string {
  const parts: string[] = [];
  const allKeys = ['libro_inicio.md', ...D.mods.map((_, i) => `libro_mod${i+1}.md`),
    ...D.caps.map(c => `libro_cap${c.n}.md`), 'libro_biblio.md'];
  for (const key of allKeys) {
    if (F[key]) parts.push(`<section>\n<pre style="white-space:pre-wrap;font-family:inherit;">${escapeHtml(F[key])}</pre>\n</section>`);
  }
  return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><title>Libro Guía — ${escapeHtml(D.nombre)}</title></head><body style="font-family:'Segoe UI',Arial,sans-serif;background:#0A1628;color:#E2E6F3;padding:32px;">${parts.join('\n')}</body></html>`;
}

function createScormIndex(D: NormalizedCourseData, cap: NormalizedChapter): string {
  const hex = cap.moduleHex;
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>SCORM Cap ${cap.n}</title><style>body{font-family:Arial,sans-serif;background:#08111c;color:#e5eef8;margin:0;padding:24px}.card{max-width:880px;margin:0 auto;background:#0f1d2d;border-radius:18px;padding:24px}.badge{display:inline-block;padding:4px 14px;border-radius:50px;background:${hex};color:#fff;font-size:11px;font-weight:700;text-transform:uppercase;margin-bottom:16px}h2{margin:0 0 12px;font-size:22px}p{color:rgba(229,238,248,.7);line-height:1.6}.btn{display:inline-block;margin-top:20px;padding:12px 28px;background:${hex};color:#fff;border-radius:10px;text-decoration:none;font-weight:700}</style></head><body><div class="card" id="scorm-cap-${cap.n}"><span class="badge">Módulo ${cap.moduleNumber} · Capítulo ${cap.n}</span><h2>${escapeHtml(cap.t)}</h2><p>Actividad gamificada del capítulo ${cap.n}. Completa las preguntas para ganar puntos y avanzar al siguiente capítulo.</p><a class="btn" href="#" onclick="top.API&&(top.API.LMSSetValue('cmi.core.lesson_status','completed'),top.API.LMSCommit(''));return false;">Completar actividad ✓</a></div><script>try{var api=top.API||parent.API;if(api){api.LMSInitialize('');api.LMSSetValue('cmi.core.lesson_status','incomplete');}}catch(e){}</script></body></html>`;
}

function createScormGameHtml(cap: NormalizedChapter, data: ScormGameData, mechanic: ScormMechanic): string {
  const hex      = cap.moduleHex;
  const ac       = cap.moduleAc;
  const gameName = data.gameName || cap.t;
  const tagline  = data.tagline  || `Refuerzo del capítulo ${cap.n}`;
  const emoji    = data.emoji    || '🎮';
  const sc       = data.scenario || { location: '', character: '', intro: '' };
  const salas    = (data.salas ?? []).slice(0, 5);
  const numSalas = Math.max(1, salas.length);
  const maxPts   = salas.reduce((sum, s) => sum + (s.preguntas?.length ?? 0) * 10, 0) || numSalas * 40;

  // Build embedded PREGUNTAS JS object
  let pregJs = 'var PREGUNTAS={\n';
  for (let i = 0; i < salas.length; i++) {
    const pqs = salas[i]?.preguntas ?? [];
    pregJs += `  sala${i + 1}:${safeJsonEmbed(pqs)}${i < salas.length - 1 ? ',' : ''}\n`;
  }
  pregJs += '};';

  // Build sala + between-sala screens HTML
  let salaHtml = '';
  for (let i = 1; i <= numSalas; i++) {
    const salaName = salas[i - 1]?.name ?? `Sala ${i}`;
    salaHtml += `\n<div id="s-sala${i}" class="screen"><div class="gwrap"><div id="sn${i}" class="sala-badge">${escapeHtml(salaName)}</div><div id="area${i}" class="game-area"></div></div></div>`;
    if (i < numSalas) {
      salaHtml += `\n<div id="s-bt${i}" class="screen"><div class="gwrap"><div class="card"><div id="btt${i}" class="tran-title"></div><div id="btp${i}" class="tran-pts"></div><button class="btn-p" onclick="show('s-sala${i + 1}');startSala(${i + 1})">Siguiente sala &#8594;</button></div></div></div>`;
    }
  }

  const scenarioHtml = sc.intro
    ? `<div class="mission-box">${sc.location ? `<div class="mission-loc">${escapeHtml(sc.location)}</div>` : ''}${sc.character ? `<div class="mission-char">${escapeHtml(sc.character)}</div>` : ''}<div class="mission-intro">${escapeHtml(sc.intro)}</div></div>`
    : '';

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no">
<title>${escapeHtml(gameName)}</title>
<!-- scormEngine:game_v1 salas:${numSalas} mechanic:${mechanic} -->
<style>
:root{--hex:${hex};--ac:${ac}}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Segoe UI',system-ui,sans-serif;background:#08111c;color:#e5eef8;line-height:1.5}
.screen{display:none;position:fixed;top:0;left:0;width:100%;height:100%;overflow-y:auto;background:#08111c}
.screen.active{display:flex;flex-direction:column;align-items:center}
.gwrap{width:100%;max-width:780px;padding:60px 16px 80px;box-sizing:border-box}
.hud{position:fixed;top:0;left:0;width:100%;z-index:999;height:48px;display:flex;align-items:center;justify-content:space-between;padding:0 16px;background:rgba(8,17,28,.96);border-bottom:1px solid rgba(255,255,255,.08);backdrop-filter:blur(8px)}
.hud-n{color:var(--hex);font-size:12px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:220px}
.hud-r{display:flex;align-items:center;gap:12px;flex-shrink:0;font-size:13px;font-weight:700}
#hud-pts{color:var(--ac)}
.sala-badge{display:inline-block;padding:4px 14px;border-radius:50px;background:var(--hex);color:#fff;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;margin-bottom:18px}
.game-area{animation:aIn .2s ease-out both}
@keyframes aIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
.game-q{font-size:16px;font-weight:700;margin-bottom:18px;color:#e5eef8;line-height:1.5}
.btn-op{display:flex;align-items:center;gap:12px;width:100%;text-align:left;padding:13px 16px;background:rgba(255,255,255,.06);border:1.5px solid rgba(255,255,255,.1);border-radius:10px;color:#e5eef8;font-size:14px;cursor:pointer;margin-bottom:10px;font-family:inherit;font-weight:600;transition:border-color .15s}
.btn-op:hover:not([disabled]){border-color:rgba(255,255,255,.25)}
.btn-op.ok{background:rgba(16,185,129,.16);border-color:#10b981;color:#6ee7b7}
.btn-op.ko{background:rgba(239,68,68,.14);border-color:#ef4444;color:#fca5a5}
.opt-key{min-width:26px;height:26px;border-radius:6px;background:rgba(255,255,255,.1);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:900;flex-shrink:0}
.btn-p{background:var(--hex);color:#fff;border:none;cursor:pointer;font-weight:800;font-family:inherit;font-size:15px;padding:13px 28px;border-radius:12px;width:100%;margin-top:10px;transition:opacity .15s}
.btn-p:hover{opacity:.85}
.btn-p:disabled{opacity:.45;cursor:default}
.card{background:#0f1d2d;border-radius:18px;padding:28px}
.toast{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);z-index:1000;padding:11px 22px;border-radius:10px;font-weight:700;font-size:14px;pointer-events:none;max-width:90vw;text-align:center;display:none;box-shadow:0 4px 24px rgba(0,0,0,.5)}
.ititle{font-size:24px;font-weight:900;margin-bottom:6px;line-height:1.2}
.itagline{font-size:14px;color:rgba(229,238,248,.55);margin-bottom:18px}
.mission-box{background:rgba(255,255,255,.05);border-left:3px solid var(--hex);border-radius:0 12px 12px 0;padding:14px 16px;margin-bottom:20px}
.mission-loc{font-size:10px;text-transform:uppercase;letter-spacing:1.2px;opacity:.5;margin-bottom:4px}
.mission-char{font-size:13px;font-weight:800;color:var(--hex);margin-bottom:6px}
.mission-intro{font-size:13px;line-height:1.6;opacity:.8}
.stats-row{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:20px}
.stat-chip{background:rgba(255,255,255,.06);border-radius:10px;padding:10px 14px;text-align:center;flex:1 1 60px}
.stat-v{font-size:20px;font-weight:800;color:var(--ac)}
.stat-l{font-size:10px;opacity:.5;text-transform:uppercase;letter-spacing:.5px}
.r-circle{width:100px;height:100px;border-radius:50%;border:4px solid var(--hex);display:flex;align-items:center;justify-content:center;flex-direction:column;margin:0 auto 16px}
.r-pct{font-size:26px;font-weight:800}
.r-lbl{font-size:10px;opacity:.5;text-transform:uppercase}
.r-verd{font-size:18px;font-weight:800;text-align:center;margin-bottom:6px}
.r-stats{font-size:13px;color:rgba(229,238,248,.55);text-align:center;margin-bottom:20px}
.tran-title{font-size:20px;font-weight:900;text-align:center;margin-bottom:8px}
.tran-pts{font-size:13px;opacity:.6;text-align:center;margin-bottom:22px}
.scenario-box{background:rgba(255,255,255,.04);border-left:3px solid var(--hex);border-radius:0 10px 10px 0;padding:12px 14px;margin-bottom:14px;font-size:13px;line-height:1.55;opacity:.82}
.seq-list{display:flex;flex-direction:column;gap:8px;margin-bottom:12px}
.seq-card{display:flex;align-items:center;gap:10px;background:rgba(255,255,255,.06);border:1.5px solid rgba(255,255,255,.1);border-radius:10px;padding:11px 14px;font-size:13px;font-weight:600}
.seq-num{min-width:24px;height:24px;border-radius:6px;background:var(--hex);color:#fff;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:800;flex-shrink:0}
.seq-btns{display:flex;flex-direction:column;gap:2px;margin-left:auto}
.seq-btn{background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.12);border-radius:5px;color:#e5eef8;cursor:pointer;font-size:11px;padding:2px 7px;font-family:inherit}
.seq-btn:hover{background:rgba(255,255,255,.14)}
.ck-items{display:flex;flex-direction:column;gap:8px;margin-bottom:12px}
.ck-item{display:flex;align-items:center;gap:12px;background:rgba(255,255,255,.05);border:1.5px solid rgba(255,255,255,.1);border-radius:10px;padding:11px 14px;cursor:pointer;transition:border-color .15s;font-size:13px;font-weight:600;user-select:none}
.ck-item.req::before{content:"*";color:var(--ac);font-weight:900;font-size:14px;flex-shrink:0}
.ck-item.checked{background:rgba(16,185,129,.1);border-color:rgba(16,185,129,.5);color:#6ee7b7}
.ck-note{font-size:11px;opacity:.5;margin-bottom:12px}
</style>
</head>
<body>
<div id="hud" class="hud">
  <span class="hud-n">${escapeHtml(gameName)}</span>
  <div class="hud-r"><span id="hud-pts">0 pts</span><span id="hud-hearts"></span></div>
</div>

<div id="s-intro" class="screen active">
  <div class="gwrap">
    <span style="display:inline-block;background:var(--hex);color:#fff;padding:3px 12px;border-radius:50px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;margin-bottom:16px;">CAP ${cap.n} &middot; ${escapeHtml(cap.moduleName)}</span>
    <div style="font-size:36px;margin-bottom:8px;">${escapeHtml(emoji)}</div>
    <h1 class="ititle">${escapeHtml(gameName)}</h1>
    <p class="itagline">${escapeHtml(tagline)}</p>
    ${scenarioHtml}
    <div class="stats-row">
      <div class="stat-chip"><div class="stat-v">${numSalas}</div><div class="stat-l">Salas</div></div>
      <div class="stat-chip"><div class="stat-v">3</div><div class="stat-l">Vidas</div></div>
      <div class="stat-chip"><div class="stat-v">${maxPts}</div><div class="stat-l">Pts m&aacute;x</div></div>
      <div class="stat-chip"><div class="stat-v">70%</div><div class="stat-l">Aprobar</div></div>
    </div>
    <button class="btn-p" onclick="startGame()">&#9654; Iniciar actividad</button>
  </div>
</div>
${salaHtml}
<div id="s-result" class="screen">
  <div class="gwrap" style="display:flex;flex-direction:column;align-items:center;">
    <span style="display:inline-block;background:var(--hex);color:#fff;padding:3px 12px;border-radius:50px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;margin-bottom:18px;">Resultado final</span>
    <div class="r-circle"><div class="r-pct" id="r-pct">0%</div><div class="r-lbl">Score</div></div>
    <div class="r-verd" id="r-verd"></div>
    <div class="r-stats" id="r-stats"></div>
    <button class="btn-p" onclick="retry()" style="max-width:320px;margin:0 auto;">&#8635; Intentar de nuevo</button>
  </div>
</div>
<div id="toast" class="toast"></div>

<script>
var MECH=${safeJsonEmbed(mechanic)};
var NUM_SALAS=${numSalas};
var MAX_PTS=${maxPts};
${pregJs}
var G={score:0,correct:0,wrong:0,lives:3,sala:1,idx:0,curOpts:[],_ck:[],_ss:[],_so:[]};
var done=false,_api=null;

function _sf(w){var t=0;while(!w.API&&w.parent&&w.parent!==w&&t<7){t++;w=w.parent;}return w.API||null;}
function _init(){_api=_sf(window);if(!_api)_api=_sf(top);if(_api){try{_api.LMSInitialize('');}catch(e){}}}
function sc(k,v){try{if(_api){_api.LMSSetValue(k,String(v));_api.LMSCommit('');}}catch(e){}}

function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function shuf(a){var b=a.slice();for(var i=b.length-1;i>0;i--){var j=Math.floor(Math.random()*(i+1));var t=b[i];b[i]=b[j];b[j]=t;}return b;}
function show(id){document.querySelectorAll('.screen').forEach(function(s){s.classList.remove('active');});var e=document.getElementById(id);if(e)e.classList.add('active');}
function toast(msg,ok){var t=document.getElementById('toast');if(!t)return;t.textContent=msg;t.style.background=ok?'rgba(16,185,129,.95)':'rgba(220,38,38,.92)';t.style.display='block';clearTimeout(t._t);t._t=setTimeout(function(){t.style.display='none';},2200);}
function updHUD(){document.getElementById('hud-pts').textContent=G.score+' pts';var h='';for(var i=0;i<3;i++)h+=i<G.lives?'&#10084;&#65039;':'&#128420;';document.getElementById('hud-hearts').innerHTML=h;}

function startGame(){
  done=false;G.score=0;G.correct=0;G.wrong=0;G.lives=3;G.idx=0;G.sala=1;G.curOpts=[];G._ck=[];G._ss=[];G._so=[];
  _init();sc('cmi.core.lesson_status','incomplete');updHUD();show('s-sala1');startSala(1);
}
function startSala(n){
  G.sala=n;G.idx=0;G.curOpts=[];G._ck=[];G._ss=[];G._so=[];
  var pqs=PREGUNTAS['sala'+n];
  if(!pqs||!pqs.length){compSala(n);return;}
  renderArea(n);
}
function compSala(n){
  if(n>=NUM_SALAS){endGame();return;}
  var bt=document.getElementById('btt'+n),bp=document.getElementById('btp'+n);
  if(bt)bt.textContent='\\u2705 Sala '+n+' completada';
  if(bp)bp.textContent='Correctas: '+G.correct+' \\u00b7 '+G.score+' pts';
  show('s-bt'+n);
}
function gameOver(){
  done=true;show('s-result');
  document.getElementById('r-pct').textContent='0%';
  var v=document.getElementById('r-verd');v.textContent='Sin vidas \\u2014 no aprobado';v.style.color='#ef4444';
  document.getElementById('r-stats').textContent='Correctas: '+G.correct+' \\u00b7 Fallidas: '+G.wrong;
  sc('cmi.core.lesson_status','failed');
  try{_api.LMSCommit('');_api.LMSFinish('');}catch(e){}
}
function endGame(){
  done=true;
  var pct=MAX_PTS>0?Math.round(G.score/MAX_PTS*100):0,passed=pct>=70;
  show('s-result');
  document.getElementById('r-pct').textContent=pct+'%';
  var v=document.getElementById('r-verd');
  v.textContent=passed?'\\u2713 Actividad aprobada':'\\u2717 Necesitas repasar el cap\\u00edtulo';
  v.style.color=passed?'#10b981':'#ef4444';
  document.getElementById('r-stats').textContent='Correctas: '+G.correct+' \\u00b7 Fallidas: '+G.wrong+' \\u00b7 '+G.score+' pts';
  sc('cmi.core.score.raw',pct);sc('cmi.core.score.min','0');sc('cmi.core.score.max','100');
  sc('cmi.core.lesson_status',passed?'passed':'failed');
  try{_api.LMSCommit('');_api.LMSFinish('');}catch(e){}
}
function retry(){
  done=false;G.score=0;G.correct=0;G.wrong=0;G.lives=3;G.idx=0;G.sala=1;G.curOpts=[];G._ck=[];G._ss=[];G._so=[];
  updHUD();show('s-intro');
}

// ── Answer checking ──────────────────────────────────────────────────────────
function checkSala(n,i){
  if(done)return;
  var q=PREGUNTAS['sala'+n][G.idx];if(!q)return;
  var ok=(G.curOpts[i]===q.correct);
  if(ok){G.score+=10;G.correct++;toast('\\u2705 '+(q.fb||'Correcto'),true);}
  else{G.lives--;G.wrong++;toast('\\u274c '+(q.correct?'Correcto: '+q.correct:'Incorrecto'),false);if(G.lives<=0){updHUD();setTimeout(gameOver,600);return;}}
  updHUD();
  setTimeout(function(){if(done)return;G.idx++;var pqs=PREGUNTAS['sala'+n];if(G.idx>=pqs.length)compSala(n);else renderArea(n);},450);
}
function checkCk(n){
  if(done)return;
  var q=PREGUNTAS['sala'+n][G.idx],items=q.items||[],sel=G._ck||[];
  var ok=items.every(function(it,k){return !it.required||!!sel[k];});
  var btn=document.getElementById('ckbtn'+n);if(btn)btn.disabled=true;
  if(ok){G.score+=10;G.correct++;toast('\\u2705 '+(q.fb||'\\u00a1Protocolo correcto!'),true);}
  else{G.lives--;G.wrong++;toast('\\u274c Marca todos los pasos obligatorios (*)',false);if(G.lives<=0){updHUD();setTimeout(gameOver,800);return;}}
  updHUD();
  setTimeout(function(){if(done)return;G.idx++;G._ck=[];var pqs=PREGUNTAS['sala'+n];if(G.idx>=pqs.length)compSala(n);else renderArea(n);},1500);
}
function checkSeq(n){
  if(done)return;
  var q=PREGUNTAS['sala'+n][G.idx],steps=G._ss||[],order=G._so||[];
  var correct=steps.slice().sort(function(a,b){return a.order-b.order;}).map(function(s){return s.id;});
  var wrongs=0;for(var k=0;k<order.length;k++)if(order[k]!==correct[k])wrongs++;
  var tol=q.tolerance!=null?Number(q.tolerance):0,ok=wrongs<=tol;
  var btn=document.getElementById('seqbtn'+n);if(btn)btn.disabled=true;
  if(ok){G.score+=10;G.correct++;toast('\\u2705 '+(q.fb||'\\u00a1Secuencia correcta!'),true);}
  else{G.lives--;G.wrong++;toast('\\u274c Orden incorrecto',false);if(G.lives<=0){updHUD();setTimeout(gameOver,800);return;}}
  updHUD();
  setTimeout(function(){if(done)return;G.idx++;G._ss=[];G._so=[];var pqs=PREGUNTAS['sala'+n];if(G.idx>=pqs.length)compSala(n);else renderArea(n);},1800);
}

// ── Render area ──────────────────────────────────────────────────────────────
function renderArea(n){
  if(MECH==='secuencia_pro')renderSeq(n);
  else if(MECH==='checklist')renderCk(n);
  else renderQuiz(n);
}
function renderQuiz(n){
  var q=PREGUNTAS['sala'+n][G.idx];if(!q){compSala(n);return;}
  var opts=(q.opts&&q.opts.length)?q.opts.slice():['A','B','C','D'];
  if(opts.length>2)opts=shuf(opts);
  G.curOpts=opts;
  var keys=['A','B','C','D'],h='';
  if(q.scenario)h+='<div class="scenario-box">'+esc(q.scenario)+'</div>';
  h+='<p class="game-q">'+esc(q.q)+'</p>';
  opts.forEach(function(o,i){h+='<button class="btn-op" onclick="checkSala('+n+','+i+')"><span class="opt-key">'+keys[i]+'</span><span>'+esc(o)+'</span></button>';});
  setArea(n,h);
}
function renderCk(n){
  var q=PREGUNTAS['sala'+n][G.idx];if(!q){compSala(n);return;}
  G._ck=[];var items=q.items||[];
  var h='<p class="game-q">'+esc(q.q)+'</p><p class="ck-note">Marca los pasos obligatorios (*) antes de verificar.</p><div class="ck-items">';
  items.forEach(function(it,k){h+='<div class="ck-item'+(it.required?' req':'')+'" id="cki'+n+'_'+k+'" onclick="ckTog('+n+','+k+')"><span id="ckc'+n+'_'+k+'">&#9744;</span><span>'+esc(it.label)+'</span></div>';});
  h+='</div><button class="btn-p" id="ckbtn'+n+'" onclick="checkCk('+n+')">&#10003; Verificar</button>';
  setArea(n,h);
}
function renderSeq(n){
  var q=PREGUNTAS['sala'+n][G.idx];if(!q){compSala(n);return;}
  var steps=(q.steps||[]).slice(),shuf_steps=shuf(steps);
  G._ss=steps;G._so=shuf_steps.map(function(s){return s.id;});
  var h='<p class="game-q">'+esc(q.q)+'</p><p style="font-size:11px;opacity:.5;margin-bottom:10px;text-transform:uppercase;letter-spacing:1px;">Ordena los pasos de arriba a abajo</p><div class="seq-list" id="seql'+n+'">';
  shuf_steps.forEach(function(s,k){h+='<div class="seq-card" id="sqc'+n+'_'+k+'"><div class="seq-num">'+(k+1)+'</div><span style="flex:1;line-height:1.4;">'+esc(s.label)+'</span><div class="seq-btns"><button class="seq-btn" onclick="seqMv('+n+','+k+',-1)">&#9650;</button><button class="seq-btn" onclick="seqMv('+n+','+k+',1)">&#9660;</button></div></div>';});
  h+='</div><button class="btn-p" id="seqbtn'+n+'" onclick="checkSeq('+n+')">&#10003; Validar secuencia</button>';
  setArea(n,h);
}
function setArea(n,h){var a=document.getElementById('area'+n);if(a){a.innerHTML=h;a.style.animation='none';void a.offsetWidth;a.style.animation='aIn .2s ease-out both';}}
function ckTog(n,k){if(!G._ck)G._ck=[];G._ck[k]=!G._ck[k];var e=document.getElementById('cki'+n+'_'+k),c=document.getElementById('ckc'+n+'_'+k);if(e)e.classList.toggle('checked',!!G._ck[k]);if(c)c.innerHTML=G._ck[k]?'&#9745;':'&#9744;';}
function seqMv(n,k,d){var l=document.getElementById('seql'+n);if(!l)return;var cs=Array.from(l.children),ni=k+d;if(ni<0||ni>=cs.length)return;var t=G._so[k];G._so[k]=G._so[ni];G._so[ni]=t;if(d>0)l.insertBefore(cs[ni],cs[k]);else l.insertBefore(cs[k],cs[ni]);Array.from(l.children).forEach(function(c,i){var nm=c.querySelector('.seq-num');if(nm)nm.textContent=String(i+1);});}

updHUD();_init();
</script>
</body>
</html>`;
}


function createScormManifest(cap: NormalizedChapter): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<manifest identifier="cap${cap.n}_juego" version="1.2" xmlns="http://www.imsproject.org/xsd/imscp_rootv1p1p2" xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_rootv1p2" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.imsproject.org/xsd/imscp_rootv1p1p2 imscp_rootv1p1p2.xsd">
  <metadata><schema>ADL SCORM</schema><schemaversion>1.2</schemaversion></metadata>
  <organizations default="cap${cap.n}_org"><organization identifier="cap${cap.n}_org"><title>Cap ${cap.n}: ${cap.t}</title><item identifier="item_1" identifierref="resource_1"><title>Actividad Cap ${cap.n}</title></item></organization></organizations>
  <resources><resource identifier="resource_1" type="webcontent" adlcp:scormtype="sco" href="index.html"><file href="index.html"/></resource></resources>
</manifest>`;
}

function createFallbackGift(unit: number | 'final', D: NormalizedCourseData): string {
  const prefix = unit === 'final' ? 'EF' : `U${unit}`;
  const topic = unit === 'final' ? D.nombre : (D.mods[Number(unit) - 1]?.n ?? D.nombre);
  return `::${prefix}-01::¿Cuál es el objetivo principal del área de ${escapeHtml(D.sector)} en ${escapeHtml(D.pais)}? {\n  =Mejorar la eficiencia operativa del sector\n  ~Reducir el número de empleados\n  ~Eliminar los procesos manuales\n  ~Centralizar todas las operaciones\n}\n::${prefix}-02::El curso "${escapeHtml(D.nombre)}" está diseñado para el sector ${escapeHtml(D.sector)}. {TRUE}\n::${prefix}-03::Relaciona los módulos del curso. {\n  ${D.mods.map((m, i) => `=Módulo ${i+1} -> ${m.n}`).join('\n  ')}\n}\n`;
}

// ── Injectable service ────────────────────────────────────────────────────────
@Injectable()
export class ContentGenerationService {
  async generateCourseContent(
    inputPayload: ContentGenerationInputPayload,
    callbacks?: ContentGenerationCallbacks,
  ): Promise<GeneratedCourseContentResult> {
    return generateCourseContent(inputPayload, callbacks);
  }
}
