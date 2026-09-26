# E2E local de Cursia V2 (Fase 9)

Aceptación end-to-end **sin costo ni red externa**:
- backend real por HTTP con el guard JWT sin modificar (token HS256 firmado localmente) sobre un PG16 descartable con todas las migraciones;
- el **executor real del navegador** (`44`/`45`/`46` del frontend) con un LLM falso;
- los workers reales (`dynamic-item-worker` y `dynamic-package-worker`), con Storage y Videogen falsos en 127.0.0.1;
- packaging rulesVersion 2 → restore en **Moodle 4.5 local**, verificado por UUID.

Cubre además:
- coherencia (estructural y del run, idempotente);
- invalidación, con dry-run comparado ítem por ítem, apply `fromRun`, run B y segundo restore;
- gating con el flag apagado;
- **DN-1 (paso `5y-youtube-dn1`)**: con la config de producción (sin `DYNAMIC_VIDEO_DELIVERY` ni `DYNAMIC_ALLOW_VIDEOGEN_DIRECT`) un curso con video: preflight `GET /dynamic/youtube/preflight`, 409 `youtube_preflight_failed:no_connection` sin escrituras, conexión cifrada real, run `youtube` con el worker real contra un **Google falso** (OAuth + YouTube Data API en 127.0.0.1 vía `google-fake-redirect.js`; un 503 en la subida se reintenta sin re-enviar a Videogen), packaging con el video como **label embebible** y restore + render en Moodle 4.5 (`moodle-render-youtube-labels.php`: `format_text` con los filtros del contexto del módulo → reproductor embebido).

Los runs A/B usan `videogen_direct` (pinned) con el escape de staging `DYNAMIC_ALLOW_VIDEOGEN_DIRECT=true`.

`netguard.js` falla ante cualquier conexión fuera de 127.0.0.1.

## Requisitos
- Node 20+ y un `npm run build` del backend a probar (el script lo corre salvo con `SKIP_BUILD=1`).
- PostgreSQL 16 de Homebrew en `/opt/homebrew/bin`.
- PHP 8.3 (`/opt/homebrew/opt/php@8.3/bin/php`) y un Moodle 4.5 local en `E2E_MOODLE_DIR`, con el layout de `moodle-local/`: `source/` con el código oficial de Moodle, `php.ini`, `start.sh`, `restore-and-inspect.sh` y `teardown.sh`. `inspect_course.php` va en `source/admin/cli/`.

## Uso
```bash
E2E_BACKEND_ROOT=/ruta/orbia-backend \
E2E_FRONTEND_ROOT=/ruta/campuscloud-gen \
E2E_SCRATCH=/tmp/cursia-e2e \
E2E_MOODLE_DIR=/ruta/moodle-local \
  bash test/e2e-v2/run-e2e.sh
```
Puertos opcionales: `E2E_PG_PORT` (default 55491) y `E2E_APP_PORT` (default 38471).

Resultado esperado: `E2E F9: PASS — N aserciones, 0 fallidas`, más los verify/audit reales con exit 0. Nunca toca staging, `main` ni producción.

## V2.1 (R13): compuerta final — `run-e2e-v21.sh`
Un solo comando que corre, en orden:
1. **E2E v2 intacto** (`e2e.js`, rulesVersion 2) y, sobre el mismo PG16 descartable, la **fase rulesVersion 3** (`e2e-v3.js`, enganchada con `E2E_AFTER` de `run-e2e.sh`):
   - app + workers reales (`dynamic-item-worker`, `dynamic-provider-worker`, `dynamic-package-worker`) con `DYNAMIC_MANIFEST_RULES_VERSION=3`, `DYNAMIC_PROVIDER_WORKER_ENABLED=true`, `DYNAMIC_ALLOW_PROVIDER_MOCK=true` y la config de producción del video (entrega YouTube contra el Google falso; el video "publicado" es el id real `IdwOipZAeqY`, 468 s del Videogen falso);
   - LLM falso v3 (`llm-v3.js`): salidas válidas para experience, intros v3 sin dígitos, H5P del tipo derivado del UUID, video_interactions de los checkpoints planeados y examen final GIFT; **una respuesta inválida por tipo, una sola vez**, para probar el reintento dirigido;
   - cursos E1 (2 módulos, las 4 combinaciones V/A, aula-clara/light, 70, final ON, h5p), E2 (4 módulos, oscuro-premium/dark, 60, final OFF, scorm) y E3 (2 módulos, tecnico/dark, 80, final ON, h5p); E1 se re-empaca con tecnico/dark + 80 (0 item runs, 0 CHARGE salvo el ZERO_BY_DESIGN del empaque, sha distinto, mismos artifacts);
   - FinOps: E0 (run 100 % mock → AUTO), 409 `budget_approval_required` sin aprobación, ledger, `cost_estimates`, contadores de los fakes;
   - restore de los 4 MBZ con `moodle-local/restore-and-inspect.sh` + `scripts/moodle/v21-packaging-v3-inspect.php` (estructura por UUID, gradepass, categorías, completion, H5P, audio con duración medida, Libro, Gamma, cifras del shell = Manifest) y simulación de notas (`moodle-v3-grades.php`).
2. **QA de navegador** (`browser-qa-v3.js`, Chrome headless por CDP): servidor PHP en 127.0.0.1:8099 solo durante la prueba, estudiante local de prueba (`E2E_MOODLE_CREDS`), E1/E2 a 390/768/1280 (+ emulación móvil), IV inline, H5P respondido → gradebook, `forceclean=1` temporal y **siempre** de vuelta a 0. Capturas en `E2E_SHOTS`.
3. **Regresión**: todos los `scripts/check-*.js` (incluidos los de Moodle local), `harness-blueprint-snapshot`, el runner de producción local y los harnesses del frontend.
4. **Resumen** (`summary-v21.js`): aserciones por área, sha de los MBZ, warnings de restore y contadores de proveedores.

```bash
E2E_BACKEND_ROOT=/ruta/orbia-backend E2E_FRONTEND_ROOT=/ruta/campuscloud-gen \
E2E_SCRATCH=/tmp/cursia-e2e-v21 E2E_MOODLE_DIR=/ruta/moodle-local \
E2E_MOODLE_CREDS=/ruta/.local-test-credentials E2E_SHOTS=/ruta/capturas \
E2E_JSDOM_NODE_PATH=/ruta/node_modules-con-jsdom \
  bash test/e2e-v2/run-e2e-v21.sh
```
Opcionales: `SKIP_BUILD=1`, `E2E_SKIP_REGRESSION=1`. `run-e2e.sh` acepta además `E2E_SKIP_V2=1` (solo fases extra) y `E2E_AFTER` (comando extra antes del cleanup); ya no detiene el Postgres del Moodle local si no lo arrancó él.
