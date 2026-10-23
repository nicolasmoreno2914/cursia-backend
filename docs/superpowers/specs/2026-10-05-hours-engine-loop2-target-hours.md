# Motor de carga horaria · Loop 2: `targetHours`

**Estado:** implementado (backend y panel). Sin proveedores, sin generación y sin migración de base.

## Cadena

```
Curso → perfil del curso (course_profiles kind 'pedagogy') → targetHours → Blueprint (course.targetHours) → Manifest
```

- **Dónde vive.** `targetHours` es una clave **opcional** del perfil del curso, en el mismo perfil append-only y versionado que el enfoque pedagógico.
  - Vale también en un perfil sin enfoque: la carga horaria es una restricción del curso, no de la pedagogía.
  - Validación: número de 1 a 500, en pasos de 0,5 (`isValidTargetHours`).
  - El servidor normaliza el perfil y la clave solo aparece si se definió.
- **Lock.** El lock v2 y la comparación «estructura viva = Blueprint» (`computeLiveMatchesCurrentBlueprint`) leen el perfil vigente.
  - Congelan `course.targetHours` en el snapshot **solo si existe**.
  - Cambiar las horas pide reconfirmar la estructura, igual que cambiar el enfoque.
- **Manifest.** Los mismos trabajos y totales. Las `features` también son iguales, salvo `features.pedagogy.profileSha256` cuando hay enfoque, porque las horas forman parte del perfil. El sha del Blueprint cambia.
  - La invalidación no regenera nada: cero trabajos y cero proveedores.
- **Dry-run.** Devuelve `targetHours` y `workload`, que compara las horas objetivo con las estimadas por el modelo de tiempo. Si la entrada trae horas, las toma; si no, usa las del snapshot recibido.
- **Panel.** Conserva las horas al guardar o quitar el enfoque y al usar la recomendación de «No estoy seguro». La edición llega en el Loop 3.

## Compatibilidad hacia atrás

Un curso sin `targetHours`, o con un perfil vacío, produce exactamente el Blueprint, el Manifest y los sha de antes. Lo prueba `scripts/check-target-hours.js` (TH2) contra 80 casos de referencia generados con el código de staging anterior (`scripts/fixtures/study-time/legacy-shas.json`):

- 4 estructuras;
- 10 perfiles;
- H5P v1 y v2;
- también el sha de los perfiles.

## Despliegue y rollback

- **Orden.** El backend se despliega antes que el frontend. Un panel nuevo sobre un backend viejo solo envía la clave si hay horas, y el backend viejo la rechaza con 400 visible.
- **Rollback.** Una vez que algún curso guardó `targetHours`, volver a un backend anterior a este loop **rompe** esos cursos:
  - el perfil se rechaza por `UNKNOWN_FIELD`;
  - el recanonicalize viejo descarta la clave y el sha del Blueprint no coincide.
- **Antes de revertir:**
  1. Guardar en esos cursos un perfil sin `targetHours` y reconfirmar la estructura.
  2. Verificar que no haya runs activos sobre Blueprints que contengan `course.targetHours`.
  3. No reintentar ni reempaquetar con el backend viejo los runs ya terminados sobre esos Blueprints: el backend viejo los recanonicaliza en el scheduler, en `course-blueprints.service` y en `coherence/report`, descarta la clave y falla por sha.
- **Cómo encontrarlos:**

  ```sql
  select course_id from course_profiles where kind = 'pedagogy' and data ? 'targetHours';
  select course_id, id from course_blueprints where snapshot_json->'course' ? 'targetHours';
  ```

## Pruebas

- **`check-target-hours.js` (TH1–TH9 + TH7b):**
  - perfil;
  - regresión byte a byte;
  - Blueprint;
  - Manifest igual;
  - dry-run;
  - cada enfoque;
  - cambiar las horas después del Blueprint, con y sin enfoque, sin regenerar nada;
  - reorden;
  - casos adversos.
- **`check-pedagogy-engine.js` (DB):**
  - perfil sin enfoque con 33 h;
  - la estructura queda «desactualizada»;
  - el lock congela las horas;
  - el Manifest tiene los mismos trabajos;
  - quitarlas vuelve al sha de siempre;
  - el lock sin perfil no lleva la clave.
- **`test-49-pedagogy-panel.mjs`:** guardar, quitar, vista previa y «No estoy seguro» conservan las horas.
