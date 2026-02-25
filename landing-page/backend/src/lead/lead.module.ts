import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth.module';
import { JwtAuthGuard } from '../jwt-auth.guard';
import { LeadController } from './lead.controller';
import { LeadInterest } from './lead.entity';
import { LeadService } from './lead.service';
import { FormSettings } from './form-settings.entity';

@Module({
  imports: [TypeOrmModule.forFeature([LeadInterest, FormSettings]), AuthModule],
  providers: [LeadService, JwtAuthGuard],
  controllers: [LeadController],
})
export class LeadModule {}
