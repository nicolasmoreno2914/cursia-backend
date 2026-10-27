import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/** r75 · 01 §1.6. Append-only (trigger). SIN secretos en before/after. Se escribe solo vía AuditLogService. */
@Entity({ name: 'admin_audit_log', synchronize: false })
export class AdminAuditLog {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' }) id: string;
  @Column({ type: 'timestamptz' }) at: Date;
  @Column({ name: 'actor_id', type: 'uuid' }) actorId: string;
  @Column({ name: 'actor_email', type: 'text', nullable: true }) actorEmail: string | null;
  @Column({ name: 'actor_is_superadmin', type: 'boolean' }) actorIsSuperAdmin: boolean;
  @Column({ type: 'text' }) action: string;
  @Column({ name: 'target_type', type: 'text' }) targetType: string;
  @Column({ name: 'target_id', type: 'text', nullable: true }) targetId: string | null;
  @Column({ name: 'institution_id', type: 'uuid', nullable: true }) institutionId: string | null;
  @Column({ type: 'jsonb', nullable: true }) before: unknown;
  @Column({ type: 'jsonb', nullable: true }) after: unknown;
  @Column({ name: 'request_id', type: 'text', nullable: true }) requestId: string | null;
  @Column({ name: 'ip_hash', type: 'text', nullable: true }) ipHash: string | null;
}
