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
| 9 | ¿Qué horas ve el estudiante: declaradas, estimadas o ambas? ¿Y con qué etiqueta? | Desde r58: la bienvenida muestra las horas **objetivo** del Blueprint como «Duración estimada del curso: X h», con coma decimal. Agrega «(definida por la institución)» solo si la fuente es el documento, cosa que el lock todavía no registra, así que hoy nunca aparece. La Guía del docente muestra «Carga horaria declarada». Antes la línea de la bienvenida no salía nunca, porque el worker no pasaba `hours`. | El texto de la bienvenida es fijo. Mostrar la estimación, o las dos cifras, y registrar la fuente de las horas en el lock son decisiones de producto. Con un objetivo no alcanzado (gap > 0), la bienvenida sigue mostrando el objetivo. |

Notas:

- Las horas del documento (componentes, créditos, semanas) no se congelan en el Blueprint, solo el objetivo. Por eso el registro del paquete trae `declared = null` con `declaredReason = 'document_hours_not_frozen'`. El dry-run del curso sí las trae, desde el contexto académico vigente. Congelarlas es una decisión de diseño pendiente porque cambia el sha del Blueprint.
- Resuelto en r58 (I4): los objetivos fraccionarios se muestran con coma decimal («40,5 h»).

## Gasto, FinOps y Fase B

| # | Decisión pendiente | Qué hace hoy Cursia | Palanca disponible |
|---|---|---|---|
| F1 | Techo diario del gasto sin atribuir (I2): por dueño y global. | Mecanismo implementado (r58 I5a), sin valor: no hay techo. | `FINOPS_UNATTRIBUTED_DAILY_USD_PER_OWNER`, `FINOPS_UNATTRIBUTED_DAILY_USD_GLOBAL` |
| F2 | Autorizar el experimento de Fase B, nivel 1 (USD 5). | Diseñado en `r58-phase-b-plan.md`, no ejecutado. | La frase de autorización del plan y la lista de verificación previa de 18 pasos. |
| F3 | Workspace o clave de Anthropic separados para cada entorno y para el experimento, con límite de gasto externo. | Sin confirmar: probablemente una sola organización y una sola clave. | Configuración en Anthropic Console (la hace el usuario). |
| F4 | Precio real de Gamma y de Videogen en `pricing_catalog`. | Gamma tiene un precio provisional de USD 0,01 por crédito; Videogen está sin verificar. | La tabla de precios (con una migración aprobada) cuando se confirmen. |
| F5 | H3: tras una toma del lease, el worker nuevo vuelve a pagar una llamada. | Se registran los dos cargos; está documentado. | Mitigación propuesta (aceptar el checkpoint del worker anterior si coinciden el item, la generación, el hash del request y la cadena de leases), sin implementar. |

## Seguridad y producción

| # | Decisión pendiente | Estado | Nota |
|---|---|---|---|
| S1 | Llevar a producción las correcciones de seguridad de r58 (notify.js con login, video-engine y transcript que fallan cerrados, SSRF, `PATCH /jobs`, email de admin verificado). | Solo están en staging. **Producción sigue con notify.js abierto y video-engine sin control.** | Requiere un deploy a `main` (con autorización). Mientras tanto: retirar las claves de Videogen y Resend de producción si no se usan. |
| S2 | Decidir `VIDEO_ENGINE_ENABLED` y `VIDEO_ENGINE_ALLOWED_OWNERS` antes de promover r58 a producción. | `check-release-rollout-guard.js` lo advierte: hoy `deploy.yml` no lo decide. | Ver `docs/ops/RELEASE-CHECKLIST.md`. |
| S3 | Escaneo de secretos con push protection, rulesets en `main` y `staging`, CODEOWNERS en `.github/`, una clave SSH por entorno, `permissions:` en los workflows de deploy. | No configurado. El repo del backend es público; no se hallaron secretos reales en el historial. | Configuración de GitHub y del VPS (la hace el usuario). |
| S4 | Backups y PITR de Supabase; copia fuera de línea de los `.mbz` entregados. | Sin confirmar. Storage no está incluido en los backups de la base. | Plan de Supabase y procedimiento operativo. |
| S5 | ¿Registros abiertos en staging? | Sin confirmar. | Configuración de Supabase Auth. |

## Calidad académica

| # | Decisión pendiente | Estado |
|---|---|---|
| Q1 | Flujo para aceptar hallazgos MAJOR. Hoy se registran sin bloquear la entrega; solo BLOCKER la bloquea. | Falta definir quién acepta, con qué motivo y dónde se guarda. |
| Q2 | H2: un curso teórico de 16 h con «menos video» termina con 0 videos. ¿Se acepta? | Decisión académica. |
| Q3 | Calibrar el umbral de palabras por minuto de la AA (4 palabras/min) y la detección de ventanas numéricas. | Sin calibrar. Solo generan hallazgos MINOR o de revisión humana. |
| Q4 | La revisión experta (clínica, legal, disciplinar) es obligatoria antes de entregar. Ninguna regla verifica la veracidad. | Política operativa. |
| Q5 | Congelar la versión del perfil de evaluación al iniciar el run y que el empaque la use (r2 m7). | Hoy el claim de la AA usa la versión vigente al crear el run y el empaque usa la actual; una diferencia se reporta como MAJOR. |

## Operación

| # | Decisión pendiente | Estado |
|---|---|---|
| O1 | Entorno de los pilotos: staging en modo fábrica (recomendado), producción con V2 o un entorno dedicado. | Pendiente (r57 R2). |
| O2 | Cuota de YouTube: la cuota por defecto no alcanza ni para un curso con 9 videos o más por día. | Pendiente (Google Cloud). |
| O3 | Re-empaquetar #1353 con el builder actual. Cuesta USD 0, pero requiere Storage de al menos 106 MB. | Pendiente. #1353 sigue marcado `stale` (empaquetado con el builder 3.13.0). |
| O4 | Proxy legítimo de Anthropic en producción. Hoy, si hay un override de la URL, toda salida se marca `mock` y no se puede empaquetar como final. | Documentado. Haría falta un flag explícito de «proxy real» si llega a usarse. |
