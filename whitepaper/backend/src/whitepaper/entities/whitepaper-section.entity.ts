import { Column, CreateDateColumn, DeleteDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

@Entity({ name: 'whitepaper_sections' })
@Index(['orderIndex'])
@Index(['startFrame', 'endFrame'])
export class WhitepaperSectionEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'text' })
  title!: string;

  @Column({ type: 'text' })
  description!: string;

  @Column({ type: 'text', default: '' })
  content!: string;

  @Column({ type: 'integer', name: 'start_frame' })
  startFrame!: number;

  @Column({ type: 'integer', name: 'end_frame' })
  endFrame!: number;

  @Column({ type: 'integer', name: 'order_index', unique: true })
  orderIndex!: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @DeleteDateColumn({ name: 'deleted_at', type: 'timestamptz' })
  deletedAt!: Date | null;
}
