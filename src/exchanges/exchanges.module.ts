import { Module } from '@nestjs/common';
import { ComplianceServiceModule } from '../compliance-service/compliance-service.module';
import { WalletsModule } from '../wallets/wallets.module';
import { ExchangeDetailRepository } from './exchange-detail.repository';
import { ExchangesController } from './exchanges.controller';
import { ExchangesRepository } from './exchanges.repository';
import { ExchangesService } from './exchanges.service';
import { IdempotencyRepository } from './idempotency.repository';

// ComplianceServiceModule aporta el cliente del servicio automático de cumplimiento; WalletsModule, el LedgerRepository
// (la única vía para mover saldos).
@Module({
  imports: [ComplianceServiceModule, WalletsModule],
  controllers: [ExchangesController],
  providers: [ExchangesService, ExchangesRepository, IdempotencyRepository, ExchangeDetailRepository],
})
export class ExchangesModule {}
