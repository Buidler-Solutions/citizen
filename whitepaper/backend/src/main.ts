import 'dotenv/config';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  const corsOrigin = process.env.CORS_ORIGIN ?? 'http://localhost:3000';
  app.enableCors({ origin: corsOrigin, credentials: true });

  const port = Number(process.env.PORT ?? 4000);
  await app.listen(port);
}

void bootstrap();
