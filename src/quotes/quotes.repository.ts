import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../common/db/pg-pool';

// Los montos son numeric(28,8) y llegan como string. fee_rate es numeric(7,6) ("0.010000").
export interface QuoteRow {
  id: string;
  source_asset: string;
  target_asset: string;
  source_amount: string;
  price: string;
  fee_rate: string;
  fee_amount: string;
  net_amount: string;
  target_amount: string;
  status: 'ACTIVE' | 'EXPIRED' | 'USED';
  created_at: Date;
  expires_at: Date;
}

export interface NewQuote {
  userId: string;
  sourceAsset: string;
  targetAsset: string;
  sourceAmount: string;
  price: string;
  feeRate: string;
  feeAmount: string;
  netAmount: string;
  targetAmount: string;
  ttlSeconds: number;
}

@Injectable()
export class QuotesRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async insert(q: NewQuote): Promise<QuoteRow> {
    // created_at y expires_at salen del reloj de la base (S6), en la misma sentencia: now() es el mismo valor en ambos,
    // así que la vigencia es exactamente ttlSeconds. Los CHECKs de quotes vuelven a verificar el cálculo.
    const { rows } = await this.pool.query<QuoteRow>(
      `INSERT INTO quotes (user_id, source_asset, target_asset, source_amount, price, fee_rate,
                           fee_amount, net_amount, target_amount, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now() + make_interval(secs => $10))
       RETURNING id, source_asset, target_asset, source_amount, price, fee_rate, fee_amount,
                 net_amount, target_amount, status, created_at, expires_at`,
      [q.userId, q.sourceAsset, q.targetAsset, q.sourceAmount, q.price, q.feeRate, q.feeAmount, q.netAmount, q.targetAmount, q.ttlSeconds],
    );
    return rows[0];
  }
}
