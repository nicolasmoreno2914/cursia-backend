# Loop 4 — capacidad de conexiones a Postgres (propuesta, NO aplicada)

Estado: documento para decisión del usuario. Nada de esto cambia el pool ni el pooler. El worker de IA
(`dist/workers/dynamic-llm-worker.js`) NO se levanta en el deploy hasta que esta propuesta se apruebe.

## Cómo consume conexiones cada proceso

Cada proceso PM2 abre su propio `pg.Pool` (TypeORM). Tamaño por rol (`src/database/db-pool-config.ts`):

| Rol | Variable | Staging (deploy-staging.yml) | Producción (deploy.yml, sin variables) |
|---|---|---|---|
| API (`dist/main.js`) | `DB_POOL_MAX` / `DB_POOL_IDLE_MS` | 2 clientes, idle 20 s | 5 clientes, idle 20 s |
| Worker (`dist/workers/*.js`) | `DB_POOL_MAX_WORKER` / `DB_POOL_IDLE_MS_WORKER` | 1 cliente, idle 1 s | 5 clientes, idle 20 s |

Un worker en espera (flag apagado, sin API key o con el gate dinámico apagado) NO abre ningún pool: sale del bootstrap
antes de crear la app de Nest (dynamic-llm-worker, dynamic-worker-gate).

## Staging hoy (pooler de Supabase en modo sesión: 15 clientes)

| Proceso | Clientes máx. |
|---|---|
| cursia-backend-staging (API) | 2 |
| content, video, audio, h5p, gamma, package, full worker (legacy) | 7 × 1 = 7 |
| dynamic-item, dynamic-package, dynamic-provider worker | 3 × 1 = 3 |
| **Subtotal procesos** | **12** |
| Margen exigido por el gate: migración del deploy 1 + preflight/admin 1 + report/FinOps admin 1 | 3 |
| **Total** | **15 de 15** (sin cupo libre) |

Con el worker de IA (1 cliente; sus consultas son cortas — claim, latido, reservas, guardados — y su concurrencia de 2
partes comparte ese cliente): **16 > 15**. Por eso `check-db-pool-capacity` falla si se registra el proceso.

## Opciones para staging (elegir una)

| Opción | Cupo resultante | Riesgo / costo |
|---|---|---|
| A. Subir el pool size del pooler de staging a 20 (Supabase → Database → Connection pooling) | 16 de 20 (+4 libres) | Ninguno de código; depende del plan/cómputo del proyecto de staging. **Recomendada.** |
| B. Retirar un worker legacy de staging que el flujo dinámico ya no usa (p. ej. `full-worker`) | 15 de 15 | Hay que confirmar que nada de staging lo usa; sin margen para crecer |
| C. Bajar el margen de 3 a 2 | 15 de 15 | Un deploy con migración + un admin concurrentes pueden dar `EMAXCONNSESSION` |
| D. Workers por el pooler en modo transacción (puerto 6543) | sin límite práctico de sesiones | Cambio de conexión y de prepared statements; no para este loop |

Al aprobar A: subir el pooler, cambiar `SESSION_LIMIT` en `scripts/check-db-pool-capacity.js` a 20, registrar
`ensure_pm2_drain_worker cursia-dynamic-llm-worker-staging dist/workers/dynamic-llm-worker.js` y, en otro paso
aprobado, `DYNAMIC_LLM_WORKER_ENABLED=true` (API y worker) + `ANTHROPIC_API_KEY` en el worker.

## Producción (antes de llevar el worker allá)

- Hoy deploy.yml levanta 11 procesos sin variables de pool → **55 clientes teóricos** (5 × 11). El límite real del
  pooler de producción no está verificado desde el repo (hay que leerlo en el dashboard de Supabase de producción).
- Propuesta: aplicar en producción la misma calibración de staging con un API más holgado
  (`DB_POOL_MAX=5`, `DB_POOL_MAX_WORKER=1`, `DB_POOL_IDLE_MS_WORKER=1000`):
  API 5 + 10 workers × 1 + worker de IA 1 = **16** + margen 3 = **19 → pooler ≥ 20** (recomendado 25 para picos de la API).
- Prerrequisitos de producción además del cupo: migraciones `run-pause` y `llm-worker-presence`, deploy de los Loops
  1–4, y la decisión explícita del usuario de activar el flag.
