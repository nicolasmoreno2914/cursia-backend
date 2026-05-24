# 01 — Arquitectura general de Cursia

---

## Diagrama de componentes

```
┌─────────────────────────────────────────────────────────────────┐
│  USUARIO (docente / empresa)                                    │
└──────────────────────────────┬──────────────────────────────────┘
                               │ HTTPS
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│  FRONTEND — cursia.nomaddi.com (Cloudflare Pages)               │
│  Vanilla JS · Supabase Auth · IndexedDB · localStorage         │
│                                                                 │
│  Generación IA ──────────────────────────► Claude API          │
│  Audio ───────────────────────────────────► ElevenLabs API     │
│  Archivos pesados ────────────────────────► Google Drive API   │
│  YouTube UI ──────────────────────────────► Backend            │
│  Cloud Save / Restore ────────────────────► Backend            │
└──────────────────────────────┬──────────────────────────────────┘
                               │ JWT Supabase (ES256)
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│  BACKEND — api.cursia.nomaddi.com (Contabo VPS)                 │
│  NestJS · TypeORM · PM2 · Nginx · SSL                          │
│                                                                 │
│  courses · course_versions · youtube_connections               │
│  usage_events · cost_rates · traditional_cost_benchmarks       │
│  Admin Dashboard · SuperAdminGuard                             │
└──────────┬──────────────────────────────┬───────────────────────┘
           │                              │
           ▼                              ▼
┌──────────────────────┐      ┌──────────────────────────────────┐
│  SUPABASE            │      │  YOUTUBE / GOOGLE APIs           │
│  PostgreSQL DB       │      │  OAuth callback → backend        │
│  Supabase Auth/JWKS  │      │  Tokens cifrados en DB           │
│  ES256 JWT           │      │  Subida de videos: Cursia → YT   │
└──────────────────────┘      └──────────────────────────────────┘
                                          │ futuro
                                          ▼
                               ┌──────────────────────┐
                               │  VIDEOGEN (externo)  │
                               │  Genera MP4 temp     │
                               │  Callback → backend  │
                               │  Cursia sube a YT    │
                               └──────────────────────┘
```

---

## Responsabilidades por componente

### Frontend (`campuscloud-gen`)
**Hace:**
- Toda la generación de contenido con IA (Claude API directamente)
- Renderizado de la app completa (vanilla JS, sin framework)
- Estado del curso en memoria: objetos `D`, `F`, `MEDIA`, `VIDEO_ENGINE`
- Persistencia local con IndexedDB (`_idbPut`/`_idbGet`)
- Supabase Auth (login/logout, obtención de JWT)
- Generación MBZ para Moodle
- Generación SCORM standalone
- Audio con ElevenLabs (directo desde navegador)
- Google Drive (OAuth, subida de archivos pesados)
- Cloud Save/Restore (llama al backend con JWT)
- UI de conexión YouTube (llama al backend)

**NO hace:**
- Validar planes/límites de forma definitiva (solo UI, el backend valida)
- Guardar tokens de YouTube o Google (el backend los cifra y guarda)
- Generar videos (eso es Videogen, orquestado por backend)
- Exponer secretos de API al usuario

---

### Backend (`cursia-backend` / `orbia-backend`)
**Hace:**
- Validar JWT de Supabase (ES256/JWKS) en cada request protegido
- CRUD de cursos y versiones con ownership (`owner_id` = UUID Supabase)
- Guardar/restaurar snapshots del estado del curso
- OAuth YouTube: generar URL de autorización, procesar callback, cifrar tokens
- Registrar eventos de uso (`usage_events`) para billing y analytics
- Admin Dashboard: aggregaciones de costos, KPIs
- Orquestar generación de videos (futuro: llamar a Videogen, manejar callbacks)
- Subida de videos a YouTube en nombre del usuario (futuro)

**NO hace:**
- Generar contenido educativo (eso es Claude API, directo desde frontend)
- Procesar audio (eso es ElevenLabs, directo desde frontend)
- Servir archivos estáticos del frontend
- Correr la base de datos (PostgreSQL vive en Supabase)

---

### Supabase
**Hace:**
- Autenticación (email/password, magic link, Google OAuth si se activa)
- Emitir JWT con ES256 (JWKS público disponible en `/auth/v1/.well-known/jwks.json`)
- Hospedar la base de datos PostgreSQL (6 tablas del backend)
- Panel de DB para inspección manual

**NO hace:**
- Servir la API del backend (eso es NestJS en Contabo)
- Hospedar el frontend (eso es Cloudflare Pages)

---

### Google Drive
**Hace:**
- Almacenar archivos MBZ pesados y snapshots grandes del curso
- Carpetas por usuario, organizadas por curso
- Liberar a PostgreSQL de guardar archivos >1 MB

**NO hace:**
- Autenticación de usuarios (eso es Supabase)
- Guardar tokens de YouTube

---

### ElevenLabs
**Hace:**
- TTS para audio de bienvenida (máx. 2 min / 220 palabras)
- TTS para audiolibro por capítulo
- Acceso directo desde el navegador (key guardada en `localStorage` del usuario)

**NO hace:**
- Nada en el servidor — es una integración solo-frontend

---

### Videogen (futuro)
**Hace:**
- Recibir prompt/assets de Cursia y generar videos MP4
- Devolver URL temporal de descarga via callback HMAC
- Storage temporal local (v1)

**NO hace:**
- Tocar tokens de YouTube (Cursia sube los videos al canal del usuario)
- Guardar datos del usuario a largo plazo
- Facturar directamente al usuario final

---

## Reglas de arquitectura

1. **PostgreSQL no guarda archivos pesados** — Drive para >1 MB
2. **El backend valida ownership** — `owner_id` viene del JWT, nunca del body
3. **El frontend no es la única capa de seguridad** — límites de plan en backend
4. **Videogen no toca tokens de YouTube** — Cursia los gestiona
5. **Supabase Auth es la única fuente de identidad** — no crear sistema de auth propio
6. **Contabo corre la API, no la DB** — Supabase sigue siendo la DB en producción
7. **Tokens de terceros siempre cifrados en DB** — nunca en frontend ni logs
