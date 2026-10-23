# LOOP 7 — Informe: ¿Cursia está lista para la validación real?

Fecha: 2026-10-06. Todo con USD 0: sin proveedores reales, sin cursos reales, sin cambios en producción ni merge a
`main`. Base: auditorías A1–A5 (`scratchpad r26/audit/`), revisiones independientes REVIEW-L7-1/2 (0 críticos, 0
importantes al cierre), E2E E11 de punta a punta y gate final (resultado al pie).

## 1. ¿Cursia está técnicamente lista para una validación real?

**Sí, en staging, con un curso piloto y un dueño interno**, siguiendo el procedimiento del punto 5.

El flujo completo funciona como **un solo sistema** (E11, un único curso, solo mocks):

microcurrículo → contexto académico → enfoque → 64 h → «Cursia recomienda» → Ver diseño → Ajustar → Aplicar →
Blueprint → Manifest → Actividades de Aplicación → coherencia → costo simulado → generación → empaque →
impacto de un cambio → regeneración parcial → re-empaque → restauración en Moodle con estudiante y docente reales.

Lo que E11 demuestra, no solo afirma:
- La tarjeta «Cursia recomienda» = lo que se congela. Coinciden capítulos, videos, Actividades de Aplicación, evaluaciones, horas y costo. Una guarda bloquea «Aplicar» si alguna vez difieren.
- «Ajustar» produce un diseño nuevo, y aplicar el diseño anterior da 409.
- El impacto previsto de un cambio = el plan real de regeneración: mismos items, mismo costo. La regeneración solo llama a la IA para lo que cambió.
- En Moodle real, el estudiante ve su Actividad de Aplicación y **nunca** el solucionario. Tampoco puede abrirlo, ni su PDF, si el docente lo muestra por error. El docente sí lo ve.

Lo que el LOOP 7 corrigió para llegar aquí:
- **Seguridad:** acceso a archivos ajenos en la API de artifacts. También está en `main`: ver punto 4.
- **Distribuidor:** las prácticas perdían su actividad al rediseñar.
- **Diseño:** una sola fuente de reglas de actividad entre vista previa y congelado. Una sola composición del lock.
- **Costos:**
  - el costo de los cambios estaba subestimado (~×3);
  - los estimados ahora son aproximados, con rango, desglose y supuestos;
  - el modal «Generar solo lo que cambió» ahora muestra el costo.
- **Moodle:** el solucionario estaba protegido solo por estar oculto. Ahora el estudiante tiene el permiso prohibido.
- **Prompt:** la Actividad de Aplicación recibía dos listas de resultados que podían contradecirse.

## 2. ¿Qué podría fallar cuando usemos proveedores reales?

Lo validado con mocks es la **orquestación**: estructura, dependencias, empaque, Moodle y costos. Lo que solo un proveedor real puede probar:

1. **Calidad y forma de las respuestas del LLM.** El LLM falso responde con la forma esperada. Uno real puede:
   - devolver JSON inválido o cortado (la Actividad de Aplicación y su solucionario son los más largos);
   - fallar los validadores (pesos ≠ 100, minutos fuera de ±tolerancia, marcas del solucionario en la página del estudiante);
   - quedarse corto en el banco de exámenes.

   Hay reintentos dirigidos y validación fuerte. Si siguen fallando, el item **falla visible**, no se sube a medias. Esto suma reintentos (costo) y tiempo.
2. **La generación de texto corre en el navegador del docente.** La pestaña tiene que quedar abierta; un corte la pausa y se reanuda. El costo del texto se registra pero no se corta: el tope duro aplica a video, Gamma y audio.
3. **Modelo.** El selector arranca en Haiku 4.5 y los estimados suponen Sonnet 4.6. Con Haiku cuesta menos, pero no está validada la calidad pedagógica con ese modelo. Para la validación conviene fijar Sonnet 4.6 en el selector.
4. **Videogen y YouTube.** Faltan por medir:
   - el tiempo de render real;
   - el cupo diario de subidas de YouTube (un curso de 64 h trae 18–25 videos);
   - errores de publicación.

   La entrega y los reintentos están probados con fakes, no contra los límites reales.
5. **Gamma.** La tarifa del seed es provisional (placeholder): lo medido una vez fue menor. Falta confirmar que respeta `es-419` y que las 10 tarjetas renderizan bien.
6. **TTS.** La tarifa no está verificada y la duración del audiolibro depende del largo real de cada capítulo.
7. **Moodle del cliente.** La restauración se validó en Moodle 4.5 local. Riesgos:
   - otra versión de Moodle, o librerías H5P distintas en el sitio;
   - restaurar por CLI: no aplica el permiso prohibido del solucionario, que queda solo oculto. Hay que restaurar desde la web, como admin o docente.
8. **Precios de los estimados.** Los estimados usan tarifas de referencia y uso típico, no medido. La primera generación real debe usarse para recalibrar con el ledger FinOps.

## 3. ¿Qué puede generar gasto y cuánto aproximadamente?

Solo **generar**, **regenerar** o **reintentar** con proveedores reales. Las vistas previas, el contexto académico, la coherencia, el impacto de cambios y el estimador son USD 0, sin llamadas de red (verificado con netguard).

Curso piloto: microcurrículo de 64 h, diseño real del distribuidor:

| Diseño | Capítulos (con video) | Act. de Aplicación | Esperado | Rango |
|---|---|---|---|---|
| Aplicación primero (competencias / ABP) | 23 (18) | 23 | **≈ USD 64** | USD 41–157 |
| Profundidad primero (significativo, o «Ajustar» → profundidad) | 26 (25) | 26 | **≈ USD 84** | USD 55–204 |

Desglose del primer diseño:
- **Audiovisual:** ≈ USD 39. Videogen 19, Gamma 12 (tarifa provisional) y TTS 5.
- **Actividades de Aplicación:** ≈ USD 6.
- **Texto con IA:** ≈ USD 19.

El máximo supone reintentos en todo, por eso el rango es amplio.

Cambios típicos sobre un curso ya generado (solo lo que se ejecutaría):
- **Editar un capítulo:** ≈ USD 6–7. Regenera ese capítulo, las prácticas de su módulo y los exámenes que lo cubren. El video y la presentación pagados quedan marcados, no se regeneran solos.
- **Cambiar el enfoque pedagógico:** ≈ USD 25 de texto. Regenerar además lo pagado marcado costaría ≈ USD 40, solo si se confirma.
- **Pasar de 64 h a 48 h:** ≈ USD 3, porque solo se rehacen las Actividades de Aplicación.

Lo pagado (video, Gamma, audio) **nunca** se regenera solo: exige `confirmPaid` y aprobación de presupuesto.

## 4. ¿Qué necesitamos resolver antes de producción?

Detalle completo, con migraciones, orden, `.env`, flags, backup, rollback y smoke: `docs/superpowers/audits/2026-10-06-loop7-preparacion-produccion.md`.

1. **Seguridad en `main` (urgente, independiente del release).** `POST /artifacts` permite registrar la ruta de otro usuario y luego descargar o borrar su archivo. El arreglo de staging (`4a2a866` + `e13edcf`) es pequeño y aislado: conviene un hotfix a `main` con tu aprobación.
2. **Release curado** (opción B). `main` está 562/499 commits detrás. Hay que repetir el *closure* DN-7, excluir course-setup y los rediseños fuera de V2, e incluir el hardening del LOOP 7.
3. **Migraciones P1–P4** en el plan de producción. P2 y P3 son inseparables. Además: sus verificaciones en modo solo lectura, los tests de PG16 local y un nuevo `Plan sha256`.
4. **Política de presupuesto de producción.** Sin ella, todo run responde 409. Propuesta para la validación: por run USD 100, por curso USD 130, mensual USD 200.
5. **`.env` de producción** con todas las variables V2, todo apagado por defecto. Incluye `FINOPS_INGEST_TOKEN` como secreto, `ALLOW_UNOWNED_COURSES=false` y admins con email verificado.
6. **Decisiones tuyas:**
   - alcance: lanzamiento conjunto, o construir interruptores por funcionalidad, que hoy no existen;
   - qué pasa con course-setup;
   - backup / PITR;
   - merges a `main`;
   - encender V2 para un owner interno.
7. **Deuda conocida (no bloquea):**
   - reglas del capítulo de práctica repartidas en muchos archivos (R30);
   - «aplicar propuesta» en 3 formas, cubiertas por pruebas (R29);
   - el estimado del panel usa el seed y la aprobación usa el catálogo (R31);
   - la regeneración con pagos nuevos requiere un admin (R32).

## 5. Procedimiento exacto para la primera generación real (en staging)

**Preparación (sin gasto):**
1. Elegir el microcurrículo piloto: idealmente el del primer cliente, en PDF con texto o DOCX. Elegir también el Moodle donde se restaurará y su versión.
2. Fijar la política de presupuesto de staging para el piloto: por run USD 100, por curso USD 130. La de staging hoy es USD 15 por run y obliga a una aprobación de admin; puede dejarse así y aprobar a mano. Registrar el `estimateId` aprobado.
3. Fijar el modelo de texto en Sonnet 4.6 (selector «Modelo IA»), coherente con el estimado.
4. Confirmar en staging:
   - el canal de YouTube conectado (preflight OK);
   - las variables de proveedores reales del owner piloto (`DYNAMIC_REAL_VIDEO_OWNERS`, `DYNAMIC_PROVIDER_WORKER_ENABLED`);
   - el saldo de Gamma, Videogen, OpenAI y Anthropic.

**Diseño (USD 0):**
5. Crear el curso → Contexto académico → subir el microcurrículo → revisar encontrado / inferido / faltante → Guardar → «Usar en el perfil».
6. Elegir el enfoque, confirmar las horas → «Cursia recomienda» → Ver diseño → Ajustar si hace falta → **anotar el costo estimado y su rango** → Aplicar diseño.
7. Revisar la estructura y los vínculos a resultados → «Verificar coherencia»: 0 críticos.
8. Confirmar la estructura (Blueprint) → ver el plan de generación (Manifest) y el costo del run.

**Generación (gasto real):**
9. Iniciar la generación con video real y Gamma/TTS reales. Aprobar el presupuesto (admin) por el monto mostrado. Dejar la pestaña abierta hasta que el texto termine.
10. Vigilar el ledger FinOps (gasto real frente al estimado), los items fallidos (se reintentan; si fallan, se ven) y los videos publicados.
11. Empaquetar → descargar el `.mbz`.

**Verificación en Moodle:**
12. Restaurar desde la **web**, como admin o docente con edición; no por CLI. Matricular un estudiante de prueba y verificar:
    - la secuencia de capítulos, las prácticas y las Actividades de Aplicación con su PDF;
    - que el estudiante **no** ve el solucionario;
    - mostrar el solucionario un instante como docente: el estudiante sigue sin poder abrirlo;
    - las evaluaciones, la nota y el certificado.

**Regeneración parcial (gasto chico):**
13. Editar un capítulo → «Impacto de los cambios» (anotar el costo) → confirmar la estructura → «Generar solo lo que cambió». Verificar que el costo del modal es el mismo y que solo se regenera lo previsto.

**Cierre:**
14. Comparar el gasto real con el estimado por proveedor y recalibrar priors y tarifas: Gamma provisional, TTS no verificado, Videogen observado. Con eso se ajustan la política de presupuesto de producción y el plan de promoción.

---

## Resultado del gate final

Gate L7G sobre `chore/loop7-hardening`: **4685 / 4686 aserciones**. La única falla es `check-deploy-dynamic-workers`
(a), que hace `git fetch` y la copia del gate no tiene `.git`: en el repo pasa 28/0, igual que en los gates de
las Fases 3–5.

- E2E v2 + v3: 0 fallas, incluido **E11, el flujo completo**, más su restauración en Moodle (E11 y E11-regen): 157 aserciones.
- QA de navegador: 0 fallas.
- Regresión: backend 87/88 scripts (2407 aserciones), frontend 67/67 harnesses (825).

Revisiones independientes: REVIEW-L7-1 (0 críticos / 4 importantes / 7 menores) → corregidos → REVIEW-L7-2 (0 / 0 / 1 menor).
El gate encontró y se corrigió además una regresión propia: el registro QA interno del backend, `bc0aa3d`.
