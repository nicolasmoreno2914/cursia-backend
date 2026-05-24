# docs/memory — Memoria persistente del proyecto Cursia

> **Fuente de verdad del proyecto. Leer antes de trabajar en Cursia.**

Esta carpeta contiene la documentación estructurada del proyecto Cursia, diseñada para que Claude (u otro asistente de IA) pueda recuperar contexto completo del proyecto al inicio de cualquier chat, sin depender de la memoria de sesiones anteriores.

---

## Qué contiene

| Archivo | Contenido | Leer cuando... |
|---|---|---|
| `00_estado_actual.md` | Estado del proyecto hoy — qué funciona, qué está pendiente, prioridades | **Siempre, primero** |
| `01_arquitectura_general.md` | Diagrama y responsabilidades de cada componente | Trabajo de arquitectura o integración |
| `02_decisiones_tecnicas.md` | Por qué se tomó cada decisión técnica importante | Antes de proponer cambios estructurales |
| `03_frontend.md` | Stack, estado global, archivos clave, reglas del frontend | Trabajo en `campuscloud-gen` |
| `04_backend.md` | NestJS, tablas, endpoints, auth, deploy | Trabajo en `orbia-backend` |
| `05_scorm.md` | Mecánicas SCORM, fixes, checklist QA | Trabajo en SCORM |
| `06_mbz_moodle.md` | Export MBZ, reglas, problemas conocidos | Trabajo en MBZ o Moodle |
| `07_audio_video_elevenlabs.md` | Audio bienvenida, audiolibro, ElevenLabs, guard | Trabajo en audio |
| `08_drive_youtube_videogen.md` | Google Drive, YouTube OAuth, Videogen | Trabajo en integraciones externas |
| `09_deploy_produccion.md` | Pasos de deploy, checklist, troubleshooting | Deploy o infraestructura |
| `10_dashboard_admin_costos.md` | Admin dashboard, eventos, costos, KPIs | Trabajo en analytics o billing |
| `11_modelo_negocio.md` | Propuesta de valor, planes, embudo de ventas | Decisiones de producto o pricing |
| `12_pendientes_riesgos.md` | Lista priorizada de tareas pendientes y riesgos | Planificación o inicio de sprint |
| `13_prompts_operativos.md` | Prompts listos para usar con Claude | Inicio de cualquier tarea |

---

## Cómo usar esta memoria

### Al iniciar una tarea

1. Abrir `00_estado_actual.md` — leer estado actual
2. Abrir el archivo del área específica (ej: `04_backend.md` para backend)
3. Abrir `12_pendientes_riesgos.md` — ver qué está pendiente
4. Usar el prompt de inicio de `13_prompts_operativos.md`

### Al terminar una tarea

1. Actualizar `00_estado_actual.md` — marcar avances
2. Actualizar `12_pendientes_riesgos.md` — marcar completado, agregar nuevos
3. Si se tomó una decisión técnica nueva → actualizar `02_decisiones_tecnicas.md`
4. Hacer commit incluyendo los archivos de memoria

---

## Regla de fuente de verdad

> **Si una decisión importante cambia, actualizar `02_decisiones_tecnicas.md`.**
>
> **Si una fase termina, actualizar `00_estado_actual.md` y `12_pendientes_riesgos.md`.**
>
> **Si hay contradicción entre código y documentación, el código manda — y la documentación se actualiza.**

---

## Regla operativa para Claude

```
Antes de trabajar en Cursia:
1. Leer 00_estado_actual.md
2. Leer el archivo del área específica
3. Revisar 12_pendientes_riesgos.md
4. Explicar qué se entendió antes de tocar código
5. Hacer cambios
6. Validar
7. Actualizar memoria si algo cambió
8. Commit
```

---

## Uso con NotebookLM

Para tener contexto de Cursia en NotebookLM:
1. Subir todos los archivos de esta carpeta como fuentes
2. Agregar también `docs/DEPLOY_CONTABO_SUPABASE.md` y `docs/SCHEMA_SUPABASE.sql`
3. Configurar NotebookLM para responder preguntas sobre el proyecto
4. Actualizar las fuentes cuando los archivos cambien (especialmente `00_estado_actual.md`)

---

## Integración futura con MCP

En el futuro, estos archivos podrían servirse via un MCP server que Claude Code lea automáticamente al iniciar cualquier sesión en este repositorio. El candidato natural es un MCP de filesystem que exponga `docs/memory/` como contexto de proyecto.

Por ahora, la práctica manual de leer `00_estado_actual.md` al inicio de cada chat es suficiente.

---

## Dónde vive esta carpeta

Esta carpeta existe en **ambos repos**:
- `orbia-backend/docs/memory/` — contexto de backend, deploy, arquitectura
- `campuscloud-gen/docs/memory/` — mismo contenido (copia sincronizada)

Cuando actualices un archivo, actualiza ambas copias o define cuál es la fuente primaria.

---

*Memoria creada en Mayo 2026. Mantener viva con cada sprint.*
