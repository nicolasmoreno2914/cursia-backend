# 08 — Google Drive, YouTube y Videogen

---

## Google Drive

### Propósito
Almacenar archivos pesados del curso (MBZ generado, snapshots grandes) fuera de PostgreSQL. Drive actúa como storage secundario vinculado a la cuenta Google del usuario.

### Scope OAuth
- `drive.file` — acceso solo a archivos creados por la app
- No `drive` completo — por privacidad y mejores prácticas OAuth

### Flujo
1. Usuario autoriza Google Drive desde la UI
2. Frontend obtiene access token (OAuth implícito o server-side)
3. Se sube el archivo al Drive del usuario
4. Backend guarda `{ storage_provider: 'google_drive', storage_file_id, storage_file_url }` en `course_versions`

### Reglas
- PostgreSQL no guarda BLOBs >1 MB
- El `file_id` de Drive es la referencia permanente
- Si el usuario revoca acceso, el archivo se vuelve inaccesible
- No usar `drive` scope completo

---

## YouTube OAuth

### Propósito
Permitir que Cursia suba videos al canal de YouTube del usuario sin que el usuario tenga que hacerlo manualmente.

### Scopes solicitados
- `https://www.googleapis.com/auth/youtube.upload` — para subir videos
- `https://www.googleapis.com/auth/youtube.readonly` — para leer info del canal

### Flujo completo
```
Usuario en Cursia → "Conectar YouTube"
→ Frontend: GET /api/v1/youtube/oauth/start (con JWT)
→ Backend: genera URL de Google OAuth
→ Frontend: redirige al usuario a Google
→ Google: usuario autoriza
→ Google: redirige a https://api.cursia.nomaddi.com/api/v1/youtube/oauth/callback
→ Backend: intercambia code por tokens
→ Backend: cifra refresh_token con AES-256-GCM + token_iv
→ Backend: guarda en youtube_connections (user_id UNIQUE)
→ Backend: redirige a FRONTEND_URL con parámetro de éxito
→ Frontend: GET /api/v1/youtube/connection → muestra canal conectado
```

### Seguridad
- El `refresh_token` se guarda **siempre cifrado** (`encrypted_refresh_token` + `token_iv`)
- La clave de cifrado es `YOUTUBE_TOKEN_SECRET` (32+ chars, random)
- El token nunca llega al frontend
- Un usuario = una conexión activa (UNIQUE en `user_id`)

### Tabla `youtube_connections`
```
id, user_id (UNIQUE), user_email, google_subject,
channel_id, channel_title, channel_thumbnail_url,
encrypted_refresh_token, token_iv, scopes,
status (active|revoked|reauth_required),
connected_at, last_used_at, revoked_at,
created_at, updated_at
```

### Error común en desarrollo
```
redirect_uri_mismatch
```
Causa: la URI en Google Cloud Console no coincide exactamente con `YOUTUBE_REDIRECT_URI`.
Fix: verificar que son idénticas (sin slash final, mismo protocolo, mismo path).

---

## Videogen (futuro)

### Propósito
Servicio externo que recibe prompts/assets y genera videos MP4 para los capítulos del curso.

### Principio de diseño fundamental
**Videogen solo genera. Cursia publica.**
Videogen no conoce los tokens de YouTube del usuario. Cursia descarga el MP4 y lo sube al canal del usuario.

### Flujo diseñado (v1)
```
Cursia: solicita 9 videos a Videogen (HMAC)
→ Videogen: acepta job, devuelve job_id
→ Videogen: genera MP4s en storage temporal local
→ Videogen: callback a Cursia (HMAC): { job_id, status, download_urls }
→ Cursia: descarga MP4s
→ Cursia: sube a YouTube del usuario (con tokens cifrados)
→ Cursia: guarda youtube_url en MEDIA.videos / course_versions
```

### Seguridad Videogen
- Comunicación via HMAC (`VIDEOGEN_WEBHOOK_SECRET`)
- Videogen no recibe tokens de YouTube ni de Google
- Los MP4 tienen TTL corto — Cursia los descarga y elimina el job
- `VIDEOGEN_API_URL` y `VIDEOGEN_SHARED_SECRET` solo en `.env` del backend

### Storage en v1
- Storage temporal local en el servidor de Videogen
- No R2, no S3, no GCS en v1 (complejidad/costo no justificado)
- Cuando escale: migrar a R2 u objeto equivalente

### Tabla futura: `video_jobs`
```
id, user_id, course_id, chapter_id,
status (pending|processing|completed|failed),
job_id, download_url, youtube_url,
provider (videogen|...), requested_at, completed_at
```

### Estado actual
- 📋 Diseñado, no implementado
- El backend tiene `VIDEOGEN_API_URL`, `VIDEOGEN_SHARED_SECRET`, `VIDEOGEN_WEBHOOK_SECRET` en `.env.production.template`
- `MEDIA.videos` en el frontend reserva espacio para los resultados
