// r73 · UX-9 · Clasificación educativa del curso (nivel, grado, edades) y su coherencia con el pedido.
//
// Caso real (producción #87, staging #1672): «Inglés Básico – Grado Sexto», microcurrículo «Educación Básica Secundaria ·
// Grado: Sexto (6.º)», y el pedido quedó con contexto = «Universitario — estudiantes de pregrado universitario, con rigor
// académico y pensamiento crítico» (inferido). Ese texto es el valor de PARTIDA del formulario (SEL de 01-state.js, chip
// encendido por defecto) y nadie lo corregía con lo que decía el documento: el contenido se escribía para universitarios.
//
// Regla: las señales EXPLÍCITAS del nivel educativo mandan sobre cualquier valor de partida o inferencia automática.
//   1. lo que eligió el usuario (contexto del pedido NO inferido): se respeta; si el curso lo contradice, solo se avisa;
//   2. el documento (nivel educativo, grado, «Educación Básica Secundaria», bachillerato, técnico, tecnólogo, pregrado,
//      posgrado, semestre, edades…);
//   3. el nombre del curso (y lo que el usuario escribió que quiere enseñar): «Grado Sexto», «6.º», «Grado 11»,
//      «Semestre», «Diplomado», «Técnico en…»;
//   4. solo entonces, nada: sin señales se PREGUNTA (nunca «Universitario» en silencio).
// Colombia / LatAm: grado 1–5 → Básica Primaria; 6–9 → Básica Secundaria; 10–11 → Media (bachillerato); técnico,
// tecnólogo, pregrado, posgrado y corporativo son distintos entre sí.
//
// Puro y determinista (sin DB, sin red, sin IA, USD 0): lo prueba scripts/check-r73-education-level.js.
import type { AcademicContextV1 } from '../academic-context/academic-context';

export type EducationStage =
  | 'primaria' | 'basica_secundaria' | 'media' | 'bachillerato' | 'tecnico' | 'tecnologo' | 'pregrado' | 'posgrado' | 'corporativo';
export type EngineLevel = 'basic' | 'secondary' | 'technical' | 'university' | 'professional';

export const STAGE_LEVEL: Readonly<Record<EducationStage, EngineLevel>> = Object.freeze({
  primaria: 'basic', basica_secundaria: 'secondary', media: 'secondary', bachillerato: 'secondary',
  tecnico: 'technical', tecnologo: 'technical', pregrado: 'university', posgrado: 'university', corporativo: 'professional',
});

export const STAGE_LABEL: Readonly<Record<EducationStage, string>> = Object.freeze({
  primaria: 'Educación Básica Primaria', basica_secundaria: 'Educación Básica Secundaria', media: 'Educación Media (bachillerato)',
  bachillerato: 'Bachillerato', tecnico: 'Técnico', tecnologo: 'Tecnólogo', pregrado: 'Universitario (pregrado)', posgrado: 'Posgrado', corporativo: 'Corporativo',
});

/** Opciones de la pregunta «¿Para quién es el curso?» (en este orden). */
export const STAGE_OPTIONS: readonly EducationStage[] = ['primaria', 'basica_secundaria', 'media', 'tecnico', 'tecnologo', 'pregrado', 'posgrado', 'corporativo'];

const strip = (s: string) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// Chips del formulario de siempre (index.html #cp-contexto): mismo texto, así el chip queda encendido.
export const CHIP_CONTEXTO = Object.freeze({
  bachillerato: 'Bachillerato — estudiantes de secundaria y media (grado 6° a 11°), con lenguaje claro, ejemplos concretos y actividades dinámicas',
  tecnico: 'Técnico / Tecnólogo — formación vocacional y técnica, orientada a competencias prácticas e inserción laboral rápida',
  pregrado: 'Universitario — estudiantes de pregrado universitario, con rigor académico y pensamiento crítico',
  corporativo: 'Corporativo — profesionales en ejercicio dentro de una organización, con enfoque práctico y aplicación inmediata',
  posgrado: 'Posgrado — especialización, maestría o doctorado, con profundidad teórica y análisis avanzado',
});

const ORD: ReadonlyArray<[RegExp, number]> = [
  [/^(primero|primer|1)$/, 1], [/^(segundo|2)$/, 2], [/^(tercero|tercer|3)$/, 3], [/^(cuarto|4)$/, 4], [/^(quinto|5)$/, 5],
  [/^(sexto|6)$/, 6], [/^(septimo|setimo|7)$/, 7], [/^(octavo|8)$/, 8], [/^(noveno|9)$/, 9], [/^(decimo|10)$/, 10],
  [/^(undecimo|once|onceavo|decimoprimero|11)$/, 11],
];
const ORD_WORDS = 'primero|primer|segundo|tercero|tercer|cuarto|quinto|sexto|septimo|setimo|octavo|noveno|decimo|undecimo|once|onceavo|decimoprimero';
function ordinal(w: string): number | null {
  const t = String(w || '').replace(/[^a-z0-9]/g, '');
  for (const [re, n] of ORD) if (re.test(t)) return n;
  return null;
}

export function stageOfGrade(g: number): EducationStage | null {
  if (g >= 1 && g <= 5) return 'primaria';
  if (g >= 6 && g <= 9) return 'basica_secundaria';
  if (g >= 10 && g <= 11) return 'media';
  return null;
}
/** Edad típica (Colombia) de un grado: grado 6 → 11–12 años. */
export function agesOfGrade(g: number): [number, number] { return [g + 5, g + 6]; }
function stageOfAges(a: number, b: number): EducationStage | null {
  const m = (a + b) / 2;
  if (m < 5) return null;
  if (m <= 10.5) return 'primaria';
  if (m <= 14.5) return 'basica_secundaria';
  if (m <= 17.5) return 'media';
  return null; // adultos: la edad no dice el nivel
}

/** Grado escolar explícito en un texto («Grado Sexto», «6.º grado», «grado 11», «Grado: Sexto (6.º)»). */
export function gradeOf(text: string): number | null {
  const t = strip(text).replace(/[º°ª]/g, 'o');
  const patterns: RegExp[] = [
    new RegExp(`\\bgrados?\\s*[:\\-–]?\\s*(${ORD_WORDS}|\\d{1,2})\\b`),
    new RegExp(`\\b(${ORD_WORDS})\\s+grado\\b`),
    /\b(\d{1,2})\s*\.?\s*o?\s*grado\b(?!s)/,
    /\b(\d{1,2})\s*\.?\s*(?:o|er|ro|do|to|vo|no|mo)\s+(?:de\s+)?(?:primaria|bachillerato|secundaria)\b/,
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (m) {
      const n = ordinal(m[1]);
      if (n && n >= 1 && n <= 11) return n;
    }
  }
  return null;
}

/** Edades explícitas («estudiantes de 11 a 12 años», «niños entre 8 y 9 años», «edad: 15 años»). Solo menores de 18. */
export function agesOf(text: string): [number, number] | null {
  const t = strip(text);
  const m = t.match(/\b(?:edad(?:es)?|entre|ninos?|ninas?|jovenes|adolescentes|estudiantes|alumnos?)\b[^.\n]{0,30}?\b(\d{1,2})\s*(?:a|y|-|–|al)\s*(\d{1,2})\s*anos\b/)
    || t.match(/\b(?:edad(?:es)?|ninos?|ninas?|jovenes|adolescentes|estudiantes|alumnos?)\b[^.\n]{0,30}?\b(\d{1,2})\s*anos\b/);
  if (!m) return null;
  const a = Number(m[1]);
  const b = m[2] !== undefined ? Number(m[2]) : a;
  if (!(a > 0 && b >= a && b < 18)) return null;
  return [a, b];
}

export interface StageSignal { stage: EducationStage; grade: number | null; ages: [number, number] | null; evidence: string; strength: 'explicit' | 'weak' }

/** Patrones por etapa, del más específico al más general (un «posgrado» nunca cae en «pregrado»). */
const STAGE_PATTERNS: ReadonlyArray<[EducationStage, RegExp, 'explicit' | 'weak']> = [
  ['posgrado', /\b(posgrados?|postgrados?|especializacion(?:es)?|maestrias?|doctorados?|mba|magister)\b/, 'explicit'],
  ['pregrado', /\b(pregrado|universitari[oa]s?|licenciaturas?|carrera profesional|profesional universitari\w*|(?:estudiantes|programa|facultad) de ingenieria)\b/, 'explicit'],
  ['tecnologo', /\b(tecnologos?|tecnologas?|tecnologia en (?!el |la |los |las |educacion\b)|tecnologico|formacion tecnologica|nivel tecnologico)/, 'explicit'],
  ['tecnico', /(^|[^\w])(tecnic[oa]s? (?:en|laboral|profesional)\b|nivel tecnico|formacion tecnica|formacion para el trabajo|tecnicos?$)/, 'explicit'],
  ['primaria', /\b(basica primaria|educacion primaria|primaria|preescolar|transicion escolar)\b/, 'explicit'],
  ['basica_secundaria', /\b(basica secundaria)\b/, 'explicit'],
  ['media', /\b(educacion media|media academica|media tecnica)\b/, 'explicit'],
  ['bachillerato', /\b(bachillerato|secundaria)\b/, 'explicit'],
  ['corporativo', /\b(corporativ[oa]s?|empresarial(?:es)?|auxiliar(?:es)? administrativ\w*|asistentes? administrativ\w*|colaboradores|empleados|trabajadores|funcionarios|personal (?:de|del|administrativo|operativo)|equipos? (?:de trabajo|comercial(?:es)?)|formacion continua|educacion continua(?:da)?|diplomados?|capacitacion (?:empresarial|laboral|interna)|en la empresa|supervisores|lideres de equipo)\b/, 'explicit'],
  ['pregrado', /\b(semestres?|ingenieria)\b/, 'weak'],
  ['bachillerato', /\b(colegio|escolar(?:es)?)\b(?<!docentes escolares)/, 'weak'],
  ['corporativo', /\b(docentes|profesores|maestros) escolares\b/, 'weak'],
];

/**
 * Señal de nivel educativo de UN texto. El grado (o la edad) precisa una etapa genérica («bachillerato grado 6» →
 * Básica Secundaria). null = el texto no dice nada del nivel.
 */
export function stageSignalOf(text: string | null | undefined): StageSignal | null {
  const raw = String(text || '').replace(/\s+/g, ' ').trim();
  if (!raw) return null;
  const t = strip(raw);
  const grade = gradeOf(raw);
  const ages = grade ? agesOfGrade(grade) : agesOf(raw);
  const ev = raw.slice(0, 140);
  // Quien APRENDE no es el público de una mención («diplomado para docentes de primaria», «atención primaria en salud»).
  const tt = t.replace(/\b(docentes|profesores|maestros|licenciados) de (basica |educacion )?(primaria|secundaria|bachillerato|preescolar)\b/g, '$1 escolares')
    .replace(/\batencion primaria\b/g, 'atencion basica en salud');
  let stage: EducationStage | null = null;
  let strength: 'explicit' | 'weak' = 'explicit';
  for (const [st, re, sg] of STAGE_PATTERNS) {
    if (re.test(tt)) { stage = st; strength = sg; break; }
  }
  // El grado manda sobre una etapa escolar genérica (y la contradice solo si es de otra etapa escolar explícita).
  const gStage = grade ? stageOfGrade(grade) : ages ? stageOfAges(ages[0], ages[1]) : null;
  if (gStage) {
    if (!stage || stage === 'bachillerato') return { stage: gStage, grade, ages, evidence: ev, strength: grade ? 'explicit' : 'weak' };
    if (stage === 'primaria' || stage === 'basica_secundaria' || stage === 'media') {
      // «Educación Básica Secundaria» + «grado 6» coinciden; si no, el grado (dato más preciso) gana.
      return { stage: gStage, grade, ages, evidence: ev, strength: 'explicit' };
    }
  }
  if (!stage) return null;
  return { stage, grade: grade && stageOfGrade(grade) === stage ? grade : null, ages: grade && stageOfGrade(grade) === stage ? ages : null, evidence: ev, strength };
}

/** ¿Dos etapas describen al mismo público? (genérico ⊂ específico). */
export function stagesCompatible(a: EducationStage, b: EducationStage): boolean {
  if (a === b) return true;
  const school = ['basica_secundaria', 'media'];
  if ((a === 'bachillerato' && school.includes(b)) || (b === 'bachillerato' && school.includes(a))) return true;
  return false;
}

/** Combina señales de una misma fuente: la más precisa (con grado) primero; si chocan, conflicto. */
function combine(signals: StageSignal[]): { signal: StageSignal | null; clash: StageSignal | null } {
  const xs = signals.filter(Boolean);
  if (!xs.length) return { signal: null, clash: null };
  const explicit = xs.filter((s) => s.strength === 'explicit');
  const pool = explicit.length ? explicit : xs;
  const ranked = [...pool].sort((a, b) => (b.grade ? 1 : 0) - (a.grade ? 1 : 0) || (b.stage === 'bachillerato' ? -1 : 0) - (a.stage === 'bachillerato' ? -1 : 0));
  const best = ranked[0];
  const clash = ranked.find((s) => !stagesCompatible(s.stage, best.stage)) || null;
  // Un mismo documento con «Educación Básica Secundaria» y «Grado 6» no choca; «Grado 6» y «Pregrado» sí.
  return { signal: best, clash: clash && clash.strength === 'explicit' && best.strength === 'explicit' ? clash : null };
}

/** Texto del contexto educativo del pedido para una etapa (con grado y edades si se conocen). */
export function contextoForStage(stage: EducationStage, grade: number | null, ages: [number, number] | null): string {
  const g = grade ? `grado ${grade}.º` : null;
  const a = ages ? `aprox. ${ages[0]}–${ages[1]} años` : null;
  const who = (def: string) => (g ? `estudiantes de ${g}${a ? ` (${a})` : ''}` : ages ? `estudiantes de ${ages[0]}–${ages[1]} años` : def);
  switch (stage) {
    case 'primaria': return `Educación Básica Primaria — ${who('estudiantes de primaria (grados 1.º a 5.º, aprox. 6–11 años)')}: lenguaje sencillo y concreto, ejemplos cercanos a su vida diaria, instrucciones cortas y actividades lúdicas`;
    case 'basica_secundaria': return `Educación Básica Secundaria — ${who('estudiantes de grados 6.º a 9.º (aprox. 11–15 años)')}: lenguaje claro y cercano, ejemplos de su vida escolar y cotidiana, actividades guiadas paso a paso`;
    case 'media': return `Educación Media (bachillerato) — ${who('estudiantes de grados 10.º y 11.º (aprox. 15–17 años)')}: lenguaje claro, ejemplos concretos y conexión con su proyecto de vida, estudios superiores y trabajo`;
    case 'bachillerato': return CHIP_CONTEXTO.bachillerato;
    case 'tecnico': return 'Técnico — formación técnica laboral o profesional, orientada a competencias prácticas, procedimientos del oficio e inserción laboral';
    case 'tecnologo': return 'Tecnólogo — formación tecnológica, con fundamentos aplicados, resolución de problemas del sector y gestión de procesos';
    case 'pregrado': return CHIP_CONTEXTO.pregrado;
    case 'posgrado': return CHIP_CONTEXTO.posgrado;
    case 'corporativo': return CHIP_CONTEXTO.corporativo;
  }
}

/** Etapa que describe el contexto del pedido (chips de siempre, textos de r73 o un «Otro» escrito a mano). */
export function stageOfContexto(contexto: string | null | undefined): EducationStage | null {
  const s = strip(String(contexto || '')).trim();
  if (!s) return null;
  if (/^educacion basica primaria/.test(s)) return 'primaria';
  if (/^educacion basica secundaria/.test(s)) return 'basica_secundaria';
  if (/^educacion media/.test(s)) return 'media';
  if (/^educacion basica/.test(s)) return 'primaria'; // LEVEL_TEXT.basic («primeros niveles de escolaridad»)
  if (/^bachillerato/.test(s)) return 'bachillerato';
  if (/^tecnico \/ tecnologo/.test(s)) return 'tecnico';
  if (/^tecnologo/.test(s)) return 'tecnologo';
  if (/^tecnico/.test(s)) return 'tecnico';
  if (/^universitario/.test(s)) return 'pregrado';
  if (/^posgrado/.test(s)) return 'posgrado';
  if (/^corporativo/.test(s)) return 'corporativo';
  if (/^personalizado — describelo/.test(s)) return null;
  const sig = stageSignalOf(contexto);
  return sig ? sig.stage : null;
}

/** El contexto del pedido (genérico) acepta esa etapa: «Técnico / Tecnólogo» sirve para técnico y tecnólogo. */
function contextoAccepts(current: EducationStage, detected: EducationStage, contexto: string): boolean {
  if (stagesCompatible(current, detected)) return true;
  if (/^tecnico \/ tecnologo/.test(strip(contexto)) && (detected === 'tecnico' || detected === 'tecnologo')) return true;
  return false;
}

const SCHOOL: readonly EducationStage[] = ['primaria', 'basica_secundaria', 'media', 'bachillerato'];
/** Registro universitario en un texto («rigor académico», «pensamiento crítico», «pregrado»). */
const UNIVERSITY_REGISTER = /\b(rigor academico|pensamiento critico|pregrado|universitari\w*|profundidad teorica|analisis avanzado)\b/;

export const DEFAULT_TONE_SCHOOL = 'Conversacional y cercano, como un mentor con ejemplos cotidianos';

export type EducationAction = 'none' | 'auto' | 'warn' | 'ask';

export interface EducationProfile {
  version: 1;
  /** Lo que dice el curso (documento o nombre), con su evidencia. null = no hay señales. */
  detected: { stage: EducationStage; level: EngineLevel; label: string; grade: number | null; ages: [number, number] | null; source: 'document' | 'name'; evidence: string[] } | null;
  /** El contexto que tiene hoy el pedido y quién lo decidió. */
  current: { contexto: string | null; stage: EducationStage | null; source: 'user' | 'inferred' | null };
  /**
   * none: coherente. auto: el contexto lo puso Cursia (o falta) y el curso lo contradice → se corrige (revisable, deshacer).
   * warn: lo eligió el usuario y el curso dice otra cosa → se respeta y se avisa. ask: sin señales, o señales explícitas
   * que chocan → UNA pregunta con una sugerencia.
   */
  action: EducationAction;
  /** Contexto (y tono, si también lo puso Cursia y no encaja) que propone Cursia. */
  proposal: { stage: EducationStage; contexto: string; tono: string | null } | null;
  message: string | null;
  question: { text: string; options: { stage: EducationStage; label: string; contexto: string }[]; suggestion: EducationStage | null; why: string } | null;
  /** Avisos de registro (tono o nivel de conocimientos que no encajan con la edad), aunque el nivel sea coherente. */
  register: string[];
}

export interface EducationInput {
  brief: { contexto?: string; tono?: string; nivel?: string; nombre?: string; obj?: string; inferidos?: string } | null;
  academic: AcademicContextV1 | null;
  courseTitle: string | null;
  /** Nivel del perfil pedagógico SOLO si lo decidió el docente (dueño 'user'). */
  userProfileLevel?: string | null;
}

const val = (f: { status: string; value: unknown } | undefined): string => {
  if (!f || f.status === 'missing' || f.value === null || f.value === undefined) return '';
  if (typeof f.value === 'string') return f.value;
  if (Array.isArray(f.value)) return '';
  return String((f.value as any).text || '');
};

function gradeText(d: { grade: number | null; ages: [number, number] | null; stage: EducationStage }): string {
  if (d.grade) return `de grado ${d.grade}.º${d.ages ? ` (${d.ages[0]}–${d.ages[1]} años)` : ''}`;
  return `de ${STAGE_LABEL[d.stage]}`;
}
function audienceText(stage: EducationStage | null, contexto: string | null): string {
  if (!stage) return `«${String(contexto || '').split(' — ')[0].slice(0, 60)}»`;
  return stage === 'pregrado' ? 'universitario' : STAGE_LABEL[stage];
}

/**
 * Clasificación educativa y coherencia del pedido. Puro: la usa «Lo que sabemos del curso» (GET /facts) y la prueba
 * scripts/check-r73-education-level.js.
 */
export function classifyEducation(input: EducationInput): EducationProfile {
  const b = input.brief || {};
  const inferred = new Set(String(b.inferidos || '').split(',').map((x) => x.trim()).filter(Boolean));
  const ctx = input.academic;
  const withDocs = !!ctx && Array.isArray(ctx.documents) && ctx.documents.length > 0;

  // 2 · Documento: nivel, programa, asignatura, perfil del estudiante, datos adicionales («Grado: Sexto (6.º)»).
  const docSignals: StageSignal[] = [];
  if (ctx && withDocs) {
    const id = ctx.identity;
    const lvl = id && id.educationLevel && id.educationLevel.status !== 'missing' ? id.educationLevel.value : null;
    for (const t of [lvl ? lvl.text : '', val(id.program as any), val(id.subjectName as any), val(ctx.learner && (ctx.learner.profile as any)), val(id.description as any)]) {
      const s = stageSignalOf(t);
      if (s) docSignals.push(s);
    }
    const extra = ctx.additionalInfo && ctx.additionalInfo.status !== 'missing' && Array.isArray(ctx.additionalInfo.value) ? (ctx.additionalInfo.value as string[]) : [];
    for (const t of extra) {
      // «Nivel de referencia: A1 (MCER)» o «Área de formación» no dicen el nivel educativo; «Grado: Sexto (6.º)» sí.
      if (/^(area|nivel de referencia|modalidad|codigo)/.test(strip(t))) continue;
      const s = stageSignalOf(t);
      if (s) docSignals.push(s);
    }
    // El nivel que leyó el extractor (aunque el texto no sea de los conocidos).
    if (lvl && lvl.level && !docSignals.length) {
      const map: Record<string, EducationStage> = { basic: 'primaria', secondary: 'bachillerato', technical: 'tecnico', university: 'pregrado', professional: 'corporativo' };
      if (map[lvl.level]) docSignals.push({ stage: map[lvl.level], grade: null, ages: null, evidence: lvl.text, strength: 'explicit' });
    }
  }
  // 3 · Nombre del curso (pedido o curso) y lo que el usuario escribió que quiere enseñar.
  const nameSignals: StageSignal[] = [];
  const names = [b.nombre && !inferred.has('nombre') ? b.nombre : '', input.courseTitle || '', b.nombre || ''];
  for (const t of names) { const s = stageSignalOf(t); if (s) nameSignals.push(s); }
  if (b.obj) { const s = stageSignalOf(b.obj); if (s) nameSignals.push(s); }

  const doc = combine(docSignals);
  const name = combine(nameSignals);

  // Contexto vigente del pedido. «Personalizado — descríbelo…» (Otro vacío) cuenta como sin dato.
  const contexto = b.contexto && !/^personalizado — /i.test(b.contexto) ? b.contexto : null;
  const curStage = stageOfContexto(contexto);
  const curSource: 'user' | 'inferred' | null = contexto ? (inferred.has('contexto') ? 'inferred' : 'user') : null;
  // 1 · Una decisión explícita del docente en el perfil pedagógico también es suya.
  const profileUser = input.userProfileLevel && !contexto ? input.userProfileLevel : null;
  const current = { contexto, stage: curStage, source: curSource };

  const evidenceOf = (xs: StageSignal[]) => [...new Set(xs.map((x) => x.evidence))].slice(0, 3);
  let detected: EducationProfile['detected'] = null;
  let clash: { a: StageSignal; b: StageSignal; aFrom: string; bFrom: string } | null = null;
  if (doc.signal) {
    detected = { stage: doc.signal.stage, level: STAGE_LEVEL[doc.signal.stage], label: STAGE_LABEL[doc.signal.stage], grade: doc.signal.grade, ages: doc.signal.ages, source: 'document', evidence: evidenceOf(docSignals) };
    if (doc.clash) clash = { a: doc.signal, b: doc.clash, aFrom: 'el documento', bFrom: 'el documento' };
    else if (name.signal && name.signal.strength === 'explicit' && !stagesCompatible(name.signal.stage, doc.signal.stage)) clash = { a: doc.signal, b: name.signal, aFrom: 'el documento', bFrom: 'el nombre del curso' };
    // El nombre precisa el grado si el documento no lo trae («Bachillerato» + «Grado Sexto»).
    else if (name.signal && !detected.grade && name.signal.grade && stagesCompatible(name.signal.stage, detected.stage)) {
      detected = { ...detected, stage: name.signal.stage, label: STAGE_LABEL[name.signal.stage], grade: name.signal.grade, ages: name.signal.ages };
    }
  } else if (name.signal) {
    detected = { stage: name.signal.stage, level: STAGE_LEVEL[name.signal.stage], label: STAGE_LABEL[name.signal.stage], grade: name.signal.grade, ages: name.signal.ages, source: 'name', evidence: evidenceOf(nameSignals) };
    if (name.clash) clash = { a: name.signal, b: name.clash, aFrom: 'el nombre del curso', bFrom: 'lo que escribiste' };
  }

  const options = STAGE_OPTIONS.map((s) => ({ stage: s, label: STAGE_LABEL[s], contexto: contextoForStage(s, null, null) }));
  const register: string[] = [];
  const out = (p: Partial<EducationProfile>): EducationProfile => ({ version: 1, detected, current, action: 'none', proposal: null, message: null, question: null, register, ...p });

  // Señales explícitas que chocan (documento contra nombre, o dentro del documento): una pregunta, nunca adivinar.
  if (clash && curSource !== 'user') {
    const opts = [clash.a, clash.b].map((s) => ({ stage: s.stage, label: STAGE_LABEL[s.stage], contexto: contextoForStage(s.stage, s.grade, s.ages) }));
    return out({
      action: 'ask',
      message: `${cap(clash.aFrom)} indica ${gradeText(clash.a)} y ${clash.bFrom} indica ${gradeText(clash.b)}.`,
      question: { text: '¿Para quién es el curso?', options: [...opts, ...options.filter((o) => !opts.some((x) => x.stage === o.stage))], suggestion: clash.a.stage,
        why: `Sugerimos ${STAGE_LABEL[clash.a.stage]} porque ${clash.aFrom} lo dice explícitamente («${clash.a.evidence.slice(0, 80)}»).` },
    });
  }

  if (!detected) {
    if (curSource === 'user' || profileUser) return out({});
    // Sin señales y con el valor de partida (o nada): UNA pregunta con una sugerencia honesta.
    const sug = curStage && curSource === 'inferred' ? curStage : null;
    return out({
      action: 'ask',
      message: 'El nombre y el pedido del curso no dicen para qué nivel educativo es.',
      question: { text: '¿Para quién es el curso?', options, suggestion: sug,
        why: sug ? `Es el valor de partida (${STAGE_LABEL[sug]}): confírmalo o elige el nivel correcto. El tono y la dificultad de todo el contenido dependen de esto.`
          : 'El tono y la dificultad de todo el contenido dependen de esto.' },
    });
  }

  const target = contextoForStage(detected.stage, detected.grade, detected.ages);
  const school = SCHOOL.includes(detected.stage);
  const young = detected.stage === 'primaria' || detected.stage === 'basica_secundaria';
  // Registro: el texto del contexto con registro universitario para un curso escolar no encaja aunque diga «bachillerato».
  const registerClash = !!contexto && school && UNIVERSITY_REGISTER.test(strip(contexto));
  const tono = String(b.tono || '');
  const toneClash = young && /^tecnico y preciso/.test(strip(tono));
  const tonoInferred = !tono || inferred.has('tono');
  if (toneClash) register.push(`El tono «${tono.split(',')[0]}» es exigente para estudiantes ${gradeText(detected)}: conviene uno cercano y con ejemplos cotidianos.`);
  if (school && /^avanzado/.test(strip(String(b.nivel || '')))) register.push(`«${String(b.nivel).split(' — ')[1] || b.nivel}» no describe a estudiantes ${gradeText(detected)}: revisa los conocimientos previos.`);

  const compatible = !!curStage && !!contexto && contextoAccepts(curStage, detected.stage, contexto) && !registerClash;
  const ev = detected.evidence[0] ? ` («${detected.evidence[0].slice(0, 80)}»)` : '';
  const from = detected.source === 'document' ? 'el documento' : 'el nombre del curso';

  if (curSource === 'user') {
    if (compatible) return out({});
    // 5 · Nunca se pisa una decisión explícita: se respeta y se avisa con la alternativa coherente.
    return out({
      action: 'warn',
      proposal: { stage: detected.stage, contexto: target, tono: null },
      message: `Elegiste ${audienceText(curStage, contexto)}, pero ${from} indica un curso ${gradeText(detected)}${ev}. Mantenemos tu elección; si el curso es ${gradeText(detected)}, usa ${STAGE_LABEL[detected.stage]}.`,
    });
  }
  if (!profileUser || STAGE_LEVEL[detected.stage] === profileUser) {
    // Inferido por Cursia (o vacío): se corrige con la etapa del curso (revisable y con «Deshacer»). Si el valor
    // inferido ya es coherente pero genérico («Bachillerato») y el curso dice el grado, se precisa.
    const genericButPrecise = compatible && !!detected.grade && contexto !== target && (curStage === 'bachillerato' || curStage === detected.stage) && !contexto!.includes(`grado ${detected.grade}.º`);
    if (!compatible || genericButPrecise || !contexto) {
      return out({
        action: 'auto',
        proposal: { stage: detected.stage, contexto: target, tono: toneClash && tonoInferred ? DEFAULT_TONE_SCHOOL : null },
        message: contexto && !compatible
          ? `Este curso es ${gradeText(detected)} según ${from}${ev}; el contexto educativo decía ${audienceText(curStage, contexto)}. Cursia lo corrigió a ${STAGE_LABEL[detected.stage]}.`
          : `Cursia completó el contexto educativo con lo que dice ${from}: ${STAGE_LABEL[detected.stage]}${detected.grade ? `, grado ${detected.grade}.º` : ''}.`,
      });
    }
    return out({});
  }
  // El docente fijó el nivel en el perfil (Avanzado) y el curso dice otra cosa: se respeta y se avisa.
  return out({
    action: 'warn',
    proposal: { stage: detected.stage, contexto: target, tono: null },
    message: `El perfil del estudiante dice otro nivel educativo, pero ${from} indica un curso ${gradeText(detected)}${ev}. Mantenemos tu elección.`,
  });
}

function cap(s: string): string { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
