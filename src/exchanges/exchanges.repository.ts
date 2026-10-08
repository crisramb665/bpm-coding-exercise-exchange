import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';

export interface LockedQuote {
  id: string;
  status: 'ACTIVE' | 'EXPIRED' | 'USED';
  source_asset: string;
  source_amount: string;
}

export interface LiveExchange {
  id: string;
  status: string;
}

@Injectable()
export class ExchangesRepository {
  // Bloquea la fila de la cotización (FOR UPDATE): serializa a todas las peticiones que quieran ejecutarla.
  // Se filtra también por user_id: una cotización ajena es indistinguible de una inexistente (404).
  async lockQuote(client: PoolClient, quoteId: string, userId: string): Promise<LockedQuote | undefined> {
    const { rows } = await client.query<LockedQuote>(
      `SELECT id, status, source_asset, source_amount
         FROM quotes
        WHERE id = $1 AND user_id = $2
          FOR UPDATE`,
      [quoteId, userId],
    );
    return rows[0];
  }

  // ¿Ya venció? Con el reloj de la base (S6), en una sentencia APARTE y POSTERIOR a lockQuote.
  // Dos detalles que importan:
  //  - clock_timestamp() y no now(): now() es la hora de INICIO de la transacción, y esta pudo esperar un bloqueo un rato.
  //  - No puede ir en la misma sentencia que el FOR UPDATE: PostgreSQL calcula las columnas del SELECT ANTES de esperar el
  //    bloqueo, así que clock_timestamp() mediría el instante previo a la espera y no el de haberlo obtenido.
  async hasExpired(client: PoolClient, quoteId: string): Promise<boolean> {
    const { rows } = await client.query<{ expired: boolean }>(
      'SELECT clock_timestamp() >= expires_at AS expired FROM quotes WHERE id = $1',
      [quoteId],
    );
    return rows[0].expired;
  }

  // El intercambio "vivo" de una cotización: cualquiera que no sea FAILED (D8). Como la cotización ya está bloqueada,
  // nadie puede crear uno entre esta lectura y nuestro INSERT.
  async findLiveByQuote(client: PoolClient, quoteId: string): Promise<LiveExchange | undefined> {
    const { rows } = await client.query<LiveExchange>(
      "SELECT id, status FROM exchanges WHERE quote_id = $1 AND status <> 'FAILED'",
      [quoteId],
    );
    return rows[0];
  }

  async markQuoteExpired(client: PoolClient, quoteId: string): Promise<void> {
    await client.query("UPDATE quotes SET status = 'EXPIRED' WHERE id = $1 AND status = 'ACTIVE'", [quoteId]);
  }

  // Lectura SIN bloqueo, solo para fallar rápido. La validación definitiva se repite bajo bloqueo en la segunda transacción.
  async availableBalance(client: PoolClient, userId: string, asset: string): Promise<string | undefined> {
    const { rows } = await client.query<{ available: string }>(
      'SELECT available FROM wallets WHERE user_id = $1 AND asset_code = $2',
      [userId, asset],
    );
    return rows[0]?.available;
  }

  async insert(client: PoolClient, userId: string, quoteId: string, idempotencyKey: string): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      "INSERT INTO exchanges (user_id, quote_id, idempotency_key, status) VALUES ($1, $2, $3, 'PROCESSING') RETURNING id",
      [userId, quoteId, idempotencyKey],
    );
    return rows[0].id;
  }

  // Historial de transiciones (exchange_events, solo inserción). actorId NULL = el sistema.
  async insertEvent(
    client: PoolClient,
    exchangeId: string,
    fromStatus: string | null,
    toStatus: string,
    actorId: string | null,
    reason: string | null = null,
  ): Promise<void> {
    await client.query(
      'INSERT INTO exchange_events (exchange_id, from_status, to_status, actor_id, reason) VALUES ($1, $2, $3, $4, $5)',
      [exchangeId, fromStatus, toStatus, actorId, reason],
    );
  }
}
