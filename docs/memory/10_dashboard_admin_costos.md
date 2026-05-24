# 10 — Dashboard Admin y Costos

---

## Propósito

El dashboard de admin permite a los super admins (equipo Cursia) entender el uso real de la plataforma, los costos de IA incurridos y el valor generado frente a métodos tradicionales. Es la base para tomar decisiones de pricing y detectar abusos.

**No es visible para usuarios finales** — solo para emails en `SUPER_ADMIN_EMAILS`.

---

## Acceso

- Guard: `SuperAdminGuard` — verifica que `req.user.email` esté en `SUPER_ADMIN_EMAILS`
- Variable de entorno: `SUPER_ADMIN_EMAILS=nicolas@nomaddi.com`
- Endpoint principal: `GET /api/v1/admin/dashboard/summary`

---

## Tablas involucradas

### `usage_events`
Registra cada acción cuantificable. Append-only (solo INSERT, nunca UPDATE/DELETE).

Campos clave:
- `user_id`, `user_email` — quién lo hizo
- `event_type` — qué tipo de acción (ver lista abajo)
- `tokens_input`, `tokens_output`, `ai_model`, `ai_provider` — para calcular costo IA
- `estimated_cost_usd` — costo calculado en el momento
- `failed`, `error_message` — para detectar fallos
- `course_id`, `video_job_id`, `video_batch_id` — trazabilidad

Tipos de evento definidos:
```
ia_generate_syllabus | ia_generate_chapter | ia_generate_quiz
ia_generate_summary  | ia_generate_full_course
video_job_requested  | video_job_completed  | video_job_failed
youtube_connect      | youtube_upload_requested | youtube_upload_completed
export_mbz | export_scorm | export_pdf
course_created | course_published
cloud_save | auth_signin
```

### `cost_rates`
Tabla de precios viva. Para cada `(provider, service, model, unit_type)` define `rate_usd`.

Actualizar precios = solo cambiar filas aquí, sin tocar código.

Ejemplo:
```
anthropic | chat_completion | claude-sonnet-4-5 | per_1k_input_tokens | 0.003
anthropic | chat_completion | claude-sonnet-4-5 | per_1k_output_tokens | 0.015
```

### `traditional_cost_benchmarks`
Costo de crear el mismo contenido con métodos tradicionales.

Ejemplo:
```
course_creation | Creación de curso completo | $2500 USD | por curso
video_production_minute | Producción de video | $150 USD | por minuto
```

---

## KPIs del dashboard

| KPI | Cómo se calcula |
|---|---|
| Cursos creados | COUNT eventos `course_created` por período |
| Costo total IA | SUM `estimated_cost_usd` en `usage_events` |
| Costo por curso | `costo_total / cursos_creados` |
| Ahorro estimado | SUM (benchmark × cantidad) - costo_cursia |
| Usuarios activos | COUNT DISTINCT `user_id` en período |
| Eventos por tipo | GROUP BY `event_type` |
| Tasa de error | `COUNT(failed=true) / COUNT(*)` |

---

## Fases del Admin Dashboard

| Fase | Estado | Descripción |
|---|---|---|
| D0 | ✅ Implementado | Infraestructura: tablas, endpoints, SuperAdminGuard, seed data |
| D1 | 📋 Pendiente | UI básica: tabla de eventos recientes, totales |
| D2 | 📋 Pendiente | Gráficas de uso por usuario y por tipo |
| D3 | 📋 Pendiente | Cálculo de ahorro vs. métodos tradicionales |
| D4 | 📋 Pendiente | Alertas de costos por usuario |
| D5–D8 | 🔮 Futuro | Billing, planes, invoicing |

---

## Cómo registrar eventos desde el frontend

El frontend debe llamar a `POST /api/v1/events` con JWT tras cada acción:

```js
// Ejemplo: tras generar un curso completo
await fetch(`${BACKEND_URL}/api/v1/events`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${supabaseToken}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    eventType: 'ia_generate_full_course',
    tokensInput: 45000,
    tokensOutput: 12000,
    aiModel: 'claude-sonnet-4-5',
    aiProvider: 'anthropic',
    estimatedCostUsd: 0.315,
    courseId: 42,
    durationMs: 95000
  })
})
```

**Regla**: los eventos de uso se registran solo si el backend está activo. Si no, se pierden — esto es aceptable en v1 mientras el backend se estabiliza.

---

## Regla operativa

> **Primero registrar eventos, luego construir UI.**
>
> La tabla `usage_events` debe llenarse desde el día 1. Los datos históricos son valiosos para pricing y análisis. La UI del dashboard puede esperar a la Fase D1.
