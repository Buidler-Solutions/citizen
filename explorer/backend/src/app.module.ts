import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { CitizenService } from './citizen.service';
import { IndexerMetricsService } from './indexer/indexer-metrics.service';
import { IndexerMetricsAccessService } from './indexer/metrics-access.service';
import { IndexerMetricsStorageService } from './indexer/metrics-storage.service';

@Module({
  controllers: [AppController],
  providers: [CitizenService, IndexerMetricsService, IndexerMetricsAccessService, IndexerMetricsStorageService],
})
export class AppModule {}
