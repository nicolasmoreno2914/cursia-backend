/**
 * dynamic-mbz-builder-v3.ts — Cursia V2.1 R12: `.mbz` de Moodle para
 * Manifests rulesVersion 3 (audit §E, §F, §K, §Q; brief R12).
 *
 * Consume, nunca genera: todos los contenidos (JSON/markdown del LLM, PDF/PNG
 * de Gamma, MP3 de TTS, video de Videogen/YouTube, GIFT) entran ya resueltos
 * por parámetro. Las piezas vienen de los bloques anteriores:
 *   R1 tema · R2 Visual Components · R6 evaluación → XML · R7 H5P content-only ·
 *   R8 video interactivo · R9 tarjeta de presentación · R10 audio · R11a facts,
 *   shell y ensamblador de capítulo.
 *
 * Reglas:
 *  - PURO y DETERMINÍSTICO: sin I/O, sin reloj (el `ts` se inyecta), sin azar.
 *    Mismos insumos → mismos bytes (entradas del zip con fecha fija, orden fijo,
 *    ids por asignador monotónico, stamps derivados).
 *  - FALLA FUERTE: un contenido faltante, un número que no sale de facts, un
 *    label que no pasa CLEAN_SAFE, un H5P no calificable en Moodle, una
 *    categoría ponderada vacía o un token `$@…$` mal tipado abortan el paquete.
 *  - Todo número visible sale de `buildCourseFacts` con datos MEDIDOS
 *    (páginas del PDF, duración de los MP3, preguntas del GIFT, palabras del Libro).
 *  - Estructura por UUID: cada módulo del curso lleva `idnumber` = `cv3:…`
 *    derivado del item_key del Manifest (trazable tras restaurar).
 *  - v1/v2 no cambian: este archivo es independiente de `dynamic-mbz-builder.ts`.
 */
import * as JSZip from 'jszip';
import {
  MoodleVersionInfo,
  esc,
  forumXml,
  gradesXml,
  inforefXml,
  labelXmlWithCtx,
  moduleXml,
  parseGIFT,
  resolveMoodleVersion,
  safeActivityName,
  sectionXml,
  sha1Buf,
  xmlEsc,
} from './mbz-common';
import {
  ResolvedAssessment,
  applyXmlFields,
  assertCategoriesPopulated,
  assessmentItemCountsForPackage,
  completionCriteriaFor,
  courseCompletionXml,
  gradeItemXml,
  gradebookXml,
  gradedModuleXml,
  h5pactivityXml,
  resolveAssessment,
} from './assessment';
import type { AssessmentCategoryKey, CompletionCandidate } from './assessment/resolve-assessment';
import {
  CURSIA_H5P_PROFILE_V1,
  CURSIA_H5P_PROFILE_V3,
  H5P_MOODLE_GRADING,
  H5P_PACKAGE_MIMETYPE,
  H5pBuiltContent,
  assertH5pGradableInMoodle,
  buildBlanks,
  buildBranchingScenario,
  buildContentOnlyH5p,
  buildDialogCardsFromExperience,
  validateBranchingScenarioInput,
  buildDragText,
  buildQuestionSet,
  buildVideoActivity,
  h5pProfileVersion,
  h5pTitle,
  validateBlanksInput,
  validateDragTextInput,
  validateQuestionSetInput,
  videoInlineIntroHtml,
  videoPackageFilename,
} from './h5p';
import { assembleAudiobook, mp3DurationSeconds } from './audio';
import { pdfPageCount, presentationCardHtml } from './presentation';
import type { GenerationManifestV1 } from '../modules/generation-manifests/generation-manifest-builder';
import type { BlueprintSnapshotV2 } from '../modules/course-blueprints/blueprint-snapshot';
import type { AssessableType, AssessmentProfile } from '../modules/course-profiles/course-profiles';
import {
  PresentationProfileInput,
  ResolvedTheme,
  THEME_ENGINE_VERSION,
  moduleColor,
  resolveTheme,
  themeSha256,
  validateTheme,
} from '../modules/theme-engine';
import { ChapterExperience, VC_RENDER_STYLE_VERSION, VC_RUNTIME_VERSION, VC_SCHEMA_VERSION, internalVocabularyExemptions, protectedVocabularyTexts, repairInternalVocabularyDeep, formulaicOpeningWarnings } from '../modules/visual-components';
import {
  CTA_BADGES,
  CourseFacts,
  CourseIntroV3,
  ModuleIntroV3,
  SHELL_AUDIOBOOK_FILE,
  SHELL_AUDIO_WELCOME_FILE,
  ShellLabel,
  assembleAllChapters,
  assertValidCourseIntroV3,
  assertValidModuleIntroV3,
  audioWelcomeLabel,
  audiobookLabel,
  buildCourseFacts,
  CertificateRequirements,
  certificateTeacherLabel,
  courseApprovalRequirements,
  closingLabel,
  competenciesLabel,
  examExplanationsBankPage,
  examExplanationsGiftPage,
  examInfoLabel,
  examsTeacherLabel,
  experienceMovementWords,
  finalExamInfoLabel,
  finalExamNextLabel,
  libroResourceIntro,
  methodologyLabel,
  moduleIntroLabel,
  moduleNextLabel,
  pendingVideoNoticeChapterIds,
  routeLabel,
  routeStartLabel,
  sectionLayoutFromFacts,
  validateH5pActivityPayload,
  welcomeLabel,
  welcomeStartLabel,
  shellProseByLabel,
  activityEmbedsInline,
} from '../modules/course-shell';
import type { H5pActivityTypeV2 } from '../modules/course-shell';
import { TEACHER_GUIDE_IDNUMBER, teacherGuidePage } from '../modules/course-shell/teacher-guide-page';
import { PackagingPlanV3, buildPackagingPlanV3, packagingPlanV3Sha256 } from '../modules/dynamic-packaging/packaging-plan-v3';
import { LIBRO_PDF_MIMETYPE, libroPdfFilename, renderLibroPdfV3 } from './v3/libro-v3';
import { LibroLogoCandidate, cursiaDefaultLogo, resolveLibroLogo } from './v3/libro-logo';
import { downscaleCoverPng } from './v3/png-downscale';
import { ActivityFrameTone, activityPackageFilename, h5pActivityInlineIntroHtml, introThemeFrom, reviewCardsIntroHtml, scormIntroHtml } from './v3/activity-intro';
import { moduleTone } from '../modules/visual-components/edu';
import { groundColor } from '../modules/visual-components/render';
import { IdAllocator, buildQuizV3, parseScormManifestIds, scormActivityXmlV3 } from './v3/moodle-activities-v3';
import { expectedExamPlan, planSlotCount, validateExamBank } from '../modules/course-shell/exam-bank';
import type { ExamBankV1 } from '../modules/course-shell/exam-bank';
import { examExplanationsAvailability, examOverallFeedbackBands } from '../modules/course-shell/exam-explanations';
import type { ExamBankPlans } from './v3/exam-validator-v3';
import { reviewCardsEnabledFor } from '../modules/study-time/manifest-input';
import { ApplicationDeliveryText, applicationSolutionPage, applicationStudentPage, practiceResourceIntro, practiceResourceName } from '../modules/course-shell/application-pages';
import { deliveryMegabytes } from '../modules/course-shell/facts';
import { repairDeadAnchorsInActivityXml } from './v3/dead-links-v3';
import { ASSIGN_PLUGIN_CONFIG_COUNT, assignActivityXml, assignDueDate, assignGradeItemXml, assignRubricGradingXml, rubricCriteriaFromApplication } from './v3/assign-v3';
import { resolvePracticeFiles } from './v3/practice-files';
import { guidedPracticeLibroMarkdown, guidedPracticePage } from '../modules/course-shell/guided-practice-page';
import { validateGuidedPracticeDoc } from '../modules/course-shell/guided-practice';
import { renderApplicationPdf } from './v3/application-pdf';
import { videoMcLengthBiasWarnings } from '../modules/quality/answer-length-bias';
import { COURSE_BADGE_BACKUP_ID, COURSE_BADGE_DEFAULT_ISSUER, courseBadgeImages, courseBadgeName, courseBadgeXml } from './v3/course-badge';

/**
 * Id del curso DENTRO del backup (`<course id>`, `original_course_id`) y su contexto
 * (`original_course_contextid`). La restauración los remapea al curso nuevo: el token
 * $@BADGESVIEWBYID*1@$ (decode rule 'course') y el criterio `course_1` de la insignia.
 * EV6 T3: el contexto del curso NO puede ser 1 = `original_system_contextid`: la restauración
 * mapea el contexto viejo 1 al de SISTEMA y los archivos del curso (la imagen de la insignia,
 * `badges/badgeimage`) terminaban en el contexto de sistema (probado en el Moodle local).
 */
export const MBZ_V3_COURSE_BACKUP_ID = 1;
export const MBZ_V3_COURSE_BACKUP_CONTEXTID = 2;
export const MBZ_V3_SYSTEM_BACKUP_CONTEXTID = 1;

/**
 * Versión del builder v3. Entra en la clave de reuse v3 (y SOLO en la v3:
 * `DYNAMIC_MBZ_BUILDER_VERSION` de v1/v2 no cambia, así sus paquetes y claves
 * siguen idénticos).
 *
 * REGLA (review G6 M9): TODO cambio que altere el `.mbz` para los mismos
 * insumos — plantillas del shell/capítulo (R11a), tarjeta (R9), intros de
 * actividad, Libro v3, XML — exige subir esta versión; si no, el reuse sirve
 * paquetes viejos. Hoy `hours` no se cablea desde el worker (no hay dato de
 * setup en el backend); el día que se cablee debe entrar en la clave de reuse.
 * 3.0.1 (fix round 1 G6): Libro sin links inseguros (M2).
 * 3.0.2 (F1/I3): categorías vacías fuera del gradebook, pesos normalizados y
 * curso sin nota (completion por vista del Libro Guía).
 * 3.0.3 (aceptación staging): tarjetas con borde completo en vez de franja lateral
 * (shell, tarjeta, intros, Libro) y sin reintento dentro del intento en IV/QuestionSet (HD-V21-22).
 * 3.0.4 (R14): bibliografía verificada del Libro (verified-bibliography.ts) y normalización de
 * comparaciones con la columna del rótulo (render.ts, #28) — un paquete anterior no se reutiliza.
 * 3.1.0 (EV6): una sección por capítulo / evaluación / examen final / cierre (cierre DESPUÉS del
 * examen final), `coursedisplay` = 1 (una sección por página) y botones de navegación entre
 * secciones («Comenzar el curso →», «Continuar con el capítulo N →», …).
 * 3.2.0 (EV6 T3): certificado nativo = insignia de curso (badges.xml + imagen f1/f2/f3,
 * setting `badges` = 1), la evaluación final SIEMPRE es criterio de completion y el cierre
 * trae el panel «Tu certificado» con el enlace $@BADGESVIEWBYID*1@$; fix 0b: label oculto
 * (visible=0) para docentes en el cierre con el paso «Habilitar acceso» de la insignia.
 * 3.3.0 (EV6 P2-B1): política de revisión del quiz (solo nota hasta el cierre) y
 * `completionattemptsexhausted`.
 * 3.4.0 (EV6 P2-B3): exámenes con banco `dynamic_exam_bank_json` → categorías por capítulo|módulo ×
 * tipo y slots aleatorios (`question_set_reference`), retroalimentación por opción + general;
 * emparejamiento del banco = definición como subpregunta y término como opción (fix 1). Los
 * paquetes con exámenes GIFT quedan byte a byte iguales a 3.3.0 (el bump invalida solo el reuse).
 * 3.5.0 (P3, sistema visual educativo 2.0): labels con rótulo/forma/color por rol pedagógico, apertura
 * «Capítulo N de T · ~X min» (minutos en facts desde las palabras medidas del experience), riel
 * «Dónde estás» del módulo y la actividad H5P/SCORM enmarcada con el tono del módulo.
 * 3.6.0 (EV6 P2-B4): página «Respuestas explicadas» (mod_page) después de cada evaluación, visible
 * solo al aprobar o agotar los intentos (availability e=1 | e=3, show:false, downloadcontent 0);
 * la info del examen la anuncia; nota para docentes (acceso condicional, intentos adicionales) en el
 * label oculto del certificado o en `cv3:shell:exams_teacher` al inicio de la primera evaluación.
 * 3.7.0 (V542 I4): `reviewattempt` = D|I|O|C — al terminar un intento el estudiante revisa sus
 * respuestas y su nota (sin corrección, feedback ni respuesta correcta antes del cierre) en vez de
 * rebotar con «No tiene permiso para revisar este cuestionario».
 * 3.8.0 (V542 I2): cada actividad H5P (video, práctica, caso, «Repaso») guarda su .h5p UNA vez
 * (filearea `package`); el embed inline del intro carga ese mismo archivo → un solo contenido y un
 * solo estado (sin «Data Reset» al pasar entre el capítulo y la página de la actividad). Un paquete
 * sin actividades H5P queda byte a byte igual a 3.7.0.
 * 3.9.0 (V542 fix round 1, I1): revisión del quiz D|I|C y notas O|C — la página de revisión al terminar
 * muestra las respuestas propias SIN nota por pregunta (la nota por pregunta revelaba la correcta de una
 * V/F); la nota total se ve en view.php (más tarde, abierto) y en el libro de calificaciones.
 * 3.10.0 (QUIZFB, re-verificación #542 R1): retroalimentación GLOBAL del quiz visible al terminar el intento
 * (reviewoverallfeedback I|O|C, bandas «aprobaste» / «todavía no» con la nota mínima del perfil) y la línea de la
 * info del examen promete exactamente eso («verás si aprobaste; tu calificación queda en Calificaciones»).
 * 3.11.0 (#583 QUAL): el caso ramificado lleva una imagen de final por calidad (óptimo verde, aceptable ámbar,
 * malo rojo; antes el «pare» rojo por defecto en todo final); el DragText empaqueta sus `distractors`; la nota
 * máxima por pregunta del quiz ya no se muestra durante el intento ni al terminarlo (reviewmaxmarks O|C, sin
 * «Puntúa como 5,88»); la tarjeta del Libro Guía es la descripción del recurso (una sola entrada en la sección 1);
 * el cierre ya no afirma que el estudiante completó el curso; pasos con mayúscula inicial y la esquina de la tabla
 * de comparación sin «Aspecto» (renderer style 3, runtime 4).
 * 3.12.0 (UX r18): la sección 0 abre con el hero de bienvenida (sin el kicker «Bienvenida» repetido) y el foro
 * de avisos va al final (ids de la sección 0 renumerados); `<audio preload="metadata">`; el audiolibro
 * concatenado lleva un frame Info con el conteo real de frames; portada a 1600 px (antes 640, PNG con filtro
 * adaptativo); sin botón «Iniciar actividad» cuando la actividad H5P va embebida debajo (SCORM lo conserva).
 * 3.12.0 (UX #5, r18): la actividad QuestionSet usa H5P.QuestionSet 1.21 (CURSIA_H5P_PROFILE_V3) con su librería
 * incluida en el .h5p (delta H5P.QuestionSet-1.21) y los rótulos «Siguiente» / «Anterior» de su navegación: en 1.20
 * el botón «Pregunta siguiente/anterior» salía como un CTA azul vacío junto a «Comprobar». Un paquete con QuestionSet
 * pide restaurar como administrador o gestor (summary.restore), igual que BS / «Repaso».
 * 3.13.0 (r19 L, Libro Guía): el Libro Guía es un PDF REAL (pdfkit, `libro_guia_<slug>.pdf`, application/pdf; único
 * archivo del recurso, sin copia HTML) con portada, índice con páginas, encabezado y pie «Página X de Y», y UNA marca de
 * agua por página (logo de la cuenta → logo de Cursia; un logo inválido cae a Cursia con aviso `libro_logo_invalid:…`);
 * la descripción del recurso lleva el botón «Abrir Libro Guía →» hacia su propio `$@RESOURCEVIEWBYID*mid@$` en una
 * pestaña nueva (`target="_blank"`, display 5 = view.php entrega el PDF). El logo y la marca entran en la clave de reuse.
 * 3.13.0 (r19 W, bienvenida, mismo número de versión): el label de bienvenida se compone como pantalla de entrada — superficie del hero
 * según `heroTreatment` de la familia (band / rule / plate), línea «Curso · N módulos · M capítulos» (facts),
 * título, filete, entrada de ≤ 40 palabras / 240 caracteres y el resto de `course_intro.welcome` a tamaño de cuerpo
 * en párrafos de ≤ 70 palabras, antes de la fila de cifras (antes: todo el texto en UN párrafo a tamaño de entrada).
 * Mismo texto, sin esquema nuevo ni llamadas LLM. El divisor de oraciones (compartido con la presentación del
 * módulo) ya no descarta el texto previo a un punto sin espacio («1.5») ni corta en abreviaturas.
 * Loop 9 B · ejercicios guiados (componente `guided_practice`; la versión sigue en 3.13.0 porque un paquete SIN ejercicios
 * guiados es byte a byte el de siempre, y uno CON ellos solo sale de un Manifest nuevo, con otra clave de reuse): el
 * capítulo de contenido con ejercicios guiados lleva la página «Ejercicios guiados — <capítulo>» (`cv3:ch:<id>:guided_practice`,
 * visible, completion por vista) después de la síntesis y antes de la actividad, y los mismos ejercicios al final del
 * capítulo en el Libro Guía (sin sumar palabras al Libro).
 * 3.14.0 (r55, invariantes de calificación — se calcula TODO al empaquetar, sin regenerar contenido): el curso se
 * aprueba SOLO por la nota final — completion.xml con UN criterio de nota del curso (tipo 6, gradepass = nota mínima
 * del curso = gradepass del ítem del curso) y ningún criterio de actividad; cada ítem calificable se completa al
 * recibir nota (completionpassgrade 0, su gradepass queda informativo); quiz con completionminattempts = intentos y
 * completionattemptsexhausted 0, y «Respuestas explicadas» abre solo al usar todos los intentos (oculta con intentos
 * ilimitados); textos del cierre, certificado, insignia, notas para docentes y evaluaciones con la regla real
 * («calificación final ≥ X/100…»); todos los .h5p solo contenido (QuestionSet 1.21, caso ramificado y «Repaso» sin
 * carpetas de librería: requisito del sitio = pack v3, summary.restore `site_library_pack`).
 * 3.15.0 (T1 r57, defectos de contenido repetibles — sin regenerar contenido): vocabulario interno del generador
 * reparado antes de renderizar («worked_example» → «ejemplo resuelto», «texto fuente» → «Libro Guía», «[S12]» fuera;
 * check INTERNAL_VOCABULARY del validador); «Tu recorrido» derivado de los slots reales; el puente que repite un
 * bloque del cierre se omite; rótulos why/apply con variación determinística; Libro Guía: mapas con ASCII de una
 * columna (LIBRO_V3_GLYPHS si queda algo sin glifo), listas sueltas numeradas 1..n, portada/índice/tarjeta con los
 * capítulos reales (práctica incluida) y «Referencias» desde fuentes estructuradas; summary.qualityWarnings
 * (aperturas repetidas entre capítulos, sesgo de longitud de las MC de los videos). Un paquete sin esos casos es
 * byte a byte el de 3.14.0 (los dorados no cambian).
 * T4/T5 (r57, misma versión 3.15.0): Actividad de Aplicación como Tarea (mod_assign: entrega, completion al enviar,
 * comentarios, nota en su categoría + rúbrica gradingform_rubric, o formativa sin nota) y archivos de trabajo (mod_resource
 * enlazados desde la AA), ambos desde claves OPCIONALES del perfil de evaluación (`applicationDelivery`,
 * `practiceResources`). Sin esas claves el paquete es byte a byte el de antes (dorado scripts/fixtures/deliverables); con
 * ellas cambia el sha del perfil y, con él, la clave de reuse — no hace falta subir la versión.
 */
export const DYNAMIC_MBZ_BUILDER_VERSION_V3 = '3.15.0';

// EV6 P2-B5: `examExplanationsAvailability` vive en course-shell/exam-explanations (lo usa también el validador).
export { examExplanationsAvailability } from '../modules/course-shell/exam-explanations';
/** Versión del renderer de Visual Components que entra en la clave de reuse. */
export const VC_RENDERER_VERSION = `vc${VC_SCHEMA_VERSION}-rt${VC_RUNTIME_VERSION}-theme${THEME_ENGINE_VERSION}-style${VC_RENDER_STYLE_VERSION}`;

/** Fecha fija de toda entrada del zip (UTC). */
export const MBZ_V3_ZIP_FIXED_DATE = new Date(Date.UTC(2026, 0, 1, 0, 0, 0));

// ─── Entradas ──────────────────────────────────────────────────────────────

export type ActivityContentV3 =
  | { variant: 'h5p'; payload: unknown }
  | { variant: 'scorm'; html: string; manifestXml: string };

export interface DynamicPackageContentsV3 {
  courseIntro: unknown;
  moduleIntros: Map<string, unknown>;
  contentMd: Map<string, string>;
  experiences: Map<string, unknown>;
  /** chapterId → bytes del PDF y de la portada (reales, o sintéticos si el run es mock). */
  presentations: Map<string, { pdf: Buffer; cover: Buffer; mock?: boolean }>;
  /** chapterId → video publicado (YouTube) con su duración MEDIDA. */
  videos: Map<string, { youtubeId: string; durationSec: number }>;
  videoInteractions: Map<string, unknown>;
  activities: Map<string, ActivityContentV3>;
  examGift: Map<string, string>;
  finalExamGift?: string | null;
  /**
   * EV6 P2: exámenes cuyo artifact es el banco `dynamic_exam_bank_json` (moduleId → banco).
   * P2-B3: se empaquetan como quiz de slots aleatorios por hoja (capítulo|módulo × tipo); un
   * módulo trae GIFT o banco, nunca ambos. El builder re-valida cada banco (plan congelado +
   * evidencia contra `contentMd`) y falla fuerte con EXAM_BANK_INVALID.
   */
  examBanks?: Map<string, ExamBankV1>;
  finalExamBank?: ExamBankV1 | null;
  audioWelcome: Buffer;
  audiobookChapters: Map<string, Buffer>;
  /**
   * r19: chapterId → manifiesto del audiolibro del capítulo (null = audio sin manifiesto, curso existente).
   * Con el mapa, `assembleAudiobook` aplica el piso de 25 min (AUDIOBOOK_TOO_SHORT_FOR_SOURCE); sin él, no.
   */
  audiobookManifests?: Map<string, any> | null;
  /**
   * Fase 2: chapterId → documento `dynamic_application_json` validado (actividad + solucionario). Solo con
   * Actividades de Aplicación: cada una se empaqueta como página del estudiante + solucionario docente oculto.
   */
  applications?: Map<string, unknown>;
  /**
   * Loop 9 B: chapterId → documento `dynamic_guided_practice_json` validado. Solo en los capítulos con ejercicios guiados:
   * cada documento se empaqueta como página visible del capítulo y al final del capítulo en el Libro Guía.
   */
  guidedPractices?: Map<string, unknown>;
  /**
   * T5 (r57): resourceId → bytes de los archivos de trabajo SUBIDOS (artifact `practice_file`) del perfil de evaluación.
   * Los generados desde una tabla (CSV/XLSX) los produce el builder. Ausente = ninguno subido.
   */
  practiceFiles?: Map<string, Buffer>;
}

export interface BuildDynamicMbzV3Input {
  manifest: GenerationManifestV1;
  blueprint: BlueprintSnapshotV2;
  manifestId?: number | null;
  /** Perfil de evaluación VIGENTE (course_profiles o default). */
  assessmentProfile: AssessmentProfile;
  /** Perfil de presentación resuelto (course_profiles, fallback legacy o default v3). */
  presentation: PresentationProfileInput;
  contents: DynamicPackageContentsV3;
  /** Reloj inyectado (segundos UNIX): el builder nunca lee el reloj. */
  ts: number;
  moodleVersion?: string;
  /** Horas del setup (se muestran etiquetadas como definidas por la institución). */
  hours?: number | null;
  /** Nivel de render de los labels (default ENHANCED sobre la base CLEAN_SAFE). */
  level?: 'enhanced' | 'clean_safe';
  /**
   * EV6 T5: capítulos cuyo video todavía es de vista previa. Su video (y sus interacciones) se
   * omiten del paquete; nunca se presenta un video simulado como real.
   */
  pendingVideoChapterIds?: readonly string[] | null;
  /**
   * EV6 DoD (BE-A): paquete de QA (run de vista previa o §2.6 degradado), NUNCA entregable. Aviso
   * visible al inicio de la bienvenida y sufijo «[QA — vista previa, no entregable]» en el nombre
   * del curso. Ausente/false → bytes idénticos a los de antes.
   */
  qaPreviewNotice?: boolean;
  /**
   * r19 (L3): marca del Libro Guía en PDF — logo candidato de la cuenta (sin validar: el builder lo valida y cae al logo de
   * Cursia con aviso) y nombre de la institución para la portada y el pie. Ausente → logo de Cursia, sin nombre.
   */
  libroBrand?: { logo?: LibroLogoCandidate | ReadonlyArray<LibroLogoCandidate> | null; name?: string | null } | null;
  /**
   * T1 (r57): bibliografía del programa académico de la institución (textos extraídos de SU documento, con fuente) →
   * «Referencias» del Libro Guía, tal cual. Ausente/vacía → sin esa subsección (nunca se inventa una referencia).
   */
  libroReferences?: ReadonlyArray<string> | null;
}

/** EV6 DoD: sufijo del nombre del curso de un paquete de QA. */
export const QA_PREVIEW_COURSE_SUFFIX = ' [QA — vista previa, no entregable]';

export interface MbzV3H5pPackage {
  itemKey: string;
  filename: string;
  mainLibrary: string;
  sha1: string;
  bytes: number;
}

export interface MbzV3Expectations {
  facts: CourseFacts;
  resolved: ResolvedAssessment;
  h5pProfileVersion: number;
  /** EV6 P2-B5: hojas (categoría, tipo, slots) de cada quiz con banco, del plan congelado → QUIZ_RANDOM. */
  examBankPlans: ExamBankPlans;
  /**
   * V542 fix round 3 (N1): prosa LLM de CADA label del shell, por idnumber (shellProseByLabel): sus cifras de
   * contenido se admiten SOLO en ese label; el resto es plantilla estricta.
   */
  shellProseByLabel: Record<string, string[]>;
  /** UX r18 fix 1 (M4): versión del builder que armó el paquete (las reglas nuevas del validador dependen de ella). */
  builderVersion: string;
  /** T1 (r57): reglas de vocabulario interno exentas porque el contenido del curso las usa como vocabulario del tema. */
  internalVocabularyExempt: string[];
  /**
   * Review r1 (I2): fragmentos escritos por una PERSONA (títulos del Blueprint, archivos de práctica, perfil,
   * referencias importadas) que contienen un término interno: el validador los quita antes de buscar (nunca bloquean).
   * Solo presente si hay alguno.
   */
  internalVocabularyUserTexts?: string[];
  /**
   * Review r2 (I3): fragmentos GENERADOS que quedaron sin reparar porque la reparación pasaba el límite de largo del
   * campo (aviso `internal_vocabulary_kept_length_limit`). Se exentan por fragmento (no la regla en todo el curso).
   * Solo presente si hay alguno.
   */
  internalVocabularyKeptTexts?: string[];
}

export interface BuildDynamicMbzV3Result {
  mbz: Buffer;
  expectations: MbzV3Expectations;
  summary: {
    builderVersion: string;
    moodleVersion: string;
    planSha256: string;
    themeSha256: string;
    themeFamily: string;
    themeMode: string;
    h5pProfileVersion: number;
    vcRendererVersion: string;
    h5pPackages: MbzV3H5pPackage[];
    mockPresentationChapters: string[];
    /** EV6 T5: videos omitidos por estar pendientes (vista previa) y si el capítulo lleva el aviso. */
    pendingVideos: Array<{ itemKey: string; chapterId: string; chapterNumber: number; title: string; notice: boolean }>;
    warnings: string[];
    /**
     * T1 (r57): avisos de CALIDAD del contenido (no operativos; nunca fallan el empaque), p. ej.
     * `formulaic_opening:reflection:piensa_en:11/15` — la misma apertura en muchos capítulos.
     */
    qualityWarnings: string[];
    counts: CourseFacts['counts'];
    /** F1 (I3): resultado de la normalización de pesos (ver `assessmentPackageSummary`). */
    assessment: AssessmentPackageSummary;
    /** EV6 H5P v2: solo si el paquete lleva librerías H5P incluidas (restaurar como administrador o gestor). */
    /** r55: `site_library_pack` (≥ 3.14.0); `admin_or_manager` solo en paquetes ≤ 3.13.0. */
    restore?: { as: 'site_library_pack'; libraryPack: 'v3'; note: string } | { as: 'admin_or_manager'; note: string };
    /** r19 (L): Libro Guía en PDF — archivo, páginas y el logo usado como marca de agua. */
    libro: { filename: string; pageCount: number; wordCount: number; logoSource: string; logoSha256: string };
    /** T4 (r57): Actividades de Aplicación entregadas como Tarea (solo si hay alguna). */
    applicationAssigns?: { count: number; graded: number; rubric: number; category: string | null };
    /** T5 (r57): archivos de trabajo publicados (solo si hay alguno): id, capítulo, archivo, sha256, bytes y origen. */
    practiceResources?: Array<{ id: string; chapterId: string; filename: string; mimetype: string; sha256: string; bytes: number; origin: string; relation: string }>;
  };
}

/** F1 (I3): lo que el resumen del paquete registra de la evaluación resuelta. */
export interface AssessmentPackageSummary {
  weightsNormalized: boolean;
  originalWeights: Partial<Record<AssessmentCategoryKey, number>>;
  weights: Partial<Record<AssessmentCategoryKey, number>>;
  emptyCategories: AssessmentCategoryKey[];
  withoutGrades: boolean;
  /**
   * r55 review r1 (M1): nota mínima REAL del curso (gradepass del criterio único «Calificación del curso»);
   * null en un curso sin nota. «Curso listo» la muestra en vez de un genérico «por defecto 70/100».
   */
  coursePassingGrade: number | null;
}

/** F1 (I3): resumen de una evaluación resuelta CON `itemCounts` (falla si no lo fue). */
export function assessmentPackageSummary(resolved: ResolvedAssessment): AssessmentPackageSummary {
  if (typeof resolved.weightsNormalized !== 'boolean' || typeof resolved.withoutGrades !== 'boolean' || !resolved.originalWeights || !resolved.emptyCategories) {
    throw new Error('ASSESSMENT_INVALID_FACTS: la evaluación del paquete v3 debe resolverse con itemCounts');
  }
  const weights: Partial<Record<AssessmentCategoryKey, number>> = {};
  for (const c of resolved.categories) weights[c.key] = c.weight;
  return {
    weightsNormalized: resolved.weightsNormalized,
    originalWeights: { ...resolved.originalWeights },
    weights,
    emptyCategories: [...resolved.emptyCategories],
    withoutGrades: resolved.withoutGrades,
    coursePassingGrade: resolved.withoutGrades ? null : resolved.courseGradepass,
  };
}

/**
 * F1 (I3): avisos del paquete derivados de la evaluación resuelta:
 * `course_without_grades` y `assessment_weights_normalized:<orig>-><final>`.
 */
export function assessmentPackageWarnings(resolved: ResolvedAssessment): string[] {
  const s = assessmentPackageSummary(resolved);
  if (s.withoutGrades) return ['course_without_grades'];
  if (!s.weightsNormalized) return [];
  const fmt = (w: Partial<Record<AssessmentCategoryKey, number>>) =>
    (Object.keys(w) as AssessmentCategoryKey[]).map((k) => `${k}=${w[k]}`).join(',');
  return [`assessment_weights_normalized:${fmt(s.originalWeights)}->${fmt(s.weights)}`];
}

export class PackagingV3ContentMissingError extends Error {
  constructor(public readonly missing: string[]) {
    super(`PACKAGING_V3_CONTENT_MISSING: faltan ${missing.length} contenido(s): ${missing.join(', ')}`);
    this.name = 'PackagingV3ContentMissingError';
  }
}

// ─── ids fijos ─────────────────────────────────────────────────────────────

// T4 (r57): `applications` (id 5) solo existe en el gradebook si el perfil la pesa: los ids 2–4 no cambian.
const CAT_ID: Record<AssessmentCategoryKey, number> = { practice: 2, moduleExams: 3, finalExam: 4, applications: 5 };
const NULL = '$@NULL@$';
const EMPTY_SHA1 = 'da39a3ee5e6b4b0d3255bfef95601890afd80709';

const BOIL = {
  roles: '<?xml version="1.0" encoding="UTF-8"?>\n<roles>\n  <role_overrides>\n  </role_overrides>\n  <role_assignments>\n  </role_assignments>\n</roles>',
  calendar: '<?xml version="1.0" encoding="UTF-8"?>\n<events>\n</events>',
  gradeHistory: '<?xml version="1.0" encoding="UTF-8"?>\n<grade_history>\n  <grade_grades>\n  </grade_grades>\n</grade_history>',
  competencies: '<?xml version="1.0" encoding="UTF-8"?>\n<course_module_competencies>\n  <competencies>\n  </competencies>\n</course_module_competencies>',
  filters: '<?xml version="1.0" encoding="UTF-8"?>\n<filters>\n  <filter_actives>\n  </filter_actives>\n  <filter_configs>\n  </filter_configs>\n</filters>',
  completion: '<?xml version="1.0" encoding="UTF-8"?>\n<completions>\n  <completionviews>\n  </completionviews>\n</completions>',
  comments: '<?xml version="1.0" encoding="UTF-8"?>\n<comments>\n</comments>',
  xapistate: '<?xml version="1.0" encoding="UTF-8"?>\n<xapistate>\n</xapistate>',
  contentbank: '<?xml version="1.0" encoding="UTF-8"?>\n<contents>\n</contents>',
};

interface FileEntry {
  id: number;
  hash: string;
  ctx: number;
  component: string;
  filearea: string;
  filename: string;
  size: number;
  mime: string | null;
  /** itemid del archivo (0 salvo la imagen de la insignia: id de la insignia en el backup). */
  itemid?: number;
}

interface ActivityRef {
  mid: number;
  aid: number;
  ctx: number;
  secnum: number;
  modname: string;
  title: string;
  dir: string;
  idnumber: string;
}

/** Escritor del zip: fecha fija, sin carpetas implícitas, blobs deduplicados por sha1. */
class MbzWriter {
  readonly zip = new JSZip();
  readonly files: FileEntry[] = [];
  readonly activities: ActivityRef[] = [];
  readonly sectionSeq = new Map<number, number[]>();
  readonly modnameByMid = new Map<number, string>();
  private readonly blobs = new Set<string>();
  private fileId = 1;
  private mid = 1000;
  private aid = 1;
  private ctx = 100;
  private gradeItemId = 100;
  private gradeSort = 10;
  readonly idnumbers = new Set<string>();

  /** Review r1 (M9): enlaces muertos reparados por archivo (la última escritura de cada archivo cuenta). */
  readonly deadLinksUnwrapped = new Map<string, number>();

  constructor(readonly ts: number, readonly MV: MoodleVersionInfo) {}

  put(name: string, data: string | Buffer | Uint8Array): void {
    // Review r1 (M9): un enlace muerto (`href="#"`) en el HTML visible de una actividad se desenvuelve (queda el texto).
    if (typeof data === 'string' && /^activities\/[a-z0-9]+_\d+\/[a-z0-9]+\.xml$/.test(name) && !/\/(module|inforef|grades|roles|calendar|grade_history|competencies|filters|completion|comments|xapistate|grading)\.xml$/.test(name)) {
      const r = repairDeadAnchorsInActivityXml(data);
      if (r.count) this.deadLinksUnwrapped.set(name, r.count);
      else this.deadLinksUnwrapped.delete(name);
      data = r.xml;
    }
    this.zip.file(name, data, { date: MBZ_V3_ZIP_FIXED_DATE, createFolders: false });
  }

  blob(data: Buffer | string): { hash: string; size: number } {
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    const hash = sha1Buf(buf);
    if (!this.blobs.has(hash)) {
      this.put(`files/${hash.slice(0, 2)}/${hash}`, buf);
      this.blobs.add(hash);
    }
    return { hash, size: buf.length };
  }

  addFile(ctx: number, component: string, filearea: string, filename: string, data: Buffer | string, mime: string, itemid = 0): number {
    const { hash, size } = this.blob(data);
    const id = this.fileId++;
    this.files.push({ id, hash, ctx, component, filearea, filename, size, mime, ...(itemid ? { itemid } : {}) });
    return id;
  }

  addDirEntry(ctx: number, component: string, filearea: string): number {
    const id = this.fileId++;
    this.files.push({ id, hash: EMPTY_SHA1, ctx, component, filearea, filename: '.', size: 0, mime: null });
    return id;
  }

  newActivity(modname: string, secnum: number, title: string, idnumber: string): ActivityRef {
    if (!/^cv3:[A-Za-z0-9:_.#-]{1,96}$/.test(idnumber) || idnumber.length > 100) throw new Error(`MBZ_V3_IDNUMBER_INVALID: ${idnumber}`);
    if (this.idnumbers.has(idnumber)) throw new Error(`MBZ_V3_IDNUMBER_DUPLICATE: ${idnumber}`);
    this.idnumbers.add(idnumber);
    const ref: ActivityRef = {
      mid: this.mid++, aid: this.aid++, ctx: this.ctx++, secnum, modname, title, idnumber,
      dir: '',
    };
    ref.dir = `activities/${modname}_${ref.mid}`;
    this.activities.push(ref);
    this.modnameByMid.set(ref.mid, modname);
    if (!this.sectionSeq.has(secnum)) this.sectionSeq.set(secnum, []);
    (this.sectionSeq.get(secnum) as number[]).push(ref.mid);
    return ref;
  }

  nextGradeItem(): { id: number; sortorder: number } {
    return { id: this.gradeItemId++, sortorder: this.gradeSort++ };
  }

  boilerplate(dir: string): void {
    this.put(`${dir}/roles.xml`, BOIL.roles);
    this.put(`${dir}/calendar.xml`, BOIL.calendar);
    this.put(`${dir}/grade_history.xml`, BOIL.gradeHistory);
    this.put(`${dir}/competencies.xml`, BOIL.competencies);
    this.put(`${dir}/filters.xml`, BOIL.filters);
    this.put(`${dir}/completion.xml`, BOIL.completion);
    this.put(`${dir}/comments.xml`, BOIL.comments);
    this.put(`${dir}/xapistate.xml`, BOIL.xapistate);
  }
}

function inforef(fileIds: number[], gradeItemIds: number[] = [], qcats: number[] = [], roleIds: number[] = []): string {
  let x = '<?xml version="1.0" encoding="UTF-8"?>\n<inforef>\n';
  // LOOP 7 (A4 I1): los roles que usa un override de la actividad (Moodle solo carga y mapea los roles referenciados).
  if (roleIds.length) x += `  <roleref>\n${roleIds.map((id) => `    <role><id>${id}</id></role>`).join('\n')}\n  </roleref>\n`;
  if (fileIds.length) x += `  <fileref>\n${fileIds.map((id) => `    <file><id>${id}</id></file>`).join('\n')}\n  </fileref>\n`;
  if (gradeItemIds.length) x += `  <grade_itemref>\n${gradeItemIds.map((id) => `    <grade_item><id>${id}</id></grade_item>`).join('\n')}\n  </grade_itemref>\n`;
  if (qcats.length) x += `  <question_categoryref>\n${qcats.map((id) => `    <question_category><id>${id}</id></question_category>`).join('\n')}\n  </question_categoryref>\n`;
  return x + '</inforef>';
}

/**
 * LOOP 7 (A4 I1) — solucionario docente: además de oculto, el rol ESTUDIANTE tiene PROHIBIDO ver la página
 * (override `mod/page:view` = CAP_PROHIBIT en el contexto de la actividad). Si un docente la muestra por error (un
 * clic en «Mostrar», edición masiva, modo sigiloso), un estudiante sigue sin poder abrirla ni descargar su PDF
 * (pluginfile de mod_page exige `mod/page:view`). Rol de respaldo 5 = student (arquetipo student): el restore lo
 * mapea por nombre corto / arquetipo al rol estudiante del sitio.
 */
export const STUDENT_ROLE_BACKUP_ID = 5;
export const TEACHER_ONLY_ROLES_XML = `<?xml version="1.0" encoding="UTF-8"?>
<roles>
  <role_overrides>
    <override id="1">
      <roleid>${STUDENT_ROLE_BACKUP_ID}</roleid>
      <capability>mod/page:view</capability>
      <permission>-1000</permission>
      <timemodified>0</timemodified>
      <modifierid>0</modifierid>
    </override>
  </role_overrides>
  <role_assignments>
  </role_assignments>
</roles>`;
export const STUDENT_ROLE_DEFINITION_XML = `<?xml version="1.0" encoding="UTF-8"?>
<roles_definition>
  <role id="${STUDENT_ROLE_BACKUP_ID}">
    <name></name>
    <shortname>student</shortname>
    <nameincourse>$@NULL@$</nameincourse>
    <description></description>
    <sortorder>5</sortorder>
    <archetype>student</archetype>
  </role>
</roles_definition>`;

function withIdnumber(xml: string, idnumber: string): string {
  return applyXmlFields(xml, { idnumber: xmlEsc(idnumber) });
}

/** Tokens `$@XVIEWBYID*mid@$` → modname del destino. */
const TOKEN_MODNAME: Record<string, string> = {
  SCORM: 'scorm', QUIZ: 'quiz', RESOURCE: 'resource', PAGE: 'page', URL: 'url', H5PACTIVITY: 'h5pactivity', LABEL: 'label', FORUM: 'forum',
};

/** Falla fuerte ante cualquier token `$@…$` que no apunte a un módulo del paquete del tipo correcto. */
export function assertTokensV3(html: string, modnameByMid: Map<number, string>, where: string, sectionNums?: Set<number>, courseBackupId?: number): void {
  const bad: string[] = [];
  if (/cursia-cta:\/\//.test(html)) bad.push('marcador cursia-cta sin resolver');
  for (const m of html.matchAll(/\$@([A-Z0-9_]+)(?:\*(\d+))?@\$/g)) {
    const kind = m[1];
    const idStr = m[2];
    // Edu EV3: enlace a una sección del paquete (botón «Continuar con el módulo…»).
    if (kind === 'COURSESECTIONBYID') {
      if (!idStr || !sectionNums || !sectionNums.has(Number(idStr))) bad.push(m[0]);
      continue;
    }
    // EV6 (T3): página de insignias (certificado) del curso del backup.
    if (kind === 'BADGESVIEWBYID') {
      if (!idStr || courseBackupId === undefined || Number(idStr) !== courseBackupId) bad.push(m[0]);
      continue;
    }
    const want = /^(.+)VIEWBYID$/.exec(kind)?.[1];
    const modname = want ? TOKEN_MODNAME[want] : undefined;
    if (!modname || !idStr || modnameByMid.get(Number(idStr)) !== modname) bad.push(m[0]);
  }
  if (bad.length) throw new Error(`MBZ_V3_TOKEN_INVALID: ${where}: ${bad.join(', ')}`);
}

// ─── Builder ───────────────────────────────────────────────────────────────

function collectMissing(plan: PackagingPlanV3, c: DynamicPackageContentsV3): string[] {
  const missing: string[] = [];
  if (!c.courseIntro) missing.push(plan.keys.courseIntro);
  if (!Buffer.isBuffer(c.audioWelcome) || c.audioWelcome.length === 0) missing.push(plan.keys.audioWelcome);
  if (plan.keys.finalExam && !c.finalExamBank && (typeof c.finalExamGift !== 'string' || !c.finalExamGift.trim())) missing.push(plan.keys.finalExam);
  for (const m of plan.modules) {
    if (!c.moduleIntros.has(m.moduleId)) missing.push(m.keys.moduleIntro);
    if (m.keys.exam && !c.examBanks?.has(m.moduleId) && !(c.examGift.get(m.moduleId) ?? '').trim()) missing.push(m.keys.exam);
    for (const ch of m.chapters) {
      const id = ch.chapterId;
      // Motor de carga horaria: el capítulo de práctica no tiene content (Libro), presentación ni audiolibro (keys null).
      if (ch.keys.content && !(c.contentMd.get(id) ?? '').trim()) missing.push(ch.keys.content);
      if (!c.experiences.has(id)) missing.push(ch.keys.experience);
      const p = c.presentations.get(id);
      if (ch.keys.presentation && (!p || !Buffer.isBuffer(p.pdf) || !Buffer.isBuffer(p.cover))) missing.push(ch.keys.presentation);
      if (ch.keys.audiobookChapter && !Buffer.isBuffer(c.audiobookChapters.get(id))) missing.push(ch.keys.audiobookChapter);
      if (ch.kind === 'practice' && (c.contentMd.has(id) || c.presentations.has(id) || c.audiobookChapters.has(id))) missing.push(`${ch.keys.experience}:practice_with_content`);
      if (ch.keys.video && !c.videos.has(id)) missing.push(ch.keys.video);
      if (ch.keys.videoInteractions && !c.videoInteractions.has(id)) missing.push(ch.keys.videoInteractions);
      if (ch.keys.activity) {
        const a = c.activities.get(id);
        if (!a) missing.push(ch.keys.activity);
        else if (a.variant !== ch.activityVariant) missing.push(`${ch.keys.activity}:variant=${a.variant}≠${ch.activityVariant}`);
      }
    }
  }
  return missing;
}

/**
 * Construye el `.h5p` de la actividad de un capítulo (R7) con la nota del perfil vigente.
 * EV5-C: `expectedType` = facts.activityType (resolveActivityType del Manifest:
 * h5pType congelado o, legacy, el hash del UUID).
 */
async function buildActivityH5p(
  payload: unknown,
  chapterId: string,
  itemKey: string,
  passingGrade: number,
  expectedType: H5pActivityTypeV2 | null,
  activityTypeRules: number | undefined,
): Promise<{ h5p: Buffer; mainLibrary: string }> {
  if (!expectedType) throw new Error(`MBZ_V3_INVARIANT: facts sin tipo h5p para ${itemKey}`);
  const check = validateH5pActivityPayload(payload, {
    chapterId,
    itemKey,
    expectedType,
    ...(activityTypeRules !== undefined ? { activityTypeRules } : {}),
  });
  if (!check.ok) {
    throw new Error(`H5P_ACTIVITY_PAYLOAD_INVALID: ${itemKey}: ${check.errors.map((e) => `${e.code} ${e.path}: ${e.message}`).join('; ')}`);
  }
  const p = payload as { type: string; data: Record<string, unknown> };
  const input: Record<string, unknown> = { ...p.data, itemKey };
  if (typeof input.title === 'string') input.title = h5pTitle(input.title);
  let built;
  if (p.type === 'questionset') {
    // R11a ruling 3: la nota interna del QuestionSet es la del perfil VIGENTE, nunca la del LLM/executor.
    input.passPercentage = passingGrade;
    validateQuestionSetInput(input);
    // UX #5 (r18): QuestionSet 1.21 (CURSIA_H5P_PROFILE_V3) — su navegación «Siguiente ›» / «Anterior»
    // es compatible con el tema de H5P.Question 1.5 (en 1.20 era un botón azul vacío).
    // r55 (R7): solo contenido, como IV/DragText/Blanks: QuestionSet 1.21 viene en el Cursia H5P Library Pack v3
    // (requisito del sitio, summary.restore). Antes llevaba su delta (H5P.QuestionSet-1.21) adentro: una clausura
    // parcial que puede colgar el validador de H5P de Moodle (dialogcards-diagnosis.md).
    const qs = buildQuestionSet(input, { profile: CURSIA_H5P_PROFILE_V3 });
    assertH5pGradableInMoodle(qs.mainLibrary);
    const h5p = await buildContentOnlyH5p({
      mainLibrary: qs.mainLibrary,
      content: qs.content,
      title: qs.title,
      language: 'es',
      profile: CURSIA_H5P_PROFILE_V3,
    });
    return { h5p, mainLibrary: qs.mainLibrary };
  } else if (p.type === 'dragtext') {
    delete input.passPercentage;
    validateDragTextInput(input);
    built = buildDragText(input);
  } else if (p.type === 'blanks') {
    delete input.passPercentage;
    validateBlanksInput(input);
    built = buildBlanks(input);
  } else if (p.type === 'branchingscenario') {
    // EV6 H5P v2 (solo activityTypeRules = 2, ya verificado arriba): caso ramificado calificado.
    // r55 (R7): solo contenido (+ las imágenes de los finales); sus librerías vienen en el pack v3 del sitio.
    delete input.passPercentage;
    if (typeof input.title === 'string') input.title = h5pTitle(input.title, 120);
    validateBranchingScenarioInput(input);
    // #583 fix round 1 (m3): el color del final sigue la nota mínima REAL de la actividad (perfil vigente).
    const bs = buildBranchingScenario(input, { passingGrade });
    assertH5pGradableInMoodle(bs.mainLibrary);
    const h5p = await buildContentOnlyH5p({
      mainLibrary: bs.mainLibrary,
      content: bs.content,
      title: bs.title,
      language: 'es',
      profile: CURSIA_H5P_PROFILE_V3,
      // #583 (I4): imágenes de los finales (óptimo verde / aceptable ámbar / malo rojo).
      ...(bs.contentFiles ? { contentFiles: bs.contentFiles } : {}),
    });
    return { h5p, mainLibrary: bs.mainLibrary };
  } else {
    throw new Error(`H5P_NOT_GRADABLE_IN_MOODLE: tipo ${p.type} no es una actividad calificable (R-011)`);
  }
  // Review G4 I4 / R-011: una actividad CALIFICABLE solo usa librerías que Moodle califica.
  assertH5pGradableInMoodle(built.mainLibrary);
  const h5p = await buildContentOnlyH5p({ mainLibrary: built.mainLibrary, content: built.content, title: built.title, language: 'es' });
  return { h5p, mainLibrary: built.mainLibrary };
}

async function scormZip(launch: string, html: string, manifestXml: string): Promise<Buffer> {
  const z = new JSZip();
  const entries: Array<[string, string]> = [['imsmanifest.xml', manifestXml], [launch, html]];
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  for (const [n, d] of entries) z.file(n, d, { date: MBZ_V3_ZIP_FIXED_DATE, createFolders: false });
  return z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } });
}

/** EV6 P2: fuente de un examen v3 — GIFT de siempre o banco JSON (`dynamic_exam_bank_json`). */
export type ExamSource = { kind: 'gift'; gift: string } | { kind: 'bank'; bank: ExamBankV1 };

/** Histórico (P2-B2): el builder ya empaqueta bancos desde 3.4.0 (P2-B3); se conserva el código exportado. */
export const EXAM_BANK_UNSUPPORTED = 'EXAM_BANK_UNSUPPORTED';
export const EXAM_BANK_INVALID_BUILDER = 'EXAM_BANK_INVALID';

/**
 * EV6 P2-B3: fuente de cada examen (GIFT | banco). Un módulo con GIFT y banco a la vez es un
 * error del caller (falla fuerte). Cada banco se re-valida contra su plan CONGELADO + pertenencia
 * y la evidencia en el Markdown del capítulo (`contentMd`) → EXAM_BANK_INVALID.
 */
function resolveExamSources(plan: PackagingPlanV3, c: DynamicPackageContentsV3): { modules: Map<string, ExamSource>; final: ExamSource | null } {
  const modules = new Map<string, ExamSource>();
  const check = (key: string, scope: 'module' | 'final', bank: ExamBankV1, chapters: Array<{ id: string; moduleId: string }>): void => {
    const r = validateExamBank(bank, { scope, chapters, chapterMd: c.contentMd, planSource: 'frozen', evidenceRules: 'asAccepted' });
    if (!r.ok) {
      const codes = [...new Set(r.errors.map((e) => e.code))].sort();
      throw new Error(`${EXAM_BANK_INVALID_BUILDER}: ${key} [${codes.join(', ')}] ${r.errors.slice(0, 5).map((e) => `${e.path} ${e.code}: ${e.message}`).join(' | ')}`);
    }
    // Fix 1 (M4): el plan CONGELADO debe cubrir cada capítulo (módulo, en el final) que el plan ACTUAL
    // cubre; un reuse viejo que omita uno dejaría ese capítulo sin evaluar → falla fuerte.
    const owner = (l: ExamBankV1['plan'][number]): string => ('chapterId' in l ? l.chapterId : l.moduleId);
    const frozen = new Set(bank.plan.map(owner));
    const uncovered = [...new Set(expectedExamPlan(scope, chapters).map(owner))].filter((o) => !frozen.has(o));
    if (uncovered.length) {
      throw new Error(`${EXAM_BANK_INVALID_BUILDER}: ${key} [EXAM_BANK_PLAN] el plan congelado del banco no cubre ${scope === 'module' ? 'los capítulos' : 'los módulos'} ${uncovered.join(', ')}`);
    }
  };
  const examModules = new Set(plan.modules.filter((m) => m.keys.exam).map((m) => m.moduleId));
  for (const id of c.examBanks?.keys() ?? []) {
    if (!examModules.has(id)) throw new Error(`MBZ_V3_INVARIANT: banco de examen para un módulo sin examen (${id})`);
  }
  for (const m of plan.modules) {
    if (!m.keys.exam) continue;
    const bank = c.examBanks?.get(m.moduleId);
    const gift = c.examGift.get(m.moduleId);
    if (bank && (gift ?? '').trim()) throw new Error(`MBZ_V3_INVARIANT: ${m.keys.exam} trae GIFT y banco a la vez`);
    if (bank) {
      // Motor de carga horaria: los capítulos de práctica no entran a los exámenes (mismo plan que el claim y que
      // packaging-v3); sin el filtro, un módulo con práctica y examen en banco nunca se empaquetaba (E2E E7).
      check(m.keys.exam, 'module', bank, m.chapters.filter((ch) => ch.kind !== 'practice').map((ch) => ({ id: ch.chapterId, moduleId: m.moduleId })));
      modules.set(m.moduleId, { kind: 'bank', bank });
    } else {
      modules.set(m.moduleId, { kind: 'gift', gift: gift as string });
    }
  }
  let final: ExamSource | null = null;
  if (plan.keys.finalExam) {
    if (c.finalExamBank && (c.finalExamGift ?? '').trim()) throw new Error(`MBZ_V3_INVARIANT: ${plan.keys.finalExam} trae GIFT y banco a la vez`);
    if (c.finalExamBank) {
      check(plan.keys.finalExam, 'final', c.finalExamBank, plan.modules.flatMap((m) => m.chapters.filter((ch) => ch.kind !== 'practice').map((ch) => ({ id: ch.chapterId, moduleId: m.moduleId }))));
      final = { kind: 'bank', bank: c.finalExamBank };
    } else {
      final = { kind: 'gift', gift: c.finalExamGift as string };
    }
  } else if (c.finalExamBank) {
    throw new Error('MBZ_V3_INVARIANT: banco de examen final en un curso sin examen final');
  }
  return { modules, final };
}

/** Claves de identificadores (nunca texto de una persona) al recolectar los textos escritos por el usuario. */
const USER_TEXT_SKIP_KEYS = new Set(['id', 'type', 'kind', 'variant', 'engine', 'activityEngine', 'structureVersion', 'storagePath', 'sha256', 'mimetype', 'mimeType', 'artifactId', 'origin', 'relation', 'chapterId', 'moduleId', 'source']);
const USER_TEXT_TITLE_KEYS = new Set(['title', 'name', 'label']);
/** Review r2 (I2): nombre de un archivo que subió o nombró el usuario («worked_example.xlsx»): siempre es suyo. */
const USER_FILENAME_KEYS = new Set(['filename']);

function collectUserStrings(v: unknown, key: string | null, out: string[]): void {
  if (typeof v === 'string') {
    if (key !== null && USER_FILENAME_KEYS.has(key)) {
      if (v.trim()) out.push(v);
      return;
    }
    if (key !== null && USER_TEXT_SKIP_KEYS.has(key)) return;
    if (/\s/.test(v.trim()) || (key !== null && USER_TEXT_TITLE_KEYS.has(key))) out.push(v);
    return;
  }
  if (Array.isArray(v)) for (const x of v) collectUserStrings(x, key, out);
  else if (v && typeof v === 'object' && !(v instanceof Buffer) && !(v instanceof Uint8Array)) {
    for (const k of Object.keys(v as Record<string, unknown>)) collectUserStrings((v as Record<string, unknown>)[k], k, out);
  }
}

/**
 * Review r2 (M-a, procedencia): del Blueprint solo cuenta como texto de una PERSONA lo que el docente escribe o edita en
 * el paso de estructura (el título del curso; título, objetivo y descripción de cada módulo y capítulo — una estructura
 * sugerida se revisa y edita ahí antes de congelarse) y el perfil del estudiante y sus resultados escritos en el perfil
 * pedagógico (`course.applicationContext`). NO cuenta lo que propone un modelo o una regla y queda guardado en el
 * Blueprint: `course.academicContext` (resultados/competencias: el snapshot no guarda su origen por dato y pueden ser
 * propuestos por IA — PROPOSAL_BASIS — así que se tratan como texto generado: se reparan y se juzgan) ni `pedagogy` /
 * `design` (motor de reglas). Lo que viene del documento importado de la institución entra por `libroReferences`.
 */
function blueprintUserStrings(bp: BlueprintSnapshotV2 | null | undefined, out: string[]): void {
  if (!bp || typeof bp !== 'object') return;
  const push = (t: unknown) => { if (typeof t === 'string' && t.trim()) out.push(t); };
  push(bp.course?.title);
  collectUserStrings(bp.course?.applicationContext ?? null, null, out);
  for (const m of Array.isArray(bp.modules) ? bp.modules : []) {
    push(m.title);
    push(m.objective);
    push(m.description);
    for (const ch of Array.isArray(m.chapters) ? m.chapters : []) {
      push(ch.title);
      push(ch.objective);
      push(ch.description);
    }
  }
}

/**
 * Review r1 (I2) + r2: textos que escribió, editó o subió una PERSONA y que el paquete muestra: del Blueprint lo que
 * edita el docente (ver `blueprintUserStrings`), el perfil de evaluación completo (lo configura el docente: archivos de
 * práctica con su título, instrucciones y NOMBRE DE ARCHIVO; textos de la Tarea), las referencias importadas del
 * documento de la institución y el nombre de la institución. Solo devuelve los fragmentos con un término interno (si
 * no hay ninguno, nada cambia), ya en la vista normalizada (`plainTextView`).
 */
export function userProvidedVocabularyTexts(input: Pick<BuildDynamicMbzV3Input, 'blueprint' | 'assessmentProfile' | 'libroReferences' | 'libroBrand'>, exempt: readonly string[]): string[] {
  const all: string[] = [];
  blueprintUserStrings(input.blueprint, all);
  collectUserStrings(input.assessmentProfile, null, all);
  for (const r of input.libroReferences ?? []) if (typeof r === 'string') all.push(r);
  if (typeof input.libroBrand?.name === 'string') all.push(input.libroBrand.name);
  return protectedVocabularyTexts(all, exempt);
}

/**
 * T1 (r57): reparación determinística del vocabulario interno en todo el contenido LLM que se muestra (experiencias,
 * intros, interacciones del video, actividad H5P, bancos de examen, AA + solucionario, ejercicios guiados). El Libro
 * (contentMd) es la referencia del dominio: define las exenciones y no se toca. Aviso por regla con su cantidad.
 * Review r1: `protectedTexts` (I2, texto de una persona citado por el modelo) nunca se toca; `noGrowth` (I3) nunca
 * alarga un campo (rótulo corto o, si tampoco entra, el original queda con aviso y su regla exenta en el validador).
 */
export function repairContentsInternalVocabulary(
  contents: DynamicPackageContentsV3,
  opts: { protectedTexts?: readonly string[]; noGrowth?: boolean } = {},
): { contents: DynamicPackageContentsV3; exempt: string[]; keptTexts: string[]; warnings: string[]; fixed: number } {
  const exempt = internalVocabularyExemptions(contents.contentMd ? contents.contentMd.values() : []);
  const counts = new Map<string, number>();
  const shortCounts = new Map<string, number>();
  const keptCounts = new Map<string, number>();
  const keptTexts: string[] = [];
  const bump = (m: Map<string, number>, ids: string[]) => { for (const f of ids) m.set(f, (m.get(f) ?? 0) + 1); };
  const fix = <T>(v: T): T => {
    if (v === undefined || v === null) return v;
    const r = repairInternalVocabularyDeep(v, exempt, opts);
    bump(counts, r.fixes);
    bump(shortCounts, r.shortened);
    bump(keptCounts, r.kept);
    keptTexts.push(...r.keptTexts);
    return r.value;
  };
  const fixMap = <T>(m: Map<string, T> | undefined): Map<string, T> | undefined => (m ? new Map(Array.from(m, ([k, v]) => [k, fix(v)])) : m);
  const activities = contents.activities
    ? new Map(Array.from(contents.activities, ([k, a]) => [k, a.variant === 'h5p' ? { ...a, payload: fix(a.payload) } : a] as [string, ActivityContentV3]))
    : contents.activities;
  const out: DynamicPackageContentsV3 = {
    ...contents,
    courseIntro: fix(contents.courseIntro),
    moduleIntros: fixMap(contents.moduleIntros) as Map<string, unknown>,
    experiences: fixMap(contents.experiences) as Map<string, unknown>,
    videoInteractions: fixMap(contents.videoInteractions) as Map<string, unknown>,
    activities,
    ...(contents.examBanks ? { examBanks: fixMap(contents.examBanks) } : {}),
    ...(contents.finalExamBank ? { finalExamBank: fix(contents.finalExamBank) } : {}),
    ...(contents.applications ? { applications: fixMap(contents.applications) } : {}),
    ...(contents.guidedPractices ? { guidedPractices: fixMap(contents.guidedPractices) } : {}),
  };
  const warnings = [
    ...Array.from(counts, ([rule, n]) => `internal_vocabulary_repaired:${rule}:${n}`),
    ...Array.from(shortCounts, ([rule, n]) => `internal_vocabulary_short_label:${rule}:${n}`),
    ...Array.from(keptCounts, ([rule, n]) => `internal_vocabulary_kept_length_limit:${rule}:${n}`),
  ].sort();
  // I3 (review r2): un término que no se pudo reparar sin pasar el límite del campo queda visible con aviso; se exenta
  // SOLO ese fragmento (`keptTexts` → expectations.internalVocabularyKeptTexts), nunca la regla en todo el curso.
  let fixed = 0;
  for (const n of counts.values()) fixed += n;
  return { contents: out, exempt, keptTexts: protectedVocabularyTexts(keptTexts, exempt), warnings, fixed };
}

/** Review r1 (I3): error de largo de un esquema (caracteres o palabras) al validar el contenido ya reparado. */
function isLengthLimitError(err: unknown): boolean {
  return /TEXT_TOO_LONG|WORD_RANGE/.test(err instanceof Error ? err.message : String(err));
}

/**
 * Review r1 (I3): la reparación del vocabulario nunca deja un paquete sin armar por largo. Primero se arma con los
 * rótulos completos; si ESO falla por un límite de largo (caracteres/palabras) y hubo reparaciones, se re-arma con la
 * reparación que nunca alarga un campo (`noGrowth`). Cualquier otro error, o el mismo sin reparaciones, sube igual.
 */
export async function buildDynamicMbzV3(input: BuildDynamicMbzV3Input): Promise<BuildDynamicMbzV3Result> {
  try {
    return await buildDynamicMbzV3Once(input, false);
  } catch (err) {
    if (!isLengthLimitError(err)) throw err;
    if (!input?.contents || repairContentsInternalVocabulary(input.contents, { protectedTexts: userProvidedVocabularyTexts(input, []) }).fixed === 0) throw err;
    return buildDynamicMbzV3Once(input, true);
  }
}

async function buildDynamicMbzV3Once(input: BuildDynamicMbzV3Input, noGrowth: boolean): Promise<BuildDynamicMbzV3Result> {
  if (!Number.isInteger(input?.ts) || input.ts <= 0) throw new Error('MBZ_V3_INVALID: ts (reloj inyectado) debe ser un entero > 0');
  const { manifest, blueprint, ts } = input;
  // Review r1 (M): fecha de inicio del curso EN EL BACKUP (course.xml <startdate> y <original_course_startdate>): las
  // fechas relativas (fecha límite de la Tarea) se anclan a ella, así Moodle las corre juntas al restaurar.
  const courseStartDate = ts;
  // T1 (r57): vocabulario interno del generador («worked_example», «texto fuente», «[S12]»…) → lenguaje natural,
  // determinístico, ANTES de validar/renderizar (también repara artifacts ya generados al re-empaquetar).
  // Review r1 (I2): el texto que escribió una persona (títulos, archivos de práctica, perfil, referencias) nunca se repara.
  const vocabUserTexts = userProvidedVocabularyTexts(input, internalVocabularyExemptions(input.contents?.contentMd ? input.contents.contentMd.values() : []));
  const vocab = repairContentsInternalVocabulary(input.contents, { protectedTexts: vocabUserTexts, noGrowth });
  const c = vocab.contents;
  const pendingIds = [...new Set(input.pendingVideoChapterIds ?? [])];
  const plan = buildPackagingPlanV3(manifest, blueprint, { manifestId: input.manifestId ?? null, omitVideoChapterIds: pendingIds });
  const omittedVideoKeys = plan.omittedVideos.map((v) => v.videoKey);
  const missing = collectMissing(plan, c);
  if (missing.length) throw new PackagingV3ContentMissingError(missing);
  const examSources = resolveExamSources(plan, c);
  const MV = resolveMoodleVersion(input.moodleVersion);
  const level = input.level === 'clean_safe' ? undefined : ('enhanced' as const);
  const opts = level ? { level } : undefined;
  const warnings: string[] = [];
  // EV6 T5: aviso visible en el resumen del paquete por cada video pendiente omitido.
  for (const v of plan.omittedVideos) warnings.push(`pending_video_omitted:${v.videoKey}`);
  warnings.push(...vocab.warnings);

  // ── Tema (R1) y evaluación (R6) ──────────────────────────────────────────
  const theme: ResolvedTheme = resolveTheme(input.presentation);
  const themeErrors = validateTheme(theme, { moduleCount: plan.modules.length });
  if (themeErrors.length) throw new Error(`THEME_INVALID: ${themeErrors.map((e) => e.code).join(', ')}`);
  // F1 (I3): los pesos se normalizan contra los ítems calificables del Manifest.
  const resolved = resolveAssessment(input.assessmentProfile, {
    hasFinalExam: plan.features.finalExam,
    activityEngine: plan.features.activityEngine,
    itemCounts: assessmentItemCountsForPackage(manifest, omittedVideoKeys, input.assessmentProfile),
  });

  // ── Contenidos LLM validados ─────────────────────────────────────────────
  const courseIntro: CourseIntroV3 = assertValidCourseIntroV3(c.courseIntro);
  const moduleIntros = new Map<string, ModuleIntroV3>();
  for (const m of plan.modules) {
    moduleIntros.set(m.moduleId, assertValidModuleIntroV3(c.moduleIntros.get(m.moduleId), { chapterIds: m.chapters.map((x) => x.chapterId) }));
  }

  // ── Datos MEDIDOS ────────────────────────────────────────────────────────
  const allChapters = plan.modules.flatMap((m) => m.chapters);
  const slideCountByChapter: Record<string, number> = {};
  // Motor de carga horaria: diapositivas, audiolibro y Libro solo de los capítulos de CONTENIDO.
  const contentChapters = allChapters.filter((ch) => ch.kind !== 'practice');
  for (const ch of contentChapters) slideCountByChapter[ch.chapterId] = pdfPageCount((c.presentations.get(ch.chapterId) as { pdf: Buffer }).pdf);
  const audioWelcomeSeconds = mp3DurationSeconds(c.audioWelcome);
  const audiobook = assembleAudiobook(
    contentChapters.map((ch) => ({ chapterId: ch.chapterId, chapterNumber: ch.chapterNumber, mp3: c.audiobookChapters.get(ch.chapterId) })),
    { manifests: c.audiobookManifests ?? null },
  );
  if (audiobook.floor) warnings.push(...audiobook.floor.warnings);
  // EV6 P2-B3: con banco, las «preguntas del examen» que ve el estudiante son los SLOTS (no el banco).
  const examQuestionCountByModule: Record<string, number> = {};
  const examBankSizeByModule: Record<string, number> = {};
  for (const m of plan.modules) {
    if (!m.keys.exam) continue;
    const src = examSources.modules.get(m.moduleId) as ExamSource;
    if (src.kind === 'bank') {
      examQuestionCountByModule[m.moduleId] = planSlotCount(src.bank.plan);
      examBankSizeByModule[m.moduleId] = src.bank.questions.length;
      continue;
    }
    const n = parseGIFT(src.gift).length;
    if (n < 1) throw new Error(`QUIZ_V3_EMPTY: el GIFT de ${m.keys.exam} no produjo preguntas`);
    examQuestionCountByModule[m.moduleId] = n;
  }
  let finalExamQuestionCount: number | undefined;
  let finalExamBankSize: number | undefined;
  if (plan.keys.finalExam) {
    const src = examSources.final as ExamSource;
    if (src.kind === 'bank') {
      finalExamQuestionCount = planSlotCount(src.bank.plan);
      finalExamBankSize = src.bank.questions.length;
    } else {
      finalExamQuestionCount = parseGIFT(src.gift).length;
      if (finalExamQuestionCount < 1) throw new Error(`QUIZ_V3_EMPTY: el GIFT de ${plan.keys.finalExam} no produjo preguntas`);
    }
  }
  // Loop 9 B: prácticas guiadas validadas (falla fuerte: una del plan sin documento o inválida nunca se omite en silencio).
  const guidedDocs = new Map<string, unknown>();
  for (const ch of allChapters) {
    if (!ch.keys.guidedPractice) continue;
    const doc = c.guidedPractices?.get(ch.chapterId);
    if (!doc) throw new Error(`MBZ_V3_INVARIANT: práctica guiada del capítulo ${ch.chapterNumber} sin documento`);
    // Loop 10 fix M1: invariante ESTRUCTURAL del empaque (la guardia de calidad la aplica el cargador según el promptVersion).
    const errs = validateGuidedPracticeDoc(doc, { chapterId: ch.chapterId, minutes: ch.guidedPracticeMinutes as number, qualityGuard: false });
    if (errs.length) throw new Error(`MBZ_V3_INVARIANT: práctica guiada del capítulo ${ch.chapterNumber} inválida (${errs.slice(0, 3).map((e) => `${e.code} ${e.path}`).join('; ')})`);
    guidedDocs.set(ch.chapterId, doc);
  }
  for (const id of c.guidedPractices?.keys() ?? []) if (!guidedDocs.has(id)) throw new Error(`MBZ_V3_INVARIANT: práctica guiada del capítulo ${id}, que no la tiene en el plan`);
  // T5 (r57): archivos de trabajo del perfil (subidos: verificados por sha256/tamaño/formato; tabla: generados). Falla fuerte.
  const practice = await resolvePracticeFiles(
    input.assessmentProfile.practiceResources,
    allChapters.map((ch) => ({ chapterId: ch.chapterId, hasApplication: !!ch.keys.application })),
    c.practiceFiles,
  );
  warnings.push(...practice.warnings);
  // T4 (r57): excepciones de entrega de capítulos sin AA (o fuera del curso) no aplican: aviso visible, nunca en silencio.
  for (const id of Object.keys(input.assessmentProfile.applicationDelivery?.chapterModes ?? {})) {
    if (!allChapters.some((ch) => ch.chapterId === id && !!ch.keys.application)) warnings.push(`application_delivery_chapter_ignored:${id}`);
  }
  // r19 (L3): logo de la marca de agua (cuenta → Cursia); un logo de la cuenta inválido deja su aviso, nunca en silencio.
  let libroLogo = resolveLibroLogo(input.libroBrand?.logo ?? null);
  warnings.push(...libroLogo.warnings);
  const libroInputBase = {
    courseTitle: plan.course.title,
    theme,
    courseIntro,
    modules: plan.modules.map((m) => ({
      number: m.moduleNumber,
      title: m.title,
      intro: moduleIntros.get(m.moduleId) as ModuleIntroV3,
      chapters: m.chapters.filter((ch) => ch.kind !== 'practice').map((ch) => ({
        number: ch.chapterNumber, title: ch.title, md: c.contentMd.get(ch.chapterId) as string,
        // Loop 9 B: la práctica guiada del capítulo al final de su capítulo en el Libro (no suma palabras al Libro).
        ...(guidedDocs.has(ch.chapterId) ? { appendixMd: guidedPracticeLibroMarkdown(guidedDocs.get(ch.chapterId)) } : {}),
      })),
    })),
    brandName: input.libroBrand?.name ?? null,
    // fix round 1 (M8): /ID del PDF único por curso (sha del plan), sigue determinístico.
    documentKey: packagingPlanV3Sha256(plan),
    // T1 (r57): la portada y el índice cuentan los capítulos REALES (los de práctica, sin texto en el Libro, en su lugar).
    practiceChapters: plan.modules.flatMap((m) => m.chapters.filter((ch) => ch.kind === 'practice').map((ch) => ({ number: ch.chapterNumber, title: ch.title, moduleNumber: m.moduleNumber }))),
    ...(input.libroReferences && input.libroReferences.length ? { programReferences: [...input.libroReferences] } : {}),
  };
  let libro: Awaited<ReturnType<typeof renderLibroPdfV3>>;
  try {
    libro = await renderLibroPdfV3({ ...libroInputBase, logo: libroLogo });
  } catch (err) {
    // fix round 1 (I1): un logo de la cuenta que pdfkit no puede embeber nunca tumba el paquete → Cursia + aviso.
    if (libroLogo.source === 'cursia_default') throw err;
    warnings.push(`libro_logo_invalid:${libroLogo.source}:pdf_embed_failed`);
    libroLogo = cursiaDefaultLogo();
    libro = await renderLibroPdfV3({ ...libroInputBase, logo: libroLogo });
  }
  // fix round 1 (I2): caracteres sin equivalente en las fuentes del PDF → contados y visibles, nunca en silencio.
  if (libro.unmappedChars > 0) warnings.push(`libro_chars_unmapped:${libro.unmappedChars}`);
  const libroFilename = libroPdfFilename(plan.course.title);

  // EV6 T5 (ruling 3): capítulos pendientes cuyos textos publicados mencionan su video → aviso.
  const noticeChapterIds = pendingVideoNoticeChapterIds({
    chapters: plan.modules.flatMap((m) => m.chapters.map((ch) => ({ id: ch.chapterId, moduleId: m.moduleId }))),
    pendingChapterIds: plan.omittedVideos.map((v) => v.chapterId),
    courseIntro,
    moduleIntros,
    experiences: c.experiences,
  });
  // EV6 H5P v2 — «Repaso» (Dialog Cards) desde la experiencia validada, solo con el ajuste del
  // Blueprint. Capítulos con < 4 tarjetas no llevan repaso (nunca un mazo de 1–3).
  const reviewDecks = new Map<string, H5pBuiltContent & { cards: unknown[] }>();
  // H2 fix round 1 (I-2, M-4): solo con H5P v2 (marcador activityTypeRules=2 del Manifest) y motor h5p
  // (un curso SCORM puede ir a un sitio sin las librerías v1 de las que depende Dialog Cards).
  if (reviewCardsApply(blueprint, manifest)) {
    for (const ch of allChapters) {
      const deck = buildDialogCardsFromExperience({ chapterTitle: ch.title, experience: c.experiences.get(ch.chapterId) });
      if (deck) reviewDecks.set(ch.chapterId, deck);
    }
  }
  const facts = buildCourseFacts({
    manifest,
    blueprint,
    ...(reviewDecks.size ? { reviewCardsChapterIds: [...reviewDecks.keys()] } : {}),
    // Motor de carga horaria: tarjetas MEDIDAS de cada «Repaso» (minutos del capítulo).
    ...(reviewDecks.size ? { reviewCardCountByChapter: Object.fromEntries([...reviewDecks].map(([id, d]) => [id, d.cards.length])) } : {}),
    // Loop 9 B: las prácticas guiadas validadas (sus minutos entran al tiempo del capítulo).
    ...(guidedDocs.size ? { guidedPracticeChapterIds: [...guidedDocs.keys()] } : {}),
    ...(practice.resolved.length ? { practiceResources: practice.resolved } : {}),
    assessment: input.assessmentProfile,
    hours: input.hours ?? null,
    pendingVideos: plan.omittedVideos.length ? { chapterIds: plan.omittedVideos.map((v) => v.chapterId), noticeChapterIds } : null,
    artifacts: {
      audioWelcomeSeconds,
      audiobookParts: audiobook.parts.map((p) => ({ chapterId: p.chapterId, seconds: p.durationSeconds })),
      slideCountByChapter,
      examQuestionCountByModule,
      ...(finalExamQuestionCount !== undefined ? { finalExamQuestionCount } : {}),
      ...(Object.keys(examBankSizeByModule).length ? { examBankSizeByModule } : {}),
      ...(finalExamBankSize !== undefined ? { finalExamBankSize } : {}),
      libroWordCount: libro.wordCount,
      // P3: palabras MEDIDAS del experience → minutos estimados del capítulo (facts).
      experienceWordsByChapter: Object.fromEntries(allChapters.map((ch) => [ch.chapterId, experienceMovementWords(c.experiences.get(ch.chapterId))])),
      // P3 (fix M2): duración medida de los videos reales (los pendientes no están en c.videos).
      videoSecondsByChapter: Object.fromEntries(
        allChapters
          .map((ch) => [ch.chapterId, (c.videos.get(ch.chapterId) as { durationSec?: number } | undefined)?.durationSec] as const)
          .filter(([, s]) => typeof s === 'number' && Number.isFinite(s) && s > 0),
      ),
      libroHasBibliography: libro.hasBibliography,
    },
  });
  // R6: una categoría con peso > 0 y sin ítems calificables deja el curso sin poder llegar a 100 → falla fuerte.
  // T4 (r57): las Tareas calificadas cuentan en su categoría (propia o práctica).
  const gradedAssignCount = facts.counts.applicationAssignsGraded ?? 0;
  const assignCategory = resolved.application?.graded ? resolved.application.category : null;
  assertCategoriesPopulated(resolved, {
    practice: facts.counts.activities + facts.counts.videos + (assignCategory === 'practice' ? gradedAssignCount : 0),
    moduleExams: facts.counts.exams,
    finalExam: facts.finalExam.enabled ? 1 : 0,
    ...(assignCategory === 'applications' || resolved.categories.some((x) => x.key === 'applications') ? { applications: assignCategory === 'applications' ? gradedAssignCount : 0 } : {}),
  });

  // EV6: el shell (facts) y el plan (Manifest) derivan las MISMAS secciones; si difieren, los
  // botones «Continuar…» apuntarían a otra sección → falla fuerte.
  const factsLayout = sectionLayoutFromFacts(facts);
  const shape = (xs: PackagingPlanV3['sections']) => JSON.stringify(xs.map((x) => [x.sectionNum, x.kind, x.moduleId ?? null, x.chapterId ?? null]));
  if (shape(factsLayout.sections) !== shape(plan.sections)) {
    throw new Error('MBZ_V3_INVARIANT: las secciones del plan no coinciden con las derivadas de facts');
  }
  const firstChapterSection = plan.modules[0]?.firstSectionNum;
  if (!Number.isInteger(firstChapterSection)) throw new Error('MBZ_V3_INVARIANT: el curso no tiene capítulos');

  // ── Capítulos (R11a) ─────────────────────────────────────────────────────
  const experiences: Record<string, ChapterExperience> = {};
  for (const ch of allChapters) experiences[ch.chapterId] = c.experiences.get(ch.chapterId) as ChapterExperience;
  const assembled = assembleAllChapters(facts, experiences, theme, opts);

  // ── Zip ──────────────────────────────────────────────────────────────────
  const W = new MbzWriter(ts, MV);
  const ids = new IdAllocator({
    qcat: 1000, qbe: 1000, qversion: 1000, question: 1000, qinstance: 1000, qref: 1000, qsetref: 1000, answer: 1000,
    match: 1000, qoptions: 1000, qsection: 1000, qfeedback: 1000, sco: 50000, scodata: 60000,
  });
  const graded: Array<CompletionCandidate & { name: string }> = [];
  const labelsHtml: Array<{ where: string; html: string }> = [];
  const h5pPackages: MbzV3H5pPackage[] = [];
  const mockPresentationChapters: string[] = [];
  const introTheme = introThemeFrom(theme);
  // P3: marco de la actividad con el tono del módulo del capítulo (mismo que la tarjeta «Práctica calificada»).
  const frameFor = (chapterNumber: number): ActivityFrameTone => {
    const cf = facts.chapters.find((x) => x.number === chapterNumber);
    if (!cf) throw new Error(`MBZ_V3_INVARIANT: capítulo ${chapterNumber} sin facts para el marco de la actividad`);
    const mt = moduleTone(theme, moduleColor(theme, cf.moduleNumber - 1), groundColor(theme));
    return { ink: mt.ink, soft: mt.soft, edge: mt.edge, chapterNumber };
  };

  // Edu EV3 — botones de navegación: el shell deja marcadores cursia-cta://…; las secciones se
  // resuelven al instante y «siguiente actividad / evaluación» cuando el builder crea esa actividad
  // en la misma sección (se reescribe el label.xml). assertTokensV3 falla ante uno sin resolver.
  const pendingCtas: Array<{ a: ActivityRef; name: string; html: string; secnum: number; logIdx: number }> = [];
  const resolveCta = (marker: 'next-activity' | 'next-exam', secnum: number, token: string): void => {
    for (let i = pendingCtas.length - 1; i >= 0; i--) {
      const p = pendingCtas[i];
      if (p.secnum !== secnum || !p.html.includes(`cursia-cta://${marker}`)) continue;
      p.html = p.html.split(`cursia-cta://${marker}`).join(token);
      W.put(`${p.a.dir}/label.xml`, labelXmlWithCtx(p.a.aid, p.a.mid, p.a.ctx, p.name, p.html, ts));
      labelsHtml[p.logIdx].html = p.html;
      if (!p.html.includes('cursia-cta://')) pendingCtas.splice(i, 1);
      return;
    }
  };
  const addLabel = (secnum: number, idnumber: string, label: ShellLabel, files: Array<{ name: string; data: Buffer | string; mime: string }> = []): ActivityRef => {
    const a = W.newActivity('label', secnum, label.name, idnumber);
    const fileIds = files.map((f) => W.addFile(a.ctx, 'mod_label', 'intro', f.name, f.data, f.mime));
    label = {
      ...label,
      html: label.html
        .replace(/cursia-cta:\/\/section\/(\d+)/g, (_m, n: string) => `$@COURSESECTIONBYID*${n}@$`)
        .split(CTA_BADGES)
        .join(`$@BADGESVIEWBYID*${MBZ_V3_COURSE_BACKUP_ID}@$`),
    };
    if (label.html.includes('cursia-cta://')) pendingCtas.push({ a, name: label.name, html: label.html, secnum, logIdx: labelsHtml.length });
    W.put(`${a.dir}/label.xml`, labelXmlWithCtx(a.aid, a.mid, a.ctx, label.name, label.html, ts));
    W.put(`${a.dir}/module.xml`, withIdnumber(moduleXml(a.mid, 'label', secnum, ts, MV.bv), idnumber));
    W.put(`${a.dir}/inforef.xml`, inforef(fileIds));
    W.put(`${a.dir}/grades.xml`, gradesXml(a.aid));
    W.boilerplate(a.dir);
    labelsHtml.push({ where: idnumber, html: label.html });
    return a;
  };

  // Fase 2: página (mod_page) con archivos en su filearea `content` (enlaces @@PLUGINFILE@@/<archivo>).
  // `hidden`: visible=0 (solo docentes: moodle/course:viewhiddenactivities). `completionView`: se marca al verla.
  let teacherOnlyPages = 0;
  const addPage = (
    secnum: number,
    idnumber: string,
    page: { name: string; html: string },
    files: Array<{ name: string; data: Buffer; mime: string }>,
    opts: { hidden?: boolean; completionView?: boolean; teacherOnly?: boolean } = {},
  ): ActivityRef => {
    const a = W.newActivity('page', secnum, page.name, idnumber);
    if (opts.teacherOnly) teacherOnlyPages++;
    const fileIds = files.map((f) => W.addFile(a.ctx, 'mod_page', 'content', f.name, f.data, f.mime));
    W.put(`${a.dir}/page.xml`, `<?xml version="1.0" encoding="UTF-8"?>
<activity id="${a.aid}" moduleid="${a.mid}" modulename="page" contextid="${a.ctx}">
  <page id="${a.aid}">
    <name>${xmlEsc(page.name)}</name>
    <intro></intro>
    <introformat>1</introformat>
    <content>${xmlEsc(page.html)}</content>
    <contentformat>1</contentformat>
    <legacyfiles>0</legacyfiles>
    <legacyfileslast>${NULL}</legacyfileslast>
    <display>0</display>
    <displayoptions>a:2:{s:10:"printintro";i:0;s:17:"printlastmodified";i:0;}</displayoptions>
    <revision>1</revision>
    <timemodified>${ts}</timemodified>
  </page>
</activity>`);
    W.put(`${a.dir}/module.xml`, applyXmlFields(withIdnumber(moduleXml(a.mid, 'page', secnum, ts, MV.bv), idnumber), {
      ...(opts.hidden || opts.teacherOnly ? { visible: '0', visibleold: '0' } : {}),
      ...(opts.completionView ? { completion: '2', completionview: '1' } : { completion: '0' }),
      downloadcontent: '0',
    }));
    W.put(`${a.dir}/inforef.xml`, inforef(fileIds, [], [], opts.teacherOnly ? [STUDENT_ROLE_BACKUP_ID] : []));
    W.put(`${a.dir}/grades.xml`, gradesXml(a.aid));
    W.boilerplate(a.dir);
    if (opts.teacherOnly) W.put(`${a.dir}/roles.xml`, TEACHER_ONLY_ROLES_XML);
    labelsHtml.push({ where: idnumber, html: page.html });
    return a;
  };

  // T4 (r57): Actividad de Aplicación como Tarea (mod_assign): la descripción es la página del estudiante (con su PDF en
  // `intro`), entrega por texto en línea y/o archivos, completion al ENVIAR (completionsubmit), comentarios de
  // retroalimentación; calificada → ítem de nota en su categoría (+ rúbrica con los criterios de la AA); formativa → sin
  // ítem de nota. El solucionario sigue en su página oculta solo para docentes.
  let assignPluginConfigId = 1;
  let gradingSeq = 1;
  let rubricCriterionId = 1;
  let rubricLevelId = 1;
  let assignsGraded = 0;
  let assignsTotal = 0;
  let assignsRubric = 0;
  const addAssign = (
    secnum: number,
    idnumber: string,
    name: string,
    introHtml: string,
    files: Array<{ name: string; data: Buffer; mime: string }>,
    doc: unknown,
  ): ActivityRef => {
    const d = resolved.application;
    if (!d) throw new Error('MBZ_V3_INVARIANT: Tarea de entrega sin applicationDelivery resuelta');
    const a = W.newActivity('assign', secnum, name, idnumber);
    assignsTotal++;
    const fileIds = files.map((f) => W.addFile(a.ctx, 'mod_assign', 'intro', f.name, f.data, f.mime));
    W.put(`${a.dir}/assign.xml`, assignActivityXml({ aid: a.aid, mid: a.mid, ctx: a.ctx, name, introHtml, ts, delivery: d, duedate: assignDueDate(courseStartDate, d.dueOffsetDays), pluginConfigId: assignPluginConfigId }));
    assignPluginConfigId += ASSIGN_PLUGIN_CONFIG_COUNT;
    // Completion al ENVIAR (completionsubmit 1 en assign.xml): la aprobación del curso sigue siendo solo la nota final (r55).
    W.put(`${a.dir}/module.xml`, applyXmlFields(withIdnumber(moduleXml(a.mid, 'assign', secnum, ts, MV.bv), idnumber), { completion: '2', completionview: '0', downloadcontent: '0' }));
    if (d.graded) {
      assignsGraded++;
      const gi = W.nextGradeItem();
      W.put(`${a.dir}/grades.xml`, assignGradeItemXml({
        gradeItemId: gi.id, itemName: name, aid: a.aid, ts, grademax: d.maxGrade as number, gradepass: d.gradepass as number,
        categoryId: CAT_ID[d.category as AssessmentCategoryKey], sortorder: gi.sortorder,
      }));
      W.put(`${a.dir}/inforef.xml`, inforef(fileIds, [gi.id]));
      if (d.rubric) {
        const criteria = rubricCriteriaFromApplication(doc);
        if (criteria.length) {
          const g = assignRubricGradingXml({
            areaId: gradingSeq, definitionId: gradingSeq, criterionId: rubricCriterionId, levelId: rubricLevelId,
            name: `Rúbrica · ${name}`.slice(0, 255), description: 'Rúbrica hecha con los criterios de evaluación de la Actividad de Aplicación.', criteria, ts,
          });
          gradingSeq++;
          rubricCriterionId += g.criteria;
          rubricLevelId += g.levels;
          W.put(`${a.dir}/grading.xml`, g.xml);
          assignsRubric++;
        }
      }
    } else {
      W.put(`${a.dir}/grades.xml`, gradesXml(a.aid));
      W.put(`${a.dir}/inforef.xml`, inforef(fileIds));
    }
    W.boilerplate(a.dir);
    labelsHtml.push({ where: `${idnumber}#intro`, html: introHtml });
    return a;
  };

  // T5 (r57): archivo de trabajo = mod_resource del capítulo (descarga; la AA lo enlaza con $@RESOURCEVIEWBYID*mid@$).
  const resourceMidById = new Map<string, number>();
  const practiceById = new Map(practice.resolved.map((r) => [r.id, r]));
  const addPracticeResource = (secnum: number, chapterId: string, chapterNumber: number, resourceId: string): void => {
    const r = practiceById.get(resourceId);
    const data = practice.bytes.get(resourceId);
    if (!r || !data || r.chapterId !== chapterId) throw new Error(`MBZ_V3_INVARIANT: archivo de trabajo ${resourceId} sin bytes o de otro capítulo`);
    const name = safeActivityName(practiceResourceName(r, chapterNumber), 255);
    const a = W.newActivity('resource', secnum, name, `cv3:ch:${chapterId}:resource:${resourceId}`);
    resourceMidById.set(resourceId, a.mid);
    const intro = practiceResourceIntro(r, chapterNumber, theme);
    const fid = W.addFile(a.ctx, 'mod_resource', 'content', r.filename, data, r.mimetype);
    W.put(`${a.dir}/resource.xml`, `<?xml version="1.0" encoding="UTF-8"?>
<activity id="${a.aid}" moduleid="${a.mid}" modulename="resource" contextid="${a.ctx}">
  <resource id="${a.aid}">
    <name>${xmlEsc(name)}</name>
    <intro>${xmlEsc(intro)}</intro>
    <introformat>1</introformat>
    <tobemigrated>0</tobemigrated>
    <legacyfiles>0</legacyfiles>
    <legacyfileslast>${NULL}</legacyfileslast>
    <display>0</display>
    <displayoptions>a:1:{s:10:"printintro";s:1:"1";}</displayoptions>
    <filterfiles>0</filterfiles>
    <revision>1</revision>
    <timemodified>${ts}</timemodified>
  </resource>
</activity>`);
    W.put(`${a.dir}/module.xml`, applyXmlFields(withIdnumber(moduleXml(a.mid, 'resource', secnum, ts, MV.bv), a.idnumber), { showdescription: '1' }));
    W.put(`${a.dir}/inforef.xml`, inforef([fid]));
    W.put(`${a.dir}/grades.xml`, gradesXml(a.aid));
    W.boilerplate(a.dir);
    labelsHtml.push({ where: `${a.idnumber}#intro`, html: intro });
  };

  const gradedCommon = (a: ActivityRef, kind: AssessableType, name: string, fileIds: number[], qcats: number[] = []): void => {
    const k = resolved.kinds[kind];
    const gi = W.nextGradeItem();
    // r55 (R5/R6): completion = recibir nota (completionpassgrade 0); el gradepass del ítem queda informativo.
    W.put(`${a.dir}/module.xml`, withIdnumber(gradedModuleXml({ mid: a.mid, modname: a.modname as 'quiz' | 'scorm' | 'h5pactivity', secnum: a.secnum, ts, bv: MV.bv, passGradeRequired: false }), a.idnumber));
    W.put(`${a.dir}/grades.xml`, gradeItemXml({
      gradeItemId: gi.id, itemName: name, itemModule: a.modname as 'quiz' | 'scorm' | 'h5pactivity', aid: a.aid, ts,
      grademax: 100, gradepass: k.passingGrade, categoryId: CAT_ID[k.category], sortorder: gi.sortorder,
    }));
    W.put(`${a.dir}/inforef.xml`, inforef(fileIds, [gi.id], qcats));
    W.boilerplate(a.dir);
    graded.push({ moduleId: a.mid, modname: a.modname as 'quiz' | 'scorm' | 'h5pactivity', kind, name });
  };

  const addH5pActivity = (secnum: number, idnumber: string, name: string, kind: AssessableType, itemKey: string, filename: string, h5p: Buffer, mainLibrary: string, intro: (mid: number) => string): void => {
    const a = W.newActivity('h5pactivity', secnum, name, idnumber);
    // V542 I2 (3.8.0): el .h5p SOLO en `package`; el embed inline del intro carga ese mismo archivo
    // (h5pInlineEmbedSrc 'package') → un contenido H5P y un estado xAPI por actividad (antes R8 ponía
    // una segunda copia en `intro`: dos contenidos, «Data Reset» y progreso perdido al alternar).
    const fPkg = W.addFile(a.ctx, 'mod_h5pactivity', 'package', filename, h5p, H5P_PACKAGE_MIMETYPE);
    const introHtml = intro(a.mid);
    W.put(`${a.dir}/h5pactivity.xml`, h5pactivityXml({
      aid: a.aid, mid: a.mid, ctx: a.ctx, name, intro: introHtml, grade: 100,
      grademethod: resolved.kinds[kind].gradeMethod, enabletracking: 1, reviewmode: 1,
      displayoptions: { frame: false, download: false, embed: false, copyright: false }, ts,
    }));
    gradedCommon(a, kind, name, [fPkg]);
    labelsHtml.push({ where: `${idnumber}#intro`, html: introHtml });
    if (kind === 'activity') resolveCta('next-activity', secnum, `$@H5PACTIVITYVIEWBYID*${a.mid}@$`);
    h5pPackages.push({ itemKey, filename, mainLibrary, sha1: sha1Buf(h5p), bytes: h5p.length });
  };

  /**
   * EV6 H5P v2 — add-on SIN nota (Dialog Cards «Repaso»): sin grade item, enabletracking 0,
   * completion 2 por vista (completionview 1), fuera de los criterios de completion del curso
   * y de la agregación del gradebook (no entra en `graded`).
   */
  const addUngradedH5pActivity = (secnum: number, idnumber: string, name: string, itemKey: string, filename: string, h5p: Buffer, mainLibrary: string, intro: (mid: number) => string): void => {
    if (H5P_MOODLE_GRADING[mainLibrary]?.gradable !== false) throw new Error(`MBZ_V3_INVARIANT: ${mainLibrary} no es un add-on sin nota`);
    const a = W.newActivity('h5pactivity', secnum, name, idnumber);
    const fPkg = W.addFile(a.ctx, 'mod_h5pactivity', 'package', filename, h5p, H5P_PACKAGE_MIMETYPE); // V542 I2: sin copia en intro
    const introHtml = intro(a.mid);
    W.put(
      `${a.dir}/h5pactivity.xml`,
      applyXmlFields(
        h5pactivityXml({
          aid: a.aid, mid: a.mid, ctx: a.ctx, name, intro: introHtml, grade: 100,
          grademethod: resolved.kinds.activity.gradeMethod, enabletracking: 1, reviewmode: 1,
          displayoptions: { frame: false, download: false, embed: false, copyright: false }, ts,
        }),
        { grade: '0', enabletracking: '0' },
      ),
    );
    W.put(
      `${a.dir}/module.xml`,
      applyXmlFields(withIdnumber(moduleXml(a.mid, 'h5pactivity', secnum, ts, MV.bv), idnumber), { completion: '2', completionview: '1', showdescription: '1' }),
    );
    W.put(`${a.dir}/grades.xml`, gradesXml(a.aid));
    W.put(`${a.dir}/inforef.xml`, inforef([fPkg]));
    W.boilerplate(a.dir);
    labelsHtml.push({ where: `${idnumber}#intro`, html: introHtml });
    h5pPackages.push({ itemKey, filename, mainLibrary, sha1: sha1Buf(h5p), bytes: h5p.length });
  };
  // r55 (R7): ningún .h5p del curso lleva librerías (todos solo contenido): el store ya no se abre al empaquetar.

  const questionCategories: string[] = [];
  const examBankPlans: ExamBankPlans = {};
  const addQuiz = (
    secnum: number,
    idnumber: string,
    name: string,
    kind: 'exam' | 'finalExam',
    src: ExamSource,
    stampSeed: string,
    bankGroups: Array<{ ownerId: string; name: string }>,
  ): ActivityRef => {
    const a = W.newActivity('quiz', secnum, name, idnumber);
    const k = resolved.kinds[kind];
    const q = buildQuizV3({
      aid: a.aid, mid: a.mid, ctx: a.ctx, name, introHtml: `<p>${esc(name)}</p>`,
      ...(src.kind === 'bank' ? { bank: { doc: src.bank, groups: bankGroups } } : { gift: src.gift }),
      attempts: k.attempts, grademethod: k.gradeMethod, ts, stampSeed, ids,
      // QUIZFB: «aprobaste / todavía no» al terminar el intento (la nota por pregunta sigue oculta mientras está abierto).
      feedbackBands: examOverallFeedbackBands(k.passingGrade, k.attempts),
    });
    // Fix 1 (M5): los slots del quiz y las «preguntas» que anuncia el shell (facts) salen de la misma
    // fuente; si difieren, el texto del curso mentiría → falla fuerte.
    const announced = kind === 'finalExam' ? facts.finalExam.questionCount : facts.modules.find((x) => `cv3:exam:${x.id}` === idnumber)?.examQuestionCount;
    if (q.questionCount !== announced) {
      throw new Error(`MBZ_V3_INVARIANT: ${idnumber} tiene ${q.questionCount} slots pero facts anuncia ${announced} preguntas`);
    }
    W.put(`${a.dir}/quiz.xml`, q.quizXml);
    if (src.kind === 'bank') examBankPlans[idnumber] = q.leaves ?? [];
    questionCategories.push(q.questionCategoriesXml);
    gradedCommon(a, kind, name, [], q.categoryIds);
    resolveCta('next-exam', secnum, `$@QUIZVIEWBYID*${a.mid}@$`);
    return a;
  };

  // EV6 P2-B4: «Respuestas explicadas» justo después del quiz (misma sección), gated por su completion.
  const addExplanationsPage = (
    quiz: ActivityRef,
    idnumber: string,
    scope: { kind: 'module'; moduleNumber: number; title: string } | { kind: 'final' },
    src: ExamSource,
    bankGroups: Array<{ ownerId: string; name: string }>,
    attempts: number,
  ): ActivityRef => {
    const page = src.kind === 'bank'
      ? examExplanationsBankPage({ scope, bank: src.bank, groups: bankGroups }, theme)
      : examExplanationsGiftPage({ scope, questions: parseGIFT(src.gift) }, theme);
    const a = W.newActivity('page', quiz.secnum, page.name, idnumber);
    W.put(`${a.dir}/page.xml`, `<?xml version="1.0" encoding="UTF-8"?>
<activity id="${a.aid}" moduleid="${a.mid}" modulename="page" contextid="${a.ctx}">
  <page id="${a.aid}">
    <name>${xmlEsc(page.name)}</name>
    <intro></intro>
    <introformat>1</introformat>
    <content>${xmlEsc(page.html)}</content>
    <contentformat>1</contentformat>
    <legacyfiles>0</legacyfiles>
    <legacyfileslast>${NULL}</legacyfileslast>
    <display>0</display>
    <displayoptions>a:2:{s:10:"printintro";i:0;s:17:"printlastmodified";i:0;}</displayoptions>
    <revision>1</revision>
    <timemodified>${ts}</timemodified>
  </page>
</activity>`);
    // r55 (R6): abre SOLO al usar todos los intentos (completion del quiz con completionminattempts = intentos);
    // con intentos ilimitados va oculta (visible=0) hasta que el docente la muestre. El builder no fija `timeclose`.
    const availability = examExplanationsAvailability(quiz.mid, attempts, 0);
    W.put(`${a.dir}/module.xml`, applyXmlFields(withIdnumber(moduleXml(a.mid, 'page', quiz.secnum, ts, MV.bv), idnumber), {
      completion: '0',
      // XML: el JSON va escapado (& < >) — un `"op":"&"` o un `"d":">="` crudos abortan la restauración (moodle-versions.md).
      ...(availability === null ? { visible: '0', visibleold: '0' } : { availability: xmlTextEsc(availability) }),
      downloadcontent: '0',
    }));
    W.put(`${a.dir}/inforef.xml`, inforef([]));
    W.put(`${a.dir}/grades.xml`, gradesXml(a.aid));
    W.boilerplate(a.dir);
    return a;
  };
  // EV6 P2-B4 (ruling 3): con certificado la nota para docentes va en su label oculto del cierre; sin
  // él, un label oculto propio al INICIO de la primera sección con una evaluación.
  const willHaveCertificate = !!plan.keys.finalExam;
  let examsTeacherPlaced = false;
  const addExamsTeacherLabel = (secnum: number): void => {
    if (willHaveCertificate || examsTeacherPlaced) return;
    if ((W.sectionSeq.get(secnum) ?? []).length) throw new Error('MBZ_V3_INVARIANT: la nota para docentes de las evaluaciones debe ser lo primero de su sección');
    const t = addLabel(secnum, 'cv3:shell:exams_teacher', examsTeacherLabel(facts, theme, opts));
    W.put(`${t.dir}/module.xml`, applyXmlFields(withIdnumber(moduleXml(t.mid, 'label', secnum, ts, MV.bv), t.idnumber), { visible: '0', visibleold: '0' }));
    examsTeacherPlaced = true;
  };

  // ── Sección 0 — shell ────────────────────────────────────────────────────
  // UX r18 (problema 1): Moodle 4.5 pinta el nombre de la sección 0 como encabezado (núcleo); el hero
  // con tema va JUSTO debajo (primer módulo de la sección) y el foro de avisos cierra la sección.
  addLabel(0, 'cv3:shell:welcome', welcomeLabel(facts, courseIntro, theme, opts, input.qaPreviewNotice === true));
  addLabel(0, 'cv3:shell:audio_welcome', audioWelcomeLabel(facts, theme, opts), [
    { name: SHELL_AUDIO_WELCOME_FILE, data: c.audioWelcome, mime: 'audio/mp3' },
  ]);
  addLabel(0, 'cv3:shell:competencies', competenciesLabel(facts, courseIntro, theme, opts));
  addLabel(0, 'cv3:shell:methodology', methodologyLabel(facts, courseIntro, theme, opts));
  addLabel(0, 'cv3:shell:start', welcomeStartLabel(firstChapterSection as number, facts, theme, opts));
  // T6 (r57): «Guía del docente» (opt-in del perfil): página OCULTA solo para docentes, antes del foro de avisos.
  if (facts.teacherGuide === true) {
    const guide = teacherGuidePage({ facts, resolved, blueprint, applications: c.applications ?? null }, theme);
    addPage(0, TEACHER_GUIDE_IDNUMBER, { name: safeActivityName(guide.name), html: guide.html }, [], { teacherOnly: true });
  }
  {
    const name = '📢 Avisos del Curso';
    const a = W.newActivity('forum', 0, name, 'cv3:shell:forum');
    W.put(`${a.dir}/forum.xml`, forumXml(a.aid, a.mid, a.ctx, name, ts));
    W.put(`${a.dir}/module.xml`, withIdnumber(moduleXml(a.mid, 'forum', 0, ts, MV.bv), a.idnumber));
    W.put(`${a.dir}/inforef.xml`, inforefXml());
    W.put(`${a.dir}/grades.xml`, gradesXml(a.aid));
    W.put(`${a.dir}/posts.xml`, '<?xml version="1.0" encoding="UTF-8"?><posts></posts>');
    W.put(`${a.dir}/subscribers.xml`, '<?xml version="1.0" encoding="UTF-8"?><subscribers></subscribers>');
    W.put(`${a.dir}/discussions.xml`, '<?xml version="1.0" encoding="UTF-8"?><discussions></discussions>');
    W.boilerplate(a.dir);
  }

  // ── Sección 1 — ruta, Libro Guía, audiolibro ─────────────────────────────
  addLabel(1, 'cv3:shell:route', routeLabel(facts, theme, opts));
  let libroMid: number;
  {
    const name = '📘 Libro Guía';
    const a = W.newActivity('resource', 1, name, 'cv3:shell:libro');
    libroMid = a.mid;
    // #583 (M5/M6, builder 3.11.0): la tarjeta del Libro Guía es la DESCRIPCIÓN del recurso (showdescription),
    // no un label aparte: la sección 1 muestra una sola entrada del Libro Guía.
    // r19 (L4, 3.13.0): con el botón «Abrir Libro Guía →» hacia su PROPIO moduleid, en una pestaña nueva.
    const libroIntro = libroResourceIntro(facts, theme, opts, a.mid).html;
    labelsHtml.push({ where: 'cv3:shell:libro#intro', html: libroIntro });
    // r19 (L1/L5): el PDF es el único archivo del recurso (display 5 → view.php lo entrega y el navegador lo muestra).
    const fid = W.addFile(a.ctx, 'mod_resource', 'content', libroFilename, libro.pdf, LIBRO_PDF_MIMETYPE);
    W.put(`${a.dir}/resource.xml`, `<?xml version="1.0" encoding="UTF-8"?>
<activity id="${a.aid}" moduleid="${a.mid}" modulename="resource" contextid="${a.ctx}">
  <resource id="${a.aid}">
    <name>${xmlEsc(name)}</name>
    <intro>${xmlEsc(libroIntro)}</intro>
    <introformat>1</introformat>
    <tobemigrated>0</tobemigrated>
    <legacyfiles>0</legacyfiles>
    <legacyfileslast>${NULL}</legacyfileslast>
    <display>5</display>
    <displayoptions>a:1:{s:10:"printintro";s:1:"0";}</displayoptions>
    <filterfiles>0</filterfiles>
    <revision>1</revision>
    <timemodified>${ts}</timemodified>
  </resource>
</activity>`);
    // F1 (I3): en un curso sin nota el Libro Guía es el criterio de completion (por vista).
    const libroModule = applyXmlFields(withIdnumber(moduleXml(a.mid, 'resource', 1, ts, MV.bv), a.idnumber), { showdescription: '1' });
    W.put(`${a.dir}/module.xml`, resolved.withoutGrades ? applyXmlFields(libroModule, { completion: '2', completionview: '1' }) : libroModule);
    W.put(`${a.dir}/inforef.xml`, inforef([fid]));
    W.put(`${a.dir}/grades.xml`, gradesXml(a.aid));
    W.boilerplate(a.dir);
  }
  addLabel(1, 'cv3:shell:audiobook', audiobookLabel(facts, theme, opts), [
    { name: SHELL_AUDIOBOOK_FILE, data: audiobook.buffer, mime: 'audio/mp3' },
  ]);
  addLabel(1, 'cv3:shell:route_start', routeStartLabel(firstChapterSection as number, facts, theme, opts));

  // ── EV6: una sección por capítulo (+ una por evaluación de módulo) ──────
  const chapterSlots = new Map(assembled.map((x) => [x.chapterNumber, x.slots]));
  for (const m of plan.modules) {
    const mf = facts.modules.find((x) => x.id === m.moduleId);
    if (!mf) throw new Error(`MBZ_V3_INVARIANT: módulo ${m.moduleId} ausente en facts`);
    addLabel(m.firstSectionNum, `cv3:module_intro:${m.moduleId}`, moduleIntroLabel(mf, moduleIntros.get(m.moduleId) as ModuleIntroV3, facts, theme, opts));
    for (const ch of m.chapters) {
      const sec = ch.sectionNum;
      const slots = chapterSlots.get(ch.chapterNumber);
      if (!slots) throw new Error(`MBZ_V3_INVARIANT: capítulo ${ch.chapterNumber} sin slots`);
      const cf = facts.chapters.find((x) => x.id === ch.chapterId);
      if (!cf) throw new Error(`MBZ_V3_INVARIANT: capítulo ${ch.chapterId} ausente en facts`);
      const idp = `cv3:ch:${ch.chapterId}`;
      for (const slot of slots) {
        if (slot.kind === 'label') {
          addLabel(sec, `${idp}:${slot.role}`, { name: slot.name, html: slot.html });
          continue;
        }
        if (slot.kind === 'presentation') {
          const pres = c.presentations.get(ch.chapterId) as { pdf: Buffer; cover: Buffer; mock?: boolean };
          if (pres.mock) mockPresentationChapters.push(ch.chapterId);
          const cover = downscaleCoverPng(pres.cover);
          if (!cover.downscaled && cover.reason !== 'already_small') {
            warnings.push(`cover_not_downscaled:${ch.keys.presentation}:${cover.reason}`);
          }
          const pdfName = `capitulo-${ch.chapterNumber}-presentacion.pdf`;
          const pngName = `capitulo-${ch.chapterNumber}-portada.png`;
          const html = presentationCardHtml({
            chapterNumber: ch.chapterNumber,
            chapterTitle: ch.title,
            coverUrl: `@@PLUGINFILE@@/${pngName}`,
            pdfUrl: `@@PLUGINFILE@@/${pdfName}`,
            slideCount: cf.slideCount,
            theme,
            moduleColor: moduleColor(theme, m.moduleNumber - 1),
            ...(level ? { level } : {}),
          });
          addLabel(sec, `${idp}:presentation`, { name: `Capítulo ${ch.chapterNumber} · Presentación`, html }, [
            { name: pngName, data: cover.png, mime: 'image/png' },
            { name: pdfName, data: pres.pdf, mime: 'application/pdf' },
          ]);
          continue;
        }
        if (slot.kind === 'video_h5p') {
          const video = c.videos.get(ch.chapterId) as { youtubeId: string; durationSec: number };
          const key = ch.keys.video as string;
          const built = await buildVideoActivity({
            itemKey: key,
            // El título del capítulo puede superar el máximo de H5P (200): se normaliza, no se rechaza el paquete.
            title: h5pTitle(ch.title),
            youtubeId: video.youtubeId,
            durationSec: video.durationSec,
            interactionsDoc: c.videoInteractions.get(ch.chapterId),
            // EV6 IV avanzado: solo Manifests con features.ivAdvanced = 1 (schemaVersion 2).
            ...(manifest.features?.ivAdvanced === 1 ? { ivAdvanced: true } : {}),
          });
          assertH5pGradableInMoodle('H5P.InteractiveVideo');
          const filename = videoPackageFilename(key);
          const name = safeActivityName(`Video interactivo · Capítulo ${ch.chapterNumber}: ${ch.title}`);
          addH5pActivity(sec, `${idp}:video`, name, 'video', key, filename, built.h5p, 'H5P.InteractiveVideo', (mid) =>
            videoInlineIntroHtml({ packageFilename: filename, title: ch.title, activityMid: mid, youtubeId: video.youtubeId, theme: introTheme, embed: 'package' }),
          );
          continue;
        }
        if (slot.kind === 'review_cards') {
          const deck = reviewDecks.get(ch.chapterId);
          if (!deck || cf.reviewCards !== true) throw new Error(`MBZ_V3_INVARIANT: «Repaso» del capítulo ${ch.chapterNumber} sin mazo`);
          const key = `review_cards:${ch.chapterId}`;
          const filename = activityPackageFilename(key);
          // r55 (R7): «Repaso» solo contenido (H5P.Dialogcards 1.9 viene en el pack v3 del sitio). Antes llevaba
          // la carpeta H5P.Dialogcards-1.9 (clausura parcial): colgaba el validador de H5P de Moodle en procesos que
          // despliegan varios paquetes con dueños mixtos y no le servía a un docente (dialogcards-diagnosis.md).
          const h5p = await buildContentOnlyH5p({
            mainLibrary: deck.mainLibrary,
            content: deck.content,
            title: deck.title,
            language: 'es',
            profile: CURSIA_H5P_PROFILE_V3,
          });
          const name = safeActivityName(`Repaso · Capítulo ${ch.chapterNumber}: ${ch.title}`);
          addUngradedH5pActivity(sec, `${idp}:review_cards`, name, key, filename, h5p, deck.mainLibrary, (mid) =>
            reviewCardsIntroHtml({ packageFilename: filename, title: deck.title, activityMid: mid, theme: introTheme, frame: frameFor(ch.chapterNumber) }),
          );
          continue;
        }
        if (slot.kind === 'guided_practice') {
          // Loop 9 B: página visible «Práctica guiada — <capítulo>» (formativa, completion por vista), sin archivos.
          const doc = guidedDocs.get(ch.chapterId);
          if (!doc || cf.guidedPracticeMinutes === undefined) throw new Error(`MBZ_V3_INVARIANT: práctica guiada del capítulo ${ch.chapterNumber} sin documento`);
          const tone = moduleTone(theme, moduleColor(theme, m.moduleNumber - 1), groundColor(theme));
          const page = guidedPracticePage({ chapterId: ch.chapterId, chapterNumber: ch.chapterNumber, chapterTitle: ch.title, doc, tone }, theme);
          addPage(sec, `${idp}:guided_practice`, { name: safeActivityName(page.name), html: page.html }, [], { completionView: true });
          continue;
        }
        if (slot.kind === 'practice_resource') {
          addPracticeResource(sec, ch.chapterId, ch.chapterNumber, slot.resourceId);
          continue;
        }
        if (slot.kind === 'application') {
          // Fase 2: página del estudiante (visible, con su PDF imprimible) + solucionario docente (OCULTO, con su PDF).
          const doc = c.applications?.get(ch.chapterId);
          if (!doc || cf.applicationMinutes === undefined) throw new Error(`MBZ_V3_INVARIANT: Actividad de Aplicación del capítulo ${ch.chapterNumber} sin documento`);
          const tone = moduleTone(theme, moduleColor(theme, m.moduleNumber - 1), groundColor(theme));
          const studentPdfName = `capitulo-${ch.chapterNumber}-actividad-de-aplicacion.pdf`;
          const teacherPdfName = `capitulo-${ch.chapterNumber}-solucionario-docente.pdf`;
          const pdfIn = { courseTitle: plan.course.title, chapterNumber: ch.chapterNumber, chapterTitle: ch.title, doc, theme, documentKey: ch.keys.application };
          const studentPdf = await renderApplicationPdf(pdfIn, 'student');
          const teacherPdf = await renderApplicationPdf(pdfIn, 'teacher');
          for (const r of [studentPdf, teacherPdf]) if (r.unmappedChars > 0) warnings.push(`application_chars_unmapped:${ch.keys.application}:${r.unmappedChars}`);
          // T5 (r57): archivos de trabajo de la AA (ya creados en la sección, antes de la actividad) → enlaces en la actividad.
          const appResources = (cf.resources ?? []).filter((r) => r.relation === 'application').map((r) => {
            const mid = resourceMidById.get(r.id);
            if (mid === undefined) throw new Error(`MBZ_V3_INVARIANT: archivo de trabajo ${r.id} no creado antes de su Actividad de Aplicación`);
            return { title: r.title, instructions: r.instructions, filename: r.filename, href: `$@RESOURCEVIEWBYID*${mid}@$` };
          });
          const pageIn = { chapterId: ch.chapterId, chapterNumber: ch.chapterNumber, chapterTitle: ch.title, doc, tone, ...(appResources.length ? { resources: appResources } : {}) };
          if (cf.applicationDelivery?.mode === 'assign') {
            // T4 (r57): Tarea de Moodle con la AA como descripción (+ «Cómo entregar») y el PDF del estudiante en `intro`.
            const d = resolved.application;
            if (!d) throw new Error('MBZ_V3_INVARIANT: capítulo con Tarea sin entrega resuelta');
            const delivery: ApplicationDeliveryText = {
              onlineText: d.submission.onlineText, file: d.submission.file, maxFiles: d.submission.maxFiles,
              maxMegabytes: deliveryMegabytes(d.submission.maxBytes), fileTypes: d.submission.fileTypes,
              dueOffsetDays: d.dueOffsetDays, graded: d.graded, maxGrade: d.maxGrade, rubric: d.graded && d.rubric,
            };
            const student = applicationStudentPage({ ...pageIn, pdfFilename: studentPdfName, delivery }, theme);
            addAssign(sec, `${idp}:application`, safeActivityName(student.name), student.html, [{ name: studentPdfName, data: studentPdf.pdf, mime: 'application/pdf' }], doc);
          } else {
            const student = applicationStudentPage({ ...pageIn, pdfFilename: studentPdfName }, theme);
            addPage(sec, `${idp}:application`, { name: safeActivityName(student.name), html: student.html }, [{ name: studentPdfName, data: studentPdf.pdf, mime: 'application/pdf' }], { completionView: true });
          }
          const teacher = applicationSolutionPage({ ...pageIn, pdfFilename: teacherPdfName }, theme);
          addPage(sec, `${idp}:application_solution`, { name: safeActivityName(teacher.name), html: teacher.html }, [{ name: teacherPdfName, data: teacherPdf.pdf, mime: 'application/pdf' }], { teacherOnly: true });
          continue;
        }
        // slot.kind === 'activity'
        const act = c.activities.get(ch.chapterId) as ActivityContentV3;
        const key = ch.keys.activity as string;
        const name = safeActivityName(`Actividad práctica · Capítulo ${ch.chapterNumber}: ${ch.title}`);
        // UX r18 (problema 4) + fix 1 (M1): el builder decide con el MISMO predicado que el ensamblador
        // (`activityEmbedsInline`: sin botón «Iniciar actividad» cuando la actividad va embebida). Embebida → intro
        // con el reproductor (hoy solo sabe embeber H5P); no embebida → se abre aparte (hoy solo SCORM). Si el
        // predicado y lo que el builder sabe construir divergen, falla fuerte en vez de dejar una práctica sin acceso.
        if (activityEmbedsInline(act.variant)) {
          if (act.variant !== 'h5p') throw new Error(`MBZ_V3_INVARIANT: la actividad ${act.variant} se declara embebida pero el builder solo embebe H5P`);
          const built = await buildActivityH5p(
            act.payload,
            ch.chapterId,
            key,
            resolved.kinds.activity.passingGrade,
            cf.activityType,
            manifest.features?.activityTypeRules,
          );
          const filename = activityPackageFilename(key);
          addH5pActivity(sec, `${idp}:activity`, name, 'activity', key, filename, built.h5p, built.mainLibrary, (mid) =>
            h5pActivityInlineIntroHtml({ packageFilename: filename, title: ch.title, activityMid: mid, theme: introTheme, frame: frameFor(ch.chapterNumber) }),
          );
        } else {
          if (act.variant !== 'scorm') throw new Error(`MBZ_V3_INVARIANT: la actividad ${(act as { variant: string }).variant} no se embebe y el builder solo abre aparte un SCORM`);
          const a = W.newActivity('scorm', sec, name, `${idp}:activity`);
          const mids = parseScormManifestIds(act.manifestXml);
          const zipName = `actividad-capitulo-${ch.chapterNumber}.zip`;
          const zipData = await scormZip(mids.launch, act.html, act.manifestXml);
          const fileIds = [
            W.addFile(a.ctx, 'mod_scorm', 'content', 'imsmanifest.xml', act.manifestXml, 'application/xml'),
            W.addFile(a.ctx, 'mod_scorm', 'content', mids.launch, act.html, 'text/html'),
            W.addDirEntry(a.ctx, 'mod_scorm', 'content'),
            W.addFile(a.ctx, 'mod_scorm', 'package', zipName, zipData, 'application/zip'),
            W.addDirEntry(a.ctx, 'mod_scorm', 'package'),
          ];
          const introHtml = scormIntroHtml(introTheme, frameFor(ch.chapterNumber));
          const k = resolved.kinds.activity;
          W.put(`${a.dir}/scorm.xml`, scormActivityXmlV3({
            aid: a.aid, mid: a.mid, ctx: a.ctx, name, introHtml, zipName, zipHash: sha1Buf(zipData), ids: mids,
            scoOrg: ids.take('sco'), scoItem: ids.take('sco'), scoD1: ids.take('scodata'), scoD2: ids.take('scodata'),
            whatgrade: k.gradeMethod, maxattempt: k.attempts, ts,
          }));
          gradedCommon(a, 'activity', name, fileIds);
          labelsHtml.push({ where: `${idp}:activity#intro`, html: introHtml });
          resolveCta('next-activity', sec, `$@SCORMVIEWBYID*${a.mid}@$`);
        }
      }
    }
    // Sección «Módulo m · Evaluación» (solo si el módulo tiene examen). EV6 fix 1 (I1): SIN examen
    // no hay label module_next — el botón del cierre de su último capítulo ya es el siguiente paso
    // (antes quedaban dos botones iguales seguidos).
    if (!m.keys.exam) continue;
    const nextSec = m.examSectionNum as number;
    if (!Number.isInteger(nextSec)) throw new Error(`MBZ_V3_INVARIANT: módulo ${m.moduleId} con examen sin sección`);
    addExamsTeacherLabel(nextSec);
    addLabel(nextSec, `cv3:exam_info:${m.moduleId}`, examInfoLabel(mf, facts, theme, opts));
    const examSrc = examSources.modules.get(m.moduleId) as ExamSource;
    const examGroups = m.chapters.map((ch) => ({ ownerId: ch.chapterId, name: `Capítulo ${ch.chapterNumber}: ${ch.title}` }));
    const quiz = addQuiz(
      nextSec,
      `cv3:exam:${m.moduleId}`,
      safeActivityName(`Evaluación del módulo ${m.moduleNumber}: ${m.title}`),
      'exam',
      examSrc,
      m.keys.exam,
      examGroups,
    );
    addExplanationsPage(quiz, `cv3:exam_explanations:${m.moduleId}`, { kind: 'module', moduleNumber: m.moduleNumber, title: m.title }, examSrc, examGroups, resolved.kinds.exam.attempts);
    // Edu EV3 / EV6: tras la evaluación → botón al primer capítulo del módulo siguiente, o a la
    // evaluación final / cierre.
    const nextPlan = plan.modules[plan.modules.indexOf(m) + 1];
    const nextFacts = nextPlan ? facts.modules.find((x) => x.id === nextPlan.moduleId) : undefined;
    if (nextPlan && !nextFacts) throw new Error(`MBZ_V3_INVARIANT: módulo ${nextPlan.moduleId} ausente en facts`);
    addLabel(
      nextSec,
      `cv3:module_next:${m.moduleId}`,
      moduleNextLabel(
        mf,
        nextPlan && nextFacts
          ? { kind: 'module', module: nextFacts, sectionNum: nextPlan.firstSectionNum }
          : { kind: 'closing', sectionNum: plan.finalExamSectionNum ?? plan.closingSectionNum },
        facts,
        theme,
        opts,
      ),
    );
  }

  // ── EV6: «Evaluación final» (si hay) y, al final, «Cierre del curso» ────
  const closing = plan.closingSectionNum;
  if (plan.keys.finalExam) {
    const fsec = plan.finalExamSectionNum;
    if (fsec === null || !(fsec < closing)) throw new Error('MBZ_V3_INVARIANT: la evaluación final debe ir antes del cierre');
    addExamsTeacherLabel(fsec);
    addLabel(fsec, 'cv3:final_exam_info', finalExamInfoLabel(facts, theme, opts));
    const finalSrc = examSources.final as ExamSource;
    const finalGroups = plan.modules.map((m) => ({ ownerId: m.moduleId, name: `Módulo ${m.moduleNumber}: ${m.title}` }));
    const quiz = addQuiz(fsec, 'cv3:final_exam', 'Evaluación final', 'finalExam', finalSrc, plan.keys.finalExam, finalGroups);
    addExplanationsPage(quiz, 'cv3:final_exam_explanations', { kind: 'final' }, finalSrc, finalGroups, resolved.kinds.finalExam.attempts);
    addLabel(fsec, 'cv3:final_exam_next', finalExamNextLabel(closing, facts, theme, opts));
  }
  // r55 (R3): completion del curso. Con nota: UN solo criterio, el de nota del curso (tipo 6, gradepass = nota
  // mínima del curso = gradepass del ítem del curso), sin criterios de actividad. Sin nota: el Libro Guía por vista
  // (comportamiento F1 de siempre, sin insignia). La insignia-certificado se otorga al completar el curso.
  const finalExamMid = W.activities.find((a) => a.idnumber === 'cv3:final_exam')?.mid ?? null;
  const completionCriteria: Array<{ moduleId: number; modname: 'quiz' | 'scorm' | 'h5pactivity' | 'resource' }> = resolved.withoutGrades
    ? [{ moduleId: libroMid, modname: 'resource' as const }]
    : completionCriteriaFor(graded.map((g) => ({ moduleId: g.moduleId, modname: g.modname, kind: g.kind })), resolved.courseCompletion);
  if (!resolved.withoutGrades) {
    if (graded.length + assignsGraded === 0) throw new Error('MBZ_V3_INVARIANT: curso con nota sin ítems calificables');
    if (completionCriteria.length !== 0) throw new Error('MBZ_V3_INVARIANT: un curso con nota no lleva criterios de actividad (solo la nota final)');
    if (resolved.courseCompletion.requireCourseGradePass !== true) throw new Error('MBZ_V3_INVARIANT: curso con nota sin criterio de nota del curso');
    if (!(resolved.courseCompletion.courseGradepass > 0) || resolved.courseCompletion.courseGradepass !== resolved.courseGradepass) {
      throw new Error('MBZ_V3_INVARIANT: el criterio de nota del curso debe usar la nota mínima del curso (> 0) del gradebook');
    }
    if (facts.assessment.coursePassingGrade !== resolved.courseGradepass) throw new Error('MBZ_V3_INVARIANT: facts y el gradebook no coinciden en la nota mínima del curso');
  } else if (resolved.courseCompletion.requireCourseGradePass) {
    throw new Error('MBZ_V3_INVARIANT: un curso sin nota no lleva criterio de nota');
  }
  // Fix round 1b (decisión M5, flujo «Evaluación final → Cierre → Certificado»): insignia, panel y label para
  // docentes SOLO si hay evaluación final. r55: la insignia exige el criterio de nota (siempre, con nota).
  const hasCertificate = finalExamMid !== null && resolved.courseCompletion.requireCourseGradePass === true;
  const certificateReq = hasCertificate ? courseApprovalRequirements(facts) : null;
  const certificate = hasCertificate;
  if (hasCertificate !== willHaveCertificate) throw new Error('MBZ_V3_INVARIANT: certificado ≠ evaluación final (nota para docentes de las evaluaciones mal ubicada)');
  if (!hasCertificate && (facts.counts.exams > 0) !== examsTeacherPlaced) throw new Error('MBZ_V3_INVARIANT: nota para docentes de las evaluaciones ausente o sobrante');
  if (!hasCertificate) warnings.push('certificate_omitted:no_final_exam');
  addLabel(closing, 'cv3:shell:closing', closingLabel(facts, courseIntro, theme, opts, certificate));
  // Fix 0b: Moodle restaura la insignia DESACTIVADA → label oculto (visible=0) para el docente con
  // el paso único «Habilitar acceso» y el botón a las insignias del curso. El estudiante no lo ve.
  if (hasCertificate) {
    const badgeName = courseBadgeName(safeActivityName(plan.course.title, 254));
    const t = addLabel(closing, 'cv3:shell:certificate_teacher', certificateTeacherLabel(badgeName, facts, theme, opts));
    W.put(`${t.dir}/module.xml`, applyXmlFields(withIdnumber(moduleXml(t.mid, 'label', closing, ts, MV.bv), t.idnumber), { visible: '0', visibleold: '0' }));
  }

  // ── Tokens (fail loud) ───────────────────────────────────────────────────
  const sectionNums = new Set(plan.sections.map((s) => s.sectionNum));
  for (const l of labelsHtml) assertTokensV3(l.html, W.modnameByMid, l.where, sectionNums, MBZ_V3_COURSE_BACKUP_ID);
  if (pendingCtas.length) throw new Error(`MBZ_V3_INVARIANT: botones de navegación sin destino: ${pendingCtas.map((p) => p.name).join(', ')}`);

  // ── Secciones ────────────────────────────────────────────────────────────
  for (const s of plan.sections) {
    const name = safeActivityName(s.title, 255);
    W.put(`sections/section_${s.sectionNum}/section.xml`, sectionXml({ num: s.sectionNum, name, summary: '' }, (W.sectionSeq.get(s.sectionNum) ?? []).join(','), ts));
    W.put(`sections/section_${s.sectionNum}/inforef.xml`, inforefXml());
    W.put(`sections/section_${s.sectionNum}/roles.xml`, BOIL.roles);
    W.put(`sections/section_${s.sectionNum}/filters.xml`, BOIL.filters);
    W.put(`sections/section_${s.sectionNum}/contentbank.xml`, BOIL.contentbank);
  }

  // ── Curso ────────────────────────────────────────────────────────────────
  // EV6 DoD: un paquete de QA lleva el sufijo «[QA — vista previa, no entregable]» (siempre entero).
  // La insignia-certificado conserva el título del curso (no se emite desde un paquete QA a nadie).
  const certificateTitle = safeActivityName(plan.course.title, 254);
  const courseTitle = input.qaPreviewNotice === true
    ? safeActivityName(plan.course.title, 254 - QA_PREVIEW_COURSE_SUFFIX.length) + QA_PREVIEW_COURSE_SUFFIX
    : certificateTitle;
  W.put('course/course.xml', `<?xml version="1.0" encoding="UTF-8"?>
<course id="${MBZ_V3_COURSE_BACKUP_ID}" contextid="${MBZ_V3_COURSE_BACKUP_CONTEXTID}">
  <shortname>${esc(courseTitle)}</shortname><fullname>${esc(courseTitle)}</fullname>
  <idnumber></idnumber><summary></summary><summaryformat>1</summaryformat>
  <format>topics</format><showgrades>1</showgrades><newsitems>5</newsitems>
  <startdate>${courseStartDate}</startdate><enddate>0</enddate><marker>0</marker>
  <maxbytes>0</maxbytes><legacyfiles>0</legacyfiles><showreports>0</showreports>
  <visible>1</visible><groupmode>0</groupmode><groupmodeforce>0</groupmodeforce>
  <defaultgroupingid>0</defaultgroupingid><lang>es</lang><theme></theme>
  <timecreated>${ts}</timecreated><timemodified>${ts}</timemodified>
  <requested>0</requested><showactivitydates>1</showactivitydates>
  <showcompletionconditions>1</showcompletionconditions>
  <pdfexportfont>${NULL}</pdfexportfont>
  <enablecompletion>1</enablecompletion><completionnotify>0</completionnotify>
  <tags></tags><customfields></customfields>
  <courseformatoptions>
    <courseformatoption><format>topics</format><sectionid>0</sectionid><name>coursedisplay</name><value>1</value></courseformatoption>
    <courseformatoption><format>topics</format><sectionid>0</sectionid><name>hiddensections</name><value>1</value></courseformatoption>
  </courseformatoptions>
</course>`);
  W.put('course/inforef.xml', inforefXml());
  W.put('course/enrolments.xml', '<?xml version="1.0" encoding="UTF-8"?>\n<enrolments>\n  <enrols>\n  </enrols>\n</enrolments>');
  W.put('course/roles.xml', BOIL.roles);
  W.put('course/completiondefaults.xml', '<?xml version="1.0" encoding="UTF-8"?>\n<course_completion_defaults>\n</course_completion_defaults>');
  W.put('course/calendar.xml', BOIL.calendar);
  W.put('course/competencies.xml', '<?xml version="1.0" encoding="UTF-8"?>\n<course_competencies>\n  <competencies>\n  </competencies>\n  <user_competencies>\n  </user_competencies>\n</course_competencies>');
  W.put('course/contentbank.xml', BOIL.contentbank);
  W.put('course/filters.xml', BOIL.filters);

  // ── Gradebook + completion del curso (R6) ────────────────────────────────
  W.put('gradebook.xml', gradebookXml({
    ts,
    courseGradepass: resolved.courseGradepass,
    aggregation: 'weighted_mean',
    courseCategoryId: 1,
    courseItemId: 1,
    categories: resolved.categories.map((cat) => ({ id: CAT_ID[cat.key], fullname: cat.fullname, weight: cat.weight, gradeItemId: CAT_ID[cat.key] })),
    ...(resolved.withoutGrades ? { withoutGrades: true } : {}),
  }));
  if (resolved.withoutGrades && graded.length + assignsGraded > 0) {
    throw new Error(`ASSESSMENT_INVALID_FACTS: curso sin nota con ${graded.length + assignsGraded} ítem(s) calificable(s) en el paquete`);
  }
  if (assignsTotal !== (facts.counts.applicationAssigns ?? 0) || assignsGraded !== (facts.counts.applicationAssignsGraded ?? 0)) {
    throw new Error(`MBZ_V3_INVARIANT: ${assignsTotal} Tarea(s) (${assignsGraded} calificadas) ≠ facts ${facts.counts.applicationAssigns ?? 0} (${facts.counts.applicationAssignsGraded ?? 0})`);
  }
  if (resourceMidById.size !== practice.resolved.length) throw new Error(`MBZ_V3_INVARIANT: ${resourceMidById.size} archivo(s) de trabajo publicados ≠ ${practice.resolved.length} resueltos`);
  W.put('completion.xml', courseCompletionXml({
    criteria: completionCriteria,
    aggregation: 'all',
    courseId: MBZ_V3_COURSE_BACKUP_ID,
    requireCourseGradePass: resolved.courseCompletion.requireCourseGradePass,
    courseGradepass: resolved.courseCompletion.courseGradepass,
  }));

  // ── Archivos raíz ────────────────────────────────────────────────────────
  // LOOP 7 (A4 I1): el rol estudiante se define solo si algún solucionario lo usa (paquetes sin Actividades de
  // Aplicación: byte-idénticos a antes).
  W.put('roles.xml', teacherOnlyPages > 0 ? STUDENT_ROLE_DEFINITION_XML : '<?xml version="1.0" encoding="UTF-8"?>\n<roles_definition>\n</roles_definition>');
  W.put('scales.xml', '<?xml version="1.0" encoding="UTF-8"?>\n<scales_definition>\n</scales_definition>');
  W.put('outcomes.xml', '<?xml version="1.0" encoding="UTF-8"?>\n<outcomes_definition>\n</outcomes_definition>');
  // EV6 (T3): certificado = insignia de curso (criterio: completion del curso) + su imagen.
  if (hasCertificate) {
    W.put('badges.xml', courseBadgeXml({
      courseTitle: certificateTitle,
      courseBackupId: MBZ_V3_COURSE_BACKUP_ID,
      requirements: certificateReq as CertificateRequirements,
      ts,
      issuerName: COURSE_BADGE_DEFAULT_ISSUER,
    }));
    for (const img of courseBadgeImages(theme)) {
      W.addFile(MBZ_V3_COURSE_BACKUP_CONTEXTID, 'badges', 'badgeimage', img.filename, img.png, 'image/png', COURSE_BADGE_BACKUP_ID);
    }
  } else {
    W.put('badges.xml', '<?xml version="1.0" encoding="UTF-8"?>\n<badges>\n</badges>');
  }
  W.put('users.xml', '<?xml version="1.0" encoding="UTF-8"?>\n<users>\n</users>');
  W.put('grade_history.xml', BOIL.gradeHistory);
  W.put('groups.xml', '<?xml version="1.0" encoding="UTF-8"?>\n<groups>\n  <groupcustomfields>\n  </groupcustomfields>\n  <groupings>\n    <groupingcustomfields>\n    </groupingcustomfields>\n  </groupings>\n</groups>');
  W.put('questions.xml', `<?xml version="1.0" encoding="UTF-8"?>\n<question_categories>\n${questionCategories.join('')}</question_categories>`);

  let filesXml = '<?xml version="1.0" encoding="UTF-8"?>\n<files>\n';
  for (const f of W.files) {
    filesXml +=
      `  <file id="${f.id}">\n    <contenthash>${f.hash}</contenthash>\n    <contextid>${f.ctx}</contextid>\n` +
      `    <component>${f.component}</component>\n    <filearea>${f.filearea}</filearea>\n    <itemid>${f.itemid ?? 0}</itemid>\n` +
      `    <filepath>/</filepath>\n    <filename>${xmlEsc(f.filename)}</filename>\n    <userid>${NULL}</userid>\n` +
      `    <filesize>${f.size}</filesize>\n    <mimetype>${f.mime ?? NULL}</mimetype>\n    <status>0</status>\n` +
      `    <timecreated>${ts}</timecreated>\n    <timemodified>${ts}</timemodified>\n` +
      `    <source>${NULL}</source>\n    <author>${NULL}</author>\n    <license>${NULL}</license>\n` +
      `    <sortorder>0</sortorder>\n    <repositorytype>${NULL}</repositorytype>\n    <repositoryid>${NULL}</repositoryid>\n    <reference>${NULL}</reference>\n  </file>\n`;
  }
  W.put('files.xml', `${filesXml}</files>`);

  // ── moodle_backup.xml ────────────────────────────────────────────────────
  const setting = (lvl: string, extra: string, n: string, v: string | number) =>
    `    <setting>\n      <level>${lvl}</level>\n${extra}      <name>${n}</name>\n      <value>${v}</value>\n    </setting>\n`;
  let sett = '';
  const rootSettings: Record<string, string> = {
    filename: `cursia-v3-${plan.course.id}.mbz`, imscc11: '0', users: '0', anonymize: '0', role_assignments: '0',
    activities: '1', blocks: '0', files: '1', filters: '1', comments: '0', badges: hasCertificate ? '1' : '0',
    calendarevents: '1', userscompletion: '0', logs: '0', grade_histories: '0',
    questionbank: '1', groups: '0', competencies: '0', customfield: '0',
    contentbankcontent: '0', xapistate: '0', legacyfiles: '1',
  };
  for (const [k, v] of Object.entries(rootSettings)) sett += setting('root', '', k, v);
  for (const s of plan.sections) {
    sett += setting('section', `      <section>section_${s.sectionNum}</section>\n`, `section_${s.sectionNum}_included`, 1);
    sett += setting('section', `      <section>section_${s.sectionNum}</section>\n`, `section_${s.sectionNum}_userinfo`, 0);
  }
  for (const a of W.activities) {
    const pre = `${a.modname}_${a.mid}`;
    sett += setting('activity', `      <activity>${pre}</activity>\n`, `${pre}_included`, 1);
    sett += setting('activity', `      <activity>${pre}</activity>\n`, `${pre}_userinfo`, 0);
  }
  const acts = W.activities
    .map((a) => `      <activity>\n        <moduleid>${a.mid}</moduleid>\n        <sectionid>${a.secnum}</sectionid>\n        <modulename>${a.modname}</modulename>\n        <title>${esc(a.title)}</title>\n        <directory>${a.dir}</directory>\n        <insubsection></insubsection>\n      </activity>\n`)
    .join('');
  const secs = plan.sections
    .map((s) => `      <section>\n        <sectionid>${s.sectionNum}</sectionid>\n        <title>${esc(safeActivityName(s.title, 255))}</title>\n        <directory>sections/section_${s.sectionNum}</directory>\n        <parentcmid></parentcmid>\n        <modname></modname>\n      </section>\n`)
    .join('');
  W.put('moodle_backup.xml', `<?xml version="1.0" encoding="UTF-8"?>
<moodle_backup>
<information>
  <name>cursia-v3-${plan.course.id}.mbz</name>
  <moodle_version>${MV.mv}</moodle_version>
  <moodle_release>${MV.mr}</moodle_release>
  <backup_version>${MV.bv}</backup_version>
  <backup_release>${MV.br}</backup_release>
  <backup_date>${ts}</backup_date>
  <mnet_remoteusers>0</mnet_remoteusers>
  <include_files>1</include_files>
  <include_file_references_to_external_content>0</include_file_references_to_external_content>
  <original_wwwroot>https://cursia.nomaddi.com</original_wwwroot>
  <original_site_identifier_hash>7723815fd5e7880d12bcade15abbbfc8</original_site_identifier_hash>
  <original_course_id>${MBZ_V3_COURSE_BACKUP_ID}</original_course_id>
  <original_course_fullname>${esc(courseTitle)}</original_course_fullname>
  <original_course_shortname>${esc(courseTitle)}</original_course_shortname>
  <original_course_format>topics</original_course_format>
  <original_course_startdate>${courseStartDate}</original_course_startdate>
  <original_course_enddate>0</original_course_enddate>
  <original_course_contextid>${MBZ_V3_COURSE_BACKUP_CONTEXTID}</original_course_contextid>
  <original_system_contextid>${MBZ_V3_SYSTEM_BACKUP_CONTEXTID}</original_system_contextid>
  <details>
    <detail backup_id="cursiav3${plan.course.id}${ts}">
      <type>course</type><format>moodle2</format><interactive>1</interactive>
      <mode>70</mode><execution>2</execution><executiontime>0</executiontime>
    </detail>
  </details>
  <contents>
    <activities>\n${acts}    </activities>
    <sections>\n${secs}    </sections>
    <course>
      <courseid>${MBZ_V3_COURSE_BACKUP_ID}</courseid>
      <title>${esc(courseTitle)}</title>
      <directory>course</directory>
    </course>
  </contents>
  <settings>\n${sett}  </settings>
</information>
</moodle_backup>`);

  // Review r1 (M9): aviso visible por cada enlace muerto reparado (nunca en silencio).
  let deadLinks = 0;
  for (const n of W.deadLinksUnwrapped.values()) deadLinks += n;
  if (deadLinks) warnings.push(`dead_link_unwrapped:${deadLinks}`);
  const mbz = (await W.zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } })) as Buffer;
  return {
    mbz,
    expectations: { facts, resolved, h5pProfileVersion, examBankPlans, shellProseByLabel: shellProseByLabel(courseIntro, moduleIntros), builderVersion: DYNAMIC_MBZ_BUILDER_VERSION_V3, internalVocabularyExempt: vocab.exempt, ...(vocabUserTexts.length ? { internalVocabularyUserTexts: vocabUserTexts } : {}), ...(vocab.keptTexts.length ? { internalVocabularyKeptTexts: vocab.keptTexts } : {}) },
    summary: {
      builderVersion: DYNAMIC_MBZ_BUILDER_VERSION_V3,
      moodleVersion: MV.br,
      planSha256: packagingPlanV3Sha256(plan),
      themeSha256: themeSha256(theme),
      themeFamily: theme.familyId,
      themeMode: theme.mode,
      // UX #5 fix round 1 (M-8): versión REAL del perfil de los .h5p del paquete — 3 si alguno trae librerías
      // incluidas (QuestionSet 1.21, BS o «Repaso», todos armados con CURSIA_H5P_PROFILE_V3); 1 si todos son
      // solo-contenido de v1 (o no hay H5P). No entra en el .mbz ni en la clave de reuse (esa sigue usando
      // `h5pProfileVersion`, la versión de derivación de subContentId; builderVersion ya invalida el reuse).
      h5pProfileVersion: summaryH5pProfileVersion(h5pPackages),
      vcRendererVersion: VC_RENDERER_VERSION,
      h5pPackages,
      mockPresentationChapters,
      pendingVideos: plan.omittedVideos.map((v) => ({
        itemKey: v.videoKey, chapterId: v.chapterId, chapterNumber: v.chapterNumber, title: v.title, notice: noticeChapterIds.includes(v.chapterId),
      })),
      warnings,
      qualityWarnings: [
        ...formulaicOpeningWarnings(plan.modules.flatMap((m) => m.chapters.map((ch) => c.experiences.get(ch.chapterId)))),
        // T1 (r57): la regla de conjunto del banco de examen (≤ 30 % «la correcta es la más larga») sobre TODOS los videos del paquete.
        ...videoMcLengthBiasWarnings(plan.modules.flatMap((m) => m.chapters.filter((ch) => !!ch.keys.video).map((ch) => c.videoInteractions.get(ch.chapterId)))),
      ],
      // r19: piso de 25 min del audiolibro (solo si el empaque pasó los manifiestos; no entra al .mbz).
      ...(audiobook.floor ? { audiobookFloor: audiobook.floor } : {}),
      counts: facts.counts,
      assessment: assessmentPackageSummary(resolved),
      libro: { filename: libroFilename, pageCount: libro.pageCount, wordCount: libro.wordCount, logoSource: libroLogo.source, logoSha256: libroLogo.sha256 },
      ...(assignsTotal ? { applicationAssigns: { count: assignsTotal, graded: assignsGraded, rubric: assignsRubric, category: resolved.application?.category ?? null } } : {}),
      ...(practice.resolved.length
        ? { practiceResources: practice.resolved.map((r) => ({ id: r.id, chapterId: r.chapterId, filename: r.filename, mimetype: r.mimetype, sha256: r.sha256, bytes: r.bytes, origin: r.origin, relation: r.relation })) }
        : {}),
      // r55 (R7): todos los .h5p son solo contenido; con un tipo que no está en el pack v1 (QuestionSet 1.21, BS,
      // «Repaso») la entrega declara el requisito del sitio: Cursia H5P Library Pack v3 (cualquier rol restaura).
      ...(h5pPackages.some((p) => p.mainLibrary in (CURSIA_H5P_PROFILE_V3.deltaByMain ?? {})) ? { restore: H5P_SITE_LIBRARY_PACK_RESTORE_NOTE } : {}),
    },
  };
}

/**
 * EV6 H5P v2 (H2 fix round 1, I-2/M-4): «Repaso» se arma SOLO si el Blueprint lo pide, el Manifest es
 * de H5P v2 (activityTypeRules = 2) y el motor de actividades es h5p. Cualquier otro caso: apagado.
 */
export function reviewCardsApply(blueprint: BlueprintSnapshotV2, manifest: GenerationManifestV1): boolean {
  // Predicado único compartido con el modelo de tiempo (study-time): mismas condiciones en ambos.
  return reviewCardsEnabledFor(blueprint, manifest);
}

/**
 * r55 (R7) — instrucción de entrega para paquetes con tipos H5P que no están en el pack v1 (QuestionSet 1.21, caso
 * ramificado, «Repaso»). Todos los .h5p son solo contenido: el sitio necesita el Cursia H5P Library Pack v3 (lo
 * sube un administrador una vez; `scripts/h5p-preflight-moodle.js --profile v3` lo verifica) y desde ahí cualquier
 * docente restaura. El frontend la muestra en «Cómo restaurarlo en Moodle» (summary.restore del paquete).
 */
export const H5P_SITE_LIBRARY_PACK_RESTORE_NOTE = Object.freeze({
  as: 'site_library_pack' as const,
  libraryPack: 'v3' as const,
  note:
    'Antes de restaurar, el sitio Moodle debe tener instalado el Cursia H5P Library Pack v3 (un administrador lo sube una sola vez en ' +
    'Administración del sitio › H5P › Gestionar tipos de contenido H5P). Con el pack instalado, cualquier docente puede restaurar el curso; ' +
    'sin él, las actividades H5P muestran «Missing main library».',
});

/**
 * @deprecated r55: nota de builders ≤ 3.13.0 (los .h5p llevaban carpetas delta y se pedía restaurar como
 * administrador o gestor). Se conserva solo para leer jobs viejos (packaging.service la acepta).
 */
export const H5P_BUNDLED_RESTORE_NOTE = Object.freeze({
  as: 'admin_or_manager' as const,
  note:
    'Restaura este curso como administrador o gestor: así Moodle instala solo los tipos de contenido H5P que el sitio todavía no tiene. ' +
    'Si lo restaura un docente en un sitio que aún no los tiene, un administrador debe subir antes el Cursia H5P Library Pack v3.',
});

/** @deprecated UX #5 fix round 1 (M-2): nombre histórico (EV6 H5P v2); usar H5P_SITE_LIBRARY_PACK_RESTORE_NOTE. */
export const H5P_V2_RESTORE_NOTE = H5P_BUNDLED_RESTORE_NOTE;

/**
 * UX #5 fix round 1 (M-8): perfil H5P real de un paquete v3 para `summary.h5pProfileVersion`: el del perfil v3
 * si algún .h5p lleva librerías incluidas (todos salen de CURSIA_H5P_PROFILE_V3), si no el de v1.
 */
export function summaryH5pProfileVersion(pkgs: ReadonlyArray<{ mainLibrary: string }>): number {
  // r55: «principal fuera del pack v1» (las claves de deltaByMain de v3 son exactamente esas principales).
  return pkgs.some((p) => p.mainLibrary in (CURSIA_H5P_PROFILE_V3.deltaByMain ?? {})) ? CURSIA_H5P_PROFILE_V3.version : h5pProfileVersion;
}

/** Escape de texto XML sin tocar comillas (el JSON de availability conserva sus `"`). */
export function xmlTextEsc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Librerías del perfil (para el validador): "Machine major.minor". */
export function h5pProfileLibraryKeys(): Set<string> {
  return new Set(CURSIA_H5P_PROFILE_V1.libraries.map((l) => `${l.machineName} ${l.majorVersion}.${l.minorVersion}`));
}
