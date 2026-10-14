# Métricas del piloto (Loop 10 C2)

Lectura de UN run dinámico para el informe del piloto. **Solo lectura** y **USD 0**: ninguna llamada a proveedores;
todas las consultas corren en una transacción `READ ONLY` que termina en `ROLLBACK` (Postgres rechaza cualquier
escritura). No registra nada nuevo: lee lo que el sistema ya guarda.

| Vía | Uso | Batería de calidad |
| --- | --- | --- |
| `GET /api/v1/admin/dynamic-runs/:runId/pilot-metrics` | SuperAdmin (`SupabaseJwtGuard` + `SuperAdminGuard`) | sí (`CoherenceService.qualityReport`, lee artifacts del storage) |
| `node scripts/pilot-metrics.js <runId> [--compact] [--dist dist]` | variables `DB_*` (y `.env`), como los demás scripts | no: `battery: null` + motivo; sí la parte de ejercicios guiados que vive en la base |

Las dos usan `computePilotMetrics` (`src/modules/dynamic-generation/pilot-metrics.ts`). Test: `scripts/check-pilot-metrics.js`
(PG16 desechable con un run sintético).

## Campos

Cabecera: `version` (`pilot-metrics-v1`), `generatedAt`, `readOnly: true`, `run` (`id`, `courseId`, `ownerId`,
`blueprintNumber`, `manifestId`, `status`, `workerStatus`, `items` = items vigentes).

### `timing`
- `runCreatedAt` — `production_jobs.created_at` del run.
- `authorizedAt` — primera fila de `cost_budget_authorizations` del run que no es `BLOCKED`.
- `firstClaimAt` — primer intento (`generation_item_attempts.started_at`, sin reaperturas); sin la tabla, el primer `claimed_at`.
- `completedAt` — `finished_at` del run si `worker_status` es `completed` o `preview` (si no, `null`).
- `lastItemFinishedAt` — último `finished_at` de sus items.
- `packageReadyAt` — `finished_at` del primer job `dynamic_package` del run completado; `packageJobs` = cuántos hubo.
- `authorizationToFirstClaimSeconds`, `firstClaimToCompletionSeconds`, `completionToPackageSeconds`.
- `totalWallSeconds` — desde `totalWallFrom` (`authorization`, o `run_created` sin autorización) hasta `totalWallTo`
  (`package_ready`, o `completed`; `null` si el run no terminó).
- `byItemType.<tipo>` — `count`, `p50Seconds` (mediana, rango inferior), `maxSeconds` de los intentos **completados**
  (`durationSource: attempts`); sin la tabla de intentos, `claimed_at → finished_at` de los items (`item_runs`).

### `cost` (ledger `generation_cost_events`)
- `totalUsd` — suma del run sin la clave del usuario (igual que `runActual`); `userKeyUsd` aparte.
- `pendingUsd` — cargos con `measurement_status = pending` que ningún evento corrigió; `settledUsd = totalUsd − pendingUsd`
  (una reserva conciliada o ajustada ya no está pendiente: su ajuste la neta).
- `openReservations` — cargos `metadata.reservation = true` sin corrección.
- `byProvider` / `byItemType` — `{ totalUsd, settledUsd, pendingUsd, events }`.
- `authorizedBudgetUsd` — última autorización del run (null si `BLOCKED`); `firstAuthorizedBudgetUsd` — la primera.
- `estimate` — `cost_estimates` del run (`scope = run`; si no hay, el de la primera autorización): `expectedUsd`, `maxUsd`.
- `totalVsAuthorized`, `totalVsEstimateExpected` — cocientes.

### `retries` (`generation_item_attempts`)
- `itemStatusCounts` — estado de los items vigentes.
- `attempts`, `attemptsPerItemHistogram` (`"n intentos" → items`), `itemsWithMultipleAttemptsByType`.
- `outcomeCounts` — `completed | failed | lease_expired | drained | abandoned | reopened | open`.
- `failureClassCounts` (A–D) y `failureCodeTop` (15 más frecuentes).
- Sin la migración REL R2: `available: false` y los conteos salen de `attempt_count`.

### `recoveries`
- `autoReopens` / `autoReopensByActorStrategy` — reaperturas hechas por el sistema (`auto_heal`, `recovery`, `system`).
- `autoHealItems` — items vigentes con `output_summary.autoHeal`.
- `leaseExpired`, `abandoned`; `leaseTakeovers` — intento siguiente de OTRO ejecutor tras `lease_expired`/`abandoned`.
- `workerHandBacks` — intentos `drained` (deploy/drenado o pausa: devolución sin gasto).
- `pauses` — la pausa registrada en el run (`pausedAt`, `pausedBy`, `reason` = `user` o el motivo del sistema
  `circuit_breaker` / `run_budget_cap`, `system`, `resumedAt`, `resumedBy`). `pauseHistory: latest_only`: el run guarda
  solo la última pausa. `spendBreaker` — reconocimientos del disyuntor al reanudar.

### `interventions` (acciones manuales, con quién y cuándo)
`authorize_budget` (autorizaciones `ADMIN_APPROVED`), `retry` / `regenerate` (reaperturas con actor `owner` o
`admin:<email>`), `pause` (no del sistema), `resume`, `cancel` (`output_summary.cancellation`), `reconcile`
(ajustes `reconciled_as_*` del ledger). `count`, `byAction`, `list` (ordenada por fecha, tope 200).

### `browser`
- `used` — algún intento con `executor_kind = browser` o `executorId` «browser-…» (o un item vigente con `worker_id` así).
- `attempts`, `byExecutorKind` (`browser | server_llm | video_worker | provider_worker | …`).
- `completedItemsByGeneratedBy` — `output_summary.generatedBy` de los items completados (`llm-worker`, …).
- `list` — los intentos del navegador (`itemKey`, `type`, `executorId`, `startedAt`, `outcome`), tope 200.

### `quality`
- `battery` — resumen de la batería (`version`, `pass`, `summary`, `checks[{id, metric, pass, blocking, findings}]`,
  `guidedPractice`, `unreadableArtifacts`) o `null` con `batteryUnavailableReason` (run en curso, owner fuera de la
  allowlist, CLI sin storage…).
- `battery.guidedPractice` (Q9, informativo, Loop 10 C1-d): `chapters`, `exercises`, `minutes`, `hours`,
  `crossChapterDuplicates`, `atFloorShare` (situación y respuesta < 1,15 × el piso de sus minutos y consignas mínimas),
  `wordsPerCreditedMinute`, `maxMinutesPerContentKWords`, `supported` = sin repetidos entre capítulos, no ≥ 80 % en el
  piso y ≥ 10 palabras de trabajo por minuto acreditado. Q9 nunca cambia `pass` del reporte.
- `guidedPracticeFromSummaries` — lo mismo que se puede saber desde la base (huellas que guarda el servidor al validar
  cada `guided_practice`): `chapters`, `chaptersWithFingerprints`, `exercises`, `minutes`, `hours`,
  `crossChapterDuplicates`. `null` si el run no tiene ejercicios guiados; runs anteriores al Loop 10 no tienen huellas.
