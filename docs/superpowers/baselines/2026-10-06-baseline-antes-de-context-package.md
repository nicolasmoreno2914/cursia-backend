# Baseline Cursia antes de Context Package

Fecha: 2026-10-06 · Loop 0 del roadmap «Contexto, coherencia y regeneración» · USD 0 (sin proveedores, sin
cursos reales).

## Estado de staging

| Repo | `origin/staging` | Despliegue |
|---|---|---|
| cursia-backend | `9b9ebde` — merge de #88 (Actividades de Aplicación) | Deploy to Staging (Contabo) **success** 2026-10-06 01:29Z, migración `supabase-migration-application-activities.sql` aplicada y verificada |
| cursia (frontend) | `2be8a87` — merge de #80 | Cloudflare Pages (staging.orbia.pages.dev) sirve el panel nuevo |

- Fase 1 (motor de carga horaria): mergeada (#85/#86 y #77/#78).
- Los 6 minors de la Fase 1 (M1–M6): cerrados en #87 / #79 (revisión 0C/0I/0M).
- Fase 2 (Actividades de Aplicación): desplegada (#88 / #80); revisión independiente 0C/0I.
- Sin PRs propios abiertos en ninguno de los dos repos (solo el antiguo cursia-backend#16, documentación de un hito).
- Producción: sin cambios (las migraciones de las fases 1 y 2 son solo de staging).

## Pruebas existentes (sobre el código de staging)

| Bloque | Resultado |
|---|---|
| E2E v2 (rulesVersion 2) | 464 / 0 |
| E2E v3 (E0–E7: FinOps, generación, empaque, H5P v2, motor pedagógico, Actividades de Aplicación) | todas ✅ |
| QA de navegador (14 suites, incluido móvil y H5P v2) | 336 / 0 |
| Regresión frontend (65 harnesses) | 795 / 0 |
| Regresión backend (83 scripts + harness) | 83 / 83 OK. En la corrida del gate, 42 fallaron por un artefacto del entorno (se recompiló `dist/` durante el gate); re-ejecutados sobre una copia limpia de staging con el mismo entorno: 42 / 42 OK |

## Baseline numérico (dorado versionado)

`scripts/check-design-baseline.js` + `scripts/fixtures/baseline/design-baseline-v1.json`. Curso de ejemplo «RCP Básico
para Auxiliares de Enfermería» (3 módulos × 3 capítulos, «Repaso», H5P v2), enfoque por competencias. Camino real
del panel: perfil → dry-run pedagógico → distribuidor → Blueprint + Manifest materializados → modelo de tiempo →
estimador de costo.

| Escenario | Estado | Horas | Cap. | Práctica | Video | Aplicación (min) | USD estimado |
|---|---|---|---|---|---|---|---|
| 20 h | within_tolerance | 19,1 | 9 | 0 | 9 | 9 (330) | 31,59 |
| 33 h | within_tolerance | 31,7 | 11 | 2 | 9 | 11 (1.050) | 33,25 |
| 50 h | within_tolerance | 48,5 | 19 | 6 | 13 | 19 (1.650) | 48,23 |
| 64 h | cannot_reach_target | 52,3 | 21 | 6 | 15 | 21 (1.710) | 54,70 |
| 64 h · Actividades solo en práctica | cannot_reach_target | 35,8 | 21 | 6 | 15 | 6 (720) | 51,13 |
| 64 h · sin Actividades | cannot_reach_target | 23,8 | 21 | 6 | 15 | 0 (0) | 49,40 |

- Sin perfil / perfil vacío / sin `targetHours`: Blueprint `21e04725…`, Manifest `e4a85978…` (los de siempre).
- Cada enfoque (competencias, problemas, experiencial, significativo, autodirigido) sin objetivo: sha de Blueprint,
  Manifest, horas y costo fijados en el dorado.
- 64 h: el desglose por proveedor es Anthropic 23,73 · Gamma 10,35 · OpenAI TTS 4,40 · Videogen 16,21 · YouTube 0.
- **Hallazgo del baseline**: con la estructura de 3 × 3, pedir 64 h no se alcanza (52,3 h; el distribuidor propone
  módulos nuevos en vez de inflar). Es el caso que el Contexto académico resuelve: un microcurrículo con 5 unidades
  da la estructura de partida.

## Empaquetado Moodle (baseline)

- E2E E1–E7 restauran en el Moodle 4.5 local: `.mbz` válido, secuencias de sección = Manifest, exámenes y bancos,
  H5P v2, Actividades de Aplicación (página del estudiante visible con PDF, solucionario docente oculto, `visible=0`).
- Capítulos de práctica: sin video, Gamma ni audiolibro (E7 y `check-practice-chapter`).

## Qué queda fijo como regresión para las fases siguientes

1. `check-design-baseline` (dorado): un curso sin contexto académico debe dar exactamente estos números y sha.
2. Los dorados existentes (`check-target-hours`: 80 casos legacy; `check-hours-engine-rcp` HE4; `check-application-activities` AA8).
3. Gate completo (E2E + navegador + regresión).
