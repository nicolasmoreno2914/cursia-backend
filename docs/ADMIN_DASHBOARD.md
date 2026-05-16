# Admin Dashboard Interno — Cursia Backend (Fase D0)

## Resumen

El Admin Dashboard Interno es un sistema de analítica y monitoreo de costes accesible
solo a super-admins. Mide cuánto usa el sistema, cuánto cuesta en APIs externas, y
cuánto ahorra Cursia en comparación con métodos tradicionales de producción de contenido.

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
- `from` — ISO 8601, default: hace 30 días
- `to` — ISO 8601, default: ahora

**Respuesta 200:**
```json
{
  "period": {
    "from": "2025-01-01T00:00:00.000Z",
    "to": "2025-01-31T23:59:59.000Z"
  },
  "events": {
    "total": 342,
    "failed": 7
  },
  "courses": {
    "created": 12
  },
  "tokens": {
    "input_total": 1850000,
    "output_total": 420000,
    "estimated_cost_usd": 8.25
  },
  "videos": {
    "requested": 48,
    "generated": 45,
    "uploaded_youtube": 38,
    "failed": 3,
    "estimated_cost_usd": 22.50
  },
  "exports": {
    "mbz_total": 9
  },
  "total_estimated_cost_usd": 30.75,
  "traditional_equivalent_usd": 31350.00,
  "savings_usd": 31319.25,
  "failures": {
    "total": 7
  }
}
```

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

## Fórmula de ahorro

```
savings = traditional_equivalent - total_cursia_cost

traditional_equivalent = Σ(benchmark.typical_cost_usd × quantity_produced)

Benchmarks base (D0):
  course_creation  → $2,500 USD / curso
  video_production → $300 USD  / video
  export_mbz       → $150 USD  / exportación
```

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
