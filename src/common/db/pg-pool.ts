import { Pool, PoolClient } from 'pg';

// Token de inyección del Pool de pg.
export const PG_POOL = Symbol('PG_POOL');

// Ejecuta `fn` dentro de una transacción: BEGIN, luego COMMIT si termina bien o ROLLBACK si lanza.
// Regla del proyecto: dentro de `fn` solo se hace SQL; nunca se llama a servicios externos con la transacción abierta.
export async function withTransaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let broken: Error | undefined;
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      // Si ni el ROLLBACK funciona la conexión está rota: se descarta en lugar de devolverla al pool.
      broken = rollbackErr as Error;
    }
    throw err; // Siempre se relanza el error original, no el del ROLLBACK.
  } finally {
    client.release(broken);
  }
}
