import { Controller, Get, Param } from '@nestjs/common';
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

  @Get('blocks/:height')
  async block(@Param('height') height: string) {
    return this.citizenService.getBlock(Number(height));
  }

  @Get('entries/:namespace')
  async entries(@Param('namespace') namespace: string) {
    return this.citizenService.getEntries(namespace);
  }

  @Get('receipts/:receiptId')
  async receipt(@Param('receiptId') receiptId: string) {
    return this.citizenService.getReceipt(receiptId);
  }
}
