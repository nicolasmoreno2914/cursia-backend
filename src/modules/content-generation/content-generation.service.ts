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
  paginas:  21,
  scorms:    9,
  examenes:  4,
};

const DEFAULT_MODEL = 'claude-sonnet-4-5';
const MAX_RETRIES   = 3;

function escapeHtml(value: any): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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
  return `${ctx}\n\nGenera cap${cap.n}_descripcion_actividad.html. Cap ${cap.n}: "${cap.t}". Módulo ${cap.moduleNumber}.\n\nCOLORES: cap.hex=${cap.moduleHex} (solo fondos y border-left) · cap.ac=${cap.moduleAc} (números, labels, badges)\nREGLA: NUNCA cap.hex como color de texto.\n\nESTRUCTURA:\n(1) Contenedor raíz: <div style="background:#0B1929;border-radius:20px;padding:28px;box-sizing:border-box;width:100%;max-width:100%;overflow:hidden;font-family:'Segoe UI',Arial,sans-serif;">\n    NO uses position:relative. NO número decorativo absoluto.\n(2) Badge: <span style="display:inline-block;background:${cap.moduleHex};color:#fff;padding:4px 14px;border-radius:20px;font-size:11px;font-weight:700;text-transform:uppercase;margin-bottom:16px;">🎮 ACTIVIDAD INTERACTIVA · CAPÍTULO ${cap.n}</span>\n(3) Título h2 + Descripción de qué hace el estudiante (2 párrafos), color:#E2E6F3\n(4) STATS — 4 chips en flex-wrap (NO tabla):\n    <div style="display:flex;flex-wrap:wrap;gap:12px;margin:20px 0;">\n    Cada chip: <div style="background:rgba(255,255,255,0.06);border-radius:10px;padding:12px 16px;min-width:80px;text-align:center;">\n      Número grande color:${cap.moduleAc} · label pequeño color:rgba(226,230,243,0.6)\n    Valores: "4" SALAS · "280" PTS MÁX · "3" VIDAS · "∞" INTENTOS\n(5) GRID 4 SALAS — <div style="display:flex;flex-wrap:wrap;gap:12px;margin-bottom:20px;">\n    Cada sala: <div style="flex:1 1 180px;background:rgba(255,255,255,0.04);border-left:3px solid ${cap.moduleHex};border-radius:8px;padding:14px;">\n    con nombre de sala, mecánica y puntos, color:#E2E6F3\n(6) CTA: <a href="#scorm-cap-${cap.n}" style="display:inline-block;background:${cap.moduleAc};color:#000;padding:12px 24px;border-radius:10px;text-decoration:none;font-weight:700;">▶ Iniciar Actividad →</a>\n\nNUNCA sesskey. FRAGMENTO HTML sin DOCTYPE.`;
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

  const anthropic  = new Anthropic({ apiKey });
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

  // ════════════════════════════════════════════════════════════════
  // FASE 1: LIBRO GUÍA
  // ════════════════════════════════════════════════════════════════

  // 1a. Inicio del libro
  try {
    const text = await callClaude(sysL, buildLibroPrompt('ini', D, ctx), 4096, 'libro_inicio');
    await addFile('libro', 'libro_inicio.md', text, 'Libro: portada e introducción');
  } catch (e: any) {
    errors.push(`libro_inicio: ${e.message}`);
    await addFile('libro', 'libro_inicio.md', `# Introducción\nContenido del curso ${D.nombre}`, 'Libro: fallback');
  }

  // 1b. Módulos
  for (let mi = 0; mi < D.mods.length; mi++) {
    const filename = `libro_mod${mi + 1}.md`;
    try {
      const text = await callClaude(sysL, buildLibroPrompt('mod', D, ctx, mi), 2048, filename);
      await addFile('libro', filename, text, `Libro: módulo ${mi + 1}`);
    } catch (e: any) {
      errors.push(`${filename}: ${e.message}`);
      await addFile('libro', filename, `# Módulo ${mi + 1}: ${D.mods[mi].n}\n\nContenido del módulo.`, `Libro: módulo ${mi + 1} (fallback)`);
    }
  }

  // 1c. Capítulos (9)
  for (let ci = 0; ci < D.caps.length; ci++) {
    const cap = D.caps[ci];
    const filename = `libro_cap${cap.n}.md`;
    try {
      const text = await callClaude(sysL, buildLibroPrompt('cap', D, ctx, undefined, ci), 8192, filename);
      await addFile('libro', filename, text, `Libro: capítulo ${cap.n}`);
    } catch (e: any) {
      errors.push(`${filename}: ${e.message}`);
      await addFile('libro', filename, `# Capítulo ${cap.n}: ${cap.t}\n\nContenido del capítulo.`, `Libro: capítulo ${cap.n} (fallback)`);
    }
  }

  // 1d. Bibliografía
  try {
    const text = await callClaude(sysL, buildLibroPrompt('bib', D, ctx), 2048, 'libro_biblio');
    await addFile('libro', 'libro_biblio.md', text, 'Libro: evaluación y bibliografía');
  } catch (e: any) {
    errors.push(`libro_biblio: ${e.message}`);
    await addFile('libro', 'libro_biblio.md', `# Evaluación y Bibliografía\nRecursos del curso ${D.nombre}`, 'Libro: fallback');
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

  for (const page of htmlPages) {
    try {
      let html = await page.prompt();
      // Sanitize: strip any <style> or <script> tags
      html = html.replace(/<style[\s\S]*?<\/style>/gi, '');
      html = html.replace(/<script[\s\S]*?<\/script>/gi, '');
      // Strip markdown wrappers if model added them
      html = html.replace(/^```html\s*/i, '').replace(/\s*```$/, '');
      await addFile('paginas', page.filename, html, page.message);
    } catch (e: any) {
      errors.push(`${page.filename}: ${e.message}`);
      const fallback = `<div style="background:#0A1628;border-radius:20px;padding:32px;color:#E2E6F3;font-family:'Segoe UI',Arial,sans-serif;"><p style="color:#E2E6F3;">${escapeHtml(page.filename)}</p></div>`;
      await addFile('paginas', page.filename, fallback, `${page.message} (fallback)`);
    }
  }

  // ════════════════════════════════════════════════════════════════
  // FASE 3: SCORMs (juegos gamificados — template por ahora)
  // ════════════════════════════════════════════════════════════════
  for (const cap of D.caps) {
    const indexHtml = createScormIndex(normalized, cap);
    const manifestXml = createScormManifest(cap);
    await addFile('scorms', `scorm_cap${cap.n}_index.html`,    indexHtml,    `SCORM: index capítulo ${cap.n}`);
    await addFile('scorms', `scorm_cap${cap.n}_manifest.xml`,  manifestXml,  `SCORM: manifest capítulo ${cap.n}`);
  }

  // ════════════════════════════════════════════════════════════════
  // FASE 4: EXÁMENES GIFT
  // ════════════════════════════════════════════════════════════════
  for (let unit = 1; unit <= 3; unit++) {
    const u = unit;
    const filename = `examen_unidad${u}.gift`;
    try {
      const gift = await callClaude(sysG, buildGiftPrompt(D, ctx, u), 4096, `examen_u${u}`);
      await addFile('examenes', filename, gift.trim(), `Examen: unidad ${u}`);
    } catch (e: any) {
      errors.push(`${filename}: ${e.message}`);
      await addFile('examenes', filename, createFallbackGift(u, D), `Examen: unidad ${u} (fallback)`);
    }
  }

  // Examen final
  try {
    const gift = await callClaude(sysG, buildGiftPrompt(D, ctx, 'final'), 6144, 'examen_final');
    await addFile('examenes', 'examen_final.gift', gift.trim(), 'Examen: final');
  } catch (e: any) {
    errors.push(`examen_final.gift: ${e.message}`);
    await addFile('examenes', 'examen_final.gift', createFallbackGift('final', D), 'Examen: final (fallback)');
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
      await addFile('scorms', `scorm_cap${cap.n}_index.html`,   createScormIndex(normalized, cap),   `SCORM: index cap ${cap.n}`);
      await addFile('scorms', `scorm_cap${cap.n}_manifest.xml`, createScormManifest(cap),             `SCORM: manifest cap ${cap.n}`);
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
