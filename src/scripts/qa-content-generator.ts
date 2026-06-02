import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import {
  ContentGenerationInputPayload,
  generateCourseContent,
} from '../modules/content-generation/content-generation.service';

async function main() {
  assert.equal(typeof (globalThis as any).window, 'undefined', 'window must be undefined in Node QA');
  assert.equal(typeof (globalThis as any).document, 'undefined', 'document must be undefined in Node QA');

  const payload: ContentGenerationInputPayload = {
    courseId: 'qa-content-generator-local',
    frontendJobId: `qa-${Date.now()}`,
    executionMode: 'backend_content',
    contentConfig: {
      model: 'template-only',
      maxRetriesPerFile: 3,
    },
    courseData: {
      nombre: 'Curso QA Backend Content',
      comp: 'Aplicar un flujo de generacion backend sin navegador',
      pais: 'Colombia',
      ciudad: 'Bogota',
      sector: 'Educacion',
      nivel: 'basico',
      tono: 'practico',
      contexto: 'Prueba local para validar generacion backend compatible con Cursia.',
      obj: 'Generar un D y un F consistentes para el pipeline SaaS.',
      horas: 24,
      mods: [
        { n: 'Fundamentos', caps: ['Panorama general', 'Roles y contexto', 'Buenas practicas'] },
        { n: 'Aplicacion', caps: ['Planeacion', 'Ejecucion', 'Seguimiento'] },
        { n: 'Cierre', caps: ['Evaluacion', 'Mejora', 'Transferencia'] },
      ],
    },
    options: {
      overwriteExistingContent: false,
    },
    metadata: {
      source: 'qa-local',
    },
  };

  const progressEvents: string[] = [];
  const result = await generateCourseContent(payload, {
    onProgress(event) {
      progressEvents.push(`${event.phase}:${event.done}/${event.total}:${event.file}`);
    },
  });

  assert.ok(result && typeof result === 'object', 'result must exist');
  assert.ok(result.D && typeof result.D === 'object', 'D must exist');
  assert.ok(result.F && typeof result.F === 'object', 'F must exist');
  assert.ok(Object.keys(result.F).length > 0, 'F must contain generated files');
  assert.ok(result.summary && typeof result.summary === 'object', 'summary must exist');
  assert.ok(result.summary.fileCount === Object.keys(result.F).length, 'summary fileCount must match F');
  assert.ok(progressEvents.length > 0, 'progress callbacks must run');

  assert.ok(result.F['libro_guia_completo.html'], 'compiled book html must exist');
  assert.ok(result.F['scorm_cap1_index.html'], 'scorm placeholder must exist');
  assert.ok(result.F['examen_final.gift'], 'final exam must exist');
  assert.ok(result.F['seccion1_ruta_aprendizaje.html'], 'route page must exist');

  const forbiddenMatches = JSON.stringify(result).match(
    /(window\.|document\.|localStorage|indexedDB|access_token|refresh_token|api_key)/i,
  );
  assert.equal(forbiddenMatches, null, 'generated payload must not include browser deps or secrets');

  console.log(
    JSON.stringify(
      {
        ok: true,
        fileCount: result.summary.fileCount,
        filesSample: Object.keys(result.F).slice(0, 12),
        progressEvents: progressEvents.slice(0, 8),
        summary: result.summary,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error('[qa:content-generator] failed:', error instanceof Error ? error.stack || error.message : error);
  process.exit(1);
});
