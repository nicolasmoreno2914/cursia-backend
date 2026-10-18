// T4 (r57) — Actividad de Aplicación como Tarea de Moodle (mod_assign) en el backup v3.
//
// Verdad de referencia: backup real hecho por Moodle 4.5.14+ (local, desechable) de una Tarea con texto en línea +
// archivos, comentarios de retroalimentación y rúbrica (gradingform_rubric): `assign.xml`, `grading.xml`, `module.xml`,
// `grades.xml`. Los campos que 4.5 agregó (markinganonymous, timelimit, submissionattachments) los ignora el restore de
// 4.1–4.4 (insert_record descarta columnas inexistentes). `attemptreopenmethod` = none (definido en 4.1–4.5).
//
// Funciones PURAS: ts e ids entran por parámetro.
import { xmlEsc } from '../mbz-common';
import { moodleDecimal } from '../assessment/assessment-xml';
import type { ResolvedApplicationDelivery } from '../assessment/resolve-assessment';

const NULL = '$@NULL@$';

export interface AssignXmlInput {
  aid: number;
  mid: number;
  ctx: number;
  name: string;
  introHtml: string;
  ts: number;
  delivery: ResolvedApplicationDelivery;
  /** Fecha límite absoluta del backup (inicio del curso + días) o 0. */
  duedate: number;
  /** Primer id de plugin_config (únicos en el paquete). */
  pluginConfigId: number;
}

/** Opciones de la rúbrica: el estudiante la ve SOLO después de ser calificado (sin alwaysshowdefinition). */
export const ASSIGN_RUBRIC_OPTIONS = '{"sortlevelsasc":1,"lockzeropoints":1,"showdescriptionteacher":1,"showdescriptionstudent":1,"showscoreteacher":1,"showscorestudent":1,"enableremarks":1,"showremarksstudent":1}';

/** Configuración de plugins (orden del backup de referencia). Comentarios de retroalimentación SIEMPRE activos. */
export function assignPluginConfigs(d: ResolvedApplicationDelivery): Array<{ plugin: string; subtype: string; name: string; value: string }> {
  const s = d.submission;
  return [
    { plugin: 'onlinetext', subtype: 'assignsubmission', name: 'enabled', value: s.onlineText ? '1' : '0' },
    { plugin: 'onlinetext', subtype: 'assignsubmission', name: 'wordlimit', value: '0' },
    { plugin: 'onlinetext', subtype: 'assignsubmission', name: 'wordlimitenabled', value: '0' },
    { plugin: 'file', subtype: 'assignsubmission', name: 'enabled', value: s.file ? '1' : '0' },
    { plugin: 'file', subtype: 'assignsubmission', name: 'maxfilesubmissions', value: String(s.maxFiles) },
    { plugin: 'file', subtype: 'assignsubmission', name: 'maxsubmissionsizebytes', value: String(s.maxBytes) },
    { plugin: 'file', subtype: 'assignsubmission', name: 'filetypeslist', value: s.fileTypes.join(',') },
    { plugin: 'comments', subtype: 'assignsubmission', name: 'enabled', value: '0' },
    { plugin: 'comments', subtype: 'assignfeedback', name: 'enabled', value: '1' },
    { plugin: 'comments', subtype: 'assignfeedback', name: 'commentinline', value: '0' },
    { plugin: 'editpdf', subtype: 'assignfeedback', name: 'enabled', value: '0' },
    { plugin: 'offline', subtype: 'assignfeedback', name: 'enabled', value: '0' },
    { plugin: 'file', subtype: 'assignfeedback', name: 'enabled', value: '0' },
  ];
}

export function assignActivityXml(p: AssignXmlInput): string {
  const d = p.delivery;
  const grade = d.graded ? (d.maxGrade as number) : 0;
  const cfg = assignPluginConfigs(d)
    .map((c, i) => `      <plugin_config id="${p.pluginConfigId + i}">
        <plugin>${c.plugin}</plugin>
        <subtype>${c.subtype}</subtype>
        <name>${c.name}</name>
        <value>${xmlEsc(c.value)}</value>
      </plugin_config>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<activity id="${p.aid}" moduleid="${p.mid}" modulename="assign" contextid="${p.ctx}">
  <assign id="${p.aid}">
    <name>${xmlEsc(p.name)}</name>
    <intro>${xmlEsc(p.introHtml)}</intro>
    <introformat>1</introformat>
    <alwaysshowdescription>1</alwaysshowdescription>
    <submissiondrafts>0</submissiondrafts>
    <sendnotifications>0</sendnotifications>
    <sendlatenotifications>0</sendlatenotifications>
    <sendstudentnotifications>1</sendstudentnotifications>
    <duedate>${p.duedate}</duedate>
    <cutoffdate>0</cutoffdate>
    <gradingduedate>0</gradingduedate>
    <allowsubmissionsfromdate>0</allowsubmissionsfromdate>
    <grade>${grade}</grade>
    <timemodified>${p.ts}</timemodified>
    <completionsubmit>1</completionsubmit>
    <requiresubmissionstatement>0</requiresubmissionstatement>
    <teamsubmission>0</teamsubmission>
    <requireallteammemberssubmit>0</requireallteammemberssubmit>
    <teamsubmissiongroupingid>0</teamsubmissiongroupingid>
    <blindmarking>0</blindmarking>
    <hidegrader>0</hidegrader>
    <revealidentities>0</revealidentities>
    <attemptreopenmethod>none</attemptreopenmethod>
    <maxattempts>-1</maxattempts>
    <markingworkflow>0</markingworkflow>
    <markingallocation>0</markingallocation>
    <markinganonymous>0</markinganonymous>
    <preventsubmissionnotingroup>0</preventsubmissionnotingroup>
    <activity>${NULL}</activity>
    <activityformat>0</activityformat>
    <timelimit>0</timelimit>
    <submissionattachments>0</submissionattachments>
    <userflags>
    </userflags>
    <submissions>
    </submissions>
    <grades>
    </grades>
    <plugin_configs>
${cfg}
    </plugin_configs>
    <overrides>
    </overrides>
  </assign>
</activity>`;
}

/** Cantidad de plugin_config que emite `assignActivityXml` (para reservar ids). */
export const ASSIGN_PLUGIN_CONFIG_COUNT = 13;

export interface AssignGradeItemInput {
  gradeItemId: number;
  itemName: string;
  aid: number;
  ts: number;
  grademax: number;
  gradepass: number;
  categoryId: number;
  sortorder: number;
}

/** `grades.xml` de la Tarea calificada (itemmodule assign, grademax = nota máxima del perfil). */
export function assignGradeItemXml(p: AssignGradeItemInput): string {
  if (!(Number.isInteger(p.grademax) && p.grademax >= 1 && p.grademax <= 100)) throw new Error(`ASSIGN_XML_INVALID: grademax ${p.grademax}`);
  if (!(Number.isInteger(p.gradepass) && p.gradepass >= 0 && p.gradepass <= p.grademax)) throw new Error(`ASSIGN_XML_INVALID: gradepass ${p.gradepass}`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<activity_gradebook>
  <grade_items>
    <grade_item id="${p.gradeItemId}">
      <categoryid>${p.categoryId}</categoryid>
      <itemname>${xmlEsc(p.itemName)}</itemname>
      <itemtype>mod</itemtype>
      <itemmodule>assign</itemmodule>
      <iteminstance>${p.aid}</iteminstance>
      <itemnumber>0</itemnumber>
      <iteminfo>${NULL}</iteminfo>
      <idnumber></idnumber>
      <calculation>${NULL}</calculation>
      <gradetype>1</gradetype>
      <grademax>${moodleDecimal(p.grademax)}</grademax>
      <grademin>${moodleDecimal(0)}</grademin>
      <scaleid>${NULL}</scaleid>
      <outcomeid>${NULL}</outcomeid>
      <gradepass>${moodleDecimal(p.gradepass)}</gradepass>
      <multfactor>1.00000</multfactor>
      <plusfactor>0.00000</plusfactor>
      <aggregationcoef>0.00000</aggregationcoef>
      <aggregationcoef2>0.00000</aggregationcoef2>
      <weightoverride>0</weightoverride>
      <sortorder>${p.sortorder}</sortorder>
      <display>0</display>
      <decimals>${NULL}</decimals>
      <hidden>0</hidden>
      <locked>0</locked>
      <locktime>0</locktime>
      <needsupdate>0</needsupdate>
      <timecreated>${p.ts}</timecreated>
      <timemodified>${p.ts}</timemodified>
      <grade_grades>
      </grade_grades>
    </grade_item>
  </grade_items>
  <grade_letters>
  </grade_letters>
</activity_gradebook>`;
}

export interface RubricCriterionInput {
  description: string;
  levels: Array<{ score: number; definition: string }>;
}

export interface AssignRubricInput {
  areaId: number;
  definitionId: number;
  /** Primer id de criterio / nivel (únicos en el paquete). */
  criterionId: number;
  levelId: number;
  name: string;
  description: string;
  criteria: RubricCriterionInput[];
  ts: number;
}

/**
 * `grading.xml` de la Tarea con rúbrica (área `submissions`, método activo `rubric`, definición LISTA = status 20).
 * Moodle calcula la nota = (puntos − mínimo) / (máximo − mínimo) × nota máxima de la tarea.
 */
export function assignRubricGradingXml(p: AssignRubricInput): { xml: string; criteria: number; levels: number } {
  if (!p.criteria.length) throw new Error('ASSIGN_RUBRIC_INVALID: la rúbrica necesita criterios');
  let cid = p.criterionId;
  let lid = p.levelId;
  let levels = 0;
  const crit = p.criteria
    .map((c, i) => {
      if (c.levels.length < 2) throw new Error(`ASSIGN_RUBRIC_INVALID: el criterio ${i + 1} necesita ≥ 2 niveles`);
      const scores = c.levels.map((l) => l.score);
      if (new Set(scores).size !== scores.length || scores.some((x) => !Number.isFinite(x) || x < 0)) throw new Error(`ASSIGN_RUBRIC_INVALID: puntajes del criterio ${i + 1} repetidos o negativos`);
      const lv = c.levels
        .map((l) => {
          levels++;
          return `                <level id="${lid++}">
                  <score>${moodleDecimal(l.score)}</score>
                  <definition>${xmlEsc(l.definition)}</definition>
                  <definitionformat>0</definitionformat>
                </level>`;
        })
        .join('\n');
      return `            <criterion id="${cid++}">
              <sortorder>${i + 1}</sortorder>
              <description>${xmlEsc(c.description)}</description>
              <descriptionformat>0</descriptionformat>
              <levels>
${lv}
              </levels>
            </criterion>`;
    })
    .join('\n');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<areas>
  <area id="${p.areaId}">
    <areaname>submissions</areaname>
    <activemethod>rubric</activemethod>
    <definitions>
      <definition id="${p.definitionId}">
        <method>rubric</method>
        <name>${xmlEsc(p.name)}</name>
        <description>${xmlEsc(p.description)}</description>
        <descriptionformat>1</descriptionformat>
        <status>20</status>
        <timecreated>${p.ts}</timecreated>
        <timemodified>${p.ts}</timemodified>
        <options>${xmlEsc(ASSIGN_RUBRIC_OPTIONS)}</options>
        <plugin_gradingform_rubric_definition>
          <criteria>
${crit}
          </criteria>
        </plugin_gradingform_rubric_definition>
        <instances>
        </instances>
      </definition>
    </definitions>
  </area>
</areas>`;
  return { xml, criteria: p.criteria.length, levels };
}

/**
 * Criterios de la rúbrica desde la AA: cada criterio (nombre, peso y descripción) con 3 niveles de la guía de corrección
 * del solucionario — Insuficiente 0, En proceso ⌊peso/2⌋ y Logrado = peso (los pesos suman 100 → máximo 100 puntos).
 */
export function rubricCriteriaFromApplication(doc: any): RubricCriterionInput[] {
  const crit: any[] = doc?.activity?.criteria ?? [];
  const guide: any[] = doc?.solution?.correctionGuide ?? [];
  return crit.map((c, i) => {
    const g = guide[i] ?? {};
    const w = Number(c.weight);
    return {
      description: `${c.name} (${w} %): ${c.description}`,
      levels: [
        { score: 0, definition: `Insuficiente. ${g.insufficient ?? ''}`.trim() },
        { score: Math.floor(w / 2), definition: `En proceso. ${g.developing ?? ''}`.trim() },
        { score: w, definition: `Logrado. ${g.achieved ?? ''}`.trim() },
      ],
    };
  });
}

/** Fecha límite del backup: inicio del curso (ts del backup) + días; 0 sin fecha. */
export function assignDueDate(courseStart: number, dueOffsetDays: number | null): number {
  return dueOffsetDays === null ? 0 : courseStart + dueOffsetDays * 86400;
}
