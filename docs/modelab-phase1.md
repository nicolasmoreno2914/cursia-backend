# MODELAB: evaluación de modelos para Cursia V2 (Fase 0 y plan de Fase 1)

r61 · Agente F · 2026-10-20. Fase 0 sin costo (USD 0): no se hizo ninguna llamada facturable.

Código en `scripts/modelab/`. Autoverificación con `node scripts/modelab/check-modelab.js`.

## 1. Pregunta

¿Sonnet 5.5 y Haiku 5.5 mejoran costo **y** calidad frente a Sonnet 4.6 en V2?

Respuesta de la Fase 0:

- **Costo:**
  - Sonnet 5.5 ahorra poco: un 8–24 % del costo LLM, según el tokenizer real. Además, el ahorro desaparece si el pensamiento queda encendido.
  - Haiku 5.5 ahorra alrededor del 95 % en cada componente donde se use.
- **Calidad:** no se puede saber sin la Fase 1. Esta fase sí deja medido el baseline determinista y el arnés listo.

## 2. Hechos de la API

**[C]** = confirmado en la documentación oficial (consultada el 2026-10-19/20). **[I]** = inferencia.

| Tema | Sonnet 4.6 | Sonnet 5.5 | Haiku 5.5 | Fuente |
|---|---|---|---|---|
| Pensamiento sin campo `thinking` | apagado | **adaptativo encendido** | **adaptativo encendido** | [C] MIG55 (tabla «Thinking runs by default»), MIGH55 |
| Apagarlo | `disabled` | `{"type":"between_tools"}`; `disabled` → 400; solo con effort low/medium/high | `disabled`, solo con effort ≤ high | [C] MIG55, EFFORT |
| `budget_tokens` | deprecado, funciona | 400 | 400 | [C] MIG55, MIGH55 |
| Effort por defecto | high (sin xhigh) | high (niveles recalibrados) | **medium** | [C] MODELS, EFFORT |
| temperature / top_p / top_k | se aceptan | un valor no-default → 400 | temperature solo 1; top_p solo 0,99; top_k → 400 | [C] MIG55, MIGH55 |
| Salida máxima | 128K | 128K | 128K | [C] MODELS |
| Tokenizer | anterior | nuevo: «about 30% more tokens» que 4.6 | nuevo: ~30 % más | [C] PRICE, MIG55, MIGH55 |
| `max_tokens` | — | cubre pensamiento + texto; el pensamiento se cobra como salida | ídem | [C] MIG55, MIGH55 |
| `stop_reason: "refusal"` | — | sí, en 5 categorías: cyber, bio, frontier_llm, reasoning_extraction, general_harms. La fallback del servidor solo reintenta cyber y frontier_llm | sí, **sin fallback del servidor** | [C] MIG55, MIGH55 |
| Prefill / `tool_choice` forzado | — | 400 / 400 | 400 / se acepta (sin pensamiento) | [C] |
| Mínimo cacheable | 1.024 | **512** | 512 | [C] CACHE |
| Precio (entrada / escritura de caché 5 min / lectura / salida, USD por MTok) | 3 / 3,75 / 0,30 / 15 | 2 / 2,50 / **0,10 (0,05×)** / 10 | 0,10 / 0,125 / 0,01 / 0,50 (≤ 100K); 0,50 / 0,625 / 0,05 / 2,50 (> 100K, contando la caché) | [C] PRICE |
| `count_tokens` | gratis | gratis | gratis | [C] COUNT («free to use») |

URLs:

- MIG55: https://platform.claude.com/docs/en/models/sonnet-5-5/migration-guide
- MIGH55: https://platform.claude.com/docs/en/models/haiku-5-5/migration-guide
- EFFORT: https://platform.claude.com/docs/en/build-with-claude/effort
- MODELS: https://platform.claude.com/docs/en/about-claude/models/overview
- PRICE: https://platform.claude.com/docs/en/about-claude/pricing
- CACHE: https://platform.claude.com/docs/en/build-with-claude/prompt-caching
- COUNT: https://platform.claude.com/docs/en/build-with-claude/token-counting

### Inferencias sobre el código actual

- **[I] Cambiar de modelo solo por env no es seguro.**
  - Ni `server-llm.ts` (`serverLlmRequestBody`) ni `provider-clients.ts` (`AnthropicClient.messages`, que arma el guion del audiolibro) envían `thinking` ni `effort`.
  - En 5.5 eso significa pensamiento adaptativo: con effort high en Sonnet 5.5 y medium en Haiku 5.5. Ese pensamiento consume `max_tokens`, se cobra como salida y suma latencia.
  - Ninguno de los dos maneja `stop_reason: "refusal"`.
- **[I] El catálogo de FinOps no soporta tramos de precio.** `claude-haiku-5-5` no tiene fila. Con un cambio por env, el cargo fallaría por PRICING_MISSING (diseño «fail loud»).

## 3. Riesgo de truncado con el tokenizer nuevo

Se compara la salida medida (4.6) × factor del tokenizer contra el `max_tokens` actual.

Limitación: el ledger offline **solo da promedios por llamada, no p95**. Que el promedio esté por encima del 85 % del tope implica que la cola ya trunca.

| Componente | Base | Salida media 4.6 | Tope | ×1,15 | ×1,30 | ×1,40 | Riesgo |
|---|---|---|---|---|---|---|---|
| course_plan M (12 caps) | 1 llamada #1353 | 8.012 | 10.400 (2.000 + 700/cap) | 0,89 | 1,00 | 1,08 | **TRUNCA** |
| course_plan L (20 caps) | interpolado | 13.412 | 16.000 | 0,96 | 1,09 | 1,17 | **TRUNCA** |
| audiobook_chapter, bloque de 900 palabras (banda hasta 1,1×) | supuesto del código: 1,8 tok/palabra | 1.782 | 1.820 | 1,13 | 1,27 | 1,37 | **TRUNCA** |
| content | promedio de #1353 | 5.648 | 8.000 | 0,81 | 0,92 | 0,99 | ALTO; el truncado de content **no se reintenta** |
| experience | promedio de #1353 | 5.575 | 8.000 | 0,80 | 0,91 | 0,98 | ALTO |
| application_activity | promedio de #1353 | 5.863 | 9.000 | 0,75 | 0,85 | 0,91 | MEDIO / ALTO |
| exam / final_exam, parte del banco | `EXAM_BANK_WORKER_OUTPUT_EST` | 7.000 | 12.000 | 0,67 | 0,76 | 0,82 | MEDIO; además, las tablas `DYN_EXAM_BANK_TOKENS_EST` quedan descalibradas |
| activity (#1510), video_interactions, guided_practice, intros | — | — | — | — | — | — | BAJO / MEDIO |

**Precondición de cualquier migración:**

1. Multiplicar por ≈ 1,35 los `max_tokens` y los presupuestos por capítulo o palabra:
   - `DYN_PLAN_TOKENS_PER_CHAPTER`;
   - `sectionMaxTokens`;
   - `DYN_CONTENT_MAX_TOKENS`;
   - `EXAM_BANK_*`.
   Hay que respetar el tope del worker (16.000) y el del proxy del navegador (8.000).
2. Mandar `between_tools` (Sonnet 5.5) o `disabled` (Haiku 5.5), con effort ≤ high.
3. Manejar `refusal`.

El brazo B de la Fase 1 ya aplica ×1,35 con tope 16.000.

## 4. Proyección de costo (`modelab project`)

Costo LLM de Anthropic por curso, en USD.

- Baseline: Sonnet 4.6 con los fixes de reintentos de r60.
- Las celdas con tres valores corresponden al factor del tokenizer 1,15 / 1,30 / 1,40.
- La columna «Total M» suma el LLM (factor 1,30) más Videogen, Gamma y TTS, que son constantes: 19,82 en M.

| Política | S 1×1 | M 3×4 | L 4×5 | Total M |
|---|---|---|---|---|
| A · S4.6 | 0,50 | 20,03 | 31,28 | 39,85 |
| B · S5.5 en todo | 0,38 / 0,43 / 0,47 | 15,17 / 17,15 / 18,47 | 23,71 / 26,80 / 28,86 | 36,97 |
| C · S5.5 + H5.5 (audio, intros) | 0,27 / 0,31 / 0,33 | 13,84 / 15,65 / 16,85 | 21,55 / 24,36 / 26,23 | 35,47 |
| D · S5.5 + H5.5 (audio, intros, video_interactions, plan) | 0,23 / 0,26 / 0,28 | 12,85 / 14,52 / 15,64 | 19,88 / 22,48 / 24,21 | 34,34 |
| E · S4.6 + H5.5 solo en audio | 0,39 | 18,46 | 28,67 | 38,28 |
| F · H5.5 en todo (piso teórico) | 0,02 | 0,87 | 1,36 | 20,69 |

Lectura:

- **Sonnet 5.5:** el precio es 2/3 del de 4.6, pero los tokens suben un 30 %. Queda en ≈ 0,87× por ítem, con un empate en factor 1,5.
  - El criterio de ahorro de ≥ 10 % por ítem válido se cumple **solo si el factor real es ≤ ~1,35** y no hay pensamiento.
  - Por eso, el primer paso de la Fase 1 es `count_tokens`, que es gratis.
- **Haiku 5.5:** baja el costo de cada componente donde se use en ~95 %.
  - En M, todo el LLM con Haiku costaría ≈ 0,9 USD, frente a ≈ 20.
  - Lo que hay que medir es la calidad, porque el costo pasa a ser irrelevante frente a Videogen, Gamma y TTS (≈ 19,8 USD en M).
- **Retries:** la proyección asume las **mismas tasas de reintento** que 4.6 con los fixes. Sin medir, es [H].

## 5. Baseline offline determinista (`modelab baseline`)

Sobre la salida real de Sonnet 4.6 del curso #1510 (paquete extraído):

| Grupo | MC | Correcta más larga | Esperado por azar | Repetición (shingles de 12) | Hits de idioma | Inglés | Marcadores editoriales |
|---|---|---|---|---|---|---|---|
| activity (H5P) | 5 | 0 % | 25 % | 0,000 | 0 | 0 | 0 |
| video_interactions (H5P) | 4 | 0 % | 31 % | 0,006 | 0 | 0 | 0 |
| Libro Guía | — | — | — | 0,000 | 0 | 0 | 0 |

Además:

- **Llamadas por ítem válido en #1353** (proxy de reintentos): content 1,08; video_interactions 2,58; experience 3,58; guided_practice 2,58; application_activity 3,67; exam 81 por banco; final_exam 93.
- **Rechazos documentados en la primera pasada del banco de examen** (post-fix): LENGTH_BIAS > DISTRACTORS > SCHEMA.

Las fixtures de replay del repo son sintéticas (LLM falso), así que no sirven como baseline de calidad.

## 6. Arnés A/B reproducible (`scripts/modelab/`)

**Mismo motor que el producto.** El arnés usa el driver offline: claim del scheduler, ejecutor en vm y validación de `completeItem`. No hay cambios en el código de la app.

**Modelo del brazo por «punto fijo» de replay.** El modelo del brazo entra sin que el ejecutor tenga red nunca:

1. Las llamadas pendientes se adaptan al brazo (modelo, thinking, effort, `max_tokens`).
2. Se validan con `lintBody`, según las reglas oficiales de arriba.
3. Se reservan en la guardia de presupuesto.
4. Se envían fuera de la barrera de red.
5. El `stop_reason` real (max_tokens / refusal) le llega al ejecutor igual que en producción.

**Otros elementos:**

- **Audiolibro:** usa el mismo `generateSectionScript`, con la banda 85–110 %, continuación, condensación, truncado e idioma.
- **Entradas fijas:**
  - `B-M`, M 3×4 sintético de la simulación comercial;
  - `1x1-sin-examenes`, la configuración de la Fase B (#1510).
  - Las dependencias, como content y course_plan, se generan **una vez** con el brazo baseline y quedan congeladas, con su sha256, para todos los brazos.
- **Brazos:**
  - A: Sonnet 4.6, como hoy;
  - B: Sonnet 5.5 con `between_tools`, effort medium y `max_tokens` ×1,35;
  - C: Haiku 5.5 con `disabled`, effort medium y `max_tokens` ×1,35.
- **Muestreo:** ningún brazo manda parámetros de muestreo. La API no tiene semilla, así que la varianza se mide con réplicas y orden rotado.
- **Calificación determinista:**
  - validez en primera pasada;
  - reintentos por ítem;
  - fallas duras;
  - truncados y refusal;
  - JSON inválido;
  - sesgo de largo de la correcta (con z contra el azar);
  - repetición;
  - idioma (`lqaSentenceFindings` del repo), inglés y marcadores editoriales;
  - USD por ítem válido.
- **Costos:** salen del código de FinOps (`priceUsage`), con un catálogo del laboratorio que incluye los tramos de Haiku.
- **Rúbrica:** se generan `judge-packets.jsonl`, con pares ciegos de etiqueta aleatoria y los nombres de modelo redactados, y `judge-key.json` aparte (con el componente de cada paquete). `modelab decide` aplica los puntajes **offline, a USD 0**, sobre la corrida guardada.
- **Presupuesto (revisión r61, I1–I6):**
  - **Ledger acumulado** `OUT/modelab-ledger-<experimento>-<modo>.jsonl`, append-only: `reserve` antes de cada intento y `settle` después. El presupuesto aprobado es **por experimento**: disponible = aprobado − todo lo gastado antes, y una reserva sin `settle` (caída a mitad de llamada) cuenta al peor caso. Con gasto previo, el modo real se niega a arrancar sin `--resume`; con `--resume` reutiliza a USD 0 las respuestas ya pagadas (`modelab-answers-*.jsonl`).
  - **Chequeo previo:** proyección por evidencia (incluido el humo) × 1,25 ≤ disponible; si no, no se hace ninguna llamada.
  - **Cota por intento:** entrada estimada × 1,25 de holgura a precio de escritura de caché + `max_tokens`. Ante un error de red o 5xx, se asume el peor caso.
  - **Sin reintentos automáticos del SDK** (`maxRetries: 0`). Los transitorios (429/529/5xx/red) se reintentan explícitamente, hasta 4 intentos con backoff, **cada intento con su reserva y su renglón**. Nunca se guardan como respuesta ni cuentan como falla del brazo; si se agotan, la corrida aborta (`INFRA_RETRIES_EXHAUSTED`).
  - **4xx inesperado** (`invalid_request`, auth): aborta la corrida con el mensaje de la API (`ARM_REQUEST_REJECTED`). Nunca se convierte en una «falla dura» del brazo.
  - **Llamada de humo obligatoria** por (componente, brazo) ANTES de dependencias y brazos: el pedido real del componente adaptado al brazo, con `max_tokens` 32, reservado en el presupuesto. En la misma fase, `count_tokens` (gratis) mide el factor del tokenizer de cada brazo sobre esos pedidos.
  - **Informe siempre:** `runExperiment` nunca relanza; cualquier error queda en `aborted`, con el gasto, las llamadas y las respuestas hasta ese momento. SIGINT/SIGTERM escriben el informe parcial y salen con 130.
- **Modo real:** exige `--real --approved-budget-usd=N --api-key-env=VAR --out=DIR` (el `--out` debe ser estable: ahí vive el ledger). El tope de 10 USD es **duro**: cambiarlo exige cambiar el código, no hay flag. El SDK va fijo a `https://api.anthropic.com`, y si `ANTHROPIC_BASE_URL` apunta a otro host se niega. Nunca lee `.env`.
- **Sin red fuera del modo real:** todo comando offline y `check-modelab` corren bajo la barrera de red del repo (`scripts/lib/netguard.js`: sockets, fetch, http(s), tls, DNS, UDP).

**Comandos:**

```bash
npm run build
export CURSIA_FRONTEND_REPO=../fe   # fixtures H5P v2 del frontend

# USD 0
node scripts/modelab/check-modelab.js                         # autoverificación: 16 checks, bajo barrera de red
node scripts/modelab/modelab.js project  --out=OUT
node scripts/modelab/modelab.js baseline --out=OUT
node scripts/modelab/modelab.js plan
node scripts/modelab/modelab.js run --dry-run --out=OUT        # punta a punta, sin red

# Fase 1, solo con autorización
ANTHROPIC_API_KEY=... node scripts/modelab/modelab.js capture --real --api-key-env=ANTHROPIC_API_KEY --out=OUT   # count_tokens, gratis
ANTHROPIC_API_KEY=... node scripts/modelab/modelab.js run --real --approved-budget-usd=5 --api-key-env=ANTHROPIC_API_KEY --out=OUT   # humo + count_tokens + brazos
ANTHROPIC_API_KEY=... node scripts/modelab/modelab.js run --real --approved-budget-usd=5 --api-key-env=ANTHROPIC_API_KEY --out=OUT --resume   # tras un aborto: reutiliza lo pagado
node scripts/modelab/modelab.js decide --run=OUT/modelab-run.json --rubric=scores.json --judge-key=OUT/judge-key.json   # veredicto con la rúbrica, offline, USD 0
```

## 7. Plan de Fase 1

Configuración: `scripts/modelab/config/phase1.json`. La proyección por evidencia es de **USD 3,68** (incluye USD 0,22 de llamadas de humo); con el margen ×1,25 queda en 4,60. **Se pide aprobar USD 5** (presupuesto por experimento, acumulado en el ledger).

| Paso | Componente | Entrada | Muestra | Brazos | Réplicas | USD estimado |
|---|---|---|---|---|---|---|
| 0 | Humo obligatorio por (componente, brazo), `max_tokens` 32, + `count_tokens` (gratis) del mismo pedido | M-sim, S | 1 pedido real por componente | A, B, C | — | 0,22 |
| 1 | Dependencias congeladas (content × 5, course_plan × 2) | M-sim, S | — | A | 1 | 0,57 |
| 2 | audiobook_chapter | M-sim | 2 capítulos | A, B, C | 2 | 1,08 |
| 3 | video_interactions | M-sim | 2 capítulos | A, B, C | 2 | 0,83 |
| 4 | course_intro | M-sim | 1 | A, B, C | 2 | 0,12 |
| 5 | module_intro | M-sim | 3 módulos | A, B, C | 1 | 0,31 |
| 6 | content | M-sim | 2 capítulos | A, B | 1 | 0,40 |
| 7 | activity (H5P) | S | 1 capítulo | A, B, C | 2 | 0,15 |
| | **Total** | | | | | **≈ 3,68** (× 1,25 = 4,60; tope 5) |

Fuera de la Fase 1, por costo y porque dependen de verificar primero los fixes del examen:

- exam / final_exam;
- experience;
- guided_practice;
- application_activity.

Esos quedan para la Fase 2: B y C solo en la revisión de forma, con un costo de ≈ USD 10.

**Criterios de éxito** por componente × brazo, frente a A:

1. Rúbrica media ≥ A − 0,25 (escala 1–5).
2. Validez en primera pasada ≥ A − 5 puntos.
3. Cero fallas duras nuevas (falla del ítem, truncado, refusal, JSON inválido).
4. Ahorro ≥ 10 % por ítem válido, medido **en frío** (las lecturas de caché se reprecian como escritura). Así el estado de la caché entre réplicas, que el humo y la réplica anterior calientan, no decide el veredicto. El informe muestra el costo real y el costo en frío.
5. El sesgo de largo de la correcta no sube más de 10 puntos.
6. Solo Sonnet 5.5: factor del tokenizer medido con `count_tokens` en el humo ≤ 1,35.

**Regla go/no-go**, implementada en `decide()`:

- **NO_GO** si falla cualquiera de los criterios deterministas (2–6), **o si falta** una métrica determinista. Un dato ausente nunca aprueba. La única excepción es el sesgo cuando ningún brazo tiene MC: ahí es «n/a».
- **PENDING_TOKENIZER** si en Sonnet 5.5 falta el factor medido.
- **PENDING_RUBRIC** si los deterministas pasan pero todavía no hay rúbrica.
- **GO** solo si además la rúbrica cumple (1).
- Los errores de infraestructura no son fallas del brazo: se reintentan o abortan la corrida.

**Rúbrica:**

- La califica un humano experto en ≥ 20 % de los paquetes.
- Se puede sumar un juez opcional, `claude-opus-5-5`, a ciegas, calibrado contra el humano.
- Para el audiolibro, además, una escucha humana de 2 capítulos.

**Decisión por componente:**

- Haiku 5.5 se adopta en los componentes con **GO**, después de implementar las precondiciones de §3.
- Sonnet 5.5 se adopta solo con GO, y el GO ya incluye la compuerta del factor ≤ 1,35.
- Si el factor es > 1,35, Sonnet 5.5 no cumple el criterio de ahorro aunque la calidad empate. En ese caso se mantiene 4.6 hasta su retiro (no antes del 2027-02-17) y se reevalúa.

## 8. Límites de esta fase

- La Fase 0 **no mide calidad de los modelos nuevos**. El dry-run usa el LLM falso y uso simulado.
- Las proyecciones dependen del factor del tokenizer y de las tasas de reintento, que son supuestos.
- Las entradas de la Fase 1 son sintéticas. Para usar el Blueprint exacto de #1510 hace falta exportar un snapshot (`source: "file"`); no se leyó la base de datos.
- El truncado se estimó con promedios, no con p95: no hay distribución por llamada offline.

### Menores abiertos de la revisión r61 (documentados, no bloquean la Fase 1)

- **M1:** la cota de entrada sigue siendo una estimación (chars/4 × factor × 1,25 de holgura). Domina `max_tokens`, pero el tope no es exacto al centavo.
- **M2:** el tramo de Haiku 5.5 en la cota se elige con la estimación. En la Fase 1 ningún prompt se acerca a 100K.
- **M7:** el juez LLM (Opus 5.5) no está implementado ni presupuestado. Si se implementa, debe pasar por `callThrough` y entrar en `planCost`.
- **M9:** la regla «tool_choice forzado sin pensamiento» de Haiku 5.5 no tiene lint. Cursia no usa `tool_choice`.
- **Ledger por directorio:** el ledger vive en `--out`. Otro `--out` empieza otro ledger; por eso el modo real exige un `--out` explícito y estable.
- **Humo y caché:** el humo calienta la caché del prefijo. Por eso el ahorro se decide en frío.
