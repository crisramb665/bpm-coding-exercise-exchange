import { Module } from '@nestjs/common';
import { LedgerRepository } from './ledger.repository';
import { WalletsController } from './wallets.controller';
import { WalletsRepository } from './wallets.repository';
import { WalletsService } from './wallets.service';

@Module({
  controllers: [WalletsController],
  providers: [WalletsService, WalletsRepository, LedgerRepository],
  // Los módulos que mueven saldos (exchanges, compliance-review) importan WalletsModule para usar LedgerRepository.
  exports: [LedgerRepository],
})
export class WalletsModule {}
