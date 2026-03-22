import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { AppModule } from './app.module';

const parseCorsOrigins = (): string[] => (process.env.CORS_ORIGIN?.split(',') ?? ['http://localhost:3000'])
  .map((origin) => origin.trim())
  .filter(Boolean);

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  const uploadsRoot = join(process.cwd(), 'uploads');
  const castsRoot = join(uploadsRoot, 'casts');
  const siteBrandingRoot = join(uploadsRoot, 'site-branding');

  if (!existsSync(castsRoot)) {
    mkdirSync(castsRoot, { recursive: true });
  }

  if (!existsSync(siteBrandingRoot)) {
    mkdirSync(siteBrandingRoot, { recursive: true });
  }

  const allowedOrigins = parseCorsOrigins();

  app.useStaticAssets(uploadsRoot, {
    prefix: '/uploads/',
    setHeaders: (response) => {
      response.setHeader('Access-Control-Allow-Origin', '*');
    },
  });

  app.enableCors({
    origin: allowedOrigins,
    credentials: true,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  await app.listen(process.env.PORT ?? 3001);
}

void bootstrap();
