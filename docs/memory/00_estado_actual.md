# 00 — Estado actual del proyecto Cursia

> **Antes de trabajar en Cursia, leer este archivo primero.**
> Actualizar este archivo cada vez que una fase termina o el estado cambia.
> Fecha de última actualización: Mayo 2026 — QA producción completado

---

## Qué es Cursia

Cursia es una plataforma SaaS/EdTech con IA que permite crear cursos virtuales completos para Moodle (formato MBZ), incluyendo estructura, libro guía, SCORM interactivos, quizzes, audio de bienvenida y audiolibro, todo a partir de un brief inicial.

El usuario final es un docente, empresa o institución que necesita transformar contenido educativo en cursos Moodle de calidad, en días en lugar de meses.

---

## Estado por componente — Mayo 2026

### Frontend (campuscloud-gen)
- **Estado: ✅ Funcional en producción** — `https://cursia.nomaddi.com`
- Generación de cursos con IA (Claude): ✅ activo
- Generación de libro guía: ✅ activo
- Exportación MBZ para Moodle: ✅ activo
- SCORM interactivos (10+ mecánicas): ✅ activo
- Quizzes Moodle: ✅ activo
- Audio de bienvenida (ElevenLabs): ✅ implementado, guard activo
- Audiolibro (ElevenLabs, por capítulos): ✅ implementado, bajo confirmación
- Cloud Save (guardar en Supabase/backend): ✅ funciona cuando backend está activo
- Google Drive (archivos pesados): ✅ funcional
- YouTube UI (conectar canal): ✅ funcional cuando backend activo
- Admin sidebar: ✅ con ícono SVG
- Feature flags: backend desactivado por defecto en producción, activable por `localStorage`

### Backend (cursia-backend)
- **Estado: ✅ EN PRODUCCIÓN + QA VALIDADO** — `https://api.cursia.nomaddi.com`
- Repo: `orbia-backend` / rama: `main`
- PM2: ✅ `cursia-backend` online — `167.86.98.162:3000` — 0 restarts, ~110MB RAM
- Nginx: ✅ reverse proxy activo — syntax OK
- SSL: ✅ Let's Encrypt — expira 2026-08-22, auto-renewal habilitado
- Supabase DB: ✅ conectada — seeds corrieron (11 cost_rates, 7 benchmarks)
- Auth: ✅ ES256/JWKS (SUPABASE_JWT_SECRET vacío → modo JWKS automático — correcto)
- CORS: ✅ `access-control-allow-origin: https://cursia.nomaddi.com` verificado
- JWT auth: ✅ token inválido → 401 en todos los endpoints protegidos
- CI/CD GitHub Actions: ⏳ workflow listo, pendiente configurar secrets en GitHub

### VPS Contabo
- **IP pública**: `167.86.98.162`
- **Tipo**: Cloud VPS 20 SSD — Ubuntu 24.04.4 LTS
- **Usuario app**: `cursia` (sudo, SSH key only)
- **App path**: `/var/www/cursia-backend`
- **SSH key local**: `orbia-backend/.cursia_vps_key` (en .gitignore)
- **Estado**: ✅ Completamente configurado y en producción

### Base de datos (Supabase PostgreSQL)
- **Estado: ✅ Proyecto activo y verificado** — `hriwbakbuypaiovvvkqh.supabase.co`
- Schema ejecutado: ✅ v1.1 — 8 tablas presentes (6 NestJS + 2 Supabase-managed)
- Tablas NestJS: `courses`, `course_versions`, `youtube_connections`, `usage_events`, `cost_rates`, `traditional_cost_benchmarks`
- Tablas extra (Supabase-managed, sin entidad NestJS): `authorized_users`, `user_settings`
- Seeds: ✅ 11 filas en `cost_rates`, 7 en `traditional_cost_benchmarks`
- Auth: ✅ ES256/JWKS — backend valida contra `hriwbakbuypaiovvvkqh.supabase.co/auth/v1/.well-known/jwks.json`

### Deploy
- Frontend: ✅ Cloudflare Pages — `https://cursia.nomaddi.com`
- Backend: ✅ VPS Contabo — `https://api.cursia.nomaddi.com` — EN PRODUCCIÓN
- DNS: ✅ registro A `api.cursia` → `167.86.98.162` creado
- Nginx + PM2 + SSL: ✅ todo configurado y activo

---

## Últimos avances importantes

| Fecha | Avance |
|---|---|
| Mayo 2026 | **QA producción completado** — backend validado: health, PM2, SSL, CORS, JWT, DB |
| Mayo 2026 | **Backend en producción** — VPS Contabo configurado + Nginx + PM2 + SSL |
| Mayo 2026 | **DNS**: registro A `api.cursia.nomaddi.com` → `167.86.98.162` creado |
| Mayo 2026 | ElevenLabs: audio bienvenida + audiolibro implementados con guard MBZ/curso |
| Mayo 2026 | MBZ: sanitización de `src="#audio"` — elimina placeholder falso del export |
| Mayo 2026 | Admin Dashboard D0: UsageEvents, CostRates, Benchmarks, SuperAdminGuard |
| Mayo 2026 | SQL Schema v1.1 corregido: idempotente, ALTER TABLE, bug `scopes` y UNIQUE |
| Mayo 2026 | CI/CD: `.github/workflows/deploy.yml` + `scripts/deploy.sh` creados |
| Mayo 2026 | Merge `feature/admin-dashboard-d0` → `main` |

---

## Ramas y repositorios principales

| Repo | Rama activa | URL |
|---|---|---|
| `campuscloud-gen` | `main` | Frontend — Cloudflare Pages |
| `orbia-backend` | `main` | Backend — pendiente deploy en Contabo |

---

## Prioridades inmediatas (en orden)

1. **Configurar GitHub Actions secrets** — VPS_HOST, VPS_USER, VPS_SSH_KEY, VPS_PATH, HEALTH_URL
2. **Agregar redirect URI de YouTube** en Google Cloud Console: `https://api.cursia.nomaddi.com/api/v1/youtube/oauth/callback`
3. **Test Cloud Save** con sesión real en browser: activar `CURSIA_BACKEND_ENABLED=true` + `CURSIA_BACKEND_URL=https://api.cursia.nomaddi.com` en localStorage
4. **Integrar POST `/api/v1/events`** en frontend tras generación de curso (`02-run.js`, `09-mbz.js`)
5. **Primer cliente de Sprint** — agendar diagnóstico gratuito

---

## Lo que NO está implementado todavía

- Videogen (generación de videos desde Cursia) — diseñado, no implementado
- Planes SaaS con límites por backend — diseñado, no implementado
- Sitio web comercial de Cursia
- RLS (Row Level Security) en Supabase — pendiente
- Migraciones TypeORM — se usa SQL manual por ahora
- Panel de administración visible para el usuario (solo para super admin por ahora)
