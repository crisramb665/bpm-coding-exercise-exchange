import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { closeDb, createApp, resetDb, testPool } from '../helpers';

// Prueba de humo de la infraestructura: la base de pruebas está migrada y sembrada, y la app arranca.
describe('infraestructura de pruebas', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createApp();
  });

  beforeEach(async () => {
    await resetDb();
  });

  afterAll(async () => {
    await app.close();
    await closeDb();
  });

  it('usa la base exchange_test, no la de desarrollo', async () => {
    const { rows } = await testPool.query<{ db: string }>('SELECT current_database() AS db');
    expect(rows[0].db).toBe('exchange_test');
  });

  it('tiene aplicadas las dos migraciones', async () => {
    const { rows } = await testPool.query<{ filename: string }>('SELECT filename FROM schema_migrations ORDER BY 1');
    expect(rows.map((r) => r.filename)).toEqual(['001_schema.sql', '002_seed.sql']);
  });

  it('resetDb deja la semilla: user-001 con 10.000 USDT-SBX y su movimiento inicial', async () => {
    // Se ensucia la base (se mueve el saldo a mano) para comprobar que resetDb realmente la restaura.
    await testPool.query("UPDATE wallets SET available = 1 WHERE user_id = 'user-001' AND asset_code = 'USDT-SBX'");
    await resetDb();

    const wallet = await testPool.query<{ available: string; held: string; total: string }>(
      "SELECT available, held, total FROM wallets WHERE user_id = 'user-001' AND asset_code = 'USDT-SBX'",
    );
    // numeric llega como string: se compara como string, nunca como Number.
    expect(wallet.rows[0]).toEqual({ available: '10000.00000000', held: '0.00000000', total: '10000.00000000' });

    const ledger = await testPool.query<{ n: string }>('SELECT count(*) AS n FROM ledger_entries');
    expect(ledger.rows[0].n).toBe('1');
  });

  it('la app arranca y responde 404 en una ruta inexistente', async () => {
    await request(app.getHttpServer()).get('/no-existe').expect(404);
  });
});
