# Licencias de las librerías H5P del store v3

Las carpetas de este directorio son copias sin modificar de librerías H5P oficiales
(organización `h5p` en GitHub). Cursia las incluye dentro de los paquetes `.h5p` de
Branching Scenario, Dialog Cards y Question Set 1.21 («delta» sobre CURSIA_H5P_PROFILE_V1). Versiones
exactas y sha256 de cada archivo: `manifest.json`.

Procedencia: machineName/author/version del library.json + repositorio upstream github.com/h5p/<repo> + licencia MIT; licenceSource dice qué evidencia aplica a cada librería (ruling del controlador 2026-10-01, fix round 1).

Fuente de la licencia (columna «Evidencia»): `library.json` = campo `license` de la librería;
`local LICENCE/README file` = archivo de licencia dentro de su carpeta; `upstream repository verified
2026-10-01` = repositorio upstream verificado en línea por el controlador. Columna «Repo verificado»:
«no» = URL deducido del nombre (h5p-<kebab>), sin verificación en línea.

Los paquetes `.h5p` de Cursia redistribuyen estas carpetas tal como las publica H5P (sin agregar
archivos): las que no traen su propio archivo de licencia viajan, como upstream, sin aviso dentro
de la carpeta; este archivo y `manifest.json` son el aviso MIT de Cursia.

| Librería | Versión | Copyright | Licencia | Evidencia | Repositorio | Repo verificado |
|---|---|---|---|---|---|---|
| H5P.AudioRecorder | 1.0.54 | 2017 H5P | MIT | library.json (LICENCE.md) | https://github.com/h5p/h5p-audio-recorder | sí |
| H5P.BranchingQuestion | 1.0.20 | Joubel AS (H5P Group AS) | MIT | library.json | https://github.com/h5p/h5p-branching-question | no |
| H5P.BranchingScenario | 1.10.1 | Joubel AS (H5P Group AS) | MIT | library.json | https://github.com/h5p/h5p-branching-scenario | no |
| H5P.ContinuousText | 1.2.16 | Joubel AS (H5P Group AS) | MIT | upstream repository verified 2026-10-01 | https://github.com/h5p/h5p-continuous-text | sí |
| H5P.CoursePresentation | 1.27.17 | 2012-2017 Joubel | MIT | library.json (LICENCE.md) | https://github.com/h5p/h5p-course-presentation | no |
| H5P.Dialogcards | 1.9.40 | Joubel AS (H5P Group AS) | MIT | library.json | https://github.com/h5p/h5p-dialogcards | no |
| H5P.DragQuestion | 1.15.37 | Joubel AS (H5P Group AS) | MIT | library.json | https://github.com/h5p/h5p-drag-question | sí |
| H5P.ExportableTextArea | 1.3.22 | Joubel AS (H5P Group AS) | MIT | upstream repository verified 2026-10-01 | https://github.com/h5p/h5p-exportable-text-area | sí |
| H5P.ImageHotspots | 1.10.31 | 2015 Joubel AS | MIT | library.json (README.md) | https://github.com/h5p/h5p-image-hotspots | no |
| H5P.InteractiveVideo | 1.28.37 | 2017 H5P | MIT | library.json (LICENCE.md) | https://github.com/h5p/h5p-interactive-video | no |
| H5P.QuestionSet | 1.21.13 | 2012-2014 Joubel AS | MIT | library.json (README.md) | https://github.com/h5p/h5p-question-set | no |
| H5P.Shape | 1.0.5 | Joubel AS (H5P Group AS) | MIT | library.json | https://github.com/h5p/h5p-shape | sí |
| H5P.TwitterUserFeed | 1.0.21 | Joubel AS (H5P Group AS) | MIT | library.json | https://github.com/h5p/h5p-twitter-user-feed | no |
| H5PEditor.BranchingQuestion | 1.0.5 | Joubel AS (H5P Group AS) | MIT | upstream repository verified 2026-10-01 | https://github.com/h5p/h5p-editor-branching-question | sí |
| H5PEditor.BranchingScenario | 1.5.13 | Joubel AS (H5P Group AS) | MIT | library.json | https://github.com/h5p/h5p-editor-branching-scenario | no |
| H5PEditor.CoursePresentation | 1.26.6 | 2012-2014 Joubel AS | MIT | local LICENCE/README file (README.md) | https://github.com/h5p/h5p-editor-course-presentation | no |
| H5PEditor.ImageCoordinateSelector | 1.2.7 | Joubel AS (H5P Group AS) | MIT | upstream repository verified 2026-10-01 | https://github.com/h5p/h5p-editor-image-coordinate-selector | sí |
| H5PEditor.InteractiveVideo | 1.26.3 | 2012-2014 Joubel AS | MIT | library.json (README.md) | https://github.com/h5p/h5p-editor-interactive-video | no |
| H5PEditor.RadioSelector | 1.2.2 | Joubel AS (H5P Group AS) | MIT | upstream repository verified 2026-10-01 | https://github.com/h5p/h5p-editor-radio-selector | sí |
| H5PEditor.Shape | 1.0.0 | Joubel AS (H5P Group AS) | MIT | upstream repository verified 2026-10-01 | https://github.com/h5p/h5p-editor-shape | sí |

## Commit upstream de las librerías sin tag

- H5P.QuestionSet 1.21.13: https://github.com/h5p/h5p-question-set/commit/48aa08f798c016a0bb9096804a6cf45fb890d3f7 — release del H5P Hub sin tag git upstream; carpeta byte a byte idéntica al commit «bump patch 1.21.13» (2026-03-04) de master.

## MIT License

Copyright (c) the copyright holders listed above for each library (Joubel AS / H5P Group AS).

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
