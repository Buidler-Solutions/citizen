import { CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn, Column, Index } from 'typeorm';

@Entity({ name: 'auth_users' })
export class AuthUser {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index({ unique: true })
  @Column({ name: 'wallet_address', length: 42 })
  walletAddress!: string;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
