import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { WhitepaperSectionEntity } from './entities/whitepaper-section.entity';
import { MediaAssetEntity } from './entities/media-asset.entity';

type Pagination = {
  page: number;
  limit: number;
};

export type UpsertSectionPayload = {
  title: string;
  description: string;
  content: string;
  startFrame: number;
  endFrame: number;
  orderIndex: number;
};

@Injectable()
export class WhitepaperService {
  constructor(
    @InjectRepository(WhitepaperSectionEntity)
    private readonly sectionsRepository: Repository<WhitepaperSectionEntity>,
    @InjectRepository(MediaAssetEntity)
    private readonly mediaRepository: Repository<MediaAssetEntity>,
  ) {}

  async getSections() {
    const sections = await this.sectionsRepository.find({ order: { orderIndex: 'ASC' } });

    return {
      data: sections,
      meta: {
        total: sections.length,
      },
    };
  }

  async getFrames({ page, limit }: Pagination) {
    const [frames, total] = await this.mediaRepository.findAndCount({
      order: { frameNumber: 'ASC' },
      take: limit,
      skip: (page - 1) * limit,
    });

    return {
      data: frames,
      meta: {
        total,
        page,
        limit,
        hasNextPage: page * limit < total,
      },
    };
  }

  async getMetadata() {
    const [sectionCount, frameCount, bounds] = await Promise.all([
      this.sectionsRepository.count(),
      this.mediaRepository.count(),
      this.mediaRepository
        .createQueryBuilder('frame')
        .select('MIN(frame.frame_number)', 'minFrame')
        .addSelect('MAX(frame.frame_number)', 'maxFrame')
        .getRawOne<{ minFrame: string | null; maxFrame: string | null }>(),
    ]);

    return {
      data: {
        sectionCount,
        frameCount,
        minFrame: bounds?.minFrame ? Number(bounds.minFrame) : 0,
        maxFrame: bounds?.maxFrame ? Number(bounds.maxFrame) : 0,
        format: 'webp',
        scrubMode: 'scroll-only',
      },
    };
  }

  async createSection(payload: UpsertSectionPayload) {
    this.validateSectionRange(payload.startFrame, payload.endFrame);

    const section = this.sectionsRepository.create(payload);
    return this.sectionsRepository.save(section);
  }

  async updateSection(id: string, payload: Partial<UpsertSectionPayload>) {
    const section = await this.sectionsRepository.findOne({ where: { id } });
    if (!section) {
      throw new NotFoundException('Whitepaper section not found');
    }

    const nextStartFrame = payload.startFrame ?? section.startFrame;
    const nextEndFrame = payload.endFrame ?? section.endFrame;
    this.validateSectionRange(nextStartFrame, nextEndFrame);

    const merged = this.sectionsRepository.merge(section, payload);
    return this.sectionsRepository.save(merged);
  }

  async deleteSection(id: string) {
    const result = await this.sectionsRepository.delete({ id });
    if (!result.affected) {
      throw new NotFoundException('Whitepaper section not found');
    }

    return { success: true };
  }

  private validateSectionRange(startFrame: number, endFrame: number) {
    if (!Number.isInteger(startFrame) || !Number.isInteger(endFrame) || startFrame < 0 || endFrame < startFrame) {
      throw new BadRequestException('Invalid frame range for section');
    }
  }
}
