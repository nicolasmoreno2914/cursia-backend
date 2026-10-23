'use strict';

// ══════════════════════════════════════════════════════════════════════════
// exam-bank-fixtures.js — EV6 P2-B2: bancos `dynamic_exam_bank_json` VÁLIDOS y
// determinísticos (sin dist/, sin aleatoriedad) para los checks del backend y
// para reusar en B3/B6/F3. Cumplen todas las reglas de validateExamBank:
// claves exactas, plan del Manifest, 2·slots por hoja, enunciados únicos,
// correcta estrictamente más larga en el 20 % de las MC (< 30 %, sin outlier),
// V/F balanceado por hoja, pares de emparejamiento limpios y evidencia copiada
// literal del Markdown del capítulo que genera `chapterMarkdown`.
//
// El plan se recibe ya calculado (el caller usa el moduleExamPlan /
// finalExamPlan compilado, o el plan del claim): así este archivo no duplica
// las fórmulas del contrato.
// ══════════════════════════════════════════════════════════════════════════

const TYPE_TAG = { multichoice: 'MC', truefalse: 'TF', match: 'MA' };
const LEVELS = ['recordar', 'comprender', 'aplicar', 'analizar'];

/** Frase de evidencia j del capítulo (40–220 chars); aparece literal en chapterMarkdown. */
function evidenceSentence(chapterIndex, j) {
  return `En la planta ${chapterIndex + 1}, la regla operativa ${j + 1} indica que el equipo revisa el punto de control ${chapterIndex + 1}.${j + 1} antes de iniciar cada turno de trabajo.`;
}

/** Markdown del capítulo `chapterIndex` (orden del examen) con `sentences` frases de evidencia. */
function chapterMarkdown(chapterIndex, title, sentences = 40) {
  const lines = [`# ${title || `Capítulo ${chapterIndex + 1}`}`, '', '## Ideas clave', ''];
  for (let j = 0; j < sentences; j++) {
    lines.push(`- **Regla ${j + 1}:** ${evidenceSentence(chapterIndex, j)}`);
    if (j % 5 === 4) lines.push('', `> Nota de seguridad ${j + 1}: la revisión queda registrada en la bitácora del turno.`, '');
  }
  return lines.join('\n') + '\n';
}

function pad2(n) {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * Banco válido para un examen.
 * @param {{ scope: 'module'|'final', moduleId: string|null, chapters: Array<{id:string, moduleId:string}>,
 *           plan: Array<{chapterId?:string, moduleId?:string, type:string, slots:number}>, prefix?: string,
 *           chapterIndex?: Map<string, number> }} o   chapterIndex: índice de chapterMarkdown de cada capítulo (default: orden del examen)
 * @returns {{ bankVersion: 1, scope, moduleId, plan, questions }}
 */
function makeExamBank(o) {
  const prefix = o.prefix || (o.scope === 'module' ? 'M' : 'F');
  // Índice de la frase de evidencia por capítulo: el del examen, o uno global (mismo Markdown para varios exámenes).
  const chapterIndex = o.chapterIndex || new Map(o.chapters.map((c, i) => [c.id, i]));
  const chapterById = new Map(o.chapters.map((c) => [c.id, c]));
  const questions = [];
  const evidenceCursor = new Map();
  let mcSeq = 0;
  const leafSeq = new Map();
  o.plan.forEach((leaf, leafIdx) => {
    const n = 2 * leaf.slots;
    // Capítulos de la hoja: el capítulo (módulo) o los del módulo (final), rotando.
    const leafChapters = 'chapterId' in leaf ? [leaf.chapterId] : o.chapters.filter((c) => c.moduleId === leaf.moduleId).map((c) => c.id);
    for (let k = 0; k < n; k++) {
      const chapterId = leafChapters[k % leafChapters.length];
      const ci = chapterIndex.get(chapterId);
      const ev = evidenceCursor.get(chapterId) || 0;
      evidenceCursor.set(chapterId, ev + 1);
      const seq = (leafSeq.get(leafIdx) || 0) + 1;
      leafSeq.set(leafIdx, seq);
      const tag = `${prefix}${leafIdx + 1}-${TYPE_TAG[leaf.type]}-${pad2(seq)}`;
      const q = {
        id: tag,
        type: leaf.type,
        chapterId,
        ...(o.scope === 'final' ? { moduleId: chapterById.get(chapterId).moduleId } : {}),
        level: LEVELS[(leafIdx + k) % LEVELS.length],
        stem: `Caso ${tag}: durante el turno, una supervisora debe decidir qué hacer con el punto de control ${ci + 1}.${(ev % 40) + 1} de la planta.`,
        explanation: `El punto de control ${ci + 1}.${(ev % 40) + 1} se revisa antes de iniciar el turno porque así se detectan fallas cuando todavía es barato corregirlas (${tag}).`,
        evidence: evidenceSentence(ci, ev % 40),
      };
      if (leaf.type === 'multichoice') {
        mcSeq++;
        // 1 de cada 5 MC: la correcta es la más larga por 3 caracteres (20 % < 30 %, sin outlier ≥ 8).
        const longest = mcSeq % 5 === 0;
        q.correct = { text: `${longest ? 'Documentar' : 'Revisar'} el control ${tag}`, why: 'Es lo que indica la regla operativa del capítulo para ese punto.' };
        q.distractors = [
          { text: `Omitir el control ${tag}`, why: 'Confunde un control obligatorio con uno opcional del turno.' },
          { text: `Aplazar el control ${tag}`, why: 'Supone que revisar después del arranque tiene el mismo efecto.' },
          { text: `Delegar el control ${tag}`, why: 'Cree que la responsabilidad del control pasa a otra área.' },
        ];
      } else if (leaf.type === 'truefalse') {
        q.answer = k % 2 === 0;
        q.whyWrong = q.answer
          ? 'Responder falso ignora que la regla exige la revisión antes del turno.'
          : 'Responder verdadero acepta una práctica que la regla del capítulo descarta.';
      } else {
        q.pairs = [
          { term: `Bitácora ${tag}`, definition: 'Registro escrito de cada revisión del turno' },
          { term: `Control ${tag}`, definition: 'Verificación previa al arranque de la línea' },
          { term: `Turno ${tag}`, definition: 'Periodo de trabajo de un mismo equipo' },
          { term: `Supervisora ${tag}`, definition: 'Persona que decide si la línea puede arrancar' },
        ];
      }
      questions.push(q);
    }
  });
  return { bankVersion: 1, scope: o.scope, moduleId: o.scope === 'module' ? o.moduleId : null, plan: o.plan.map((l) => ({ ...l })), questions };
}

module.exports = { chapterMarkdown, evidenceSentence, makeExamBank };
