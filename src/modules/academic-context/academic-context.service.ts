import { BadRequestException, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { CoursesService } from '../courses/courses.service';
import { assertDynamicOwnerAllowed } from '../features/dynamic-features';
import { loadCurrentPedagogicalProfile } from '../pedagogy/pedagogy-db';
import { academicOutcomeIds } from './academic-context';
import { loadCurrentAcademicContext } from './academic-db';
import { proposeStructureFromContext, suggestOutcomeLinks, suggestProfileFromContext } from './context-design';
import { DocumentReadError } from './extract/text-sources';
import { extractAcademicContext } from './extract/extractor';
import { validateAcademicContext } from './validate';
import { ExtractAcademicContextDto } from './dto/extract.dto';

/**
 * Fase 3 — Contexto académico: extracción (sin guardar) y diseño desde el contexto guardado. Sin proveedores
 * (USD 0), sin escrituras: guardar el contexto es POST /courses/:id/profiles/academic (versionado); aplicar las
 * sugerencias usa las APIs de siempre (perfil pedagógico, estructura).
 */
@Injectable()
export class AcademicContextService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly coursesService: CoursesService,
  ) {}

  private async loadCourse(courseId: number, ownerId: string): Promise<void> {
    const course = await this.coursesService.findOne(courseId, ownerId); // 404 si no es suyo
    if (course.structureVersion !== 'dynamic') {
      throw new BadRequestException(`El curso #${courseId} es "${course.structureVersion}" — esta API solo admite cursos "dynamic".`);
    }
  }

  async extract(courseId: number, ownerId: string, dto: ExtractAcademicContextDto) {
    assertDynamicOwnerAllowed(ownerId);
    await this.loadCourse(courseId, ownerId);
    const inputs = dto.files.map((f) => ({ name: f.name, data: Buffer.from(f.dataBase64, 'base64') }));
    try {
      const r = await extractAcademicContext(inputs);
      return { draft: r.context, validation: validateAcademicContext(r.context), notes: r.notes, stats: r.stats, saved: false };
    } catch (err) {
      if (err instanceof DocumentReadError) throw new BadRequestException({ code: err.code, message: `${err.code}: ${err.message}` });
      if (err instanceof Error && /^ACADEMIC_/.test(err.message)) throw new BadRequestException(err.message.slice(0, 500));
      throw err;
    }
  }

  /**
   * Lo que el contexto GUARDADO propone para el diseño: sugerencias al perfil pedagógico (sobre el perfil vigente),
   * estructura desde el microcurrículo y vínculos para la estructura actual. Solo lectura.
   */
  async design(courseId: number, ownerId: string) {
    await this.loadCourse(courseId, ownerId);
    const academic = await loadCurrentAcademicContext(this.dataSource, courseId);
    if (!academic) {
      return { available: false, reason: 'NO_ACADEMIC_CONTEXT', contextVersion: 0, validation: null, profileSuggestion: null, structureProposal: null, outcomeLinks: [] };
    }
    const validation = validateAcademicContext(academic.context);
    if (!validation.canProceed) {
      return { available: false, reason: 'CONTEXT_HAS_ERRORS', contextVersion: academic.version, validation, profileSuggestion: null, structureProposal: null, outcomeLinks: [] };
    }
    const ped = await loadCurrentPedagogicalProfile(this.dataSource, courseId);
    const chapters: { id: string; module_id: string; title: string; objective: string | null; description: string | null; outcome_ids: unknown }[] = await this.dataSource.query(
      `select ch.id, ch.module_id, ch.title, ch.objective, ch.description, to_jsonb(ch) -> 'outcome_ids' as outcome_ids
         from public.course_chapters ch join public.course_modules m on m.id = ch.module_id
        where ch.course_id = $1 order by m.position, ch.position, ch.id`,
      [courseId],
    );
    const known = academicOutcomeIds(academic.context);
    return {
      available: true,
      reason: null,
      contextVersion: academic.version,
      contextSha256: academic.sha256,
      validation,
      profileSuggestion: suggestProfileFromContext(academic.context, ped ? ped.profile : null),
      structureProposal: proposeStructureFromContext(academic.context),
      outcomeLinks: suggestOutcomeLinks(
        academic.context,
        chapters.map((c) => ({
          id: c.id, moduleId: c.module_id, title: c.title, objective: c.objective, description: c.description,
          // Un vínculo a un resultado que ya no existe en el contexto no cuenta como «decisión del docente».
          outcomeIds: Array.isArray(c.outcome_ids) ? (c.outcome_ids as string[]).filter((x) => known.has(x)) : null,
        })),
      ),
      providersCalled: 0,
    };
  }
}
