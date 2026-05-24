# 13 — Prompts operativos para Claude

> Estos son los prompts base para iniciar/cerrar tareas en Cursia.
> Copiar y adaptar según la tarea específica.

---

## 1. Prompt de inicio de tarea (universal)

```
Antes de tocar código, lee estos archivos en orden:
1. docs/memory/00_estado_actual.md — estado actual del proyecto
2. docs/memory/12_pendientes_riesgos.md — qué está pendiente
3. docs/memory/[archivo del área específica] — contexto técnico del área

Una vez leídos, explica con tus propias palabras:
- Qué entendiste del estado actual
- Qué vas a hacer exactamente
- Qué archivos vas a tocar
- Qué no vas a tocar
- Qué puede salir mal

Espera confirmación antes de escribir código.
```

---

## 2. Prompt de cierre de tarea

```
La tarea está completa. Ahora:
1. Actualiza docs/memory/00_estado_actual.md:
   - Marca lo que se completó
   - Agrega los nuevos avances
   - Actualiza el estado de deploy si cambió

2. Actualiza docs/memory/12_pendientes_riesgos.md:
   - Marca las tareas completadas
   - Agrega nuevas tareas que surgieron
   - Ajusta prioridades si cambió algo

3. Haz commit de los cambios incluyendo los archivos de memoria.

Formato del commit:
feat/fix/chore(área): descripción breve

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
```

---

## 3. Prompt para cambios en el frontend

```
Actúa como experto en vanilla JavaScript y la arquitectura de Cursia.

Contexto:
- Lee docs/memory/03_frontend.md antes de empezar
- El estado global vive en D, F, MEDIA, VIDEO_ENGINE
- La persistencia local usa IndexedDB (_idbPut / _idbGet)
- Los scripts se cargan en orden en index.html

Reglas críticas:
- No romper 02-run.js (orquestador de generación)
- No tocar SCORM sin QA completo
- No tocar 09-mbz.js sin validar export real
- No depender solo del frontend para validar planes
- No guardar tokens de terceros en localStorage

Tarea: [DESCRIPCIÓN DE LA TAREA]

Explica qué vas a cambiar y por qué antes de escribir código.
```

---

## 4. Prompt para cambios en el backend

```
Actúa como arquitecto senior de NestJS y TypeORM.

Contexto:
- Lee docs/memory/04_backend.md antes de empezar
- TypeORM synchronize:false en producción — cambios de schema via SQL manual
- owner_id siempre viene del JWT (req.user.id), nunca del body
- ALLOW_UNOWNED_COURSES=false siempre en producción
- 6 tablas en Supabase (ver docs/SCHEMA_SUPABASE.sql)

Reglas:
- No cambiar el schema de DB sin actualizar SCHEMA_SUPABASE.sql
- No agregar endpoints sin validar ownership
- No exponer datos de un usuario a otro
- No hardcodear secretos

Tarea: [DESCRIPCIÓN DE LA TAREA]

Explica qué módulos/entidades/endpoints vas a tocar.
```

---

## 5. Prompt para cambios en SCORM

```
Actúa como experto en SCORM 1.2 y eLearning.

Contexto:
- Lee docs/memory/05_scorm.md antes de empezar
- Hay 10+ mecánicas activas, ninguna deprecated
- Los fixes de contraste, cierre final y done flag NO deben revertirse
- El paquete es HTML+JS standalone, sin dependencias externas

Reglas:
- No tocar la integración SCORM API (LMSInitialize, LMSSetValue, LMSFinish)
- No agregar mecánicas sin actualizar la lista en 05_scorm.md
- Correr checklist QA completo tras cualquier cambio
- Probar en Moodle real, no solo en browser

Tarea: [DESCRIPCIÓN DE LA TAREA]
```

---

## 6. Prompt para deploy

```
Actúa como DevOps senior experto en Contabo, Nginx, PM2 y NestJS.

Contexto:
- Lee docs/memory/09_deploy_produccion.md
- Lee docs/DEPLOY_CONTABO_SUPABASE.md para la guía completa
- El schema de Supabase debe ejecutarse ANTES del primer arrange de PM2
- .env con permisos 600, nunca en Git
- Transaction Pooler (6543) de Supabase NO funciona con TypeORM — usar Direct (5432)

Reglas:
- No hacer cambios de código durante el deploy
- No usar synchronize:true permanentemente
- Validar cada paso antes del siguiente
- Si algo falla, reportar antes de continuar

Tarea: [DESCRIPCIÓN DE LA TAREA DE DEPLOY]
```

---

## 7. Prompt para QA

```
Actúa como QA engineer para la plataforma Cursia.

Antes de validar, lee:
- docs/memory/00_estado_actual.md
- docs/memory/05_scorm.md (si el QA involucra SCORM)
- docs/memory/06_mbz_moodle.md (si el QA involucra MBZ)

Checklist base:
- [ ] Generación de curso completo funciona
- [ ] Export MBZ sin errores
- [ ] MBZ importa en Moodle sin errores
- [ ] SCORM completa y reporta score
- [ ] Audio bienvenida: player funciona en MBZ
- [ ] Quizzes: configuración real coincide con etiquetas
- [ ] Cloud Save y Restore funciona (si backend activo)
- [ ] Sin src="#audio" en ninguna página del MBZ

Documenta cada resultado y reporta los fallos con archivo+línea exactos.
```

---

## 8. Prompt para actualizar memoria

```
Ha ocurrido un cambio importante en el proyecto. Actualiza la memoria:

1. Identifica qué archivos de docs/memory/ deben cambiar:
   - 00_estado_actual.md → si cambió el estado de un componente
   - 02_decisiones_tecnicas.md → si se tomó una nueva decisión técnica
   - 12_pendientes_riesgos.md → si se completó o agregó una tarea

2. Actualiza solo lo que cambió. No reescribas secciones que siguen igual.

3. Agrega la fecha de la actualización en el header del archivo.

4. Haz commit: docs(memory): actualizar estado tras [descripción]

Cambio a documentar: [DESCRIPCIÓN DEL CAMBIO]
```

---

## 9. Regla operativa (leer antes de cualquier tarea)

**Cada vez que Claude vaya a trabajar en Cursia debe:**

1. Leer `docs/memory/00_estado_actual.md`
2. Leer el archivo específico del área de trabajo
3. Revisar `docs/memory/12_pendientes_riesgos.md`
4. **Antes de modificar código: explicar qué entendió** (3-5 líneas)
5. Hacer los cambios
6. Ejecutar las validaciones del área
7. Actualizar la memoria si cambió algo importante
8. Hacer commit con mensaje descriptivo
