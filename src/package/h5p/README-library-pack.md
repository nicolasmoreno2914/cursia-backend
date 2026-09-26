# Cursia H5P Library Pack (CURSIA_H5P_PROFILE_V1)

Instalación **una sola vez por sitio Moodle**, por un administrador.

## Por qué hace falta

Los cursos de Cursia traen sus actividades H5P (`mod_h5pactivity`) como
paquetes **solo contenido**: pesan pocos KB porque no incluyen las librerías
H5P (el reproductor de cada tipo de contenido).

Moodle solo instala librerías H5P si el **autor del archivo** `.h5p` tiene
permiso `moodle/h5p:updatelibraries` (administrador o manager). Al restaurar un
curso, el autor pasa a ser **quien restaura**. Si restaura un docente en un
sitio sin las librerías, el H5P muestra "Missing main library" y **no
despliega**. Este pack instala esas librerías de antemano, así cualquier
docente puede restaurar cursos de Cursia.

## Contenido

| Archivo | Tipo de contenido |
|---|---|
| `cursia-h5p-pack-v1-H5P.InteractiveVideo-1.27.x.h5p` | Video interactivo |
| `cursia-h5p-pack-v1-H5P.QuestionSet-1.20.x.h5p` | Conjunto de preguntas |
| `cursia-h5p-pack-v1-H5P.SingleChoiceSet-1.11.x.h5p` | Opción única (práctica rápida) |
| `cursia-h5p-pack-v1-H5P.DragText-1.10.x.h5p` | Arrastrar palabras |
| `cursia-h5p-pack-v1-H5P.Blanks-1.14.x.h5p` | Completar espacios |
| `cursia-h5p-pack-v1-H5P.MultiChoice-1.16.x.h5p` | Opción múltiple |
| `cursia-h5p-pack-v1-H5P.TrueFalse-1.8.x.h5p` | Verdadero o falso |
| `cursia-h5p-library-pack.manifest.json` | Versiones exactas y sha256 de cada paquete y librería |

Cada `.h5p` incluye la librería principal, sus dependencias de ejecución y las
de edición (sin las de edición, el validador de H5P rechaza el paquete y el
docente no podría editar el contenido en Moodle). El contenido de ejemplo es
neutro y en español.

## Instalación (opción A, recomendada)

1. Entrar a Moodle como **administrador**.
2. *Administración del sitio → H5P → Gestionar tipos de contenido H5P*
   (*Site administration → H5P → Manage H5P content types*).
3. En **"Subir tipos de contenido H5P"** (*Upload H5P content types*),
   seleccionar cada `.h5p` del pack y pulsar **Subir**. Repetir con los 7
   archivos.
4. Verificar en la misma página que aparezcan las versiones del manifest
   (p. ej. *Interactive Video 1.27.x*).

## Instalación (opción B)

Como administrador, crear en un curso de prueba una actividad **H5P** con cada
`.h5p` del pack y **verla una vez**: al desplegarse con autor administrador,
Moodle instala las librerías. Después se puede borrar la actividad; las
librerías quedan instaladas.

## Verificación automática (preflight)

Cursia compara las librerías instaladas con el perfil (`CURSIA_H5P_PROFILE_V1`)
y **falla fuerte** si falta alguna o si su versión es menor:

```bash
node scripts/h5p-preflight-moodle.js <moodleDir> <php.ini>
```

Compatible = mismo major.minor y patch instalado mayor o igual al del perfil.

## Actualizaciones

Un pack nuevo implica un perfil nuevo (`CURSIA_H5P_PROFILE_V2`,
`h5pProfileVersion = 2`). Las versiones de un perfil publicado no cambian.
