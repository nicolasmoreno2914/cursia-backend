# Admin Dashboard Interno — Cursia Backend (Fase D0)

## Resumen

El Admin Dashboard Interno es un sistema de analítica y monitoreo de costes accesible
solo a super-admins. Mide cuánto usa el sistema y cuánto cuesta en APIs externas.

> **FinOps P0 (2026-10-16):** todo el dinero sale del ledger V2
> (`generation_cost_events` → `CostReadService` → API → Dashboard), con definiciones
> fijas (`finops-read-v1`, cabecera de `src/modules/finops/cost-read.service.ts`).
> `usage_events` queda solo para contar actividad no financiera; sus columnas de costo
> (y las que manda `POST /events`) nunca son dinero. Se eliminaron
> `total_estimated_cost_usd`, `tokens.estimated_cost_usd`, `videos.estimated_cost_usd`,
> `costs`, `costByProvider`, `courseCostSummary`, `traditional_equivalent_usd` y
> `savings_usd` (el «ahorro» era un número contra un costo fijo, no dinero).

---

## Arquitectura D0

### Tablas nuevas

| Tabla | Propósito |
|-------|-----------|
| `usage_events` | Registro inmutable de cada acción cuantificable (IA, video, export, etc.) |
| `cost_rates` | Tarifas vivas por proveedor/servicio/modelo. Actualizar precios = solo cambiar filas |
| `traditional_cost_benchmarks` | Coste de referencia por método tradicional (freelancer, agencia) |

### Módulos nuevos

| Módulo | Archivo | Descripción |
|--------|---------|-------------|
| `EventsModule` | `src/events/` | `POST /api/v1/events` — recibe eventos del frontend |
| `AdminModule` | `src/admin/` | `GET /api/v1/admin/dashboard/summary` — resumen de métricas |

### Guards nuevos

| Guard | Archivo | Descripción |
|-------|---------|-------------|
| `SuperAdminGuard` | `src/auth/super-admin.guard.ts` | Verifica email en `SUPER_ADMIN_EMAILS` env var |

---

## Variables de entorno

```bash
# Admin Dashboard (D0)
# Emails con acceso al panel de administración, separados por coma.
# Case-insensitive. NUNCA commitear valores reales.
SUPER_ADMIN_EMAILS=admin@cursia.com,nicolas@cursia.com
```

---

## Endpoints

### POST /api/v1/events

Registra un evento de uso. **Fire-and-forget** — el cliente nunca debe bloquear
la generación esperando la respuesta de este endpoint.

**Auth:** SupabaseJwtGuard (requiere usuario autenticado)

**Body:**
```json
{
  "event_type": "ia_generate_chapter",  // requerido
  "failed": false,                       // opcional
  "error_message": null,                 // opcional
  "tokens_input": 1200,                  // opcional — para calcular coste
  "tokens_output": 3400,                 // opcional — para calcular coste
  "ai_model": "claude-3-5-sonnet-20241022", // opcional
  "ai_provider": "anthropic",            // opcional
  "video_job_id": null,                  // opcional
  "video_batch_id": null,                // opcional
  "video_count": null,                   // opcional
  "course_id": 42,                       // opcional
  "duration_ms": 4200,                   // opcional
  "metadata": {}                         // opcional — JSON libre
}
```

**Respuesta 200:**
```json
{ "ok": true, "id": "uuid-del-evento" }
```

> ⚠️ El `user_id` se extrae **siempre** del JWT. Nunca del body.

---

### GET /api/v1/admin/dashboard/summary

Retorna métricas agregadas del período indicado.

**Auth:** SupabaseJwtGuard + SuperAdminGuard (email en `SUPER_ADMIN_EMAILS`)

**Query params:**
- `from` — instante ISO 8601 (UTC), default: hace 30 días
- `to` — instante ISO 8601 (UTC), default: ahora
- Período `[from, to)` sobre la fecha efectiva del evento (un ajuste hereda la fecha de su cargo). Fechas inválidas o `from > to` → `400`.

**Respuesta 200 (resumida; montos = strings decimales de 10 decimales en USD, nunca números JS):**
```json
{
  "period": { "from": "2026-10-01T00:00:00.000Z", "to": "2026-11-01T00:00:00.000Z" },
  "money": {
    "status": "ok",                 // "ok" | "no_data" (sin eventos: montos null) | "unavailable" (base sin ledger)
    "completeness": "partial",      // "complete" | "partial" (hay llamadas sin precio) | null (unavailable)
    "definitions": "finops-read-v1",
    "currency": "USD",
    "actual": "51.8713810500",      // Real: todo lo que no es pendiente abierto
    "reserved": "0.0522500000",     // Reservado (aún no gastado): pendientes abiertos
    "committed": "51.9236310500",   // Comprometido = actual + reserved (neto del ledger)
    "estimated": { "expected": "57.5000000000", "runs": 2 },              // planeación, nunca gasto
    "authorized": { "amount": "60.0000000000", "runsWithCap": 2, "runsWithoutCap": 0 },
    "byok": { "actual": "9.0000000000", "reserved": "0.0000000000", "committed": "9.0000000000", "providerCalls": 1 },
    "retries": { "calls": 1, "actual": "0.0410000000", "committed": "0.0410000000" },
    "counts": { "events": 23, "providerCalls": 11, "retries": 1, "failedCalls": 1, "openReservations": 1, "openPending": 1, "unpriced": 1, "...": 0 },
    "unpriced": { "count": 1, "events": [{ "idempotencyKey": "anthropic:msg:…", "reason": "pricing_missing", "provider": "anthropic", "model": "…", "courseId": 1353, "runId": "…", "itemKey": "…", "billingAccount": "cursia" }] },
    "byProvider": [{ "key": "anthropic", "actual": "…", "reserved": "…", "committed": "…", "providerCalls": 9, "events": 15, "sharePct": "97.6" }],
    "byItemType": [], "byOperation": [],
    "perCourse": { "courses": 1, "excluded": 0, "average": "51.9236310500", "min": "…", "max": "…" },
    "unattributed": { "committed": "0.0010000000", "byReason": [{ "reason": "no_attribution_declared", "committed": "0.0010000000", "events": 1 }], "...": "mismo formato" },
    "tokens": { "input": 18100, "output": 2700, "cacheWrite": 0, "cacheRead": 0 }
  },
  "courseCosts": [{ "courseId": "1353", "frontendCourseId": "fe-1353", "courseName": "…", "status": "published", "money": { "...": "mismo formato, montos SOLO del período" }, "lastUpdatedAt": "…", "eventsCount": 23 }],
  "events": { "total": 342, "failed": 7 },
  "courses": { "created": 12 },
  "tokens": { "input_total": 18100, "output_total": 2700 },
  "videos": { "requested": 48, "generated": 45, "uploaded_youtube": 38, "failed": 3 },
  "audio": { "welcome_generated": 3, "audiobooks_generated": 2 },
  "production": { "completed": 4 },
  "exports": { "mbz_total": 9 },
  "failures": { "total": 7 },
  "productionTrend": [{ "date": "2026-10-14", "count": 1 }]
}
```

Reglas que el FE debe respetar:
- **Sin precio / `completeness: "partial"`:** el alcance incluye llamadas cuyo gasto real NO está en los montos (precio faltante en `pricing_catalog`, o uso que no se pudo medir, p.ej. un TTS no-mp3). Se muestra «Incluye N llamadas sin precio (costo real incompleto)». Nunca se infla `actual` con una cota. Se re-precia manualmente (`repricePendingCharge`, solo `pricing_missing`).
- **`perCourse`:** promedio/mín./máx. solo sobre cursos con gasto de Cursia > 0 en el período; los cursos solo BYOK, solo mock o con todo a 0 quedan fuera de las estadísticas (`excluded`) pero siguen en `courseCosts`.
- **«Sin datos» ≠ «USD 0,00»:** `status: "no_data"`/`"unavailable"` → montos null.

### GET /api/v1/courses/:id/cost

Costo de UN curso (todas sus corridas + desglose `money.runs[]`), mismo formato y
definiciones que `money` arriba, verificando que el curso sea del usuario (404 si no).
Para el dueño se omiten `runs[].byItemKey` y el detalle de `unpriced.events` (queda el
conteo y `completeness`); SUPER_ADMIN ve todo vía `/finops/courses/:id/costs` (`money`).

**Errores:**
- `401 Unauthorized` — sin token o token expirado
- `403 Forbidden` — usuario autenticado pero no es super-admin

---

## Tipos de evento (`event_type`)

| Evento | Cuándo emitirlo |
|--------|----------------|
| `ia_generate_syllabus` | Al generar un temario con IA |
| `ia_generate_chapter` | Al generar un capítulo con IA |
| `ia_generate_quiz` | Al generar un quiz con IA |
| `ia_generate_summary` | Al generar un resumen con IA |
| `ia_generate_full_course` | Al generar un curso completo |
| `video_job_requested` | Al crear un job de video |
| `video_job_completed` | Al recibir video listo |
| `video_job_failed` | Al fallar un job de video |
| `video_batch_requested` | Al crear un batch de videos |
| `youtube_connect` | Al conectar canal YouTube |
| `youtube_disconnect` | Al desconectar canal YouTube |
| `youtube_upload_requested` | Al iniciar subida a YouTube |
| `youtube_upload_completed` | Al confirmar subida exitosa |
| `youtube_upload_failed` | Al fallar subida a YouTube |
| `export_mbz` | Al exportar archivo MBZ (Moodle) |
| `export_scorm` | Al exportar SCORM |
| `export_pdf` | Al exportar PDF |
| `course_created` | Al crear un curso |
| `course_published` | Al publicar un curso |
| `cloud_save` | Al guardar en la nube (Drive) |
| `auth_signin` | Al iniciar sesión |

---

## Ahorro (eliminado)

El «ahorro vs. producción tradicional» se quitó en FinOps P0: no era dinero real
(costo fijo de referencia menos un estimado). `traditional_cost_benchmarks` sigue
existiendo pero ningún endpoint de dinero lo usa.

---

## Seed idempotente

El seed corre automáticamente en cada arranque del backend (`onModuleInit`).
Verifica existencia antes de insertar — nunca duplica.

Para re-sembrar en desarrollo:
```sql
TRUNCATE cost_rates RESTART IDENTITY CASCADE;
TRUNCATE traditional_cost_benchmarks RESTART IDENTITY CASCADE;
```

---

## Fases futuras (D1–D8)

| Fase | Descripción |
|------|-------------|
| D1 | Integración en frontend: emitir eventos reales desde generación IA |
| D2 | Panel Admin UI básico (tabla de eventos) |
| D3 | Gráficos de uso por período |
| D4 | Desglose por usuario |
| D5 | Exportación de reportes (CSV/PDF) |
| D6 | Alertas por umbral de coste |
| D7 | Forecasting basado en tendencia |
| D8 | Migración SuperAdmin a tabla DB (roles) |

---

*Implementado en D0 — rama `feature/admin-dashboard-d0`*
