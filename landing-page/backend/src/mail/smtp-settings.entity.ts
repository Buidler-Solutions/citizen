import { Column, DeleteDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

@Entity({ name: 'smtp_settings' })
export class SmtpSettings {
  @PrimaryColumn({ type: 'varchar', length: 40 })
  id!: string;

  @Column({ length: 180, default: '' })
  host!: string;

  @Column({ type: 'int', default: 587 })
  port!: number;

  @Column({ default: false })
  secure!: boolean;

  @Column({ length: 180, default: '' })
  username!: string;

  @Column({ type: 'text', default: '' })
  password!: string;

  @Column({ name: 'from_address', length: 220, default: '' })
  fromAddress!: string;

  @Column({ name: 'reply_to', length: 220, default: '' })
  replyTo!: string;

  @Column({ name: 'default_bcc', type: 'text', default: '' })
  defaultBcc!: string;

  @Column({ name: 'reject_unauthorized', default: true })
  rejectUnauthorized!: boolean;

  @UpdateDateColumn()
  updatedAt!: Date;

  @DeleteDateColumn()
  deletedAt!: Date | null;
}
