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

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
