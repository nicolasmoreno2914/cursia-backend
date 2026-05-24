# 12 — Pendientes y riesgos

> Actualizar este archivo cuando una tarea se completa o cambia de prioridad.
> Última actualización: Mayo 2026

---

## Deploy backend

| Tarea | Prioridad | Estado | Riesgo si no se hace | Próxima acción |
|---|---|---|---|---|
| Ejecutar SCHEMA_SUPABASE.sql v1.1 en Supabase | 🔴 Alta | ⏳ Pendiente | Backend no arranca | Abrir SQL Editor en Supabase y ejecutar el archivo |
| Configurar VPS `167.86.98.162` (usuario, firewall, Node 22, PM2) | 🔴 Alta | ⏳ Pendiente | Backend no tiene dónde correr | `ssh root@167.86.98.162` → ejecutar pasos del doc 09 |
| Crear DNS `api.cursia → 167.86.98.162` | 🔴 Alta | ⏳ Pendiente | Dominio no resuelve | Panel DNS de Cloudflare/Namecheap |
| Crear `.env` en VPS con valores reales | 🔴 Alta | ⏳ Pendiente | Backend arranca sin config | Seguir `.env.production.template` |
| Certbot SSL para `api.cursia.nomaddi.com` | 🔴 Alta | ⏳ Pendiente | Sin HTTPS, browser bloquea | Después del DNS propagado |
| Validar endpoints en producción | 🔴 Alta | ⏳ Pendiente | No sabemos si funciona | Checklist sección 18 del doc de deploy |
| Configurar GitHub Actions secrets | 🟡 Media | ⏳ Pendiente | Sin CI/CD automático | Después de deploy manual exitoso |

---

## Supabase DB

| Tarea | Prioridad | Estado | Riesgo | Próxima acción |
|---|---|---|---|---|
| Confirmar 6 tablas creadas (query verificación) | 🔴 Alta | ⏳ Pendiente | Backend crashea al arrancar | Ejecutar query de verificación del SQL |
| Activar RLS (Row Level Security) | 🟡 Media | 📋 Diseñado | Sin RLS, usuarios podrían ver datos ajenos via Supabase directo | Agregar policies en Supabase después del primer deploy |
| Backup antes de cambios de schema | 🟡 Media | Continuo | Pérdida de datos | Hacer pg_dump antes de ALTER TABLE |

---

## Frontend

| Tarea | Prioridad | Estado | Riesgo | Próxima acción |
|---|---|---|---|---|
| Integrar `POST /api/v1/events` tras generación de curso | 🟡 Media | ⏳ Pendiente | Sin datos de uso en dashboard | Agregar llamada en `02-run.js` tras completar generación |
| Activar backend en producción para Cloud Save | 🟡 Media | ⏳ Pendiente (depende de backend) | Cloud Save no funciona | Configurar `ORBIA_BACKEND_URL` tras deploy |
| Confirmar Google Drive OAuth en producción | 🟡 Media | 🔄 Por validar | Drive no funciona si redirect URI cambió | Probar OAuth completo en producción |

---

## SCORM

| Tarea | Prioridad | Estado | Riesgo | Próxima acción |
|---|---|---|---|---|
| QA completo de mecánicas en Moodle real | 🟡 Media | Continuo | Regresión silenciosa | Correr checklist de 05_scorm.md tras cada cambio |
| Documentar mecánicas nuevas si se agregan | 🟢 Baja | Continuo | Inconsistencia con 05_scorm.md | Actualizar archivo 05 |

---

## MBZ / Moodle

| Tarea | Prioridad | Estado | Riesgo | Próxima acción |
|---|---|---|---|---|
| Validar que `src="#audio"` no aparece en ningún export | 🟡 Media | ✅ Fix aplicado | Moodle muestra player roto | Probar export con y sin audio |
| Verificar completion coherente en quizzes | 🟡 Media | 🔄 Por validar | Estudiantes no pueden completar el curso | Test en Moodle real |

---

## Audio / ElevenLabs

| Tarea | Prioridad | Estado | Riesgo | Próxima acción |
|---|---|---|---|---|
| Validar persistencia IDB tras reload | 🟡 Media | ✅ Implementado | Audio desaparece al recargar | Probar: generar → recargar → verificar player |
| Límite 220 palabras bienvenida | 🟡 Media | ✅ Implementado | Costo excesivo | Verificar que recorte funciona |
| Confirmación antes de audiolibro | 🟡 Media | ✅ Implementado | Usuario genera sin querer | Probar flujo de confirmación |

---

## Google Drive

| Tarea | Prioridad | Estado | Riesgo | Próxima acción |
|---|---|---|---|---|
| Confirmar OAuth `drive.file` en producción | 🟡 Media | 🔄 Por validar | Drive no funciona | Probar subida real de MBZ |
| Validar que `file_id` se guarda en backend | 🟢 Baja | 🔄 Por validar | No se puede restaurar desde Drive | Revisar `course_versions.storage_file_id` |

---

## YouTube

| Tarea | Prioridad | Estado | Riesgo | Próxima acción |
|---|---|---|---|---|
| Validar OAuth callback en producción | 🔴 Alta | ⏳ Pendiente (depende de backend) | YouTube no se puede conectar | Configurar Google Cloud Console + probar flujo completo |
| Agregar URI producción en Google Cloud Console | 🔴 Alta | ⏳ Pendiente | `redirect_uri_mismatch` | Agregar `https://api.cursia.nomaddi.com/api/v1/youtube/oauth/callback` |

---

## Videogen

| Tarea | Prioridad | Estado | Riesgo | Próxima acción |
|---|---|---|---|---|
| Definir contrato de API con Videogen | 🟢 Baja | 📋 Diseñado | Sin integración | Cuando Videogen esté disponible |
| Implementar `video_jobs` en backend | 🟢 Baja | 📋 Diseñado | Sin orquestación de videos | Después de YouTube validado |
| Implementar callback HMAC en backend | 🟢 Baja | 📋 Diseñado | Sin recepción de resultados | Junto con video_jobs |

---

## Dashboard Admin

| Tarea | Prioridad | Estado | Riesgo | Próxima acción |
|---|---|---|---|---|
| D1: UI básica de eventos y totales | 🟡 Media | 📋 Pendiente | Sin visibilidad de uso | Después de backend en producción |
| Integrar llamadas a `POST /events` en frontend | 🟡 Media | ⏳ Pendiente | Sin datos históricos | Agregar en `02-run.js`, `09-mbz.js` |
| D2: Gráficas de uso | 🟢 Baja | 📋 Diseñado | Solo afecta visibilidad interna | Después de D1 |

---

## Modelo de negocio / SaaS

| Tarea | Prioridad | Estado | Riesgo | Próxima acción |
|---|---|---|---|---|
| Primer cliente de Sprint pagado | 🔴 Alta | ⏳ Pendiente | Sin validación comercial | Agendar diagnóstico gratuito |
| Caso de éxito documentado | 🔴 Alta | ⏳ Pendiente | Sin prueba social para vender | Documentar el primer sprint |
| Planes SaaS con límites en backend | 🟢 Baja | 📋 Diseñado | Sin monetización recurrente | Después de 3+ clientes validados |

---

## Sitio web comercial

| Tarea | Prioridad | Estado | Riesgo | Próxima acción |
|---|---|---|---|---|
| Landing page de Cursia | 🟡 Media | ⏳ Pendiente | Sin presencia pública para vender | Definir propuesta y crear con Claude |

---

## QA general

| Tarea | Prioridad | Estado | Riesgo | Próxima acción |
|---|---|---|---|---|
| Test end-to-end: brief → MBZ → Moodle | 🔴 Alta | 🔄 Continuo | Regresiones no detectadas | Correr tras cada cambio grande |
| Test Cloud Save → Restore | 🟡 Media | ⏳ Pendiente (depende de backend) | Pérdida de trabajo del usuario | Probar tras deploy |
