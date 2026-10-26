/**
 * r76 «Diseño visual» — contexto y vista previa REAL del diseño visual de un curso.
 *
 *  - context: perfil de presentación vigente (o el default), las familias del Theme Engine con sus colores clave, la
 *    marca de la cuenta (logo del Brand Kit / de la cuenta, nombre de la institución) y quién guardó la versión vigente.
 *  - preview: arma con `buildDynamicMbzV3` (el builder del empaque real) un curso de MUESTRA fijo con el perfil pedido y
 *    devuelve el HTML de sus actividades tal como quedaron en el .mbz, el PDF del Libro Guía, la insignia y el informe
 *    de contraste. Sin IA, sin red, sin escribir nada: USD 0. Guardar sigue siendo POST /courses/:id/profiles/presentation.
 */
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { createHash } from 'crypto';
import { CourseProfilesService } from '../course-profiles/course-profiles.service';
import {
  PresentationProfile,
  defaultPresentationProfile,
  normalizePresentationProfile,
  presentationIdentityOf,
  profileSha256,
  validatePresentationProfile,
} from '../course-profiles/course-profiles';
import { THEME_FAMILIES, ResolvedTheme, ThemeFamilyId, ThemeMode, contrastRatio, resolveTheme, themeSha256 } from '../theme-engine';
import { LibroBrandV3, applyPresentationIdentity, loadAccountLibroBrandV3, resolvePackagingTheme } from '../dynamic-packaging/packaging-v3';
import { buildDynamicMbzV3 } from '../../package/dynamic-mbz-builder-v3';
import { resolveLibroLogo } from '../../package/v3/libro-logo';
import { PREVIEW_COURSE_TITLE, previewPackagingInput } from './preview-fixture';
import { MbzActivityHtml, displayableHtml, readMbzActivities } from './preview-extract';

/** Muestras de la vista previa: qué actividad del curso de muestra se muestra y con qué nombre. */
export const PREVIEW_SAMPLES: ReadonlyArray<{ key: string; title: string; description: string; match: (idnumber: string) => boolean }> = [
  { key: 'welcome', title: 'Bienvenida del curso', description: 'Primera pantalla del curso en Moodle (sección 0).', match: (i) => i === 'cv3:shell:welcome' },
  { key: 'route', title: 'Ruta de aprendizaje', description: 'Recorrido del curso por módulos y capítulos.', match: (i) => i === 'cv3:shell:route' },
  { key: 'module', title: 'Presentación del módulo', description: 'Apertura de cada módulo con sus resultados.', match: (i) => i.startsWith('cv3:module_intro:') },
  { key: 'lesson', title: 'Lección del capítulo', description: 'Contenido HTML del capítulo (apertura).', match: (i) => /^cv3:ch:[^:]+:opening$/.test(i) },
  { key: 'lesson_deep', title: 'Lección: profundización', description: 'Tarjetas, pestañas, comparaciones y pasos.', match: (i) => /^cv3:ch:[^:]+:deepening$/.test(i) },
  { key: 'cover', title: 'Portada de la presentación', description: 'Marco de la presentación del capítulo (la imagen la genera Gamma).', match: (i) => /^cv3:ch:[^:]+:presentation$/.test(i) },
  { key: 'activity', title: 'Tarjeta de actividad', description: 'Llamado a la práctica del capítulo.', match: (i) => /^cv3:ch:[^:]+:activity_instruction$/.test(i) },
  { key: 'libro_card', title: 'Acceso al Libro Guía', description: 'Tarjeta que abre el Libro Guía en PDF.', match: (i) => i === 'cv3:shell:libro' },
  { key: 'exam', title: 'Introducción a la evaluación', description: 'Antes de cada evaluación del módulo.', match: (i) => i.startsWith('cv3:exam_info:') },
  { key: 'closing', title: 'Cierre del curso', description: 'Última pantalla del curso.', match: (i) => i === 'cv3:shell:closing' },
];

export interface PreviewSample {
  key: string;
  title: string;
  description: string;
  idnumber: string;
  modname: string;
  /** HTML exacto del .mbz (sin tocar). */
  packagedHtml: string;
  /** El mismo HTML con las imágenes del paquete como data URI (para mostrarlo en un iframe con sandbox). */
  html: string;
  sha256: string;
}

export interface ContrastPair {
  key: string;
  label: string;
  fg: string;
  bg: string;
  ratio: number;
  min: number;
  ok: boolean;
}

const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Pares de contraste del tema resuelto (WCAG AA: 4,5:1 texto normal) + el color pedido antes de corregirlo. */
export function contrastReport(theme: ResolvedTheme, requestedAccent?: string | null): { pairs: ContrastPair[]; requested: { accent: string; onBg: number; applied: string; adjusted: boolean } | null; adjustments: string[] } {
  const c = theme.color;
  const pair = (key: string, label: string, fg: string, bg: string, min = 4.5): ContrastPair => {
    const ratio = round2(contrastRatio(fg, bg));
    return { key, label, fg, bg, ratio, min, ok: ratio >= min };
  };
  const pairs = [
    pair('text_bg', 'Texto principal sobre el fondo', c.textPrimary, c.bg),
    pair('text2_bg', 'Texto secundario sobre el fondo', c.textSecondary, c.bg),
    pair('accent_text', 'Títulos y enlaces de acento sobre el fondo', c.accentStrong, c.bg),
    pair('on_accent', 'Texto de los botones sobre el color principal', c.textOnAccent, c.accent),
    pair('text_surface', 'Texto sobre tarjetas', c.textPrimary, c.surfaceAlt),
  ];
  const requested = requestedAccent
    ? { accent: requestedAccent.toUpperCase(), onBg: round2(contrastRatio(requestedAccent, c.bg)), applied: c.accent.toUpperCase(), adjusted: requestedAccent.toUpperCase() !== c.accent.toUpperCase() }
    : null;
  return { pairs, requested, adjustments: [...theme.adjustments] };
}

interface CacheEntry {
  at: number;
  value: any;
}

@Injectable()
export class VisualDesignService {
  private readonly logger = new Logger('VisualDesign');
  private readonly cache = new Map<string, CacheEntry>();
  private static readonly CACHE_MAX = 24;

  constructor(
    private readonly dataSource: DataSource,
    private readonly profiles: CourseProfilesService,
  ) {}

  /** Familias del Theme Engine con los colores clave de cada modo (sin marca). */
  families(): Array<{ id: ThemeFamilyId; label: string; modes: ThemeMode[]; defaultMode: ThemeMode; swatches: Record<string, { bg: string; surface: string; text: string; accent: string; modules: string[]; fontBody: string; fontHeading: string }> }> {
    return (Object.keys(THEME_FAMILIES) as ThemeFamilyId[]).map((id) => {
      const f = THEME_FAMILIES[id];
      const swatches: Record<string, any> = {};
      for (const m of f.supportedModes) {
        const t = resolveTheme({ themeFamily: id, mode: m });
        swatches[m] = { bg: t.color.bg, surface: t.color.surfaceAlt, text: t.color.textPrimary, accent: t.color.accent, modules: t.moduleColorsBasis.slice(0, 4), fontBody: t.typography.fontBody, fontHeading: t.typography.fontHeading };
      }
      return { id, label: f.label, modes: [...f.supportedModes], defaultMode: f.defaultMode, swatches };
    });
  }

  private async courseRow(courseId: number): Promise<{ title: string; ownerId: string | null; institutionId: string | null }> {
    const [c] = await this.dataSource.query(`select title, owner_id, institution_id from public.courses where id = $1`, [courseId]);
    return { title: String(c?.title ?? ''), ownerId: c?.owner_id ?? null, institutionId: c?.institution_id ?? null };
  }

  async context(courseId: number, ownerId: string, actorId: string, paletteId?: string | null) {
    const current = await this.profiles.getCurrent(courseId, ownerId, 'presentation', paletteId ?? null); // ownership + dynamic
    const course = await this.courseRow(courseId);
    const account = await loadAccountLibroBrandV3(this.dataSource as any, courseId, course.ownerId ?? ownerId);
    const accountLogo = account.candidates.length ? resolveLibroLogo(account.candidates) : null;
    const profile = current.profile as PresentationProfile;
    return {
      courseId,
      courseTitle: course.title,
      profile,
      version: current.version,
      isDefault: current.isDefault,
      defaultSource: (current as any).defaultSource ?? null,
      createdAt: current.createdAt,
      savedBy: current.createdBy ? { byYou: current.createdBy === actorId } : null,
      identity: presentationIdentityOf(profile),
      defaults: { profile: defaultPresentationProfile(), identity: presentationIdentityOf(null) },
      families: this.families(),
      account: {
        institutionName: account.name,
        // El logo de la cuenta YA validado (el mismo que usará el Libro); null = no hay o no valida (→ Cursia).
        logo: accountLogo && accountLogo.source !== 'cursia_default'
          ? { source: accountLogo.source, dataUri: `data:image/${accountLogo.kind};base64,${accountLogo.bytes.toString('base64')}`, width: accountLogo.width, height: accountLogo.height }
          : null,
        logoWarnings: [...account.warnings, ...(accountLogo?.warnings ?? [])],
      },
    };
  }

  /** Vista previa real: valida el perfil pedido, arma el curso de muestra con el builder del empaque y lo lee. */
  async preview(courseId: number, ownerId: string, data: unknown, opts: { includePackage?: boolean } = {}) {
    const errors = validatePresentationProfile(data);
    if (errors.length) {
      throw new BadRequestException({ code: 'PRESENTATION_PROFILE_INVALID', message: `Perfil de presentación inválido: ${errors.map((e) => `${e.path || '(raíz)'}: ${e.message}`).join('; ')}`, errors });
    }
    await this.profiles.getCurrent(courseId, ownerId, 'presentation'); // ownership + curso dynamic (404/400 como el resto)
    const profile = normalizePresentationProfile(data);
    const course = await this.courseRow(courseId);
    const account = await loadAccountLibroBrandV3(this.dataSource as any, courseId, course.ownerId ?? ownerId);
    const brand: LibroBrandV3 = applyPresentationIdentity(account, presentationIdentityOf(profile));
    const input = resolvePackagingTheme({ presentationProfile: profile }).input;
    let theme: ResolvedTheme;
    try {
      theme = resolveTheme(input);
    } catch (err) {
      throw new BadRequestException({ code: 'THEME_INVALID', message: err instanceof Error ? err.message : String(err) });
    }
    const brandKey = sha(`${brand.candidates.map((c) => `${c.source}:${sha(c.dataUri)}`).join(',')}|${brand.name ?? ''}|${brand.watermark === false ? 0 : 1}|${brand.showInCourse ? 1 : 0}`);
    const key = sha(`${profileSha256(profile)}|${brandKey}|${opts.includePackage ? 1 : 0}`);
    const hit = this.cache.get(key);
    if (hit) return { ...hit.value, cached: true };

    const t0 = Date.now();
    const built = await buildDynamicMbzV3(previewPackagingInput(input, {
      logo: brand.candidates,
      name: brand.name,
      ...(brand.watermark === false ? { watermark: false } : {}),
      ...(brand.showInCourse ? { showInCourse: true } : {}),
    }));
    const acts = await readMbzActivities(built.mbz);
    const samples: PreviewSample[] = [];
    for (const s of PREVIEW_SAMPLES) {
      const a = acts.find((x) => s.match(x.idnumber));
      if (!a) continue;
      samples.push(sampleOf(s, a));
    }
    const libroAct = acts.find((x) => x.idnumber === 'cv3:shell:libro');
    const libroPdf = libroAct ? [...libroAct.files.values()].find((f) => f.mime === 'application/pdf') : undefined;
    const badge = await badgePng(built.mbz);
    const requestedAccent = profile.brandSeed?.accent ?? null;
    const value = {
      courseId,
      sampleCourseTitle: PREVIEW_COURSE_TITLE,
      profile,
      profileSha256: profileSha256(profile),
      theme: {
        familyId: theme.familyId,
        familyLabel: THEME_FAMILIES[theme.familyId].label,
        mode: theme.mode,
        sha256: themeSha256(theme),
        color: theme.color,
        fonts: { body: theme.typography.fontBody, heading: theme.typography.fontHeading },
        moduleColors: theme.moduleColorsBasis.slice(0, 4),
      },
      contrast: contrastReport(theme, requestedAccent),
      logo: { source: built.summary.libro.logoSource, sha256: built.summary.libro.logoSha256 },
      institutionName: brand.name,
      libro: libroPdf ? { filename: built.summary.libro.filename, pageCount: built.summary.libro.pageCount, sha1: libroPdf.sha1, pdfBase64: libroPdf.bytes.toString('base64') } : null,
      badge: badge ? { dataUri: `data:image/png;base64,${badge.toString('base64')}` } : null,
      samples,
      warnings: built.summary.warnings.filter((w: string) => /logo|theme|brand/i.test(w)),
      builderVersion: built.summary.builderVersion,
      ...(opts.includePackage ? { package: { filename: 'cursia-muestra-diseno.mbz', sizeBytes: built.mbz.length, sha256: sha(built.mbz), base64: built.mbz.toString('base64') } } : {}),
      ms: Date.now() - t0,
    };
    if (this.cache.size >= VisualDesignService.CACHE_MAX) this.cache.delete(this.cache.keys().next().value as string);
    this.cache.set(key, { at: Date.now(), value });
    return value;
  }
}

function sampleOf(s: (typeof PREVIEW_SAMPLES)[number], a: MbzActivityHtml): PreviewSample {
  return { key: s.key, title: s.title, description: s.description, idnumber: a.idnumber, modname: a.modname, packagedHtml: a.html, html: displayableHtml(a), sha256: sha(a.html) };
}

/** Imagen de la insignia del curso (badges/<id>/…/badge.png o la que el builder haya dejado en files.xml de badges). */
async function badgePng(mbz: Buffer): Promise<Buffer | null> {
  const JSZip = await import('jszip');
  const zip = await (JSZip as any).loadAsync(mbz);
  const filesXml: string = (await zip.file('files.xml')?.async('string')) ?? '';
  const m = /<file id="\d+">(?:(?!<\/file>)[\s\S])*?<component>badges<\/component>(?:(?!<\/file>)[\s\S])*?<\/file>/.exec(filesXml);
  if (!m) return null;
  const hash = (/<contenthash>([0-9a-f]{40})<\/contenthash>/.exec(m[0]) || [])[1];
  if (!hash) return null;
  const f = zip.file(`files/${hash.slice(0, 2)}/${hash}`);
  return f ? f.async('nodebuffer') : null;
}
