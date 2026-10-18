# r58: decisiones pendientes (requieren una persona)

Este documento lista decisiones de producto o de política académica que el código **no** toma por su cuenta. Para cada una se indica qué hace hoy Cursia (el default, que no cambia sin una decisión) y qué palanca existe para aplicar la respuesta cuando se tome. No se asume ninguna respuesta.

## Horas académicas

Origen: AU2 (r58) §F6. Implementación relacionada: registro de horas (`src/modules/study-time/hours-ledger.ts`), configuración del modelo de tiempo (`src/modules/study-time/time-model-config.ts`, clave opcional `hoursModel` del perfil pedagógico, congelada en el Blueprint) y el harness `scripts/check-hours-model.js`.

Vocabulario del registro:

- **declarado:** lo que dice el documento académico (total, componentes, créditos, semanas);
- **objetivo:** las horas objetivo del curso (perfil o documento);
- **estimado:** líneas `measured` y `estimated_with_evidence`;
- **asignado:** líneas `declared`, es decir, niveles de la Actividad de Aplicación y de la práctica guiada, y la constante del foro;
- **observado:** siempre `null`, porque no hay fuente de datos;
- **gap:** objetivo − (estimado + asignado). Se informa y nunca se rellena.

| # | Decisión pendiente | Qué hace hoy Cursia (default) | Palanca disponible |
|---|---|---|---|
| 1 | ¿El estudio autónomo cuenta para el total declarado? ¿Cómo se mapean los componentes del documento (presencial / práctico / autónomo / otro) a las categorías de Cursia? | Sin mapeo: el informe lista cada componente con `mappedCategories: null` y el hallazgo `HOURS_COMPONENT_MAPPING_UNDEFINED` (INFO). Todas las líneas suman al total. | `hoursModel.componentMap` (componente → categorías, sin solapes). Con él, el informe compara por componente (`HOURS_COMPONENT_MISMATCH`, MINOR). |
| 2 | Conversión crédito → horas (por país o institución). | Sin conversión: `credits.conversion = 'no_definida'` y `HOURS_CREDITS_CONVERSION_UNDEFINED` (INFO). Nunca se supone un valor (por ejemplo, 48 h por crédito). | `hoursModel.hoursPerCredit`. |
| 3 | ¿Los minutos de un nivel declarado (AA 30/60/90/120, práctica guiada 40/60/80/120) se acreditan tal cual, escalados por un proxy de esfuerzo medido, o con tope? ¿Qué proporción máxima declarada vs. medida admite un curso? | Tal cual: acredita el número del nivel. Se muestra `declaredShare` (por ejemplo, 70 % en 4×4 9+7) sin umbral ni hallazgo. | `hoursModel.applicationTierMinutes` / `guidedPracticeTierMinutes` (minutos acreditados por nivel; el conjunto de niveles no cambia). El umbral de proporción no está implementado: falta la decisión. |
| 4 | ¿Cuenta el tiempo de retroalimentación (leer correcciones, «Respuestas explicadas») y los reintentos de examen? | No se modela: la categoría `retroalimentacion` existe en el registro con 0 min. | Ninguna todavía. Requiere definir la regla y la evidencia, por ejemplo palabras de las explicaciones. |
| 5 | ¿El audiolibro sigue siendo alternativa al Libro Guía (0 h) o cuenta para quien estudia escuchando? | Alternativa: 0 h. El audiolibro no genera línea. | Ninguna todavía: cambiarlo es una regla nueva del modelo, no una tasa. |
| 6 | Calibración de las tasas: 150 palabras/min, 0,6 min por diapositiva, 1 min por interacción del video, 1,2 min por ítem o pregunta, 0,5 min por tarjeta, 10 min de foro. Variantes por audiencia (nivel, texto técnico). | Tasas del default `cursia.default.v1`, calibradas con cursos de staging #542, #583 y #616 (Fase 0). Las líneas planificadas citan esa calibración. | `hoursModel.rates.*` por institución o perfil. Cada línea anota el `configId` de la regla que se cambió. Una calibración con datos observados queda pendiente (observado = null). |
| 7 | Formas con mucha práctica (r57 T3): ¿se acepta el faltante, se permite práctica guiada en capítulos de práctica, o se mide la capacidad real de práctica? | Se acepta y se informa: 4×4 9+7 llega a 52,5 de 64 h; 4×5 9+11 a 55,8 de 76; 3×3 5+4 a 29,9 de 32; 4×6 10+14 a 60,7 de 96. El gap explícito va como `HOURS_TARGET_GAP` (MAJOR). Las propuestas comerciales de 64, 76 o 96 h con esas formas no son reproducibles hoy. | Ninguna sin decisión: permitir práctica guiada en capítulos de práctica cambia el distribuidor y el validador del Blueprint. |
| 8 | Umbral de aceptación de práctica guiada (30 %) y tope de la proporción de AA (50 % / 40 %): ¿política de la institución o default del producto? | Defaults del producto: `design-verification.ts` y `DISTRIBUTOR_RULES.applicationFirst`. | No son configurables por institución (no se movieron a `hoursModel`): falta la decisión. |
| 9 | ¿Qué horas ve el estudiante: declaradas, estimadas o ambas? | Desde r58 (fix): la bienvenida muestra las horas **objetivo** del Blueprint como «Duración estimada: X h (definida por la institución)» y la Guía del docente muestra «Carga horaria declarada». El tiempo estimado se ve por capítulo (~N min) y, para docentes, en la Guía. Antes la línea de la bienvenida no salía nunca porque el worker no pasaba `hours`. | El texto de la bienvenida es fijo. Mostrar también la estimación, o solo ella, es una decisión de producto. Con un objetivo no alcanzado (gap > 0), la bienvenida sigue mostrando el objetivo etiquetado como definido por la institución. |

Notas:

- Las horas del documento (componentes, créditos, semanas) no se congelan en el Blueprint, solo el objetivo. Por eso el registro del paquete trae `declared = null` con `declaredReason = 'document_hours_not_frozen'`. El dry-run del curso sí las trae, desde el contexto académico vigente. Congelarlas es una decisión de diseño pendiente porque cambia el sha del Blueprint.
- Con objetivos fraccionarios, la bienvenida escribe la cifra tal cual llega (por ejemplo, «40.5 h»). Si se decide mostrarla con coma decimal, también hay que ajustar el validador de cifras del paquete (`NUMBER_NOT_FROM_FACTS`).
