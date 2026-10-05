# Motor pedagógico Fase 2: el diseño llega a cada generador

**Estado:** implementado (backend + frontend). Solo pruebas con proveedores falsos: sin generación real, sin gasto y sin cambios en producción.

## Objetivo

Cerrar la cadena que en V1 terminaba en el Manifest:

```
Perfil pedagógico → reglas → Blueprint → Manifest → design de cada trabajo
  → brief del generador (generator-directives.ts) → prompt / configuración → proveedor
```

Cada generador recibe solo la parte del diseño que le corresponde a SU trabajo. No es una línea global del tipo «este curso usa constructivismo».

## Pieza central: `src/modules/pedagogy/generator-directives.ts`

`buildItemPedagogyBrief({ item, snapshot, activityTypeRules })` es una función pura. Toma un item del Manifest v3 que trae `design` y devuelve:

- `generator`: generador que produce el item. Puede ser `course_plan`, `course_intro`, `module_intro`, `content`, `experience`, `presentation`, `video`, `video_interactions`, `activity`, `branching_scenario`, `scorm_activity`, `exam` o `final_exam`.
- `directives[]`: lista de `{ target, value, label, instruction }`. Los textos salen de los **valores del vocabulario**, nunca del nombre de un enfoque, así que cualquier enfoque registrado funciona sin tocar el archivo (hay una prueba con «aula invertida»).
- `overridden[]`: traza de cada regla pedagógica que pierde frente a una superior. Cada entrada lleva `by: technical | product | course`, `scope: full | partial`, la regla y el efecto.
- `text` y `textSha256`: el texto que recibe el generador.
  - En los prompts del navegador es un bloque con el marcador «── DISEÑO PEDAGÓGICO DE ESTE RECURSO ──».
  - En Gamma es una línea compacta, «Enfoque didáctico: …». En Videogen viaja dentro del texto del capítulo, así que se marca «[Indicación para el guion, no narrar] …».

`PEDAGOGY_GENERATOR_COVERAGE` registra cada tipo de item del Manifest v3, dice si consume el diseño y, si no, por qué. Una prueba exige que el registro cubra exactamente los tipos que emite el Manifest.

### Qué recibe cada generador

| Trabajo | Generador | Parte del diseño | Dónde entra |
|---|---|---|---|
| course_plan | LLM (navegador) | enfoque, estilo de objetivos, profundidad | antes del JSON pedido |
| course_intro | LLM (navegador) | cómo se aprende en el curso (resumen del enfoque), nivel de interacción | antes del JSON pedido |
| module_intro | LLM (navegador) | apertura y cierre del módulo | antes del JSON pedido |
| content | LLM (navegador) | secuencia mapeada a las 5 secciones, tipo de contenido, objetivos y verbos, profundidad, caso, forma de las actividades de apoyo | antes del cierre obligatorio (sidecar) |
| experience | LLM (navegador) | componentes preferidos según el tipo de contenido, caso, retroalimentación | después del texto del capítulo y antes del schema |
| video_interactions | LLM (navegador) | tipo de interacción, retroalimentación | antes del JSON pedido |
| activity (H5P) | LLM (navegador) | intención, situación, retroalimentación | después del texto del capítulo y antes del cuerpo del ejercicio |
| activity (escenario ramificado) | LLM (navegador) | intención explícita (TOMA DE DECISIONES / SIMULACIÓN…), escenario, retroalimentación | ídem |
| activity (SCORM) | LLM (navegador) | intención y situación de las salas | antes de la plantilla |
| exam / final_exam | LLM (navegador), banco o GIFT | estrategia, estilo (integrador en el final), retroalimentación en las explicaciones | banco: en la parte «task», sin romper el caché del «source»; GIFT: antes de la sintaxis |
| presentation | Gamma (worker) | tipo de contenido y orden de las diapositivas | al final de `additionalInstructions` |
| video | Videogen (worker) | estilo del video | cabecera de `content_txt` |
| audio_welcome / audiobook_chapter | TTS / guion LLM (worker) | **no consumen** | narran contenido ya diseñado; el audiolibro se valida contra el texto del capítulo |
| Tarjetas de repaso (Dialog Cards) | sin generador propio | indirecto | se derivan de la experiencia en el empaque |

## Transporte

- **Backend.** `DynamicSchedulerService.buildClaimedItem` arma el brief con el Manifest ya validado contra el Blueprint en la misma transacción. Lo entrega como `ClaimedItem.pedagogy`, solo si el item trae `design`.
  - El texto se escribe una sola vez, en el backend. El navegador y los workers lo usan tal cual.
  - Un brief que no se puede armar hace fallar el claim con un error claro, nunca un prompt sin diseño.
- **Navegador.**
  - `44`: `dynPedagogyBlock(item)` devuelve '' si no hay brief. Si el brief existe pero está roto (sin marcador, de otro generador o demasiado largo) lanza `PEDAGOGY_BRIEF_INVALID`.
  - Cada builder recibe `ped` como parámetro opcional y lo inserta antes del formato de salida, así las reglas del schema siguen siendo lo último.
  - `45`: los 11 generadores del navegador pasan el bloque y registran `pedagogySha256` en el summary del item.
  - Los reintentos y correcciones parten del prompt base, así que llevan el mismo bloque.
  - Dos llamadas no llevan bloque, a propósito: el reintento que solo pide el sidecar `context_summary` del contenido y la pasada que iguala la longitud de las opciones GIFT. Son reparaciones de formato sobre un texto ya generado con el diseño. El E2E E6 lo encontró y quedó documentado.
- **Orden de despliegue y pestañas viejas.** El navegador nuevo declara `?features=pedagogy-brief-1` en el claim; va por query porque el body es whitelist estricta y CORS no admite headers propios, y un backend anterior lo ignora.
  - En un run con diseño, un ejecutor que no lo declara (una pestaña abierta con una versión anterior) recibe un 409 `rules_version_mismatch`, que esa versión ya muestra como pausa visible con «recarga la página». No reclama nada, así que no genera ni paga recursos sin el enfoque.
  - Runs sin pedagogía: sin cambios.
  - Un brief roto en el navegador falla solo ese item, sin reintentos. Un brief imposible de armar en el claim marca el item fallido (`PEDAGOGY_DIRECTIVE_UNKNOWN`) en vez de trabar el run.

## Prioridad de reglas

Si una regla pedagógica choca con otra, gana la de mayor prioridad: 1 técnica/seguridad, 2 producto, 3 curso, 4 diseño pedagógico, 5 preferencias.

El bloque dice que se aplica DENTRO de las reglas anteriores. Las trazas actuales:

- **Contenido:** una secuencia de más de 5 pasos se agrupa en las 5 secciones numeradas (producto). «Fuentes para investigar» y «Lecturas de ampliación» nunca se piden, porque chocan con la regla de veracidad (técnica).
- **Exámenes:** tipos, cantidades, niveles y evidencia los fija el banco; el diseño orienta enunciados y explicaciones (producto).
- **Video interactivo:** cuántas preguntas y en qué momento lo fija el plan de puntos de control (producto). El momento de la retroalimentación lo fija H5P (técnica).
- **Actividades:**
  - Rige el tope de escenarios ramificados, uno cada cuatro actividades (producto).
  - Rige también la variedad: ningún tipo domina el curso (producto).
  - Un tipo no disponible en H5P v1 se descarta (producto).
  - El objetivo del capítulo puede elegir otro tipo dentro del top-2 (curso).
- **SCORM:** la plantilla fija la mecánica (producto).
- **Presentación:** portada fija y número de diapositivas fijo (producto). Si la línea no cabe en el tope de `additionalInstructions` (2000 caracteres), se omite entera (técnica).
- **Curso:** un capítulo sin video o sin actividad anula esa parte del diseño. Aparece en `courseOverrides` del dry-run.

## Huellas de invalidación (pendiente N2 de V1)

La huella del contenido (`content-own`) sigue siendo la de V1, con el diseño congelado e independiente de la posición. Cada trabajo de capítulo suma, solo a SU huella, la parte del diseño EFECTIVO que lee su brief, y solo cuando el rol del capítulo en el módulo la cambia (`BRIEF_ROLE_SENSITIVE_FIELDS`, `roleDesignDelta`).

El plan de invalidación v3 regenera ese trabajo con el motivo `pedagogy_role_design_changed`. Si es de un proveedor pago, lo marca `STALE_NO_AUTO`.

Hoy la única variación por rol es la intención de la actividad en el cierre del módulo. Por eso, al reordenar un módulo con perfil «competencias», solo se regeneran las 2 actividades afectadas: ni contenido, ni Gamma, ni Videogen, ni audiolibro. Sin variación por rol, las huellas son idénticas a las de V1. En los cursos de staging que ya tienen un perfil con variación por rol (competencias, experiencial), la huella de las actividades de cierre cambia una sola vez al desplegar. No provoca regeneración en el plan; solo impide reusar una actividad deshabilitada guardada antes. `check-pedagogy-generators.js` verifica que `BRIEF_ROLE_SENSITIVE_FIELDS` cubra todo lo que el rol puede cambiar en un brief.

## Dry-run

`runPedagogyDryRun` ahora devuelve también:

- `generators[]`: por trabajo, qué generador lo produce, si consume el diseño o por qué no, dónde entra y el brief completo;
- `courseOverrides[]`.

El panel «Enfoque pedagógico» muestra «Qué recibe cada generador» para el curso, el módulo 1 y el capítulo 1, con las reglas que mandan.

Los prompts FINALES del navegador se arman sin LLM en `src/js/__harness__/test-50-pedagogy-prompts.mjs`, con los builders reales y los items exportados del backend (`scripts/pedagogy-export-fe-fixtures.js`). `PEDAGOGY_PROMPTS_REPORT=archivo.md` escribe la comparación.

## Costo

Activar el perfil no agrega trabajos, llamadas ni unidades de proveedor:

- el Manifest tiene los mismos items;
- la estimación de FinOps es idéntica;
- Gamma recibe el mismo `numCards`.

El único costo marginal son los tokens de entrada del bloque. Mide hasta unos 1300 caracteres, unos 330 tokens, en cada llamada LLM del navegador. En el banco de preguntas el bloque suma tamaño frente al tope de 64 KB del proxy: un capítulo que antes entraba justo puede fallar visible con `EXAM_BANK_PROMPT_TOO_LARGE`; no se probó en el borde.

## Pruebas

- `scripts/check-pedagogy-generators.js`: G1 a G18, cobertura y enfoque nuevo.
- `scripts/check-pedagogy-engine.js`: I2 actualizado a N2.
- `src/js/__harness__/test-50-pedagogy-prompts.mjs`: prompts finales RCP × 5, cobertura del ejecutor y sin perfil = sin bloque.
- E2E v3 E6:
  - el ejecutor REAL contra el LLM falso; cada prompt de cada item, reintentos incluidos, trae el brief de SU item;
  - Videogen y Gamma falsos reciben su línea;
  - el summary registra `pedagogySha256`.

## Qué queda para la fase siguiente

- **Validación con un curso real.** Se hará con un curso real autorizado por el usuario, comparando calidad con y sin enfoque.
- **Principios libres del perfil.** No entran a los prompts porque no forman parte del diseño de cada item.
- **Botón «Aplicar cambios sugeridos»** y pesos sugeridos aplicados al perfil de evaluación.
- **Modelo pedagógico institucional** desde PDF o Word.
- **Migración de producción** de `course_profiles.kind = 'pedagogy'`.
