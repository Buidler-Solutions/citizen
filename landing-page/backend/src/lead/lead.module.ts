import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth.module';
import { LeadController } from './lead.controller';
import { LeadInterest } from './lead.entity';
import { LeadService } from './lead.service';
import { FormSettings } from './form-settings.entity';

@Module({
  imports: [TypeOrmModule.forFeature([LeadInterest, FormSettings]), AuthModule],
  providers: [LeadService],
  controllers: [LeadController],
})
export class LeadModule {}
