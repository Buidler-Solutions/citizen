import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

@Entity({ name: 'form_settings' })
export class FormSettings {
  @PrimaryColumn({ type: 'varchar', length: 40 })
  id!: string;

  @Column({ length: 220, default: 'Build Public Truth with Citizen' })
  title!: string;

  @Column({ length: 260, default: 'Validator · Builder · Observer onboarding' })
  subtitle!: string;

  @Column({ type: 'text', default: 'I want to stress test the system as a Validator focused on...' })
  validatorPrompt!: string;

  @Column({ type: 'text', default: 'I want to build civic applications as a Builder for...' })
  builderPrompt!: string;

  @Column({ type: 'text', default: 'I want to run audits as an Observer to improve...' })
  observerPrompt!: string;

  @UpdateDateColumn()
  updatedAt!: Date;
}
