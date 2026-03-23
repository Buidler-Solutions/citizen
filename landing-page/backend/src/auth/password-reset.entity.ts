import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { OnboardingUser } from '../user/onboarding-user.entity';

@Entity({ name: 'password_resets' })
export class PasswordReset {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => OnboardingUser, { eager: true, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user!: OnboardingUser;

  @Column({ name: 'user_id', length: 36 })
  userId!: string;

  @Column({ length: 180 })
  email!: string;

  @Column({ name: 'token_hash', length: 128 })
  tokenHash!: string;

  @Column({ name: 'expires_at', type: 'timestamp with time zone' })
  expiresAt!: Date;

  @Column({ name: 'used_at', type: 'timestamp with time zone', nullable: true })
  usedAt!: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;
}
