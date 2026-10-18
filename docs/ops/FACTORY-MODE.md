# Factory mode: producing client courses on staging

This is the operating procedure for staging when it produces real client courses, which is the plan for the first commercial pilots (from 27 Oct 2026).
Background and the decision record are in `R2-ENVIRONMENT-RECOMMENDATION.md` (§5 checklist, §6 daily control).

Factory mode does not change any budget **value** in code. Every switch below is an env var or a GitHub variable, and its default keeps today's behavior.

---

## 1. Switches

### 1.1 Backend env vars (VPS: `$VPS_PATH_STAGING/.env`)

The deploy never syncs `.env` (rsync excludes it), and it does not manage these keys. A value set by hand stays set across deploys.
After you edit `.env`, run `sudo pm2 restart <process> --update-env` for the API and the workers, so the processes read the new values.
`staging-budget-policy.js` reads `.env` on every deploy, so it needs no restart.

| Variable | Default | Factory value | Effect |
|---|---|---|---|
| `DYNAMIC_DEFAULT_HOLD_PACKAGING_OWNERS` | empty (no run changes) | factory owner UUID (comma-separated list; `*` = every owner) | New runs of these owners start with `stopAfter = {itemKeys: [], holdPackaging: true}`. This is the same as the manual `PUT …/runs/:runId/stop-after {"itemKeys":[],"holdPackaging":true}`. When the run completes, **no** package is built. The package is built only by an explicit action: «Preparar paquete», or `POST …/runs/:runId/package-hold/release`. The owner can remove the hold with `DELETE …/stop-after`. Entries that are not UUIDs (and not `*`) are ignored, and the API logs a warning. |
| `DYNAMIC_AUTO_REPACKAGE_ON_BUILDER_BUMP` | `false` | leave `false` | Only the exact value `true` makes the auto-package sweep rebuild a completed final package that an older builder version produced. With the default, that package shows as `stale`, with a visible `retry_package` action, and nothing is rebuilt automatically. On 16 Oct a deploy rebuilt 4 delivered courses automatically. This switch prevents that. |
| `DYNAMIC_AUTO_PACKAGE_ENABLED` | on | optionally `false` (belt and braces) | Global off switch for automatic packaging: both the trigger at run completion and the sweep. The manual button still works. |
| `STAGING_BUDGET_MAX_COST_PER_RUN` | `106` | as approved by the owner | `staging-budget-policy.js` (deploy step `[4h10]`) writes a new version of the current staging policy when the limits differ. The value must be a number > 0 in USD, with at most 2 decimals. An invalid value fails the deploy step on purpose. |
| `STAGING_BUDGET_MAX_COST_PER_COURSE` | `106` | as approved | Same. |
| `STAGING_BUDGET_MONTHLY_CAP` | `162` | as approved | Same. The value is written to the monthly key that the policy already uses (`monthlyCap` or `monthlyCapStaging`). |
| `DEPLOY_FREEZE` | unset | `true` outside release windows | The VPS-side deploy guard (§2) refuses every deploy, with exit 3. |
| `PACKAGE_MBZ_MAX_BYTES` | unset (measure and report only) | the Storage global upload limit in bytes (e.g. `209715200` for 200 MB) | T6: the package worker measures every built `.mbz` before upload. Above this limit the job fails with `PACKAGE_SIZE_LIMIT_EXCEEDED` (held for a person: raise the storage limit or reduce the course) instead of a 413 from Storage after the build. The job summary always carries `size` (total bytes and the 10 heaviest files). Not a positive integer → `PACKAGE_SIZE_CONFIG_INVALID`. |
| `PACKAGE_MBZ_WARN_BYTES` | 90 % of `PACKAGE_MBZ_MAX_BYTES` (none if that is unset) | optional | Above it the package is still uploaded, with the visible warning `package_size_over_warn:<bytes>:<threshold>`. Must be ≤ the max. |

Raising a budget is an owner decision. It is never done by code or by the agent loop. Set the three `STAGING_BUDGET_*` values only after the owner approves them in chat.
If you remove the variables, the next deploy restores 106/106/162.

### 1.2 GitHub (repo or `staging` environment variables / dispatch inputs)

| Setting | Default | Effect |
|---|---|---|
| Variable `DEPLOY_FREEZE` | unset | `true` makes the **first** step of `deploy-staging.yml` fail on every push to `staging` (merges still land, but nothing is deployed). |
| Dispatch input `force_deploy` | `no` | `yes` is the only escape. It skips the `DEPLOY_FREEZE` check and turns the active-runs guard into report-only. Pushes cannot set it. |

---

## 2. Deploy freeze guard

`deploy-staging.yml` runs two guards before anything reaches the VPS:

1. **`Deploy freeze guard (DEPLOY_FREEZE variable)`** is the first step of the job. It fails when `vars.DEPLOY_FREEZE=true`, unless the run is a `workflow_dispatch` with `force_deploy=yes`.
2. **`Deploy freeze guard (no active dynamic runs / package jobs on the staging VPS)`** runs after `Configure SSH`, and before the ownership fix, the rsync and the PM2 restart/reload. It pipes `scripts/ops/check-active-runs.js` over SSH (`node - < script`). The script runs in `$VPS_PATH_STAGING` with the `.env` and the `pg` driver that are already there. It is **read-only** (`begin transaction read only` + rollback).

| Exit | Meaning | Deploy |
|---|---|---|
| 0 | no activity (or `--force`) | continues |
| 2 | `dynamic_generation` run in `queued/running/retrying/waiting_external/pausing/cancelling`, or a claimed item (`generation_item_runs` running with a live lease), or a `dynamic_package` job in `queued/running/retrying` | aborted |
| 3 | `DEPLOY_FREEZE=true` in the VPS `.env` | aborted |
| 1 | could not query (fail closed) | aborted |

The guard also reports these, without blocking: **paused** runs (they would resume on the new code) and items in `running` with an **expired** lease (the auto-healer reclaims them).
The output lists ids, statuses and counts only.

Manual check on the VPS:

```bash
cd $VPS_PATH_STAGING && node scripts/ops/check-active-runs.js          # human output
cd $VPS_PATH_STAGING && node scripts/ops/check-active-runs.js --json   # JSON
```

Forcing a deploy (for example, a hotfix for a stuck run): Actions → *Deploy to Staging* → Run workflow → `calibration_action=none`, `force_deploy=yes`.
The dynamic workers still drain (SIGINT, ≤ 270 s). An in-flight item goes back to the queue.

Regression harness: `node scripts/check-deploy-freeze-guard.js`. CI runs the pure part with `--pure-only`. The full run includes a disposable PG16 and must be run locally.

---

## 3. Release windows

- **One window per week** (for example Monday 07:00 COT). Outside the window: `DEPLOY_FREEZE=true` (GitHub variable **and** VPS `.env`).
- Open the window only when `check-active-runs.js` is clean **and** no client run is between generation and delivery.
- Sequence: full local gate + gate-core → merge to `staging` → unfreeze (`DEPLOY_FREEZE` unset/false) → deploy → smoke (a synthetic USD-0 run) → freeze again.
- **Frontend**: merge the Cloudflare Pages `staging` branch only during the window, or pause its automatic deployments.
- A course never spans a window. Start a run only if it can finish before the next window.
- For each delivered course, record the builder and prompt versions in the delivery log (§5).

---

## 4. Packaging hold policy

- Every client run is held: set `DYNAMIC_DEFAULT_HOLD_PACKAGING_OWNERS=<factory owner>`. The manual `PUT …/stop-after` is the fallback for other owners.
- Order: QA first, then «Preparar paquete» (an explicit action), then the SHA-256 and the offline copy (§5), then delivery to the client.
- **Never release the hold** on a delivered course.
- Builder bumps repackage **only** on explicit request. `DYNAMIC_AUTO_REPACKAGE_ON_BUILDER_BUMP` stays `false`. A repackage of a delivered course is a new delivery version, with a new SHA-256 and a new log entry.
- Emergency stop of provider spend: dispatch `calibration_action=worker_off`. It lasts until the next deploy.

---

## 5. Storage limit and backups

- **Supabase Storage**: keep the spend cap OFF, or set the global upload limit to **≥ 200 MB**, for the whole factory period. #1353 produced a 106 MB `.mbz`, and the 50 MB limit (spend cap ON) rejects it. Accept the pay-as-you-go storage and egress cost.
- Set `PACKAGE_MBZ_MAX_BYTES` to the same limit (§1.1) so an oversized package fails before upload with a clear code.
- **DB backups**: confirm that daily backups are enabled on the staging plan. Decide on PITR (≥ 7 days) for the contract period. That is an owner decision.
- **Storage objects are not in DB backups.** Keep an **offline copy of every delivered `.mbz`** (Drive or S3).
- **Delivery log**, one row per delivery: course id, run id, package job id, artifact id, `.mbz` SHA-256, builder version, delivery date, and the client contact who received it.

---

## 6. Health report cron

`scripts/ops/v2-health-report.js` is read-only. Exit codes: 0 OK · 2 threshold exceeded · 1 error · 3 wrong ref. Install it on the VPS. It is not installed today.

```cron
*/30 * * * * cd /var/www/cursia-backend-staging && MIGRATION_ENV=staging node scripts/ops/v2-health-report.js --env-file .env --expect-ref ljdtmkwuhkvtmlhugjrv >> /var/log/cursia-v2-health-staging.log 2>&1 || <alert command>
```

- Alert channel: the owner picks one (for example a Brevo email or a Slack webhook).
- Thresholds come from the real environment, not from `--env-file`. Set real values for the factory period:
  - `V2_HEALTH_MAX_VIDEOGEN_USD_24H` / `_7D`;
  - `V2_HEALTH_MAX_STUCK_LEASES=0`;
  - `V2_HEALTH_MAX_PACKAGE_FAILURES_24H=0`;
  - `V2_HEALTH_MAX_DYNAMIC_STORAGE_GB`.

  The full list is in `docs/v2-production-migrations.md` §Observabilidad.
- Also watch the shared VPS: `free -m`, `pm2 status`.

---

## 7. Daily control

- **FinOps**: committed + reserved per run, against the estimate (alert at +50 %). Monthly cap headroom.
- **Health and VPS**: health report status, `pm2 status`, VPS memory, and `check-active-runs.js` before any planned deploy.
- **Review queue**: start no new generation while more than 3 courses are unreviewed.
- **Quotas and balances**: YouTube quota used today. Anthropic, Gamma and Videogen balances.
- **Storage**: GB used, against the plan.

---

## 8. Leaving factory mode

After the last contract review round:

- unset `DYNAMIC_DEFAULT_HOLD_PACKAGING_OWNERS`;
- remove the `STAGING_BUDGET_*` overrides (the next deploy restores 106/106/162);
- unset `DEPLOY_FREEZE` (GitHub and VPS);
- turn the spend cap back ON;
- archive the factory owner.
