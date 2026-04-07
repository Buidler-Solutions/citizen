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

  @Get('entries/:namespace/wallet-signers/:signerDid')
  async entriesByWalletSigner(
    @Param('namespace') namespace: string,
    @Param('signerDid') signerDid: string,
  ) {
    return this.citizenService.getEntriesByWalletSigner(namespace, decodeURIComponent(signerDid));
  }

  @Get('receipts/:receiptId')
  async receipt(@Param('receiptId') receiptId: string) {
    return this.citizenService.getReceipt(receiptId);
  }

  @Get('files/manifests/:manifestId')
  async fileManifest(@Param('manifestId') manifestId: string) {
    return this.citizenService.getFileManifest(manifestId);
  }


  @Get('files/timeline/:manifestId')
  async fileTimeline(@Param('manifestId') manifestId: string) {
    return this.citizenService.getFileTimeline(manifestId);
  }

  @Get('payloads/fields/:entryId/:namespace')
  async payloadFieldRefs(
    @Param('entryId') entryId: string,
    @Param('namespace') namespace: string,
  ) {
    return this.citizenService.getPayloadFieldRefs(entryId, namespace);
  }
}
