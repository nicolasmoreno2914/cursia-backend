/* eslint-disable */
// Title Normalization — migración de cursos dinámicos EXISTENTES con títulos de
// módulo/capítulo > 80: separa cada título en título breve + descripción con el
// MISMO normalizador que la API (dist/modules/course-structure/structure-titles.js).
//
// Solo la estructura VIVA (course_modules / course_chapters). Los Blueprints
// congelados y los runs ya generados NO se tocan (inmutables): el cambio se ve
// al confirmar una versión nueva de la estructura.
//
// - plan (solo lectura): qué se cambiaría y qué no se puede separar solo.
// - apply: por curso, en UNA transacción: actualiza título + descripción (solo
//   si el título sigue siendo el mismo que se planificó: nunca pisa una edición
//   concurrente), nunca pierde texto (la descripción separada se agrega a la
//   existente) y sube structure_version_counter (un editor abierto recibe 409 y
//   recarga). Idempotente: re-correrlo no encuentra nada (todos ≤ 80).
'use strict';

function loadNormalizer(distRoot) {
  const path = require('path');
  return require(path.join(distRoot, 'modules/course-structure/structure-titles.js'));
}

/**
 * @param {{ query(sql: string, params?: any[]): Promise<{rows:any[]}> }} c  pg.Client
 * @param {{ distRoot: string, courseId?: number|null }} opts
 */
async function planStructureTitleMigration(c, opts) {
  const T = loadNormalizer(opts.distRoot);
  const courseFilter = opts.courseId ? 'and co.id = $2' : '';
  const params = opts.courseId ? [T.STRUCTURE_TITLE_MAX, opts.courseId] : [T.STRUCTURE_TITLE_MAX];
  const { rows } = await c.query(
    `select 'module' as kind, m.id, m.course_id, m.title, m.description
       from public.course_modules m join public.courses co on co.id = m.course_id
      where co.structure_version = 'dynamic' and char_length(btrim(m.title)) > $1 ${courseFilter}
     union all
     select 'chapter' as kind, ch.id, ch.course_id, ch.title, ch.description
       from public.course_chapters ch join public.courses co on co.id = ch.course_id
      where co.structure_version = 'dynamic' and char_length(btrim(ch.title)) > $1 ${courseFilter}
      order by 3, 1 desc, 2`,
    params,
  );
  const changes = [];
  const unresolved = [];
  for (const r of rows) {
    const n = T.normalizeStructureTitle(r.title);
    const merged = n ? T.mergeDescription(r.description, n.description) : null;
    if (n && merged && merged.length > T.STRUCTURE_DESCRIPTION_MAX) {
      unresolved.push({ kind: r.kind, id: r.id, courseId: Number(r.course_id), length: r.title.trim().length, code: T.STRUCTURE_DESCRIPTION_TOO_LONG });
      continue;
    }
    if (!n) {
      unresolved.push({ kind: r.kind, id: r.id, courseId: Number(r.course_id), length: r.title.trim().length, code: r.kind === 'chapter' ? T.CHAPTER_TITLE_TOO_LONG : T.MODULE_TITLE_TOO_LONG });
      continue;
    }
    changes.push({
      kind: r.kind,
      id: r.id,
      courseId: Number(r.course_id),
      oldTitle: r.title,
      newTitle: n.title,
      oldDescription: r.description ?? null,
      newDescription: merged,
    });
  }
  return { changes, unresolved, max: T.STRUCTURE_TITLE_MAX };
}

async function applyStructureTitleMigration(c, plan) {
  const byCourse = new Map();
  for (const ch of plan.changes) {
    if (!byCourse.has(ch.courseId)) byCourse.set(ch.courseId, []);
    byCourse.get(ch.courseId).push(ch);
  }
  const applied = [];
  const skipped = [];
  for (const [courseId, list] of byCourse) {
    await c.query('begin');
    try {
      // Mismo orden de locks que la API (fila del curso primero): sin deadlocks con un editor abierto.
      await c.query(`select id from public.courses where id = $1 for update`, [courseId]);
      let n = 0;
      for (const ch of list) {
        const table = ch.kind === 'chapter' ? 'course_chapters' : 'course_modules';
        // Solo si título Y descripción siguen como en el plan: nunca pisa una edición concurrente.
        const res = await c.query(
          `update public.${table} set title = $1, description = $2, updated_at = now()
            where id = $3 and course_id = $4 and title = $5 and description is not distinct from $6`,
          [ch.newTitle, ch.newDescription, ch.id, courseId, ch.oldTitle, ch.oldDescription],
        );
        if (res.rowCount === 1) { n++; applied.push(ch); } else skipped.push({ ...ch, reason: 'changed_since_plan' });
      }
      if (n > 0) {
        await c.query(`update public.courses set structure_version_counter = structure_version_counter + 1 where id = $1`, [courseId]);
      }
      await c.query('commit');
    } catch (err) {
      await c.query('rollback').catch(() => {});
      throw err;
    }
  }
  return { applied, skipped };
}

function printPlan(plan, log = console.log) {
  log(`títulos > ${plan.max}: ${plan.changes.length} separables, ${plan.unresolved.length} sin corte natural (revisar a mano en el editor)`);
  for (const ch of plan.changes) {
    log(`  curso #${ch.courseId} ${ch.kind} ${String(ch.id).slice(0, 8)}: ${ch.oldTitle.trim().length} → ${ch.newTitle.length} chars ` +
      `${JSON.stringify(ch.newTitle)} · descripción ${ch.newDescription ? ch.newDescription.length : 0} chars`);
  }
  for (const u of plan.unresolved) log(`  ✗ curso #${u.courseId} ${u.kind} ${String(u.id).slice(0, 8)}: ${u.length} chars — ${u.code}`);
}

module.exports = { planStructureTitleMigration, applyStructureTitleMigration, printPlan };
