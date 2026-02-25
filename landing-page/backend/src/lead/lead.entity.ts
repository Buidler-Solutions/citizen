import { randomUUID } from 'node:crypto';
import {
  BeforeInsert,
  Column,
  CreateDateColumn,
  Entity,
  PrimaryColumn,
} from 'typeorm';

@Entity({ name: 'interest_submissions' })
export class LeadInterest {
  @PrimaryColumn({ type: 'varchar', length: 36 })
  id!: string;

  @BeforeInsert()
  assignId() {
    if (!this.id) {
      this.id = randomUUID();
    }
  }

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
