import { returningRows } from '../../common/db/returning-rows';
import { loadDesignPins } from '../course-design/design-pins';
import { normalizeProfile, profileSha256, validateProfile } from '../course-profiles/course-profiles';
import { advanceStructureOriginIfUntouched } from '../course-structure/structure-authority';
import { ACTIVE_RUN_WORKER_STATUSES } from '../dynamic-generation/item-transitions';
import { loadCurrentPedagogicalProfile } from '../pedagogy/pedagogy-db';
import type { AcademicContextV1 } from './academic-context';
import { hasDocuments } from './proposed-context';
import { StoredAcademicContext, loadCurrentAcademicContext } from './academic-db';
import {
  DocumentlessLinkPlan,
  PROFILE_OUTCOMES_KEY,
  ProfileOutcomesRecord,
  academicContextFromProfile,
  isDocumentlessContext,
  normalizeOutcomeText,
  parseProfileOutcomesRecord,
  planDocumentlessLinks,
} from './profile-outcomes';

/**
 * r63 · Resultados del perfil pedagógico → contexto académico + vínculos con los capítulos, en la base. Sin IA, sin
 * proveedores (USD 0). Lo llaman, DENTRO de una transacción con la fila del curso tomada (FOR UPDATE):
 *   - el guardado del perfil pedagógico (CourseProfilesService.append),
 *   - «Usar este diseño» / «Vincular ahora» (POST /design/fix link_outcomes),
 *   - el Prebrief (GET /prebrief y «Preparar»), antes de calcular la propuesta.
 * Nunca mientras se produce el curso, y (salvo un pedido explícito) nunca sobre una propuesta preparada o aprobada:
 * así un Prebrief aprobado no se invalida solo y los Blueprints congelados no cambian (son filas inmutables).
 */

type Q = { query(sql: string, params?: unknown[]): Promise<any> };

export type ProfileOutcomesBlock = 'PRODUCTION_ACTIVE' | 'PREBRIEF_FROZEN';

export async function readProfileOutcomesRecord(q: Q, courseId: number): Promise<ProfileOutcomesRecord | null> {
  const [row] = await q.query(`select metadata -> '${PROFILE_OUTCOMES_KEY}' as r from public.courses where id = $1`, [courseId]);
  const v = row ? (typeof row.r === 'string' ? JSON.parse(row.r) : row.r) : null;
  return parseProfileOutcomesRecord(v);
}

/** ¿Algo impide tocar el contexto o los vínculos sin que nadie lo pida? (producción en curso; propuesta preparada/aprobada). */
export async function profileOutcomesBlockedBy(q: Q, courseId: number, respectPrebrief: boolean): Promise<ProfileOutcomesBlock | null> {
  // Sin las columnas / tablas (entornos sin la migración) no se consulta nada: una consulta fallida abortaría la transacción.
  const [t] = await q.query(
    `select exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'production_jobs' and column_name = 'worker_status')
              and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'production_jobs' and column_name = 'execution_mode') as jobs,
            to_regclass('public.course_prebrief_versions') is not null as prebrief`,
  );
  if (t && t.jobs) {
    const [busy] = await q.query(
      `select 1 as x from public.production_jobs where course_id = $1 and execution_mode = 'dynamic_generation' and worker_status = any($2::text[]) limit 1`,
      [courseId, ACTIVE_RUN_WORKER_STATUSES],
    );
    if (busy) return 'PRODUCTION_ACTIVE';
  }
  if (respectPrebrief && t && t.prebrief) {
    const [v] = await q.query(`select status from public.course_prebrief_versions where course_id = $1 order by version desc limit 1`, [courseId]);
    if (v && (v.status === 'ready' || v.status === 'approved')) return 'PREBRIEF_FROZEN';
  }
  return null;
}

export interface PlanningOverlay {
  /** Contexto académico que quedaría vigente (el guardado si no cambia nada). */
  academic: StoredAcademicContext | null;
  /** true = algo de esto todavía no está guardado (contexto o vínculos): se guarda al usar el diseño o al preparar. */
  virtual: boolean;
  /** Vínculos de cada capítulo de contenido tal como quedarían (los guardados que siguen vigentes + los nuevos). */
  links: Map<string, string[]> | null;
}

/**
 * r63 · Lo que Cursia guardaría AHORA en la planificación académica (contexto desde el perfil + vínculos sin documento),
 * SIN escribir nada: «Cursia recomienda» y el GET del Prebrief lo muestran; «Usar este diseño» (design/fix) y «Preparar»
 * lo guardan con `syncAcademicOutcomesFromProfile` (mismo cálculo → mismo contexto, mismo sha, mismos vínculos).
 * Con documento, bloqueado o sin la migración: lo guardado, tal cual.
 */
export async function planningOverlay(q: Q, courseId: number, opts: { respectPrebrief: boolean }): Promise<PlanningOverlay> {
  const stored = await loadCurrentAcademicContext(q, courseId);
  const asIs: PlanningOverlay = { academic: stored, virtual: false, links: null };
  if (stored && hasDocuments(stored.context)) return asIs;
  if (await profileOutcomesBlockedBy(q, courseId, opts.respectPrebrief)) return asIs;
  if (!(await academicKindSupported(q))) return asIs;
  const ped = await loadCurrentPedagogicalProfile(q, courseId);
  const r = academicContextFromProfile(stored ? stored.context : null, ped ? ped.profile : null, await readProfileOutcomesRecord(q, courseId), { allowRemovals: true });
  let academic = stored;
  let virtual = false;
  if ((r.action === 'create' || r.action === 'update') && r.context) {
    const context = normalizeProfile('academic', r.context);
    const sha = profileSha256(context);
    if (!stored || stored.sha256 !== sha) { academic = { version: (stored ? stored.version : 0) + 1, context, sha256: sha }; virtual = true; }
  }
  if (!academic || !isDocumentlessContext(academic.context)) return { academic, virtual, links: null };
  const { plan, current, prunedAny } = await documentlessLinkPlanFor(q, courseId, academic.context);
  const links = new Map<string, string[]>();
  for (const [id, ids] of current) links.set(id, ids);
  for (const l of plan.links) links.set(l.chapterId, l.suggested);
  const changedLinks = plan.links.length > 0 || prunedAny;
  return { academic, virtual: virtual || changedLinks, links };
}

/**
 * ¿La base admite perfiles 'academic'? (sin supabase-migration-academic-context.sql el CHECK de kind los rechaza y el
 * INSERT abortaría la transacción del llamador). Sin la restricción con nombre, se asume que sí (es la de la migración).
 */
export async function academicKindSupported(q: Q): Promise<boolean> {
  const [c] = await q.query(`select pg_get_constraintdef(oid) as d from pg_constraint where conname = 'course_profiles_kind_check' limit 1`);
  return !c || /'academic'/.test(String(c.d));
}

export interface DocumentlessLinkCandidates {
  plan: DocumentlessLinkPlan;
  titles: Map<string, string>;
  /** Vínculos guardados de cada capítulo de contenido que siguen siendo ids del contexto (los demás, podados). */
  current: Map<string, string[]>;
  /** Algún capítulo tiene guardados ids que el contexto ya no define (se podan al guardar). */
  prunedAny: boolean;
}

/**
 * Vínculos que la vinculación sin documento propone para la estructura VIVA: capítulos de contenido, sin vínculos
 * propios, que el docente no desvinculó a propósito. Los vinculados cuentan para la cobertura (nunca se pisan).
 */
export async function documentlessLinkPlanFor(q: Q, courseId: number, ctx: AcademicContextV1): Promise<DocumentlessLinkCandidates> {
  const rows: { id: string; title: string; objective: string | null; description: string | null; outcome_ids: unknown; kind: string | null }[] = await q.query(
    `select ch.id, ch.title, ch.objective, ch.description, to_jsonb(ch) -> 'outcome_ids' as outcome_ids, to_jsonb(ch) ->> 'chapter_kind' as kind
       from public.course_chapters ch join public.course_modules m on m.id = ch.module_id
      where ch.course_id = $1 order by m.position, ch.position, ch.id`,
    [courseId],
  );
  const pins = await loadDesignPins(q, courseId);
  const known = new Set([...ctx.outcomes.map((o) => o.id), ...ctx.competencies.map((c) => c.id)]);
  const current = new Map(rows.filter((r) => r.kind !== 'practice').map((r) => [r.id, (Array.isArray(r.outcome_ids) ? (r.outcome_ids as string[]) : []).filter((x) => known.has(x))] as [string, string[]]));
  const plan = planDocumentlessLinks(ctx, rows.filter((r) => r.kind !== 'practice').map((r) => ({
    id: r.id, title: r.title, objective: r.objective, description: r.description,
    outcomeIds: Array.isArray(r.outcome_ids) ? (r.outcome_ids as string[]) : [],
    eligible: !(pins[r.id] && pins[r.id].noLinks),
  })));
  const prunedAny = rows.some((r) => Array.isArray(r.outcome_ids) && (r.outcome_ids as string[]).some((x) => !known.has(x)));
  return { plan, titles: new Map(rows.map((r) => [r.id, r.title])), current, prunedAny };
}

/** Quita de course_chapters.outcome_ids los ids que `ctx` no define (sube el contador si cambió algo). */
export async function pruneOutcomeLinksTo(qr: Q, courseId: number, ctx: AcademicContextV1): Promise<{ chapterId: string; removed: string[] }[]> {
  const rows: { id: string; ids: unknown }[] = await qr.query(
    `select id, to_jsonb(ch) -> 'outcome_ids' as ids from public.course_chapters ch
      where ch.course_id = $1 and jsonb_typeof(to_jsonb(ch) -> 'outcome_ids') = 'array'`,
    [courseId],
  );
  const known = new Set([...ctx.outcomes.map((o) => o.id), ...ctx.competencies.map((c) => c.id)]);
  const out: { chapterId: string; removed: string[] }[] = [];
  for (const r of rows) {
    const ids = Array.isArray(r.ids) ? (r.ids as string[]) : [];
    const keep = ids.filter((x) => known.has(x));
    if (keep.length === ids.length) continue;
    await qr.query(`update public.course_chapters set outcome_ids = $1::jsonb, updated_at = now() where id = $2 and course_id = $3`, [keep.length ? JSON.stringify(keep) : null, r.id, courseId]);
    out.push({ chapterId: r.id, removed: ids.filter((x) => !known.has(x)) });
  }
  if (out.length) {
    // Review L80 R2-M1: el contador nuevo sale del mismo UPDATE (el llamador ya tiene la fila del curso FOR UPDATE).
    const res = await qr.query(`update public.courses set structure_version_counter = structure_version_counter + 1 where id = $1 returning structure_version_counter c`, [courseId]);
    const before = Number(returningRows(res)[0].c) - 1;
    // LOOP 8.0 (review L80 I2): es trabajo de Cursia, no del docente (una estructura de Cursia intacta lo sigue siendo).
    await advanceStructureOriginIfUntouched(qr, courseId, before, before + 1);
  }
  return out;
}

export interface ProfileOutcomesSync {
  /** Por qué no se hizo nada (bloqueo, documento, sin resultados en el perfil). */
  skipped: string | null;
  context: { action: 'none' | 'create' | 'update'; version: number | null; added: string[]; removed: string[]; duplicates: string[]; ignored: string[] };
  linked: { chapterId: string; title: string; outcomes: string[] }[];
  /** Vínculos quitados porque el resultado salió del contexto (sube el contador: va en `structureVersionCounter`). */
  pruned?: { chapterId: string; removed: string[] }[];
  ambiguous: { id: string; text: string }[];
  unmatchedChapters: { chapterId: string; title: string }[];
  structureVersionCounter: number | null;
}

/**
 * Normaliza los resultados del perfil pedagógico en el contexto académico (versión nueva SOLO si cambia algo) y, si
 * `link`, vincula los capítulos sin vínculos de un curso sin documento. Debe correr dentro de una transacción con la fila
 * del curso tomada. `respectPrebrief`: no tocar nada si hay una propuesta preparada o aprobada (los disparadores
 * automáticos); un pedido explícito del docente («Vincular ahora») no lo respeta.
 */
export async function syncAcademicOutcomesFromProfile(
  qr: Q,
  courseId: number,
  ownerId: string,
  opts: { respectPrebrief: boolean; link: boolean; allowRemovals?: boolean },
): Promise<ProfileOutcomesSync> {
  const out: ProfileOutcomesSync = {
    skipped: null, context: { action: 'none', version: null, added: [], removed: [], duplicates: [], ignored: [] },
    linked: [], ambiguous: [], unmatchedChapters: [], structureVersionCounter: null,
  };
  const blocked = await profileOutcomesBlockedBy(qr, courseId, opts.respectPrebrief);
  if (blocked) return { ...out, skipped: blocked };
  if (!(await academicKindSupported(qr))) return { ...out, skipped: 'NO_ACADEMIC_MIGRATION' };
  const current = await loadCurrentAcademicContext(qr, courseId);
  const ped = await loadCurrentPedagogicalProfile(qr, courseId);
  const record = await readProfileOutcomesRecord(qr, courseId);
  // Quitar resultados poda vínculos (sube el contador): solo donde se vincula (link) o si el llamador lo pide.
  const r = academicContextFromProfile(current ? current.context : null, ped ? ped.profile : null, record, { allowRemovals: opts.allowRemovals ?? opts.link });
  out.context = { action: r.action === 'skip' ? 'none' : r.action, version: current ? current.version : null, added: r.added, removed: r.removed, duplicates: r.duplicates, ignored: r.ignored };
  if (r.action === 'skip') out.skipped = r.reason;
  let ctx: AcademicContextV1 | null = current ? current.context : null;
  if ((r.action === 'create' || r.action === 'update') && r.context) {
    const errors = validateProfile('academic', r.context, { finalExam: true });
    // Falla fuerte: un contexto inválido nunca se guarda en silencio (no debería pasar: los textos ya vienen del perfil).
    if (errors.length) throw new Error(`PROFILE_OUTCOMES_INVALID: ${errors.map((e) => `${e.path}: ${e.message}`).join('; ').slice(0, 500)}`);
    const next = normalizeProfile('academic', r.context);
    const sha = profileSha256(next);
    if (!current || current.sha256 !== sha) {
      const version = (current ? current.version : 0) + 1;
      await qr.query(
        `insert into public.course_profiles (course_id, kind, version, data, sha256, created_by) values ($1, 'academic', $2, $3::jsonb, $4, $5)`,
        [courseId, version, JSON.stringify(next), sha, ownerId],
      );
      out.context.version = version;
      if (r.removed.length) {
        const pruned = await pruneOutcomeLinksTo(qr, courseId, next);
        if (pruned.length) out.pruned = pruned;
      }
    } else out.context.action = 'none';
    ctx = next;
  }
  if (r.record && JSON.stringify(r.record) !== JSON.stringify(record)) {
    await qr.query(
      `update public.courses set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), $2::text[], $3::jsonb, true) where id = $1`,
      [courseId, [PROFILE_OUTCOMES_KEY], JSON.stringify(r.record)],
    );
  }
  if (out.pruned) out.structureVersionCounter = Number((await qr.query(`select structure_version_counter c from public.courses where id = $1`, [courseId]))[0].c);
  if (opts.link && ctx && isDocumentlessContext(ctx)) {
    const { plan, titles } = await documentlessLinkPlanFor(qr, courseId, ctx);
    const [c0] = await qr.query(`select structure_version_counter c from public.courses where id = $1`, [courseId]);
    const before = Number(c0.c);
    for (const l of plan.links) {
      const res = await qr.query(
        `update public.course_chapters set outcome_ids = $1::jsonb, updated_at = now()
          where id = $2 and course_id = $3 and (outcome_ids is null or jsonb_array_length(outcome_ids) = 0) returning id`,
        [JSON.stringify(l.suggested), l.chapterId, courseId],
      );
      if (returningRows(res).length) out.linked.push({ chapterId: l.chapterId, title: titles.get(l.chapterId) || '', outcomes: l.suggested });
    }
    out.structureVersionCounter = before;
    if (out.linked.length) {
      const n = await qr.query(`update public.courses set structure_version_counter = structure_version_counter + 1 where id = $1 returning structure_version_counter c`, [courseId]);
      out.structureVersionCounter = Number(returningRows(n)[0].c);
      await advanceStructureOriginIfUntouched(qr, courseId, before, out.structureVersionCounter);
    }
    out.ambiguous = plan.ambiguous.map((a) => ({ id: a.id, text: a.text }));
    out.unmatchedChapters = plan.unmatchedChapterIds.map((id) => ({ chapterId: id, title: titles.get(id) || '' }));
  }
  return out;
}

/**
 * r63 · Un documento reemplaza un contexto sin documento: los ids que agregó el puente pueden significar otra cosa en el
 * documento (RA1 del perfil ≠ RA1 del documento). Los vínculos de capítulos a esos ids se quitan si el texto cambió
 * (nunca quedan vínculos que ya no dicen lo mismo) y el registro del puente se borra: desde ahí manda el documento.
 * Mismos ids con el mismo texto conservan sus vínculos. Solo corre en ese cambio (documento sobre un contexto sin
 * documento): reimportar un documento o editar resultados en «Lo que entendimos» se comporta igual que siempre.
 */
export async function pruneProfileLinksReplacedByDocument(qr: Q, courseId: number, ctx: AcademicContextV1): Promise<{ chapterId: string; removed: string[] }[]> {
  const record = await readProfileOutcomesRecord(qr, courseId);
  if (!record) return [];
  const textOf = new Map<string, string>([...ctx.outcomes.map((o) => [o.id, normalizeOutcomeText(o.text)] as [string, string]), ...ctx.competencies.map((c) => [c.id, normalizeOutcomeText(c.text)] as [string, string])]);
  const changed = new Set(Object.entries(record.items).filter(([id, t]) => textOf.has(id) && textOf.get(id) !== t).map(([id]) => id));
  const out: { chapterId: string; removed: string[] }[] = [];
  if (changed.size) {
    const rows: { id: string; ids: unknown }[] = await qr.query(
      `select id, to_jsonb(ch) -> 'outcome_ids' as ids from public.course_chapters ch where ch.course_id = $1 and jsonb_typeof(to_jsonb(ch) -> 'outcome_ids') = 'array'`,
      [courseId],
    );
    for (const r of rows) {
      const ids = Array.isArray(r.ids) ? (r.ids as string[]) : [];
      const keep = ids.filter((x) => !changed.has(x));
      if (keep.length === ids.length) continue;
      await qr.query(`update public.course_chapters set outcome_ids = $1::jsonb, updated_at = now() where id = $2 and course_id = $3`, [keep.length ? JSON.stringify(keep) : null, r.id, courseId]);
      out.push({ chapterId: r.id, removed: ids.filter((x) => changed.has(x)) });
    }
    if (out.length) {
      const res = await qr.query(`update public.courses set structure_version_counter = structure_version_counter + 1 where id = $1 returning structure_version_counter c`, [courseId]);
      const before = Number(returningRows(res)[0].c) - 1;
      await advanceStructureOriginIfUntouched(qr, courseId, before, before + 1);
    }
  }
  await qr.query(`update public.courses set metadata = coalesce(metadata, '{}'::jsonb) - $2 where id = $1`, [courseId, PROFILE_OUTCOMES_KEY]);
  return out;
}
