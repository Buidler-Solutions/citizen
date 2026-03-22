import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';


interface CampaignCard {
  weight: number;
  eyebrow: string;
  title: string;
  body: string;
}

interface RoleOption {
  id: string;
  label: string;
  prompt: string;
  thankYouNote: string;
  weight: number;
}

@Entity({ name: 'form_settings' })
export class FormSettings {
  @PrimaryColumn({ type: 'varchar', length: 40 })
  id!: string;

  @Column({ length: 220, default: 'Build Public Truth with Citizen' })
  title!: string;

  @Column({ length: 260, default: 'Validator · Builder · Observer onboarding' })
  subtitle!: string;

  @Column({
    type: 'jsonb',
    default: () => `'[
      {"weight":1,"eyebrow":"citizen-protocol-v0.1.0","title":"Citizen Protocol in one line","body":"A governance-first blockchain for public truth, accountability, and tamper-evident civic records."},
      {"weight":2,"eyebrow":"citizen-protocol-v0.1.0","title":"Why this project exists","body":"Critical public records are fragmented and hard to trust. Citizen Protocol creates one auditable source of truth for civic systems."},
      {"weight":3,"eyebrow":"citizen-protocol-v0.1.0","title":"What we are solving","body":"We reduce record fraud, strengthen governance transparency, and improve institutional trust across agencies."}
    ]'::jsonb`,
  })
  campaignCards!: CampaignCard[];

  @Column({
    type: 'jsonb',
    default: () => `'[
      {"id":"validator","label":"Validator","prompt":"I want to stress test the system as a Validator focused on...","thankYouNote":"Thank you for applying to run a Citizen Validator node. We have added you to the validator waitlist. Our team will review your submission and send onboarding updates, eligibility checks, and timeline details to your email.","weight":1},
      {"id":"builder","label":"Builder","prompt":"I want to build civic applications as a Builder for...","thankYouNote":"Thank you for joining as a Builder. You are now on our builder waitlist. We will share product updates, API access details, and onboarding milestones by email as new slots open.","weight":2},
      {"id":"observer","label":"Observer","prompt":"I want to run audits as an Observer to improve...","thankYouNote":"Thank you for registering as an Observer. We have added you to the observer waitlist. You will receive updates by email about review status, audit participation windows, and next steps.","weight":3}
    ]'::jsonb`,
  })
  roles!: RoleOption[];


  @UpdateDateColumn()
  updatedAt!: Date;
}
