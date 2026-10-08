import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { INestApplication, Type } from '@nestjs/common';
import { Test, TestingModuleBuilder } from '@nestjs/testing';
import { Pool } from 'pg';
import { AppModule } from '../src/app.module';
import { withTransaction } from '../src/common/db/pg-pool';
import { calculateQuote, FEE_RATE, formatAmount, PRICE } from '../src/common/money/money';
import { LedgerRepository } from '../src/wallets/ledger.repository';
import { TEST_DATABASE_URL } from './env';

// Pool propio de las pruebas, para preparar y consultar datos directamente en SQL.
export const testPool = new Pool({ connectionString: TEST_DATABASE_URL });

const SEED_SQL = readFileSync(join(__dirname, '..', 'migrations', '002_seed.sql'), 'utf8');

// Deja la base como recién migrada: vacía las tablas y vuelve a cargar la semilla (plan §2).
// TRUNCATE no dispara los triggers de solo inserción, que sí bloquean DELETE. schema_migrations no se toca.
export async function resetDb(): Promise<void> {
  await testPool.query(`
    TRUNCATE users, assets, wallets, quotes, exchanges, idempotency_keys, ledger_entries,
             compliance_checks, compliance_decisions, exchange_events
    RESTART IDENTITY CASCADE`);
  await testPool.query(SEED_SQL);
}

export interface CreateAppOptions {
  // Sustituye providers, por ejemplo el servicio de cumplimiento por uno que falla:
  // { overrides: (b) => b.overrideProvider(X).useValue(Y) }
  overrides?: (builder: TestingModuleBuilder) => TestingModuleBuilder;
  // Controllers que solo existen en las pruebas (p. ej. rutas de prueba para los guards).
  controllers?: Type<unknown>[];
}

// Levanta la app completa en memoria (sin abrir un puerto).
export async function createApp({ overrides, controllers }: CreateAppOptions = {}): Promise<INestApplication> {
  let builder = Test.createTestingModule({ imports: [AppModule], controllers });
  if (overrides) builder = overrides(builder);
  const app = (await builder.compile()).createNestApplication();
  await app.init();
  return app;
}

// Cada archivo de prueba lo llama en su afterAll para que Jest termine sin conexiones abiertas.
export async function closeDb(): Promise<void> {
  await testPool.end();
}

// Montos pseudoaleatorios como string con 8 decimales (entre 0.00000001 y ~1.000.000 USDT), reproducibles: la misma
// semilla da siempre los mismos montos. Usa un generador congruencial y BigInt; no hay Math.random ni Number.
export function randomAmounts(count: number, seed = 12345n): string[] {
  let state = seed;
  const next = (): bigint => (state = (state * 6364136223846793005n + 1442695040888963407n) % 2n ** 64n);
  const amounts: string[] = [];
  for (let i = 0; i < count; i++) {
    const digits = 1n + (next() % 14n); // magnitudes variadas: de 1 a 14 dígitos en unidades de 1e-8
    const units = 1n + (next() % 10n ** digits);
    amounts.push(`${units / 100000000n}.${(units % 100000000n).toString().padStart(8, '0')}`);
  }
  return amounts;
}

// Inserta una cotización calculada con el mismo código de producción. `ageSeconds` la "envejece": created_at queda
// en el pasado y expires_at = created_at + 30 s, de modo que ageSeconds >= 30 da una cotización ya vencida.
// (El trigger impide editar expires_at después, así que una cotización vencida hay que insertarla ya vencida.)
export async function insertQuote(options: { amount: string; userId?: string; ageSeconds?: number }): Promise<string> {
  const { amount, userId = 'user-001', ageSeconds = 0 } = options;
  const q = calculateQuote(amount);
  const { rows } = await testPool.query<{ id: string }>(
    `INSERT INTO quotes (user_id, source_asset, target_asset, source_amount, price, fee_rate,
                         fee_amount, net_amount, target_amount, created_at, expires_at)
     VALUES ($1, 'USDT-SBX', 'XAUT-SBX', $2, $3, $4, $5, $6, $7,
             now() - make_interval(secs => $8), now() - make_interval(secs => $8) + interval '30 seconds')
     RETURNING id`,
    [userId, amount, formatAmount(PRICE), FEE_RATE.toFixed(6), formatAmount(q.feeAmount), formatAmount(q.netAmount), formatAmount(q.targetAmount), ageSeconds],
  );
  return rows[0].id;
}

// Inserta un intercambio en PROCESSING (el único estado en que puede nacer) sobre una cotización.
export async function insertExchange(quoteId: string, options: { userId?: string; key?: string } = {}): Promise<string> {
  const { userId = 'user-001', key = `key-${quoteId}` } = options;
  const { rows } = await testPool.query<{ id: string }>(
    "INSERT INTO exchanges (user_id, quote_id, idempotency_key, status) VALUES ($1, $2, $3, 'PROCESSING') RETURNING id",
    [userId, quoteId, key],
  );
  return rows[0].id;
}

// Aplica un movimiento de ledger con el MISMO código de producción (LedgerRepository), para preparar escenarios.
export async function ledgerMove(m: {
  userId: string;
  asset: string;
  exchangeId: string;
  entryType: 'DEBIT' | 'CREDIT';
  balanceType: 'AVAILABLE' | 'HELD';
  amount: string;
}): Promise<void> {
  const id = await walletIdOf(m.userId, m.asset);
  await withTransaction(testPool, (client) =>
    new LedgerRepository().applyMovement(client, {
      walletId: id,
      entryType: m.entryType,
      balanceType: m.balanceType,
      amount: m.amount,
      reference: { type: 'EXCHANGE', exchangeId: m.exchangeId },
    }),
  );
}

// id de la wallet de un usuario y un activo.
export async function walletIdOf(userId: string, asset: string): Promise<string> {
  const { rows } = await testPool.query<{ id: string }>(
    'SELECT id FROM wallets WHERE user_id = $1 AND asset_code = $2',
    [userId, asset],
  );
  return rows[0].id;
}

// Comprueba la CONTABILIDAD de toda la base (lo que haría una conciliación en producción). Si algo no cuadra, la
// prueba falla mostrando exactamente qué wallet o qué movimiento está mal. Se llama al final de las pruebas que mueven saldos.
//   1) El saldo de cada wallet (available y held) es igual a la suma de sus movimientos: créditos menos débitos.
//   2) Cada movimiento empieza donde terminó el anterior de la misma wallet y del mismo saldo (cadena sin huecos),
//      arrancando en 0. Detecta un saldo modificado por fuera del ledger o un movimiento con el "antes" equivocado.
export async function assertReconciled(): Promise<void> {
  const signed = "CASE l.entry_type WHEN 'CREDIT' THEN l.amount ELSE -l.amount END";
  const balanceMismatches = await testPool.query(
    `SELECT user_id, asset_code, available, ledger_available, held, ledger_held FROM (
       SELECT w.user_id, w.asset_code, w.available, w.held,
              COALESCE(SUM(CASE WHEN l.balance_type = 'AVAILABLE' THEN ${signed} END), 0)::numeric(28,8) AS ledger_available,
              COALESCE(SUM(CASE WHEN l.balance_type = 'HELD'      THEN ${signed} END), 0)::numeric(28,8) AS ledger_held
         FROM wallets w LEFT JOIN ledger_entries l ON l.wallet_id = w.id
        GROUP BY w.id
     ) t
      WHERE available <> ledger_available OR held <> ledger_held
      ORDER BY user_id, asset_code`,
  );
  const brokenChains = await testPool.query(
    `SELECT wallet_id, balance_type, id, balance_before, expected_before FROM (
       SELECT wallet_id, balance_type, id, balance_before,
              COALESCE(LAG(balance_after) OVER (PARTITION BY wallet_id, balance_type ORDER BY id), 0)::numeric(28,8) AS expected_before
         FROM ledger_entries
     ) t
      WHERE balance_before <> expected_before
      ORDER BY id`,
  );
  expect({ walletsQueNoCuadranConSuLedger: balanceMismatches.rows, movimientosConCadenaRota: brokenChains.rows }).toEqual({
    walletsQueNoCuadranConSuLedger: [],
    movimientosConCadenaRota: [],
  });
}
