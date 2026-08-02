import { CreateDateColumn, Column, DeleteDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

@Entity({ name: 'asciinema_recordings' })
export class AsciinemaRecording {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ length: 80, unique: true })
  shortcode!: string;

  @Column({ length: 180, default: '' })
  label!: string;

  @Column({ length: 500 })
  castUrl!: string;

  @Column({ length: 255, default: '' })
  filename!: string;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;

  @DeleteDateColumn()
  deletedAt!: Date | null;
}
