import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth.module';
import { JwtAuthGuard } from '../jwt-auth.guard';
import { LeadController } from './lead.controller';
import { LeadInterest } from './lead.entity';
import { LeadService } from './lead.service';
import { FormSettings } from './form-settings.entity';
import { AsciinemaRecording } from './asciinema-recording.entity';
import { MailModule } from '../mail/mail.module';

@Module({
  imports: [TypeOrmModule.forFeature([LeadInterest, FormSettings, AsciinemaRecording]), AuthModule, MailModule],
  providers: [LeadService, JwtAuthGuard],
  controllers: [LeadController],
})
export class LeadModule {}
