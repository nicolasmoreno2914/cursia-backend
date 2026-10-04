# Motor pedagógico V1 — diseño

**Estado:** implementado en staging (backend + frontend). Solo diseño y dry-run: sin generación real, sin proveedores nuevos, sin infraestructura nueva y gasto USD 0.

## Objetivo

Agregar una capa pedagógica ANTES de cualquier contenido pagado, sin construir otro generador:

```
Usuario
  → Perfil pedagógico (course_profiles, kind = 'pedagogy')
  → Reglas de diseño (motor data-driven)
  → Blueprint v2 existente (course.pedagogy + design por módulo/capítulo)
  → Manifest v3 existente (features.pedagogy + design por item + h5pType del diseño)
  → Generadores existentes (Fase 2: leer item.design en los prompts)
```

## Dónde entra (diagnóstico)

| Pieza existente | Rol en el motor |
|---|---|
| `course_profiles` (append-only, versionado, sha) | Persistencia del perfil: se agregó `kind = 'pedagogy'` (migración que solo amplía el CHECK). |
| Lock del Blueprint v2 (`CourseBlueprintsService.lockV2`) | Lee el perfil vigente, deriva las reglas y congela el diseño en el snapshot. Nunca toca los toggles del docente. |
| `buildBlueprintSnapshotV2` | Acepta el diseño opcional; sin diseño, el JSON canónico es byte a byte el de antes (pins en el check). |
| `buildGenerationManifestV3` + `validateGenerationManifestV3` | Copian y verifican el diseño por item; el tipo H5P sale del diseño dentro de los tipos que admite `activityTypeRules`. |
| Huellas de invalidación v3 | Incluyen el diseño solo si existe: cambiar de enfoque regenera lo que depende de él. De `course.pedagogy` entra solo la proyección de diseño (sin `profileSha256` ni `engineVersion`): editar la descripción del estudiante o un resultado no regenera nada. |
| Comparación «estructura viva = Blueprint vigente» | Usa la MISMA función que el lock (`lockPedagogyInput`): con perfil la estructura figura confirmada; guardar otro perfil la marca desactualizada. |
| Estimador FinOps (puro, seed de precios) | El dry-run estima lo que costaría generar, sin ejecutar nada. |
| Panel de perfiles (pantalla de estructura V2) | El panel «Enfoque pedagógico» (49) vive al lado de «Diseño y evaluación» (47). |

Lo que NO se tocó: generadores, prompts, workers, proveedores, empaque, `deploy.yml` (producción) y la lista de migraciones de producción.

## Perfil pedagógico (`pedagogy-profile.ts`)

Estructurado: `primaryApproach`, `secondaryApproaches` (≤ 2), `learner` (descripción, edad, nivel, conocimientos previos, experiencia), `learningOutcomes` (saber / saber hacer / competencias), `learningModes` (P3), `experienceTypes` (P4), `assessmentMethods` (P5), `principles`, `origin` (manual | wizard). El servidor guarda además `designRules` (registro de las reglas derivadas por el motor vigente; las del cliente se ignoran). Perfil vacío (`primaryApproach: null`) = comportamiento anterior.

## Enfoques (datos) y motor (código)

- `vocabulary.ts`: 11 dimensiones, 16 metas de elección única, 2 metas de lista y 33 pasos de secuencia. Cerrado y versionado (`PEDAGOGY_ENGINE_VERSION`).
- `builtin-approaches.ts`: competencias, problemas, experiencial, significativo y autodirigido. Cada uno trae dimensiones, votos con `ruleId` y justificación, listas, secuencia, pasos firma, votos por rol, verbos y afinidad con las 6 preguntas.
- `approach-registry.ts`: valida cada enfoque contra el vocabulario. Agregar un enfoque = registrar un objeto (T13 lo prueba con «aula invertida» sin tocar el motor).
- `design-rules.ts`: pesos 0,6 / 0,4 repartido, mezcla de dimensiones, ajustes por estudiante y respuestas, voto ponderado por meta con traza (`applied` / `overridden`), Borda para listas, secuencia con pasos firma, votos por rol, y derivados (profundidad, interacción, escenarios ramificados, pesos sugeridos).
- `pedagogical-blueprint.ts`: diseño por capítulo INDEPENDIENTE de su posición (las variaciones por rol —apertura / desarrollo / cierre del módulo— se guardan una vez en `course.pedagogy.roleTargets` y el Manifest resuelve el rol al construirse, como la numeración: un reorden no cambia el Blueprint ni sus huellas), sugerencias de estructura (videos por capítulo, actividades, repaso), tipo H5P por capítulo (intención del diseño, objetivo dentro del top-2, tope de escenarios max(1, floor(n/4)), variedad ≤ max(2, ceil(0,6·n))) y revisión de objetivos (verbos no observables).

## «No estoy seguro — ayúdame a elegir» (`recommendation.ts`)

Las 6 preguntas (fuente única: `GET /pedagogy/wizard`) → puntaje por afinidad. Pesos: P1 0,10 · P2 0,15 · P3 0,30 · P4 0,20 · P5 0,25; una pregunta sin respuesta, o «Combinación» sola, vale neutro (0,5). P6 «Sí» pone primero los enfoques elegidos (+0,25). Devuelve el ranking con %, hasta 3 razones por enfoque, la confianza, notas (colaboración y proyectos) y un perfil sugerido. Nunca genera un curso.

## DRY RUN (`dry-run.ts`)

Perfil → reglas → Blueprint (línea base y pedagógico) → Manifest (los dos, validados) → plan de proveedores + estimación (seed de precios), y se detiene. Muestra estructura, módulos, capítulos (secuencia, contenido, video, actividad antes→después), evaluación, retroalimentación, recursos, cambios sugeridos, objetivos a revisar, reglas aplicadas y proveedores que serían necesarios. Las garantías `providersCalled: 0` y `spendUsd: '0.00'` se cumplen por construcción: el módulo no importa clientes de proveedores. T10 lo verifica en un proceso con toda la red bloqueada.

## API (controller V2, oculto con `DYNAMIC_COURSE_STRUCTURE` apagado)

- `GET /api/v1/pedagogy/catalog`: enfoques y etiquetas en español.
- `GET /api/v1/pedagogy/wizard`: las 6 preguntas.
- `POST /api/v1/pedagogy/recommend {answers}`: recomendación (400 con respuestas inválidas).
- `POST /api/v1/pedagogy/dry-run {structure, profile}`: dry-run en línea (máximo 20 módulos × 20 capítulos).
- `POST /api/v1/courses/:id/pedagogy/dry-run {profile?}`: dry-run de la estructura viva del curso. Solo lectura y con control de dueño.
- Guardar: `GET/POST /api/v1/courses/:id/profiles/pedagogy` (la API de perfiles de siempre).

## Pruebas

- `scripts/check-pedagogy-engine.js`: parte pura (las 13 pruebas pedidas + extras) y parte DB con Postgres 16 desechable (migración, perfiles, lock con y sin perfil, dry-run del curso).
- `test/e2e-v2/e2e-v3.js` E6: perfil → lock → Manifest con diseño → run 100 % mock con el ejecutor real → empaque.
- `src/js/__harness__/test-49-pedagogy-panel.mjs` (frontend): panel, asistente, vista previa y errores.
- `scripts/pedagogy-compare.js`: comparación de la Fase 8, el curso RCP con los 5 enfoques (solo dry-run).

## Fase 2 (fuera de alcance)

Conectar `item.design` a los prompt builders (frontend 44 y guion de video del backend) y validarlo con un curso real autorizado. Además:

- botón «Aplicar cambios sugeridos» (usa la API de estructura existente);
- aplicar los pesos sugeridos al perfil de evaluación;
- modelo pedagógico institucional desde PDF/Word;
- más enfoques;
- entrada en la lista de migraciones de producción.
