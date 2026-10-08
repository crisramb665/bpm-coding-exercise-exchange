import { Inject, Injectable } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { PG_POOL } from '../common/db/pg-pool';

// Una fila de la bandeja de Cumplimiento (docs/spec.md §5.7).
export interface PendingExchange {
  id: string;
  user_id: string;
  user_name: string;
  source_asset: string;
  source_amount: string;
  target_asset: string;
  target_amount: string;
  price: string;
  risk_level: string;
  created_at: Date;
}

@Injectable()
export class ComplianceReviewRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  // De la más antigua a la más reciente: la que lleva más tiempo esperando se atiende primero. Usa el índice parcial
  // exchanges_pending_idx (created_at) WHERE status = 'PENDING_REVIEW'. El precio es el de la cotización original, que no cambia.
  async listPending(limit: number): Promise<PendingExchange[]> {
    const { rows } = await this.pool.query<PendingExchange>(
      `SELECT e.id, e.user_id, u.name AS user_name, q.source_asset, q.source_amount, q.target_asset, q.target_amount,
              q.price, e.risk_level, e.created_at
         FROM exchanges e
         JOIN quotes q ON q.id = e.quote_id
         JOIN users  u ON u.id = e.user_id
        WHERE e.status = 'PENDING_REVIEW'
        ORDER BY e.created_at ASC, e.id ASC
        LIMIT $1`,
      [limit],
    );
    return rows;
  }

  // La decisión humana queda como un registro propio e inmutable (D10). UNIQUE(exchange_id) garantiza una sola decisión por
  // operación, y la FK compuesta a users exige que el revisor tenga rol COMPLIANCE.
  async insertDecision(
    client: PoolClient,
    exchangeId: string,
    reviewerId: string,
    decision: 'APPROVED' | 'REJECTED',
    reason: string | null,
  ): Promise<void> {
    await client.query(
      'INSERT INTO compliance_decisions (exchange_id, reviewer_id, decision, reason) VALUES ($1, $2, $3, $4)',
      [exchangeId, reviewerId, decision, reason],
    );
  }
}
