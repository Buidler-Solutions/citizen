import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

export type LeadNotificationStatus = 'sent' | 'failed' | 'logged';

@Entity({ name: 'lead_notifications' })
export class LeadNotification {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'lead_id', type: 'uuid', nullable: true })
  leadId!: string | null;

  @Column({ name: 'template_type', length: 80 })
  templateType!: string;

  @Column({ name: 'recipient_email', length: 180 })
  recipientEmail!: string;

  @Column({ name: 'recipient_name', length: 180, default: '' })
  recipientName!: string;

  @Column({ name: 'subject_snapshot', length: 220 })
  subjectSnapshot!: string;

  @Column({ length: 40, default: 'sent' })
  status!: LeadNotificationStatus;

  @Column({ type: 'text', default: '' })
  channel!: string;

  @Column({ name: 'audience_mode', length: 40, default: '' })
  audienceMode!: string;

  @Column({ type: 'text', nullable: true })
  errorMessage!: string | null;

  @Column({ name: 'sent_at', type: 'timestamptz', nullable: true })
  sentAt!: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;
}
