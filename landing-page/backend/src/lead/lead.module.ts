import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth.module';
import { LeadController } from './lead.controller';
import { LeadInterest } from './lead.entity';
import { LeadService } from './lead.service';

@Module({
  imports: [TypeOrmModule.forFeature([LeadInterest]), AuthModule],
  providers: [LeadService],
  controllers: [LeadController],
})
export class LeadModule {}
