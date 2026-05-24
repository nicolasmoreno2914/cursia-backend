# 02 — Decisiones técnicas

> Si una decisión importante cambia, actualizar este archivo.

---

## Formato

Cada decisión incluye: **qué se decidió**, **por qué**, **implicación**, **estado**.

---

### DT-01 — Backend separado del frontend

| Campo | Detalle |
|---|---|
| Decisión | El backend NestJS es un repo separado (`orbia-backend`), no parte del frontend |
| Razón | Separación de responsabilidades, seguridad (JWT en backend), escalabilidad independiente |
| Implicación | Frontend llama al backend con JWT; el backend valida ownership; dos deployments separados |
| Estado | ✅ Activo |

---

### DT-02 — Supabase como única base de datos en producción

| Campo | Detalle |
|---|---|
| Decisión | PostgreSQL vive en Supabase, no en el VPS de Contabo |
| Razón | Simplifica infraestructura: sin backups manuales, sin gestión de PG, HA incluido |
| Implicación | El VPS solo corre Node.js; `DB_HOST` apunta a `db.XXXX.supabase.co` |
| Estado | ✅ Activo |

---

### DT-03 — Contabo corre la API, no la DB

| Campo | Detalle |
|---|---|
| Decisión | El VPS de Contabo ejecuta solo el proceso NestJS vía PM2 |
| Razón | Separación clara; PostgreSQL en Supabase es más confiable que una instancia PG manual |
| Implicación | No instalar PostgreSQL local en el VPS; usar `DB_SSL=true` para conexión a Supabase |
| Estado | ✅ Activo |

---

### DT-04 — Google Drive para archivos pesados

| Campo | Detalle |
|---|---|
| Decisión | MBZ y snapshots >1 MB se guardan en Google Drive del usuario |
| Razón | PostgreSQL no es adecuado para BLOBs grandes; Drive es gratuito para el usuario |
| Implicación | Backend guarda solo el `file_id` y la URL de Drive en `course_versions`; `storage_provider = 'google_drive'` |
| Estado | ✅ Activo en frontend |

---

### DT-05 — YouTube se conecta solo en Cursia (no en Videogen)

| Campo | Detalle |
|---|---|
| Decisión | El OAuth de YouTube lo gestiona el backend de Cursia; Videogen nunca recibe tokens de YouTube |
| Razón | Seguridad: tokens de YouTube son del usuario de Cursia; Videogen es un servicio de generación, no de publicación |
| Implicación | Flujo: Videogen genera MP4 → devuelve URL temporal → Cursia descarga y sube a YouTube |
| Estado | ✅ Diseñado, Videogen pendiente de implementar |

---

### DT-06 — Videogen solo genera MP4 temporales (v1)

| Campo | Detalle |
|---|---|
| Decisión | En v1, Videogen usa storage local temporal; no usa R2 ni S3 |
| Razón | Simplificación del primer sprint; R2 agrega costo y complejidad que no se justifica en v1 |
| Implicación | Los MP4 tienen TTL corto; Cursia debe descargarlos pronto tras el callback |
| Estado | 📋 Diseñado, pendiente de implementar |

---

### DT-07 — SCORM usa HTML standalone

| Campo | Detalle |
|---|---|
| Decisión | Los SCORM generados son paquetes ZIP con HTML+JS sin dependencias externas |
| Razón | Compatibilidad máxima con LMS; Moodle no necesita que los assets sean externos |
| Implicación | Todos los assets (CSS, JS, imágenes base64) van inline o en el ZIP; no URLs externas en SCORM |
| Estado | ✅ Activo |

---

### DT-08 — No usar `src="#audio"` en MBZ

| Campo | Detalle |
|---|---|
| Decisión | Las páginas HTML dentro del MBZ no pueden tener `<audio src="#audio">` placeholder |
| Razón | Moodle renderiza esa etiqueta tal cual; el estudiante ve un player roto |
| Implicación | Si no hay archivo de audio real, el MBZ builder reemplaza `<audio>` con un `<div>` limpio |
| Estado | ✅ Corregido en `09-mbz.js` y `16-mbz-patch.js` |

---

### DT-09 — Audio de bienvenida: máximo 2 minutos / 220 palabras

| Campo | Detalle |
|---|---|
| Decisión | El audio de bienvenida generado con ElevenLabs tiene un límite estricto |
| Razón | Costos de API, experiencia del estudiante, convención pedagógica |
| Implicación | El script se recorta antes de enviar a ElevenLabs si supera el límite |
| Estado | ✅ Activo en `28-elevenlabs.js` |

---

### DT-10 — Audiolibro bajo confirmación explícita

| Campo | Detalle |
|---|---|
| Decisión | El audiolibro no se genera automáticamente; requiere confirmación con estimación de coste |
| Razón | Puede generar mucho texto (todos los capítulos); coste significativo en ElevenLabs |
| Implicación | UI muestra contador de caracteres y coste estimado antes de confirmar |
| Estado | ✅ Activo en `28-elevenlabs.js` |

---

### DT-11 — Guard: no generar audio sin curso/MBZ cargado

| Campo | Detalle |
|---|---|
| Decisión | Los botones de ElevenLabs quedan deshabilitados hasta que exista un curso generado o un MBZ subido |
| Razón | Evita generación de audio huérfano sin contexto; evita costos innecesarios |
| Implicación | `_elRefreshGuard()` se llama tras carga de MBZ y tras generación de curso |
| Estado | ✅ Activo |

---

### DT-12 — Dashboard admin: primero registrar eventos, luego construir UI

| Campo | Detalle |
|---|---|
| Decisión | La tabla `usage_events` se llena desde el inicio; la UI del dashboard se construye después |
| Razón | Los datos históricos son valiosos desde el día 1; la UI puede esperar |
| Implicación | `POST /api/v1/events` debe ser llamado por el frontend tras cada acción de IA |
| Estado | ✅ Endpoint activo, frontend pendiente de integrar las llamadas |

---

### DT-13 — Planes SaaS validados en backend

| Campo | Detalle |
|---|---|
| Decisión | Los límites de plan (cursos/mes, funciones premium) se validan en el backend, nunca solo en frontend |
| Razón | El frontend es manipulable; la seguridad de billing debe estar en el servidor |
| Implicación | Backend necesitará tabla `subscriptions` o integración con Stripe/Lemonsqueezy |
| Estado | 📋 Diseñado, pendiente de implementar |

---

### DT-14 — `ALLOW_UNOWNED_COURSES=false` siempre en producción

| Campo | Detalle |
|---|---|
| Decisión | La variable de entorno que permite ver cursos sin `owner_id` nunca va a `true` en producción |
| Razón | Flag de desarrollo para datos legacy pre-Fase 6; en producción causaría fuga de datos |
| Implicación | Revisar esta variable en cada deploy; está en el checklist de producción |
| Estado | ✅ Activo |

---

### DT-15 — `synchronize: false` permanente en producción

| Campo | Detalle |
|---|---|
| Decisión | TypeORM nunca altera el schema automáticamente en producción |
| Razón | `synchronize:true` puede destruir datos al agregar/quitar columnas en tablas con datos reales |
| Implicación | Todo cambio de schema requiere SQL manual en Supabase o migración TypeORM explícita |
| Estado | ✅ Activo (`synchronize` depende de `NODE_ENV === 'development'`) |

---

### DT-16 — TypeORM usa variables individuales, no `DATABASE_URL`

| Campo | Detalle |
|---|---|
| Decisión | El `DatabaseModule` usa `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASS`, `DB_NAME`, `DB_SSL` |
| Razón | Así está implementado; cambiar requería refactorizar el módulo |
| Implicación | No usar `DATABASE_URL` en el `.env` de producción aunque Supabase lo ofrezca |
| Estado | ✅ Activo |
