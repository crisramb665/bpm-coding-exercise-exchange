import { Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import { PoolClient } from 'pg';
import { AMOUNT_DECIMALS } from '../common/money/money';

// De dónde viene un movimiento. Un tipo unión (y no dos campos sueltos) hace imposible compilar un movimiento de
// operación sin exchangeId o un depósito inicial con uno; la tabla lo vuelve a exigir con un CHECK.
export type LedgerReference = { type: 'EXCHANGE'; exchangeId: string } | { type: 'INITIAL_DEPOSIT' };

export interface MovementInput {
  walletId: string;
  entryType: 'DEBIT' | 'CREDIT';
  // Qué saldo de la wallet se mueve. Retener = DEBIT AVAILABLE + CREDIT HELD; liberar = DEBIT HELD + CREDIT AVAILABLE (D1).
  balanceType: 'AVAILABLE' | 'HELD';
  amount: Decimal.Value; // siempre positivo; el signo lo da entryType
  reference: LedgerReference;
}

export interface AppliedMovement {
  id: string; // bigint como string
  balanceBefore: string;
  balanceAfter: string;
}

export interface LockedWallet {
  id: string;
  asset: string;
  available: string;
  held: string;
}

@Injectable()
export class LedgerRepository {
  // Bloquea las wallets del usuario para los activos indicados (SELECT … FOR UPDATE) y devuelve su saldo ya bloqueado.
  //
  // REGLA DE CONCURRENCIA: las wallets SIEMPRE se bloquean ordenadas por id. Si dos transacciones necesitan las mismas
  // wallets y las pidieran en órdenes distintos, cada una podría quedarse con una y esperar la otra (interbloqueo).
  // Con un orden global único, la segunda simplemente espera a que la primera termine. En un SELECT … ORDER BY … FOR UPDATE
  // el bloqueo se toma en el orden del ORDER BY (el nodo LockRows va después del Sort).
  //
  // Hay que llamarla ANTES de decidir con el saldo (¿alcanza?) y de llamar a applyMovement: lo que se lee aquí ya no
  // puede cambiar hasta el COMMIT, y eso es lo que impide gastar dos veces el mismo saldo.
  async lockWallets(client: PoolClient, userId: string, assets: string[]): Promise<LockedWallet[]> {
    const { rows } = await client.query<LockedWallet>(
      `SELECT id, asset_code AS asset, available, held
         FROM wallets
        WHERE user_id = $1 AND asset_code = ANY($2::text[])
        ORDER BY id
          FOR UPDATE`,
      [userId, assets],
    );
    return rows;
  }

  // ÚNICA función del código que modifica el saldo de una wallet (regla R2: ningún saldo cambia sin un movimiento).
  // Mueve el saldo y registra el movimiento en UNA sola sentencia, así no puede quedar uno sin el otro, y
  // balance_before / balance_after salen del saldo real que devuelve la base, no de una lectura anterior que pudo cambiar.
  //
  // Debe ejecutarse dentro de la transacción de la operación (client de withTransaction), con la wallet ya bloqueada
  // con lockWallets. No traduce errores de la base a propósito: si el movimiento dejara un saldo negativo, el CHECK
  // (available >= 0 / held >= 0) aborta la transacción entera. Es la última defensa contra el doble gasto; el flujo
  // normal ya comprobó el saldo bajo bloqueo y nunca debería llegar a dispararla.
  async applyMovement(client: PoolClient, m: MovementInput): Promise<AppliedMovement> {
    const amount = new Decimal(m.amount);
    // No son errores de entrada del usuario (eso lo valida el DTO): llegar aquí con esto es un error de programación.
    if (!amount.isFinite() || amount.lte(0)) {
      throw new Error(`El monto de un movimiento debe ser mayor que 0, recibió ${m.amount}`);
    }
    if (amount.decimalPlaces() > AMOUNT_DECIMALS) {
      throw new Error(`El monto de un movimiento admite como máximo ${AMOUNT_DECIMALS} decimales, recibió ${m.amount}`);
    }
    const delta = m.entryType === 'CREDIT' ? amount : amount.neg();

    const { rows } = await client.query<{ id: string; balance_before: string; balance_after: string }>(
      `WITH moved AS (
         UPDATE wallets
            SET available  = available + CASE WHEN $2::text = 'AVAILABLE' THEN $3::numeric ELSE 0 END,
                held       = held      + CASE WHEN $2::text = 'HELD'      THEN $3::numeric ELSE 0 END,
                updated_at = now()
          WHERE id = $1::uuid
         RETURNING CASE WHEN $2::text = 'AVAILABLE' THEN available ELSE held END AS balance_after
       )
       INSERT INTO ledger_entries
              (wallet_id, reference_type, exchange_id, entry_type, balance_type, amount, balance_before, balance_after)
       SELECT $1::uuid, $4::text, $5::uuid, $6::text, $2::text, $7::numeric, balance_after - $3::numeric, balance_after
         FROM moved
       RETURNING id, balance_before, balance_after`,
      [
        m.walletId,
        m.balanceType,
        delta.toFixed(AMOUNT_DECIMALS),
        m.reference.type,
        m.reference.type === 'EXCHANGE' ? m.reference.exchangeId : null,
        m.entryType,
        amount.toFixed(AMOUNT_DECIMALS),
      ],
    );

    // El UPDATE no encontró la wallet: el INSERT ... SELECT no insertó nada y no hay error de la base que avise.
    if (rows.length === 0) throw new Error(`La wallet ${m.walletId} no existe`);

    return { id: rows[0].id, balanceBefore: rows[0].balance_before, balanceAfter: rows[0].balance_after };
  }
}
