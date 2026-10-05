# Motor de carga horaria · Loop 3: distribuidor de horas

**Estado:** implementado (backend, dry-run y panel). Función pura: no genera, no escribe y no llama a proveedores.

## Qué hace

`distributeCourseHours({ snapshot, rules, targetHours, activityTypeRules, tolerance })` (`src/modules/study-time/distributor.ts`) recibe:

- el Blueprint actual;
- las reglas del motor pedagógico, sin un motor nuevo;
- las horas objetivo.

Devuelve un **diseño propuesto**:

- módulos;
- capítulos de contenido y de práctica, con su rol (por posición, `chapterRole`);
- video, actividad y repaso;
- nivel de la Actividad de aplicación;
- tiempo objetivo de cada capítulo.

Los minutos los pone **siempre** el modelo de tiempo (Loop 1).

## Política (de las dimensiones del motor pedagógico)

| | Aplicación primero (competencias, problemas, experiencial; sin enfoque) | Profundidad primero (significativo) |
|---|---|---|
| Peso decisivo | promedio(práctica, evidencia, autenticidad) ≥ promedio(profundidad conceptual, conocimientos previos) | lo contrario |
| Tope de la Actividad de aplicación: contenido / cierre o práctica | 90 / 120 min | 60 / 90 min |
| Proporción máxima de aplicación | 50 % | 40 % |
| Capítulos de práctica por módulo | 2 | 1 |
| Orden de crecimiento | aplicación → práctica → profundización | aplicación → profundización → práctica |

**Límites:**

- 240 min por capítulo;
- 5 capítulos de contenido por módulo;
- tolerancia de ±5 % o ±1 h, lo que sea mayor, configurable (`tolerance.pct`, `tolerance.minHours`);
- ajuste fino bajando niveles de 30 minutos.

## Reglas que respeta

- **No rellena.** Si la estructura mínima supera el objetivo, devuelve `minimum_exceeds_target` y dice «La estructura mínima actual supera la carga horaria objetivo». Propone cuántos capítulos quitar, pero no recorta nada.
- **No inventa horas.** Si con los topes no alcanza, devuelve `cannot_reach_target` y propone módulos o capítulos nuevos. No infla textos ni tiempos, y no agrega módulos por su cuenta: sus temas los decide el docente.
- **Prioridad.** Técnica > producto > curso (`targetHours`) > pedagogía > preferencias. El objetivo obliga a cambiar la estructura, pero los capítulos nuevos son **propuestas** (`proposed:…`): el lock nunca las aplica (`priorityTrace`).

## Actividades de aplicación: Fase 2 (decisión de alcance)

La Fase 1 no genera Actividades de aplicación. Sin ellas, 33 o 50 h solo se alcanzarían con decenas de capítulos de contenido, lo contrario de «más práctica, no más texto». Por eso el distribuidor **reserva** el nivel de la actividad en el diseño (`applicationMinutes`) e informa por separado:

- `estimatedHours`: las horas del diseño completo;
- `generableHours`: las horas que se pueden generar hoy, sin esas actividades.

El panel lo dice explícitamente. Nada se persiste ni se genera.

## RCP (con «Repaso», competencias)

| | 8 h | 20 h | 33 h | 50 h | 80 h | 50 h significativo |
|---|---|---|---|---|---|---|
| Estado | mínimo supera | dentro | dentro | dentro | no alcanza | no alcanza |
| Horas del diseño | 13,6 | 19,1 | 31,7 | 48,5 | 52,3 | 41,8 |
| Generables hoy | 13,6 | 13,6 | 14,2 | 21,0 | 23,8 | 22,8 |
| Capítulos (práctica) | 9 (0) | 9 (0) | 11 (2) | 19 (6) | 21 (6) | 18 (3) |
| Con video | 9 | 9 | 9 | 13 | 15 | 15 |

Los resultados coinciden con la Fase 0: 19,1 / 31,8 / 48,6 h y 9 / 11 / 19 capítulos.

## Dónde se ve

- **Dry-run:** `distribution`, solo con objetivo; sin objetivo es `null` y la salida es la de siempre.
- **Panel «Enfoque pedagógico»:**
  - campo «Horas de estudio objetivo» con atajos 20/33/50 y «Sin objetivo»; se puede guardar sin enfoque;
  - en la vista previa, la sección «Carga horaria»: objetivo frente a diseño, horas generables hoy, recomendaciones y tabla de capítulos con los propuestos marcados.

## Pruebas

- `scripts/check-distributor.js` (D1–D13):
  - 20, 33 y 50 h;
  - 8 h;
  - 80 h;
  - sin perfil o con perfil vacío;
  - cada enfoque;
  - tolerancia;
  - determinismo;
  - horas generables;
  - prioridad;
  - límites;
  - reorden y cambio de objetivo;
  - dry-run;
  - casos adversos.
- `test-49-pedagogy-panel.mjs`: campo de horas y propuesta en la vista previa.
