# Quality reports (r58, review r1 M-6)

Two report shapes exist. They are not interchangeable.

| Shape | Producer | Where it is stored / shown | Status |
| --- | --- | --- | --- |
| **`CourseQualityReport`** (`src/modules/quality/course-quality-report.ts`, findings in the common format of `quality-finding.ts`, `formatVersion`) | Package worker v3 (after `validateMbzV3`) and the offline driver dry-run | `production_jobs.output_summary.qualityReport` and the `.mbz` artifact `metadata.qualityReport` (summary, capped at `COURSE_QUALITY_SUMMARY_MAX_FINDINGS`); SuperAdmin view in «Curso listo» | **Canonical** for a delivered course. Delivery rule and severities live here. |
| `QualityReport` — battery Q1–Q9 (`src/modules/quality/quality-battery.ts`) | `CoherenceService.qualityReport` (on demand), pilot metrics, optimisation regressions (`compareQualityReports`) | Not persisted; read on demand | Input/adapter. It is projected into the canonical report when available; never used for delivery decisions. |

Convergence plan: the battery keeps its own shape (its consumers compare metrics run-to-run), and every new consumer reads
the canonical `CourseQualityReport`. A future step can make `CoherenceService.qualityReport` also return the battery
projected as `QualityFindingV2[]`; until then, do not build new UI on the battery shape.

## Severities and the delivery rule

`QUALITY_DELIVERY_RULE`: BLOCKER blocks delivery; MAJOR requires human resolution or a recorded acceptance and is
**not** auto-blocking; MINOR is visible with no action required; INFO is reviewer information.

### Why `NUMERIC_WINDOW_CONFLICT` is MAJOR (and still not blocking)

E3 finds the same term with different time windows or quantities in different parts of the course (for example
«hasta 120 horas» in a chapter and «72 horas» in an exam). The finding's own `cause` says it *can* be legitimate
(two different cases). It stays MAJOR because, when it is not legitimate, the student gets contradictory facts and an
exam answer can depend on which value is right. That is a content error with consequences, not a style issue.
The heuristic cannot tell the two cases apart, so the finding is `kind: needs_human_review`: an expert confirms which
value applies in each context. It never blocks delivery and is never auto-corrected. If the pilot shows mostly
false positives, lower it to MINOR in `QUALITY_SEVERITY_MAP` (one line, covered by `check-quality-report.js`).

## Checks that could not be measured

- Battery: a check with `status: 'not_measured'` (today Q7 continuity without sidecars / without internal assumed
  concepts) has `pass: null` — **neutral**: neither passed nor failed — and `blocking: false`, so `report.pass` ignores it.
  Consumers that read per-check `pass` must treat `null` as "no data", not as a failure (`pilot-metrics` passes it
  through unchanged). `compareQualityReports` reports a measured → not measured change as the regression «sin datos»,
  not as «dejó de pasar».
- Canonical report: rules that could not be measured are listed in `notMeasured` (`measured: false` findings) and never
  count as passed.
