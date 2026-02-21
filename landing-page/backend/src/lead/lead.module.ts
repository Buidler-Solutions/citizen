import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LeadController } from './lead.controller';
import { LeadInterest } from './lead.entity';
import { LeadService } from './lead.service';

@Module({
  imports: [TypeOrmModule.forFeature([LeadInterest])],
  providers: [LeadService],
  controllers: [LeadController],
})
export class LeadModule {}
