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

  @Column({ type: 'text' })
  missionNeed!: string;

  @CreateDateColumn()
  createdAt!: Date;
}
