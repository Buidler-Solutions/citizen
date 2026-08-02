import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { AuthUser } from './auth-user.entity';

@Entity({ name: 'auth_sessions' })
@Index('IDX_auth_sessions_active_user', ['userId'], { where: 'revoked_at IS NULL' })
export class AuthSession {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @ManyToOne(() => AuthUser, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user!: AuthUser;

  @Column({ name: 'refresh_token_hash', length: 128 })
  refreshTokenHash!: string;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt!: Date;

  @Column({ name: 'revoked_at', type: 'timestamptz', nullable: true })
  revokedAt!: Date | null;

  @Column({ name: 'revoked_reason', type: 'varchar', length: 120, nullable: true })
  revokedReason!: string | null;

  @Column({ name: 'last_used_at', type: 'timestamptz', nullable: true })
  lastUsedAt!: Date | null;

  @Column({ name: 'user_agent', length: 255, default: '' })
  userAgent!: string;

  @Column({ name: 'ip_address', length: 80, default: '' })
  ipAddress!: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;

  @DeleteDateColumn({ name: 'deleted_at' })
  deletedAt!: Date | null;
}
