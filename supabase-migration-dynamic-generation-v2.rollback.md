# Rollback de `supabase-migration-dynamic-generation-v2.sql` (rulesVersion 2)

Notas de reversión de la migración rulesVersion 2 + Context Package (5B.2.B + Fase 6).
Origen: M5 de la revisión integral `review-rv2`.

**Esto es documentación, no un script.** No existe (a propósito) un `.sql` ni un `.js`
ejecutable de down-migration: cada paso destructivo lo decide y lo corre una persona,
contra **staging**, después de revisar los conteos del paso 0. La migración solo corre en
staging (`deploy-staging.yml`, paso `[4h2]`); `deploy.yml` (producción) no la ejecuta.

## Qué agregó la migración (y qué NO tocó)

| Tabla | Cambio v2 | Estado pre-v2 |
|---|---|---|
| `generation_item_runs` | `module_id` pasó a nullable | `module_id uuid not null` |
| `generation_item_runs` | columna `scope text not null` + backfill por `type` | no existía |
| `generation_item_runs` | trigger `generation_item_runs_default_scope` + función `public.generation_item_runs_default_scope()` | no existían |
| `generation_item_runs` | CHECK `gir_type_check` (7 tipos) reemplazó el CHECK inline sin nombre | `check (type in ('content','scorm','video','exam'))` (inline, nombre autogenerado) |
| `generation_item_runs` | CHECK `gir_type_scope` | no existía |
| `generation_item_runs` | CHECK `gir_chapter_scope` redefinido por `scope` (mismo nombre) | `check ((type = 'exam') = (chapter_id is null))` |
| `course_generation_manifests` | columnas `course_plan_count`, `course_intro_count`, `module_intro_count` (default 0) | no existían |
| `course_generation_manifests` | CHECK `cgm_counts_consistent` redefinido (mismo nombre) | `content_count = chapter_count and scorm_count = chapter_count and video_count <= chapter_count and exam_count <= module_count and total_jobs = content_count + scorm_count + video_count + exam_count` |

No tocó `production_jobs`, `artifacts`, `generation_run_contexts` ni ningún índice. Los tipos
de artifact v2 (`dynamic_course_plan_json`, `dynamic_course_intro_md`,
`dynamic_module_intro_md`, `dynamic_context_package_json`, `dynamic_context_summary_json`)
no tienen allow-list en la base, así que no hay nada que revertir ahí.

## La frase "reversible sin tocar datos" tiene un límite

Solo vale **mientras no existan filas v2**. Con cualquier fila v2 presente:

- restaurar `module_id NOT NULL` falla por las filas de scope `course` (`course_plan`,
  `course_intro`: `module_id` es NULL);
- restaurar el CHECK de tipo de 4 tipos falla por `course_plan` / `course_intro` /
  `module_intro`;
- restaurar el `gir_chapter_scope` viejo falla por `module_intro` (`chapter_id` NULL y
  `type <> 'exam'`);
- restaurar el `cgm_counts_consistent` viejo falla por los Manifests v2
  (`total_jobs` incluye plan e intros).

Por eso hay dos caminos. **En casi todos los casos, el camino A alcanza.**

## Orden obligatorio (ambos caminos)

1. **Config primero.** En staging: `DYNAMIC_MANIFEST_RULES_VERSION=1` (o quitarla) y
   reiniciar la API. Desde ese momento no se crean Manifests v2. Los runs v2 que ya existen
   siguen legibles y cancelables por su Manifest congelado (`getById`).
2. **Runs v2 activos.** Cancelarlos desde la UI o con
   `POST …/manifest/runs/:runId/cancel`. Así no queda un ejecutor reclamando items v2 a
   mitad del rollback. Para verificar:
   ```sql
   select pj.id, pj.worker_status
     from public.production_jobs pj
     join public.course_generation_manifests m on m.id::text = pj.input_payload->>'manifestId'
    where pj.execution_mode = 'dynamic_generation' and m.rules_version = 2
      and pj.worker_status in ('queued','running','retrying');
   ```
   Tiene que devolver 0 filas.
3. **Código.** Volver el backend y el frontend de staging a la versión previa, si hace falta.
   El código previo a v2 no sabe leer runs v2: `progress()` responde 500 "tipo de item
   desconocido" para esos runs. Es ruidoso y no corrompe nada.
4. **Recién ahí, el schema.** Seguir el camino A o el B.

### Paso 0: conteos (antes de decidir)

```sql
select count(*) as manifests_v2 from public.course_generation_manifests where rules_version = 2;
select count(*) as items_v2 from public.generation_item_runs
 where type in ('course_plan','course_intro','module_intro') or scope = 'course';
select count(*) as artifacts_v2 from public.artifacts
 where type in ('dynamic_course_plan_json','dynamic_course_intro_md','dynamic_module_intro_md',
                'dynamic_context_package_json','dynamic_context_summary_json');
```

## Camino A: dejar el schema v2 puesto (recomendado)

La migración es aditiva: el código v1 escribe y lee igual sobre el schema v2. El trigger
completa `scope` en los INSERT v1, el CHECK de 7 tipos acepta los 4 de siempre y los
conteos v2 quedan en 0 en cada Manifest v1. Con los pasos 1 a 3 alcanza. Las filas v2 quedan
como histórico inerte, y la auditoría (`scripts/audit-dynamic-generation.js`) las sigue
validando.

## Camino B: revertir el schema (solo si hay que volver al DDL exacto previo)

**Borra datos** (runs v2, sus items y sus contextos). Correrlo solo con backup o snapshot de
staging y conteos anotados. Dentro de una transacción:

1. **Datos v2** (destructivo y explícito):
   - borrar los `production_jobs` de los runs v2 → hace cascada a `generation_item_runs` y a
     `generation_run_contexts`;
   - los `artifacts` vinculados quedan con `item_run_id`/`manifest_id` en NULL (FK
     `on delete set null`, así que no se pierden los blobs);
   - borrar los `course_generation_manifests` con `rules_version = 2` (el trigger solo
     prohíbe UPDATE, no DELETE).
   ```sql
   delete from public.production_jobs pj
    using public.course_generation_manifests m
    where pj.execution_mode = 'dynamic_generation'
      and m.id::text = pj.input_payload->>'manifestId' and m.rules_version = 2;
   -- Los jobs dynamic_package de esos runs (input_payload->>'runId') pueden
   -- borrarse también o quedar como histórico; no tienen FK al run.
   delete from public.course_generation_manifests where rules_version = 2;
   ```
   Hay que volver a correr los conteos del paso 0: `manifests_v2` e `items_v2` tienen que
   dar 0.
2. **`course_generation_manifests`**, en orden inverso:
   - `alter table … drop constraint cgm_counts_consistent;`
   - volver a crear el CHECK previo (ver la tabla de arriba);
   - `drop column module_intro_count, drop column course_intro_count, drop column course_plan_count`.
3. **`generation_item_runs`**, en orden inverso:
   - `drop constraint gir_chapter_scope` y volver a crear
     `check ((type = 'exam') = (chapter_id is null))`;
   - `drop constraint gir_type_scope`;
   - `drop constraint gir_type_check` y volver a crear el CHECK de 4 tipos (con nombre
     explícito, por ejemplo `gir_type_check_v1`: el inline original tenía un nombre
     autogenerado que no hace falta reproducir);
   - `drop trigger generation_item_runs_default_scope on public.generation_item_runs;` y
     `drop function public.generation_item_runs_default_scope();`;
   - `alter table … drop column scope;`;
   - `alter table … alter column module_id set not null;`. Falla si quedó alguna fila de
     scope `course`, y eso es lo esperado: indica que el paso 1 no terminó.
4. `scripts/verify-dynamic-generation-schema.js` y
   `scripts/verify-generation-manifests-schema.js` **del código previo a v2** tienen que
   pasar.
5. Quitar el paso `[4h2]` de `deploy-staging.yml`. Si no, el próximo deploy vuelve a aplicar
   la migración, porque es idempotente.

## Qué NO hacer

- No revertir el schema (camino B) con runs v2 activos ni antes de bajar la config: un
  `startRun` concurrente crearía filas v2 a mitad del rollback.
- No "arreglar" filas v2 pasándolas a tipos v1 (por ejemplo `course_plan` → `content`). Eso
  rompe `uq_artifacts_item_run_type`, el hash del Manifest y la auditoría. Las filas v2 se
  dejan (camino A) o se borran enteras (camino B).
- No correr nada de esto contra producción: la migración v2 nunca se aplicó ahí.
