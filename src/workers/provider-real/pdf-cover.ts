// ─────────────────────────────────────────────────────────────────────────────
// Cursia V2.1 F2 — portada de la presentación: página 1 del PDF de Gamma → PNG,
// igual que el legacy (gamma-worker.ts renderPdfFirstPageToPng: `pdftoppm`,
// poppler-utils, instalado en el VPS por deploy.yml).
//
// Diferencia deliberada con el legacy: allá la portada era best-effort (label
// sin imagen); en V2.1 la portada es obligatoria (contrato R9: `cover` con
// dimensiones medidas). La API de Gamma no documenta una miniatura/imagen de
// portada, así que no hay fuente alternativa: si `pdftoppm` no está, se falla
// FUERTE con GAMMA_COVER_RASTERIZER_UNAVAILABLE — y ese chequeo corre ANTES de
// enviar la generación a Gamma (sin gasto).
// ─────────────────────────────────────────────────────────────────────────────
import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const execFileAsync = promisify(execFile);

export const GAMMA_COVER_RASTERIZER_UNAVAILABLE = 'GAMMA_COVER_RASTERIZER_UNAVAILABLE';
export const GAMMA_COVER_RENDER_FAILED = 'GAMMA_COVER_RENDER_FAILED';
export const PDFTOPPM_BIN_ENV = 'PDFTOPPM_BIN';

export class CoverError extends Error {
  constructor(public readonly code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'CoverError';
  }
}

export interface CoverRasterizer {
  /** true si la herramienta nativa está disponible (se chequea ANTES del gasto). */
  available(): Promise<boolean>;
  /** PNG de la página 1. Lanza CoverError si falla. */
  firstPagePng(pdf: Buffer): Promise<Buffer>;
}

function bin(env: Record<string, string | undefined> = process.env): string {
  return (env[PDFTOPPM_BIN_ENV] ?? '').trim() || 'pdftoppm';
}

/** `pdftoppm` real (mismos flags que el legacy: -png -f 1 -l 1 -r 150). */
export function pdftoppmRasterizer(env: Record<string, string | undefined> = process.env): CoverRasterizer {
  return {
    async available() {
      try {
        await execFileAsync(bin(env), ['-v'], { timeout: 10_000 });
        return true;
      } catch (err: any) {
        // `pdftoppm -v` imprime la versión por stderr y sale 0 (poppler) o 99 (xpdf): solo ENOENT = ausente.
        return !!err && err.code !== 'ENOENT' && typeof err.code === 'number';
      }
    },
    async firstPagePng(pdf: Buffer) {
      let dir: string | null = null;
      try {
        dir = await mkdtemp(join(tmpdir(), 'cursia-v21-cover-'));
        const pdfPath = join(dir, 'in.pdf');
        await writeFile(pdfPath, pdf);
        await execFileAsync(bin(env), ['-png', '-f', '1', '-l', '1', '-r', '150', pdfPath, join(dir, 'out')], { timeout: 120_000 });
        // pdftoppm nombra con padding variable ("out-01.png"): se busca el .png real.
        const png = (await readdir(dir)).find((f) => f.endsWith('.png'));
        if (!png) throw new CoverError(GAMMA_COVER_RENDER_FAILED, 'pdftoppm no generó ningún .png');
        return await readFile(join(dir, png));
      } catch (err) {
        if (err instanceof CoverError) throw err;
        if ((err as any)?.code === 'ENOENT') throw new CoverError(GAMMA_COVER_RASTERIZER_UNAVAILABLE, 'pdftoppm no está instalado');
        throw new CoverError(GAMMA_COVER_RENDER_FAILED, `pdftoppm falló (${err instanceof Error ? err.message.slice(0, 200) : String(err)})`);
      } finally {
        if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      }
    },
  };
}
