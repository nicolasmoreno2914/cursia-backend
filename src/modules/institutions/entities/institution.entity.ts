import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

@Entity('institutions')
export class Institution {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** UUID del usuario propietario — igual al auth.users.id de Supabase */
  @Index()
  @Column({ name: 'owner_id', length: 36 })
  ownerId: string;

  @Column({ length: 255 })
  name: string;

  @Index({ unique: true })
  @Column({ length: 120 })
  slug: string;

  /**
   * r75 (01 §1.1): columnas de supabase-migration-r75-access.sql. `select/insert/update: false` A PROPÓSITO: producción
   * no tiene la migración en r75, y TypeORM no debe nombrarlas en ninguna query de la entity (con los flags en off el
   * código no toca columnas nuevas). Se leen y escriben por SQL en InstitutionsService / AccessModule.
   */
  @Column({ type: 'text', default: 'organization', select: false, insert: false, update: false })
  kind: 'organization' | 'personal';

  @Column({ type: 'text', default: 'active', select: false, insert: false, update: false })
  status: 'active' | 'suspended' | 'archived';

  @Column({ name: 'created_by', length: 36, nullable: true, select: false, insert: false, update: false })
  createdBy: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
