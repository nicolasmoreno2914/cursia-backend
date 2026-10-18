# Release checklist: staging → main (production)

Review r1 (I-2). Production deploys run on every push to `main`. The backend goes through `.github/workflows/deploy.yml` (rsync + `pm2 reload`). The frontend goes to Cloudflare Pages production.

Neither deploy writes the backend `.env` or the Pages environment variables. Any switch that r58 added with a **safe-by-default** value changes production behaviour on the first promotion, unless someone decides it on purpose before the merge.

`scripts/check-release-rollout-guard.js` reads `deploy.yml` and prints a **warning** (it does not fail) for each item below that the workflow does not set. The warning is a reminder that the item must be decided by hand. Production config and secrets are never changed by code or by the agent loop.

## Before merging to `main`

### 1. Video Engine (v1 video generation)

r58 changed the default from open to closed.

**Backend `.env` (VPS `$VPS_PATH`)**

| Variable | r58 default | What happens if nobody decides |
|---|---|---|
| `VIDEO_ENGINE_ENABLED` | unset → real renders off | `POST /api/v1/video-engine` `create` / `batch-create` answer 503 `video_engine_disabled`. v1 video generation stops. |
| `VIDEO_ENGINE_ALLOWED_OWNERS` | unset → SuperAdmin only | Non-admins get 403 on `create` / `batch-create` / `auth-test`. |

**Frontend (Cloudflare Pages → production env)**

| Variable | r58 default | Effect on `/api/video-engine` |
|---|---|---|
| `VIDEO_ENGINE_ENABLED` | unset → off | Same as the backend: no real renders. |
| `VIDEO_ENGINE_ALLOWED_OWNERS` / `VIDEO_ENGINE_ADMIN_EMAILS` | unset → nobody | 403 on render / `auth-test` actions. |

- [ ] The owner decides: keep v1 video open (`VIDEO_ENGINE_ENABLED=true` + `VIDEO_ENGINE_ALLOWED_OWNERS=*`, in **both** places), or keep it closed and tell users.
- `status` and `batch-status` are read-only and cost nothing. Since review r1 they are open to every signed-in user in both proxies, so renders that were already submitted can still be tracked whatever is decided here.

### 2. Other r58 switches that the production workflow does not manage

- [ ] `LEGACY_PAID_JOBS_ENABLED`: default `true` (v1 unchanged). Set `false` only if v1 paid jobs should stop.
- [ ] `SUPER_ADMIN_USER_IDS` (recommended) and `SUPER_ADMIN_EMAIL_VERIFICATION` (leave it `required`). Admins need a confirmed email. Without a readable `auth.users` row, the guard uses the JWT `email_verified` claim.
- [ ] `YOUTUBE_UPLOAD_ALLOWED_HOSTS`: needed only if Videogen download URLs redirect to a host other than `VIDEOGEN_API_URL` / `SUPABASE_URL`.
- [ ] `FINOPS_KILL_SWITCH` / `FINOPS_PROVIDER_ALLOWLIST`: unset in production unless spend must stop.

### 3. After the deploy

- [ ] Run a v1 video smoke test as a non-admin user. It should match the decision in §1: either it renders, or you see the expected 503/403 with a clear message. `status` polling must still answer.
- [ ] Run `pm2 restart <process> --update-env` for every process whose `.env` value changed.
