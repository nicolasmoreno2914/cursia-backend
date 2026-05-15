# QA V1 — Checklist de Validación

> Usar antes de deploy (entorno local/staging) y después de deploy (producción).
> Marcar con ✅ aprobado, ❌ fallido, ⏭ no aplica.

---

## 1. Autenticación

### Pre-deploy

- [ ] Login con email/password de usuario autorizado → accede correctamente
- [ ] Login con email/password de usuario NO autorizado → bloqueado con mensaje claro
- [ ] Login con credenciales incorrectas → error legible, no crash
- [ ] Logout → sesión cerrada, estado local limpio
- [ ] Reset de contraseña → email enviado, enlace funciona
- [ ] Sesión persiste al recargar página (token en Supabase localStorage)
- [ ] Registro de usuario nuevo (email en `authorized_users`) → puede iniciar sesión
- [ ] Registro de usuario no autorizado → acceso denegado al intentar entrar

### Post-deploy

- [ ] Login funciona desde `orbia.pages.dev` (no solo localhost)
- [ ] Token JWT válido generado por Supabase, verificado por el backend

---

## 2. Panel Admin

- [ ] Usuario admin ve el panel de administración
- [ ] Usuario regular NO ve el panel de administración
- [ ] Admin puede agregar un email a `authorized_users`
- [ ] Admin puede eliminar un email de `authorized_users`
- [ ] Admin puede marcar a otro usuario como admin (`is_admin = true`)
- [ ] Admin puede revocar rol de admin a otro usuario
- [ ] La tabla `authorized_users` en Supabase refleja los cambios
- [ ] El panel admin no expone datos de usuarios a usuarios regulares

---

## 3. Configuración de Usuario

- [ ] Guardar API key de Anthropic → se persiste en `user_settings` de Supabase
- [ ] Cargar API key al iniciar sesión → disponible para generación
- [ ] Cambiar logo → se actualiza en la UI
- [ ] Cambiar datos de cuenta → se guarda en Supabase
- [ ] Cambiar tema visual → se aplica inmediatamente y persiste
- [ ] Cerrar sesión y volver a entrar → configuración intacta

---

## 4. Generación de Cursos

- [ ] Crear nuevo curso desde cero (título, sector, nivel)
- [ ] Generación del libro/índice con IA → respuesta recibida, sin timeout
- [ ] Generación de páginas/capítulos → contenido HTML generado correctamente
- [ ] Estado de generación persiste al recargar (IndexedDB activo)
- [ ] Generación de quizzes → preguntas generadas con respuestas
- [ ] Exportar SCORM → .zip descargado correctamente
- [ ] Generación persistente no se pierde al cerrar y reabrir pestaña
- [ ] Curso se puede reanudar desde donde se dejó

---

## 5. SCORM

- [ ] Abrir actividades SCORM en el navegador → sin errores de consola
- [ ] Mecánicas premium (score, vidas, timer) funcionan correctamente
- [ ] Score se actualiza al responder preguntas
- [ ] Sistema de vidas descuenta correctamente al fallar
- [ ] Timer cuenta regresiva sin bugs
- [ ] SCORM se puede importar en un LMS (validación manual opcional)
- [ ] No hay errores JavaScript en consola durante ejercicios SCORM

---

## 6. Audio / Video y H5P

- [ ] Pegar URL de video → se procesa correctamente (`processMedia`)
- [ ] H5P generado → se renderiza sin errores
- [ ] MBZ existente contiene los recursos de audio/video correctamente
- [ ] Video Engine en modo `test_only` → no genera carga real, UI correcta
- [ ] No hay errores de CORS al acceder a recursos multimedia

---

## 7. MBZ (Moodle)

- [ ] Exportar MBZ desde un curso completo → archivo descargado
- [ ] MBZ contiene módulos, actividades y recursos correctamente
- [ ] Guardar MBZ en Google Drive → archivo subido, URL guardada
- [ ] Restaurar MBZ en Moodle (si entorno disponible) → importación exitosa
- [ ] URL del MBZ en Drive se guarda en `user_settings.oca_data` o `courses.drive_url_mbz`

---

## 8. Cloud Save (Backend + Frontend)

### Backend apagado / desactivado

- [ ] `ORBIA_BACKEND_ENABLED` = `false` → panel Cloud Save no aparece o está desactivado
- [ ] Resto de la app funciona normalmente sin el backend
- [ ] No hay errores de red visibles al usuario cuando el backend está apagado

### Backend encendido, usuario no logueado

- [ ] Botón "Guardar en nube" aparece desactivado (`disabled`)
- [ ] Mensaje "Inicia sesión para guardar en la nube" visible
- [ ] Lista de cursos en nube muestra mensaje de inicio de sesión, no error

### Backend encendido, usuario logueado

- [ ] `GET /health` → responde `{"status": "ok"}`
- [ ] `GET /api/v1/auth/me` con token → devuelve `{id, email, role}` correctos
- [ ] Guardar snapshot pequeño → se guarda con `storage_provider = 'postgres_json'`
- [ ] Guardar snapshot grande → se sube a Drive y se guarda referencia en backend
- [ ] Listar cursos → solo aparecen los cursos del usuario autenticado
- [ ] Listar versiones de un curso → versiones ordenadas, numeradas
- [ ] Restaurar versión `postgres_json` → estado del curso restaurado correctamente
- [ ] Restaurar versión `google_drive` → se descarga de Drive y se restaura
- [ ] Recuperar backup local → restaura el estado desde archivo `.json` descargado

### Aislamiento

- [ ] Usuario A no ve cursos de Usuario B
- [ ] Intento de acceder a curso ajeno devuelve 404 (no 403, no 200)

---

## 9. Seguridad

- [ ] `GET /api/v1/courses` sin token → `401 "Token de acceso requerido"`
- [ ] `POST /api/v1/courses` sin token → `401`
- [ ] Token con firma inválida → `401 "Token inválido o expirado"`
- [ ] Token de otro proyecto Supabase → `401`
- [ ] Token expirado → `401 "Token inválido o expirado"`
- [ ] `owner_id` en body del POST es ignorado (ValidationPipe lo rechaza)
- [ ] No hay tokens de acceso en `localStorage` del usuario (Supabase los gestiona en sus propias claves)
- [ ] No hay secrets (API keys, JWT secrets) en el código fuente o en el repo de Git
- [ ] `/health` responde `200` sin token (endpoint público correcto)

---

## 10. No Regresión

Verificar que las funcionalidades existentes no se rompieron con los cambios de Cloud Save y auth.

- [ ] **SCORM**: generación y descarga siguen funcionando
- [ ] **MBZ**: exportación sin cambios
- [ ] **Audio/Video**: `processMedia` y Video Engine sin cambios
- [ ] **Google Drive**: OAuth, subida de MBZ, descarga siguen funcionando
- [ ] **Librería Supabase**: listado de cursos en Supabase (no en backend) correcto
- [ ] **Panel Admin Supabase**: gestión de `authorized_users` sin cambios
- [ ] **user_settings**: API key, logo, tema — sin cambios
- [ ] **Generación principal**: el flujo completo de IA sigue funcionando
- [ ] **Backup local**: descarga de JSON sigue disponible
- [ ] **IndexedDB**: persistencia de generación en curso sin cambios

---

## Plantilla de Resultado

```
Fecha de QA: ___________
Entorno: [ ] local  [ ] staging  [ ] producción
Tester: ___________

Sección 1 — Auth:         ___/8  ✅ ___ ❌ ___
Sección 2 — Admin:        ___/8  ✅ ___ ❌ ___
Sección 3 — Configuración:___/6  ✅ ___ ❌ ___
Sección 4 — Generación:   ___/8  ✅ ___ ❌ ___
Sección 5 — SCORM:        ___/7  ✅ ___ ❌ ___
Sección 6 — Audio/Video:  ___/5  ✅ ___ ❌ ___
Sección 7 — MBZ:          ___/5  ✅ ___ ❌ ___
Sección 8 — Cloud Save:   ___/15 ✅ ___ ❌ ___
Sección 9 — Seguridad:    ___/9  ✅ ___ ❌ ___
Sección 10 — No regresión:___/10 ✅ ___ ❌ ___

TOTAL: ___/81

Bugs encontrados:
1.
2.

Veredicto: [ ] APROBADO PARA DEPLOY  [ ] BLOQUEADO — corregir primero
```
