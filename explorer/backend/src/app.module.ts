import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { CitizenService } from './citizen.service';
import { IndexerMetricsService } from './indexer/indexer-metrics.service';
import { IndexerMetricsAccessService } from './indexer/metrics-access.service';

@Module({
  controllers: [AppController],
  providers: [CitizenService, IndexerMetricsService, IndexerMetricsAccessService],
})
export class AppModule {}
