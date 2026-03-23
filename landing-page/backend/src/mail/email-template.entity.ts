import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

@Entity({ name: 'email_templates' })
export class EmailTemplate {
  @PrimaryColumn({ type: 'varchar', length: 80 })
  type!: string;

  @Column({ length: 220 })
  subject!: string;

  @Column({ type: 'text' })
  html!: string;

  @UpdateDateColumn()
  updatedAt!: Date;
}
