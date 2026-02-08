import { Controller, Get } from '@nestjs/common';
import { CitizenService } from './citizen.service';

@Controller()
export class AppController {
  constructor(private readonly citizenService: CitizenService) {}

  @Get('health')
  health() {
    return { status: 'ok' };
  }

  @Get('status')
  async status() {
    return this.citizenService.getStatus();
  }

  @Get('blocks')
  async blocks() {
    return this.citizenService.getBlocks();
  }

  @Get('entries')
  async entries() {
    return this.citizenService.getEntries();
  }
}
