import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

/** r75 · 01 §1.6. Una activa por (usuario, tipo). Levantar = lifted_* (una sola vez); historia inmutable (trigger). */
@Entity({ name: 'user_suspensions', synchronize: false })
export class UserSuspension {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ name: 'user_id', type: 'uuid' }) userId: string;
  @Column({ type: 'text' }) kind: 'account' | 'generation';
  @Column({ type: 'text' }) reason: string;
  @Column({ name: 'created_by', type: 'uuid' }) createdBy: string;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt: Date;
  @Column({ name: 'lifted_by', type: 'uuid', nullable: true }) liftedBy: string | null;
  @Column({ name: 'lifted_at', type: 'timestamptz', nullable: true }) liftedAt: Date | null;
  @Column({ name: 'lift_reason', type: 'text', nullable: true }) liftReason: string | null;
}
