# 05 — Sistema SCORM

---

## Objetivo

Los SCORM de Cursia son actividades interactivas autónomas que se insertan dentro del curso Moodle. No son el curso completo — son actividades complementarias de práctica y verificación para cada capítulo.

Cada SCORM es un paquete ZIP con HTML+JS standalone, sin dependencias externas, compatible con SCORM 1.2.

---

## Mecánicas activas

| Mecánica | Descripción |
|---|---|
| `flashcards` | Tarjetas de memoria con anverso/reverso |
| `sortable` | Ordenar elementos en secuencia correcta |
| `matching` | Relacionar columnas A-B |
| `fill_blank` | Completar frases con texto libre o selección |
| `hotspot` | Seleccionar zona en imagen |
| `timeline` | Ordenar eventos cronológicamente |
| `scenario` | Escenario de decisión tipo árbol |
| `quiz_classic` | Quiz de opción múltiple clásico |
| `drag_classify` | Clasificar ítems en categorías |
| `word_search` | Sopa de letras temática |

---

## Mecánicas deprecated (no usar)

Cualquier mecánica no listada arriba. Si el generador sugiere una mecánica desconocida, el sistema tiene fallback a `quiz_classic`.

---

## Criterios de selección de mecánica

- La mecánica se selecciona según el tipo de contenido del capítulo
- Variedad obligatoria: no usar la misma mecánica más de 2 veces seguidas en un curso
- Mínimo 3 mecánicas distintas por curso si hay ≥4 capítulos

---

## Fixes aplicados (no revertir)

| Fix | Problema que resolvía |
|---|---|
| Contraste de colores | Texto ilegible en fondos oscuros |
| Cierre final correcto | La última pantalla mostraba estado incorrecto |
| `done` flag | SCORM reportaba completado antes de terminar |
| Salas vacías | Algunas mecánicas aparecían sin contenido |
| Longitud de preguntas | Preguntas demasiado largas rompían el layout |
| Distractores plausibles | Opciones incorrectas obviamente falsas (mala UX pedagógica) |
| Fallback de preguntas malformadas | Si la IA generaba JSON inválido, el SCORM reventaba |
| Feedback útil | Mensajes de retroalimentación específicos, no genéricos |

---

## SCORM API

El paquete usa SCORM 1.2:
```js
API.LMSInitialize()
API.LMSSetValue('cmi.core.score.raw', score)
API.LMSSetValue('cmi.core.lesson_status', 'completed')
API.LMSFinish()
```

No modificar la integración SCORM API sin QA en Moodle real.

---

## Checklist QA obligatorio antes de exportar SCORM

- [ ] Todas las opciones son legibles (contraste mínimo 4.5:1)
- [ ] La pantalla de cierre final muestra score correcto
- [ ] No aparece "Sin preguntas" al terminar
- [ ] Ninguna mecánica deprecated
- [ ] Mínimo 3 mecánicas distintas si hay ≥4 capítulos
- [ ] Distractores plausibles (no obviamente incorrectos)
- [ ] Feedback útil (no "Incorrecto, intenta de nuevo")
- [ ] SCORM API llama a `LMSFinish()` al cerrar
- [ ] El paquete ZIP se importa sin errores en Moodle

---

## Reglas para no regresión

1. No cambiar la lógica de selección de mecánica sin correr todos los tipos
2. No tocar el cierre final sin verificar que el score se reporta
3. No modificar la generación de JSON de preguntas sin el fallback activo
4. Probar con el ZIP generado en Moodle real, no solo en browser local
