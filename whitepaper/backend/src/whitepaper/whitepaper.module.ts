import { CacheModule } from '@nestjs/cache-manager';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MediaAssetEntity } from './entities/media-asset.entity';
import { WhitepaperSectionEntity } from './entities/whitepaper-section.entity';
import { WhitepaperController } from './whitepaper.controller';
import { WhitepaperService } from './whitepaper.service';

@Module({
  imports: [
    CacheModule.register({
      isGlobal: false,
      ttl: 120_000,
    }),
    TypeOrmModule.forFeature([WhitepaperSectionEntity, MediaAssetEntity]),
  ],
  controllers: [WhitepaperController],
  providers: [WhitepaperService],
  exports: [WhitepaperService],
})
export class WhitepaperModule {}
