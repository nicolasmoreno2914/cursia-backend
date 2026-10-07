import type { CorsOptions } from '@nestjs/common/interfaces/external/cors-options.interface';

/**
 * CORS del API (una sola definición: main.ts y scripts/check-cors-methods.js la usan).
 *
 * LOOP 8.2.1: faltaba PUT — PUT /courses/:id/brief (8.1) y PUT /courses/:id/academic-context/outcomes (8.2) fallaban
 * en el navegador con «Failed to fetch» (el preflight no lo permitía) aunque los E2E por HTTP desde Node pasaban
 * (Node no aplica CORS). check-cors-methods.js exige que todo método usado por un controller esté aquí y lo prueba con
 * un Chrome real.
 */
export const CORS_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const;
/** Cabeceras que manda el cliente (24-backend-client.js: backendApiRequest). */
export const CORS_ALLOWED_HEADERS = ['Content-Type', 'Authorization'] as const;

export function corsOptions(env: NodeJS.ProcessEnv = process.env): CorsOptions {
  return {
    origin: env.CORS_ORIGIN ? env.CORS_ORIGIN.split(',') : '*',
    methods: [...CORS_METHODS],
    allowedHeaders: [...CORS_ALLOWED_HEADERS],
    credentials: false,
    // Task 4 (rendimiento): cada request con Authorization lleva un preflight OPTIONS (~200 ms de
    // ida y vuelta desde LatAm). Cachearlo 10 min en el navegador (Chrome topa en 2 h).
    maxAge: 600,
  };
}
