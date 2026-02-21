import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LeadModule } from './lead/lead.module';
import { AuthModule } from './auth.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres' as const,
        host: config.get<string>('DB_HOST', 'localhost'),
        port: config.get<number>('DB_PORT', 5432),
        username: config.get<string>('DB_USER', 'citizen'),
        password: config.get<string>('DB_PASSWORD', 'citizen'),
        database: config.get<string>('DB_NAME', 'citizen_landing'),
        autoLoadEntities: true,
        synchronize: true,
      }),
    }),
    LeadModule,
    AuthModule,
  ],
})
export class AppModule {}
