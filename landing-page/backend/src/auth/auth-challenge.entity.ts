import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity({ name: 'auth_challenges' })
export class AuthChallenge {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'wallet_address', length: 42 })
  walletAddress!: string;

  @Column({ length: 160 })
  domain!: string;

  @Column({ length: 255 })
  uri!: string;

  @Column({ name: 'chain_id', type: 'int' })
  chainId!: number;

  @Index({ unique: true })
  @Column({ length: 64 })
  nonce!: string;

  @Column({ type: 'text' })
  message!: string;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt!: Date;

  @Column({ name: 'used_at', type: 'timestamptz', nullable: true })
  usedAt!: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;
}
