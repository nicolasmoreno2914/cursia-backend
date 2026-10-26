import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

/** r75 · 01 §1.3. Una fila vigente por (institución, usuario, permiso); revocar = revoked_*; sin DELETE físico. */
@Entity({ name: 'institution_permission_overrides', synchronize: false })
export class InstitutionPermissionOverride {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ name: 'institution_id', type: 'uuid' }) institutionId: string;
  @Column({ name: 'user_id', type: 'uuid' }) userId: string;
  @Column({ type: 'text' }) permission: string;
  @Column({ type: 'text' }) effect: 'grant' | 'deny';
  @Column({ type: 'text', nullable: true }) reason: string | null;
  @Column({ name: 'created_by', type: 'uuid' }) createdBy: string;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt: Date;
  @Column({ name: 'revoked_by', type: 'uuid', nullable: true }) revokedBy: string | null;
  @Column({ name: 'revoked_at', type: 'timestamptz', nullable: true }) revokedAt: Date | null;
}
