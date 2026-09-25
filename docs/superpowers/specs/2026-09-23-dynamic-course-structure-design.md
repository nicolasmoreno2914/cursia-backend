# Estructura dinámica de cursos + Course Blueprint — Diseño

> **Alcance:** este spec cruza los dos repos del monorepo — `campuscloud-gen`
> (frontend) y `orbia-backend` (NestJS + Supabase). Se guarda acá por
> convención del proyecto, pero toca ambos.
>
> **Para agentes:** SUB-SKILL REQUERIDO: superpowers:writing-plans para
> convertir esto en plan de implementación, una vez aprobado.

**Objetivo:** reemplazar la estructura rígida de 3 módulos × 3 capítulos por
una estructura dinámica y editable (N módulos, M capítulos cada uno, video y
examen opcionales por capítulo/módulo), manteniendo coherencia pedagógica
antes y después de generar contenido pesado.

**No-objetivo de esta versión:** SCORM configurable (sigue obligatorio por
capítulo), constructor de LMS libre, tipos de actividad más allá de los ya
existentes.

**Restricción dura, no negociable:** `cursia.nomaddi.com` (producción) no se
toca, no se migra, no se pone en riesgo mientras se desarrolla esta
arquitectura. Todo lo de este documento se construye y valida en un entorno
aislado antes de que exista siquiera la posibilidad de que llegue a
producción. Ver sección -1.

---

## -1. Restricción de producción y estrategia de despliegue segura

### Infraestructura real (verificada, no asumida)

Antes de tocar nada se auditó cómo está desplegado hoy cada repo —
esto no es una propuesta, es lo que ya existe y funciona:

**`campuscloud-gen` (frontend, repo `nicolasmoreno2914/cursia`):**
- Ramas reales: `main` (producción), `staging`, más varias `feature/*`.
- Cloudflare Pages despliega automáticamente por rama. `main` →
  `cursia.nomaddi.com`. `staging` → `staging.orbia.pages.dev` (URL de
  preview, ya usada y confirmada funcionando en esta sesión).
  **Un solo punto a confirmar en el dashboard de Cloudflare** (no está en
  el repo, es config de plataforma): que la "Production branch" del
  proyecto Pages sea `main` y que ninguna otra rama tenga el dominio
  custom asociado. Es el comportamiento estándar de Cloudflare Pages y es
  consistente con lo ya observado, pero no está de más verificarlo una
  vez antes de la Fase 0.
- **Corrección sobre una alarma anterior de esta sesión**: se había
  reportado que `src/js/24-backend-client.js:46` hardcodea
  `PROD_URL='https://api.cursia.nomaddi.com'` como default en staging.
  Al leer `_resolveConfig()` completo (líneas 32-80), **eso es incorrecto**:
  el backend está OFF por defecto en cualquier host que no sea
  `cursia.nomaddi.com` (incluido staging), y si se fuerza ON ahí sin fijar
  `CURSIA_BACKEND_URL` explícitamente, cae a `http://localhost:3000`, no a
  producción. Solo llega a `PROD_URL` si alguien pone esa URL a mano en su
  propio `localStorage` — una acción deliberada, no un default peligroso.
  **No hay gap que cerrar acá.** Lo único que queda de esta observación es
  documentar en la Fase 0 cómo apuntar el backend de staging
  explícitamente a `api-staging.cursia.nomaddi.com` vía
  `CURSIA_BACKEND_URL` cuando se quiera probar el modo "backend + sesión"
  ahí (hoy, sin esa variable puesta, simplemente no habla con ningún
  backend en staging — modo 100% local).

**`orbia-backend` (repo `nicolasmoreno2914/cursia-backend`):**
- Ramas reales: `main` (producción), `staging`, más `feature/*`.
- **Ya existen dos workflows de deploy completamente separados**:
  `.github/workflows/deploy.yml` (trigger solo `push: main` → VPS Contabo
  `<VPS_HOST>`, directorio `cursia-backend`, procesos PM2
  `cursia-backend`/`cursia-*-worker`) y
  `.github/workflows/deploy-staging.yml` (trigger solo `push: staging` →
  **mismo VPS pero directorio, puerto y procesos PM2 propios**
  `cursia-backend-staging`/`cursia-*-worker-staging`, nunca toca el
  directorio de producción).
- **Ya existe un proyecto de Supabase separado para staging** — las
  credenciales viven en el `.env` propio del directorio de staging en el
  VPS, creado a mano una sola vez, nunca sincronizado por `rsync`
  (ambos workflows excluyen `.env`/`.env.*` explícitamente). Esto es la
  pieza más importante: **las migraciones de base de datos que se corran
  en el pipeline de staging pegan contra una base de datos física
  distinta a la de producción.** No hay riesgo de migración cruzada
  mientras el trabajo se mantenga en la rama `staging` y no se mergee a
  `main`.

**Conclusión: no hace falta construir infraestructura nueva.** Ya existe
todo lo que la sección 8 de tu mensaje pedía (dominio/entorno separado,
backend separado, DB separada). El trabajo de "entorno aislado" se reduce
a: (1) documentar cómo apuntar explícitamente el frontend de staging al
backend de staging cuando haga falta probar el modo "backend + sesión"
ahí (por defecto ya está OFF en cualquier host que no sea
`cursia.nomaddi.com` — no hace falta arreglar nada, solo dejarlo por
escrito), y (2) disciplina de ramas (nunca mergear a `main` hasta validar
completo en `staging`).

### Diagrama: producción actual vs. entorno V2

```
┌───────────────────────────────┐        ┌───────────────────────────────┐
│         PRODUCCIÓN             │        │       STAGING / V2             │
│                                 │        │                                 │
│  cursia.nomaddi.com             │        │  staging.orbia.pages.dev        │
│  (Cloudflare Pages, rama main)  │        │  (Cloudflare Pages, rama staging)│
│         │                       │        │         │                       │
│         ▼                       │        │         ▼ (CURSIA_BACKEND_URL │
│  api.cursia.nomaddi.com         │        │           apuntado a mano)     │
│  (VPS Contabo, PM2:             │        │  api-staging.cursia.nomaddi.com │
│   cursia-backend +              │        │  (mismo VPS, directorio propio, │
│   cursia-*-worker)              │        │   PM2: cursia-backend-staging + │
│         │                       │        │   cursia-*-worker-staging)      │
│         ▼                       │        │         │                       │
│  Supabase PROYECTO PRODUCCIÓN   │        │         ▼                       │
│  (cursos reales, datos reales)  │        │  Supabase PROYECTO STAGING       │
│                                 │        │  (aislado, ya existe)           │
│  Estructura: 3×3 legacy         │        │  Estructura: 3×3 legacy +       │
│  SIN CAMBIOS EN TODO ESTE PLAN  │        │  dynamic (nueva), conviven      │
└───────────────────────────────┘        └───────────────────────────────┘
        rama: main                                rama: staging
        NUNCA se mergea código nuevo               TODO el desarrollo pasa
        de esta iniciativa acá hasta               por acá primero, se valida
        validación completa                        completo antes de evaluar
                                                    un merge futuro a main
```

Ninguna dependencia de V2 (tablas nuevas, endpoints nuevos, editor nuevo)
puede alcanzar producción salvo por un merge explícito y consciente a
`main` — y ese merge no ocurre como parte de este plan, es una decisión
posterior, deliberada, después de validar todo en staging.

### Estrategia de coexistencia: legacy + dynamic (tu opción A, con ajuste)

De tus 3 opciones (A: legacy temporal + dynamicV2 en paralelo, B:
arquitectura única compatible con ambos formatos, C: feature flag), la
respuesta correcta es **A + C combinadas, no una sola**:

- **C (feature flag) gatea el ENTORNO**: `DYNAMIC_COURSE_STRUCTURE=false`
  en el `.env` de producción (ni siquiera se expone el endpoint/UI nuevo
  ahí), `=true` en el `.env` de staging. Esto es la primera barrera: en
  producción, el código nuevo puede existir desplegado pero
  inalcanzable.
- **A (campo por curso) gatea la INSTANCIA**: `courses.structure_version`
  (`'legacy' | 'dynamic'`, default `'legacy'`). Esta es la segunda
  barrera, independiente de la primera: aunque el flag de entorno
  estuviera mal configurado, un curso legacy nunca ejecuta código nuevo
  porque el dispatcher decide por este campo, no por el entorno.
- **B (arquitectura única) se descarta explícitamente para esta
  transición** — unificar los dos formatos en una sola implementación
  ahora significaría tocar el código de generación que hoy sostiene
  producción real. Vos mismo lo dijiste: preferís seguridad y rollback
  simple antes que refactor masivo. La unificación, si alguna vez tiene
  sentido, es trabajo de una fase muy posterior, después de que `dynamic`
  esté probado y `legacy` ya no tenga cursos activos.

Con las dos barreras juntas: para que un curso real ejecute código nuevo
en producción hacen falta DOS fallas simultáneas (flag de entorno mal
puesto Y alguien creó el curso como `dynamic` a mano) — no una sola.

### Dispatcher, no refactor

**Backend** (`content-generation.service.ts` y demás): se agrega un punto
de entrada único que lee `course.structure_version` y delega:
```
if (course.structure_version === 'legacy') return legacyGenerate(...); // código actual, sin tocar una línea
if (course.structure_version === 'dynamic') return dynamicGenerate(...); // código nuevo
```
`legacyGenerate` es literalmente las funciones actuales
(`buildNormalizedModules()` con sus loops `for(index<3)`, etc.) **sin
modificar ni una línea** — se llaman desde el dispatcher, no se tocan por
dentro. Sí, esto es duplicación temporal a propósito — es el costo
explícito que pediste pagar a cambio de rollback trivial: si `dynamic`
falla en cualquier forma, `legacy` sigue siendo código intacto, nunca
tocado, corriendo exactamente igual que hoy.

**Frontend** (`18-cursia-structure.js`): mismo patrón.
`orbSyncToInputs()` (el aplanado a los 12 campos fijos) **no se borra ni
se modifica**. Se agrega `saveStructureToDynamicAPI()` como función nueva,
y un punto de decisión en el flujo de "Continuar" que llama a una u otra
según `DYNAMIC_COURSE_STRUCTURE` (flag de build/entorno) esté activo y el
curso sea nuevo. Un usuario de producción hoy pasa por el mismo código
exacto que pasa hoy, sin ninguna rama condicional nueva en su camino.

### Migraciones: solo aditivas

Confirmado y sin excepciones para todo este plan: `CREATE TABLE`,
`ALTER TABLE ... ADD COLUMN` (con default o nullable, nunca `NOT NULL`
sin default sobre una tabla con filas existentes). Cero `DROP`, cero
`RENAME` destructivo, cero reescritura de filas existentes. Una tabla
nueva vacía o una columna nueva con default no cambia el comportamiento
de una sola fila que ya existe. Esto se cumple automáticamente porque
estas migraciones corren primero (y, mientras dure este plan,
únicamente) contra la base de datos de staging — nunca contra la de
producción, que ni siquiera las recibe hasta un merge a `main` futuro y
explícito.

### Cursos existentes: no hay backfill en este plan

Se adopta tu propuesta de la sección 5 tal cual, reemplazando la Fase 2
del plan original (que sí proponía backfill completo desde el día 1):
**cursos existentes siguen 100% en `legacy`, para siempre, hasta que se
decida lo contrario en una fase totalmente separada y posterior**, con su
propio spec (dry-run, backup, validación, reporte de fallos, rollback).
No es parte de este documento. Cursos nuevos creados en el entorno de
staging con el flag activo nacen directamente en `dynamic`.

### Rollout gradual (tu sección 13, con la secuencia concreta)

1. **Solo staging** — todo el desarrollo y validación de este plan ocurre
   acá. Nada de lo siguiente empieza hasta que esto esté completo.
2. **Pruebas internas en staging** — vos (y quien más corresponda)
   genera cursos reales con estructura no-3×3 en `staging.orbia.pages.dev`,
   valida Moodle real, valida coherencia, valida costos.
3. **Decisión explícita de merge a `main`** — punto de no-retorno
   consciente, con el código ya detrás del flag de entorno
   (`DYNAMIC_COURSE_STRUCTURE=false` en el `.env` de producción desde el
   primer merge, para que llegue "apagado").
4. **Flag activado en producción solo para casos puntuales** — activarlo
   primero para una cuenta/curso de prueba tuya en producción, nadie más.
5. **Habilitación general para cursos nuevos** — el editor dinámico
   aparece para todos los usuarios al crear un curso nuevo.
6. **Migración opcional de cursos legacy** — fase independiente, futura,
   fuera de este documento.

Cada etapa es reversible con un solo cambio: apagar el flag de entorno.
Ningún curso `legacy` se ve afectado en ninguna etapa.

---

## 0. Grounding — qué existe hoy realmente

Esto no es un diseño en el vacío. Antes de proponer nada se auditó el código
real:

**Frontend (`campuscloud-gen`):**
- `D.mods`/`D.caps` (`01-state.js:673-687`) son arrays de longitud fija (3 y
  9), construidos desde 12 inputs ocultos fijos (`m1-n`, `m1-c1..m3-c9`,
  `CC_FIELDS` en `01-state.js:57-59`). El número de capítulo (`cap.n`) es
  **posicional, calculado** (`mi*3+ci+1`) — ya es la idea correcta, solo que
  atada a un tamaño fijo.
- **Ya existe un editor dinámico de estructura**: `src/js/18-cursia-structure.js`
  (`ORB_MODS`, pantalla `#panel-estructura`) permite agregar/quitar
  módulos y capítulos en memoria (`orbAttachEvents`, `.push`/`.splice`). Pero
  está artificialmente limitado a 3×3 (`18-cursia-structure.js:210,235`,
  texto literal "hasta 3 módulos con 3 capítulos cada uno") y al confirmar
  (`orbSyncToInputs`, líneas 66-92) **aplana todo de vuelta a los 12 campos
  fijos**, descartando cualquier módulo/capítulo más allá del 3×3.
- El 3×3 está horneado en ~8 lugares más: mapeo de secciones Moodle en
  `09-mbz.js:189-204` (asume exactamente 9 capítulos en 3 grupos de 3),
  prompts de `05-libro.js:145-167` ("3 módulos, 9 capítulos", "9 secciones"),
  contadores de progreso en `31-course-production.js` (`/9` hardcodeado en
  5+ lugares), textos de examen final en `07-examenes.js:4-5,199` ("50
  preguntas, 3 unidades").
- Exámenes (`07-examenes.js`) y videos (`22-video-engine.js`) **ya iteran
  dinámicamente** sobre `D.mods.length`/`D.caps.length` — no tienen un loop
  fijo `for(i<9)`. El hardcodeo ahí es solo en texto/prompts y contadores de
  UI, no en la lógica de iteración. Esto reduce el blast radius real.

**Backend (`orbia-backend`):**
- `courses` (id SERIAL) y **`course_versions`** (id SERIAL, `course_id` FK,
  `version_number INT`, `snapshot_json JSONB`, `manifest_json JSONB`) —
  **esto ya es prácticamente una tabla de versiones de blueprint**, con
  historial real por versión. No hace falta inventar una tabla nueva para
  versionado, hay que extenderla/reutilizarla.
- `production_jobs` (id UUID, `status` con lifecycle
  queued|running|waiting_external|retrying|paused|blocked|failed_recoverable|failed|completed|cancelled,
  `attempt_count`/`max_attempts` con backoff, `lease_until`/`worker_id` para
  claim pattern, `input_payload`/`output_summary` JSONB) — es una tabla
  genérica de jobs, no una por tipo. Sirve tal cual para jobs dinámicos, con
  un agregado menor (ver Fase 4).
- `artifacts` (id UUID, `type` enum, `course_id`+`job_id`+`type`) — sin
  columna de versión propia, pero con `metadata JSONB` disponible para
  extender.
- **`content-generation.service.ts` tiene el MISMO hardcodeo 3×3** que el
  frontend: `buildNormalizedModules()` (líneas 128-146) itera
  `for(index<3)` / `for(capIndex<3)` sin importar cuántos módulos/capítulos
  venían en la entrada. `PHASE_TOTALS` también es un mapa fijo. Es decir, el
  backend nunca tuvo estructura variable tampoco — hay que arreglarlo ahí
  también, no es solo un problema de frontend.

Esto cambia el punto de partida de tu propuesta original en dos formas
importantes:
1. El editor de estructura **no hay que construirlo desde cero** — hay que
   liberar el que ya existe (`18-cursia-structure.js`) y cambiar su
   serialización de "aplanar a 12 campos fijos" a "escribir contra el
   Blueprint real".
2. El versionado **no hay que inventarlo** — `course_versions` ya es
   prácticamente la tabla de `blueprint_versions` que proponías en la
   sección 11 de tu brief. Se repropone/extiende, no se crea una nueva.

---

## A. Respuesta directa a tus preguntas de diseño (1-9): Blueprint

**1. ¿Tiene sentido un Course Blueprint como fuente de verdad?** Sí, pero no
como un blob JSON aislado. Ver punto 3.

**2-3. ¿Cómo modelarlo? ¿JSON, relacional, o ambos?** Híbrido, y esto es una
corrección directa a tu propuesta: un Blueprint **puramente JSON** (como en
tu ejemplo de la sección 7) es cómodo para mandarle a un LLM, pero es malo
para todo lo demás que necesitás: integridad referencial con jobs y
artifacts, queries ("¿qué capítulos necesitan video?"), updates atómicos
concurrentes, índices. Y un modelo **puramente relacional** sin ningún
snapshot inmutable te deja sin la garantía de "todos los workers ven la
misma verdad" que vos mismo identificás como problema en la sección 10.

Propuesta: **el Blueprint vive en dos capas**:
- **Capa viva (relacional)**: `course_modules` y `course_chapters` — el
  estado editable, lo que el usuario ve y modifica en tiempo real en el
  editor de estructura. Esto es lo que respondés en tus preguntas 4-6.
- **Capa congelada (JSONB, versión inmutable)**: cuando el usuario confirma
  la estructura (botón "Continuar"), se toma un snapshot completo de la capa
  viva y se graba en `course_versions.snapshot_json` (tabla que ya existe).
  Cada job de generación referencia esa versión, nunca la capa viva
  directamente. Esto resuelve tu pregunta 8 (coherencia entre workers
  concurrentes) de raíz: un worker que lee `blueprint_version_id=7` nunca ve
  un capítulo que el usuario borró después de que empezó a generar.

**4. Course, Module, Chapter:**

```sql
-- ya existe, sin cambios estructurales
courses (id, owner_id, title, status, metadata jsonb, ...)

-- NUEVO
course_modules (
  id            uuid primary key default gen_random_uuid(),
  course_id     int references courses(id),
  position      int not null,          -- orden, 0-based o 1-based, reasignado en cada escritura
  title         text not null,
  objective     text,
  exam_enabled  boolean not null default true,
  status        text not null default 'draft', -- draft|locked
  created_at    timestamptz default now(),
  updated_at    timestamptz default now(),
  unique(course_id, position)
)

-- NUEVO
course_chapters (
  id                          uuid primary key default gen_random_uuid(),
  course_id                   int references courses(id),
  module_id                   uuid references course_modules(id) on delete cascade,
  position                    int not null,   -- posición DENTRO del módulo
  title                       text not null,
  objective                   text,
  video_enabled               boolean not null default false,
  status                      text not null default 'not_generated',
    -- not_generated | generating | ready | stale | failed
  context_summary             jsonb,          -- ver sección H (Context Package)
  generated_with_version_id   int references course_versions(id),
  created_at                  timestamptz default now(),
  updated_at                  timestamptz default now(),
  unique(module_id, position)
)
```

**El número visible de capítulo/módulo (Cap 1, Cap 2...) NUNCA se
almacena.** Se calcula en el momento de mostrar, iterando módulos por
`position` y, dentro de cada uno, capítulos por `position`, acumulando un
contador global. Esto es exactamente tu instinto en la sección 2 ("la
identidad debería ser un ID estable y la numeración depender de la
posición") — ya estaba bien pensado, solo faltaba el modelo de datos que lo
sostenga.

**5. `videoEnabled`/`examEnabled`:** tal cual las proponés — booleano en
`course_chapters`/`course_modules`. Lo importante no es el campo, es qué
hace con él la capa de generación (ver sección I): el Generation Manifest
lee el blueprint congelado y arma la lista de jobs a crear filtrando por
estos flags. La condicional vive UNA vez, al armar el manifest — no
salpicada dentro de cada worker.

**6. Orden sin depender de numeración visible:** `position` INT, único
dentro de su scope (módulo para capítulos, curso para módulos),
reasignado (resequence 0..N-1) en la misma transacción cada vez que hay
insert/delete/reorder. Evalué "fractional indexing" (posiciones tipo
1.5 para insertar sin reescribir todo) y lo descarto para v1: la
edición de estructura es de un usuario a la vez, sobre decenas de filas
como mucho — reescribir todas las posiciones en una transacción es
trivial en costo y muchísimo más simple de razonar. No lo compliques.

---

## B. Coherencia pedagógica (preguntas 7, 16, y sección 5-6 de tu brief)

Tu pregunta 41 (LLM único vs. agentes vs. reglas vs. embeddings vs. grafo)
tiene una respuesta híbrida, en capas — no es "o LLM o reglas", es cada
herramienta donde rinde:

**Capa 1 — Determinística (código, sin LLM), corre siempre, instantánea:**
- Todo módulo tiene ≥1 capítulo (bloqueante, no se puede guardar si no).
- `position` contiguo y único (lo garantiza la transacción de escritura).
- Ningún examen referencia un módulo inexistente, ningún video referencia
  un capítulo inexistente (integridad referencial, la da la FK).
- Blueprint tiene al menos 1 módulo.

**Capa 2 — Similaridad semántica (embeddings, NO LLM generativo), corre en
cada edición, barata y rápida:**
- Al guardar título+objetivo de un capítulo, calculás su embedding y lo
  comparás (coseno) contra los demás capítulos del curso. Por encima de un
  umbral (ej. 0.85) marcás "posible duplicado" en la UI del editor,
  **en vivo, sin esperar a ningún botón de "Continuar"**. Esto es
  exactamente tu ejemplo de "Tipos de bombas" vs. "Tipos y características
  de bombas" — se detecta con una operación vectorial de centavos de
  costo, no con una llamada a un LLM por par de capítulos.

**Capa 3 — Revisión curricular (1 sola llamada LLM), corre al confirmar la
estructura ("Continuar"), antes de congelar la versión:**
- Se le manda al LLM un **outline compacto**, no contenido completo (que
  todavía no existe en esta etapa): objetivo del curso, y por cada módulo
  su título+objetivo+examEnabled, y por cada capítulo su
  título+objetivo+videoEnabled+posición. Para un curso de 30 capítulos esto
  son unas pocas KB de texto, no el curso entero.
- El LLM devuelve JSON estructurado: lista de hallazgos con
  `{severity, moduleId?, chapterId?, issue, suggestion}` para: progresión
  incorrecta (conceptos avanzados antes que fundamentos), objetivos del
  curso no cubiertos por ningún módulo, módulos sin propósito claro,
  duplicados que la Capa 2 ya marcó (se los pasás como candidatos para que
  el LLM confirme/descarte, en vez de que compare todo desde cero).
- Esto responde tu pregunta 43 (riesgos): un LLM de revisión puede tener
  falsos positivos — por eso esto es una **lista de advertencias que el
  usuario puede aceptar o descartar en el editor**, nunca un bloqueo duro
  salvo violaciones de la Capa 1.

**Sobre el "grafo de conceptos" (tu pregunta 14 y la lista de ideas en 18):
lo recomiendo CORTAR de v1.** Un grafo de dependencias formal (nodos,
aristas, validación topológica) es ingeniería pesada para un problema que,
a la escala real de un curso (decenas de capítulos, no miles), la Capa 3
ya resuelve razonablemente bien vía lenguaje natural. Si en producción se
demuestra que el LLM se equivoca sistemáticamente en cursos grandes,
recién ahí vale la pena construir el grafo. Construirlo antes de tener esa
señal es sobre-ingeniería.

**Sobre coherencia de CONTENIDO ya generado** (capítulos que ya tienen
texto real, no solo blueprint): esto es un chequeo distinto y más caro,
porque ahí sí hay contenido real que comparar. Recomiendo que sea
**opcional, bajo demanda** ("auditoría profunda"), no parte del flujo
estándar — y que use los `context_summary` (resúmenes cortos, ver sección
H) en vez de mandar el contenido completo de cada capítulo, por costo.

---

## C. Context Package por capítulo (preguntas 11-15, 17)

Tu instinto de sección 9 es correcto — evitar "genera un capítulo sobre X"
aislado, y evitar mandar el curso completo. La implementación concreta:

Cada capítulo, al generarse, además del contenido educativo, el mismo
prompt le pide al LLM que devuelva (en el mismo JSON de salida, sin llamada
extra) un resumen estructurado corto:

```json
{
  "content": "... contenido completo del capítulo ...",
  "context_summary": {
    "concepts_introduced": ["bomba centrífuga", "caudal", "presión de succión"],
    "concepts_assumed": ["circulación del agua", "componentes del sistema"],
    "key_terms": ["NPSH", "cavitación"]
  }
}
```

Esto se guarda en `course_chapters.context_summary` (JSONB). El prompt del
**siguiente** capítulo recibe:
- Constantes del curso (objetivo, competencia) — una vez, es barato.
- Objetivo del módulo actual.
- `context_summary` del capítulo INMEDIATO anterior (no todos los
  anteriores completos).
- `concepts_introduced` acumulados de TODOS los capítulos previos del
  mismo módulo (son listas cortas de términos, no prosa — concatenar 5
  resúmenes de 3-6 términos cada uno son ~30 palabras, no miles).
- Título+objetivo (no contenido, todavía no existe) del capítulo
  siguiente en el blueprint, para que el LLM sepa hacia dónde no
  adelantarse.

Esto acota el contexto a **tamaño constante por capítulo**,
independientemente de si el curso tiene 9 o 90 capítulos — responde
directamente tu pregunta 17/12.

---

## D. Versionado del Blueprint (preguntas 28-30)

Reusar `course_versions` tal cual, con dos agregados de columna:
`locked_at timestamptz` (null mientras es editable, seteado al congelar) y
confirmar que `snapshot_json` contenga el árbol completo módulos+capítulos+
flags al momento del lock.

`course_chapters.generated_with_version_id` (ya en el DDL de arriba) es tu
propio ejemplo de la sección 11, tal cual. La regla de "desactualizado":

```
recurso.stale = (recurso.generated_with_version_id != course.current_version_id)
```

pero — y esto es importante — **no marcás todo como stale automáticamente
al crear una versión nueva**. Ver Invalidación (sección F): la versión
nueva se crea, pero cada recurso se marca `stale` solo si el motor de
invalidación determina que el cambio específico lo afecta. Si edito el
título del Módulo 3 y el capítulo 1 vive en el Módulo 1, el capítulo 1 no
se toca.

---

## E. Concurrencia entre workers (pregunta 8, sección 10)

Respuesta directa a tus 3 preguntas de cierre de esa sección:
- **¿El Blueprint debe ser inmutable durante la generación?** Sí.
- **¿Cada worker recibe un snapshot?** Sí — cada `production_job` creado
  para una corrida de generación lleva `blueprint_version_id` (agregar
  como columna real, no solo dentro de `input_payload` JSONB, porque vas a
  necesitar filtrar/joinear por esto seguido: "todos los jobs de la
  versión 7").
- **¿Necesitás versiones?** Sí, y ya las tenés (`course_versions`).

Con esto, dos workers generando capítulos en paralelo nunca pueden
divergir sobre "cuántos capítulos tiene el módulo 2" — ambos leen la misma
fila congelada de `snapshot_json`, no la tabla viva que el usuario podría
estar editando en otra pestaña en simultáneo.

**Candado adicional, no opcional:** mientras un curso tiene una corrida de
generación activa (`production_jobs` con status queued/running para ese
`course_id`), el editor de estructura se bloquea para ese curso (solo
lectura). Esto es más simple y más seguro que intentar reconciliar
ediciones en vivo contra jobs en vuelo, y responde tu pregunta 33
("condiciones de carrera entre workers") eliminando la causa raíz en vez
de mitigarla con locks finos.

---

## F. Invalidación (preguntas 22-27, sección 12)

Tabla de reglas determinística (código, no LLM) — cada tipo de cambio
estructural dispara una acción concreta:

| Cambio | Acción |
|---|---|
| Agregar capítulo | Nuevo capítulo → generar. Vecinos → **no se tocan automáticamente**. Se corre la Capa 3 de coherencia; si detecta un problema puntual en un vecino, ESE capítulo se marca `stale` con motivo explícito. |
| Eliminar capítulo | El capítulo desaparece (soft-delete, no hard-delete — ver abajo). El examen del módulo → `stale`. Otros módulos → sin cambios. |
| Capítulo cambia de módulo | Se trata como eliminar+agregar: contenido → `stale` (el objetivo del módulo cambió). Video/SCORM ya generados → se conservan si videoEnabled sigue true (no dependen del módulo). Examen del módulo viejo Y del nuevo → `stale`. |
| Reordenar capítulos (mismo módulo) | Por sí solo, **no regenera nada** — reordenar no cambia contenido. Dispara re-chequeo de Capa 3; solo lo que el chequeo señale puntualmente pasa a `stale`. |
| Editar título/objetivo de capítulo | Ese capítulo → `stale`. Downstream → no automático, solo vía Capa 3. |
| `videoEnabled: false→true` | Se crea SOLO el job de video para ese capítulo. Contenido/SCORM no se tocan. |
| `videoEnabled: true→false` | El video existente se **desactiva** (`artifacts.metadata.disabled=true`), no se borra. Se excluye del empaquetado. Reversible sin volver a gastar crédito de IA. |
| `examEnabled: false→true` | Se crea job de examen para ese módulo, con el set de capítulos actual. |
| `examEnabled: true→false` | Igual patrón: desactivar, no borrar. |

**Por qué "no se tocan automáticamente" en vez de tu propuesta original
("capítulo siguiente: quizás revisar")**: marcar vecinos como "para
revisar" en cada edición estructural, en un curso con edición frecuente,
genera fatiga de alertas — el usuario deja de prestarles atención. Es más
confiable dejar que la Capa 3 (que sí entiende el contenido real) decida
puntualmente cuándo algo realmente quedó incoherente, en vez de una regla
gruesa "todo lo adyacente es sospechoso".

**Regla general sobre borrado: nunca hard-delete de recursos generados**
(video, audio, examen). Siempre soft-disable con motivo. Esto es coherente
con lo que ya documenta el `CLAUDE.md` del proyecto sobre no degradar
trabajo silenciosamente — acá aplica al revés: no perder trabajo
silenciosamente tampoco.

**Examen tras eliminar un capítulo del módulo:** no intentes parchear el
banco de preguntas existente quitando solo las preguntas del capítulo
eliminado — es lógica frágil y el ahorro de costo es marginal (un examen
es barato de regenerar comparado con video/contenido). Regenerar completo
cuando queda `stale`.

---

## G. Modelo de datos — resumen de tablas (preguntas 35-38)

**Reutilizar, no crear de cero** — esta es la corrección más importante a
tu lista de ideas (sección 18):

| Tu propuesta | Qué hacer realmente |
|---|---|
| Course, CourseBlueprint/Version, Module, Chapter, Resources, GenerationJob | `courses` (existe) + `course_modules`/`course_chapters` (nuevas, ver sección A) + `course_versions` (existe, reutilizar como blueprint_versions) + `artifacts` (existe, agregar `module_id`/`chapter_id` nullable + `status` + `generated_with_version_id`) + `production_jobs` (existe, agregar columna `blueprint_version_id`) |
| "Resources" como entidad nueva | No — `artifacts` ya cubre el 90% del rol, extenderla es más barato que migrar a una entidad nueva |
| Redis para algo | No hace falta — el lease-based claiming (`lease_until`/`worker_id`) ya vive en Postgres y a esta escala (cursos, no eventos de alto volumen) no hay motivo para introducir otra pieza de infraestructura |
| Dependency Graph | Cortar de v1 (ver sección B) |
| Generation Manifest | Mantener el nombre — es el paso que traduce blueprint congelado → lista de `production_jobs` a crear (código, no tabla nueva) |

---

## H. Migración de cursos existentes — riesgo que tu brief no cubre

Los cursos ya generados en producción (y sus datos en `content_snapshot`)
viven en el formato viejo 3×3 sin `course_modules`/`course_chapters` reales
ni UUIDs de capítulo. Antes de activar edición dinámica para cursos
existentes hace falta un script de backfill: por cada curso actual, leer su
`D.mods`/`D.caps` (desde el snapshot más reciente) y crear las filas
`course_modules`/`course_chapters` correspondientes, marcándolas
`status='ready'` con `generated_with_version_id` apuntando a una versión 1
sintética. Cursos nuevos nacen directamente en el modelo nuevo. Esto es
trabajo de una fase dedicada (Fase 8 abajo), no accesorio.

---

## I. Riesgos y edge cases adicionales (no cubiertos en tu brief)

- **Módulo con 0 capítulos**: prohibido por validación determinística
  (Capa 1), no un caso a manejar en generación.
- **Curso de 1 solo módulo**: válido, ningún código debe asumir ≥2 módulos
  (auditar `07-examenes.js`/`05-libro.js` durante la implementación, ya
  que hoy asumen 3 en texto de prompts).
- **Edición concurrente de estructura** (dos pestañas del mismo usuario, o
  dos usuarios): agregar `courses.structure_version INT` que se
  incrementa en cada escritura estructural; el editor manda la versión que
  tenía al guardar, y si no coincide con la actual el backend rechaza con
  conflicto (optimistic concurrency), en vez de pisarse silenciosamente.
- **Edición durante generación activa**: bloqueada por completo (sección
  E), no reconciliada en vivo.
- **Costo de la Capa 3 en cursos grandes**: un outline de 50+ capítulos
  sigue siendo unas pocas KB — no es un problema real hasta órdenes de
  magnitud mayores a lo que este producto genera.

---

## J. Plan de fases (revisado — producción intacta hasta validación completa)

Regla de lectura para todas las fases: **todo ocurre en la rama `staging`
de ambos repos, contra el proyecto de Supabase de staging, salvo que se
indique explícitamente lo contrario.** Ninguna fase mergea a `main`.

### Fase 0 — Preparación segura (nueva, precondición de todo lo demás)
**Objetivo:** confirmar por escrito que el punto de partida es seguro y
dejar documentado cómo apuntar staging a su propio backend, antes de
escribir una sola línea de la arquitectura nueva.
**Repositorio afectado:** ninguno en código — es verificación +
documentación. `_resolveConfig()` en `24-backend-client.js` ya hace lo
correcto (backend OFF por defecto fuera de `cursia.nomaddi.com`; forzarlo
ON en staging sin URL explícita cae a `localhost:3000`, nunca a
producción) — no se modifica.
**Archivos afectados:** ninguno de código. Se agrega una nota en
`CLAUDE.md` (o donde el proyecto documente esto) explicando que para
probar el modo "backend + sesión" en staging hay que setear a mano, en
la consola del navegador:
`localStorage.setItem('CURSIA_BACKEND_ENABLED','true'); localStorage.setItem('CURSIA_BACKEND_URL','https://api-staging.cursia.nomaddi.com');`
**Base de datos afectada:** ninguna todavía.
**Endpoints:** ninguno todavía.
**Cambios frontend:** ninguno.
**Cambios backend:** ninguno de código — solo verificación operativa:
confirmar que `deploy-staging.yml` corre limpio hoy contra su `.env`
propio (health check en verde: `curl https://api-staging.cursia.nomaddi.com/health`),
y confirmar en el dashboard de Cloudflare Pages que `main` es la única
rama con el dominio custom asociado.
**Compatibilidad con legacy:** total — no se toca ningún código.
**Feature flags:** se crea (sin usar todavía) `DYNAMIC_COURSE_STRUCTURE`
en el `.env` de staging (`true`) y se documenta que el de producción
debe quedar `false`/ausente siempre.
**Pruebas:** con las dos líneas de `localStorage` de arriba pegadas en la
consola de `staging.orbia.pages.dev`, confirmar en la pestaña Network que
las llamadas van a `api-staging.cursia.nomaddi.com`; sin esas líneas,
confirmar que no sale ninguna llamada a backend (modo local puro, el
default de hoy).
**Rollback:** no aplica — no hay cambio de código que revertir.
**¿Afecta producción?** No. **¿Modifica datos?** No. **¿Backward
compatible?** Sí, no hay cambios.
**Riesgo:** ninguno — es un paso de verificación y documentación.
**Criterio de aceptación:** health check de staging responde OK; queda
documentado el procedimiento de apuntar staging a su propio backend;
confirmado en Cloudflare que `main` es la única rama con dominio custom.

### Fase 1 — Modelo de datos (aditivo, solo staging)
**Objetivo:** que exista el modelo relacional nuevo en la base de datos
de staging, sin ningún lector/escritor real todavía.
**Repositorio:** `orbia-backend`.
**Archivos:** nueva migración SQL (`migrations/xxxx_dynamic_structure.sql`
o equivalente al patrón ya usado en el repo), entidades TypeORM nuevas
`CourseModule`/`CourseChapter`.
**Base de datos:** `CREATE TABLE course_modules`, `CREATE TABLE
course_chapters` (columnas de la sección A); `ALTER TABLE courses ADD
COLUMN structure_version TEXT NOT NULL DEFAULT 'legacy'`, `ADD COLUMN
structure_version_counter INT NOT NULL DEFAULT 0` (optimistic
concurrency); `ALTER TABLE course_versions ADD COLUMN locked_at
TIMESTAMPTZ`; `ALTER TABLE artifacts ADD COLUMN module_id UUID NULL, ADD
COLUMN chapter_id UUID NULL, ADD COLUMN status TEXT NULL, ADD COLUMN
generated_with_version_id INT NULL`; `ALTER TABLE production_jobs ADD
COLUMN blueprint_version_id INT NULL`. Todas nullable o con default —
ninguna fila existente cambia de comportamiento.
**Endpoints:** ninguno todavía (solo esquema).
**Cambios frontend:** ninguno.
**Cambios backend:** ninguno de lógica — solo esquema y entidades.
**Compatibilidad con legacy:** total, por diseño (aditivo puro).
**Feature flags:** no aplica todavía (nada las lee).
**Pruebas:** migración corre limpio en staging; un `SELECT` sobre
`courses` en staging después de la migración muestra
`structure_version='legacy'` en todos los cursos existentes sin haberlos
tocado explícitamente.
**Rollback:** `DROP TABLE course_modules, course_chapters` +
`ALTER TABLE ... DROP COLUMN` de las columnas agregadas — reversible sin
pérdida de datos porque nada las usó todavía.
**¿Afecta producción?** No (corre solo contra Supabase de staging).
**¿Modifica datos?** No modifica ninguna fila existente, solo agrega
estructura vacía. **¿Backward compatible?** Sí.
**Riesgo:** muy bajo.
**Criterio de aceptación:** esquema nuevo existe en staging; producción
no recibió ninguna migración (verificable: el pipeline de `main` no se
ejecutó).

### Fase 2 — Dispatcher backend (legacy intacto + rama dynamic vacía)
**Objetivo:** introducir el punto de decisión `structure_version` sin que
todavía exista contenido real del lado `dynamic` — solo separar los dos
caminos de código.
**Repositorio:** `orbia-backend`.
**Archivos:** `content-generation.service.ts` — agregar el dispatcher al
inicio de `generateCourseContent()` (o equivalente), extraer el código
actual tal cual a `legacyGenerate()` (copy, no refactor), y un
`dynamicGenerate()` que por ahora lanza "no implementado" si se llega a
invocar.
**Base de datos:** ninguna nueva.
**Endpoints:** ninguno nuevo todavía.
**Compatibilidad con legacy:** total — `legacyGenerate()` es
byte-idéntico al código actual, solo movido de lugar; todo curso con
`structure_version='legacy'` (el default, o sea todos los existentes)
sigue el mismo camino exacto que hoy.
**Feature flags:** el dispatcher no depende de `DYNAMIC_COURSE_STRUCTURE`
— depende únicamente de `course.structure_version`, que en esta fase es
siempre `'legacy'` para cualquier curso real.
**Pruebas:** generar un curso normal en staging (backend+sesión) y
confirmar que el resultado es idéntico a antes de este cambio (mismo
número de archivos, mismo shape) — es un refactor de "mover código", el
test es "nada cambió".
**Rollback:** revertir el commit — el dispatcher es una capa fina, sin
estado en DB.
**¿Afecta producción?** No hasta que esto se mergee a `main`, lo cual no
ocurre en este plan. **¿Modifica datos?** No. **¿Backward compatible?**
Sí, por construcción.
**Riesgo:** bajo-medio — es el cambio más delicado sobre código que hoy
sostiene producción real, por eso se aísla en su propia fase, sin mezclar
con lógica nueva, y se valida exhaustivamente en staging antes de seguir.
**Criterio de aceptación:** 100% de los cursos generados en staging
durante esta fase (todos `legacy`) producen el mismo resultado que antes
del refactor.

### Fase 3 — Editor de estructura desbloqueado (detrás del flag)
**Objetivo:** `18-cursia-structure.js` gana un camino nuevo
(`saveStructureToDynamicAPI()`) sin tocar `orbSyncToInputs()`.
**Repositorio:** `campuscloud-gen`.
**Archivos:** `18-cursia-structure.js` (nueva función, límites 3×3
condicionados a `!DYNAMIC_COURSE_STRUCTURE`), nuevos endpoints CRUD en
`orbia-backend` (`course_modules`/`course_chapters`).
**Base de datos:** lecturas/escrituras reales sobre las tablas de Fase 1
por primera vez.
**Endpoints:** `POST/PATCH/DELETE /courses/:id/modules`,
`.../modules/:id/chapters`, `PATCH .../reorder`. Todos nuevos, ninguno
reemplaza uno existente.
**Cambios frontend:** rama condicional en el flujo de "Continuar":
`DYNAMIC_COURSE_STRUCTURE` apagado (producción, siempre en esta fase) →
`orbSyncToInputs()` de siempre; encendido (solo staging) →
`saveStructureToDynamicAPI()`.
**Compatibilidad con legacy:** total — el código legacy no se toca, solo
se agrega un `if` antes de llamarlo.
**Feature flags:** `DYNAMIC_COURSE_STRUCTURE` (build-time o runtime vía
`window.location.hostname`, igual patrón que Fase 0) gatea qué función
se llama.
**Pruebas:** en staging con el flag activo, crear/eliminar/reordenar
módulos y capítulos sin límite de 3×3, verificar que persiste en las
tablas nuevas. En un build simulando producción (flag apagado), verificar
que el editor se comporta exactamente igual que hoy.
**Rollback:** apagar el flag — el código nuevo queda inerte, sin borrar
nada.
**¿Afecta producción?** No (flag apagado ahí). **¿Modifica datos?** Solo
en staging. **¿Backward compatible?** Sí.
**Riesgo:** medio — es el cambio de UI más visible; se mitiga con el
flag y con que `orbSyncToInputs()` permanece como código muerto-pero-
intacto detrás de la rama `false`.
**Criterio de aceptación:** un curso armado con 2 módulos/5 capítulos en
staging se guarda correctamente en `course_modules`/`course_chapters`;
un curso armado en un build con el flag apagado sigue limitado a 3×3
exactamente como hoy.

### Fase 4 — Blueprint versioning + lock
**Objetivo:** al confirmar estructura dinámica, congelar un snapshot
inmutable.
**Repositorio:** `orbia-backend`.
**Archivos:** nuevo endpoint de lock, uso de `course_versions` (ya
existe, solo se le agregó `locked_at` en Fase 1).
**Base de datos:** solo `course_versions` (tabla existente).
**Endpoints:** `POST /courses/:id/lock-structure` (nuevo).
**Compatibilidad con legacy:** cursos `legacy` nunca llaman este
endpoint — no aplica.
**Feature flags:** el endpoint solo es alcanzable desde el editor
dinámico (Fase 3), que ya está detrás del flag.
**Pruebas:** lockear, editar después, confirmar versión 2 sin tocar los
recursos de la versión 1.
**Rollback:** el endpoint es nuevo y aislado — deshabilitarlo no afecta
nada existente.
**¿Afecta producción?** No. **¿Modifica datos?** Solo filas nuevas en
`course_versions` para cursos `dynamic` de staging. **¿Backward
compatible?** Sí.
**Riesgo:** bajo.
**Criterio de aceptación:** dos versiones del mismo curso de staging
coexisten con snapshots distintos.

### Fase 5 — Generation Manifest + jobs dinámicos (dentro de `dynamicGenerate()`)
**Objetivo:** implementar de verdad la rama `dynamic` del dispatcher de
Fase 2 — hasta acá era un stub.
**Repositorio:** ambos (`orbia-backend` para el flujo con sesión,
`campuscloud-gen` `02-run.js` para el flujo local — mismo patrón de
dispatcher que en Fase 2, aplicado ahora del lado frontend).
**Archivos:** `content-generation.service.ts` (`dynamicGenerate()` real),
`02-run.js` (dispatcher local `legacy`/`dynamic` según
`D.structureVersion`).
**Base de datos:** lectura de `course_modules`/`course_chapters`/
`course_versions.snapshot_json`; escritura en `production_jobs` con
`blueprint_version_id` poblado.
**Endpoints:** ninguno nuevo — es lógica interna de generación.
**Compatibilidad con legacy:** el dispatcher garantiza que ningún curso
`legacy` pasa por acá.
**Feature flags:** heredado de que el curso sea `dynamic` (que a su vez
solo pudo crearse con el flag de entorno activo).
**Pruebas:** generar en staging un curso `dynamic` con estructura no
estándar (2 módulos, 5 capítulos, 2 videos, 1 examen) y confirmar
exactamente esos jobs creados, ni más ni menos. Generar en paralelo un
curso `legacy` y confirmar que sigue produciendo exactamente 9
capítulos/3 exámenes como siempre.
**Rollback:** el dispatcher permite desactivar `dynamicGenerate()`
devolviendo error controlado sin afectar `legacyGenerate()`.
**¿Afecta producción?** No. **¿Modifica datos?** Solo cursos `dynamic`
de staging. **¿Backward compatible?** Sí.
**Riesgo:** medio — primera vez que se genera contenido real por el
camino nuevo; se mitiga corriendo ambos caminos en paralelo en staging
y comparando resultados de un curso `legacy` de control.
**Criterio de aceptación:** el caso 3×3 estándar y un caso no estándar
generan ambos correctamente en staging, sin que el curso `legacy` de
control cambie su comportamiento.

### Fase 6 — Context Package dinámico
**Objetivo:** capítulos `dynamic` generan y consumen `context_summary`.
**Repositorio:** ambos (prompt de generación de capítulo, solo dentro
de `dynamicGenerate()`).
**Base de datos:** `course_chapters.context_summary` (ya existe desde
Fase 1).
**Compatibilidad con legacy:** los prompts de `legacyGenerate()` no se
tocan.
**Pruebas:** curso `dynamic` de 15+ capítulos en staging — tamaño de
prompt no crece con la posición del capítulo.
**Rollback:** cambio de prompt aislado a `dynamicGenerate()`.
**¿Afecta producción?** No. **Riesgo:** bajo.
**Criterio de aceptación:** capítulo 20 de un curso `dynamic` de 20
recibe un prompt de tamaño comparable al del capítulo 3.

### Fase 7 — Coherence Engine (capas 2 y 3)
**Objetivo:** embeddings en vivo + revisión LLM al lockear, solo en el
editor dinámico.
**Repositorio:** ambos.
**Endpoints:** de similaridad (llamado desde el editor de Fase 3) y de
revisión (llamado desde el lock de Fase 4).
**Compatibilidad con legacy:** no aplica — el editor legacy no tiene
estos botones.
**Pruebas:** casos de tu brief (duplicado de título, orden pedagógico
incorrecto) detectados en staging.
**Rollback:** endpoints nuevos, aislados.
**¿Afecta producción?** No. **Riesgo:** bajo (falsos positivos posibles,
pero son advertencias descartables, nunca bloqueos).
**Criterio de aceptación:** ambos casos de prueba producen advertencia
visible en el editor de staging.

### Fase 8 — Invalidation Engine + regeneración parcial
**Objetivo:** tabla de reglas de la sección F, operando sobre cursos
`dynamic` ya generados en staging.
**Repositorio:** `orbia-backend` principalmente.
**Pruebas:** un test unitario por fila de la tabla de la sección F,
corridos contra datos de staging.
**Rollback:** función de invalidación aislada, se puede desactivar sin
afectar generación ni el resto del pipeline.
**¿Afecta producción?** No. **Riesgo:** medio (reglas mal aplicadas
invalidan de más/de menos) — mitigado por el test unitario por regla.
**Criterio de aceptación:** agregar un capítulo NO marca `stale`
capítulos de otros módulos; eliminar uno SÍ marca `stale` el examen de
su módulo. Todo esto validado en staging, ningún curso de producción
existe en este flujo todavía.

### Punto de decisión posterior (fuera de este plan)
Terminada la Fase 8 y validado todo en staging durante el tiempo que se
considere necesario, la decisión de mergear a `main` — y con qué
combinación de flag de entorno + habilitación gradual (sección -1,
"Rollout gradual") — es una decisión explícita y separada, no un paso
automático de este documento.


## K. Qué cortaría de tu propuesta original (resumen)

- **Blueprint puramente JSON** → híbrido relacional + snapshot inmutable.
- **Dependency Graph formal** → diferido post-v1, la Capa 3 (LLM) cubre el
  caso de uso a esta escala.
- **Entidad "Resources" nueva** → extender `artifacts`, ya existe.
- **Redis** → no hace falta a este volumen.
- **"Revisar capítulos vecinos" como regla automática de invalidación** →
  reemplazado por chequeo puntual vía Capa 3, para evitar fatiga de
  alertas.
- **Blueprint versions como tabla nueva** → reusar `course_versions`.
- **Backfill completo de cursos existentes desde el día 1** (tu sección 5)
  → confirmado, se corta de este plan. Cursos existentes quedan en
  `legacy` indefinidamente; migrarlos es una fase futura independiente,
  con su propio spec (dry-run, backup, validación, rollback, reporte).
- **Arquitectura única compatible con ambos formatos** (tu opción B) →
  descartada para esta transición a favor de dispatcher legacy/dynamic
  con duplicación temporal deliberada — ver sección -1.

Todo lo demás de tu lista de ideas (UUIDs estables, position, videoEnabled/
examEnabled, Context Packages, Coherence Engine, Invalidation Engine,
Generation Manifest) se mantiene, con el modelo concreto de arriba.
