// r79.1 · Asignación de los TIPOS de Actividad de Aplicación al diseño propuesto (función pura, determinista).
//
// Corre DESPUÉS del distribuidor y solo con la preferencia «Tipos de actividad: automático»
// (designPreferences.activityKinds = 'auto'). No cambia minutos, capítulos ni conteos: elige, para las Actividades de
// Aplicación que el diseño YA tiene, el tipo que aporta valor pedagógico según criterios EXPLÍCITOS (versionados):
//
//   K1 estudio de caso (capítulo de contenido; niveles 60/90): el capítulo pide ANALIZAR o DECIDIR — su tipo de
//      aprendizaje es «decisión y casos» o «normativo y ético», o su objetivo / sus resultados vinculados están en el
//      nivel analizar o evaluar (Bloom). A lo sumo uno por módulo (el de señal más fuerte; empate → el más avanzado del
//      módulo) y no más de la mitad de las Actividades de contenido del curso.
//   K2 proyecto integrador (primer capítulo de práctica del módulo, «Práctica integradora»; niveles 90/120): el módulo
//      tiene ≥ 2 capítulos de contenido y sus resultados u objetivos piden CREAR / PRODUCIR (Bloom crear). Con la señal
//      solo en los resultados del curso (perfil), uno por curso (en el último módulo que cumpla).
//   K3 retroalimentación formativa (otro capítulo de práctica del módulo, nunca el integrador; niveles 30/60/90): hay una
//      práctica EVALUABLE antes en el módulo (una Actividad de Aplicación con criterios y producto). A lo sumo una por
//      módulo.
//
// Nunca: en una Actividad fijada por el docente, en un nivel que no es del tipo, ni en un nivel con el candado de
// proporcionalidad cerrado (course-shell/application-kinds.ts). Sin señal → la Actividad de siempre.
import type { BlueprintSnapshotV2 } from '../course-blueprints/blueprint-snapshot';
import { bloomLevelOf, observableLevelOf } from '../academic-context/bloom';
import { classifyLearningType } from '../pedagogy/learning-type';
import { TierLockRow, isTierSelectable } from '../course-shell/application-kinds';
import { APPLICATION_KIND_LABEL, APPLICATION_KIND_TIERS, ApplicationKind } from './application-kind-tiers';
import type { DistributionChange, DistributionResult, ProposedChapter } from './distributor';

export const ACTIVITY_KIND_RULES_VERSION = 1 as const;
export type ActivityKindsMode = 'auto' | 'none';
export const ACTIVITY_KINDS_MODES: readonly ActivityKindsMode[] = ['auto', 'none'];

export interface ActivityKindDecision {
  chapterId: string;
  moduleId: string;
  kind: ApplicationKind;
  minutes: number;
  ruleId: 'K1' | 'K2' | 'K3';
  reason: string;
}
export interface ActivityKindsReport {
  rulesVersion: typeof ACTIVITY_KIND_RULES_VERSION;
  /** Actividades que cumplen el criterio de algún tipo (antes de los topes por módulo / curso). */
  eligible: number;
  decisions: ActivityKindDecision[];
  counts: Record<ApplicationKind, number>;
}

const BLOOM_ANALYSIS = new Set(['analyze', 'evaluate']);
const BLOOM_CREATE = new Set(['create']);

interface Ctx {
  textOf: Map<string, { text: string; level: string | null }>;
  snapCh: Map<string, any>;
  courseOutcomes: string[];
}

function levelOf(text: string, frozen?: string | null): string | null {
  if (frozen) return frozen;
  return bloomLevelOf(text) ?? observableLevelOf(text);
}

/** Textos (objetivo + resultados vinculados) de un capítulo y su nivel cognitivo. */
function chapterSignals(c: ProposedChapter, moduleContent: ProposedChapter[], ctx: Ctx): { levels: Set<string>; evidence: string[] } {
  const levels = new Set<string>();
  const evidence: string[] = [];
  const add = (t: string | null | undefined, frozen?: string | null, label?: string) => {
    if (!t || !t.trim()) return;
    const l = levelOf(t, frozen);
    if (l) { levels.add(l); evidence.push(`${label ? `${label} ` : ''}«${t.trim().slice(0, 90)}» (${l})`); }
  };
  add(c.objective, null, 'objetivo');
  const ids: string[] = [];
  const sc = ctx.snapCh.get(c.id);
  if (sc && Array.isArray(sc.outcomeIds)) ids.push(...sc.outcomeIds);
  else if (c.proposed && c.kind === 'content') for (const x of moduleContent) { const s2 = ctx.snapCh.get(x.id); if (s2 && Array.isArray(s2.outcomeIds)) ids.push(...s2.outcomeIds); }
  for (const id of [...new Set(ids)].sort()) { const o = ctx.textOf.get(id); if (o) add(o.text, o.level, id); }
  return { levels, evidence };
}

const LT_MEMO = new Map<string, string>();
function learningTypeOf(c: ProposedChapter, ctx: Ctx): string {
  const frozen = ctx.snapCh.get(c.id)?.design?.learningType?.type;
  if (typeof frozen === 'string') return frozen;
  const desc = ctx.snapCh.get(c.id)?.description ?? null;
  const key = `${c.title}\u0000${c.objective ?? ''}\u0000${desc ?? ''}`;
  const hit = LT_MEMO.get(key);
  if (hit) return hit;
  const t = classifyLearningType({ title: c.title, objective: c.objective, description: desc }).type;
  if (LT_MEMO.size > 20000) LT_MEMO.clear();
  LT_MEMO.set(key, t);
  return t;
}

function canHold(c: ProposedChapter, kind: ApplicationKind, lock: readonly TierLockRow[] | null): boolean {
  return c.applicationMinutes !== null && !c.applicationPinned && APPLICATION_KIND_TIERS[kind].includes(c.applicationMinutes) && isTierSelectable(kind, c.applicationMinutes, lock);
}

/**
 * Asigna los tipos (o los quita: con `mode = 'none'` el resultado no tiene ninguno). Devuelve un diseño NUEVO (no muta
 * el de entrada) y el informe con cada decisión y su motivo.
 */
export function assignApplicationKinds(dist: DistributionResult, snapshot: BlueprintSnapshotV2, mode: ActivityKindsMode, lock: readonly TierLockRow[] | null = null): { dist: DistributionResult; report: ActivityKindsReport } {
  const out: DistributionResult = { ...dist, modules: dist.modules.map((m) => ({ ...m, chapters: m.chapters.map((c) => { const { applicationKind: _k, ...rest } = c; return { ...rest } as ProposedChapter; }) })) };
  const counts: Record<ApplicationKind, number> = { case_study: 0, integrative_project: 0, formative_feedback: 0 };
  const report: ActivityKindsReport = { rulesVersion: ACTIVITY_KIND_RULES_VERSION, eligible: 0, decisions: [], counts };
  const before = new Map<string, ApplicationKind | undefined>();
  for (const m of snapshot.modules) for (const c of m.chapters) before.set(c.id, (c as { applicationKind?: ApplicationKind }).applicationKind);
  if (mode === 'auto') {
    const ac: any = (snapshot.course as any).academicContext;
    const textOf = new Map<string, { text: string; level: string | null }>();
    if (ac) {
      for (const o of ac.outcomes ?? []) textOf.set(o.id, { text: o.text, level: o.level ?? null });
      for (const o of ac.competencies ?? []) textOf.set(o.id, { text: o.text, level: null });
    }
    const snapCh = new Map<string, any>();
    for (const m of snapshot.modules) for (const c of m.chapters) snapCh.set(c.id, c);
    const lo: any = (snapshot.course as any).applicationContext?.learningOutcomes;
    const courseOutcomes = [...(Array.isArray(lo?.do) ? lo.do : []), ...(Array.isArray(lo?.competencies) ? lo.competencies : []), ...(ac ? (ac.outcomes ?? []).map((o: any) => o.text) : [])].filter((x) => typeof x === 'string');
    const ctx: Ctx = { textOf, snapCh, courseOutcomes };
    const contentApps = out.modules.flatMap((m) => m.chapters.filter((c) => c.kind === 'content' && c.applicationMinutes !== null)).length;
    const caseCap = Math.floor(contentApps / 2);
    const courseCreate = courseOutcomes.some((t) => BLOOM_CREATE.has(levelOf(t) ?? ''));
    let courseProjectAt: { m: number; c: ProposedChapter; reason: string } | null = null;
    const decide = (m: (typeof out.modules)[number], c: ProposedChapter, kind: ApplicationKind, ruleId: ActivityKindDecision['ruleId'], reason: string) => {
      c.applicationKind = kind;
      counts[kind] += 1;
      report.decisions.push({ chapterId: c.id, moduleId: m.id, kind, minutes: c.applicationMinutes as number, ruleId, reason });
    };
    out.modules.forEach((m, mi) => {
      const content = m.chapters.filter((c) => c.kind === 'content');
      const practice = m.chapters.filter((c) => c.kind === 'practice');
      // K1 · estudio de caso
      const cand = content
        .map((c, i) => {
          const sig = chapterSignals(c, content, ctx);
          const lt = learningTypeOf(c, ctx);
          const a = lt === 'decision_caso' || lt === 'normativo_etico';
          const b = [...sig.levels].some((l) => BLOOM_ANALYSIS.has(l));
          return { c, i, score: (a ? 1 : 0) + (b ? 1 : 0), lt, sig, a, b };
        })
        .filter((x) => x.score > 0 && x.c.applicationMinutes !== null);
      report.eligible += cand.length;
      const fit = cand.filter((x) => canHold(x.c, 'case_study', lock)).sort((x, y) => y.score - x.score || y.i - x.i)[0];
      if (fit && counts.case_study < caseCap) {
        const why = [fit.a ? `su tipo de aprendizaje es «${fit.lt === 'decision_caso' ? 'decisión y casos' : 'normativo y ético'}»` : '', fit.b ? `pide analizar o evaluar (${fit.sig.evidence.filter((e) => /analyze|evaluate/.test(e)).slice(0, 2).join('; ')})` : ''].filter(Boolean).join(' y ');
        decide(m, fit.c, 'case_study', 'K1', `«${fit.c.title}» ${why}: un estudio de caso con datos, preguntas de análisis graduadas y una decisión justificada evidencia ese nivel mejor que ejercicios sueltos.`);
      }
      // K2 · proyecto integrador
      const integ = practice[0];
      if (integ && content.length >= 2 && integ.applicationMinutes !== null) {
        const modLevels = new Set<string>();
        const ev: string[] = [];
        for (const c of content) { const sg = chapterSignals(c, content, ctx); sg.levels.forEach((l) => modLevels.add(l)); ev.push(...sg.evidence.filter((e) => /\(create\)/.test(e))); }
        const moduleCreate = modLevels.has('create');
        if (moduleCreate || courseCreate) report.eligible += 1;
        if (canHold(integ, 'integrative_project', lock)) {
          if (moduleCreate) decide(m, integ, 'integrative_project', 'K2', `El módulo pide crear o producir (${ev.slice(0, 2).join('; ')}) y tiene ${content.length} capítulos de contenido: un proyecto por etapas (una por capítulo, con entregables intermedios) integra el módulo en un producto final.`);
          else if (courseCreate) courseProjectAt = { m: mi, c: integ, reason: `Los resultados del curso piden crear o producir y el módulo tiene ${content.length} capítulos de contenido: un proyecto integrador por etapas, una vez en el curso (en el último módulo que lo admite).` };
        }
      }
      // K3 · retroalimentación formativa
      const fb = practice.slice(1).find((p) => {
        const at = m.chapters.indexOf(p);
        return m.chapters.slice(0, at).some((x) => x.applicationMinutes !== null);
      });
      if (fb) {
        report.eligible += 1;
        if (canHold(fb, 'formative_feedback', lock) && !fb.applicationKind) {
          const prev = m.chapters.slice(0, m.chapters.indexOf(fb)).filter((x) => x.applicationMinutes !== null);
          decide(m, fb, 'formative_feedback', 'K3', `Después de ${prev.length === 1 ? 'la Actividad de Aplicación' : `${prev.length} Actividades de Aplicación`} del módulo (${prev.map((x) => `«${x.title}»`).slice(0, 2).join(', ')}${prev.length > 2 ? ` y ${prev.length - 2} más` : ''}): el estudiante revisa su producto con criterios, un ejemplar comentado y errores frecuentes, lo mejora y lo vuelve a entregar.`);
        }
      }
    });
    if (courseProjectAt && counts.integrative_project === 0) {
      const { m, c, reason } = courseProjectAt as { m: number; c: ProposedChapter; reason: string };
      decide(out.modules[m], c, 'integrative_project', 'K2', reason);
    }
  }
  // Cambios visibles (capítulos existentes): el tipo nuevo o el que se quita.
  const changes: DistributionChange[] = [...dist.changes.filter((x) => x.type !== 'set_application_kind' && x.type !== 'remove_application_kind')];
  for (const m of out.modules) for (const c of m.chapters) {
    if (c.proposed) continue;
    const had = before.get(c.id);
    if (had === c.applicationKind) continue;
    changes.push(c.applicationKind
      ? { type: 'set_application_kind', moduleId: m.id, chapterId: c.id, detail: `La Actividad de Aplicación de «${c.title}» pasa a ser un ${APPLICATION_KIND_LABEL[c.applicationKind].toLowerCase()} (${c.applicationMinutes} min).` }
      : { type: 'remove_application_kind', moduleId: m.id, chapterId: c.id, detail: `La Actividad de Aplicación de «${c.title}» vuelve a ser la de siempre (antes: ${had ? APPLICATION_KIND_LABEL[had].toLowerCase() : ''}).` });
  }
  out.changes = changes;
  return { dist: out, report };
}
