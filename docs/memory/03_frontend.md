# 03 — Frontend (campuscloud-gen)

---

## Stack

- **Lenguaje**: Vanilla JavaScript (sin framework)
- **Bundler**: ninguno — scripts cargados directamente en `index.html`
- **Auth**: Supabase JS SDK (`window.SB`)
- **Persistencia local**: IndexedDB (`_idbPut`, `_idbGet`) + `localStorage`
- **Deploy**: Cloudflare Pages — `https://cursia.nomaddi.com`
- **Repo**: `campuscloud-gen`

---

## Estructura de archivos JS relevantes

| Archivo | Función |
|---|---|
| `01-state.js` | Estado global (`D`, `F`, `MEDIA`, `VIDEO_ENGINE`), IDB helpers, `clearSavedSession()`, `nuevoCurso()` |
| `02-run.js` | Orquesta la generación completa del curso; llama a Claude API |
| `05-libro.js` | Generación del libro guía (capítulos, prompts a Claude) |
| `09-mbz.js` | Builder del archivo MBZ (ZIP para Moodle); sanitiza audio placeholders |
| `10-media.js` | Objeto `MEDIA` — gestión de archivos audio/video |
| `14-drive.js` | Google Drive OAuth y subida de archivos |
| `16-mbz-patch.js` | Patch del MBZ; expone `window.hasMbzOrCourse()`; notifica guard de EL |
| `28-elevenlabs.js` | Generación de audio con ElevenLabs; guard; IDB persistence de blobs |
| `scorm/*.js` | Generador de actividades SCORM |
| `youtube/*.js` | UI de conexión YouTube (llama al backend) |

---

## Estado global del curso

Todo el estado en memoria se guarda en cuatro objetos:

```js
D    // datos del curso: nombre, sector, nivel, módulos, capítulos, etc.
F    // archivos generados: { 'libro_cap1.md': '...', 'quiz_1.xml': '...', ... }
MEDIA // { audio: File|Blob|null, audiolibro: null, videos: {} }
VIDEO_ENGINE // estado de generación de videos
```

Persistencia:
- `F` y `D` se guardan en IndexedDB bajo la clave `'F'` y `'D'`
- `MEDIA.audio` (Blob generado por EL) se guarda en IDB bajo `'MEDIA_AUDIO_BLOBS'`
- `EL_STATE` (estado ElevenLabs) en `window.EL_STATE`
- Config ElevenLabs (key, voice, model) en `localStorage`

Al limpiar sesión (`clearSavedSession()`): se borran IDB keys de F, D, MEDIA_AUDIO_BLOBS y se resetean EL_STATE y MEDIA.

---

## Supabase Auth en el frontend

```js
window.SB = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
// Login:
await SB.auth.signInWithPassword({ email, password })
// Token para backend:
const { data } = await SB.auth.getSession()
const token = data.session.access_token
// Header para backend:
fetch('/api/v1/courses', { headers: { Authorization: `Bearer ${token}` } })
```

---

## Feature flags actuales

### Backend — resolución automática por hostname

En producción (`cursia.nomaddi.com`) el backend se activa **automáticamente**.
No requiere ningún flag manual. La lógica está en `_resolveConfig()` dentro de `24-backend-client.js`.

Prioridad de resolución:
1. `CURSIA_BACKEND_DISABLED=true` → forzado OFF (útil para QA en prod)
2. `CURSIA_BACKEND_ENABLED=true`  → forzado ON  (útil en localhost)
3. `hostname === 'cursia.nomaddi.com'` → ON automático
4. Otros hosts → OFF por defecto

| Flag | Acción | Cuándo usar |
|---|---|---|
| `localStorage.setItem('CURSIA_BACKEND_DISABLED','true')` | Fuerza backend OFF | QA en producción, para comparar sin backend |
| `localStorage.removeItem('CURSIA_BACKEND_DISABLED')` | Restaura comportamiento normal | Tras QA en producción |
| `localStorage.setItem('CURSIA_BACKEND_ENABLED','true')` | Fuerza backend ON | Desarrollo en localhost |
| `localStorage.setItem('CURSIA_BACKEND_URL','http://localhost:3000')` | URL personalizada | Dev / staging |
| ElevenLabs key | UI config card → guardar | Habilita generación de audio |

> **Nota**: `CURSIA_BACKEND_ENABLED=false` ya NO desactiva el backend en producción.
> Usar `CURSIA_BACKEND_DISABLED=true` para forzar OFF.

---

## Cloud Save / Restore

- El frontend llama a `POST /api/v1/courses` con JWT y snapshot del estado
- En restore: `GET /api/v1/courses/:id/versions` y reconstruye `D`, `F`, `MEDIA`
- Si backend no está activo, guarda solo en IDB local

---

## Google Drive

- OAuth `drive.file` scope (solo archivos creados por la app)
- Archivos MBZ y snapshots grandes se suben a Drive
- El backend guarda el `file_id` en `course_versions.storage_file_id`
- No requiere backend activo para funcionar (OAuth directo desde frontend)

---

## YouTube UI

- El usuario hace click en "Conectar YouTube" → frontend llama al backend
- El backend genera la URL de autorización de Google y devuelve redirect
- Tras el callback, el backend guarda tokens cifrados en `youtube_connections`
- Frontend consulta `GET /api/v1/youtube/connection` para mostrar estado

---

## ElevenLabs UI

- Config card: API key, voice ID, model (`eleven_multilingual_v2`)
- Guard: botones deshabilitados si no hay MBZ/curso (`_elRefreshGuard()`)
- Audio bienvenida: botón en slot de Audio Bienvenida
- Audiolibro: botón en slot de Audiolibro, requiere confirmación
- Persistencia: blob guardado en IDB, restaurado en `DOMContentLoaded` con 800ms delay

---

## Reglas críticas para trabajar en el frontend

1. **No romper la generación de cursos** — el flujo de `02-run.js` es el núcleo
2. **No tocar SCORM sin QA completo** — hay 10+ mecánicas y su regresión es silenciosa
3. **No tocar `09-mbz.js` sin validar export real** en Moodle
4. **No tocar Google Drive sin probar OAuth completo** (requiere redirect real)
5. **No depender solo del frontend para validar planes** — el backend es la autoridad
6. **No guardar tokens de terceros en `localStorage`** — solo la EL key (es del usuario mismo)
7. **No generar audio sin verificar guard** — `_elRefreshGuard()` debe llamarse tras cada cambio de estado relevante
