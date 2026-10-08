import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { closeDb, createApp, insertExchange, insertQuote, ledgerMove, resetDb, testPool } from '../helpers';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('wallets', () => {
  let app: INestApplication;
  const get = (path: string, userId?: string) => {
    const req = request(app.getHttpServer()).get(path);
    return userId ? req.set('X-User-Id', userId) : req;
  };

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

  // id de la wallet de un usuario y un activo, leído directamente de la base.
  const walletId = async (userId: string, asset: string): Promise<string> => {
    const { rows } = await testPool.query<{ id: string }>(
      'SELECT id FROM wallets WHERE user_id = $1 AND asset_code = $2',
      [userId, asset],
    );
    return rows[0].id;
  };

  // Una operación HIGH retenida y luego rechazada, tal como la ejecutará la app (D1): produce 4 movimientos reales
  // sobre la wallet USDT, de modo que wallet y ledger siguen cuadrando. 5.000,01 → retención y liberación.
  const holdAndRelease = async (): Promise<void> => {
    const exchangeId = await insertExchange(await insertQuote({ amount: '5000.01' }));
    const usdt = { userId: 'user-001', asset: 'USDT-SBX', exchangeId, amount: '5000.01' };
    await ledgerMove({ ...usdt, entryType: 'DEBIT', balanceType: 'AVAILABLE' }); // retener
    await ledgerMove({ ...usdt, entryType: 'CREDIT', balanceType: 'HELD' });
    await ledgerMove({ ...usdt, entryType: 'DEBIT', balanceType: 'HELD' }); // liberar (rechazo)
    await ledgerMove({ ...usdt, entryType: 'CREDIT', balanceType: 'AVAILABLE' });
  };

  describe('GET /wallets', () => {
    it('401 sin usuario', async () => {
      const res = await get('/wallets').expect(401);
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
    });

    it('user-001 ve sus dos wallets: 10.000 / 0 / 10.000 USDT y 0 XAUT, ordenadas por activo', async () => {
      const res = await get('/wallets', 'user-001').expect(200);

      expect(res.body).toHaveLength(2);
      const [usdt, xaut] = res.body;
      expect(usdt).toEqual({
        id: expect.stringMatching(UUID),
        asset: 'USDT-SBX',
        available: '10000.00000000', // los montos viajan como string, tal como salen de numeric(28,8)
        held: '0.00000000',
        total: '10000.00000000',
        updated_at: expect.any(String),
      });
      expect(xaut).toEqual({
        id: expect.stringMatching(UUID),
        asset: 'XAUT-SBX',
        available: '0.00000000',
        held: '0.00000000',
        total: '0.00000000',
        updated_at: expect.any(String),
      });
    });

    it('cada usuario ve solo las suyas: compliance-001 no ve el saldo de user-001', async () => {
      const res = await get('/wallets', 'compliance-001').expect(200);
      expect(res.body).toHaveLength(2);
      expect(res.body.map((w: { total: string }) => w.total)).toEqual(['0.00000000', '0.00000000']);

      const mine = new Set(res.body.map((w: { id: string }) => w.id));
      expect(mine.has(await walletId('user-001', 'USDT-SBX'))).toBe(false);
    });

    it('refleja el saldo disponible, retenido y total que hay en la base', async () => {
      await testPool.query(
        "UPDATE wallets SET available = 7000.5, held = 2999.5 WHERE user_id = 'user-001' AND asset_code = 'USDT-SBX'",
      );
      const res = await get('/wallets', 'user-001').expect(200);
      expect(res.body[0]).toMatchObject({ available: '7000.50000000', held: '2999.50000000', total: '10000.00000000' });
    });
  });

  describe('GET /wallets/:id/movements', () => {
    it('user-001 ve el depósito inicial de su wallet USDT', async () => {
      const id = await walletId('user-001', 'USDT-SBX');
      const res = await get(`/wallets/${id}/movements`, 'user-001').expect(200);

      expect(res.body).toEqual([
        {
          id: expect.stringMatching(/^\d+$/), // bigint como string
          entry_type: 'CREDIT',
          balance_type: 'AVAILABLE',
          amount: '10000.00000000',
          balance_before: '0.00000000',
          balance_after: '10000.00000000',
          status: 'CONFIRMED',
          reference_type: 'INITIAL_DEPOSIT',
          exchange_id: null,
          created_at: expect.any(String),
        },
      ]);
    });

    it('una wallet sin movimientos devuelve una lista vacía, no un error', async () => {
      const id = await walletId('user-001', 'XAUT-SBX');
      const res = await get(`/wallets/${id}/movements`, 'user-001').expect(200);
      expect(res.body).toEqual([]);
    });

    it('del más reciente al más antiguo, con el saldo anterior y posterior de cada movimiento', async () => {
      await holdAndRelease();
      const id = await walletId('user-001', 'USDT-SBX');

      const res = await get(`/wallets/${id}/movements`, 'user-001').expect(200);
      const summary = res.body.map((m: Record<string, string>) => [
        m.entry_type, m.balance_type, m.amount, m.balance_before, m.balance_after, m.reference_type,
      ]);
      expect(summary).toEqual([
        ['CREDIT', 'AVAILABLE', '5000.01000000', '4999.99000000', '10000.00000000', 'EXCHANGE'], // liberación
        ['DEBIT', 'HELD', '5000.01000000', '5000.01000000', '0.00000000', 'EXCHANGE'],
        ['CREDIT', 'HELD', '5000.01000000', '0.00000000', '5000.01000000', 'EXCHANGE'], // retención
        ['DEBIT', 'AVAILABLE', '5000.01000000', '10000.00000000', '4999.99000000', 'EXCHANGE'],
        ['CREDIT', 'AVAILABLE', '10000.00000000', '0.00000000', '10000.00000000', 'INITIAL_DEPOSIT'], // el más antiguo
      ]);
      expect(res.body[0].exchange_id).toMatch(UUID);
      // El orden es por id estrictamente decreciente (los ids son strings de bigint).
      const ids: bigint[] = res.body.map((m: { id: string }) => BigInt(m.id));
      expect(ids).toEqual([...ids].sort((a, b) => (a > b ? -1 : 1)));
    });

    it('limit recorta a los N más recientes', async () => {
      await holdAndRelease();
      const id = await walletId('user-001', 'USDT-SBX');

      const res = await get(`/wallets/${id}/movements?limit=2`, 'user-001').expect(200);
      expect(res.body.map((m: Record<string, string>) => `${m.entry_type} ${m.balance_type}`)).toEqual([
        'CREDIT AVAILABLE',
        'DEBIT HELD',
      ]);
    });

    it('sin limit devuelve 50 (el valor por defecto); con limit=200 devuelve todos', async () => {
      for (let i = 0; i < 13; i++) await holdAndRelease(); // 13 × 4 movimientos + el depósito inicial = 53
      const id = await walletId('user-001', 'USDT-SBX');

      expect((await get(`/wallets/${id}/movements`, 'user-001').expect(200)).body).toHaveLength(50);
      expect((await get(`/wallets/${id}/movements?limit=200`, 'user-001').expect(200)).body).toHaveLength(53);
    });

    it('limit acepta los extremos 1 y 200', async () => {
      const id = await walletId('user-001', 'USDT-SBX');
      expect((await get(`/wallets/${id}/movements?limit=1`, 'user-001').expect(200)).body).toHaveLength(1);
      await get(`/wallets/${id}/movements?limit=200`, 'user-001').expect(200);
    });

    it.each(['0', '201', '-1', '1.5', 'abc', '', '1e2', '05', '%205'])('400 si limit es "%s"', async (limit) => {
      const id = await walletId('user-001', 'USDT-SBX');
      const res = await get(`/wallets/${id}/movements?limit=${limit}`, 'user-001').expect(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.details.fields[0].field).toBe('limit');
    });

    it('400 si el id no es un uuid', async () => {
      const res = await get('/wallets/no-es-uuid/movements', 'user-001').expect(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.details.fields[0].field).toBe('id');
    });

    it('404 WALLET_NOT_FOUND si la wallet es de otro usuario (B8), igual que si no existe', async () => {
      const ajena = await walletId('compliance-001', 'USDT-SBX');
      const inexistente = '00000000-0000-4000-8000-000000000000';

      const a = await get(`/wallets/${ajena}/movements`, 'user-001').expect(404);
      const b = await get(`/wallets/${inexistente}/movements`, 'user-001').expect(404);

      expect(a.body.error.code).toBe('WALLET_NOT_FOUND');
      // Misma respuesta en ambos casos: no se revela si el id existe.
      expect(a.body).toEqual(b.body);
    });

    it('la restricción es simétrica: compliance-001 tampoco ve las wallets de user-001', async () => {
      const id = await walletId('user-001', 'USDT-SBX');
      await get(`/wallets/${id}/movements`, 'compliance-001').expect(404);
    });

    it('COMPLIANCE consulta los movimientos de su propia wallet', async () => {
      const id = await walletId('compliance-001', 'USDT-SBX');
      const res = await get(`/wallets/${id}/movements`, 'compliance-001').expect(200);
      expect(res.body).toEqual([]);
    });

    it('401 sin usuario, antes de mirar el id', async () => {
      await get('/wallets/no-es-uuid/movements').expect(401);
    });
  });
});
