import { CacheModule } from '@nestjs/cache-manager';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MediaAssetEntity } from './entities/media-asset.entity';
import { WhitepaperSectionEntity } from './entities/whitepaper-section.entity';
import { AdminAuthGuard } from './admin-auth.guard';
import { AdminAuthService } from './admin-auth.service';
import { AdminWhitepaperController } from './admin-whitepaper.controller';
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
  controllers: [WhitepaperController, AdminWhitepaperController],
  providers: [WhitepaperService, AdminAuthService, AdminAuthGuard],
  exports: [WhitepaperService],
})
export class WhitepaperModule {}
