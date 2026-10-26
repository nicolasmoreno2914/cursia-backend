import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AccessActor, auditActor } from './access-actor';
import { E } from './access-errors';
import { iso, r75AccessSchemaPresent } from './access-schema';
import { AuditLogService } from './audit-log.service';

export interface GenerationFreeze {
  enabled: boolean;
  reason: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

/**
 * r75 · A — interruptores de plataforma (no secretos). Hoy solo `generation_freeze` (01 §7): con `enabled` nadie
 * arranca, reintenta ni reanuda generaciones (403 platform_generation_frozen, lo aplican B/C), ni siquiera el SA,
 * que es quien la levanta. Los runs en curso siguen. Historia en admin_audit_log.
 */
@Injectable()
export class PlatformControlsService {
  private cache: { at: number; value: GenerationFreeze } | null = null;
  private static readonly TTL_MS = 5_000;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly audit: AuditLogService,
  ) {}

  async getGenerationFreeze(): Promise<GenerationFreeze> {
    const off: GenerationFreeze = { enabled: false, reason: null, updatedAt: null, updatedBy: null };
    if (!(await r75AccessSchemaPresent(this.dataSource))) return off;
    const rows: any[] = await this.dataSource.query(
      `select enabled, reason, updated_at, updated_by::text as updated_by from public.platform_controls where key = 'generation_freeze'`);
    const r = rows[0];
    return r ? { enabled: r.enabled === true, reason: r.reason ?? null, updatedAt: iso(r.updated_at), updatedBy: r.updated_by ?? null } : off;
  }

  /** Para B/C en cada arranque: caché de 5 s por proceso (la escritura local la invalida). */
  async isGenerationFrozen(): Promise<boolean> {
    const now = Date.now();
    if (this.cache && now - this.cache.at < PlatformControlsService.TTL_MS) return this.cache.value.enabled;
    const value = await this.getGenerationFreeze();
    this.cache = { at: now, value };
    return value.enabled;
  }

  async getControls(): Promise<{ generationFreeze: GenerationFreeze }> {
    return { generationFreeze: await this.getGenerationFreeze() };
  }

  async setGenerationFreeze(actor: AccessActor, body: { enabled?: unknown; reason?: unknown }): Promise<{ generationFreeze: GenerationFreeze }> {
    if (!(await r75AccessSchemaPresent(this.dataSource))) throw E.schemaMissing();
    if (typeof body?.enabled !== 'boolean') throw E.invalidInput('enabled debe ser booleano.');
    const reason = typeof body?.reason === 'string' ? body.reason.trim().slice(0, 1000) : '';
    if (!reason) throw E.reasonRequired();
    await this.dataSource.transaction(async (m) => {
      const prev: any[] = await m.query(`select enabled, reason from public.platform_controls where key = 'generation_freeze' for update`);
      await m.query(
        `insert into public.platform_controls (key, enabled, reason, updated_by, updated_at)
         values ('generation_freeze', $1, $2, $3, now())
         on conflict (key) do update set enabled = excluded.enabled, reason = excluded.reason,
                                         updated_by = excluded.updated_by, updated_at = now()`,
        [body.enabled, reason, actor.userId]);
      await this.audit.record({
        ...auditActor(actor), action: 'platform.generation_freeze', targetType: 'platform', targetId: 'generation_freeze',
        before: prev[0] ? { enabled: prev[0].enabled, reason: prev[0].reason } : { enabled: false },
        after: { enabled: body.enabled, reason },
      }, m);
    });
    this.cache = null;
    return this.getControls();
  }
}
