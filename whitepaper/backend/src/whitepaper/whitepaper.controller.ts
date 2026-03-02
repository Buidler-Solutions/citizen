import { CacheInterceptor, CacheTTL } from '@nestjs/cache-manager';
import { Controller, DefaultValuePipe, Get, ParseIntPipe, Query, UseInterceptors } from '@nestjs/common';
import { WhitepaperService } from './whitepaper.service';

@Controller('whitepaper')
@UseInterceptors(CacheInterceptor)
export class WhitepaperController {
  constructor(private readonly whitepaperService: WhitepaperService) {}

  @Get('sections')
  @CacheTTL(300)
  getSections() {
    return this.whitepaperService.getSections();
  }

  @Get('frames')
  @CacheTTL(120)
  getFrames(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number,
  ) {
    return this.whitepaperService.getFrames({ page, limit: Math.min(limit, 200) });
  }

  @Get('metadata')
  @CacheTTL(300)
  getMetadata() {
    return this.whitepaperService.getMetadata();
  }
}
