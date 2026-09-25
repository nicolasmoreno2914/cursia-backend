# E2E local de Cursia V2 (Fase 9)

Aceptación end-to-end **sin costo ni red externa**:
- backend real por HTTP con el guard JWT sin modificar (token HS256 firmado localmente) sobre un PG16 descartable con todas las migraciones;
- el **executor real del navegador** (`44`/`45`/`46` del frontend) con un LLM falso;
- los workers reales (`dynamic-item-worker` y `dynamic-package-worker`), con Storage y Videogen falsos en 127.0.0.1;
- packaging rulesVersion 2 → restore en **Moodle 4.5 local**, verificado por UUID.

Cubre además:
- coherencia (estructural y del run, idempotente);
- invalidación, con dry-run comparado ítem por ítem, apply `fromRun`, run B y segundo restore;
- gating con el flag apagado.

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
Resultado esperado: `E2E F9: PASS — 426 aserciones, 0 fallidas`, más los verify/audit reales con exit 0. Nunca toca staging, `main` ni producción.
