import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { IndexerMetricsService } from './indexer/indexer-metrics.service';

function isAddrInUse(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  return (error as { code?: string }).code === 'EADDRINUSE';
}

async function listenWithPortFallback(
  app: Awaited<ReturnType<typeof NestFactory.create>>,
  preferredPort: number,
  explicitPortProvided: boolean,
): Promise<number> {
  try {
    await app.listen(preferredPort);
    return preferredPort;
  } catch (error) {
    if (!isAddrInUse(error)) {
      throw error;
    }

    if (explicitPortProvided) {
      throw new Error(
        `Port ${preferredPort} is already in use. Set a different PORT value and retry.`,
      );
    }

    const fallbackPort = preferredPort + 1;
    // eslint-disable-next-line no-console
    console.warn(
      `Port ${preferredPort} is already in use; falling back to port ${fallbackPort}. Set PORT to override.`,
    );
    await app.listen(fallbackPort);
    return fallbackPort;
  }
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const indexerMetricsService = app.get(IndexerMetricsService);
  indexerMetricsService.startPolling();

  app.enableShutdownHooks();
  app
    .getHttpAdapter()
    .getInstance()
    .on('close', () => {
      indexerMetricsService.stopPolling();
    });

  const explicitPortProvided = typeof process.env.PORT === 'string';
  const requestedPort = explicitPortProvided ? Number(process.env.PORT) : 4444;
  if (!Number.isInteger(requestedPort) || requestedPort <= 0) {
    throw new Error(`Invalid PORT value: ${process.env.PORT}`);
  }
  const port = await listenWithPortFallback(app, requestedPort, explicitPortProvided);
  // eslint-disable-next-line no-console
  console.log(`Citizen explorer backend running on http://localhost:${port}`);
}

bootstrap();
