import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  OneToMany,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { CourseVersion } from '../../course-versions/entities/course-version.entity';
import { Institution } from '../../institutions/entities/institution.entity';

@Entity('courses')
export class Course {
  @PrimaryGeneratedColumn()
  id: number;

  // ── Ownership (Fase 6 — Supabase JWT Auth) ──────────────────────
  /** UUID del usuario propietario — igual al auth.users.id de Supabase */
  @Index()
  @Column({ name: 'owner_id', length: 36, nullable: true })
  ownerId: string;

  /** Email del propietario al momento de crear el curso (denormalizado para consultas) */
  @Column({ name: 'owner_email', length: 255, nullable: true })
  ownerEmail: string;

  /** Institución a la que pertenece el curso (opcional — habilita el brand kit "Mi Marca") */
  @Index()
  @Column({ name: 'institution_id', type: 'uuid', nullable: true })
  institutionId: string;

  @ManyToOne(() => Institution, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'institution_id' })
  institution: Institution;

  @Column({ length: 255 })
  title: string;

  @Column({ type: 'text', nullable: true })
  description: string;

  @Column({ length: 100, nullable: true })
  sector: string;

  @Column({ length: 100, nullable: true })
  level: string;

  @Column({ default: 'draft' })
  status: string; // draft | in_review | published | archived

  @Column({ name: 'structure_version', default: 'legacy' })
  structureVersion: string; // legacy | dynamic

  @Column({ name: 'structure_version_counter', default: 0 })
  structureVersionCounter: number; // optimistic concurrency para ediciones de estructura

  /**
   * Blueprint congelado vigente (Fase 3). Columna plana: la FK compuesta
   * (current_blueprint_id, id) → course_blueprints(id, course_id) la crea
   * supabase-migration-course-blueprints.sql; solo la escribe
   * CourseBlueprintsService.lock().
   *
   * Solo lectura para el ORM (insert/update: false): CoursesService.update
   * hace findOne → Object.assign → save(); con la columna escribible, una
   * entidad cargada antes de un lock() concurrente reescribía el puntero
   * viejo (o NULL) y revertía el Blueprint vigente en silencio — la FK
   * compuesta no lo ataja porque el viejo es un Blueprint válido del curso.
   */
  @Column({ name: 'current_blueprint_id', type: 'int', nullable: true, insert: false, update: false })
  currentBlueprintId: number | null;

  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, any>;

  // ── Storage (Fase 5 — Drive unificado) ──────────────────────────
  /** null | 'google_drive' | 'postgres_json' | 'external_url' */
  @Column({ name: 'storage_provider', length: 50, nullable: true })
  storageProvider: string;

  /** ID de la carpeta de Drive que agrupa los archivos de este curso */
  @Column({ name: 'storage_folder_id', type: 'text', nullable: true })
  storageFolderId: string;

  /** URL de la carpeta de Drive (webViewLink) */
  @Column({ name: 'storage_folder_url', type: 'text', nullable: true })
  storageFolderUrl: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  @OneToMany(() => CourseVersion, (version) => version.course)
  versions: CourseVersion[];
}
