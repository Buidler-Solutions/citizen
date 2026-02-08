import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { CitizenService } from './citizen.service';

@Module({
  controllers: [AppController],
  providers: [CitizenService],
})
export class AppModule {}
