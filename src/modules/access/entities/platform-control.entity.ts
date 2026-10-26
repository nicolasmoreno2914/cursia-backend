import { Column, Entity, PrimaryColumn } from 'typeorm';

/** r75 · 01 §1.6. Interruptores de plataforma (hoy solo 'generation_freeze'). */
@Entity({ name: 'platform_controls', synchronize: false })
export class PlatformControl {
  @PrimaryColumn({ type: 'text' }) key: 'generation_freeze';
  @Column({ type: 'boolean' }) enabled: boolean;
  @Column({ type: 'text', nullable: true }) reason: string | null;
  @Column({ name: 'updated_by', type: 'uuid' }) updatedBy: string;
  @Column({ name: 'updated_at', type: 'timestamptz' }) updatedAt: Date;
}
