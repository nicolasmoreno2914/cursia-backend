import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { Institution } from '../../institutions/entities/institution.entity';

export type BrandProfileStatus =
  | 'draft'
  | 'pending_review'
  | 'active'
  | 'archived';

@Entity('brand_profiles')
@Index('idx_brand_profiles_one_active', ['institutionId'], {
  unique: true,
  where: `status = 'active'`,
})
export class BrandProfile {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ name: 'institution_id', type: 'uuid' })
  institutionId: string;

  @ManyToOne(() => Institution, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'institution_id' })
  institution: Institution;

  /** Versión incremental por institución. Nunca se edita una fila active: subir un manual nuevo crea una versión nueva. */
  @Column({ type: 'int', default: 1 })
  version: number;

  @Column({ type: 'text', default: 'draft' })
  status: BrandProfileStatus;

  /** Artifact del PDF del manual de marca subido (Fase 2, nullable en carga manual) */
  @Column({ name: 'source_artifact_id', type: 'uuid', nullable: true })
  sourceArtifactId: string;

  /** Output crudo de la extracción por IA, incluye warnings[] del linter de contraste */
  @Column({ name: 'extracted_raw', type: 'jsonb', nullable: true })
  extractedRaw: Record<string, any>;

  /**
   * Paleta en la MISMA forma que un objeto de PALETTES[] del frontend:
   * { id, name, desc, cat:'marca', m1, m1a, m2, m2a, m3, m3a, accent, dark,
   *   logoUrl, source:'brand_profile', brandProfileId }
   */
  @Column({ type: 'jsonb' })
  palette: Record<string, any>;

  @Column({ name: 'logo_artifact_id', type: 'uuid', nullable: true })
  logoArtifactId: string;

  @Column({ type: 'jsonb', nullable: true })
  typography: Record<string, any>;

  @Column({ name: 'usage_rules', type: 'jsonb', nullable: true })
  usageRules: Record<string, any>;

  @Column({ name: 'reviewed_by', length: 36, nullable: true })
  reviewedBy: string;

  @Column({ name: 'reviewed_at', type: 'timestamptz', nullable: true })
  reviewedAt: Date;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
