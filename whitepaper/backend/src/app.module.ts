import { Module } from '@nestjs/common';
import { TypeOrmModule, TypeOrmModuleOptions } from '@nestjs/typeorm';
import { WhitepaperModule } from './whitepaper/whitepaper.module';
import { MediaAssetEntity } from './whitepaper/entities/media-asset.entity';
import { WhitepaperSectionEntity } from './whitepaper/entities/whitepaper-section.entity';

function normalizeEnvValue(value: string | undefined): string {
  if (!value) {
    return '';
  }

  const trimmedValue = value.trim();
  const hasMatchingQuotes =
    (trimmedValue.startsWith('"') && trimmedValue.endsWith('"')) ||
    (trimmedValue.startsWith("'") && trimmedValue.endsWith("'"));

  if (hasMatchingQuotes) {
    return trimmedValue.slice(1, -1);
  }

  return trimmedValue;
}

function resolveDatabasePassword(parsedUrl?: URL): string {
  const urlPassword = parsedUrl ? decodeURIComponent(parsedUrl.password || '') : '';
  const envPassword =
    normalizeEnvValue(process.env.DB_PASSWORD) ||
    normalizeEnvValue(process.env.POSTGRES_PASSWORD) ||
    normalizeEnvValue(process.env.PGPASSWORD);

  const resolvedPassword = String(urlPassword || envPassword);

  if (!resolvedPassword) {
    throw new Error(
      'Database password is required. Set it in DATABASE_URL or DB_PASSWORD/POSTGRES_PASSWORD/PGPASSWORD.',
    );
  }

  return resolvedPassword;
}

function buildDatabaseConfig(): TypeOrmModuleOptions {
  const entities = [WhitepaperSectionEntity, MediaAssetEntity];
  const databaseUrl = normalizeEnvValue(process.env.DATABASE_URL);

  if (databaseUrl) {
    const parsedUrl = new URL(databaseUrl);

    return {
      type: 'postgres',
      host: parsedUrl.hostname,
      port: Number.parseInt(parsedUrl.port || '5432', 10),
      username:
        decodeURIComponent(parsedUrl.username || '') ||
        normalizeEnvValue(process.env.DB_USER) ||
        'postgres',
      password: resolveDatabasePassword(parsedUrl),
      database: decodeURIComponent(parsedUrl.pathname.replace(/^\//, '') || 'postgres'),
      ssl:
        parsedUrl.searchParams.get('sslmode') === 'require'
          ? { rejectUnauthorized: false }
          : undefined,
      entities,
      synchronize: false,
      logging: false,
    };
  }

  return {
    type: 'postgres',
    host: normalizeEnvValue(process.env.DB_HOST) || 'localhost',
    port: Number.parseInt(normalizeEnvValue(process.env.DB_PORT) || '5432', 10),
    username: normalizeEnvValue(process.env.DB_USER) || 'postgres',
    password: resolveDatabasePassword(),
    database: normalizeEnvValue(process.env.DB_NAME) || 'postgres',
    entities,
    synchronize: false,
    logging: false,
  };
}

@Module({
  imports: [TypeOrmModule.forRoot(buildDatabaseConfig()), WhitepaperModule],
})
export class AppModule {}
