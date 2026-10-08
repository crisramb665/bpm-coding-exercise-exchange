import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../common/db/pg-pool';

// Los montos son columnas numeric(28,8): pg las entrega como string ("10000.00000000") y así viajan hasta la API.
export interface WalletRow {
  id: string;
  asset: string;
  available: string;
  held: string;
  total: string;
  updated_at: Date;
}

export interface MovementRow {
  id: string; // bigint: pg lo entrega como string para no perder precisión
  entry_type: 'DEBIT' | 'CREDIT';
  balance_type: 'AVAILABLE' | 'HELD';
  amount: string;
  balance_before: string;
  balance_after: string;
  status: string;
  reference_type: 'EXCHANGE' | 'INITIAL_DEPOSIT';
  exchange_id: string | null;
  created_at: Date;
}

@Injectable()
export class WalletsRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async findByUser(userId: string): Promise<WalletRow[]> {
    const { rows } = await this.pool.query<WalletRow>(
      `SELECT id, asset_code AS asset, available, held, total, updated_at
         FROM wallets
        WHERE user_id = $1
        ORDER BY asset_code`,
      [userId],
    );
    return rows;
  }

  // Filtrar también por user_id es lo que impide ver wallets ajenas: no existe una consulta "por id a secas".
  async existsForUser(walletId: string, userId: string): Promise<boolean> {
    const { rowCount } = await this.pool.query('SELECT 1 FROM wallets WHERE id = $1 AND user_id = $2', [
      walletId,
      userId,
    ]);
    return rowCount === 1;
  }

  // Del más reciente al más antiguo. Se ordena por id (IDENTITY) y no por created_at: now() es la hora de inicio de la
  // transacción, así que el débito y el crédito de una misma operación empatan en created_at.
  async findMovements(walletId: string, limit: number): Promise<MovementRow[]> {
    const { rows } = await this.pool.query<MovementRow>(
      `SELECT id, entry_type, balance_type, amount, balance_before, balance_after,
              status, reference_type, exchange_id, created_at
         FROM ledger_entries
        WHERE wallet_id = $1
        ORDER BY id DESC
        LIMIT $2`,
      [walletId, limit],
    );
    return rows;
  }
}
