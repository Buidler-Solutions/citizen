import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';


interface CampaignCard {
  weight: number;
  title: string;
  body: string;
}

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

  @Column({
    type: 'jsonb',
    default: () => `'[
      {"weight":1,"title":"Citizen Protocol in one line","body":"A governance-first blockchain for public truth, accountability, and tamper-evident civic records."},
      {"weight":2,"title":"Why this project exists","body":"Critical public records are fragmented and hard to trust. Citizen Protocol creates one auditable source of truth for civic systems."},
      {"weight":3,"title":"What we are solving","body":"We reduce record fraud, strengthen governance transparency, and improve institutional trust across agencies."}
    ]'::jsonb`,
  })
  campaignCards!: CampaignCard[];

  @UpdateDateColumn()
  updatedAt!: Date;
}
