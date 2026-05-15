import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * Almacena la conexión de YouTube por usuario.
 * El refresh_token se guarda SIEMPRE cifrado (AES-256-GCM).
 * Un usuario tiene máximo una conexión activa.
 */
@Entity('youtube_connections')
export class YoutubeConnection {
  @PrimaryGeneratedColumn()
  id: number;

  /** UUID del usuario en Supabase auth.users — único por usuario */
  @Index({ unique: true })
  @Column({ name: 'user_id' })
  userId: string;

  @Column({ name: 'user_email', nullable: true, type: 'varchar', length: 255 })
  userEmail: string | null;

  /** El 'sub' del ID token de Google — identifica la cuenta Google */
  @Column({ name: 'google_subject', nullable: true, type: 'varchar', length: 255 })
  googleSubject: string | null;

  /** ID del canal de YouTube (ej: UCxxxxxxxxxxxxxx) */
  @Column({ name: 'channel_id', type: 'varchar', length: 100 })
  channelId: string;

  @Column({ name: 'channel_title', nullable: true, type: 'varchar', length: 255 })
  channelTitle: string | null;

  @Column({ name: 'channel_thumbnail_url', nullable: true, type: 'text' })
  channelThumbnailUrl: string | null;

  /** AES-256-GCM ciphertext + authTag (16 bytes) — en base64 */
  @Column({ name: 'encrypted_refresh_token', type: 'text' })
  encryptedRefreshToken: string;

  /** IV de 12 bytes (GCM) — en base64 */
  @Column({ name: 'token_iv', type: 'varchar', length: 32 })
  tokenIv: string;

  /** Scopes autorizados, separados por coma */
  @Column({ nullable: true, type: 'text' })
  scopes: string | null;

  /**
   * Estado de la conexión:
   * - active          → token válido, listo para usar
   * - revoked         → usuario desconectó YouTube
   * - reauth_required → token expirado/inválido, requiere reconexión
   */
  @Column({ type: 'varchar', length: 50, default: 'active' })
  status: 'active' | 'revoked' | 'reauth_required';

  @Column({ name: 'connected_at', type: 'timestamp', default: () => 'NOW()' })
  connectedAt: Date;

  @Column({ name: 'last_used_at', type: 'timestamp', nullable: true })
  lastUsedAt: Date | null;

  @Column({ name: 'revoked_at', type: 'timestamp', nullable: true })
  revokedAt: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
