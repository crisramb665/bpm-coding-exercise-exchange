import { Pool } from 'pg';
import { withTransaction } from '../../src/common/db/pg-pool';
import { TEST_DATABASE_URL } from '../env';
import { closeDb, resetDb, testPool } from '../helpers';

// withTransaction contra la base real: COMMIT, ROLLBACK y devolución de la conexión al pool.
describe('withTransaction', () => {
  // Pool propio para poder inspeccionar totalCount/idleCount sin interferencia de otras consultas.
  const pool = new Pool({ connectionString: TEST_DATABASE_URL });

  beforeEach(async () => {
    await resetDb();
  });

  afterAll(async () => {
    await pool.end();
    await closeDb();
  });

  const readAvailable = async (reader: Pool): Promise<string> => {
    const { rows } = await reader.query<{ available: string }>(
      "SELECT available FROM wallets WHERE user_id = 'user-001' AND asset_code = 'USDT-SBX'",
    );
    return rows[0].available;
  };

  // Cada caso se lee con el lector que NO puede engañarse:
  //  - COMMIT: desde OTRA conexión (testPool). El mismo pool vería sus propios cambios aunque no se hubieran confirmado.
  //  - ROLLBACK: desde el MISMO pool probado. Si la transacción quedara abierta, su conexión (devuelta al pool)
  //    vería sus cambios sin confirmar; otra conexión nunca los vería y no distinguiría "revertido" de "pendiente".

  it('confirma los cambios y devuelve el resultado de la función', async () => {
    const result = await withTransaction(pool, async (client) => {
      await client.query("UPDATE wallets SET available = 5 WHERE user_id = 'user-001' AND asset_code = 'USDT-SBX'");
      return 'listo';
    });
    expect(result).toBe('listo');
    expect(await readAvailable(testPool)).toBe('5.00000000');
  });

  it('revierte TODO si la función lanza, y relanza el error original', async () => {
    const boom = new Error('falla a mitad de la transacción');
    await expect(
      withTransaction(pool, async (client) => {
        await client.query("UPDATE wallets SET available = 5 WHERE user_id = 'user-001' AND asset_code = 'USDT-SBX'");
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(await readAvailable(pool)).toBe('10000.00000000'); // sin cambios
  });

  it('revierte si la base rechaza una sentencia (CHECK de saldo no negativo)', async () => {
    await expect(
      withTransaction(pool, async (client) => {
        await client.query("UPDATE wallets SET held = 1 WHERE user_id = 'user-001' AND asset_code = 'USDT-SBX'");
        await client.query("UPDATE wallets SET available = -1 WHERE user_id = 'user-001' AND asset_code = 'USDT-SBX'");
      }),
    ).rejects.toThrow(/wallets_available_check/);

    const { rows } = await pool.query<{ held: string }>(
      "SELECT held FROM wallets WHERE user_id = 'user-001' AND asset_code = 'USDT-SBX'",
    );
    expect(rows[0].held).toBe('0.00000000'); // el primer UPDATE tampoco quedó
  });

  it('devuelve la conexión al pool tanto al confirmar como al revertir', async () => {
    await withTransaction(pool, async () => undefined);
    await withTransaction(pool, async () => {
      throw new Error('x');
    }).catch(() => undefined);
    expect(pool.totalCount).toBe(pool.idleCount); // ninguna conexión quedó retenida

    // Y la conexión que vuelve al pool está limpia: no arrastra una transacción con escrituras sin cerrar.
    const { rows } = await pool.query<{ clean: boolean }>('SELECT pg_current_xact_id_if_assigned() IS NULL AS clean');
    expect(rows[0].clean).toBe(true);
  });
});
