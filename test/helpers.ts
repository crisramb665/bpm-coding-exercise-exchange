import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { INestApplication, Type } from '@nestjs/common';
import { Test, TestingModuleBuilder } from '@nestjs/testing';
import { Pool } from 'pg';
import { AppModule } from '../src/app.module';
import { calculateQuote, FEE_RATE, formatAmount, PRICE } from '../src/common/money/money';
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

// Aplica un movimiento de ledger a mano (saldo + movimiento en una sola sentencia), para preparar escenarios.
// Las columnas se eligen de una lista fija, nunca desde entrada externa. La app lo hará con LedgerRepository (T10).
export async function ledgerMove(m: {
  userId: string;
  asset: string;
  exchangeId: string;
  entryType: 'DEBIT' | 'CREDIT';
  balanceType: 'AVAILABLE' | 'HELD';
  amount: string;
}): Promise<void> {
  const column = m.balanceType === 'AVAILABLE' ? 'available' : 'held';
  const sign = m.entryType === 'CREDIT' ? '+' : '-';
  const after = column; // tras el UPDATE, RETURNING entrega el saldo nuevo
  await testPool.query(
    `WITH moved AS (
       UPDATE wallets SET ${column} = ${column} ${sign} $3
        WHERE user_id = $1 AND asset_code = $2
       RETURNING id, ${after} AS balance_after
     )
     INSERT INTO ledger_entries (wallet_id, reference_type, exchange_id, entry_type, balance_type, amount, balance_before, balance_after)
     SELECT id, 'EXCHANGE', $4, $5, $6, $3,
            CASE WHEN $5 = 'CREDIT' THEN balance_after - $3 ELSE balance_after + $3 END, balance_after
       FROM moved`,
    [m.userId, m.asset, m.amount, m.exchangeId, m.entryType, m.balanceType],
  );
}
