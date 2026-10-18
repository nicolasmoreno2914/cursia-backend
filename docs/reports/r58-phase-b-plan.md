# r58 Fase B: plan del primer experimento económico con IA real (techo USD 5)

**Estado: DISEÑO. No se ejecutó nada.** Este documento no autoriza ningún gasto, despliegue, cambio de `.env` ni llamada a proveedores.
Fecha: 2026-10-18. Fuentes:
- `r58/AU3-FINOPS-SECURITY-AUDIT.md` (§H3, §H4: defensa en profundidad; topes externos reales; criterios de aborto);
- `r58/AU1-PIPELINE-AUDIT.md` (§1.6–1.7, §3, R5: claves de generación por Manifest; checkpoints = grabación);
- `r58w1/I1-REPORT.md` (driver offline, replay, conversor, guarda `CURSIA_ALLOW_REAL_PROVIDER_RECORD`);
- `r58w2/I5A-REPORT.md` (`FINOPS_KILL_SWITCH`, `FINOPS_PROVIDER_ALLOWLIST`, techos sin atribuir, `ownerMonthlyCap`, `LEGACY_PAID_JOBS_ENABLED`, `VIDEO_ENGINE_ENABLED`, `DYNAMIC_WORKERS_HOLD`);
- `r58w3/I3-REPORT.md` (horas: `hoursReport`, línea «Duración estimada»);
- `r58w4/I5B-REPORT.md` (procedencia `llmMode`, preview vs final, guarda de base URL);
- ledger de #1353 y `validation/` (`piloto-M-post-piloto-curso-1353-2026-10-14.md`, `final-exam-run{,2,3}-1353-*.md`, `finops-p0-staging-2026-10-16.md`);
- código: `generation-manifest-builder.ts` (ítems v3 y `dependsOn`), `llm-worker-routing.ts`, `stop-after.ts`, `spend-controls.ts`.

Etiquetas: **[E]** estimación (no medición) · **[V]** verificado en código o documento · **[P]** pendiente de verificar antes de ejecutar.

---

## 1. Objetivo

Validar con IA real (Anthropic) la **calidad**, el **costo** y la **confiabilidad** de un camino de componentes **pequeño y aislado**, de punta a punta en staging. Debe pasar por las funciones nuevas de r57/r58:
- reserva → llamada → liquidación, con tope atómico del run;
- kill switch, allow-list de proveedores, techo sin atribuir, `ownerMonthlyCap`;
- worker de IA del servidor, con checkpoints;
- validadores v3 por ítem;
- procedencia `llmMode`: el run termina en `preview` porque Gamma, TTS y video van en mock, así que nunca sale un paquete final;
- `hoursReport`;
- grabación de las respuestas reales como fixtures saneadas para replay a USD 0.

**No es objetivo:** generar un curso completo, probar Gamma / TTS / Videogen / YouTube, ni producir un entregable de cliente.

Pregunta que debe responder: **¿el costo real por componente de texto cae dentro del rango medido en #1353, sin bucles de reparación, con 0 gasto fuera del ledger y Console ≈ ledger?**

---

## 2. Componente elegido

### 2.1 Alternativas comparadas (costos por ítem del ledger de #1353, incluyendo sus reintentos)

| Opción | Qué genera | Costo medido en #1353 | Varianza observada | ¿Proveedores? | Veredicto |
|---|---|---|---|---|---|
| **A. Un capítulo, componentes de texto** | content + experience + activity (H5P calificable) + video_interactions, más los ítems de curso/módulo obligatorios | content ≈ 0,10; experience ≈ 0,31; activity ≈ 0,04; video_interactions ≈ 0,105; ítems de curso/módulo ≈ 0,05 c/u | Moderada. experience del cap. 2.1 llegó a 8 intentos (`deepening[n].steps` fuera de 3–6); video_interactions: 4 de 12 con reintento | Solo Anthropic | **ELEGIDA** |
| B. Un banco de examen de módulo pequeño | `exam:<m>` | ≈ 3,15–3,69 por banco; el banco de M2 falló 10 intentos (≈ USD 3–4 perdidos) | **Alta**: rendimiento de reparación bajo, `EXAM_BANK_INCOMPLETE` determinista, caché vencida entre principal y reparación | Solo Anthropic | Rechazada: un solo intento malo consume casi todo el techo |
| C. Examen final | `final_exam` | ≈ 7,92 en total (3 runs); estimado 1,8, real 3,44 en el primer intento | Muy alta (17 reparaciones, truncado a 12 000 tokens, reintento desde cero) | Solo Anthropic | Rechazada: excede el techo |
| D. Capítulo completo con medios | A + presentation (Gamma) + audiobook (guion + TTS) + video (Videogen) | + Gamma ≈ 0,485 (precio provisional), guion 0,137 + TTS 0,316, Videogen ≈ 0,85 (no verificado) | Precio Gamma de marcador (0,01/crédito), Videogen sin verificar | Gamma, OpenAI, Videogen | Rechazada: rompe "solo Anthropic" y su costo no es medible con exactitud |
| E. Driver offline en modo `record` contra Anthropic real | los mismos ítems de A, fuera del producto | igual que A | igual que A | Solo Anthropic | Rechazada como camino principal: llama directo, **sin ledger, sin tope de run, sin kill switch**. Solo lo frena el límite externo y no valida nada de r58 FinOps |

### 2.2 Justificación de A
- Es el camino de texto con menor costo y menor varianza que toca **todos** los mecanismos nuevos (worker del servidor, reservas, validadores v3, H5P v2, `llmMode`, horas).
- Ningún ítem de A tiene un costo medido > USD 0,40. El peor caso está acotado por el presupuesto de recuperación por ítem (2,5× esperado, máximo estimado, piso USD 0,25) y por el tope del run [V AU3 §H1.1].
- `activity` cubre «una actividad H5P calificable». `video_interactions` cubre el guion de interacciones de video **sin** Videogen: el video va en mock y video_interactions se genera y valida igual [V I1, nota sobre videos].
- Los exámenes quedan para un nivel posterior, cuando los arreglos del banco estén validados en replay a USD 0 (ver §11).

### 2.3 Forma del curso: un curso NUEVO 1×1 sin exámenes
Un run siembra **todos** los ítems del Manifest [V AU1 §1.6]. `stop-after` pausa cuando se completa **cualquiera** de sus claves, no cuando se completan todas [V `stop-after.ts`]. Y `exam:<m>` se puede reclamar en cuanto termina el content del módulo. Conclusión: `stop-after` **no** basta para aislar un capítulo dentro de un curso más grande. La forma del curso tiene que hacer el aislamiento:
- **1 módulo × 1 capítulo de contenido** (la forma mínima válida es `modules ≥ 1`, `chaptersPerModule ≥ 1`) [V `context-design.ts:323`];
- `examEnabled=false` en el módulo y `finalExam=false` en el curso, para que no existan `exam:*` ni `final_exam:*` [V manifest builder: existen solo con esos flags]. **[P]** Hay que confirmar que el flujo de creación y los validadores del Blueprint aceptan ambos flags en false. **Si el producto no lo permite, el experimento NO se ejecuta** y vuelve a Fase A (selección de ítems en el run);
- `videoEnabled=true` (necesario para que exista `video_interactions`) y `activityEnabled=true`;
- carga horaria baja, para que el motor de horas **no** agregue `application_activity`, `guided_practice` ni un capítulo de práctica. **[P]** Se confirma con el dry-run.

**Manifest esperado (lista blanca; cualquier otro tipo en el estimate-preview → no aprobar):**

| Ítem | Ejecuta | Modo | Costo |
|---|---|---|---|
| `course_plan:<id>` | worker IA del servidor | real | Anthropic |
| `course_intro:<id>` | worker IA | real | Anthropic |
| `module_intro:<m>` | worker IA | real | Anthropic |
| `content:<ch>` | worker IA | real | Anthropic |
| `experience:<ch>` | worker IA | real | Anthropic |
| `activity:<ch>` (variant / h5pType según reglas) | worker IA | real | Anthropic |
| `video_interactions:<ch>` | worker IA | real | Anthropic |
| `video:<ch>` | item worker | **mock** (`videoMode:'mock'`) | 0 |
| `presentation:<ch>` | provider worker | **mock** (`providerModes.presentation:'mock'`) | 0 |
| `audio_welcome:<id>` | provider worker | **mock** (`providerModes.audio:'mock'`) | 0 |
| `audiobook_chapter:<ch>` | provider worker | **mock** (`providerModes.audio:'mock'`) | 0 [P: confirmar que en mock no corre el guion LLM] |

Por los ítems mock, R2 clasifica el run como `preview`. Solo se puede empaquetar `qa_preview` (SUPER_ADMIN) y nunca un final [V I5B]. Para este experimento eso es lo deseado.

**R5:** el curso es **nuevo y desechable**, así que las claves de generación 1 (`sha256(manifestId:itemKey:generation)`) que se consumen pertenecen a un Manifest que no sirve para nada más. **Nunca** se usa #1353, #1209, #542 ni ningún curso existente.

---

## 3. Datos de entrada (sintéticos, sin datos de cliente)

- **Título:** `[SINTÉTICO] Introducción al compostaje doméstico`. Tema neutro, sin institución, sin marca, sin documento de cliente.
- **Microcurrículo, escrito a mano en el formulario** (sin subir PDF ni DOCX):
  - Módulo 1 «Fundamentos del compostaje».
  - Capítulo 1.1 «Cómo iniciar una compostera en casa». Contenidos:
    1. materiales verdes y marrones;
    2. proporción y humedad;
    3. volteo y señales de problemas.
  - Objetivo: «El participante prepara y mantiene una compostera doméstica identificando y corrigiendo problemas comunes».
- **Público:** adultos, nivel básico, español neutro (es-419). País: ninguno específico.
- **Horas objetivo:** baja (p. ej. 3 h) **[P]**: el valor final se elige con el dry-run, de modo que el Manifest quede igual a la lista blanca de §2.3.
- **Perfil pedagógico:** el default. Sin `hoursModel`, salvo que se quiera probar `teacherGuideBreakdown` (USD 0, solo empaque).
- **Prohibido en la ventana** (son llamadas pagadas directas, fuera del run):
  - `POST /course-setup/extract-from-pdf`;
  - subir brand profiles (extracción de marca con Opus);
  - lectura académica avanzada (`ACADEMIC_ADVANCED_EXTRACTION_ENABLED` sin definir);
  - `/tts/speech`;
  - botones de «probar conexión» o de coherencia del navegador, que generan gasto sin atribuir.

---

## 4. Proveedores

- **Permitido:** solo Anthropic, con una clave de un **workspace dedicado** (§6, capa 0). Modelo: el default del worker (`claude-sonnet-4-6` [V `replay-api.js:27` = default del worker]). Ejecutor: **worker de IA del servidor**, porque `ALL_LLM_WORKER_TYPES` cubre los 7 tipos reales [V `llm-worker-routing.ts`]. Así cada respuesta queda como checkpoint (grabación) y atribuida en el servidor.
- **Bloqueados por ausencia de clave en staging durante la ventana:** OpenAI, Gamma, Videogen (`VIDEOGEN_API_KEY`, `VIDEO_ENGINE_API_KEY`), Resend, RapidAPI. Ese es el único allow-list que se sostiene en **todos** los caminos [V AU3 §H4.2].
- **Bloqueados por código** (r58 I5A, una vez desplegado):
  - `FINOPS_PROVIDER_ALLOWLIST=anthropic`;
  - `LEGACY_PAID_JOBS_ENABLED=false`;
  - `VIDEO_ENGINE_ENABLED` sin definir o false.
- **YouTube:** sin uso (video en mock).

---

## 5. Estimación de costo [E]

### 5.1 Supuestos
- Costo por ítem = promedio por ítem del ledger de #1353 (curso M, 12 capítulos), **incluidos sus reintentos**.
- Un curso 1×1 tiene menos contexto de módulo, así que el costo por llamada probablemente sea **menor**. Pero tiene menos lectura de caché entre ítems. Se toma el promedio de #1353 tal cual, sin descuento.
- `course_plan` en 1×1 debería pedir mucho menos que en M (en un L llega a 16 000 tokens de salida). Se usa el promedio de los ítems de curso/módulo de #1353 (0,33 USD / 6 ítems ≈ 0,055).
- Precios: los del ledger (`PRICED_MODELS`). Si aparece una llamada sin precio, es criterio de suspensión (§8).
- Tokens por llamada [E, orden de magnitud desde los documentos de #1353]:
  - entrada 3k–15k, con caché del contenido del capítulo (≈ 11k tokens);
  - salida 1,5k–8k;
  - tope de salida por llamada 16 000 en el worker [V AU3 fila 1].
- p50 = el promedio medido. p90 = 2–3× el promedio en los tipos que tuvieron reintentos en #1353. «Peor acotado» = la suma de los presupuestos de recuperación por ítem (2,5× esperado o piso 0,25), antes de que el guard pare el ítem.

### 5.2 Tabla

| Ítem | Llamadas esperadas | p50 USD | p90 USD | Peor acotado USD |
|---|---|---|---|---|
| course_plan | 1 | 0,06 | 0,15 | 0,25 |
| course_intro | 1 | 0,05 | 0,10 | 0,25 |
| module_intro | 1 | 0,05 | 0,10 | 0,25 |
| content | 1–2 (continuación) | 0,10 | 0,25 | 0,26 |
| experience | 3–4 (+ repair) | 0,31 | 0,90 | 0,78 + reapertura manual (no se permite, §8) |
| activity (H5P) | 1–2 | 0,04 | 0,12 | 0,25 |
| video_interactions | 2–3 | 0,105 | 0,30 | 0,26 |
| ítems mock | 0 | 0 | 0 | 0 |
| **Total** | **≈ 10–14** | **≈ 0,72** | **≈ 1,9** | **≈ 2,3** |

- **Margen a la incertidumbre:** aunque el costo real fuera 2× el p90, quedaría en ≈ USD 3,8, por debajo del aborto en 4,00 y del techo de 5.
- **Autorización recomendada del run: USD 3,00.** Es ≥ p90 + margen, ≤ techo. El techo absoluto de USD 5 queda como `maxCostPerRun` / `maxCostPerCourse` de la política.
- Si `estimate.expected` del estimate-preview supera **USD 1,50**, o el máximo estimado supera USD 5, **no se aprueba**: el Manifest no es el esperado.

---

## 6. Techo USD 5: defensa en profundidad

### Capa 0: externa, el único tope duro real (Usuario)
1. En la Anthropic Console, un **workspace nuevo** «cursia-staging-exp-b1» con **su propia API key**:
   - **límite de gasto del workspace: USD 6** (5 + margen para reservas abiertas en conciliación);
   - límites de tasa mínimos.
   **[P]** Verificar en la Console actual que el límite de gasto por workspace **rechaza** llamadas, y no solo alerta.
2. **Auto-reload de la organización: OFF** durante toda la ventana.
3. La clave nueva va **solo** en el `.env` del VPS de staging (`ANTHROPIC_API_KEY`) y en el env de Pages de `staging.orbia.pages.dev`. Producción no se toca.
4. Quitar de staging (VPS `.env` y Pages env) `OPENAI_API_KEY`, `GAMMA_API_KEY`, `VIDEOGEN_API_KEY`, `VIDEO_ENGINE_API_KEY`, `RESEND_API_KEY` y `RAPIDAPI_KEY`. Guardar una copia fuera de línea para restaurarlas después. Luego `pm2 restart … --update-env`.

### Capa 1: env y código (r58 I5A desplegado en staging)

| Variable | Valor en la ventana | Efecto |
|---|---|---|
| `FINOPS_PROVIDER_ALLOWLIST` | `anthropic` | cualquier reserva o cargo de otro proveedor se rechaza |
| `FINOPS_KILL_SWITCH` | `false` (preparado para `true`) | ver §7 |
| `FINOPS_UNATTRIBUTED_DAILY_USD_PER_OWNER` | `0.25` | techo sin atribuir por dueño (24 h) |
| `FINOPS_UNATTRIBUTED_DAILY_USD_GLOBAL` | `0.50` | techo sin atribuir global |
| `LEGACY_PAID_JOBS_ENABLED` | `false` | workers v1 de pago sin claim |
| `VIDEO_ENGINE_ENABLED` | sin definir / `false` | `/video-engine` sin renders |
| `DYNAMIC_ALLOW_PROVIDER_MOCK` | `true` (solo en la ventana) | permite `providerModes` mock |
| `DYNAMIC_REAL_VIDEO_OWNERS` / `_ALL_OWNERS` | sin el dueño experimental | nunca video real |
| `DYNAMIC_AUTO_HEAL_ENABLED` | `false` | sin reaperturas automáticas, sin sondeo de crédito, sin reenvío de audio |
| `DYNAMIC_DEFAULT_HOLD_PACKAGING_OWNERS` | `<dueño experimental>` | sin empaque automático |
| `DYNAMIC_LLM_WORKER_ENABLED` | `true` | worker de IA activo (presencia viva) |
| `DYNAMIC_LLM_WORKER_SINCE` | instante ≤ creación del run | el ruteo aplica al run nuevo |
| `ACADEMIC_ADVANCED_EXTRACTION_ENABLED` | sin definir | sin lectura avanzada |
| `SUPER_ADMIN_USER_IDS` | definido | admin solo por id + email confirmado |
| `DEPLOY_FREEZE` | `true` (variable de GitHub + `.env` del VPS) | ningún deploy durante la ventana |
| `CURSIA_ALLOW_REAL_PROVIDER_RECORD` | **sin definir en todos lados** | ver §9 |

Además:
- deploy automático de Cloudflare Pages `staging` **pausado** a mano;
- Supabase Auth de staging: **signups OFF** durante la ventana;
- `ANTHROPIC_API_BASE_URL` sin definir (oficial).

### Capa 2: objetos de presupuesto en la DB (USD 0)
- **Dueño dedicado:** un UUID nuevo, solo en `DYNAMIC_V2_ALLOWED_OWNERS`. No es el dueño QA `aa2fa9a1` ni el dueño de #1353.
- **Política de alcance dueño:**
  - `maxCostPerRun: 5`, `maxCostPerCourse: 5`;
  - **`ownerMonthlyCap: 5`** (I5A: por dueño, con fallo cerrado; se chequea solo al aprobar);
  - `maxCostPerProvider: {gamma: 0, openai: 0, videogen: 0}`;
  - `require_human_approval_for_real_spend: true`, `on_exceed: BLOCK`;
  - sin `monthlyCap` global nuevo.
- **Curso nuevo** (gasto del curso = 0). Un solo run.
- **Autorización del run:** `min(estimate.max, 3,00)`, aprobada por el Usuario. El techo de 5 queda en la política.

### Capa 3: monitoreo (Claude, solo lectura, cada 5 min mientras el run esté vivo)
- `committed` / `actual` / `reserved` del run (`/finops/runs/:id/costs`) contra la autorización.
- Cantidad y suma de eventos `billable` con `provider <> 'anthropic'` desde el inicio de la ventana: **esperado 0**.
- Sin atribuir de hoy (`run_id is null`, `billing_account='cursia'`), por dueño y por `attributionRejectReason`: **esperado 0**.
- Reservas abiertas (cantidad y suma), llamadas sin precio (`pricingMissing` / `unpricedReason`).
- Por ítem: `worker_status`, intentos, roles de llamada (`main` / `validation_retry` / `continuation`), estado del breaker, motivo de pausa.
- Logs: `FINOPS_NOT_RECORDED`, `finops_ledger_write_failed`, `PROVIDER_NOT_ALLOWED`, `NETWORK`/5xx/524.
- **Anthropic Console del workspace** (Usuario): uso al inicio, a los 30 min y al final (+ 60 min por el retraso de la Console), contra la suma del ledger con `provider='anthropic'`.
- pm2 y memoria del VPS (compartido con producción).

### Capa 4: criterios de suspensión (§8)

---

## 7. Procedimiento del kill switch

En orden. Se detiene en el primer paso que alcance:
1. **Pausar el run** (`POST …/runs/:id/pause`). Efecto inmediato: los guards rechazan llamadas nuevas. Una llamada en vuelo termina y se registra [V AU3 §H1.1].
2. **`worker_off`** por dispatch. Escribe `DYNAMIC_WORKERS_HOLD=true`, que sobrevive deploys [V I5A #9].
3. **`FINOPS_KILL_SWITCH=true`** en el `.env` del VPS de staging + `pm2 restart <api y workers> --update-env`. Se lee de `process.env` en cada reserva [V `spend-controls.ts`], **pero cambiar el env exige reiniciar el proceso**. Efecto: ninguna reserva nueva pagada por Cursia en proxy, worker LLM, provider worker ni Videogen; los caminos directos devuelven 503. Hacer lo mismo en Pages env (para `video-engine.js`).
4. **Revocar la API key del workspace experimental** en la Console. Es el tope duro final e instantáneo.
5. **No recargar crédito** hasta investigar: una recarga reactiva el sondeo de proveedor si auto-heal quedara encendido.

El paso 3 lo puede ejecutar Claude **solo si el Usuario lo autorizó de antemano en el chat** para esta ventana, como acción de emergencia. El paso 4 lo hace siempre el Usuario.

---

## 8. Criterios de suspensión

**Cualquiera dispara pausa inmediata (§7.1); si persiste, kill switch (§7.3).**

| # | Condición | Umbral |
|---|---|---|
| S1 | Cualquier cargo o reserva de un proveedor distinto de Anthropic, o cualquier evento de un camino legacy/directo (`tts-speech`, `*-extraction`, filas de costo en `usage_events`) | > 0 |
| S2 | Gasto sin atribuir del día (dueño experimental o global) | > USD 0,25 (y cualquier valor > 0 se investiga) |
| S3 | `committed` del run | ≥ USD 4,00 (80 % del techo). Con la autorización de 3,00, el guard pausa antes |
| S4 | Diferencia Console − ledger (Anthropic) | > max(USD 0,50; 10 %) |
| S5 | Bucle de validador: algún ítem llega al **intento 3**, o tiene **> 2 llamadas `validation_retry`/repair** en un intento | N = 2 |
| S6 | Llamada o red inesperada: un host distinto de `api.anthropic.com` en los logs de egreso del worker, `PROVIDER_BASE_URL_OVERRIDE_IN_PRODUCTION`, o cualquier llamada de un camino que no sea el worker de IA | > 0 |
| S7 | Reservas abiertas | > 4, o suma > USD 0,50 |
| S8 | Llamada sin precio (`pricingMissing`) | > 0 |
| S9 | Pausa del breaker, `llm_pending_review` en algún ítem, ≥ 3 errores 5xx/524 seguidos, o log `FINOPS_NOT_RECORDED` / `finops_ledger_write_failed` | > 0 |
| S10 | Se alcanza el límite externo del workspace | se detiene; no recargar |
| S11 | Un ítem fuera de la lista blanca de §2.3 pasa a `running` | > 0 |
| S12 | Truncado por `max_tokens` en cualquier llamada | > 1 |

**Sin reintentos manuales en la ventana.** Si un ítem falla de forma definitiva, se documenta. Un `manual_retry` o un regenerate necesita **otra** autorización del Usuario con su costo estimado.

---

## 9. Modo de grabación (fixtures para replay futuro)

- **Camino recomendado (sin flag):** la grabación es el **checkpoint del worker** [V AU1 §4: `server-llm.ts` guarda `{text, usage, stopReason, messageId}` por hash de pedido]. Después del run, a USD 0:
  1. `GET admin/dynamic-runs/:runId/items/:itemKey/llm-diagnostics` por ítem (SUPER_ADMIN, solo lectura) → JSON;
  2. `node scripts/convert-llm-checkpoints-to-fixtures.js <diag.json> <out.json> --model=claude-sonnet-4-6 --contract=<promptVersion> --validator=<versión>`, **sin** `--synthetic`. Las respuestas son reales aunque el curso sea sintético, así que quedan `synthetic:false`. El conversor se niega a escribirlas dentro de `scripts/fixtures/replay/` [V];
  3. salida en `~/cursia-test-env/work/r58b/fixtures/` (fuera del repo), saneada (claves, tokens, correos, dueño de las rutas);
  4. verificar con `check-replay`: replay del run completo con el driver offline y `llm:'replay'`. Cada hash debe resolverse; un faltante es `REPLAY_FIXTURE_MISSING`, nunca un fallback.
- **`CURSIA_ALLOW_REAL_PROVIDER_RECORD`:** en el camino recomendado **queda sin definir en todos lados** (VPS, Pages, máquina local). Solo haría falta para la variante E (driver `record` directo contra Anthropic), que este plan **no** usa. Si algún día se usa, sería con una autorización aparte, solo en la máquina del operador, solo durante la ventana, con la misma clave del workspace limitado y con un `unset` verificado al cerrar.
- **¿Versionar las fixtures en el repo?** Solo si el Usuario lo decide después de revisarlas. El repo del backend es público [V AU3 §J10]. Recomendación: no versionarlas.

---

## 10. Criterios de calidad (para declarar éxito)

| # | Criterio | Cómo se mide |
|---|---|---|
| Q1 | Los 7 ítems reales terminan `completed`, cada uno en el intento 1, con **≤ 1 reparación** | intentos y `callRole` por ítem |
| Q2 | Validador v3 `valid` con `contentSha256` en cada ítem | `output_summary` |
| Q3 | Informe de calidad: **0 BLOCKER**; cada MAJOR revisado y firmado por una persona (Usuario) | paquete `qa_preview` (USD 0, §12 paso 8) + quality report |
| Q4 | Editorial: español neutro, sin texto en inglés, sin marcadores tipo «Pendiente», sin tokens `$@…@$` inventados, H5P con respuestas correctas únicas y sin sesgo de posición | language-qa + revisión humana |
| Q5 | Alineación: experience, activity y video_interactions evalúan los 3 contenidos del capítulo y el objetivo; nada fuera del tema | revisión humana con checklist |
| Q6 | Horas: `hoursReport` sin violaciones de invariantes; línea «Duración estimada» presente en la bienvenida si hay `targetHours`; `HOURS_TARGET_GAP` explicado | `facts.hoursReport` del `qa_preview` |
| Q7 | Procedencia: ítems LLM `llmMode` real, run `preview` por los mock, `final` imposible (409 `preview_not_deliverable`) | API |
| Q8 | El `.mbz` `qa_preview` pasa `validateMbzV3`, con aviso QA visible | validador |
| Q9 | Costo: total real ≤ p90 (USD 1,9); cada tipo ≤ 2× su promedio de #1353 | ledger |
| Q10 | FinOps: 0 sin atribuir, 0 no-Anthropic, 0 sin precio, 0 reservas abiertas al cierre, Console ≈ ledger (dentro de S4) | §6 capa 3 |
| Q11 | Replay: el driver offline reproduce el run desde las fixtures a USD 0 y con la red bloqueada | `check-replay` |

**Resultado esperado [E]:** USD 0,5–1,2 reales, 10–14 llamadas, 30–60 min. A lo sumo un ítem con una reparación (lo más probable: experience o video_interactions).

---

## 11. Escalera de niveles (propuesta; cada nivel necesita su propia autorización)

| Nivel | Alcance | Proveedores | Techo propuesto [E] | Evidencia para subir |
|---|---|---|---|---|
| 0 (hecho, USD 0) | dry-run, driver offline, replay, gate | ninguno | 0 | Fase A cerrada (I1–I5B) |
| **1 (este plan)** | 1 capítulo, texto: content / experience / activity / video_interactions | Anthropic | **USD 5** (autorización 3,00) | Q1–Q11 cumplidos, ningún criterio S disparado, fixtures grabadas |
| 2 | 1 capítulo con `guided_practice` + `application_activity` (texto), o 2–3 capítulos de un módulo, sin exámenes | Anthropic | USD 8 | costo real ≤ p90 del nivel 1 × capítulos; experience sin bucles; S en 0 |
| 3 | 1 módulo **con banco de examen** | Anthropic | USD 15 | antes, a USD 0: los arreglos del banco (borrador conservado, checkpoints no descartados, reparación por hoja, caché) validados en replay de los checkpoints de #1353; luego el banco real en ≤ 2 intentos |
| 4 | curso **S** completo; Gamma y TTS reactivados con crédito prepago sin auto-recarga; Videogen todavía fuera | Anthropic + OpenAI + Gamma | ≈ USD 25–30 [E] | nivel 3 OK; precio real de Gamma por crédito confirmado; conciliación Console/ledger por proveedor |
| 5 | curso S con video real | + Videogen / YouTube | por definir | costo real de Videogen verificado (hoy no lo está); reservas de Videogen conciliables |

Regla general: un nivel no se sube si el anterior dejó una diferencia Console − ledger sin explicar, o una reserva abierta sin conciliar.

---

## 12. Checklist previo (en orden) y responsables

**U** = Usuario · **C** = Claude · **U→C** = Claude lo hace solo después de una autorización explícita del Usuario en el chat para ese paso. Claude **nunca** maneja valores secretos: no crea, copia, pega ni imprime API keys.

| # | Paso | Quién |
|---|---|---|
| 1 | Revisar y aprobar este plan (alcance, autorización 3,00, techo 5, curso sintético) | U |
| 2 | Merge de r58 Fase A (w1–w4) a `staging`: revisión independiente + gate completo verde + deploy de staging con éxito; verificar que el código servido es el probado | C (por la política de staging) / U si se pide |
| 3 | Dry-run (USD 0) del curso sintético 1×1 sin exámenes: confirmar que el Blueprint acepta `examEnabled=false` y `finalExam=false`, y que el Manifest es igual a la lista blanca de §2.3. Si no, **stop** | C |
| 4 | Crear el workspace de Anthropic, la clave nueva, el límite de USD 6 y verificar que bloquea; auto-reload OFF; anotar el saldo inicial | U |
| 5 | Poner la clave nueva en el `.env` del VPS de staging y en el Pages env de staging; quitar las claves de OpenAI, Gamma, Videogen, Video Engine, Resend y RapidAPI (copia de respaldo fuera de línea) | U |
| 6 | Flags no secretos de §6 capa 1 en el VPS `.env` + `pm2 restart --update-env`; `DEPLOY_FREEZE=true` (GitHub var + VPS) | U→C |
| 7 | Pausar el deploy automático de Pages `staging`; signups de Supabase OFF | U |
| 8 | Crear el dueño experimental, `DYNAMIC_V2_ALLOWED_OWNERS`, la política de dueño (§6 capa 2, `ownerMonthlyCap: 5`) | U→C |
| 9 | Verificación a USD 0 con el entorno ya configurado:<br>• `GET /health`;<br>• presencia viva del worker de IA;<br>• `provider-readiness` muestra Gamma/OpenAI/Videogen «no configurado»;<br>• un intento de reserva no-Anthropic es rechazado (harness `[KS]` o log);<br>• sin atribuir hoy = 0;<br>• `CURSIA_ALLOW_REAL_PROVIDER_RECORD` sin definir;<br>• `ANTHROPIC_API_BASE_URL` sin definir;<br>• ningún otro run activo en staging (`check-active-runs`) | C |
| 10 | Crear el curso `[SINTÉTICO]` con el dueño experimental (entrada a mano, sin subir archivos), Prebrief, Blueprint, Manifest | C (con la sesión del dueño experimental, que el Usuario inicia) |
| 11 | `estimate-preview`: `expected ≤ 1,50`, `max ≤ 5`, lista blanca exacta, `providerModes` y `videoMode` en mock | C (reporta los números) |
| 12 | **Autorización del run** con el `estimateHash`, monto 3,00 («Autorizar y generar») | **U** |
| 13 | Monitoreo de §6 capa 3 cada 5 min; aplicar §8 | C (Console: U) |
| 14 | Al terminar: `worker_off`, `FINOPS_KILL_SWITCH=true`, conciliar reservas abiertas, comparar Console y ledger (+60 min) | U→C / U (Console) |
| 15 | `qa_preview` (USD 0, SUPER_ADMIN), quality report, revisión humana de los MAJOR | C / **U** (firma de MAJOR) |
| 16 | Exportar llm-diagnostics, convertir a fixtures fuera del repo, replay offline (§9) | C |
| 17 | Restaurar staging: claves originales, `DYNAMIC_ALLOW_PROVIDER_MOCK` sin definir, `FINOPS_KILL_SWITCH` según lo que se decida, `DEPLOY_FREEZE=false`, Pages y signups como estaban, archivar el dueño experimental, revocar la clave experimental | U (secretos) / U→C (flags) |
| 18 | Informe final en `validation/phase-b-n1-<fecha>.md`: costos por ítem, llamadas, intentos, Console vs ledger, Q1–Q11, S1–S12, recomendación para el nivel 2 | C |

### Lo que necesita autorización explícita del Usuario en el chat
- Ejecutar el experimento: frase propuesta «**AUTORIZO EL EXPERIMENTO FASE B NIVEL 1 (USD 5)**». Sin esa frase no se crea ni se aprueba ningún run real.
- Aprobar el run (paso 12) con el monto exacto.
- Cualquier cambio de `.env`, flag o política en staging (pasos 6, 8, 14, 17).
- Usar el kill switch como emergencia sin consultar (si se quiere delegar en Claude).
- Cualquier `manual_retry`, regenerate o reanudación durante la ventana.
- Versionar fixtures reales en algún repo.
- Subir de nivel (§11).
- Todo lo de producción está fuera de este plan.

---

## 13. Evidencia que se entrega al cierre

- Ledger del run (SQL de solo lectura):
  - eventos por ítem y por rol de llamada;
  - actual / reserved / committed;
  - sin atribuir y no-Anthropic, ambos en 0;
  - reservas conciliadas.
- Captura o cifra del uso del workspace en la Console (Usuario), inicial y final.
- Intentos por ítem, duraciones, códigos de falla clasificados.
- Artefactos generados (texto), resultado del validador por ítem, `llmMode`.
- Quality report del `qa_preview`, `hoursReport`, `validateMbzV3`.
- Fixtures saneadas + resultado de `check-replay`.
- Tabla «estimado vs real» por tipo contra §5.2, y recalibración propuesta del estimador para el nivel 2.

## 14. Riesgos residuales conocidos

- El límite de gasto del workspace es una función del proveedor **[P]**. Si no bloquea, el tope duro pasa a ser el crédito prepago de la organización: en ese caso dejar en la organización solo ≈ USD 6–10 de saldo durante la ventana, o no ejecutar.
- El VPS, pm2 y nginx son compartidos con producción [V AU3 §J1]: un `pm2 restart` debe nombrar **solo** los procesos de staging.
- El límite de entrada de la reserva es heurístico (chars/2,5). El sobregiro esperado es de centavos y lo cubre la red de seguridad M3 [V AU3 §H1.1].
- Ventana de lease: una llamada en vuelo que vence su lease se puede repetir una vez (reservada, acotada).
- La Console de Anthropic se actualiza con retraso: la comparación S4 final se hace ≥ 60 min después de la última llamada.
- El tipo H5P de `activity` lo deciden las reglas de actividad. Si sale un tipo no calificable, Q3/Q5 lo registran, pero no se fuerza.
