import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity({ name: 'interest_submissions' })
export class LeadInterest {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ length: 180 })
  fullName!: string;

  @Column({ length: 180 })
  institution!: string;

  @Column({ length: 180 })
  email!: string;

  @Column({ length: 120 })
  country!: string;

  @Column({ length: 80, default: 'builder' })
  role!: string;

  @Column({ type: 'text' })
  missionNeed!: string;

  @Column({ type: 'varchar', length: 120, nullable: true })
  walletSignerDid!: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  walletVerifyingKey!: string | null;

  @Column({ type: 'text', nullable: true })
  walletSignature!: string | null;

  @Column({ type: 'varchar', length: 71, nullable: true })
  walletPayloadHash!: string | null;

  @Column({ type: 'text', nullable: true })
  walletSigningPayload!: string | null;

  @Column({ type: 'varchar', length: 32, nullable: true, default: 'ed25519' })
  walletAlgorithm!: string | null;

  @CreateDateColumn()
  createdAt!: Date;
}
