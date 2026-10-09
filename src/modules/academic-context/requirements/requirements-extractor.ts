import type { SourceLine } from '../extract/text-sources';
import type {
  DocumentRequirement,
  IgnoredNumber,
  IgnoredReason,
  RequirementCondition,
  RequirementConflict,
  RequirementGroup,
  RequirementKind,
  RequirementMode,
  RequirementObligation,
  RequirementScope,
  RequirementSelection,
  RequirementsExtraction,
} from './requirements';

/**
 * LOOP 8.6A · Extractor de requisitos explícitos. Determinista, local, sin proveedores (USD 0).
 *
 * Reglas (validadas contra un conjunto de documentos reales + casos sintéticos):
 *   1. Una cifra solo es requisito con un DISPARADOR: verbo de obligación/recomendación/permiso o campo de ficha
 *      («Duración: 3 horas», «Intensidad horaria total: 64»). Sin disparador se ignora (y queda registrada).
 *   2. Cantidad = NÚMERO + SUSTANTIVO («5 capítulos»). SUSTANTIVO + NÚMERO es una referencia («capítulo 6», «Parcial 1»).
 *   3. Contexto que anula: ejemplos, pagos, horas de clase / acompañamiento / autónomas / semanales (no son el total del
 *      estudiante) y cifras dentro de una condición.
 *   4. «aproximadamente» → preferencia (nunca exacto obligatorio); «podrá … hasta» → tope permitido; «se recomienda /
 *      se propone» → recomendación. Si hay duda: confianza media («Revisa esta lectura»), nunca una obligación inventada.
 *   5. Alcance explícito (curso / por módulo / por capítulo / por resultado / por unidad / módulo n / asignatura) y grupos
 *      compuestos (N × M, parciales + final) o alternativas (S/M/L, opciones): las alternativas nunca se suman ni aplican
 *      hasta elegir una.
 */

/** «1.200» (miles) → 1200; «12,5» / «12.5» / «12,50» → 12,5. */
const numberOf = (t: string): number => (/^\d{1,3}(?:\.\d{3})+$/.test(t) ? Number(t.replace(/\./g, '')) : Number(t.replace(',', '.')));

export const REQUIREMENTS_EXTRACTOR_VERSION = 1;

// ── Normalización ────────────────────────────────────────────────────────────────────────────────────────────────

function strip(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

const WORD_NUMBERS: Record<string, number> = {
  dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10, once: 11, doce: 12, trece: 13,
  catorce: 14, quince: 15, dieciseis: 16, diecisiete: 17, dieciocho: 18, diecinueve: 19, veinte: 20, veinticuatro: 24,
  treinta: 30, cuarenta: 40, cincuenta: 50, sesenta: 60, setenta: 70, ochenta: 80, noventa: 90, cien: 100, ciento: 100,
};

// Sustantivos que Cursia modela (sobre texto normalizado, sin acentos, en minúsculas).
// Singular y plural reales («actividad / actividades», «evaluación / evaluaciones», «unidad / unidades»).
const PF = '(?: parcial(?:es)?| final(?:es)?)?';
const NOUN_SRC =
  '(actividad(?:es)? de aplicacion|actividad(?:es)?(?: interactivas?)?|modulos?|unidad(?:es)?(?: tematicas?| didacticas?| de aprendizaje)?|' +
  'capitulos?(?: de practica| de contenido)?|leccion(?:es)?|temas?|videos?|videoclases?|capsulas? de video|' +
  `evaluaci(?:on|ones)${PF}|examen(?:es)?${PF}|parcial(?:es)?|pruebas?${PF}|horas?|hrs?|h)`;
const NUMBER_SRC = '(\\d{1,4}(?:[.,]\\d{1,2})?)';
const ARTICLE = '\u00b7';
const STOP = new Set(['de', 'del', 'la', 'el', 'las', 'los', 'en', 'por', 'para', 'con', 'y', 'o', 'a', 'al', 'que', 'se', 'su', 'sus', 'cada']);

function nounKind(noun: string): { kind: RequirementKind; evaluationType?: 'any' | 'partial' | 'final'; medium?: boolean; practice?: boolean; content?: boolean } | null {
  if (/^actividad(es)? de aplicacion/.test(noun)) return { kind: 'application_activities' };
  if (/^actividad/.test(noun)) return { kind: 'activities' };
  if (/^modulo/.test(noun)) return { kind: 'modules' };
  if (/^unidad/.test(noun)) return { kind: 'units' };
  if (/^capitulos? de practica/.test(noun)) return { kind: 'chapters', practice: true };
  if (/^capitulos? de contenido/.test(noun)) return { kind: 'chapters', content: true };
  if (/^(capitulo|leccion)/.test(noun)) return { kind: 'chapters' };
  if (/^tema/.test(noun)) return { kind: 'chapters', medium: true };
  if (/^(video|capsula)/.test(noun)) return { kind: 'videos' };
  if (/^(evaluacion|examen|parcial|prueba)/.test(noun)) {
    const evaluationType = /parcial/.test(noun) ? 'partial' : /final/.test(noun) ? 'final' : 'any';
    return { kind: 'evaluations', evaluationType };
  }
  if (/^(hora|hr|h$)/.test(noun)) return { kind: 'target_hours' };
  return null;
}

/** «cuatro (4)» → «4»; palabras numéricas → dígitos; «un/una» solo delante de un sustantivo modelado. */
function numerize(n: string): string {
  let t = n.replace(/\b(\d{1,4})\s*\(\s*\1\s*\)/g, '$1');
  t = t.replace(/\b([a-z]+)\s*\(\s*(\d{1,4})\s*\)/g, (m, w, d) => (WORD_NUMBERS[w] === Number(d) ? d : m));
  t = t.replace(/\b(dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|trece|catorce|quince|dieciseis|diecisiete|dieciocho|diecinueve|veinte|veinticuatro|treinta|cuarenta|cincuenta|sesenta|setenta|ochenta|noventa|cien|ciento)\b/g, (w) => String(WORD_NUMBERS[w]));
  // «un/una» se marca (1·) para distinguir el artículo de una cantidad: solo vale 1 con alcance o calificador.
  t = t.replace(new RegExp(`\\b(un|una)\\s+(?=${NOUN_SRC}\\b)`, 'g'), '1\u00b7 ');
  return t;
}

// ── Marcadores ───────────────────────────────────────────────────────────────────────────────────────────────────

const RE_EXAMPLE = /\b(ejemplo|por ejemplo|p\. ?ej|supongamos|a modo de ejemplo|ilustrativ\w*|hipotetic\w*)\b/;
const RE_PAYMENT = /(\bpago\b|\bpagar\w*|remunera\w*|honorario\w*|reconocer\w*|\breconocimiento\b|\$|\bcop\b|\bprecio\b|\btarifa\b|\binversion\b|\bvalor del\b)/;
const RE_REQUIRED = /\b(debera|deberan|debe|deben|tendra|tendran|contara con|contaran con|constara de|constaran de|estara (?:compuest|conformad|dividid|organizad)\w*|se realizara|se realizaran|seran realizad\w*|sera realizad\w*|se desarrollara|se desarrollaran|se deben|se debe|se requiere|se requieren|es obligatori\w*|obligatoriamente|se exige|se exigen|incluira|incluiran|sera|seran|se contemplara|se contemplaran|se producira|se produciran|se aplicaran|se aplicara)\b/;
// LOOP 9 (P1-3): el presente descriptivo «incluye / contiene / contempla» también fija el curso («Cada módulo incluye 1 Actividad
// de Aplicación»), con número + sustantivo modelado, igual que «tiene».
const RE_PRESENT = /\b(tiene|tienen|consta de|constan de|esta dividid\w*|esta compuest\w*|esta organizad\w*|esta conformad\w*|se divide|se organiza|comprende|comprenden|cuenta con)\b/;
// …solo cuando el sujeto es el curso o una de sus partes: «la bibliografía incluye 3 capítulos del libro» no exige nada.
// El sujeto abre la oración (review BE-L9 m1: «La bibliografía de cada módulo incluye 3 capítulos del libro» no exige nada).
/** Conector corto al inicio de la oración («Además, cada módulo…»). */
const LEAD = '(?:(?:ademas|asimismo|tambien|por otra parte|en total|en este curso),?\\s+)?';
const RE_PRESENT_INCLUDE = /^\s*(?:(?:ademas|asimismo|tambien|por otra parte|en total|en este curso),?\s+)?(?:en\s+)?(el curso|este curso|la asignatura|el programa|el diplomado|el modulo|cada modulo|los modulos|el capitulo|cada capitulo|los capitulos|cada unidad|las unidades)\b[^.;:]{0,40}?\b(incluye|incluyen|contiene|contienen|contempla|contemplan)\b/;
const RE_RECOMMENDED = /\b(se recomienda|se recomiendan|se sugiere|se sugieren|recomendable|idealmente|preferiblemente|sugerid\w*|se propone|se proponen)\b/;
const RE_PROPOSE = /\b(se propone|se proponen)\b/;
const RE_PERMITTED = /\b(podra|podran|puede|pueden|opcional\w*|es posible)\b/;
const RE_NEGATION = /\b(no se requiere|no se requieren|no incluira|no tendra|no debera|no deben|no debe)\b/;
// Horas que NO son el total de trabajo del estudiante.
const RE_COMPONENT_HOURS = /\b(clase|clases|acompanamiento|presencial\w*|teoric\w*|practic\w*|autonom\w*|independiente|semanal\w*|por semana|a la semana|sincronic\w*|encuentro|tutoria\w*|limite|despues|antes|dedicacion semanal|had|hti|ht|hp)\b/;
const RE_TOTAL_HOURS_LABEL = /(intensidad horaria total|horas totales|total de horas|total horas|numero total de horas|duracion total|trabajo academico del estudiante|horas academicas totales)/;
// Rótulo de ficha: corto (≤ 8 palabras) y sin cifras. «…es un curso de 3 módulos por 3 capítulos: 9 capítulos» NO es un rótulo.
const RE_FIELD_LABEL = /^((?:[^:\d\s]+\s+){0,7}[^:\d\s]+)\s*:\s*(.+)$/;
/** Rótulos de ficha sobre algo que Cursia modela («Duración», «Número de módulos», «Intensidad horaria total»…). */
const RE_MODELED_LABEL = /\b(duracion|intensidad|horas|numero de|cantidad de|modulos?|capitulos?|unidades|videos?|evaluacion(?:es)?|examen(?:es)?|parcial(?:es)?|actividades|actividad de aplicacion|estructura)\b/;
// Descripción genérica o del producto («nuestro curso estándar», «por lo general»): no exige nada a ESTE curso.
const RE_GENERIC = /\b(curso estandar|cursos estandar|nuestro curso|nuestros cursos|por lo general|normalmente|habitualmente|tipicamente|en general)\b/;
const RE_CONDITION_START = /^(si|cuando|en caso de que|para (?:los |las )?(?:cursos|asignaturas|programas|diplomados|espacios academicos)|dependiendo d\w*|segun)\b/;

// ── Segmentos ────────────────────────────────────────────────────────────────────────────────────────────────────

interface Segment {
  text: string;
  line: number;
  page: number | null;
  option?: string;
  /** Cita original (fila de una tabla de tamaños, antes de quitarle precio y horas semanales). */
  quote?: string;
  block?: { level: 'module' | 'unit'; index: number };
  example: boolean;
  cells: boolean;
  /** LOOP 9.2: dentro de una sección que el documento declara no prescriptiva. */
  informative?: boolean;
}

/** LOOP 9.2 · Título de una sección que no exige nada («15. Información no prescriptiva», «Referencias de contexto»…). */
const RE_NONPRESCRIPTIVE_HEAD = /(no prescriptiv\w*|informacion (de contexto|contextual|complementaria no obligatoria)|referencias? de contexto|no constituyen requisitos|solo (para )?contextualizar)/;
/**
 * ¿La línea abre una sección? Review I10: si el documento tiene títulos con estilo (Word/Markdown), solo esos; si no, un
 * numerado que SIGUE la numeración de las secciones (15 → 16, no los ítems «1.», «2.» de una lista), un título en
 * mayúsculas o un «Anexo …».
 */
function sectionHeadingDetector(lines: SourceLine[]): (l: SourceLine, raw: string) => boolean {
  const styled = lines.some((l) => !!l.heading);
  let last: number | null = null;
  return (l, raw) => {
    if (l.cells) return false;
    const n = /^\s*(\d{1,2})[.)]\s+\S/.exec(raw);
    const short = raw.length <= 90 && !/[.;:]$/.test(raw);
    if (styled && l.heading) { if (n) last = Number(n[1]); return true; }
    // Review 2.ª (M2): en un DOCX con algunos títulos con estilo, la numeración continua también abre sección.
    if (n && short && (last === null || Number(n[1]) === last + 1)) { last = Number(n[1]); return true; }
    if (short && /^(anexo|apendice)\b/i.test(raw)) return true;
    const letters = raw.replace(/[^A-Za-zÁÉÍÓÚÑáéíóúñ]/g, '');
    return short && letters.length >= 4 && letters === letters.toUpperCase() && raw.split(/\s+/).length <= 8;
  };
}

const ROMAN: Record<string, number> = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10 };
const RE_BLOCK = /^(modulo|sesion|unidad)\s+(\d{1,2}|[ivx]{1,4})\b/;
const RE_OPTION = /^\s*(?:opci[oó]n\s+|talla\s+|tama[nñ]o\s+|paquete\s+)?(XS|S|M|L|XL)\s*[:—–]\s*(.+)$/;
const RE_OPTION_NAMED = /^\s*opci[oó]n\s+([A-Z0-9]{1,3})\s*[:—–-]\s*(.+)$/i;

// Tabla de tamaños sin «:» (como la entregan los PDF): la etiqueta sola en su línea («L», luego sus celdas en las
// líneas siguientes) o al inicio de la fila seguida de un número («S 1 h/sem 20-22 h 3 módulos × 3 capítulos $800.000»).
const RE_SIZE_ALONE = /^(XS|S|M|L|XL)$/;
const RE_SIZE_ROW = /^(XS|S|M|L|XL)(?:\s*·\s*|\s+)(?=\d)(.*)$/;
const RE_UNIT_ONLY = /^(?:\d{1,4}\s*(?:-|–|a)\s*)?\d{0,4}\s*(?:h|horas?|hrs?)\.?$/;

/** Bloques de una tabla de tamaños: { índices de línea consumidos, etiqueta, texto de datos limpio }. */
function sizeTableBlocks(raws: string[]): Map<number, { label: string; text: string; quote: string; consumed: number[] }> {
  const starts: { i: number; label: string; rest: string }[] = [];
  raws.forEach((r, i) => {
    const a = RE_SIZE_ALONE.exec(r);
    const b = a ? null : RE_SIZE_ROW.exec(r);
    if (a) starts.push({ i, label: a[1], rest: '' });
    else if (b) starts.push({ i, label: b[1], rest: b[2] });
  });
  const blocks: { i: number; label: string; text: string; quote: string; consumed: number[] }[] = [];
  const startSet = new Set(starts.map((s) => s.i));
  for (const s of starts) {
    const parts = s.rest ? [s.rest] : [];
    const consumed = [s.i];
    const status = () => {
      const t = strip(parts.join(' '));
      const mods = /\d\s*modulos?\b/.test(t);
      const caps = mods && /modulos?\b[^]*?\d\s*capitulos?\b/.test(t);
      const hours = /\d\s*(?:h|horas?|hrs?)\b(?!\s*\/)/.test(t.replace(/\d+\s*h\s*\/\s*sem\w*/g, ''));
      return { complete: (mods && caps) || (hours && !mods), any: mods || hours };
    };
    for (let j = s.i + 1; j < raws.length && j <= s.i + 8 && !startSet.has(j); j++) {
      if (status().complete) {
        // Después de completar la fila solo se admite una unidad suelta («h») que el PDF partió.
        if (RE_UNIT_ONLY.test(strip(raws[j]))) { parts.push(raws[j]); consumed.push(j); }
        break;
      }
      parts.push(raws[j]);
      consumed.push(j);
    }
    if (!status().any) continue;
    // Datos de la fila: fuera precios, horas semanales y «N cursos» (no son del curso).
    const text = parts.join(' ').replace(/\$\s?[\d.,]+/g, ' ').replace(/\b\d{1,2}\s*h\s*\/\s*sem\w*/gi, ' ').replace(/\b\d{1,4}\s+cursos\b/gi, ' ').replace(/\s*·\s*/g, ' ').replace(/\s+/g, ' ').trim();
    blocks.push({ i: s.i, label: s.label, text, quote: consumed.map((j) => raws[j]).join(' · '), consumed });
  }
  // Solo es una tabla de tamaños si hay al menos dos etiquetas distintas cercanas (≤ 40 líneas entre sí).
  const out = new Map<number, { label: string; text: string; quote: string; consumed: number[] }>();
  for (const b of blocks) {
    const near = blocks.filter((o) => Math.abs(o.i - b.i) <= 40 && o.label !== b.label);
    if (near.length) out.set(b.i, { label: b.label, text: b.text, quote: b.quote, consumed: b.consumed });
  }
  return out;
}

function segmentsOf(lines: SourceLine[]): Segment[] {
  const out: Segment[] = [];
  let block: Segment['block'];
  let exampleUntil = -1;
  const raws = lines.map((l) => (l.cells && l.cells.length ? l.cells.filter((c) => c && c.trim()).join(' | ') : l.text).replace(/\s+/g, ' ').trim());
  const sizes = sizeTableBlocks(raws);
  const consumed = new Set<number>();
  for (const b of sizes.values()) for (const j of b.consumed) consumed.add(j);
  let informative = false;
  const isSectionHeading = sectionHeadingDetector(lines);
  lines.forEach((l, i) => {
    const raw = raws[i];
    if (!raw) return;
    // LOOP 9.2: una sección «no prescriptiva» no aporta requisitos hasta el encabezado siguiente.
    if (isSectionHeading(l, raw)) informative = RE_NONPRESCRIPTIVE_HEAD.test(strip(raw));
    const size = sizes.get(i);
    if (size) {
      out.push({ text: size.text, quote: size.quote, line: l.line, page: l.page, block, example: i <= exampleUntil, cells: true, option: size.label });
      return;
    }
    if (consumed.has(i)) return;
    const n = strip(raw);
    const b = RE_BLOCK.exec(n);
    if (b) block = { level: b[1] === 'unidad' ? 'unit' : 'module', index: /\d/.test(b[2]) ? Number(b[2]) : ROMAN[b[2]] || 0 };
    // Zona de ejemplo: un rótulo «EJEMPLO» / «Ejemplo:» cubre las líneas que le siguen inmediatamente.
    if (/^(ejemplo\b|como ejemplo\b|por ejemplo\b)/.test(n) || /\bejemplo\s*[·:]/.test(n) || (raw === raw.toUpperCase() && /EJEMPLO/.test(raw))) exampleUntil = i + 6;
    const opt = RE_OPTION.exec(raw) || RE_OPTION_NAMED.exec(raw);
    const seg: Segment = { text: raw, line: l.line, page: l.page, block, example: i <= exampleUntil, cells: !!(l.cells && l.cells.length), ...(informative ? { informative: true } : {}) };
    if (opt) {
      seg.option = opt[1].toUpperCase();
      seg.text = opt[2].trim();
    }
    const prev = out[out.length - 1];
    // Un párrafo que el PDF partió en varias líneas: se une si la anterior no cierra frase y esta sigue en minúscula.
    if (prev && !seg.option && !prev.option && !seg.cells && !prev.cells && prev.page === seg.page && !/[.:;!?]$/.test(prev.text) && /^[a-záéíóúñ(]/.test(raw) && !b) {
      prev.text = `${prev.text} ${raw}`;
      return;
    }
    out.push(seg);
  });
  return out;
}

function sentencesOf(seg: Segment): string[] {
  return seg.text.split(/(?<=[.;!?])\s+(?=[A-ZÁÉÍÓÚÑ¿¡•\-(])/).map((s) => s.trim()).filter(Boolean);
}

// ── Menciones ────────────────────────────────────────────────────────────────────────────────────────────────────

interface Mention {
  kind: RequirementKind;
  value: number;
  valueMax?: number;
  mode: RequirementMode;
  evaluationType?: 'any' | 'partial' | 'final';
  scope: RequirementScope;
  medium?: boolean;
  index: number;
  end: number;
  raw: string;
}

const RE_QTY = new RegExp(
  `(?:(entre)\\s+${NUMBER_SRC}\\s+y\\s+|(de)\\s+${NUMBER_SRC}\\s+a\\s+|${NUMBER_SRC}\\s*(?:-|–|a)\\s*)?${NUMBER_SRC}(${ARTICLE})?\\s+(?:([a-z]+)\\s+)?${NOUN_SRC}\\b`,
  'g',
);

/** Verbos que una negación gobierna sobre «más/menos de N» (review I9). */
const NEG_VERB = '(?:tendra|tendran|habra|sera|seran|incluira|incluiran|contara con|contaran con|podra tener|podran tener|exigira|exigiran|realizara|realizaran|debera tener|deberan tener|tiene|tienen|incluye|incluyen)';

function num(s: string): number {
  return Number(s.replace(ARTICLE, '').replace(',', '.'));
}

function scopeAfter(after: string, kind: RequirementKind): RequirementScope | null {
  if (kind !== 'modules' && /^\s*(por modulo|en cada modulo|de cada modulo|cada uno|por cada modulo)\b/.test(after)) return { level: 'module', each: true };
  if (kind !== 'chapters' && /^\s*(por capitulo|en cada capitulo|de cada capitulo|por cada capitulo)\b/.test(after)) {
    if (/^\s*\S+ (cada )?capitulo de practica/.test(after) || /capitulo de practica/.test(after.slice(0, 40))) return { level: 'chapter', each: true, chapterKind: 'practice' };
    // LOOP 9.2: «2 videos por cada capítulo de contenido» (no en los de práctica).
    if (/capitulo de contenido/.test(after.slice(0, 40))) return { level: 'chapter', each: true, chapterKind: 'content' };
    return { level: 'chapter', each: true };
  }
  if (/^\s*(por resultado|por cada resultado|en cada resultado|por resultado de aprendizaje)\b/.test(after)) return { level: 'outcome', each: true };
  if (kind !== 'units' && /^\s*(por unidad|en cada unidad|de cada unidad)\b/.test(after)) return { level: 'unit', each: true };
  if (/^\s*(en total|en el curso|del curso|en todo el curso)\b/.test(after)) return { level: 'course' };
  return null;
}

function mentionsOf(m: string, sentenceScope: RequirementScope | null, ignored: (r: IgnoredReason, q: string) => void): Mention[] {
  const out: Mention[] = [];
  RE_QTY.lastIndex = 0;
  let x: RegExpExecArray | null;
  while ((x = RE_QTY.exec(m))) {
    const [all, , rangeA, , rangeB, rangeC, nStr, article, filler, noun] = x;
    if (filler && STOP.has(filler)) {
      // «1 y examen final»: el relleno es una palabra vacía → no es «número + sustantivo».
      RE_QTY.lastIndex = x.index + 1;
      continue;
    }
    const k = nounKind(noun);
    if (!k) continue;
    const start = x.index;
    const before = m.slice(Math.max(0, start - 40), start);
    const after = m.slice(start + all.length, start + all.length + 60);
    // Referencia: el sustantivo va ANTES del número («capítulo 6», «parcial 1»).
    if (/\b(capitulo|pagina|pag|seccion|ejemplo|figura|tabla|parcial|examen|semana|unidad|modulo|sesion|paso|nivel|anexo|numeral|item|corte)\s*$/.test(before) && !rangeA && !rangeB && !rangeC) {
      ignored('reference', all);
      continue;
    }
    if (k.kind === 'chapters' && /^\s*(del|de) (libro|texto|manual)/.test(after)) {
      ignored('reference', all);
      continue;
    }
    if (k.kind === 'target_hours') {
      const near = `${before.slice(-30)} ${noun} ${after.slice(0, 45)}`;
      if (RE_COMPONENT_HOURS.test(near) && !RE_TOTAL_HOURS_LABEL.test(near)) {
        ignored('component_hours', all);
        continue;
      }
    }
    let mode: RequirementMode = 'exact';
    let value = num(nStr);
    let valueMax: number | undefined;
    const lo = rangeA ?? rangeB ?? rangeC;
    if (lo !== undefined) {
      mode = 'range';
      valueMax = value;
      value = num(lo);
    } else if (/(aproximadamente|alrededor de|cerca de|aprox\.?|unas|unos)\s*$/.test(before)) mode = 'approx';
    // LOOP 9.2: la negación que gobierna el cuantificador («no tendrá menos de 5» = al menos 5; «no tendrá más de 5» =
    // hasta 5; «sin más de 2» = hasta 2). Review I9: solo «no + verbo + más/menos de», nunca un «no» cualquiera antes.
    else if (/\bno menos de\s*$/.test(before)) mode = 'min';
    else if (/\bno mas de\s*$/.test(before)) mode = 'max';
    else if (new RegExp(`\\b(?:no\\s+(?:se\\s+)?${NEG_VERB}\\s+|sin\\s+)menos de\\s*$`).test(before)) mode = 'min';
    else if (new RegExp(`\\b(?:no\\s+(?:se\\s+)?${NEG_VERB}\\s+|sin\\s+)mas de\\s*$`).test(before)) mode = 'max';
    else if (/(minimo|minimo de|como minimo|como minimo de|al menos|por lo menos|no menos de|mas de)\s*$/.test(before)) {
      mode = 'min';
      // LOOP 9.2: «más de 2 evaluaciones» = al menos 3 (no «al menos 2»). En horas (continuas) queda el mínimo.
      if (/mas de\s*$/.test(before) && !/no mas de\s*$/.test(before) && k.kind !== 'target_hours') value += 1;
    } else if (/(maximo|maximo de|como maximo|como maximo de|hasta|no mas de|a lo sumo|menos de)\s*$/.test(before)) {
      mode = 'max';
      if (/(^|[^o] )menos de\s*$/.test(before) && !/no menos de\s*$/.test(before) && k.kind !== 'target_hours') value = Math.max(0, value - 1);
    }
    const explicitScope = scopeAfter(after, k.kind);
    // «una evaluación del grado de avance» es un artículo: «un/una» solo es 1 con alcance («en cada capítulo»,
    // «Cada módulo … una actividad») o con un calificador («mínimo una…»).
    if (article && !explicitScope && !(sentenceScope && k.kind !== 'modules') && !/(minimo|maximo|al menos|solo|solamente|unicamente|exactamente)\s*$/.test(before)) {
      continue;
    }
    let scope: RequirementScope = explicitScope ?? (k.kind !== 'modules' && sentenceScope ? sentenceScope : { level: 'course' });
    // LOOP 9.2: «cada módulo tendrá 1 capítulo de práctica» = 1 práctica POR MÓDULO (antes: «1 capítulo por capítulo de
    // práctica», un alcance sin sentido que Cursia no medía y la práctica desaparecía del diseño). Sin módulo: en el curso.
    // Review I11: «… y cada módulo tendrá 1 capítulo de práctica» (el alcance justo antes del sustantivo, a mitad de oración).
    const modBefore = /\b(cada modulo|por modulo|en cada modulo)\b[^.;:]{0,30}$/.test(before);
    if (k.practice) scope = (scope.level === 'module' && 'each' in scope) || modBefore ? { level: 'module', each: true, chapterKind: 'practice' } : { level: 'course', chapterKind: 'practice' };
    else if (k.content && scope.level === 'module' && 'each' in scope) scope = { level: 'module', each: true, chapterKind: 'content' };
    else if (k.content && scope.level === 'course') scope = { level: 'course', chapterKind: 'content' };
    out.push({ kind: k.kind, value, valueMax, mode, evaluationType: k.evaluationType, scope, medium: k.medium, index: start, end: start + all.length, raw: all });
  }
  return out;
}

// ── Extracción ───────────────────────────────────────────────────────────────────────────────────────────────────

function scopeKey(s: RequirementScope): string {
  switch (s.level) {
    case 'module':
      return 'each' in s ? `module·each${s.chapterKind ? `:${s.chapterKind}` : ''}` : `module:${s.index}`;
    case 'chapter':
      return `chapter·each${s.chapterKind ? `:${s.chapterKind}` : ''}`;
    case 'unit':
      return 'each' in s ? 'unit·each' : `unit:${s.index}`;
    case 'subject':
      return `subject:${strip(s.subject)}`;
    case 'course':
      return s.chapterKind ? `course:${s.chapterKind}` : 'course';
    case 'structure':
      return s.chapterKind ? `structure:${s.chapterKind}` : 'structure';
    default:
      return 'outcome·each';
  }
}

function conditionOf(c: string): RequirementCondition {
  const cr = /(mas de|menos de)?\s*(\d{1,2})\s*creditos?/.exec(c);
  if (cr) return { text: c, modeled: true, field: 'credits', op: cr[1] === 'mas de' ? '>' : cr[1] === 'menos de' ? '<' : '=', value: Number(cr[2]) };
  const mo = /\b(virtual|presencial|hibrid\w*|a distancia)\b/.exec(c);
  if (mo) return { text: c, modeled: true, field: 'modality', op: '=', value: mo[1] };
  return { text: c, modeled: false };
}

/** LOOP 9 (P1-10): de qué habla un choque, en palabras (antes se mostraba la clave interna «target_hours@course»). */
const CONFLICT_SUBJECT: Readonly<Record<string, string>> = {
  target_hours: 'las horas de trabajo del estudiante', modules: 'la cantidad de módulos', units: 'las unidades', chapters: 'los capítulos', structure: 'la estructura',
  videos: 'los videos', application_activities: 'las Actividades de Aplicación', activities: 'las actividades interactivas', evaluations: 'las evaluaciones',
};
function conflictSubject(r: DocumentRequirement): string {
  const base = r.kind === 'evaluations' && r.evaluationType === 'partial' ? 'las evaluaciones parciales'
    : r.kind === 'evaluations' && r.evaluationType === 'final' ? 'la evaluación final' : CONFLICT_SUBJECT[r.kind] || 'un mismo dato';
  const sc = r.scope as any;
  const scope = sc && sc.each ? (sc.level === 'module' ? ' por módulo' : sc.level === 'chapter' ? ' por capítulo' : sc.level === 'unit' ? ' por unidad' : '')
    : sc && sc.index ? (sc.level === 'module' ? ` del módulo ${sc.index}` : sc.level === 'unit' ? ` de la unidad ${sc.index}` : '') : '';
  return base + scope;
}

export function extractRequirements(lines: SourceLine[], documentId = 'doc'): RequirementsExtraction {
  const segs = segmentsOf(lines);
  const requirements: DocumentRequirement[] = [];
  const groups: RequirementGroup[] = [];
  const ignored: IgnoredNumber[] = [];
  const joined = strip(lines.map((l) => (l.cells ? l.cells.join(' ') : l.text)).join('\n'));

  // Documento de varias asignaturas: filas «Asignatura — N horas», varias identificaciones de asignatura, tablas con
  // créditos por fila o un catálogo con precios.
  const subjectRows = segs.filter((s) => !s.option && /^([A-ZÁÉÍÓÚÑ][^—–:]{2,60}?)\s*[—–]\s*\d{1,4}\s*(h|horas)\b/i.test(s.text));
  const identities = (joined.match(/nombre (?:del espacio academico|de la asignatura|del curso)\s*:/g) || []).length;
  const creditRows = (joined.match(/\b\d\s*cr\b/g) || []).length;
  const catalog = (joined.match(/\$\s?\d/g) || []).length >= 3 && (joined.match(/\bdiplomados?\b/g) || []).length >= 5;
  // Propuesta o malla que entrega varios cursos («56 cursos en Moodle», «36 cursos», «piloto de 3 asignaturas»).
  const courseCounts = (joined.match(/\b([3-9]|[1-9]\d{1,2}) (?:cursos|asignaturas|materias)\b/g) || []).length;
  const multiCourse = subjectRows.length >= 2 || identities >= 2 || creditRows >= 3 || catalog || courseCounts >= 2;
  const subjects: string[] = [];

  let seq = 0;
  const push = (r: Omit<DocumentRequirement, 'id' | 'key'>): DocumentRequirement => {
    const key = `${r.kind}@${scopeKey(r.scope)}${r.kind === 'evaluations' && r.evaluationType && r.evaluationType !== 'any' ? `#${r.evaluationType}` : ''}`;
    const req: DocumentRequirement = { id: `RQ${++seq}`, key, ...r };
    requirements.push(req);
    return req;
  };

  let optionRun: { group: RequirementGroup; labels: Set<string> } | null = null;
  let pendingAnaphora: { mentions: Mention[]; seg: Segment; quote: string } | null = null;

  for (const seg of segs) {
    if (!seg.option) optionRun = null;
    const src = (quote: string) => ({ documentId, line: seg.line, page: seg.page, quote: (seg.quote || quote).slice(0, 300) });

    // Filas de asignatura.
    const sr = /^([A-ZÁÉÍÓÚÑ][^—–:]{2,60}?)\s*[—–]\s*(\d{1,4})\s*(?:h|horas)\b/i.exec(seg.text);
    if (subjectRows.length >= 2 && sr) {
      const subject = sr[1].trim();
      subjects.push(subject);
      push({ kind: 'target_hours', scope: { level: 'subject', subject }, mode: 'exact', value: Number(sr[2]), obligation: 'required', active: false, status: 'found', confidence: 'high', review: ['Aplica solo a esta asignatura: elige la asignatura del curso.'], source: src(seg.text) });
      continue;
    }

    for (const sentence of sentencesOf(seg)) {
      const n0 = strip(sentence);
      const quote = sentence;
      const ign = (reason: IgnoredReason, q: string) => ignored.push({ reason, quote: q.slice(0, 160), line: seg.line });
      // LOOP 9.2: lo que el documento declara no prescriptivo («NO constituyen requisitos») no se convierte en requisito.
      if (seg.informative) {
        if (/\d/.test(n0)) ign('not_prescriptive', sentence);
        continue;
      }
      if (seg.example || RE_EXAMPLE.test(n0)) {
        if (/\d/.test(n0)) ign('example', sentence);
        continue;
      }
      // Condición: la cláusula inicial hasta la primera coma no aporta requisitos; condiciona los de la principal.
      let condition: RequirementCondition | undefined;
      let main = n0;
      const cs = RE_CONDITION_START.exec(n0);
      if (cs) {
        const comma = n0.indexOf(',');
        if (comma > 0) {
          condition = conditionOf(n0.slice(0, comma));
          if (/\d/.test(n0.slice(0, comma))) ign('condition_clause', n0.slice(0, comma));
          main = n0.slice(comma + 1);
        }
      }
      const m = numerize(main);
      if (RE_PAYMENT.test(m)) {
        if (/\d/.test(m)) ign('payment', sentence);
        continue;
      }

      // Obligación de la oración.
      const field = RE_FIELD_LABEL.exec(m);
      const generic = RE_GENERIC.test(m);
      let obligation: RequirementObligation | null = null;
      let medium = false;
      if (RE_RECOMMENDED.test(m)) {
        obligation = 'recommended';
        if (RE_PROPOSE.test(m)) medium = true;
      } else if (RE_PERMITTED.test(m) && !/\bno (podra|podran|puede|pueden)\b/.test(m)) obligation = 'permitted';
      // Review 2.ª (M4): «no podrá tener más de 4 módulos» es una prohibición: un máximo obligatorio.
      else if (/\bno (podra|podran|puede|pueden)\b/.test(m)) obligation = 'required';
      else if (RE_REQUIRED.test(m)) obligation = 'required';
      else if (RE_PRESENT.test(m) || RE_PRESENT_INCLUDE.test(m)) {
        obligation = 'required';
        medium = true;
      } else if (seg.option || (field && /\d/.test(field[2]) && RE_MODELED_LABEL.test(field[1]))) obligation = 'required'; // dato de ficha u opción rotulada

      // Alcance de la oración («Cada módulo deberá…», «Cada capítulo de práctica…»).
      let sentenceScope: RequirementScope | null = null;
      if (new RegExp(`^\\s*${LEAD}(en )?cada modulo\\b`).test(m)) sentenceScope = { level: 'module', each: true };
      else if (new RegExp(`^\\s*${LEAD}(en )?cada capitulo de practica\\b`).test(m)) sentenceScope = { level: 'chapter', each: true, chapterKind: 'practice' };
      else if (new RegExp(`^\\s*${LEAD}(en )?cada capitulo\\b`).test(m)) sentenceScope = { level: 'chapter', each: true };
      else if (new RegExp(`^\\s*${LEAD}(en )?cada unidad\\b`).test(m)) sentenceScope = { level: 'unit', each: true };

      // Campo de ficha con número suelto: el tipo sale del rótulo («Número de módulos: 4», «Capítulos por módulo: 5»).
      let mentions: Mention[] = [];
      if (field && /^\s*\d{1,4}(?:[.,]\d+)?\s*$/.test(field[2]) && RE_MODELED_LABEL.test(field[1])) {
        const label = field[1];
        // El tipo sale del sustantivo ANTES de «por / cada» («Videos por capítulo» son videos); el alcance, de lo que sigue.
        const head = label.split(/\b(?:por|en cada|de cada|cada)\b/)[0];
        const k = /actividad(es)? de aplicacion/.test(head) ? 'application_activities' : /video/.test(head) ? 'videos' : /modulo/.test(head) ? 'modules' : /capitulo/.test(head) ? 'chapters' : /(evaluacion|examen|parcial)/.test(head) ? 'evaluations' : /(horas|intensidad|duracion)/.test(head) ? 'target_hours' : null;
        const evaluationType = /parcial/.test(label) ? ('partial' as const) : /final/.test(label) ? ('final' as const) : ('any' as const);
        if (k) {
          const v = Number(field[2].trim().replace(',', '.'));
          const scope: RequirementScope = /por modulo|cada modulo/.test(label) ? { level: 'module', each: true } : /por capitulo|cada capitulo/.test(label) ? { level: 'chapter', each: true } : { level: 'course' };
          if (!(k === 'target_hours' && RE_COMPONENT_HOURS.test(label) && !RE_TOTAL_HOURS_LABEL.test(label))) {
            mentions = [{ kind: k as RequirementKind, value: v, mode: 'exact', scope, index: 0, end: m.length, raw: m, ...(k === 'evaluations' ? { evaluationType } : {}) }];
          }
        }
      }
      if (!mentions.length) mentions = mentionsOf(m, sentenceScope, ign);
      // LOOP 9.2 · Cláusula de reparto tras el total: «2 Actividades de Aplicación: 1 por módulo, ubicadas en los capítulos
      // de práctica», «4 actividades interactivas H5P: 1 por cada capítulo de contenido». El total Y el reparto (y dónde
      // va) son requisitos: antes solo quedaba el total y el diseño podía poner las dos actividades en el mismo módulo.
      const DIST_G = /:\s*(\d{1,3})\s+por\s+(?:cada\s+)?(modulo|capitulo(?: de (?:contenido|practica))?)\b/g;
      let dm: RegExpExecArray | null;
      while ((dm = DIST_G.exec(m))) {
        const at = dm.index;
        const total = [...mentions].filter((x) => x.index < at && x.scope.level === 'course' && x.mode === 'exact').sort((a, b) => b.index - a.index)[0];
        if (!total || total.kind === 'modules' || total.kind === 'target_hours' || total.kind === 'evaluations') continue;
        const unit = dm[2];
        const inPractice = /\b(ubicad\w*|situad\w*|incluid\w*)?\s*en (el|los|cada) capitulos? de practica/.test(m.slice(at));
        let scope: RequirementScope;
        if (unit === 'modulo') scope = inPractice ? { level: 'module', each: true, chapterKind: 'practice' } : { level: 'module', each: true };
        else scope = /de contenido/.test(unit) ? { level: 'chapter', each: true, chapterKind: 'content' } : /de practica/.test(unit) ? { level: 'chapter', each: true, chapterKind: 'practice' } : { level: 'chapter', each: true };
        mentions.push({ kind: total.kind, value: Number(dm[1]), mode: 'exact', ...(total.evaluationType ? { evaluationType: total.evaluationType } : {}), scope, index: at, end: at + dm[0].length, raw: dm[0] });
      }
      // «N módulos × M capítulos» / «N módulos de M capítulos» / «N módulos por M capítulos»: los M son de CADA módulo.
      const cross = /(\d{1,3})\s*modulos?\s*(?:x|×|\*|por|de)\s*(\d{1,3})\s*capitulos?/.exec(m);
      // Review 2.ª (I3): «2 módulos de 2 capítulos de contenido» conserva «de contenido».
      if (cross) for (const x of mentions) if (x.kind === 'chapters' && x.value === Number(cross[2]) && x.scope.level === 'course') x.scope = (x.scope as { chapterKind?: string }).chapterKind === 'content' ? { level: 'module', each: true, chapterKind: 'content' } : { level: 'module', each: true };

      // Total de horas por rótulo (re-review final L86C: con decimales, «12,5 horas» → 12,5 y no 12) («Total Horas de Trabajo Académico del Estudiante (HAD+HTI) 192», «160 horas totales»).
      const tl = /(intensidad horaria total|horas totales|total de horas|total horas|numero total de horas|duracion total|trabajo academico del estudiante)([^0-9]{0,90}?)(\d{1,3}(?:\.\d{3})+(?!\d)|\d{1,4}(?:[,.]\d{1,2}(?!\d))?)(?![\d.,])/.exec(m);
      const tb = /\b(\d{1,3}(?:\.\d{3})+(?!\d)|\d{1,4}(?:[,.]\d{1,2}(?!\d))?)\s*horas totales\b/.exec(m);
      let totalHours: number | null = null;
      // «… (HT+HP) 48 Horas Totales»: en una tabla el 48 es de la celda anterior (acompañamiento), no el total.
      if (tb && !RE_COMPONENT_HOURS.test(m.slice(Math.max(0, tb.index - 60), tb.index).replace(/\((had|hti|ht|hp)\s*\+\s*(had|hti|ht|hp)\)/g, ''))) totalHours = numberOf(tb[1]);
      else if (tl && !RE_COMPONENT_HOURS.test(tl[2].replace(/\((had|hti|ht|hp)\s*\+\s*(had|hti|ht|hp)\)/g, ''))) totalHours = numberOf(tl[3]);
      if (totalHours !== null) {
        mentions = mentions.filter((x) => x.kind !== 'target_hours');
        mentions.push({ kind: 'target_hours', value: totalHours, mode: 'exact', scope: { level: 'course' }, index: 0, end: 0, raw: 'total' });
        if (!obligation) obligation = 'required';
      }

      // Duración de un módulo/sesión: «Duración: 3 horas» dentro del bloque «Sesión 1».
      if (field && /duracion/.test(field[1]) && seg.block && seg.block.index && totalHours === null) {
        for (const x of mentions) if (x.kind === 'target_hours') x.scope = seg.block.level === 'unit' ? { level: 'unit', index: seg.block.index } : { level: 'module', index: seg.block.index };
      }

      // Total inferido: «8 semanas (12 horas de dedicación semanal)» / «16 semanas de 4 horas».
      const inf = /(\d{1,2})\s*semanas?\s*(?:\(|de|con)\s*(\d{1,2})\s*horas?\s*(?:de dedicacion\s*)?(?:semanal\w*|por semana|a la semana|cada una)?/.exec(m);
      let inferred: number | null = null;
      if (inf && /(semanal|por semana|a la semana|cada una|duracion)/.test(m)) inferred = Number(inf[1]) * Number(inf[2]);

      if (!obligation && !inferred) {
        if (mentions.length) {
          // ¿Lo retoma la oración siguiente («Estos exámenes serán realizados…»)? Se decide al leerla.
          pendingAnaphora = { mentions, seg, quote };
          for (const x of mentions) ign('no_trigger', x.raw);
        }
        continue;
      }
      if (!obligation && inferred) obligation = 'required';
      if (pendingAnaphora && /^\s*(estos|estas|dichos|dichas)\b/.test(m) && obligation === 'required' && !mentions.length) {
        mentions = pendingAnaphora.mentions;
        medium = true;
      }
      pendingAnaphora = null;

      // Negación sin número: «No se requieren videos» → máximo 0.
      if (!mentions.length && RE_NEGATION.test(m)) {
        // Solo si el objeto de la negación es el sustantivo («No se requieren videos»), no algo en otra parte de la frase.
        const nn = new RegExp(`(?:no se requieren?|no (?:se )?(?:incluira|tendra|debera incluir|deben incluir|debe incluir|deben tener|debe tener))\\s+(?:[a-z]+\\s+)?${NOUN_SRC}\\b`).exec(m);
        const k = nn && nounKind(nn[1]);
        if (k && k.kind !== 'target_hours') mentions = [{ kind: k.kind, value: 0, mode: 'max', scope: { level: 'course' }, index: 0, end: 0, raw: m }];
      }
      if (inferred && !mentions.some((x) => x.kind === 'target_hours')) {
        mentions.push({ kind: 'target_hours', value: inferred, mode: 'exact', scope: { level: 'course' }, index: 0, end: 0, raw: 'inferred' });
      }

      const created: DocumentRequirement[] = [];
      for (const x of mentions) {
        let ob = obligation as RequirementObligation;
        if (x.mode === 'approx' && ob === 'required') ob = 'recommended'; // «aproximadamente»: nunca exacto obligatorio
        const review: string[] = [];
        let confidence: 'high' | 'medium' = medium || x.medium ? 'medium' : 'high';
        if (x.kind === 'units') review.push('«Unidades» no equivale automáticamente a módulos (revisa si el documento las usa como módulos).');
        if (x.medium) review.push('«temas» leídos como capítulos: revisa esta lectura.');
        const isInferred = x.raw === 'inferred';
        if (isInferred) {
          confidence = 'medium';
          review.push(`Total calculado: ${inf![1]} semanas × ${inf![2]} h; el documento no lo dice.`);
        }
        let active = true;
        if (condition) {
          active = false;
          if (!condition.modeled) {
            confidence = 'medium';
            review.push(`Condicionado a «${condition.text}», que Cursia no modela: revisa esta lectura.`);
          } else review.push(`Aplica solo si ${condition.text}.`);
        }
        if (seg.option) active = false;
        if (ob !== 'required') active = ob === 'recommended' || ob === 'permitted' ? active : false;
        if (generic && !seg.option) {
          ob = 'informative';
          active = false;
          confidence = 'medium';
          review.push('Describe un curso genérico o el producto («curso estándar», «por lo general»), no exige nada a este curso.');
        }
        // Una alternativa rotulada ya espera una elección explícita: no se degrada por ser un documento de varias asignaturas.
        if (multiCourse && x.scope.level !== 'subject' && !seg.option && ob !== 'informative') {
          ob = 'informative';
          active = false;
          review.push('Documento de varias asignaturas: no aplica al curso hasta elegir la asignatura.');
        }
        created.push(push({
          kind: x.kind, scope: x.scope, mode: x.mode, value: x.value,
          ...(x.valueMax !== undefined ? { valueMax: x.valueMax } : {}),
          ...(x.evaluationType ? { evaluationType: x.evaluationType } : {}),
          obligation: ob, ...(condition ? { condition } : {}), active, status: isInferred ? 'inferred' : 'found', confidence,
          ...(review.length ? { review } : {}), source: src(quote),
        }));
      }

      // Compuestos de la oración.
      const mods = created.find((r) => r.kind === 'modules' && r.scope.level === 'course');
      const chEach = created.find((r) => r.kind === 'chapters' && r.scope.level === 'module' && 'each' in r.scope && !(r.scope.chapterKind === 'practice'));
      const chTotal = created.find((r) => r.kind === 'chapters' && r.scope.level === 'course');
      if (mods && (chEach || chTotal) && mods.mode === 'exact') {
        const ids = [mods.id, (chEach || chTotal)!.id];
        if (chEach && chEach.mode === 'exact' && mods.value) {
          const content = 'chapterKind' in chEach.scope && chEach.scope.chapterKind === 'content';
          const st = push({ kind: 'structure', scope: content ? { level: 'structure', chapterKind: 'content' } : { level: 'structure' }, mode: 'exact', value: null, shape: Array(mods.value).fill(chEach.value), obligation: mods.obligation, active: mods.active, status: 'found', confidence: mods.confidence, ...(mods.condition ? { condition: mods.condition } : {}), source: src(quote) });
          created.push(st);
          ids.push(st.id);
        }
        const g: RequirementGroup = { id: `G${groups.length + 1}`, relation: 'all', label: chEach ? `${mods.value} × ${chEach.value}` : `${mods.value} módulos, ${chTotal!.value} capítulos`, requirementIds: ids, source: src(quote) };
        groups.push(g);
        for (const r of requirements) if (ids.includes(r.id) && !seg.option) r.groupId = g.id;
      }
      const partial = created.find((r) => r.kind === 'evaluations' && r.evaluationType === 'partial');
      const final = created.find((r) => r.kind === 'evaluations' && r.evaluationType === 'final');
      if (partial && final) {
        const g: RequirementGroup = { id: `G${groups.length + 1}`, relation: 'all', label: `${partial.value} parciales + ${final.value} final`, requirementIds: [partial.id, final.id], source: src(quote) };
        groups.push(g);
        partial.groupId = final.groupId = g.id;
      }

      // Alternativas rotuladas (S/M/L, «Opción A»): un grupo oneOf mientras las opciones sean consecutivas.
      if (seg.option && created.length) {
        if (!optionRun || optionRun.labels.has(seg.option)) {
          const g: RequirementGroup = { id: `G${groups.length + 1}`, relation: 'oneOf', label: 'Alternativas', options: [], source: src(quote) };
          groups.push(g);
          optionRun = { group: g, labels: new Set() };
        }
        optionRun.labels.add(seg.option);
        optionRun.group.options!.push({ id: seg.option, label: seg.option, requirementIds: created.map((r) => r.id) });
        for (const r of created) {
          r.groupId = optionRun.group.id;
          r.optionId = seg.option;
          r.active = false;
          r.review = [...(r.review || []), `Alternativa ${seg.option}: aplica solo si se elige esta opción.`];
        }
      }
    }
  }

  // Duplicados coherentes se funden; contradictorios quedan como conflicto (nunca se elige uno en silencio).
  const conflicts: RequirementConflict[] = [];
  const seen = new Map<string, DocumentRequirement>();
  const kept: DocumentRequirement[] = [];
  for (const r of requirements) {
    const k = `${r.key}|${r.optionId || ''}|${r.condition ? r.condition.text : ''}`;
    const prev = seen.get(k);
    if (prev && prev.mode === r.mode && prev.value === r.value && prev.valueMax === r.valueMax && JSON.stringify(prev.shape) === JSON.stringify(r.shape) && prev.obligation === r.obligation) {
      for (const g of groups) {
        if (g.requirementIds) g.requirementIds = g.requirementIds.map((id) => (id === r.id ? prev.id : id));
        for (const o of g.options || []) o.requirementIds = o.requirementIds.map((id) => (id === r.id ? prev.id : id));
      }
      continue;
    }
    if (prev && prev.active && r.active && prev.obligation === 'required' && r.obligation === 'required') {
      conflicts.push({ key: r.key, requirementIds: [prev.id, r.id], message: `El documento dice dos cosas distintas sobre ${conflictSubject(r)}: «${prev.source.quote.slice(0, 80)}» y «${r.source.quote.slice(0, 80)}».` });
    }
    if (!prev) seen.set(k, r);
    kept.push(r);
  }
  // La misma tabla de alternativas repetida (resumen en otra página) es un solo grupo.
  const sig = (g: RequirementGroup) => JSON.stringify((g.options || []).map((o) => [o.id, [...o.requirementIds].sort()]));
  const finalGroups: RequirementGroup[] = [];
  for (const g of groups) {
    if (g.relation === 'oneOf' && finalGroups.some((f) => f.relation === 'oneOf' && sig(f) === sig(g))) continue;
    finalGroups.push(g);
  }
  // Ficha con campos separados («Número de módulos: 4» y «Capítulos por módulo: 5»): también es un compuesto N × M.
  const lone = (k: RequirementKind, lvl: string) => kept.filter((r) => r.kind === k && r.scope.level === lvl && r.mode === 'exact' && r.active && r.obligation === 'required' && !r.groupId && !r.condition);
  const fm = lone('modules', 'course');
  const fc = lone('chapters', 'module').filter((r) => 'each' in r.scope && (r.scope as { chapterKind?: string }).chapterKind !== 'practice');
  if (fm.length === 1 && fc.length === 1 && fm[0].value && !kept.some((r) => r.kind === 'structure' && r.active)) {
    const [m0, c0] = [fm[0], fc[0]];
    // LOOP 9.2: con «capítulos de contenido», el N × M cuenta solo contenido (las prácticas van aparte).
    const contentOnly = 'chapterKind' in c0.scope && c0.scope.chapterKind === 'content';
    const st: DocumentRequirement = { id: `RQ${++seq}`, key: contentOnly ? 'structure@structure:content' : 'structure@structure', kind: 'structure', scope: contentOnly ? { level: 'structure', chapterKind: 'content' } : { level: 'structure' }, mode: 'exact', value: null, shape: Array(m0.value!).fill(c0.value), obligation: 'required', active: true, status: 'found', confidence: m0.confidence === 'high' && c0.confidence === 'high' ? 'high' : 'medium', review: ['Compuesto de dos campos del documento (módulos y capítulos por módulo).'], source: m0.source };
    kept.push(st);
    const g: RequirementGroup = { id: `G${finalGroups.length + 1}`, relation: 'all', label: `${m0.value} × ${c0.value}`, requirementIds: [m0.id, c0.id, st.id], source: m0.source };
    finalGroups.push(g);
    m0.groupId = c0.groupId = st.groupId = g.id;
  }
  return { requirementsVersion: 1, requirements: kept, groups: finalGroups, conflicts, ignored, multiCourse, subjects };
}

/**
 * Requisitos que aplican a ESTE curso después de elegir asignatura, alternativa y con los datos del curso (créditos,
 * modalidad). Solo lectura: no cambia el diseño (eso es 8.6C).
 */
export function requirementsFor(x: RequirementsExtraction, sel: RequirementSelection = {}): DocumentRequirement[] {
  const out: DocumentRequirement[] = [];
  for (const r of x.requirements) {
    if (r.obligation === 'informative') continue;
    if (r.scope.level === 'subject') {
      if (!sel.subject || strip(r.scope.subject) !== strip(sel.subject)) continue;
      out.push({ ...r, active: true });
      continue;
    }
    if (r.optionId) {
      const chosen = sel.options && (sel.options[r.groupId || ''] ?? sel.options['*']);
      if (!chosen || chosen.toUpperCase() !== r.optionId.toUpperCase()) continue;
      out.push({ ...r, active: true });
      continue;
    }
    if (r.condition) {
      if (!r.condition.modeled || !sel.facts) continue;
      const fact = r.condition.field === 'credits' ? sel.facts.credits : sel.facts.modality;
      if (fact === undefined) continue;
      const v = r.condition.value;
      const ok = r.condition.op === '=' ? fact === v : r.condition.op === '>' ? (fact as number) > (v as number) : r.condition.op === '<' ? (fact as number) < (v as number) : false;
      if (!ok) continue;
      out.push({ ...r, active: true });
      continue;
    }
    if (r.active) out.push(r);
  }
  return out;
}

/** Total de capítulos de un compuesto N × M (para verificar «4 × 5 = 20»). */
export function structureTotal(r: DocumentRequirement): number | null {
  return r.kind === 'structure' && r.shape ? r.shape.reduce((a, b) => a + b, 0) : null;
}
