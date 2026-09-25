/**
 * Fase 5B.1: contrato compartido del empaquetado Moodle dinámico.
 *
 * Solo tipos. Tres bloques lo implementan en paralelo:
 *   B1: packaging-plan.ts (buildPackagingPlan) + artifact-resolver.ts
 *   B2: src/package/dynamic-mbz-builder.ts (buildDynamicMbz)
 *   B3: packaging.controller.ts / servicio / worker + UI
 * Spec: campuscloud-gen docs/superpowers/specs/2026-09-25-dynamic-course-structure-fase5b-packaging-design.md
 *
 * Invariantes:
 * - Los números (sectionNum, moduleNumber, chapterNumber) salen SOLO del
 *   Manifest congelado y se usan únicamente para presentación y nombres de
 *   archivo. La identidad es siempre el UUID (moduleId, chapterId) y el
 *   itemKey del Manifest.
 * - No hay examen final ni sección de cierre en dynamic V1.
 * - No hay texto generado por LLM en esta capa: todo texto de packaging es
 *   plantilla determinística.
 */

import type { GenerationManifestV1 } from '../generation-manifests/generation-manifest-builder';
import type { BlueprintSnapshotV1 } from '../course-blueprints/blueprint-snapshot';

export type { GenerationManifestV1, BlueprintSnapshotV1 };

export interface PackagingChapterPlan {
  chapterId: string;
  moduleId: string;
  chapterNumber: number; // global 1..N (Manifest)
  moduleNumber: number;
  title: string;
  objective: string | null;
  /** itemKeys del Manifest que este capítulo empaqueta. */
  contentItemKey: string; // 'content:<chapterId>'
  scormItemKey: string; // 'scorm:<chapterId>'
  videoItemKey: string | null; // 'video:<chapterId>' si existe en el Manifest
}

export interface PackagingModulePlan {
  moduleId: string;
  moduleNumber: number; // 1..M (Manifest)
  sectionNum: number; // 1 + moduleNumber (0 = bienvenida, 1 = ruta y libro guía)
  title: string;
  objective: string | null;
  /** Índice de color: (moduleNumber - 1), el builder lo cicla con % paleta.length. */
  colorIndex: number;
  chapters: PackagingChapterPlan[]; // orden del Manifest
  examItemKey: string | null; // 'exam:<moduleId>' si existe en el Manifest
}

export interface PackagingPlan {
  planVersion: 1;
  manifestId: number | null; // null en tests puros
  course: { id: number; title: string; summary: string | null };
  /** Secciones de Moodle en orden: 0 welcome, 1 route_and_book, luego una por módulo. */
  sections: Array<
    | { sectionNum: 0; kind: 'welcome'; title: string }
    | { sectionNum: 1; kind: 'route_and_book'; title: string }
    | { sectionNum: number; kind: 'module'; moduleId: string; title: string }
  >;
  modules: PackagingModulePlan[];
  totals: { modules: number; chapters: number; scorms: number; videos: number; exams: number };
}

/** Artifact final resuelto de un item del Manifest (se une por item_run_id). */
export interface ResolvedArtifact {
  itemKey: string;
  itemRunId: string;
  artifactId: string;
  type:
    | 'dynamic_content_md'
    | 'dynamic_scorm_html'
    | 'dynamic_scorm_manifest'
    | 'dynamic_exam_gift'
    | 'dynamic_video';
  storageBucket: string;
  storagePath: string;
  mimeType: string | null;
}

/** Contenidos ya descargados que consume el builder (sin I/O dentro del builder). */
export interface DynamicPackageContents {
  contentMd: Map<string, string>; // chapterId -> markdown
  scorm: Map<string, { html: string; manifestXml: string }>; // chapterId
  examGift: Map<string, string>; // moduleId -> GIFT
  /**
   * chapterId -> video externo. 5B.1 usa la URL directa y pública de Videogen
   * (downloadUrl del artifact dynamic_video) SOLO como mecanismo de aceptación
   * en staging. La entrega final del video (YouTube, storage estable, etc.) se
   * decide en 5B.2. Nunca se usan signed URLs temporales.
   * 5B.2.A: `delivery: 'youtube'` (solo runs congelados en youtube) → `url`
   * es la de YouTube y cambia el texto de la actividad; ausente = Videogen
   * directo (5B.1, byte-idéntico).
   */
  videos: Map<string, { url: string; videogenJobId: string; delivery?: 'youtube' }>;
}

export interface BuildDynamicMbzInput {
  plan: PackagingPlan;
  contents: DynamicPackageContents;
  /** Colores de módulo, ciclados por colorIndex. Hex sin '#'. */
  palette?: { dark: string; accent: string; modules: Array<{ main: string; accent: string }> };
  moodleVersion?: string; // default igual al builder legacy
}

export class PackagingNotReadyError extends Error {
  constructor(public readonly missing: string[], message?: string) {
    super(message ?? `Empaquetado no listo: faltan ${missing.length} item(s)`);
    this.name = 'PackagingNotReadyError';
  }
}
