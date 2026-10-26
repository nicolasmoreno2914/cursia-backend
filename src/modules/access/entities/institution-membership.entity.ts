import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/** r75 · 01 §1.2. La tabla la crea supabase-migration-r75-access.sql (synchronize:false). Quitar = status 'removed'. */
@Entity({ name: 'institution_memberships', synchronize: false })
export class InstitutionMembership {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ name: 'institution_id', type: 'uuid' }) institutionId: string;
  @Column({ name: 'user_id', type: 'uuid' }) userId: string;
  @Column({ type: 'text' }) role: 'ADMIN_INSTITUCIONAL' | 'CREADOR' | 'APROBADOR_ACADEMICO' | 'CONSULTA';
  @Column({ type: 'text', default: 'active' }) status: 'active' | 'suspended' | 'removed';
  @Column({ name: 'created_by', type: 'uuid', nullable: true }) createdBy: string | null;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt: Date;
  @Column({ name: 'updated_by', type: 'uuid', nullable: true }) updatedBy: string | null;
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' }) updatedAt: Date;
}
