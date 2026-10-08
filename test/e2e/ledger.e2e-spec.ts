import Decimal from 'decimal.js';
import { PoolClient } from 'pg';
import { withTransaction } from '../../src/common/db/pg-pool';
import { LedgerRepository, MovementInput } from '../../src/wallets/ledger.repository';
import { assertReconciled, closeDb, insertExchange, insertQuote, resetDb, testPool, walletIdOf } from '../helpers';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('LedgerRepository', () => {
  const ledger = new LedgerRepository();

  beforeEach(async () => {
    await resetDb();
  });

  afterAll(async () => {
    await closeDb();
  });

  // ---- utilidades ----------------------------------------------------------------------------------------------
  const newExchange = async (amount = '5000.01'): Promise<string> => insertExchange(await insertQuote({ amount }));

  // Aplica varios movimientos en UNA transacción, como lo hará la aplicación.
  const inTx = <T>(fn: (client: PoolClient) => Promise<T>): Promise<T> => withTransaction(testPool, fn);

  const move = async (
    client: PoolClient,
    exchangeId: string,
    user: string,
    asset: string,
    entryType: 'DEBIT' | 'CREDIT',
    balanceType: 'AVAILABLE' | 'HELD',
    amount: string,
  ) =>
    ledger.applyMovement(client, {
      walletId: await walletIdOf(user, asset),
      entryType,
      balanceType,
      amount,
      reference: { type: 'EXCHANGE', exchangeId },
    });

  const balances = async (user: string, asset: string): Promise<{ available: string; held: string }> =>
    (
      await testPool.query<{ available: string; held: string }>(
        'SELECT available, held FROM wallets WHERE user_id = $1 AND asset_code = $2',
        [user, asset],
      )
    ).rows[0];

  const ledgerCount = async (): Promise<number> =>
    Number((await testPool.query<{ n: string }>('SELECT count(*) AS n FROM ledger_entries')).rows[0].n);

  // Los 4 flujos de dinero del sistema, tal como los ejecutará la aplicación (docs/spec.md §6.2).
  const U = 'user-001';
  const USDT = 'USDT-SBX';
  const XAUT = 'XAUT-SBX';
  const lowOrMedium = async (c: PoolClient, ex: string, usdt: string, xaut: string) => {
    await move(c, ex, U, USDT, 'DEBIT', 'AVAILABLE', usdt);
    await move(c, ex, U, XAUT, 'CREDIT', 'AVAILABLE', xaut);
  };
  const hold = async (c: PoolClient, ex: string, usdt: string) => {
    await move(c, ex, U, USDT, 'DEBIT', 'AVAILABLE', usdt);
    await move(c, ex, U, USDT, 'CREDIT', 'HELD', usdt);
  };
  const approve = async (c: PoolClient, ex: string, usdt: string, xaut: string) => {
    await move(c, ex, U, USDT, 'DEBIT', 'HELD', usdt);
    await move(c, ex, U, XAUT, 'CREDIT', 'AVAILABLE', xaut);
  };
  const reject = async (c: PoolClient, ex: string, usdt: string) => {
    await move(c, ex, U, USDT, 'DEBIT', 'HELD', usdt);
    await move(c, ex, U, USDT, 'CREDIT', 'AVAILABLE', usdt);
  };

  // ---- applyMovement -------------------------------------------------------------------------------------------
  describe('applyMovement', () => {
    it('mueve el saldo y registra el movimiento con el saldo anterior y posterior reales', async () => {
      const ex = await newExchange('999.99');

      const applied = await inTx((c) => move(c, ex, U, USDT, 'DEBIT', 'AVAILABLE', '999.99'));

      expect(applied).toEqual({ id: expect.stringMatching(/^\d+$/), balanceBefore: '10000.00000000', balanceAfter: '9000.01000000' });
      expect(await balances(U, USDT)).toEqual({ available: '9000.01000000', held: '0.00000000' });

      const { rows } = await testPool.query(
        `SELECT reference_type, exchange_id, entry_type, balance_type, amount, balance_before, balance_after, status
           FROM ledger_entries WHERE id = $1`,
        [applied.id],
      );
      expect(rows).toEqual([
        {
          reference_type: 'EXCHANGE',
          exchange_id: ex,
          entry_type: 'DEBIT',
          balance_type: 'AVAILABLE',
          amount: '999.99000000',
          balance_before: '10000.00000000',
          balance_after: '9000.01000000',
          status: 'CONFIRMED',
        },
      ]);
    });

    it('un CREDIT suma al saldo indicado y deja el otro saldo intacto', async () => {
      const ex = await newExchange();
      const applied = await inTx((c) => move(c, ex, U, XAUT, 'CREDIT', 'AVAILABLE', '0.39599604'));
      expect(applied).toMatchObject({ balanceBefore: '0.00000000', balanceAfter: '0.39599604' });
      expect(await balances(U, XAUT)).toEqual({ available: '0.39599604', held: '0.00000000' });
    });

    it('acepta la unidad mínima (0,00000001) y actualiza updated_at', async () => {
      const before = (await testPool.query<{ t: Date }>("SELECT updated_at AS t FROM wallets WHERE user_id = 'user-001' AND asset_code = 'XAUT-SBX'")).rows[0].t;
      await sleep(5);
      const ex = await newExchange();
      await inTx((c) => move(c, ex, U, XAUT, 'CREDIT', 'AVAILABLE', '0.00000001'));
      const after = (await testPool.query<{ t: Date }>("SELECT updated_at AS t FROM wallets WHERE user_id = 'user-001' AND asset_code = 'XAUT-SBX'")).rows[0].t;
      expect(after.getTime()).toBeGreaterThan(before.getTime());
    });

    describe('los 4 flujos del sistema dejan la contabilidad cuadrada', () => {
      it('LOW / MEDIUM: débito de USDT y crédito de XAUT (999,99 → 0,39599604)', async () => {
        const ex = await newExchange('999.99');
        await inTx((c) => lowOrMedium(c, ex, '999.99', '0.39599604'));

        expect(await balances(U, USDT)).toEqual({ available: '9000.01000000', held: '0.00000000' });
        expect(await balances(U, XAUT)).toEqual({ available: '0.39599604', held: '0.00000000' });
        expect(await ledgerCount()).toBe(3); // depósito inicial + 2
        await assertReconciled();
      });

      it('HIGH: retener mueve disponible a retenido y el total no cambia', async () => {
        const ex = await newExchange();
        await inTx((c) => hold(c, ex, '5000.01'));

        expect(await balances(U, USDT)).toEqual({ available: '4999.99000000', held: '5000.01000000' });
        const { rows } = await testPool.query("SELECT total FROM wallets WHERE user_id = 'user-001' AND asset_code = 'USDT-SBX'");
        expect(rows[0].total).toBe('10000.00000000');
        await assertReconciled();
      });

      it('aprobar: se debita lo retenido y se acredita el XAUT', async () => {
        const ex = await newExchange();
        await inTx((c) => hold(c, ex, '5000.01'));
        await inTx((c) => approve(c, ex, '5000.01', '1.98000396'));

        expect(await balances(U, USDT)).toEqual({ available: '4999.99000000', held: '0.00000000' });
        expect(await balances(U, XAUT)).toEqual({ available: '1.98000396', held: '0.00000000' });
        expect(await ledgerCount()).toBe(5); // depósito + 2 de la retención + 2 de la aprobación
        await assertReconciled();
      });

      it('rechazar: se libera lo retenido y no se acredita XAUT', async () => {
        const ex = await newExchange();
        await inTx((c) => hold(c, ex, '5000.01'));
        await inTx((c) => reject(c, ex, '5000.01'));

        expect(await balances(U, USDT)).toEqual({ available: '10000.00000000', held: '0.00000000' });
        expect(await balances(U, XAUT)).toEqual({ available: '0.00000000', held: '0.00000000' });
        await assertReconciled();
      });

      it('retener TODO el saldo (10.000) deja el disponible en 0', async () => {
        const ex = await newExchange('10000');
        await inTx((c) => hold(c, ex, '10000'));
        expect(await balances(U, USDT)).toEqual({ available: '0.00000000', held: '10000.00000000' });
        await assertReconciled();
      });
    });

    describe('la última defensa: la base impide saldos negativos', () => {
      it('un débito mayor que el disponible aborta TODA la transacción, incluido lo anterior', async () => {
        const ex = await newExchange();
        const countBefore = await ledgerCount();

        await expect(
          inTx(async (c) => {
            await move(c, ex, U, XAUT, 'CREDIT', 'AVAILABLE', '1'); // esto no debe quedar
            await move(c, ex, U, USDT, 'DEBIT', 'AVAILABLE', '10000.00000001'); // 1 unidad mínima de más
          }),
        ).rejects.toThrow(/wallets_available_check/);

        expect(await balances(U, XAUT)).toEqual({ available: '0.00000000', held: '0.00000000' });
        expect(await balances(U, USDT)).toEqual({ available: '10000.00000000', held: '0.00000000' });
        expect(await ledgerCount()).toBe(countBefore);
        await assertReconciled();
      });

      it('debitar lo retenido sin tener retenido también falla', async () => {
        const ex = await newExchange();
        await expect(inTx((c) => move(c, ex, U, USDT, 'DEBIT', 'HELD', '1'))).rejects.toThrow(/wallets_held_check/);
        await assertReconciled();
      });
    });

    describe('protecciones contra errores de programación', () => {
      it('el mismo movimiento dos veces para una operación se rechaza y se revierte todo', async () => {
        const ex = await newExchange();
        await expect(
          inTx(async (c) => {
            await move(c, ex, U, USDT, 'DEBIT', 'AVAILABLE', '100');
            await move(c, ex, U, USDT, 'DEBIT', 'AVAILABLE', '100'); // duplicado
          }),
        ).rejects.toThrow(/duplicate key/);
        expect(await balances(U, USDT)).toEqual({ available: '10000.00000000', held: '0.00000000' });
      });

      // '1.123456789' es el caso que importa: sin la validación se redondearía a 1.12345679 EN SILENCIO y se movería ese monto.
      // ('0.000000001' lo habría atrapado la base de todos modos, porque se redondea a 0 y viola amount > 0.)
      it.each(['0', '-1', '0.000000001', '1.123456789', 'Infinity', 'NaN'])('rechaza el monto %s sin tocar la base', async (amount) => {
        const ex = await newExchange();
        await expect(inTx((c) => move(c, ex, U, USDT, 'DEBIT', 'AVAILABLE', amount))).rejects.toThrow();
        expect(await balances(U, USDT)).toEqual({ available: '10000.00000000', held: '0.00000000' });
        expect(await ledgerCount()).toBe(1); // solo el depósito inicial
      });

      it('rechaza un texto que no es un número', async () => {
        const ex = await newExchange();
        await expect(inTx((c) => move(c, ex, U, USDT, 'DEBIT', 'AVAILABLE', 'abc'))).rejects.toThrow();
      });

      it('una wallet que no existe da un error claro, no un movimiento fantasma', async () => {
        const ex = await newExchange();
        await expect(
          inTx((c) =>
            ledger.applyMovement(c, {
              walletId: '00000000-0000-4000-8000-000000000000',
              entryType: 'CREDIT',
              balanceType: 'AVAILABLE',
              amount: '1',
              reference: { type: 'EXCHANGE', exchangeId: ex },
            }),
          ),
        ).rejects.toThrow(/no existe/);
        expect(await ledgerCount()).toBe(1);
      });

      it('una operación que no existe se rechaza (clave foránea)', async () => {
        await expect(
          inTx(async (c) =>
            ledger.applyMovement(c, {
              walletId: await walletIdOf(U, USDT),
              entryType: 'DEBIT',
              balanceType: 'AVAILABLE',
              amount: '1',
              reference: { type: 'EXCHANGE', exchangeId: '00000000-0000-4000-8000-000000000000' },
            }),
          ),
        ).rejects.toThrow(/foreign key/);
      });
    });

    describe('depósito inicial (D2)', () => {
      const deposit = (c: PoolClient, walletId: string): Promise<unknown> =>
        ledger.applyMovement(c, { walletId, entryType: 'CREDIT', balanceType: 'AVAILABLE', amount: '50', reference: { type: 'INITIAL_DEPOSIT' } } satisfies MovementInput);

      it('se registra sin operación asociada (exchange_id NULL)', async () => {
        const wallet = await walletIdOf(U, XAUT);
        await inTx((c) => deposit(c, wallet));
        const { rows } = await testPool.query("SELECT reference_type, exchange_id FROM ledger_entries WHERE wallet_id = $1", [wallet]);
        expect(rows).toEqual([{ reference_type: 'INITIAL_DEPOSIT', exchange_id: null }]);
        await assertReconciled();
      });

      it('solo puede haber un depósito inicial por wallet', async () => {
        const wallet = await walletIdOf(U, USDT); // la semilla ya le dio el suyo
        await expect(inTx((c) => deposit(c, wallet))).rejects.toThrow(/ledger_initial_deposit_uq/);
      });
    });

    it('los movimientos son inmutables: ni UPDATE ni DELETE', async () => {
      const ex = await newExchange();
      const applied = await inTx((c) => move(c, ex, U, USDT, 'DEBIT', 'AVAILABLE', '1'));
      await expect(testPool.query('UPDATE ledger_entries SET amount = 2 WHERE id = $1', [applied.id])).rejects.toThrow(/append-only/);
      await expect(testPool.query('DELETE FROM ledger_entries WHERE id = $1', [applied.id])).rejects.toThrow(/append-only/);
    });
  });

  // ---- lockWallets ---------------------------------------------------------------------------------------------
  describe('lockWallets', () => {
    it('devuelve las wallets pedidas con su saldo, ordenadas por id sin importar el orden pedido', async () => {
      const a = await inTx((c) => ledger.lockWallets(c, U, [USDT, XAUT]));
      const b = await inTx((c) => ledger.lockWallets(c, U, [XAUT, USDT]));

      expect(a).toEqual(b); // mismo resultado y mismo orden: el orden global de bloqueo no depende del llamador
      const ids = a.map((w) => w.id);
      expect(ids).toEqual([...ids].sort());
      expect(a.find((w) => w.asset === USDT)).toEqual({ id: expect.any(String), asset: USDT, available: '10000.00000000', held: '0.00000000' });
    });

    it('solo bloquea las del usuario y los activos pedidos', async () => {
      expect(await inTx((c) => ledger.lockWallets(c, U, [USDT]))).toHaveLength(1);
      expect(await inTx((c) => ledger.lockWallets(c, 'nadie', [USDT, XAUT]))).toEqual([]);
      expect(await inTx((c) => ledger.lockWallets(c, U, ['BTC']))).toEqual([]);
    });

    it('una segunda transacción ESPERA hasta que la primera termina (FOR UPDATE)', async () => {
      const first = await testPool.connect();
      const second = await testPool.connect();
      try {
        await first.query('BEGIN');
        await ledger.lockWallets(first, U, [USDT]);

        await second.query('BEGIN');
        let secondGotLock = false;
        const waiting = ledger.lockWallets(second, U, [USDT]).then((rows) => {
          secondGotLock = true;
          return rows;
        });

        await sleep(250);
        expect(secondGotLock).toBe(false); // sigue esperando mientras la primera no termine

        await first.query('COMMIT');
        const rows = await waiting;
        expect(secondGotLock).toBe(true);
        expect(rows).toHaveLength(1);
        await second.query('COMMIT');
      } finally {
        first.release();
        second.release();
      }
    });
  });

  // ---- doble gasto ---------------------------------------------------------------------------------------------
  describe('doble gasto: dos operaciones simultáneas de 6.000 con 10.000 de saldo', () => {
    // Cada operación: decide con el saldo que lee y, si alcanza, retiene 6.000. La pausa de 80 ms ensancha la ventana
    // entre "leer el saldo" y "usarlo", que es donde ocurriría el doble gasto.
    const spend = async (ex: string, lockFirst: boolean): Promise<'OK' | 'INSUFFICIENT'> =>
      inTx(async (c) => {
        const available = lockFirst
          ? new Decimal((await ledger.lockWallets(c, U, [USDT]))[0].available)
          : new Decimal((await c.query<{ available: string }>("SELECT available FROM wallets WHERE user_id = 'user-001' AND asset_code = 'USDT-SBX'")).rows[0].available);
        if (available.lt(6000)) return 'INSUFFICIENT';
        await sleep(80);
        await hold(c, ex, '6000');
        return 'OK';
      });

    it('CON bloqueo: una se ejecuta y la otra ve el saldo ya descontado y se rechaza limpiamente', async () => {
      const [e1, e2] = [await newExchange('6000'), await newExchange('6000')];

      const results = await Promise.all([spend(e1, true), spend(e2, true)]);

      expect([...results].sort()).toEqual(['INSUFFICIENT', 'OK']);
      expect(await balances(U, USDT)).toEqual({ available: '4000.00000000', held: '6000.00000000' });
      await assertReconciled();
    });

    it('SIN bloqueo ambas leen 10.000, pero el CHECK de la base impide el saldo negativo (última defensa)', async () => {
      const [e1, e2] = [await newExchange('6000'), await newExchange('6000')];

      const results = await Promise.allSettled([spend(e1, false), spend(e2, false)]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(String(rejected[0].reason)).toMatch(/wallets_available_check/);
      // Sin el CHECK, el saldo habría quedado en -2.000. Con él, solo una retención se aplicó.
      expect(await balances(U, USDT)).toEqual({ available: '4000.00000000', held: '6000.00000000' });
      await assertReconciled();
    });
  });
});
