# 06 — MBZ / Moodle export

---

## Qué es un MBZ

Un `.mbz` es un archivo ZIP con estructura específica de Moodle que contiene el curso completo: actividades, recursos, configuración, metadatos XML. Se importa en Moodle desde la interfaz de administración del curso.

---

## Contenido de un MBZ generado por Cursia

| Componente | Descripción |
|---|---|
| Páginas HTML | Una por capítulo del libro guía (contenido textual formateado) |
| SCORM | Actividad interactiva por capítulo (ZIP embebido) |
| Quizzes Moodle | Evaluaciones con banco de preguntas en formato XML Moodle |
| Labels | Etiquetas de navegación y separadores entre secciones |
| Audio bienvenida | Página con player de audio (si existe archivo real) |
| Audiolibro | Páginas de audio por capítulo (si existen archivos reales) |
| Completion | Configuración de seguimiento de actividades |

---

## Archivo principal

`src/js/09-mbz.js` — construye el ZIP completo.
`src/js/16-mbz-patch.js` — parchea el MBZ con datos adicionales y expone helpers.

---

## Problemas detectados y corregidos

### `src="#audio"` placeholder
**Problema**: Los prompts de generación de libro guía incluían `<audio src="#audio">` como placeholder. Al exportar MBZ, ese placeholder quedaba en el HTML y Moodle lo renderizaba roto.

**Fix aplicado** en `09-mbz.js`:
```js
// Si es página de audio y no hay archivo real:
fnContent = fnContent.replace(
  /<audio\b[^>]*>[\s\S]*?<\/audio>/gi,
  '<div style="...">Audio en preparación</div>'
);
```

### Quizzes: configuración real vs. etiquetas informativas
**Problema**: Las etiquetas del quiz decían "3 intentos" pero la configuración XML decía "ilimitados".
**Regla**: las etiquetas deben coincidir con la configuración XML real del quiz.

### Videos placeholder
**Problema**: Páginas con embed de video generaban `<iframe>` sin URL real.
**Regla**: si no hay URL de video real, usar texto limpio "Video en preparación" en lugar de embed roto.

### Completion incoherente
**Problema**: actividades marcadas como "requeridas para completar el curso" que el estudiante no podía completar.
**Regla**: solo marcar como requerida la actividad si tiene un criterio de completado real (quiz: nota mínima; SCORM: completado; página: vista).

---

## Reglas del MBZ (no romper)

1. **No `src="#audio"`** — siempre reemplazar con placeholder limpio si no hay archivo
2. **No embed de video sin URL real** — usar texto en su lugar
3. **Etiquetas informativas = configuración real** — no mentir al estudiante
4. **Completion coherente** — solo marcar requerida si hay criterio alcanzable
5. **No modificar estructura XML de actividades** sin validar en Moodle real
6. **El ZIP debe ser válido** — probar `unzip -t curso.mbz` antes de entregar

---

## Cómo probar un MBZ

1. Exportar desde Cursia → descargar `.mbz`
2. Ir a Moodle → Restaurar curso → subir el `.mbz`
3. Verificar: páginas, SCORM, quizzes, audio, completion
4. Intentar completar el curso como estudiante

---

## Relación con el audio

Cuando se genera audio con ElevenLabs:
- El blob se guarda en IDB (`MEDIA_AUDIO_BLOBS`)
- Al construir el MBZ, `09-mbz.js` busca `MEDIA.audio`
- Si existe → genera página con player real
- Si no existe → genera placeholder limpio (sin `<audio>` roto)

El flag `hasMbzOrCourse()` en `16-mbz-patch.js` se usa para el guard de ElevenLabs.
