import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';

export interface IdempotencyRow {
  request_hash: string;
  exchange_id: string | null;
  response_status: number | null; // NULL = la petición original aún no terminó
  response_body: unknown;
}

// Tabla idempotency_keys. Todas las operaciones reciben el client de la transacción en curso: reservar la clave, guardar
// la respuesta y liberarla (rollback) son parte de la misma transacción que la operación.
@Injectable()
export class IdempotencyRepository {
  // Reserva la clave. true = es nuestra; false = ya existía y hay que leerla (find).
  // ON CONFLICT DO NOTHING sobre la PK (user_id, key): si OTRA transacción acaba de insertar la misma clave y aún no
  // termina, esta sentencia ESPERA a que haga commit (entonces devuelve false) o rollback (entonces inserta). Así dos
  // peticiones simultáneas con la misma clave no pueden ejecutar ambas la operación.
  async reserve(client: PoolClient, userId: string, key: string, requestHash: string): Promise<boolean> {
    const { rowCount } = await client.query(
      `INSERT INTO idempotency_keys (user_id, key, request_hash)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, key) DO NOTHING`,
      [userId, key, requestHash],
    );
    return rowCount === 1;
  }

  async find(client: PoolClient, userId: string, key: string): Promise<IdempotencyRow | undefined> {
    const { rows } = await client.query<IdempotencyRow>(
      'SELECT request_hash, exchange_id, response_status, response_body FROM idempotency_keys WHERE user_id = $1 AND key = $2',
      [userId, key],
    );
    return rows[0];
  }

  // Guarda la respuesta definitiva: desde aquí, repetir la petición devuelve exactamente esto (D11).
  async storeResponse(client: PoolClient, userId: string, key: string, status: number, body: unknown): Promise<void> {
    await client.query(
      'UPDATE idempotency_keys SET response_status = $3, response_body = $4::jsonb WHERE user_id = $1 AND key = $2',
      [userId, key, status, JSON.stringify(body)],
    );
  }

  async linkExchange(client: PoolClient, userId: string, key: string, exchangeId: string): Promise<void> {
    await client.query('UPDATE idempotency_keys SET exchange_id = $3 WHERE user_id = $1 AND key = $2', [userId, key, exchangeId]);
  }

  // Libera la clave: borra la fila. Se usa cuando el resultado es transitorio (503, saldo insuficiente) para que el cliente
  // pueda reintentar con la MISMA clave (D11). Va dentro de la misma transacción que deja la operación en FAILED, así que
  // nadie puede ver la operación FAILED con la clave aún "en curso", ni al revés.
  async release(client: PoolClient, userId: string, key: string): Promise<void> {
    await client.query('DELETE FROM idempotency_keys WHERE user_id = $1 AND key = $2', [userId, key]);
  }
}
