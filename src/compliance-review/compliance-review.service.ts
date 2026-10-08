import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL, withTransaction } from '../common/db/pg-pool';
import { BusinessError } from '../common/errors/business-error';
import { ExchangeDetail, ExchangeDetailRepository } from '../exchanges/exchange-detail.repository';
import { ExchangesRepository } from '../exchanges/exchanges.repository';
import { LedgerRepository } from '../wallets/ledger.repository';
import { ComplianceReviewRepository, PendingExchange } from './compliance-review.repository';

// REVISIÓN HUMANA de las operaciones HIGH (rol COMPLIANCE). No tiene relación de código con compliance-service (el servicio
// automático que clasifica el riesgo): solo se encuentran en el estado PENDING_REVIEW. Ver docs/spec.md D19.
@Injectable()
export class ComplianceReviewService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly review: ComplianceReviewRepository,
    private readonly exchanges: ExchangesRepository,
    private readonly details: ExchangeDetailRepository,
    private readonly ledger: LedgerRepository,
  ) {}

  listPending(limit: number): Promise<PendingExchange[]> {
    return this.review.listPending(limit);
  }

  approve(reviewerId: string, exchangeId: string, reason: string | undefined): Promise<ExchangeDetail> {
    return this.decide(reviewerId, exchangeId, 'APPROVED', reason ?? null);
  }

  reject(reviewerId: string, exchangeId: string, reason: string): Promise<ExchangeDetail> {
    return this.decide(reviewerId, exchangeId, 'REJECTED', reason);
  }

  // UNA transacción (docs/plan.md §6), con el mismo orden de bloqueos que la ejecución: exchange → quote → wallets.
  //   Aprobar: se debita lo retenido (USDT) y se acredita el XAUT cotizado       → COMPLETED
  //   Rechazar: se debita lo retenido y se devuelve al disponible (la liberación) → REJECTED
  // Se usan el precio y los montos de la cotización original, tal cual (R13): NO se mira si la cotización ya venció.
  private decide(reviewerId: string, exchangeId: string, decision: 'APPROVED' | 'REJECTED', reason: string | null): Promise<ExchangeDetail> {
    return withTransaction(this.pool, async (client) => {
      // 1) Bloquear la operación y comprobar el estado DESPUÉS de bloquear. Es lo que serializa a dos revisores que
      // decidan a la vez: el segundo espera, ve que ya no está en PENDING_REVIEW y recibe 409. (UNIQUE(exchange_id) de
      // compliance_decisions es el respaldo en la base.)
      const exchange = await this.exchanges.lockExchange(client, exchangeId);
      if (!exchange) throw new BusinessError('EXCHANGE_NOT_FOUND', 404, 'La operación no existe', { exchange_id: exchangeId });
      if (exchange.status !== 'PENDING_REVIEW') {
        throw new BusinessError('EXCHANGE_NOT_PENDING', 409, 'La operación no está pendiente de revisión', {
          exchange_id: exchangeId,
          status: exchange.status,
        });
      }

      // 2) La cotización guardada y 3) las wallets DEL DUEÑO de la operación (nunca las del revisor, D17), ordenadas por id.
      const quote = await this.exchanges.lockQuoteForExecution(client, exchange.quote_id);
      const wallets = await this.ledger.lockWallets(client, exchange.user_id, [quote.source_asset, quote.target_asset]);
      const sourceWallet = wallets.find((w) => w.asset === quote.source_asset);
      const targetWallet = wallets.find((w) => w.asset === quote.target_asset);
      if (!sourceWallet || !targetWallet) throw new Error(`Faltan wallets de ${exchange.user_id} para la operación ${exchangeId}`);

      // 4) Mover el dinero. En ambos casos primero sale lo retenido.
      const reference = { type: 'EXCHANGE', exchangeId } as const;
      await this.ledger.applyMovement(client, {
        walletId: sourceWallet.id,
        entryType: 'DEBIT',
        balanceType: 'HELD',
        amount: quote.source_amount,
        reference,
      });
      if (decision === 'APPROVED') {
        await this.ledger.applyMovement(client, {
          walletId: targetWallet.id,
          entryType: 'CREDIT',
          balanceType: 'AVAILABLE',
          amount: quote.target_amount,
          reference,
        });
      } else {
        await this.ledger.applyMovement(client, {
          walletId: sourceWallet.id,
          entryType: 'CREDIT',
          balanceType: 'AVAILABLE',
          amount: quote.source_amount,
          reference,
        });
      }

      // 5) La decisión, el nuevo estado y el evento (con el revisor como actor). Una operación HIGH nunca queda marcada
      // para seguimiento: ese marcador es solo para MEDIUM completada.
      const finalStatus = decision === 'APPROVED' ? 'COMPLETED' : 'REJECTED';
      await this.review.insertDecision(client, exchangeId, reviewerId, decision, reason);
      await this.exchanges.updateExchange(client, exchangeId, {
        status: finalStatus,
        riskLevel: exchange.risk_level,
        requiresFollowUp: false,
        failureReason: null,
      });
      await this.exchanges.insertEvent(client, exchangeId, 'PENDING_REVIEW', finalStatus, reviewerId, reason);

      const detail = await this.details.findById(client, exchangeId);
      if (!detail) throw new Error(`La operación ${exchangeId} desapareció durante su revisión`);
      return detail;
    });
  }
}
