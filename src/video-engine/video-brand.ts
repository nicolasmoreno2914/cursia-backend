/**
 * Marca (logo + nombre) de los videos de Videogen de un curso: la MISMA que el Libro Guía.
 *
 * Videogen atiende a todos los clientes de Cursia con una sola API key; sin esta marca usaba la de esa
 * cuenta (un único logo para todos los cursos). Orden, idéntico al del Libro (loadLibroBrandV3 +
 * resolveLibroLogo):
 *   1. «Diseño visual» del curso: logo propio ('custom') o logo de Cursia ('cursia');
 *   2. Brand Kit activo de la institución del curso;
 *   3. «Logo del centro» de la cuenta del dueño (user_settings.logo_b64);
 *   4. logo oficial de Cursia (también si el de la cuenta no valida).
 * Nombre: el mismo del Libro; si no hay, o es el automático de un espacio personal («Espacio de
 * correo@…»: el correo no debe salir en la portada del video), «Cursia».
 */
import { loadLibroBrandV3, loadPackagingProfilesV3 } from '../modules/dynamic-packaging/packaging-v3';
import { QueryExecutor } from '../modules/dynamic-packaging/artifact-resolver';
import { LibroLogoSource, resolveLibroLogo } from '../package/v3/libro-logo';

/** Lo que recibe Videogen en `brand` (POST /api/external/videos/batch-create). */
export interface VideogenBrand {
  logo_data_uri: string;
  institution_name: string;
}

export interface ResolvedVideoBrand {
  brand: VideogenBrand;
  logoSource: LibroLogoSource;
  warnings: string[];
}

export const VIDEO_BRAND_DEFAULT_NAME = 'Cursia';

/** Nombre para el video: nunca un correo (los espacios personales se llaman «Espacio de correo@…»). */
export function videoInstitutionName(name: string | null | undefined): string {
  const n = name?.trim();
  return n && !/\S+@\S+\.\S+/.test(n) ? n : VIDEO_BRAND_DEFAULT_NAME;
}

export async function loadVideoBrand(q: QueryExecutor, courseId: number, ownerId: string | null): Promise<ResolvedVideoBrand> {
  const warnings: string[] = [];
  // Solo la identidad del perfil de presentación: un tema inválido no debe dejar al video sin marca
  let identity = null;
  try {
    identity = (await loadPackagingProfilesV3(q, courseId, false)).identity;
  } catch (err) {
    warnings.push(`video_brand_profile_unavailable:${(err instanceof Error ? err.message : String(err)).slice(0, 80)}`);
  }
  const brand = await loadLibroBrandV3(q, courseId, ownerId, identity);
  const logo = resolveLibroLogo(brand.candidates);
  return {
    brand: {
      logo_data_uri: `data:image/${logo.kind};base64,${logo.bytes.toString('base64')}`,
      institution_name: videoInstitutionName(brand.name),
    },
    logoSource: logo.source,
    warnings: [...warnings, ...brand.warnings, ...logo.warnings],
  };
}
