import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { WhitepaperSectionEntity } from './whitepaper-section.entity';

@Entity({ name: 'media_assets' })
@Index(['frameNumber'])
@Index(['chapterId', 'frameNumber'], { unique: true })
export class MediaAssetEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'text' })
  filename!: string;

  @Column({ type: 'integer', name: 'frame_number' })
  frameNumber!: number;

  @Column({ name: 'chapter_id', type: 'uuid' })
  chapterId!: string;

  @ManyToOne(() => WhitepaperSectionEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'chapter_id' })
  chapter!: WhitepaperSectionEntity;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @DeleteDateColumn({ name: 'deleted_at', type: 'timestamptz' })
  deletedAt!: Date | null;
}
