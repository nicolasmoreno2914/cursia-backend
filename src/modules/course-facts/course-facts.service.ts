import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { assertDynamicOwnerAllowed } from '../features/dynamic-features';
import { loadCourseFacts } from './course-facts-db';
import {
  BRIEF_KEY,
  BRIEF_VERSION,
  CourseBrief,
  CourseFacts,
  normalizeBriefFields,
  parseBrief,
} from './course-facts';
import { PutBriefDto } from './dto/put-brief.dto';

type Q = { query(sql: string, params?: any[]): Promise<any> };

/** LOOP 8.1 · Pedido del curso (courses.metadata.brief) y «Lo que sabemos del curso» (lectura única). Sin proveedores. */
@Injectable()
export class CourseFactsService {
  constructor(private readonly dataSource: DataSource) {}

  /** Mismo filtro de ownership que CoursesService.findOne; solo cursos dinámicos. */
  private async courseRow(q: Q, courseId: number, ownerId: string, forUpdate = false) {
    const allowUnowned = process.env.ALLOW_UNOWNED_COURSES === 'true';
    const rows = await q.query(
      `select id, title, structure_version, institution_id, metadata from public.courses
        where id = $1 and (owner_id = $2 or ($3 = true and owner_id is null))${forUpdate ? ' for update' : ''}`,
      [courseId, ownerId, allowUnowned],
    );
    const row = rows[0];
    if (!row) throw new NotFoundException(`Course #${courseId} not found`);
    if (row.structure_version !== 'dynamic') {
      throw new BadRequestException(`El curso #${courseId} es "${row.structure_version}" — esta API solo admite cursos "dynamic".`);
    }
    return row;
  }

  async getBrief(courseId: number, ownerId: string): Promise<{ brief: CourseBrief | null }> {
    const row = await this.courseRow(this.dataSource, courseId, ownerId);
    return { brief: parseBrief(row.metadata ? row.metadata[BRIEF_KEY] : null) };
  }

  async putBrief(courseId: number, ownerId: string, dto: PutBriefDto): Promise<{ brief: CourseBrief; changed: boolean }> {
    assertDynamicOwnerAllowed(ownerId);
    const qr = this.dataSource.createQueryRunner();
    try {
      await qr.connect();
      await qr.startTransaction();
      const row = await this.courseRow(qr, courseId, ownerId, true);
      const prev = parseBrief(row.metadata ? row.metadata[BRIEF_KEY] : null);
      const fields = normalizeBriefFields(dto as Record<string, unknown>);
      if (prev && JSON.stringify(prev.fields) === JSON.stringify(fields)) {
        await qr.rollbackTransaction();
        return { brief: prev, changed: false };
      }
      const brief: CourseBrief = { briefVersion: BRIEF_VERSION, fields, updatedAt: new Date().toISOString() };
      await qr.query(
        `update public.courses set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), $2::text[], $3::jsonb, true) where id = $1`,
        [courseId, [BRIEF_KEY], JSON.stringify(brief)],
      );
      await qr.commitTransaction();
      return { brief, changed: true };
    } catch (err) {
      if (qr.isTransactionActive) await qr.rollbackTransaction();
      throw err;
    } finally {
      await qr.release();
    }
  }

  async getFacts(courseId: number, ownerId: string): Promise<CourseFacts> {
    const row = await this.courseRow(this.dataSource, courseId, ownerId);
    return this.factsFor(this.dataSource, courseId, row);
  }

  private factsFor(q: Q, courseId: number, row: any): Promise<CourseFacts> {
    return loadCourseFacts(q, courseId, row);
  }
}
