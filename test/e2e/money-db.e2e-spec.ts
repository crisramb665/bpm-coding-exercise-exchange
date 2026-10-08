import { calculateQuote, FEE_RATE, formatAmount, PRICE } from '../../src/common/money/money';
import { closeDb, randomAmounts, resetDb, testPool } from '../helpers';

// El cálculo de cotización existe dos veces: en TypeScript (decimal.js) y como CHECKs de quotes en 001_schema.sql.
// Estas pruebas aseguran que coinciden: cualquier cotización que calcula el código debe aceptarla la base.
describe('calculateQuote vs. CHECKs de la tabla quotes', () => {
  beforeAll(async () => {
    await resetDb();
  });

  afterAll(async () => {
    await closeDb();
  });

  const insertQuote = (client: { query: typeof testPool.query }, source: string) => {
    const q = calculateQuote(source);
    return client.query(
      `INSERT INTO quotes (user_id, source_asset, target_asset, source_amount, price, fee_rate,
                           fee_amount, net_amount, target_amount, expires_at)
       VALUES ('user-001', 'USDT-SBX', 'XAUT-SBX', $1, $2, $3, $4, $5, $6, now() + interval '30 seconds')`,
      [source, formatAmount(PRICE), FEE_RATE.toFixed(6), formatAmount(q.feeAmount), formatAmount(q.netAmount), formatAmount(q.targetAmount)],
    );
  };

  it('la base acepta lo que calcula el código en 500 montos pseudoaleatorios', async () => {
    // El generador incluye montos diminutos (< 0,0000253) cuyo destino es 0: esos los rechaza D12 y se excluyen aquí.
    const amounts = randomAmounts(500, 777n).filter((a) => !calculateQuote(a).targetAmount.isZero());
    expect(amounts.length).toBeGreaterThan(300); // con esta semilla sobreviven 355

    // Una sola transacción que se revierte: no deja cotizaciones sueltas. Si un solo monto viola un CHECK, falla todo.
    const client = await testPool.connect();
    try {
      await client.query('BEGIN');
      for (const amount of amounts) await insertQuote(client, amount);
      const { rows } = await client.query<{ n: string }>('SELECT count(*) AS n FROM quotes');
      expect(rows[0].n).toBe(String(amounts.length));
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it.each(['999.99', '1000', '2500', '5000', '5000.01', '0.12345678', '0.00002526'])(
    'la base acepta los montos de la tabla de la spec: %s',
    async (amount) => {
      await insertQuote(testPool, amount);
    },
  );

  it('respalda D12: un monto cuyo destino da 0 lo rechaza la base (target_amount > 0)', async () => {
    expect(calculateQuote('0.00002525').targetAmount.isZero()).toBe(true);
    await expect(insertQuote(testPool, '0.00002525')).rejects.toThrow(/quotes_target_amount_check/);
  });

  it('la base rechaza una comisión redondeada hacia abajo y un destino redondeado hacia arriba', async () => {
    const insert = (fee: string, net: string, target: string) =>
      testPool.query(
        `INSERT INTO quotes (user_id, source_asset, target_asset, source_amount, price, fee_rate,
                             fee_amount, net_amount, target_amount, expires_at)
         VALUES ('user-001', 'USDT-SBX', 'XAUT-SBX', '0.12345678', 2500, 0.01, $1, $2, $3, now() + interval '30 seconds')`,
        [fee, net, target],
      );
    await expect(insert('0.00123456', '0.12222222', '0.00004888')).rejects.toThrow(/violates check constraint/); // fee ↓
    await expect(insert('0.00123457', '0.12222221', '0.00004889')).rejects.toThrow(/violates check constraint/); // target ↑
    await insert('0.00123457', '0.12222221', '0.00004888'); // los valores correctos sí pasan
  });
});
