# Course profile keys and packaging features (commercial-readiness loop r57)

This page lists the opt-in keys added to the course profiles in loop r57 (T1–T6, T8) and the packaging behaviour that
comes with them. Every key is **optional**: with the key absent the profile, its sha, the Manifest and the `.mbz` are
byte-identical to the previous behaviour (each task proves this with a golden in its harness).

Profiles are stored per course in `course_profiles` and saved with `POST /courses/:courseId/profiles/:kind`
(`kind` = `pedagogy` | `assessment` | `presentation`). The frontend panel «Diseño y evaluación»
(`47-course-profiles-panel.js`) writes the same keys and keeps any key it does not show.

| Key | Profile | Changes | Cost to change |
|---|---|---|---|
| `learningPlan` (T2) | pedagogy | learning type per chapter, activity derived from it, methodology phases | new Blueprint → regeneration of the affected items |
| `learningPlan.composition` (T3) | pedagogy | videos by learning need, practice mix by module | new Blueprint (video on/off goes through the normal invalidation) |
| `applicationDelivery` (T4) | assessment | Application Activity as page or Moodle assign (submission, grading, rubric, due date) | repackage only, USD 0 |
| `practiceResources` (T5) | assessment | practice files per chapter as `mod_resource`, linked from the AA | repackage only, USD 0 |
| `teacherGuide` (T6) | assessment | hidden «Guía del docente» page | repackage only, USD 0 |

Assessment-profile keys are packaging inputs: the profile sha is part of the package reuse key, so changing them
rebuilds the `.mbz` without regenerating content.

---

## 1. `learningPlan` (pedagogy profile, T2)

```json
{
  "learningPlan": {
    "framework": "gagne_9_eventos",
    "phaseLabels": true,
    "moduleFrameworks": { "<moduleId>": "teoria_demostracion_practica" },
    "chapterOverrides": { "<chapterId>": { "learningType": "protocolo", "framework": "default" } }
  }
}
```

- `framework`: methodology id from the registry (`modules/pedagogy/instructional-frameworks.ts`): `default`,
  `teoria_demostracion_practica` (TDP) or `gagne_9_eventos`. Methodologies are data, not institution code.
- `phaseLabels` (optional): show the phase names to students in the chapter blocks. Default = the framework's
  `phaseLabelsDefault`.
- `moduleFrameworks` / `chapterOverrides` (optional): per-module methodology; per-chapter learning type
  (`conceptual`, `procedimental`, `protocolo`, `decision_caso`, `comunicacion`, `normativo_etico`) and methodology.
  An override wins over the rule classifier; the dry-run shows both (`source: 'override'`, `suggested`).
- Effect: `chapter.design.learningType` frozen in the Blueprint; the graded H5P activity type is chosen from
  `LEARNING_TYPE_ACTIVITY_RULES`; the generators receive the framework directives.

## 2. `learningPlan.composition` (pedagogy profile, T3)

```json
{
  "learningPlan": {
    "framework": "default",
    "composition": {
      "videos": "by_need",
      "minVideos": 6,
      "maxVideos": 12,
      "practiceMix": { "format": "M", "practicePerModule": 1 }
    }
  }
}
```

- `videos: "by_need"`: video per chapter decided by its learning type (procedural, protocol and communication chapters
  get one; the others are optional within the hours budget of 1 optional video per 5 target hours). Precedence:
  teacher pin > document requirement > `minVideos`/`maxVideos` > «Ajustar» > need > budget. Unmet constraints are
  reported (`unmet`), never dropped.
- `practiceMix`: `{ modules, chaptersPerModule, practiceTotal | audiovisualTotal }` or
  `{ format: 'S'|'M'|'L', practicePerModule | practiceTotal }`. Applies only when the structure's content shape
  matches; document constraints win. Practice-heavy shapes report `cannot_reach_target` instead of padding hours.
- `minVideos` / `maxVideos` / `practiceMix` require `videos: "by_need"` (`COMPOSITION_REQUIRES_BY_NEED`).

## 3. `applicationDelivery` (assessment profile, T4)

```json
{
  "categoryWeights": { "practice": 25, "applications": 20, "moduleExams": 35, "finalExam": 20 },
  "applicationDelivery": {
    "mode": "assign",
    "chapterModes": { "<chapterId>": "page" },
    "submission": { "onlineText": true, "file": true, "maxFiles": 3, "maxBytes": 10485760, "fileTypes": [".pdf", ".docx", ".xlsx"] },
    "dueOffsetDays": 14,
    "grading": { "graded": true, "maxGrade": 100, "gradepass": 60, "category": "applications", "rubric": true }
  }
}
```

- `mode`: `page` (default behaviour) or `assign` (Moodle Tarea); `chapterModes` overrides per chapter.
- `submission`: online text and/or files; `maxFiles` 1–20; `maxBytes` per file, 1 KB–100 MB; `fileTypes` allowlist.
- `dueOffsetDays` (optional): absent or `null` = **no due date** (the default; the panel leaves it empty). With
  1–365, `duedate` = the course `<startdate>` **in the backup** + N days (`assignDueDate`; the backup's
  `<startdate>` and `<original_course_startdate>` are the same value, the packaging clock). When the course is
  restored with a new start date, Moodle shifts every date by (new start − backup start), so the due date stays N days
  after the course start. If the course is restored keeping the backup's start date (e.g. the CLI restore without a
  start date, or «Mantener la fecha de inicio original»), the due date is N days after the **packaging** time and can
  already be in the past: set the course start date on restore, or leave `dueOffsetDays` empty.
- `grading`: `{ "graded": false }` (formative: no grade item, no rubric, feedback comments on) or graded with
  `maxGrade` 1–100, `gradepass` 0–max, `category` `applications` (own gradebook category, needs the `applications`
  weight) or `practice`, `rubric` (one criterion per AA criterion with its weight; levels Insuficiente 0 / En proceso
  ⌊w/2⌋ / Logrado w with **generic** descriptors built from the criterion name; visible to the student after
  grading). The solucionario's correction guide is teacher-only (hidden page + PDF) and never goes into the rubric;
  the teacher material pairs each guide entry with its criterion **by name** (position only as fallback).
- Completion is on submit. The course is still approved only by the final course grade.
- Gradebook before grading (review r1): a **formative** assign has no grade item, so it can never change a grade.
  A **graded** assign is a grade item in its category; v3 categories and the course use `aggregateonlygraded = 0`
  («Solo calificaciones no vacías» = No), so an assign that is submitted but **not yet graded counts as 0** in its
  category and in the course total until the teacher grades it. A student cannot reach the course passing grade
  (and the certificate badge) while graded assigns are pending. Tell clients to grade assigns before judging course
  results; harness `check-review-r1-fixes` (G) asserts both behaviours.

## 4. `practiceResources` (assessment profile, T5)

```json
{
  "practiceResources": [
    {
      "id": "datos-taller", "chapterId": "<chapterId>", "title": "Datos del taller",
      "instructions": "Completa la columna Total.", "relation": "application",
      "source": { "kind": "artifact", "artifactId": "<uuid>", "filename": "datos-taller.xlsx",
                  "mimetype": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "bytes": 1200, "sha256": "<64 hex>" }
    },
    {
      "id": "ventas", "chapterId": "<chapterId>", "title": "Ventas del trimestre", "instructions": "", "relation": "chapter",
      "source": { "kind": "table", "format": "csv", "filename": "ventas.csv", "columns": ["Mes", "Ventas"], "rows": [["Enero", 120]] }
    }
  ]
}
```

- `relation`: `application` (placed before the AA and linked from it) or `chapter` (chapter material).
- `source.kind: artifact`: a `practice_file` artifact of the run owner (uploaded with `artifactUpload`); size, sha256,
  mimetype and format signature are verified at packaging (`PRACTICE_FILE_INVALID` = held for the user). An artifact
  that was deleted, belongs to someone else or is not a `practice_file` fails with `PRACTICE_FILE_MISSING` — same
  class D «package_precheck» group (held for a person: re-attach the file in the profile; never retried alone).
- `source.kind: table`: CSV (RFC 4180 + BOM) or minimal XLSX generated deterministically.
- Allowlist: pdf, docx, xlsx, pptx, odt, ods, odp, csv, txt, zip, png, jpg. Limits: 20 MB per file, 60 MB per course,
  10 files per chapter, 40 per course.

## 5. `teacherGuide` (assessment profile, T6)

```json
{ "teacherGuide": { "include": true } }
```

- Adds the page «Guía del docente (solo docentes)» (`cv3:shell:teacher_guide`) at the end of section 0, before the
  announcements forum. Hidden (`visible=0`, `visibleold=0`) and with the student role's `mod/page:view` prohibited, so
  it stays closed even if a teacher shows it by mistake (verified on a real Moodle 4.5 restore).
- Built deterministically, without LLM, from what the package already has: course summary and estimated hours;
  methodology and its phases (with `learningPlan`); evaluation categories, weights, passing grade, attempts and the
  approval rule; per module and chapter the objective, learning type, resources, the Application Activity (title,
  delivery, product, criteria with weights), the solucionario **by name** (never linked or copied) and the practice
  files; module and final exam question counts.
- `include: false` or the key absent → the `.mbz` is byte-identical to before. Both normalize to the same profile
  (the key is dropped unless `include: true`), so the profile sha is the same and switching it off on a course that
  never had it does not repackage (review r1, M4). The panel offers it under
  «Entrega y archivos de trabajo → Guía del docente».
- Validator rule `TEACHER_GUIDE` (exists ⇔ facts say so, hidden, student prohibited, no grade/completion, names every
  module and chapter, nobody links to it).

---

## 6. Packaging features without a profile key

| Feature | Task | Where |
|---|---|---|
| Internal generator vocabulary repaired before rendering; `INTERNAL_VOCABULARY` validator rule | T1 | `modules/visual-components/internal-vocabulary.ts` |
| Course-level video MC length-bias warning `video_mc_length_bias:k/n` (> 30 % and z > 1.96) | T1 | `modules/quality/answer-length-bias.ts` |
| Generation-time course-wide bias test: claims of `video_interactions` / H5P `activity` carry `claimPayload.answerBiasPool` (signals of the run's completed items); the executor seeds its pool from it and applies the same set rule through the existing soft retry | T6 | `modules/quality/answer-bias-pool.ts`, `scheduler.service.ts`, fe `45-dynamic-generation-executor.js` |
| Packager integrity: orphan/malformed blobs, files without owner or inforef, tokens and `@@PLUGINFILE@@` in page content, dead links (`href="#"`, empty, `javascript:`), `MANIFEST_COVERAGE` (presentation with PDF + cover, video, activity per facts), `content/content.json` in every `.h5p` | T6 | `package/v3/mbz-validator-v3.ts` |
| Package size budget before upload (`PACKAGE_MBZ_MAX_BYTES`, `PACKAGE_MBZ_WARN_BYTES`; job `summary.size`) | T6 | `package/v3/package-size-budget.ts`, `docs/ops/FACTORY-MODE.md` |
| Deploy freeze, default packaging hold per owner, budget limits from env, auto-repackage on builder bump opt-in | T8 | `docs/ops/FACTORY-MODE.md` |
| Builder bump with `DYNAMIC_AUTO_REPACKAGE_ON_BUILDER_BUMP` off: when the **only** difference is the builder version (same content, profiles, theme, Moodle), the package stays fresh — «Curso listo», no `needs_attention`, no «Hay cambios…». `GET …/package` adds `builderUpdateAvailable: { packagedWith, current }` **for SUPER_ADMIN only** (the panel shows an admin notice with «Re-empaquetar con el armado nuevo»); an explicit `POST …/package` builds with the current builder, the automatic packaging reuses the fresh package. Any other change is stale as before; with the flag on, a builder bump repackages as before | review r1 I1 | `package-freshness.ts`, `packaging.service.ts` |
| `INTERNAL_VOCABULARY` judges only **generated** text: text written by a person (Blueprint titles and texts, practice file titles/instructions, assessment profile texts, imported program references, institution name) is never repaired and is removed before the validator looks for terms (`expectations.internalVocabularyUserTexts`) | review r1 I2 | `internal-vocabulary.ts`, `dynamic-mbz-builder-v3.ts` |
| The vocabulary repair never pushes a field past its length limit: if the full repair makes the build fail with `TEXT_TOO_LONG`/`WORD_RANGE`, it is rebuilt with a repair that never lengthens a string (short label, or the original with warning `internal_vocabulary_kept_length_limit:<rule>:n` and that rule exempt) | review r1 I3 | same |
| Dead links (`href="#"`, empty, `javascript:`) in legacy content are unwrapped deterministically (the text stays; warning `dead_link_unwrapped:n`); only unresolved Moodle tokens `$@…@$` still fail | review r1 M9 | `package/v3/dead-links-v3.ts` |
| A DB error reading the program references is logged and reported as `libro_references_unavailable:<why>` in the package warnings (the Libro ships without «Referencias») | review r1 M8 | `packaging-v3.ts` |

Harnesses: `check-t1-content-integrity`, `check-learning-plan`, `check-composition-formats`,
`check-application-deliverables` (+ `-moodle`), `check-t6-package-integrity`, `check-t6-answer-bias-pool`,
`check-t6-teacher-guide` (+ `-moodle`), `check-review-r1-fixes` (+ `check-ev6-dod-autopkg` «[AP] review r1 I1», PG);
fe `test-68-learning-plan`, `test-69-deliverables`, `test-70-answer-bias-claim-pool`, `test-71-builder-update-notice`.

## 7. Cost risks not in the estimator (review r1)

Neither of these retries is modelled in the FinOps priors (`usage-model.priors.v1.json`; changing the priors is a
calibration decision, not done here). Watch retries and cost per item on the pilot (`byModel` / `byProvider`):

- **Video MC length bias (course level, T6)**: once the course's answer pool is biased (> 30 % «the correct option
  is the longest», z > 1.96), each new `video_interactions` (and H5P `activity`) item can take **one extra targeted
  retry** through the existing soft retry. Upper bound ≈ +1 LLM call per biased item.
- **`FRAMEWORK_ELEMENT_MISSING` (opt-in `learningPlan`, prompt v21-exp-7)**: a hard validation of the methodology
  phases (e.g. Gagné's 9 events) that adds experience retries when an element is missing. Only with `learningPlan`.
