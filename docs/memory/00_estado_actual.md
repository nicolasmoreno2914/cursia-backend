# 00 — Estado actual del proyecto Cursia

> **Antes de trabajar en Cursia, leer este archivo primero.**
> Actualizar este archivo cada vez que una fase termina o el estado cambia.
> Fecha de última actualización: Mayo 2026

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
- **Estado: ✅ EN PRODUCCIÓN** — `https://api.cursia.nomaddi.com`
- Repo: `orbia-backend` / rama: `main`
- PM2: ✅ `cursia-backend` online — `167.86.98.162:3000`
- Nginx: ✅ reverse proxy activo
- SSL: ✅ Let's Encrypt — expira 2026-08-22
- Supabase DB: ✅ conectada — seeds corrieron al arrancar
- CI/CD GitHub Actions: ✅ workflow listo, pendiente configurar secrets en GitHub

### VPS Contabo
- **IP pública**: `167.86.98.162`
- **Tipo**: Cloud VPS 20 SSD — Ubuntu 24.04.4 LTS
- **Usuario app**: `cursia` (sudo, SSH key only)
- **App path**: `/var/www/cursia-backend`
- **SSH key local**: `orbia-backend/.cursia_vps_key` (en .gitignore)
- **Estado**: ✅ Completamente configurado y en producción

### Base de datos (Supabase PostgreSQL)
- **Estado: ✅ Proyecto activo** — `hriwbakbuypaiovvvkqh.supabase.co`
- Schema ejecutado: 🔄 pendiente confirmar (hubo error `42703` corregido en v1.1 del SQL)
- 6 tablas: `courses`, `course_versions`, `youtube_connections`, `usage_events`, `cost_rates`, `traditional_cost_benchmarks`
- Auth: ES256/JWKS configurado en backend

### Deploy
- Frontend: ✅ Cloudflare Pages — `https://cursia.nomaddi.com`
- Backend: 🔄 VPS Contabo — dominio `api.cursia.nomaddi.com` pendiente de configurar
- DNS: ⏳ pendiente crear registro A `api.cursia` → IP del VPS
- Nginx + PM2 + SSL: ⏳ pendiente ejecutar en VPS

---

## Últimos avances importantes

| Fecha | Avance |
|---|---|
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

1. **Ejecutar `docs/SCHEMA_SUPABASE.sql` en Supabase** (v1.1 — versión corregida)
2. **Configurar VPS** `167.86.98.162`: usuario `cursia`, UFW, Node.js 22, PM2, Nginx
3. **Clonar repo + crear `.env`** en `/var/www/cursia-backend`
4. **DNS**: crear registro A `api.cursia → 167.86.98.162` en panel de Cloudflare/Namecheap
5. **Certbot SSL** para `api.cursia.nomaddi.com`
6. **Configurar GitHub Actions secrets** (VPS_HOST=167.86.98.162, VPS_USER, VPS_SSH_KEY, VPS_PATH, HEALTH_URL)
7. **Validar endpoints**: `/health`, `/api/v1`, `/api/v1/auth/me`
8. **Activar backend en frontend** vía `localStorage` y validar Cloud Save

---

## Lo que NO está implementado todavía

- Videogen (generación de videos desde Cursia) — diseñado, no implementado
- Planes SaaS con límites por backend — diseñado, no implementado
- Sitio web comercial de Cursia
- RLS (Row Level Security) en Supabase — pendiente
- Migraciones TypeORM — se usa SQL manual por ahora
- Panel de administración visible para el usuario (solo para super admin por ahora)
