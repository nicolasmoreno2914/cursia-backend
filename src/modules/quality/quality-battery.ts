/**
 * Loop 6 · Bloque 5 — Batería de calidad de un run TERMINADO (puro: sin I/O; el servicio junta los artifacts).
 *
 * Por qué: la generación ya valida cada parte por separado (veracidad, idioma, esquemas, evidencia del banco) y el
 * motor de coherencia mide conceptos del plan (C1–C7). Faltaba UN reporte por run que mida el curso como unidad y
 * que sirva de compuerta para las optimizaciones de costo («menos USD con la misma calidad, coherencia y cohesión»):
 * dos runs del mismo diseño se comparan con compareQualityReports y una métrica que empeora más que su tolerancia
 * bloquea la optimización.
 *
 * Determinístico y léxico (sin IA): mide lo que se puede medir con certeza y deja la lectura experta a una persona.
 *   Q1 contenido perdido      — cada item del Manifest tiene su artifact vigente del tipo esperado.
 *   Q2 contenido duplicado    — párrafos casi iguales entre capítulos distintos (shingles de palabras).
 *   Q3 terminología           — los términos clave del capítulo (sidecar real) aparecen en su texto.
 *   Q4 resultados ↔ texto     — cada resultado de aprendizaje vinculado se refleja en el texto de sus capítulos.
 *   Q5 competencias           — las competencias de la bienvenida corresponden a las del contexto académico.
 *   Q6 evaluaciones           — el banco cubre los capítulos que evalúa y su evidencia está en el texto.
 *   Q7 continuidad (cohesión) — lo que un capítulo da por sabido fue introducido antes (sidecars reales).
 *   Q8 trazabilidad           — capítulos sin resultado vinculado (con contexto académico) y artifacts sin item.
 *   Q9 ejercicios guiados     — (Loop 10 C1-d, INFORMATIVO: nunca bloquea) repetidos entre capítulos, ejercicios en
 *                               el piso en todo el curso y volumen de trabajo vs minutos acreditados; dice si las
 *                               horas acreditadas por los ejercicios guiados están respaldadas (`guidedPractice`).
 */
import { GUIDED_PRACTICE_DISTINCT, GUIDED_PRACTICE_FLOORS, guidedPracticeJaccard, guidedPracticeNormTitle, guidedPracticeShingles } from '../course-shell/guided-practice';

export const QUALITY_BATTERY_VERSION = 'quality-battery-v1';

export interface QualityChapter {
  id: string;
  moduleId: string;
  title: string;
  objective?: string | null;
  outcomeIds?: string[];
  kind?: 'practice';
}
export interface QualityOutcome { id: string; text: string; domain?: string }
export interface QualityManifestItem { key: string; type: string; chapterId?: string | null; moduleId?: string | null }
export interface QualityContextSummary { concepts_introduced?: string[] | null; concepts_assumed?: string[] | null; key_terms?: string[] | null }

export interface QualityInputs {
  chapters: QualityChapter[]; // orden del curso
  outcomes: QualityOutcome[];
  competencies: QualityOutcome[];
  manifestItems: QualityManifestItem[];
  /** itemKey → tipos de artifact vigentes (no deshabilitados) de su generación completada. */
  artifactTypesByItem: Record<string, string[]>;
  /** capítulo → markdown del Libro Guía. */
  chapterMd: Record<string, string>;
  /** capítulo → sidecar real (context_summary). */
  contextSummaries: Record<string, QualityContextSummary>;
  /** competencias que muestra la bienvenida (course_intro). */
  introCompetencies?: string[] | null;
  /** itemKey del banco → preguntas (chapterId + evidence). */
  examBanks: Record<string, { chapterIds: string[]; questions: Array<{ chapterId?: string | null; evidence?: string | null }> }>;
  /** Loop 10 C1-d: capítulo → documento `dynamic_guided_practice_json` vigente (ausente = el run no tiene). */
  guidedPractices?: Record<string, QualityGuidedPracticeDoc>;
}

export interface QualityGuidedPracticeDoc {
  minutes?: number | null;
  exercises?: Array<{ id?: string; minutes?: number; kind?: string; title?: string; situation?: string; tasks?: string[]; expectedProduct?: string; modelAnswer?: string }> | null;
}

/** Loop 10 C1-d: lectura del respaldo de las horas de ejercicios guiados (informativa). */
export interface GuidedPracticeQuality {
  chapters: number;
  exercises: number;
  minutes: number;
  hours: number;
  /** Parejas de ejercicios de capítulos DISTINTOS con el mismo título o situación casi igual (Jaccard ≥ 0,5). */
  crossChapterDuplicates: number;
  /** Fracción de ejercicios «en el piso» (situación y respuesta < 1,15 × el piso de sus minutos y consignas mínimas). */
  atFloorShare: number;
  /** Palabras de trabajo (situación + consignas + producto + respuesta modelo) por minuto acreditado. */
  wordsPerCreditedMinute: number;
  /** Máximo de minutos de ejercicios guiados por cada 1000 palabras del texto del capítulo (null sin texto). */
  maxMinutesPerContentKWords: number | null;
  /** true = sin repetidos entre capítulos, no todo en el piso y volumen ≥ el mínimo por minuto. */
  supported: boolean;
}

export type QualitySeverity = 'critical' | 'warning' | 'info';
export interface QualityFinding { code: string; severity: QualitySeverity; message: string; ref?: string }
export interface QualityCheck {
  id: string;
  title: string;
  metric: number | null; // 0..1 (1 = mejor); null = no aplica (sin datos)
  threshold: number;
  pass: boolean;
  findings: QualityFinding[];
  /** Loop 10: false = informativo (nunca cambia `pass` del reporte). Ausente = bloquea como siempre. */
  blocking?: false;
  /**
   * r58 (I2): `not_measured` = la regla no tuvo datos para medirse (p. ej. Q7 sin sidecars o sin supuestos internos). Un
   * check NO MEDIDO nunca es aprobado (`pass: false`) y no cuenta para `report.pass` (`blocking: false`). Ausente = medido.
   */
  status?: 'not_measured';
  /** r58 (I2): por qué no se midió (solo con status not_measured). */
  measuredReason?: string;
}
export interface QualityReport {
  version: string;
  pass: boolean;
  checks: QualityCheck[];
  summary: Record<string, number | null>;
  /** Loop 10 C1-d: respaldo de las horas de ejercicios guiados (null si el run no tiene). */
  guidedPractice?: GuidedPracticeQuality | null;
}

/** Artifact principal esperado por tipo de item (cualquiera de la lista; los demás tipos no generan texto medible). */
export const EXPECTED_ARTIFACT_BY_ITEM_TYPE: Readonly<Record<string, readonly string[]>> = {
  course_plan: ['dynamic_course_plan_json'],
  course_intro: ['dynamic_course_intro_json'],
  module_intro: ['dynamic_module_intro_json'],
  content: ['dynamic_content_md'],
  experience: ['dynamic_experience_json'],
  video_interactions: ['dynamic_video_interactions_json'],
  application_activity: ['dynamic_application_json'],
  // Loop 9 B: una práctica guiada sin su artifact también es contenido perdido (Q1).
  guided_practice: ['dynamic_guided_practice_json'],
  // Review I5: un examen sin su banco (o su GIFT) también es contenido perdido.
  exam: ['dynamic_exam_bank_json', 'dynamic_exam_gift'],
  final_exam: ['dynamic_exam_bank_json', 'dynamic_exam_gift'],
};

// ── Normalización léxica (español) ──
const STOP = new Set(('a al algo algún alguna algunas alguno algunos ante antes aquel aquella aquellas aquello aquellos así aun aunque cada como con contra cual cuales cuando de del desde donde dos e el ella ellas ello ellos en entre era eran es esa esas ese eso esos esta estas este esto estos fue fueron ha hacia han hasta hay la las le les lo los mas más me mi mis muy ni no nos o otra otras otro otros para pero poco por porque que qué se sea sean ser si sí sin sobre su sus también tan tanto te tiene tienen todo todos tras tu tus un una unas uno unos y ya yo usar uso aplicar aplicación identificar reconocer describir explicar analizar evaluar comprender conocer realizar desarrollar manejar utilizar según cómo través forma tipo tipos').split(/\s+/));
export function normText(s: string): string {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9ñ\s]/g, ' ').replace(/\s+/g, ' ').trim();
}
function stem(w: string): string {
  return w.length > 5 ? w.slice(0, 5) : w; // raíz corta: «inspección/inspeccionar» comparten «inspe»
}
export function contentWords(s: string): string[] {
  return normText(s).split(' ').filter((w) => w.length >= 4 && !STOP.has(w));
}
function stems(s: string): Set<string> {
  return new Set(contentWords(s).map(stem));
}

function paragraphs(md: string): string[] {
  return String(md || '')
    .split(/\n\s*\n/)
    .map((p) => p.replace(/^#+\s.*$/gm, '').trim())
    .filter((p) => normText(p).split(' ').length >= 25);
}
function shingles(text: string, k = 5): Set<string> {
  const w = normText(text).split(' ');
  const out = new Set<string>();
  for (let i = 0; i + k <= w.length; i++) out.add(w.slice(i, i + k).join(' '));
  return out;
}
function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

const T = {
  Q2_DUP_JACCARD: 0.6, // párrafo casi igual a otro de OTRO capítulo
  Q2_MAX_DUP_RATE: 0.05,
  Q3_MIN_TERM_COVERAGE: 0.8,
  Q4_MIN_OUTCOME_OVERLAP: 0.34, // fracción de palabras de contenido del resultado presentes en sus capítulos
  Q4_MIN_COVERED: 0.9,
  Q5_MIN_MATCHED: 0.5,
  Q6_MIN_EVIDENCE: 0.98,
  Q7_MIN_CONTINUITY: 0.8,
  // Loop 10 C1-d (informativos)
  Q9_FLOOR_MARGIN: 1.15, // «en el piso»: situación y respuesta modelo < 1,15 × el piso de sus minutos
  Q9_MAX_AT_FLOOR_SHARE: 0.8, // ≥ 80 % de los ejercicios en el piso = «en el piso en todo el curso»
  Q9_MIN_WORDS_PER_MINUTE: 10, // palabras de trabajo por minuto acreditado (los pisos de 40 min dan ≈ 10,7)
  Q9_MAX_MINUTES_PER_CONTENT_KWORDS: 60, // minutos de ejercicios por 1000 palabras del capítulo
};
export const QUALITY_THRESHOLDS = T;

function check(id: string, title: string, metric: number | null, threshold: number, findings: QualityFinding[], higherIsBetter = true): QualityCheck {
  const pass = metric === null ? !findings.some((f) => f.severity === 'critical') : (higherIsBetter ? metric >= threshold - 1e-9 : metric <= threshold + 1e-9) && !findings.some((f) => f.severity === 'critical');
  return { id, title, metric: metric === null ? null : Math.round(metric * 10000) / 10000, threshold, pass, findings };
}

export function runQualityBattery(inp: QualityInputs): QualityReport {
  const checks: QualityCheck[] = [];
  const chapterById = new Map(inp.chapters.map((c) => [c.id, c]));
  const contentChapters = inp.chapters.filter((c) => c.kind !== 'practice');

  // Q1 contenido perdido
  {
    const f: QualityFinding[] = [];
    let expected = 0;
    let present = 0;
    for (const it of inp.manifestItems) {
      const want = EXPECTED_ARTIFACT_BY_ITEM_TYPE[it.type];
      if (!want) continue;
      expected++;
      const have = inp.artifactTypesByItem[it.key] || [];
      if (want.some((t) => have.includes(t))) present++;
      else f.push({ code: 'Q1_MISSING_ARTIFACT', severity: 'critical', message: `${it.key}: falta el artifact ${want.join(' o ')}`, ref: it.key });
    }
    checks.push(check('Q1', 'Contenido perdido (cada parte tiene su artifact)', expected ? present / expected : null, 1, f));
  }

  // Q2 duplicación entre capítulos
  {
    const f: QualityFinding[] = [];
    const paras: Array<{ ch: string; sh: Set<string>; text: string }> = [];
    for (const c of inp.chapters) for (const p of paragraphs(inp.chapterMd[c.id] || '')) paras.push({ ch: c.id, sh: shingles(p), text: p });
    let dup = 0;
    for (let i = 0; i < paras.length; i++) {
      for (let j = i + 1; j < paras.length; j++) {
        if (paras[i].ch === paras[j].ch) continue;
        if (jaccard(paras[i].sh, paras[j].sh) >= T.Q2_DUP_JACCARD) {
          dup++;
          f.push({ code: 'Q2_DUPLICATE_PARAGRAPH', severity: 'warning', message: `párrafo casi igual en «${chapterById.get(paras[i].ch)?.title}» y «${chapterById.get(paras[j].ch)?.title}»: «${paras[j].text.slice(0, 90)}…»`, ref: `${paras[i].ch}|${paras[j].ch}` });
          break;
        }
      }
    }
    const rate = paras.length ? dup / paras.length : null;
    checks.push(check('Q2', 'Contenido duplicado entre capítulos (tasa de párrafos)', rate, T.Q2_MAX_DUP_RATE, f.slice(0, 20), false));
  }

  // Q3 terminología: términos clave del sidecar presentes en el texto del capítulo
  {
    const f: QualityFinding[] = [];
    let total = 0;
    let hit = 0;
    for (const c of contentChapters) {
      const md = normText(inp.chapterMd[c.id] || '');
      const mdStems = stems(inp.chapterMd[c.id] || ''); // review M6: por palabra (no subcadena suelta)
      const terms = (inp.contextSummaries[c.id]?.key_terms || []).filter((t) => typeof t === 'string' && t.trim());
      for (const t of terms) {
        total++;
        const words = contentWords(t);
        const ok = words.length === 0 ? (' ' + md + ' ').includes(' ' + normText(t) + ' ') : words.every((w) => mdStems.has(stem(w)));
        if (ok) hit++;
        else f.push({ code: 'Q3_KEY_TERM_ABSENT', severity: 'warning', message: `«${c.title}»: el término clave «${t}» no aparece en el texto del capítulo`, ref: c.id });
      }
    }
    checks.push(check('Q3', 'Consistencia terminológica (términos clave usados en el texto)', total ? hit / total : null, T.Q3_MIN_TERM_COVERAGE, f.slice(0, 30)));
  }

  // Q4 resultados de aprendizaje ↔ texto de sus capítulos
  {
    const f: QualityFinding[] = [];
    const linked = inp.outcomes.filter((o) => inp.chapters.some((c) => (c.outcomeIds || []).includes(o.id)));
    let covered = 0;
    for (const o of linked) {
      const chs = inp.chapters.filter((c) => (c.outcomeIds || []).includes(o.id));
      const text = new Set<string>();
      for (const c of chs) for (const s of stems(inp.chapterMd[c.id] || '')) text.add(s);
      // capítulos de práctica sin libro: su texto son los capítulos de contenido del módulo
      for (const c of chs) if (c.kind === 'practice') for (const cc of contentChapters.filter((x) => x.moduleId === c.moduleId)) for (const s of stems(inp.chapterMd[cc.id] || '')) text.add(s);
      const ow = [...stems(o.text)];
      const ov = ow.length ? ow.filter((w) => text.has(w)).length / ow.length : 1;
      if (ov >= T.Q4_MIN_OUTCOME_OVERLAP) covered++;
      else f.push({ code: 'Q4_OUTCOME_NOT_REFLECTED', severity: 'warning', message: `${o.id} «${o.text.slice(0, 80)}»: solo ${(ov * 100).toFixed(0)} % de sus palabras clave aparecen en sus capítulos`, ref: o.id });
    }
    checks.push(check('Q4', 'Alineación resultados ↔ texto generado', linked.length ? covered / linked.length : null, T.Q4_MIN_COVERED, f));
  }

  // Q5 competencias de la bienvenida vs contexto académico
  {
    const f: QualityFinding[] = [];
    let metric: number | null = null;
    const intro = (inp.introCompetencies || []).filter((x) => typeof x === 'string');
    if (inp.competencies.length && intro.length) {
      const introStems = intro.map((x) => stems(x));
      let matched = 0;
      for (const c of inp.competencies) {
        const cs = stems(c.text);
        const best = Math.max(0, ...introStems.map((s) => (cs.size ? [...cs].filter((w) => s.has(w)).length / cs.size : 0)));
        if (best >= 0.34) matched++;
        else f.push({ code: 'Q5_COMPETENCY_NOT_IN_INTRO', severity: 'info', message: `${c.id} «${c.text.slice(0, 80)}» no se refleja en las competencias de la bienvenida`, ref: c.id });
      }
      metric = matched / inp.competencies.length;
    }
    checks.push(check('Q5', 'Competencias de la bienvenida ↔ contexto académico', metric, T.Q5_MIN_MATCHED, f));
  }

  // Q6 evaluaciones: cobertura de capítulos y evidencia textual
  {
    const f: QualityFinding[] = [];
    let ev = 0;
    let evOk = 0;
    for (const [key, bank] of Object.entries(inp.examBanks)) {
      for (const chId of bank.chapterIds) {
        if (!bank.questions.some((q) => q.chapterId === chId)) f.push({ code: 'Q6_CHAPTER_NOT_ASSESSED', severity: 'critical', message: `${key}: ninguna pregunta del capítulo «${chapterById.get(chId)?.title || chId}»`, ref: key });
      }
      for (const q of bank.questions) {
        if (!q.evidence || !q.chapterId) continue;
        ev++;
        const md = normText(inp.chapterMd[q.chapterId] || '');
        if (md.includes(normText(q.evidence))) evOk++;
        else f.push({ code: 'Q6_EVIDENCE_NOT_IN_CHAPTER', severity: 'warning', message: `${key}: evidencia que no está en el capítulo: «${String(q.evidence).slice(0, 80)}»`, ref: key });
      }
    }
    checks.push(check('Q6', 'Evaluaciones alineadas (cobertura y evidencia en el texto)', ev ? evOk / ev : (Object.keys(inp.examBanks).length ? 1 : null), T.Q6_MIN_EVIDENCE, f.slice(0, 30)));
  }

  // Q7 continuidad: conceptos supuestos introducidos antes (sidecars reales, orden del curso)
  {
    const f: QualityFinding[] = [];
    const seen = new Set<string>();
    let total = 0;
    let ok = 0;
    const matches = (a: string, x: string) => { const as = stems(a); const xs = stems(x); return as.size > 0 && [...as].filter((w) => xs.has(w)).length / as.size >= 0.5; };
    const allIntroduced = contentChapters.flatMap((c) => inp.contextSummaries[c.id]?.concepts_introduced || []);
    for (const c of contentChapters) {
      const s = inp.contextSummaries[c.id];
      if (!s) continue;
      for (const a of s.concepts_assumed || []) {
        // Review I4: un supuesto que NINGÚN capítulo introduce es un prerrequisito externo (lo del curso anterior o del
        // perfil): se informa, no cuenta. La cohesión mide el ORDEN: introducido después de usarse = ruptura.
        if (!allIntroduced.some((x) => matches(a, x))) { f.push({ code: 'Q7_EXTERNAL_PREREQUISITE', severity: 'info', message: `«${c.title}» da por sabido «${a}» (prerrequisito externo al curso)`, ref: c.id }); continue; }
        total++;
        // re-review M-b: introducido en el MISMO capítulo (lo define y lo usa) no es ruptura de orden.
        if ([...seen, ...(s.concepts_introduced || [])].some((x) => matches(a, x))) ok++;
        else f.push({ code: 'Q7_ASSUMED_NOT_INTRODUCED', severity: 'warning', message: `«${c.title}» da por sabido «${a}», que el curso introduce recién DESPUÉS`, ref: c.id });
      }
      for (const x of s.concepts_introduced || []) seen.add(x);
    }
    if (total) {
      checks.push(check('Q7', 'Continuidad entre capítulos (cohesión)', ok / total, T.Q7_MIN_CONTINUITY, f.slice(0, 30)));
    } else {
      // r58 (I2, AU2 E0.4): antes `null` contaba como aprobado. Ahora NO MEDIDO: nunca pasa, no bloquea el reporte y dice por qué.
      const sidecars = contentChapters.filter((c) => !!inp.contextSummaries[c.id]).length;
      const assumed = contentChapters.reduce((a, c) => a + (inp.contextSummaries[c.id]?.concepts_assumed || []).length, 0);
      const external = f.filter((x) => x.code === 'Q7_EXTERNAL_PREREQUISITE').length;
      const reason = sidecars === 0 ? 'no_sidecars' : assumed === 0 ? 'no_assumed_concepts' : 'all_assumed_external';
      const why = reason === 'no_sidecars'
        ? 'ningún capítulo tiene resumen de contexto (sidecar)'
        : reason === 'no_assumed_concepts'
          ? `${sidecars} sidecar(s) sin conceptos supuestos`
          : `los ${assumed} conceptos supuestos son prerrequisitos externos (${external}); ninguno coincide con un concepto introducido por el curso`;
      checks.push({
        id: 'Q7', title: 'Continuidad entre capítulos (cohesión)', metric: null, threshold: T.Q7_MIN_CONTINUITY, pass: false, blocking: false, status: 'not_measured', measuredReason: reason,
        findings: [{ code: 'Q7_NOT_MEASURED', severity: 'info', message: `continuidad no medida: ${why} (sidecars ${sidecars}, supuestos ${assumed}, externos ${external})` }, ...f.slice(0, 29)],
      });
    }
  }

  // Q8 trazabilidad
  {
    const f: QualityFinding[] = [];
    const manifestKeys = new Set(inp.manifestItems.map((m) => m.key));
    for (const k of Object.keys(inp.artifactTypesByItem)) if (!manifestKeys.has(k)) f.push({ code: 'Q8_ARTIFACT_WITHOUT_ITEM', severity: 'critical', message: `artifact de ${k}, que no está en el Manifest`, ref: k });
    let metric: number | null = null;
    if (inp.outcomes.length) {
      const linked = contentChapters.filter((c) => (c.outcomeIds || []).length > 0).length;
      metric = contentChapters.length ? linked / contentChapters.length : null;
      for (const c of contentChapters) if (!(c.outcomeIds || []).length) f.push({ code: 'Q8_CHAPTER_WITHOUT_OUTCOME', severity: 'info', message: `«${c.title}» no tiene resultado de aprendizaje vinculado`, ref: c.id });
    }
    checks.push(check('Q8', 'Trazabilidad (capítulos ↔ resultados; artifacts ↔ Manifest)', metric, 0, f));
  }

  // Q9 ejercicios guiados (Loop 10 C1-d, informativo)
  const gp = guidedPracticeQuality(inp, chapterById);
  checks.push(gp.check);

  const summary: Record<string, number | null> = {};
  for (const c of checks) summary[c.id] = c.metric;
  return { version: QUALITY_BATTERY_VERSION, pass: checks.every((c) => c.blocking === false || c.pass), checks, summary, guidedPractice: gp.quality };
}

function wordCount(s: unknown): number {
  return normText(String(s || '')).split(' ').filter(Boolean).length;
}

/** Q9: respaldo de los minutos de ejercicios guiados del run (puro, informativo: nunca bloquea). */
function guidedPracticeQuality(inp: QualityInputs, chapterById: Map<string, QualityChapter>): { check: QualityCheck; quality: GuidedPracticeQuality | null } {
  const f: QualityFinding[] = [];
  const docs = Object.entries(inp.guidedPractices || {}).filter(([, d]) => d && Array.isArray(d.exercises) && d.exercises.length);
  if (!docs.length) {
    return { check: { ...check('Q9', 'Ejercicios guiados (repetición, piso y volumen vs minutos; informativo)', null, 1, []), pass: true, blocking: false }, quality: null };
  }
  const xs: Array<{ ch: string; i: number; title: string; nt: string; sh: string[]; minutes: number; words: number; atFloor: boolean }> = [];
  let minutes = 0;
  for (const [ch, d] of docs) {
    const dm = typeof d.minutes === 'number' ? d.minutes : 0;
    minutes += dm;
    (d.exercises || []).forEach((e, i) => {
      const m = typeof e?.minutes === 'number' ? e.minutes : 0;
      const F = GUIDED_PRACTICE_FLOORS[m] || GUIDED_PRACTICE_FLOORS[20];
      const sit = String(e?.situation || '');
      const ans = String(e?.modelAnswer || '');
      const tasks = Array.isArray(e?.tasks) ? e.tasks : [];
      const atFloor = sit.length < F.situationMin * T.Q9_FLOOR_MARGIN && ans.length < F.modelAnswerMin * T.Q9_FLOOR_MARGIN && tasks.length <= F.tasksMin;
      xs.push({ ch, i, title: String(e?.title || ''), nt: guidedPracticeNormTitle(e?.title), sh: guidedPracticeShingles(sit), minutes: m, atFloor,
        words: wordCount(sit) + tasks.reduce((a: number, t: unknown) => a + wordCount(t), 0) + wordCount(e?.expectedProduct) + wordCount(ans) });
    });
  }
  // Repetidos entre capítulos.
  let dups = 0;
  const dupIdx = new Set<number>();
  for (let a = 0; a < xs.length; a++) {
    for (let b = a + 1; b < xs.length; b++) {
      if (xs[a].ch === xs[b].ch) continue;
      const sameTitle = !!xs[a].nt && xs[a].nt === xs[b].nt;
      const j = guidedPracticeJaccard(xs[a].sh, xs[b].sh);
      if (sameTitle || j >= GUIDED_PRACTICE_DISTINCT.situationJaccard) {
        dups++;
        dupIdx.add(a);
        dupIdx.add(b);
        if (f.length < 20) f.push({ code: 'Q9_GUIDED_DUPLICATE_ACROSS_CHAPTERS', severity: 'warning', message: `ejercicio guiado repetido entre «${chapterById.get(xs[a].ch)?.title || xs[a].ch}» y «${chapterById.get(xs[b].ch)?.title || xs[b].ch}»: «${xs[b].title}»${sameTitle ? ' (mismo título)' : ` (situación ${(j * 100).toFixed(0)} % igual)`}`, ref: `${xs[a].ch}|${xs[b].ch}` });
      }
    }
  }
  const atFloorShare = xs.length ? xs.filter((x) => x.atFloor).length / xs.length : 0;
  if (xs.length >= 2 && atFloorShare >= T.Q9_MAX_AT_FLOOR_SHARE) f.push({ code: 'Q9_GUIDED_AT_FLOOR', severity: 'warning', message: `${Math.round(atFloorShare * 100)} % de los ejercicios guiados están en el piso de su extensión: los minutos acreditados quedan justo en el mínimo en todo el curso` });
  const creditedMinutes = xs.reduce((a, x) => a + x.minutes, 0) || minutes;
  const words = xs.reduce((a, x) => a + x.words, 0);
  const wpm = creditedMinutes ? words / creditedMinutes : 0;
  if (wpm < T.Q9_MIN_WORDS_PER_MINUTE) f.push({ code: 'Q9_GUIDED_THIN_VOLUME', severity: 'warning', message: `${wpm.toFixed(1)} palabras de trabajo por minuto acreditado (< ${T.Q9_MIN_WORDS_PER_MINUTE}): poco contenido para los minutos que se cuentan` });
  let maxPerK: number | null = null;
  for (const [ch, d] of docs) {
    const w = wordCount(inp.chapterMd[ch] || '');
    if (!w) continue;
    const perK = (Number(d.minutes) || 0) / (w / 1000);
    maxPerK = maxPerK === null ? perK : Math.max(maxPerK, perK);
    if (perK > T.Q9_MAX_MINUTES_PER_CONTENT_KWORDS) f.push({ code: 'Q9_GUIDED_MINUTES_VS_CONTENT', severity: 'info', message: `«${chapterById.get(ch)?.title || ch}»: ${d.minutes} min de ejercicios guiados para ${w} palabras de capítulo (${perK.toFixed(0)} min por 1000 palabras)`, ref: ch });
  }
  const metric = xs.length ? (xs.length - dupIdx.size) / xs.length : null;
  const quality: GuidedPracticeQuality = {
    chapters: docs.length, exercises: xs.length, minutes, hours: Math.round((minutes / 60) * 10) / 10, crossChapterDuplicates: dups,
    atFloorShare: Math.round(atFloorShare * 10000) / 10000, wordsPerCreditedMinute: Math.round(wpm * 100) / 100,
    maxMinutesPerContentKWords: maxPerK === null ? null : Math.round(maxPerK * 10) / 10,
    supported: dups === 0 && !(xs.length >= 2 && atFloorShare >= T.Q9_MAX_AT_FLOOR_SHARE) && wpm >= T.Q9_MIN_WORDS_PER_MINUTE,
  };
  return { check: { ...check('Q9', 'Ejercicios guiados (repetición, piso y volumen vs minutos; informativo)', metric, 1, f), pass: true, blocking: false }, quality };
}

/**
 * Compuerta de una optimización: el reporte nuevo no puede empeorar ninguna métrica más que la tolerancia (ni perder
 * un check que pasaba). Devuelve las regresiones (vacío = la optimización conserva la calidad medible).
 */
export function compareQualityReports(baseline: QualityReport, candidate: QualityReport, tolerance = 0.02): Array<{ id: string; baseline: number | null; candidate: number | null; why: string }> {
  const out: Array<{ id: string; baseline: number | null; candidate: number | null; why: string }> = [];
  for (const b of baseline.checks) {
    // Loop 10 fix M7: un check informativo (blocking === false, p. ej. Q9) nunca bloquea una optimización.
    if (b.blocking === false) continue;
    const c = candidate.checks.find((x) => x.id === b.id);
    if (!c) { out.push({ id: b.id, baseline: b.metric, candidate: null, why: 'check ausente' }); continue; }
    if (b.pass && !c.pass) out.push({ id: b.id, baseline: b.metric, candidate: c.metric, why: 'dejó de pasar' });
    // Review I3: un check que se medía y deja de tener datos (p. ej. sin sidecars o sin evidencia) es una regresión.
    if (b.metric !== null && c.metric === null) out.push({ id: b.id, baseline: b.metric, candidate: null, why: 'sin datos' });
    if (b.metric !== null && c.metric !== null) {
      const lowerIsBetter = b.id === 'Q2';
      const worse = lowerIsBetter ? c.metric - b.metric : b.metric - c.metric;
      if (worse > tolerance) out.push({ id: b.id, baseline: b.metric, candidate: c.metric, why: `empeora ${(worse * 100).toFixed(1)} pp` });
    }
  }
  return out;
}
