import { Module } from '@nestjs/common';
import { ExchangesModule } from '../exchanges/exchanges.module';
import { WalletsModule } from '../wallets/wallets.module';
import { ComplianceReviewController } from './compliance-review.controller';
import { ComplianceReviewRepository } from './compliance-review.repository';
import { ComplianceReviewService } from './compliance-review.service';

// REVISIÓN HUMANA (rol COMPLIANCE): la bandeja de operaciones retenidas y su aprobación o rechazo. NO es el servicio
// automático que clasifica el riesgo (ver compliance-service/). Reutiliza de ExchangesModule el bloqueo y la actualización de
// operaciones, y de WalletsModule el único punto que mueve saldos (LedgerRepository).
@Module({
  imports: [ExchangesModule, WalletsModule],
  controllers: [ComplianceReviewController],
  providers: [ComplianceReviewService, ComplianceReviewRepository],
})
export class ComplianceReviewModule {}
