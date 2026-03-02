import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WhitepaperModule } from './whitepaper/whitepaper.module';
import { MediaAssetEntity } from './whitepaper/entities/media-asset.entity';
import { WhitepaperSectionEntity } from './whitepaper/entities/whitepaper-section.entity';

@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: 'postgres',
      url: process.env.DATABASE_URL,
      entities: [WhitepaperSectionEntity, MediaAssetEntity],
      synchronize: false,
      logging: false,
    }),
    WhitepaperModule,
  ],
})
export class AppModule {}
