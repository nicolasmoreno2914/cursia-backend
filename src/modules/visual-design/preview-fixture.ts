/**
 * r76 «Diseño visual» — curso de MUESTRA para la vista previa del diseño.
 *
 * Insumos completos de `buildDynamicMbzV3` para un curso sintético FIJO (1 módulo × 2 capítulos, actividad SCORM en el
 * capítulo 1, evaluación del módulo y evaluación final). Contenido determinístico copiado de los fixtures de R2/R11a
 * (`preview-content.json`), medios sintéticos (`package/v3/synthetic-media`), sin IA, sin red, sin base de datos.
 *
 * La vista previa empaqueta ESTE curso con el perfil de presentación elegido usando el MISMO builder que el empaque real:
 * lo que se muestra es la salida real del empaque (mismos renderers, mismas plantillas, mismos tokens del tema).
 */
import { buildBlueprintSnapshotV2, snapshotSha256V2 } from '../course-blueprints/blueprint-snapshot';
import { buildGenerationManifestV3 } from '../generation-manifests/generation-manifest-builder';
import { defaultAssessmentProfile } from '../course-profiles/course-profiles';
import type { PresentationProfileInput } from '../theme-engine';
import { syntheticCoverPng, syntheticMp3, syntheticPdf } from '../../package/v3/synthetic-media';
import type { BuildDynamicMbzV3Input } from '../../package/dynamic-mbz-builder-v3';
import * as CONTENT from './preview-content.json';

export const PREVIEW_COURSE_ID = 760001;
export const PREVIEW_COURSE_TITLE = 'Curso de muestra: Atención al cliente';
export const PREVIEW_TS = 1790500000;
export const PREVIEW_MODULE_TITLE = 'Bases del servicio';
export const PREVIEW_CHAPTER_TITLES = ['Fundamentos de la atención al cliente', 'Escucha y empatía'] as const;

const uuid = (prefix: string, n: number) => `00000000-0000-4000-8000-${prefix}${String(n).padStart(12 - prefix.length, '0')}`;

function contentMd(n: number, title: string): string {
  return [
    `# Capítulo ${n}: ${title}`,
    '',
    `Este capítulo desarrolla **${title.toLowerCase()}** con ejemplos del servicio diario.`,
    '',
    '## Ideas clave',
    '',
    '- Escuchar antes de responder.',
    '- Confirmar lo entendido con palabras propias.',
    '- Cerrar con un próximo paso claro.',
    '',
    '| Situación | Respuesta recomendada |',
    '|---|---|',
    '| Cliente molesto | Reconocer la emoción y ofrecer una salida |',
    '| Consulta técnica | Explicar sin tecnicismos |',
    '',
    '> Una respuesta clara ahorra tres consultas posteriores.',
  ].join('\n');
}

const SCORM_MANIFEST = (n: number) => `<?xml version="1.0" encoding="UTF-8"?>
<manifest identifier="cap${n}_juego" version="1.2" xmlns="http://www.imsproject.org/xsd/imscp_rootv1p1p2" xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_rootv1p2">
  <metadata><schema>ADL SCORM</schema><schemaversion>1.2</schemaversion></metadata>
  <organizations default="cap${n}_org"><organization identifier="cap${n}_org"><title>Práctica del capítulo</title><item identifier="item_1" identifierref="resource_1"><title>Práctica</title></item></organization></organizations>
  <resources><resource identifier="resource_1" type="webcontent" adlcp:scormtype="sco" href="index.html"><file href="index.html"/></resource></resources>
</manifest>`;
const SCORM_HTML = '<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><title>Práctica</title></head><body><h1>Práctica</h1><p>Actividad de práctica (muestra).</p></body></html>';

function moduleGift(moduleNumber: number): string {
  const mc = Array.from({ length: 6 }, (_, i) =>
    `::M${moduleNumber}P${i + 1}:: ¿Qué conducta mejora la atención en el caso ${String.fromCharCode(65 + i)}? {\n=Escuchar y confirmar\n~Interrumpir\n~Derivar sin explicar\n}`,
  );
  mc.push(`::M${moduleNumber}VF:: Confirmar lo entendido reduce malentendidos. {TRUE}`);
  return mc.join('\n\n');
}
const FINAL_GIFT = Array.from({ length: 12 }, (_, i) =>
  `::P${i + 1}:: ¿Qué práctica mejora la atención al cliente en la situación ${String.fromCharCode(65 + i)}? {\n=Escuchar y confirmar lo entendido\n~Responder sin escuchar\n~Derivar sin explicar\n}`,
).join('\n\n');

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

/**
 * Insumos del curso de muestra con el tema y la marca dados. `libroBrand` = la marca YA resuelta del curso real
 * (applyPresentationIdentity): la vista previa usa el mismo logo, nombre y marca de agua que usará el empaque.
 */
export function previewPackagingInput(presentation: PresentationProfileInput, libroBrand: BuildDynamicMbzV3Input['libroBrand'] = null): BuildDynamicMbzV3Input {
  const courseId = PREVIEW_COURSE_ID;
  const mid = uuid('a', courseId * 10 + 1);
  const mrows = [{ id: mid, position: 0, title: PREVIEW_MODULE_TITLE, objective: null, exam_enabled: true }];
  const crows = PREVIEW_CHAPTER_TITLES.map((title, k) => ({
    id: uuid('c', courseId * 100 + k + 1),
    module_id: mid,
    position: k,
    title,
    objective: null,
    video_enabled: false,
    activity_enabled: k === 0,
  }));
  const snapshot = buildBlueprintSnapshotV2({ id: courseId, title: PREVIEW_COURSE_TITLE, finalExam: true, activityEngine: 'scorm' } as any, mrows as any, crows as any);
  const source = { courseId, blueprintId: courseId + 7000, blueprintNumber: 1, blueprintSha256: snapshotSha256V2(snapshot) };
  const manifest = buildGenerationManifestV3(snapshot, source as any);
  const chapters = manifest.modules.flatMap((m: any) => m.chapters);
  const presentations = new Map<string, { pdf: Buffer; cover: Buffer }>();
  const audiobookChapters = new Map<string, Buffer>();
  const contentMdMap = new Map<string, string>();
  const activities = new Map<string, any>();
  const experiences = new Map<string, unknown>();
  chapters.forEach((c: any, i: number) => {
    presentations.set(c.chapterId, { pdf: syntheticPdf(8 + i), cover: syntheticCoverPng(1600, 900, ['#2F5D8A', '#3A7D44'][i % 2]) });
    audiobookChapters.set(c.chapterId, syntheticMp3(150 + 17 * i));
    contentMdMap.set(c.chapterId, contentMd(c.chapterNumber, PREVIEW_CHAPTER_TITLES[i]));
    experiences.set(c.chapterId, { ...clone((CONTENT as any).experience), chapterId: c.chapterId });
    if (c.activityEnabled) activities.set(c.chapterId, { variant: 'scorm', html: SCORM_HTML, manifestXml: SCORM_MANIFEST(c.chapterNumber) });
  });
  const m0 = manifest.modules[0];
  const moduleIntros = new Map<string, unknown>([[
    m0.moduleId,
    {
      schemaVersion: 1,
      presentation:
        'En esta etapa vas a trabajar las bases que sostienen una buena experiencia de servicio. ' +
        'Partimos de cómo se forma la percepción del cliente y avanzamos hacia las conductas que la mejoran, con ejemplos del día a día y preguntas para tu propia práctica profesional.',
      outcomes: [
        'Reconocer los momentos que definen la experiencia del cliente.',
        'Aplicar técnicas de escucha en conversaciones reales.',
        'Ordenar una respuesta clara ante una consulta compleja.',
      ],
      journey: m0.chapters.map((c: any) => ({ chapterId: c.chapterId, line: 'Un paso más en la forma de acompañar al cliente con criterio y calidez.' })),
      bibliography: [
        { author: 'Hattie, John', title: 'Visible Learning: A Synthesis of Over 800 Meta-Analyses Relating to Achievement', year: 2009, publisher: 'Routledge' },
        { author: 'Wiliam, Dylan', title: 'Embedded Formative Assessment', year: 2011, publisher: 'Solution Tree Press' },
      ],
    },
  ]]);
  return {
    manifest,
    blueprint: snapshot,
    manifestId: 9001,
    assessmentProfile: defaultAssessmentProfile({ finalExam: true }),
    presentation,
    ts: PREVIEW_TS,
    libroBrand,
    contents: {
      courseIntro: clone((CONTENT as any).courseIntro),
      moduleIntros,
      contentMd: contentMdMap,
      experiences,
      presentations,
      videos: new Map(),
      videoInteractions: new Map(),
      activities,
      examGift: new Map([[m0.moduleId, moduleGift(1)]]),
      finalExamGift: FINAL_GIFT,
      audioWelcome: syntheticMp3(58.2),
      audiobookChapters,
    },
  } as BuildDynamicMbzV3Input;
}
