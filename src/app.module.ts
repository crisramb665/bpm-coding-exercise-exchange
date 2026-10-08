import { Module } from '@nestjs/common';
import { APP_FILTER, APP_PIPE } from '@nestjs/core';
import { AuthModule } from './common/auth/auth.module';
import { ComplianceReviewModule } from './compliance-review/compliance-review.module';
import { ComplianceServiceModule } from './compliance-service/compliance-service.module';
import { DbModule } from './common/db/db.module';
import { BusinessErrorFilter } from './common/errors/business-error.filter';
import { createValidationPipe } from './common/errors/validation-pipe';
import { ExchangesModule } from './exchanges/exchanges.module';
import { QuotesModule } from './quotes/quotes.module';
import { WalletsModule } from './wallets/wallets.module';

// Módulo raíz. Los módulos de dominio (wallets, quotes, compliance-service, exchanges, compliance-review) se agregan a `imports`
// a medida que se implementan (docs/tasks.md).
// El filtro y el pipe se registran aquí (y no en main.ts) para que también apliquen en las pruebas,
// que crean la app a partir de este módulo sin pasar por main.ts.
@Module({
  imports: [DbModule, AuthModule, WalletsModule, QuotesModule, ComplianceServiceModule, ExchangesModule, ComplianceReviewModule],
  providers: [
    { provide: APP_FILTER, useClass: BusinessErrorFilter },
    { provide: APP_PIPE, useFactory: createValidationPipe },
  ],
})
export class AppModule {}
