# 07 — Audio, Video y ElevenLabs

---

## Objetivo

Cursia permite enriquecer los cursos con audio generado por IA (ElevenLabs) y videos (integración Videogen + YouTube, pendiente). El audio se integra al MBZ como recursos descargables y reproducibles dentro de Moodle.

---

## Estructura del objeto MEDIA

```js
window.MEDIA = {
  audio: null,        // File o Blob del audio de bienvenida
  audiolibro: null,   // null o { cap1: Blob, cap2: Blob, ... }
  videos: {}          // { capN: { url, provider, jobId } }
}
```

**Importante**: `MEDIA.audio` es un objeto `File` o `Blob` en memoria. Se pierde al recargar la página. La solución es guardarlo en IDB como ArrayBuffer bajo la clave `MEDIA_AUDIO_BLOBS`.

---

## Audio de bienvenida

**Propósito**: introducir el curso al estudiante. Se reproduce en la primera página del curso Moodle.

**Límites**:
- Máximo 2 minutos
- 130–180 palabras ideal
- Máximo 220 palabras (se recorta antes de enviar a EL)
- Tono: cálido y profesional

**Proceso de generación**:
1. Usuario hace clic en "✨ Generar con ElevenLabs" (guard activo)
2. `generateWelcomeAudio()` en `28-elevenlabs.js` construye el script desde `D` (datos del curso)
3. Llamada a `POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}`
4. Respuesta: `audio/mpeg` → `ArrayBuffer` → `Blob`
5. Se guarda en IDB bajo `MEDIA_AUDIO_BLOBS.welcome`
6. Se asigna a `MEDIA.audio` para uso en MBZ
7. Se muestra player en la UI

**Guard**:
- Botón deshabilitado hasta que `hasMbzOrCourse()` retorne `true`
- `_elRefreshGuard()` se llama tras: carga de MBZ, generación de curso
- Si no hay API key: muestra sección de configuración

---

## Audiolibro

**Propósito**: versión en audio de cada capítulo del libro guía, para estudiantes que prefieren escuchar.

**Proceso de generación**:
1. Usuario hace clic en "Generar audiolibro" (guard activo)
2. Se estiman los caracteres de todos los capítulos
3. Se muestra confirmación con estimación de coste (aprox. $0.30 por 1000 chars en EL Flash)
4. Usuario confirma → generación capítulo por capítulo
5. Cada capítulo: HTML del libro → texto limpio → ElevenLabs → Blob → IDB
6. Progress bar con estado por capítulo

**Reglas**:
- No generar sin confirmación explícita del usuario
- Limpiar HTML antes de enviar (strip tags, decode entities)
- Guardar en IDB cada capítulo conforme se completa (no esperar a todos)

---

## Configuración ElevenLabs

Se guarda en `localStorage` (es la key del usuario, no de la app):

```js
localStorage.setItem('EL_API_KEY', 'sk_...')
localStorage.setItem('EL_VOICE_ID', 'EXAVITQu4vr4xnSDxMaL')  // Sarah (default)
localStorage.setItem('EL_MODEL_ID', 'eleven_multilingual_v2')
```

La config card en la UI permite cambiarla sin recargar.

---

## Costos estimados ElevenLabs

| Acción | Caracteres aprox. | Coste aprox. (Flash model) |
|---|---|---|
| Audio bienvenida | 800–1200 | ~$0.01 |
| Capítulo audiolibro | 2000–5000 | ~$0.03–0.08 |
| Audiolibro completo (8 caps) | 20000–40000 | ~$0.30–0.60 |

Precios orientativos. Dependen del plan del usuario en ElevenLabs.

---

## Integración con MBZ

- Si `MEDIA.audio` existe al construir el MBZ → se incluye como archivo en el ZIP + página con player
- Si no existe → la página de audio bienvenida tiene placeholder limpio (no `<audio>` roto)
- El audiolibro funciona igual por capítulo

---

## Video (pendiente)

- **Estado**: diseñado, no implementado
- El objeto `MEDIA.videos` reserva espacio para URLs de video por capítulo
- Cuando Videogen esté implementado: `MEDIA.videos.cap1 = { url, provider, jobId }`
- Los iframes en las páginas HTML solo se generan si hay URL real

---

## Reglas críticas

1. **No `src="#audio"`** — nunca en el MBZ, nunca en páginas HTML
2. **No generar audio sin guard activo** — `hasMbzOrCourse()` debe ser `true`
3. **No sobrescribir audio manual del usuario sin confirmación**
4. **No mostrar player si no hay archivo** — placeholder limpio
5. **No enviar más de 220 palabras a EL para bienvenida** — recortar antes
6. **No generar audiolibro sin confirmación** — coste puede ser significativo
