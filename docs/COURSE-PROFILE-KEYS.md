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
- `dueOffsetDays`: `null` or 1–365 days from the course start (Moodle shifts it on restore).
- `grading`: `{ "graded": false }` (formative: no grade item, no rubric, feedback comments on) or graded with
  `maxGrade` 1–100, `gradepass` 0–max, `category` `applications` (own gradebook category, needs the `applications`
  weight) or `practice`, `rubric` (built from the AA criteria and the solucionario correction guide; visible to the
  student after grading).
- Completion is on submit. The course is still approved only by the final course grade.

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
  mimetype and format signature are verified at packaging (`PRACTICE_FILE_INVALID` = held for the user).
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
- `include: false` or the key absent → the `.mbz` is byte-identical to before. The panel offers it under
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

Harnesses: `check-t1-content-integrity`, `check-learning-plan`, `check-composition-formats`,
`check-application-deliverables` (+ `-moodle`), `check-t6-package-integrity`, `check-t6-answer-bias-pool`,
`check-t6-teacher-guide` (+ `-moodle`); fe `test-68-learning-plan`, `test-69-deliverables`,
`test-70-answer-bias-claim-pool`.
