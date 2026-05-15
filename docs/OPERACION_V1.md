# Orbia V1 — Guía de Operación

> Para el equipo que administra y usa la plataforma en producción.

---

## 1. Cómo crear y autorizar un nuevo usuario

El acceso a Orbia es por invitación. El flujo completo:

**Paso 1 — Admin añade el email**
1. Inicia sesión con una cuenta admin.
2. Abre el **Panel Admin** (icono de escudo o enlace en la barra lateral).
3. En el campo "Añadir usuario", escribe el email del nuevo usuario.
4. Pulsa "Añadir". El email queda en `authorized_users` en Supabase.

**Paso 2 — Usuario se registra**
1. El usuario va a `orbia.pages.dev` (o el dominio de producción).
2. Pulsa "Registrarse" e introduce su email y contraseña.
3. Recibe un email de confirmación de Supabase.
4. Confirma el email.

**Paso 3 — Usuario entra a la app**
1. Hace login con su email y contraseña.
2. El frontend verifica que su email está en `authorized_users`.
3. Si está autorizado → accede a la plataforma.
4. Si no está autorizado → ve un mensaje de acceso denegado.

> **Nota**: el usuario debe existir en `authorized_users` ANTES de registrarse, o el frontend lo bloqueará en el login aunque el registro en Supabase haya funcionado.

---

## 2. Cómo volver admin a un usuario

1. Inicia sesión con una cuenta admin.
2. Abre el **Panel Admin**.
3. Busca al usuario en la lista.
4. Activa el toggle "Admin" junto a su nombre.
5. El campo `is_admin = true` se actualiza en `authorized_users`.

El usuario ya puede gestionar otros usuarios en su próxima sesión.

---

## 3. Cómo revocar acceso a un usuario

1. Inicia sesión con una cuenta admin.
2. Abre el **Panel Admin**.
3. Busca al usuario.
4. Pulsa "Eliminar" o el ícono de basura.
5. El email se elimina de `authorized_users`.

> En la próxima recarga o login, el usuario verá acceso denegado aunque su sesión de Supabase siga técnicamente activa. Para invalidar la sesión inmediatamente, ve al Dashboard de Supabase → Authentication → Users y desactiva o elimina al usuario.

---

## 4. Cómo configurar la API key de Anthropic

Cada usuario configura su propia API key de Claude.

1. Inicia sesión.
2. Abre el **Panel de Configuración** (icono de engranaje o perfil).
3. En el campo "API Key de Anthropic", pega tu clave `sk-ant-...`.
4. Pulsa "Guardar".
5. La clave se guarda en `user_settings` de Supabase, vinculada a tu cuenta.

> La API key nunca viaja al backend de Orbia. Solo se usa desde el navegador para llamar directamente a la API de Anthropic.

---

## 5. Cómo conectar Google Drive

1. Inicia sesión.
2. Abre el **Panel de Google Drive** (icono de Drive o en configuración).
3. Pulsa "Conectar Drive".
4. Completa el flujo OAuth de Google en la ventana emergente.
5. Acepta los permisos necesarios (acceso a archivos creados por la app).
6. El estado `drive_connected = true` se guarda en `user_settings`.

Para desconectar: misma pantalla → "Desconectar Drive".

---

## 6. Cómo crear un curso

1. Inicia sesión.
2. En la pantalla principal, pulsa "Nuevo curso" o el botón `+`.
3. Completa el formulario:
   - Título del curso
   - Sector / área temática
   - Nivel (básico, intermedio, avanzado)
4. Pulsa "Crear" para comenzar la generación con IA.
5. Sigue el flujo de generación: índice → capítulos → actividades.

El estado del curso se guarda automáticamente en IndexedDB mientras generas.

---

## 7. Cómo guardar un curso en la nube (Backend)

Requiere: estar logueado + backend encendido + `ORBIA_BACKEND_ENABLED` activo.

1. Abre el **Panel Cloud Save** (icono de nube).
2. Verifica que el indicador muestra "Conectado" (verde).
3. Pulsa "Guardar en nube".
4. El sistema elige automáticamente:
   - Si el snapshot es pequeño → se guarda en PostgreSQL (`postgres_json`)
   - Si el snapshot es grande → se sube a Drive y la referencia va a PostgreSQL (`google_drive`)
5. El curso aparece en la lista "Mis cursos en la nube".

Cada guardado crea una **nueva versión** del curso. Las versiones no se sobrescriben.

---

## 8. Cómo restaurar una versión guardada

1. Abre el **Panel Cloud Save**.
2. En la lista de cursos, selecciona el curso a restaurar.
3. Pulsa "Ver versiones".
4. Selecciona la versión deseada (cada una tiene número, fecha y notas).
5. Pulsa "Restaurar".
   - Si es `postgres_json`: los datos se cargan directamente desde el backend.
   - Si es `google_drive`: el frontend descarga el archivo de Drive y lo restaura.
6. El estado del editor se actualiza con el contenido de la versión.

> La restauración NO borra la versión actual. Puedes volver a guardar y crear una nueva versión.

---

## 9. Cómo recuperar un backup local

Si guardaste un backup manual (archivo `.json` en tu computadora):

1. Abre el **Panel Cloud Save** o el menú de recuperación.
2. Pulsa "Recuperar backup local".
3. Selecciona el archivo `.json` desde tu sistema de archivos.
4. El estado del curso se restaura desde el archivo.

> El backup local es un snapshot del estado completo del editor, incluyendo `D`, `F`, `MEDIA` y `VIDEO_ENGINE`.

---

## 10. Cómo exportar MBZ

1. Completa la generación del curso (capítulos y actividades listos).
2. Abre el menú de exportación.
3. Selecciona "Exportar MBZ".
4. El sistema genera el paquete Moodle (`.mbz`).
5. El archivo se descarga automáticamente a tu carpeta de Descargas.

Para importar en Moodle: Administración del sitio → Cursos → Restaurar curso → sube el `.mbz`.

---

## 11. Cómo guardar un MBZ en Google Drive

1. Exporta el MBZ (paso anterior).
2. En el panel de exportación, pulsa "Guardar MBZ en Drive".
3. El archivo se sube a la carpeta del curso en tu Google Drive.
4. La URL del archivo se guarda en `user_settings` / metadatos del curso para referencia futura.

---

## 12. Resolución de problemas comunes

### El backend está apagado

**Síntoma**: El indicador Cloud Save muestra "Error de conexión" o el panel no carga.

**Qué hacer**:
- La app sigue funcionando completamente (generación, SCORM, MBZ, Drive).
- Solo Cloud Save está afectado.
- Puedes seguir trabajando y guardar un backup local.
- Cuando el backend vuelva, guarda normalmente.

**Para el admin**: revisar logs del servidor backend (Railway/Render/VPS) y reiniciar el servicio.

---

### El usuario no está logueado

**Síntoma**: Botón "Guardar en nube" desactivado, mensaje "Inicia sesión para guardar".

**Qué hacer**:
- Inicia sesión con tu cuenta.
- Si no tienes cuenta, pide al admin que añada tu email.

---

### Google Drive no está conectado

**Síntoma**: Al intentar guardar un snapshot grande, error de Drive o no aparece la opción.

**Qué hacer**:
- Ve al Panel de Drive y pulsa "Conectar Drive".
- Completa el flujo OAuth.
- Vuelve a intentar guardar.

---

### El snapshot es demasiado grande

**Síntoma**: Error "Snapshot demasiado grande para PostgreSQL" o similar.

**Qué hacer**:
- Asegúrate de tener Google Drive conectado.
- El sistema intentará subir automáticamente a Drive si el snapshot supera el umbral.
- Si Drive no está conectado, conecta Drive y reintenta.

---

### La sesión expiró

**Síntoma**: Mensaje de "Token expirado" o "Sesión expirada", el backend devuelve 401.

**Qué hacer**:
- El cliente Supabase renueva el token automáticamente en la mayoría de los casos.
- Si persiste, cierra sesión y vuelve a iniciarla.
- El estado local (IndexedDB) no se pierde al cerrar sesión.

---

### El curso no aparece en la lista de la nube

**Posibles causas y soluciones**:

1. **Nunca se guardó en la nube**: pulsa "Guardar en nube" por primera vez.
2. **Guardado desde otra cuenta**: los cursos están vinculados al usuario (`owner_id`). No son compartidos.
3. **Backend en otro entorno**: confirma que el backend URL en la configuración apunta al servidor correcto.
4. **`ALLOW_UNOWNED_COURSES=false` en producción**: cursos legacy sin `owner_id` no aparecen. Solución: guardar una nueva versión desde la cuenta actual.
