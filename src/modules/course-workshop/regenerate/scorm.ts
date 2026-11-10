/**
 * r107 B10 · `regenerate_scorm` — rehace el juego del capítulo con el generador EXISTENTE:
 *   - curso con SCORM (V1 / v2): el motor SCORM v2 del ejecutor vendorizado (`_dynGenScormRoomV2` por sala, con su
 *     reintento dirigido y la plantilla de reemplazo `_dynPickRoomFallback`; `scormV2ValidateChapterRooms`;
 *     `buildScormV2Html`; `defMf`). Las 5 salas con la MISMA mecánica que el juego original (si es del motor v2), la que
 *     pidió el docente o la rotación del curso — dicho en el plan. Una sala que no sale completa corta la producción:
 *     nunca un juego con «⚠️ Pendiente» ni con salas de menos;
 *   - curso v3: la práctica H5P EQUIVALENTE del capítulo (`_dynRunActivityH5p`, mismo tipo H5P) y el `.h5p` lo arma el
 *     builder v3 (`buildActivityH5p`).
 */
import type { DryRunPricing } from '../../pedagogy/dry-run';
import type { WorkshopCourse } from '../course-model';
import { buildActivityH5p } from '../../../package/dynamic-mbz-builder-v3';
import { parseScormManifestIds } from '../../../package/v3/moodle-activities-v3';
import { workshopExecutor } from './executor';
import { PaidCallGate, RegenProviders } from './ports';
import type { RegenDbSources } from './sources';
import { hasPendingMarker, h5pJsonOf, scormV2Rooms } from './target';
import { ProducedRegen, RegenError, RegenTarget, SCORM_V2_ROOMS, SCORM_V2_TEMPLATE_IDS } from './types';

type ScormTarget = Extract<RegenTarget, { op: 'regenerate_scorm'; engine: 'scorm_v2' }>;
type PracticeTarget = Extract<RegenTarget, { op: 'regenerate_scorm'; engine: 'h5p_practice' }>;

/** Contexto del curso para los prompts del generador (`dynCtx`): lo que hay en la base, o lo del paquete. */
export function courseContextOf(course: WorkshopCourse, db: RegenDbSources | null): Record<string, unknown> {
  return { nombre: course.course.title ?? '', sector: '', pais: '', nivel: '', tono: '', obj: '', contexto: '', ...(db?.courseContext ?? {}) };
}
export function outlineOf(course: WorkshopCourse): Array<{ id: string; moduleNumber: number; title: string; chapters: Array<{ id: string; chapterNumber: number; title: string }> }> {
  const mods = course.modules.length ? course.modules : [{ number: 1, title: course.course.title ?? 'Módulo 1', chapterNumbers: course.chapters.map((c) => c.number), builderUuid: null } as any];
  return mods.map((m: any) => ({
    id: m.builderUuid ?? `ws-module-${m.number}`, moduleNumber: m.number, title: m.title ?? `Módulo ${m.number}`,
    chapters: (m.chapterNumbers ?? []).map((n: number) => {
      const c = course.chapters.find((x) => x.number === n);
      return { id: c?.builderUuid ?? `ws-chapter-${n}`, chapterNumber: n, title: c?.title ?? `Capítulo ${n}` };
    }),
  }));
}

/** Validación del juego producido (independiente del generador): 5 salas reconocidas, sin «Pendiente», con su JS y manifiesto. */
export function scormProblems(p: { html: string; manifestXml: string; roomAssignment: string[] }): string[] {
  const out: string[] = [];
  const rooms = scormV2Rooms(p.html);
  if (rooms.length !== SCORM_V2_ROOMS) out.push(`el juego tiene ${rooms.length} sala(s); se esperaban ${SCORM_V2_ROOMS}`);
  if (rooms.some((r) => r === null)) out.push('hay salas que no corresponden a ninguna mecánica del motor');
  if (JSON.stringify(rooms) !== JSON.stringify(p.roomAssignment)) out.push('las salas del HTML no coinciden con la asignación de mecánicas');
  if (hasPendingMarker(p.html)) out.push('el juego trae un marcador «⚠️ Pendiente»');
  if (!/<script\b[\s\S]*?sv2ShowRoom[\s\S]*?<\/script>/i.test(p.html)) out.push('el juego no trae su JavaScript');
  if (!/<\/html>\s*$/i.test(p.html)) out.push('el HTML del juego está cortado');
  try { parseScormManifestIds(p.manifestXml); } catch (e) { out.push(`imsmanifest.xml inválido: ${e instanceof Error ? e.message : String(e)}`); }
  return out;
}

export async function produceScormV2(a: { target: ScormTarget; course: WorkshopCourse; providers: RegenProviders; gate: PaidCallGate; pricing: DryRunPricing; db: RegenDbSources | null }): Promise<ProducedRegen> {
  const ex = workshopExecutor({ providers: a.providers, gate: a.gate, pricing: a.pricing, what: 'scorm_room', texts: new Map(), ownerId: a.gate.charge.payer });
  const ctx = ex.sandbox.ctx;
  const t = a.target;
  const cap = { n: t.chapterNumber, t: t.chapterTitle };
  const courseContext = courseContextOf(a.course, a.db);
  const outline = outlineOf(a.course);
  const pool = t.mechanics.filter((m) => (SCORM_V2_TEMPLATE_IDS as readonly string[]).includes(m));
  if (!pool.length) throw new RegenError('invalid_result', 'No quedó ninguna mecánica válida del motor de juegos.');
  // Mecánica: la original sala por sala; si no, la asignación del generador sobre el conjunto (sin dos iguales seguidas).
  const assignment: string[] = t.mechanicsSource === 'original' && pool.length === SCORM_V2_ROOMS
    ? [...pool]
    : Array.from(ctx._dynAssignRoomTemplates(pool, SCORM_V2_ROOMS, ctx._dynItemRng({ chapterId: `workshop-${t.moduleId}`, generation: 1 }, 'scorm-rooms')) as string[]);
  const sys = ctx.scormV2SysPrompt();
  const roomsData: Array<{ templateId: string; data: unknown }> = [];
  for (let i = 0; i < SCORM_V2_ROOMS; i++) {
    let templateId = assignment[i];
    let result = await ctx._dynGenScormRoomV2(cap, templateId, sys, courseContext, outline, null, '').catch((e: any) => ({ ok: false, reason: e?.msg ?? e?.message ?? String(e) }));
    if (ex.stop) throw ex.stop;
    if (!result.ok && !ctx.DYN_EXHAUSTED_RETRIES_RE.test(result.reason || '')) {
      const fb = ctx._dynPickRoomFallback(pool.length >= 2 ? pool : [...SCORM_V2_TEMPLATE_IDS], assignment, i, templateId);
      if (fb) {
        const r2 = await ctx._dynGenScormRoomV2(cap, fb, sys, courseContext, outline, null, '').catch((e: any) => ({ ok: false, reason: e?.msg ?? e?.message ?? String(e) }));
        if (ex.stop) throw ex.stop;
        if (r2.ok) { assignment[i] = fb; templateId = fb; }
        result = r2;
      }
    }
    if (!result.ok) throw new RegenError('invalid_result', `El juego nuevo no salió completo: la sala ${i + 1} (${templateId}) no tiene datos válidos (${String(result.reason || '').slice(0, 200)}). No se agrega un juego a medias.`);
    roomsData.push({ templateId, data: result.data });
  }
  const v = ctx.scormV2ValidateChapterRooms(assignment, roomsData);
  if (!v.ok) throw new RegenError('invalid_result', `El juego nuevo no pasó la validación del motor: ${v.reason}.`);
  const html = String(ctx.buildScormV2Html(cap, assignment, roomsData));
  const manifestXml = String(ctx.defMf(cap));
  const problems = scormProblems({ html, manifestXml, roomAssignment: assignment });
  if (problems.length) throw new RegenError('invalid_result', `El juego nuevo no es válido: ${problems.join('; ')}.`);
  return { kind: 'scorm_v2', moduleId: t.moduleId, chapterNumber: t.chapterNumber, html, manifestXml, roomAssignment: [...assignment], rooms: SCORM_V2_ROOMS };
}

/** Preguntas / huecos / decisiones de una práctica (para el «después»). */
function practiceCount(type: string, data: any): number {
  if (type === 'questionset') return Array.isArray(data?.questions) ? data.questions.length : 0;
  if (type === 'branchingscenario') return Array.isArray(data?.decisions) ? data.decisions.length : 0;
  if (type === 'dragtext' || type === 'blanks') return Math.floor(String(data?.text ?? (Array.isArray(data?.questions) ? data.questions.join(' ') : '')).split('*').length / 2);
  return 0;
}

export async function producePracticeH5p(a: { target: PracticeTarget; course: WorkshopCourse; providers: RegenProviders; gate: PaidCallGate; pricing: DryRunPricing; db: RegenDbSources | null; chapterMd: string; currentH5p: Buffer }): Promise<ProducedRegen> {
  const t = a.target;
  const cp = a.db?.contextPackage.get(t.chapterNumber);
  if (!cp) throw new RegenError('source_missing', 'La práctica H5P se arma con el Context Package del capítulo guardado en Cursia, y este curso no lo tiene: no se puede rehacer.');
  const chapterId = (typeof (cp as any).chapterId === 'string' && (cp as any).chapterId) || a.course.chapters.find((c) => c.number === t.chapterNumber)?.builderUuid || `workshop-${t.moduleId}`;
  const cur = await h5pJsonOf(a.currentH5p);
  const pp = Number(cur?.content?.passPercentage);
  const passing = Number.isInteger(pp) && pp >= 0 && pp <= 100 ? pp : 70;
  const texts = new Map<string, string>([['ws-md', a.chapterMd], ['ws-cp', JSON.stringify(cp)]]);
  const ex = workshopExecutor({ providers: a.providers, gate: a.gate, pricing: a.pricing, what: 'practice_h5p', texts, ownerId: a.gate.charge.payer });
  const itemKey = `activity:${chapterId}`;
  const item = {
    rulesVersion: 3, type: 'activity', variant: 'h5p', itemKey, itemRunId: null, chapterId, chapterNumber: t.chapterNumber, generation: 1,
    claimPayload: { h5pType: t.h5pType, activityTypeSource: 'manifest', passPercentage: passing },
    dependencyArtifacts: [{ type: 'dynamic_content_md', artifactId: 'ws-md', itemKey: `content:${chapterId}` }, { type: 'dynamic_context_package_json', artifactId: 'ws-cp', itemKey: `content:${chapterId}` }],
    blueprint: { chapter: { id: chapterId, title: t.chapterTitle, objective: (cp as any)?.chapter?.objective ?? null }, outline: outlineOf(a.course) },
    context: { courseContext: courseContextOf(a.course, a.db) },
  };
  const res = await ex.sandbox.ctx._dynRunActivityH5p(item).catch((e: any) => ({ ok: false, error: e?.msg ?? e?.message ?? String(e) }));
  if (ex.stop) throw ex.stop;
  if (!res || !res.ok) throw new RegenError('invalid_result', `La práctica nueva no pasó la validación del generador: ${String(res?.error ?? 'sin detalle').slice(0, 300)}.`);
  const art = (res.artifacts || []).find((x: any) => x.type === 'dynamic_h5p_params_json');
  let payload: any;
  try { payload = JSON.parse(art.content); } catch { throw new RegenError('invalid_result', 'La práctica nueva no trae su contenido.'); }
  if (payload?.type !== t.h5pType) throw new RegenError('invalid_result', `La práctica nueva es de otro tipo (${payload?.type}); se esperaba ${t.h5pType}.`);
  let built: { h5p: Buffer; mainLibrary: string };
  try {
    built = await buildActivityH5p(payload, chapterId, itemKey, passing, t.h5pType as any, t.h5pType === 'branchingscenario' ? 2 : undefined);
  } catch (e) {
    throw new RegenError('invalid_result', `El builder no pudo armar la práctica: ${e instanceof Error ? e.message.slice(0, 300) : String(e)}.`);
  }
  if (built.mainLibrary !== t.mainLibrary) throw new RegenError('invalid_result', `La práctica nueva usa ${built.mainLibrary}; la del curso es ${t.mainLibrary}.`);
  const questions = practiceCount(t.h5pType, payload.data);
  if (questions < 1) throw new RegenError('invalid_result', 'La práctica nueva no tiene preguntas.');
  return { kind: 'h5p_practice', moduleId: t.moduleId, chapterNumber: t.chapterNumber, h5p: built.h5p, mainLibrary: built.mainLibrary, h5pType: t.h5pType, questions };
}
