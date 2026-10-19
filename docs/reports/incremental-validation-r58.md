# r58: Fase A, validación incremental sin costo (informe ejecutivo)

**Fecha:** 2026-10-18.

**Rama:** `feat/incremental-validation-r58`, creada desde staging (BE `bfe802a`, FE `56e1dc9`).

**Restricciones cumplidas:**
- USD 0 de proveedores;
- ninguna generación real;
- producción, #1353, el ledger histórico y el Spend Cap intactos;
- sin migraciones en bases compartidas;
- sin código específico de ningún cliente.

**Escala de evidencia** (cada nivel es distinto del siguiente):
1. implementado;
2. probado sintéticamente;
3. probado con IA real;
4. validado comercialmente.

**Todo lo de este loop llega como mucho al nivel 2** (fixtures, reglas y Moodle local).

## 1. Qué existía antes
Base r57, verificada en el repo con el gate r57g3 (PASS 7038/0):
- generación por partes, con el mismo ejecutor en el navegador y en el servidor;
- dry-run pedagógico, `estimate-preview` y dry-run de regeneración;
- checkpoints del worker LLM, guardados por hash del request;
- validadores por ítem, por banco y por paquete (`validateMbzV3`);
- batería de calidad Q1–Q9, invocable solo bajo demanda;
- ledger FinOps con reserva, liquidación, ajuste y tope atómico;
- modo fábrica;
- suite de simulación comercial con 10 cursos.

Auditorías de este loop: `AU1` (pipeline), `AU2` (calidad y horas), `AU3` (FinOps y seguridad).

## 2. Qué se implementó (código genérico, sin cambios de esquema)
- **Driver offline** (`scripts/lib/offline-driver.js`):
  - ejecuta solo los componentes seleccionados (capítulo, H5P, banco, guion, AA, paquete) y sus dependencias;
  - usa el constructor de claims del producto, extraído como función pura y probado igual a `buildClaimedItem`;
  - usa el ejecutor vendorizado y los validadores reales;
  - preserva por hash los componentes aprobados y produce los mismos bytes en cada corrida;
  - marca el paquete como **[SINTÉTICO]**, con `cursia-synthetic.json` y `deliverable:false`.
- **Record/replay** (`replay-api.js`, fixtures v1 con procedencia y marca de sintético, sanitizador, conversor de checkpoints):
  - una respuesta ausente lanza `REPLAY_FIXTURE_MISSING` y nunca recurre a una llamada real;
  - grabar desde un proveedor real está bloqueado.
- **Barrera de red estricta** (`netguard`): bloquea fetch, http(s), tls, http2, sockets, DNS y dgram.
- **Informe estructurado del dry-run** (JSON y Markdown):
  - configuración;
  - decisiones pedagógicas;
  - recursos previstos;
  - validaciones;
  - advertencias y errores;
  - componentes no verificados;
  - dependencias externas.
- **Informe de calidad** (`CourseQualityReport`, canónico):
  - un formato común de hallazgo: código, severidad BLOCKER/MAJOR/MINOR/INFO, ubicación, evidencia, regla, causa, recomendación, si bloquea, y si es determinista o requiere revisión humana;
  - adaptadores para los validadores existentes;
  - Q7 sin datos queda como `not_measured` (neutro);
  - checks deterministas nuevos: afirmaciones de cantidad, ventanas numéricas contradictorias entre capítulos (MAJOR, a revisión humana, nunca autocorregido), referencias hacia atrás, cierre prematuro, evaluación de memoria para una competencia práctica, extensión de la AA, referencias a archivos;
  - visible para administradores en «Curso listo».
- **Modelo de horas** (`hours-ledger.ts`, `time-model-config.ts`):
  - cada actividad tiene una línea con su categoría, su base (`measured` / `estimated_with_evidence` / `declared`), su evidencia, su regla y su `configId`;
  - informe de objetivo, estimado, asignado y observado (siempre null), con el **gap explícito y nunca rellenado**;
  - tasas configurables (`hoursModel`), idénticas por defecto;
  - corregidos dos bugs: los totales declarados aparecían como medidos, y la bienvenida nunca mostraba la duración (builder 3.15.1).
- **Integridad de artifacts:**
  - `POST /artifacts` rechaza los tipos que solo crea el servidor;
  - la reutilización de un paquete exige la ruta canónica, el checksum del servidor y la validación registrada;
  - **los bytes entregados nunca se sobrescriben** (una reconstrucción va a una ruta nueva);
  - una salida de IA simulada o reproducida (`llmMode`) nunca termina en un paquete final;
  - producción no arranca con overrides de URL de proveedores.
- **Control de gasto:**
  - interruptor global e allowlist de proveedores en el punto de reserva y antes de las llamadas directas;
  - el proxy rechaza ids de parte inexistentes;
  - mecanismo de techo para el gasto sin atribuir (valor pendiente);
  - interruptores para los endpoints legacy y para video-engine;
  - tope mensual por dueño;
  - **H4: un run sin autorización de presupuesto queda bloqueado** (falla cerrado).
- **Seguridad:**
  - notify.js exige login, solo envía al propio usuario y escapa el HTML;
  - video-engine y transcript fallan cerrados;
  - SSRF cerrado en `upload-from-url`;
  - admin solo con email verificado;
  - `PATCH /jobs` no puede tocar los runs V2;
  - el `worker_off` sobrevive los deploys y apaga los dos workers.
- **P1 de r57:**
  - sesgo de longitud en las preguntas del video también verificado en el servidor;
  - archivos de práctica validados al adjuntarlos;
  - la AA referencia sus archivos;
  - coma decimal en las horas.
- **Simulación:**
  - 7 cursos sintéticos nuevos (teórico, práctico, protocolo, casos, mixto, 1×1 sin exámenes, 1×1 sin notas);
  - se verifican las relaciones entre objetivos, actividades, evaluaciones, horas, archivos, notas y calidad;
  - prueba del lease que vence a mitad de una llamada.

## 3. Qué se reutilizó
- generación por ítem y ejecutor;
- fakes de e2e;
- receta de hash de los checkpoints;
- dry-runs existentes;
- validadores;
- motor de la simulación comercial;
- ledger, `CostReadService` y tope atómico;
- modo fábrica;
- netguard del gate.

No se creó un segundo motor.

## 4. Qué no fue necesario desarrollar
- **Libro Guía como componente aparte:** el empaquetador lo construye desde el contenido.
- **Conciliación con proveedores:** queda para Fase B.
- **Paralelismo:** fuera de alcance.
- **Generación parcial sobre cursos reales:** BLOQUEADA, porque consume las claves de generación del Manifest.

## 5. Pruebas
- **Gate completo:** ver §11 (r58g2).
- **Suites nuevas:**

| Suite | Resultado |
|---|---|
| `check-offline-driver` | 10/0 |
| `check-replay` | 7/0 |
| `check-netguard` | 4/0 |
| `check-hours-model` | 9/0 |
| `check-r58-pipeline-hardening` | 16/0 |
| `check-r58-finops-security` | 17/0 |
| `check-quality-report` | 10/0 |
| `check-r58-one-by-one` | 7/0 |
| `check-r58-lease-midcall` | 6/0 |
| `check-r58-review-r1` | 16/0 |
| `check-finops-atomic-cap` (incluye H4) | 20/0 |
| `check-release-rollout-guard` | no fatal; 2 advertencias esperadas sobre el `deploy.yml` de producción |
| Simulación comercial | 25/0 |

- **Moodle:**
  - 4.5 local: 18/18;
  - 4.1–4.4: 28/28 con los cursos nuevos;
  - los 10 de r57 ya estaban validados en las 5 versiones.

## 6. Problemas encontrados y corregidos
- **De las auditorías:**
  - 🔴 rutas pagas sin control: video-engine, legacy `/jobs`, proxy sin atribuir;
  - 🔴 notify.js abierto (relay de email);
  - 🟠 SSRF;
  - 🟠 un dueño podía reescribir su run;
  - 🟠 admin sin email verificado;
  - R1: `dynamic_mbz` falsificable;
  - R2: un run falso podía empaquetarse como final;
  - R3: overrides de URL en producción;
  - bugs de horas;
  - Q7 pasaba sin medir.
- **De la simulación:** H4 (run sin autorización = sin tope).
- **De la revisión r1:**
  - I-1: sobrescritura de bytes entregados;
  - I-2: video-engine cerrado para todos;
  - I-3: el preflight de YouTube siempre fallaba;
  - 7 menores.

## 7. Qué sigue pendiente
- **Menores de la revisión r2 (m1–m7):**
  - escaneo de reutilización;
  - carrera de referencias;
  - enumeración de ids de video-engine;
  - proxy legítimo marcado como `mock`;
  - un run BLOCKED puede reanudarse (las reservas igual se rechazan);
  - etiqueta de horas;
  - congelar la versión del perfil.
- **H3:** pago doble tras una toma del lease, documentado.
- **Decisiones humanas:** `r58-decisions-pending.md`.
- **Correcciones de seguridad en producción** (S1).

## 8. Qué se necesita para Fase B
Ver `r58-phase-b-plan.md`.
- **Experimento:** nivel 1 = un capítulo de texto en un curso 1×1 sin exámenes, con los medios simulados.
- **Supuesto verificado:** el producto lo acepta (`check-r58-one-by-one`).
- **Costo estimado:** p50 ≈ USD 0,72–0,85; peor caso acotado ≈ 2,3–2,6.
- **Tope:** USD 5 con defensa en profundidad:
  - workspace propio de Anthropic con límite de USD 6;
  - claves de los demás proveedores retiradas;
  - allowlist, kill switch, techo sin atribuir, autorización del run y tope mensual por dueño;
  - deploys congelados y empaque retenido.
- **Requiere tu autorización explícita.**

## 9. Matriz de validación
Ver `r58-validation-matrix.md`.

## 10. Revisión independiente
- **r1 (rama completa):** REQUEST_CHANGES (0 críticos, 3 importantes, 7 menores), todo corregido.
- **r2 (correcciones):** APPROVE (0 críticos, 0 importantes, 7 menores pendientes).
- **Confirmado por la revisión:**
  - ningún camino automático reconstruye #1353 ni cursos existentes;
  - ningún cliente legítimo sube los tipos bloqueados;
  - H4 no afecta los flujos mock y e2e;
  - el guard de URL solo actúa en producción;
  - un fixture ausente falla explícitamente.

## 11. Gate, PR y deploy
- **Gate completo r58g4 (código final):** PASS, con **7231 aserciones y 0 fallidas**. Cubre E2E (F9 464/0, V2.1 1957/0), navegador, reproductor H5P, regresión del backend (147 scripts, rc=0) y regresión del frontend (88 de 89 harnesses en rc=0, 1166/0).
  - El único rc=1 era el harness `test-r58-functions-security`, que había quedado desactualizado por el cambio I-2. Se corrigió en el FE `73251e8`, solo en el test, y pasa 9/0; la suite completa de harnesses del FE se volvió a correr.
- **Gates anteriores** (no son fallos de código):
  - r58g1: interrumpido por correcciones posteriores;
  - r58g2: el Mac entró en Low Power Sleep;
  - r58g3: 7149/2. Los dos fallos eran la regresión E24e del cambio M-1, corregida en `4271bbb`.
- **PR, merge y deploy:** ver el resumen final de la sesión.
