import { Module } from '@nestjs/common';
import { ExchangesController } from './exchanges.controller';
import { ExchangesRepository } from './exchanges.repository';
import { ExchangesService } from './exchanges.service';
import { IdempotencyRepository } from './idempotency.repository';

// La ejecución completa (cumplimiento + ledger) se agrega en la T12 importando ComplianceServiceModule y WalletsModule.
@Module({
  controllers: [ExchangesController],
  providers: [ExchangesService, ExchangesRepository, IdempotencyRepository],
})
export class ExchangesModule {}
