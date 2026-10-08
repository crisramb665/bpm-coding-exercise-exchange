import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { COMPLIANCE_PROVIDER } from '../../src/compliance-service/compliance.types';
import { LedgerRepository } from '../../src/wallets/ledger.repository';
import { ControllableProvider } from '../controllable-provider';
import { assertReconciled, closeDb, createApp, insertExchange, insertQuote, ledgerMove, resetDb, testPool } from '../helpers';

const UNKNOWN = '00000000-0000-4000-8000-000000000001';
const provider = new ControllableProvider();
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Revisión humana de las operaciones HIGH (T14): bandeja, aprobar y rechazar.
describe('compliance-review', () => {
  let app: INestApplication;

  const asUser = (a: INestApplication = app) => ({
    quote: async (amount: string) =>
      (await request(a.getHttpServer()).post('/quotes').set('X-User-Id', 'user-001').send({ source_asset: 'USDT-SBX', target_asset: 'XAUT-SBX', source_amount: amount }).expect(201)).body.id as string,
    execute: (quoteId: string, key: string) =>
      request(a.getHttpServer()).post('/exchanges').set('X-User-Id', 'user-001').set('Idempotency-Key', key).send({ quote_id: quoteId }),
  });
  // Una operación HIGH retenida de user-001: devuelve su id.
  let seq = 0;
  const pending = async (amount = '5000.01', a: INestApplication = app): Promise<string> => {
    const user = asUser(a);
    const res = await user.execute(await user.quote(amount), `k-${++seq}`).expect(201);
    expect(res.body.status).toBe('PENDING_REVIEW');
    return res.body.id;
  };

  // user-001 solo tiene 10.000: tras retener 5.000,01 le quedan 4.999,99 y no puede crear una segunda retención de 6.000.
  // Los tests que necesitan varias operaciones retenidas le dan fondos antes con un abono real del ledger.
  let topUps = 0;
  const topUp = async (amount: string): Promise<void> => {
    const fixture = await insertExchange(await insertQuote({ amount: '1' }), { key: `top-up-${++topUps}` });
    await ledgerMove({ userId: 'user-001', asset: 'USDT-SBX', exchangeId: fixture, entryType: 'CREDIT', balanceType: 'AVAILABLE', amount });
  };

  const review = (method: 'get' | 'patch', path: string, userId: string | null = 'compliance-001', body?: unknown, a: INestApplication = app) => {
    const req = request(a.getHttpServer())[method](path);
    if (userId) req.set('X-User-Id', userId);
    return body === undefined ? req : req.send(body as object);
  };
  const approve = (id: string, body?: unknown, user: string | null = 'compliance-001') => review('patch', `/compliance/exchanges/${id}/approve`, user, body ?? {});
  const reject = (id: string, body?: unknown, user: string | null = 'compliance-001') => review('patch', `/compliance/exchanges/${id}/reject`, user, body ?? { reason: 'No verificado' });

  const wallet = async (user: string, asset: string): Promise<{ available: string; held: string }> =>
    (await testPool.query('SELECT available, held FROM wallets WHERE user_id = $1 AND asset_code = $2', [user, asset])).rows[0];
  const count = async (table: string): Promise<number> => Number((await testPool.query<{ n: string }>(`SELECT count(*) AS n FROM ${table}`)).rows[0].n);
  const status = async (id: string): Promise<string> => (await testPool.query<{ status: string }>('SELECT status FROM exchanges WHERE id = $1', [id])).rows[0].status;
  const movementSummary = (body: { movements: Record<string, string>[] }) =>
    body.movements.map((m) => [m.asset, m.entry_type, m.balance_type, m.amount, m.balance_before, m.balance_after]);

  // D17: Cumplimiento tiene wallets, pero decidir sobre las operaciones de otros nunca las toca.
  const assertComplianceWalletsUntouched = async (): Promise<void> => {
    for (const asset of ['USDT-SBX', 'XAUT-SBX']) {
      expect(await wallet('compliance-001', asset)).toEqual({ available: '0.00000000', held: '0.00000000' });
    }
    const movements = await testPool.query("SELECT count(*) AS n FROM ledger_entries l JOIN wallets w ON w.id = l.wallet_id WHERE w.user_id = 'compliance-001'");
    expect(movements.rows[0].n).toBe('0');
  };

  beforeAll(async () => {
    app = await createApp({ overrides: (b) => b.overrideProvider(COMPLIANCE_PROVIDER).useValue(provider) });
  });

  beforeEach(async () => {
    provider.reset();
    seq = 0;
    topUps = 0;
    await resetDb();
    await testPool.query("INSERT INTO users (id, role, name) VALUES ('user-002', 'USER', 'Otro usuario')");
  });

  afterAll(async () => {
    await app.close();
    await closeDb();
  });

  // ---------------------------------------------------------------------------------------------------------------
  describe('autenticación y rol', () => {
    it('401 sin usuario en las tres rutas', async () => {
      const id = await pending();
      await review('get', '/compliance/exchanges/pending', null).expect(401);
      await approve(id, {}, null).expect(401);
      await reject(id, undefined, null).expect(401);
    });

    it('j: un USER recibe 403 en las tres rutas y no cambia nada', async () => {
      const id = await pending();
      const before = await wallet('user-001', 'USDT-SBX');

      for (const res of [
        await review('get', '/compliance/exchanges/pending', 'user-001').expect(403),
        await approve(id, {}, 'user-001').expect(403),
        await reject(id, { reason: 'x' }, 'user-001').expect(403),
      ]) {
        expect(res.body.error.code).toBe('FORBIDDEN');
      }

      expect(await status(id)).toBe('PENDING_REVIEW');
      expect(await count('compliance_decisions')).toBe(0);
      expect(await wallet('user-001', 'USDT-SBX')).toEqual(before);
      await assertReconciled();
    });
  });

  // ---------------------------------------------------------------------------------------------------------------
  describe('GET /compliance/exchanges/pending', () => {
    it('sin operaciones retenidas devuelve una lista vacía', async () => {
      expect((await review('get', '/compliance/exchanges/pending').expect(200)).body).toEqual([]);
    });

    it('solo las PENDING_REVIEW, de la más antigua a la más reciente, con los campos de la spec', async () => {
      await topUp('20000');
      const first = await pending('5000.01');
      const user = asUser();
      await user.execute(await user.quote('999.99'), 'k-low').expect(201); // COMPLETED: no debe aparecer
      provider.mode = 'fail';
      await user.execute(await user.quote('100'), 'k-failed').expect(503); // FAILED: no debe aparecer
      provider.mode = 'normal';
      await insertExchange(await insertQuote({ amount: '300' }), { key: 'k-proc' }); // PROCESSING: no debe aparecer
      const second = await pending('6000');

      const res = await review('get', '/compliance/exchanges/pending').expect(200);

      expect(res.body.map((e: { id: string }) => e.id)).toEqual([first, second]);
      expect(res.body[0]).toEqual({
        id: first,
        user_id: 'user-001',
        user_name: 'Usuario de prueba',
        source_asset: 'USDT-SBX',
        source_amount: '5000.01000000',
        target_asset: 'XAUT-SBX',
        target_amount: '1.98000396',
        price: '2500.00000000',
        risk_level: 'HIGH',
        created_at: expect.any(String),
      });
    });

    it('incluye las retenidas de cualquier usuario, con su nombre', async () => {
      const mine = await pending();
      const quote = await insertQuote({ amount: '7000', userId: 'user-002' });
      const theirs = await insertExchange(quote, { userId: 'user-002' });
      await testPool.query("UPDATE exchanges SET status = 'PENDING_REVIEW', risk_level = 'HIGH' WHERE id = $1", [theirs]);

      const res = await review('get', '/compliance/exchanges/pending').expect(200);

      expect(res.body.map((e: { id: string }) => e.id)).toEqual([mine, theirs]);
      expect(res.body[1]).toMatchObject({ user_id: 'user-002', user_name: 'Otro usuario', source_amount: '7000.00000000' });
    });

    it('al decidir, la operación sale de la bandeja', async () => {
      await topUp('20000');
      const a = await pending('5000.01');
      const b = await pending('6000');
      await approve(a).expect(200);
      expect((await review('get', '/compliance/exchanges/pending').expect(200)).body.map((e: { id: string }) => e.id)).toEqual([b]);
      await reject(b).expect(200);
      expect((await review('get', '/compliance/exchanges/pending').expect(200)).body).toEqual([]);
    });

    it('limit recorta a las más antiguas; un limit inválido es 400', async () => {
      await topUp('20000');
      const first = await pending('5000.01');
      await pending('6000');
      expect((await review('get', '/compliance/exchanges/pending?limit=1').expect(200)).body.map((e: { id: string }) => e.id)).toEqual([first]);
      await review('get', '/compliance/exchanges/pending?limit=0').expect(400);
    });
  });

  // ---------------------------------------------------------------------------------------------------------------
  describe('h: aprobar una operación retenida', () => {
    it('200 COMPLETED: se debita lo retenido, se acredita el XAUT cotizado y queda toda la trazabilidad', async () => {
      const id = await pending('5000.01');

      const res = await approve(id, { reason: 'Origen de fondos verificado' }).expect(200);

      expect(res.body).toMatchObject({
        id,
        status: 'COMPLETED',
        risk_level: 'HIGH',
        requires_follow_up: false, // el seguimiento es solo para MEDIUM completada
        failure_reason: null,
        decision: { reviewer_id: 'compliance-001', decision: 'APPROVED', reason: 'Origen de fondos verificado', decided_at: expect.any(String) },
        quote: { price: '2500.00000000', target_amount: '1.98000396', status: 'USED' },
      });
      expect(movementSummary(res.body)).toEqual([
        ['USDT-SBX', 'DEBIT', 'AVAILABLE', '5000.01000000', '10000.00000000', '4999.99000000'], // la retención...
        ['USDT-SBX', 'CREDIT', 'HELD', '5000.01000000', '0.00000000', '5000.01000000'],
        ['USDT-SBX', 'DEBIT', 'HELD', '5000.01000000', '5000.01000000', '0.00000000'], // ...y la aprobación
        ['XAUT-SBX', 'CREDIT', 'AVAILABLE', '1.98000396', '0.00000000', '1.98000396'],
      ]);
      expect(res.body.events.map((e: Record<string, unknown>) => [e.from_status, e.to_status, e.actor_id, e.reason])).toEqual([
        [null, 'PROCESSING', 'user-001', null],
        ['PROCESSING', 'PENDING_REVIEW', null, 'Riesgo HIGH'],
        ['PENDING_REVIEW', 'COMPLETED', 'compliance-001', 'Origen de fondos verificado'],
      ]);

      expect(await wallet('user-001', 'USDT-SBX')).toEqual({ available: '4999.99000000', held: '0.00000000' });
      expect(await wallet('user-001', 'XAUT-SBX')).toEqual({ available: '1.98000396', held: '0.00000000' });
      await assertComplianceWalletsUntouched();
      await assertReconciled();
    });

    it('el motivo es opcional al aprobar', async () => {
      const id = await pending();
      const res = await approve(id).expect(200);
      expect(res.body.decision.reason).toBeNull();
      expect(res.body.events.at(-1)).toMatchObject({ to_status: 'COMPLETED', actor_id: 'compliance-001', reason: null });
    });

    it('lo que devuelve es lo mismo que consulta después el dueño con GET /exchanges/:id', async () => {
      const id = await pending();
      const res = await approve(id, { reason: 'ok' }).expect(200);
      const read = await request(app.getHttpServer()).get(`/exchanges/${id}`).set('X-User-Id', 'user-001').expect(200);
      expect(read.body).toEqual(res.body);
    });

    it('R13: se aprueba con el precio original aunque la cotización YA HAYA VENCIDO mientras estaba retenida', async () => {
      const user = asUser();
      const quote = await insertQuote({ amount: '5000.01', ageSeconds: 28 }); // le quedan ~2 s de vigencia
      const created = await user.execute(quote, 'k-vence').expect(201); // se ejecuta a tiempo
      expect(created.body.status).toBe('PENDING_REVIEW');

      await sleep(2500); // la cotización vence mientras la operación espera a Cumplimiento
      const expired = (await testPool.query<{ vencida: boolean }>('SELECT now() >= expires_at AS vencida FROM quotes WHERE id = $1', [quote])).rows[0].vencida;
      expect(expired).toBe(true);

      const res = await approve(created.body.id).expect(200);

      expect(res.body.status).toBe('COMPLETED');
      expect(res.body.quote).toMatchObject({ price: '2500.00000000', fee_amount: '50.00010000', target_amount: '1.98000396' });
      expect((await wallet('user-001', 'XAUT-SBX')).available).toBe('1.98000396');
      await assertReconciled();
    });
  });

  // ---------------------------------------------------------------------------------------------------------------
  describe('i: rechazar una operación retenida', () => {
    it('200 REJECTED: se libera el saldo retenido y NO se acredita XAUT', async () => {
      const id = await pending('5000.01');

      const res = await reject(id, { reason: 'Origen de fondos no acreditado' }).expect(200);

      expect(res.body).toMatchObject({
        status: 'REJECTED',
        risk_level: 'HIGH',
        requires_follow_up: false,
        decision: { reviewer_id: 'compliance-001', decision: 'REJECTED', reason: 'Origen de fondos no acreditado' },
      });
      expect(movementSummary(res.body)).toEqual([
        ['USDT-SBX', 'DEBIT', 'AVAILABLE', '5000.01000000', '10000.00000000', '4999.99000000'],
        ['USDT-SBX', 'CREDIT', 'HELD', '5000.01000000', '0.00000000', '5000.01000000'],
        ['USDT-SBX', 'DEBIT', 'HELD', '5000.01000000', '5000.01000000', '0.00000000'], // se libera...
        ['USDT-SBX', 'CREDIT', 'AVAILABLE', '5000.01000000', '4999.99000000', '10000.00000000'], // ...de vuelta al disponible
      ]);
      expect(res.body.events.at(-1)).toMatchObject({ from_status: 'PENDING_REVIEW', to_status: 'REJECTED', actor_id: 'compliance-001', reason: 'Origen de fondos no acreditado' });

      expect(await wallet('user-001', 'USDT-SBX')).toEqual({ available: '10000.00000000', held: '0.00000000' });
      expect(await wallet('user-001', 'XAUT-SBX')).toEqual({ available: '0.00000000', held: '0.00000000' });
      await assertComplianceWalletsUntouched();
      await assertReconciled();
    });

    it('el saldo liberado se puede volver a usar: el usuario puede retener otra vez los 10.000', async () => {
      const id = await pending('5000.01');
      await reject(id).expect(200);

      const user = asUser();
      const again = await user.execute(await user.quote('10000'), 'k-otra').expect(201);

      expect(again.body.status).toBe('PENDING_REVIEW');
      expect(await wallet('user-001', 'USDT-SBX')).toEqual({ available: '0.00000000', held: '10000.00000000' });
      await assertReconciled();
    });

    it('D4: la cotización de una operación rechazada NO se reutiliza (sigue USED)', async () => {
      const user = asUser();
      const quote = await user.quote('5000.01');
      const created = await user.execute(quote, 'k-1').expect(201);
      await reject(created.body.id).expect(200);

      const res = await user.execute(quote, 'k-2').expect(409);

      expect(res.body.error.code).toBe('QUOTE_ALREADY_USED');
    });

    it('el motivo es OBLIGATORIO al rechazar', async () => {
      const id = await pending();
      const before = await wallet('user-001', 'USDT-SBX');

      for (const body of [{}, { reason: '' }, { reason: '   ' }, { reason: 123 }, { reason: null }, { reason: 'x'.repeat(501) }, { reason: 'ok', extra: 1 }]) {
        const res = await reject(id, body).expect(400);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
      }

      expect(await status(id)).toBe('PENDING_REVIEW');
      expect(await count('compliance_decisions')).toBe(0);
      expect(await wallet('user-001', 'USDT-SBX')).toEqual(before);
    });

    it('un motivo de exactamente 500 caracteres se acepta', async () => {
      await reject(await pending(), { reason: 'x'.repeat(500) }).expect(200);
    });
  });

  // ---------------------------------------------------------------------------------------------------------------
  describe('B9: solo se decide lo que está pendiente', () => {
    it.each([
      ['COMPLETED', async () => (await asUser().execute(await asUser().quote('999.99'), 'k-low').expect(201)).body.id as string],
      ['FAILED', async () => {
        provider.mode = 'fail';
        const res = await asUser().execute(await asUser().quote('100'), 'k-f').expect(503);
        provider.mode = 'normal';
        return res.body.error.details.exchange_id as string;
      }],
      ['PROCESSING', async () => insertExchange(await insertQuote({ amount: '100' }), { key: 'k-p' })],
    ])('aprobar y rechazar una operación %s da 409 EXCHANGE_NOT_PENDING, sin tocar nada', async (expected, makeExchange) => {
      const id = await makeExchange();
      const ledgerBefore = await count('ledger_entries');

      for (const res of [await approve(id).expect(409), await reject(id).expect(409)]) {
        expect(res.body.error).toMatchObject({ code: 'EXCHANGE_NOT_PENDING', details: { status: expected, exchange_id: id } });
      }

      expect(await status(id)).toBe(expected);
      expect(await count('compliance_decisions')).toBe(0);
      expect(await count('ledger_entries')).toBe(ledgerBefore);
    });

    it('decidir dos veces: la segunda es 409 y hay una sola decisión (aprobar→aprobar, aprobar→rechazar, rechazar→aprobar)', async () => {
      await topUp('20000');
      const a = await pending('5000.01');
      await approve(a).expect(200);
      expect((await approve(a).expect(409)).body.error.details.status).toBe('COMPLETED');
      expect((await reject(a).expect(409)).body.error.details.status).toBe('COMPLETED');

      const b = await pending('6000');
      await reject(b).expect(200);
      expect((await approve(b).expect(409)).body.error.details.status).toBe('REJECTED');

      expect(await count('compliance_decisions')).toBe(2);
      await assertReconciled();
    });

    it('404 EXCHANGE_NOT_FOUND si no existe; 400 si el id no es un uuid', async () => {
      expect((await approve(UNKNOWN).expect(404)).body.error.code).toBe('EXCHANGE_NOT_FOUND');
      expect((await reject(UNKNOWN).expect(404)).body.error.code).toBe('EXCHANGE_NOT_FOUND');
      await approve('no-es-uuid').expect(400);
      await reject('no-es-uuid').expect(400);
    });

    it('al aprobar: el motivo largo, no textual o propiedades desconocidas son 400', async () => {
      const id = await pending();
      await approve(id, { reason: 'x'.repeat(501) }).expect(400);
      await approve(id, { reason: 5 }).expect(400);
      await approve(id, { monto: '1' }).expect(400);
      expect(await status(id)).toBe('PENDING_REVIEW');
    });
  });

  // ---------------------------------------------------------------------------------------------------------------
  describe('concurrencia entre revisores', () => {
    it('aprobar y rechazar a la vez: una gana (200), la otra recibe 409, y el dinero cuadra', async () => {
      const id = await pending();

      const [a, r] = await Promise.all([approve(id), reject(id)]);

      expect([a.status, r.status].sort()).toEqual([200, 409]);
      expect(await count('compliance_decisions')).toBe(1);
      const finalStatus = await status(id);
      expect(finalStatus).toBe(a.status === 200 ? 'COMPLETED' : 'REJECTED');
      await assertReconciled();
      await assertComplianceWalletsUntouched();
    });

    it('5 aprobaciones simultáneas: se aprueba UNA vez (XAUT acreditado una sola vez)', async () => {
      const id = await pending('5000.01');

      const results = await Promise.all(Array.from({ length: 5 }, () => approve(id)));

      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      expect(results.filter((r) => r.status === 409)).toHaveLength(4);
      expect(await count('compliance_decisions')).toBe(1);
      expect(await wallet('user-001', 'XAUT-SBX')).toEqual({ available: '1.98000396', held: '0.00000000' });
      await assertReconciled();
    });

    it('3 operaciones del MISMO usuario decididas a la vez (aprobar, rechazar, aprobar): todas terminan y cuadra, sin interbloqueos', async () => {
      await topUp('10000'); // tres retenciones HIGH de 6.000 necesitan 18.000; tiene 10.000
      const [h1, h2, h3] = [await pending('6000'), await pending('6000'), await pending('6000')];

      const results = await Promise.all([approve(h1), reject(h2), approve(h3)]);

      expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
      expect(await wallet('user-001', 'USDT-SBX')).toEqual({ available: '8000.00000000', held: '0.00000000' }); // 20.000 − 2 aprobadas × 6.000
      expect((await wallet('user-001', 'XAUT-SBX')).available).toBe('4.75200000'); // 2 × 2,376
      await assertReconciled();
    });
  });

  // ---------------------------------------------------------------------------------------------------------------
  describe('R5: atomicidad de la decisión', () => {
    class FlakyLedger extends LedgerRepository {
      // Falla en cualquier acreditación al disponible: el débito de lo retenido ya se aplicó cuando eso ocurre.
      override async applyMovement(...args: Parameters<LedgerRepository['applyMovement']>): ReturnType<LedgerRepository['applyMovement']> {
        const [, movement] = args;
        if (movement.entryType === 'CREDIT' && movement.balanceType === 'AVAILABLE') throw new Error('falla simulada a mitad de la decisión');
        return super.applyMovement(...args);
      }
    }

    it.each(['aprobar', 'rechazar'] as const)('si falla a mitad al %s, se revierte TODO: sigue retenida, sin decisión y sin movimientos nuevos', async (action) => {
      const flaky = await createApp({
        overrides: (b) => b.overrideProvider(COMPLIANCE_PROVIDER).useValue(provider).overrideProvider(LedgerRepository).useValue(new FlakyLedger()),
      });
      try {
        const id = await pending('5000.01', flaky);
        const ledgerBefore = await count('ledger_entries');

        const path = `/compliance/exchanges/${id}/${action === 'aprobar' ? 'approve' : 'reject'}`;
        await review('patch', path, 'compliance-001', { reason: 'x' }, flaky).expect(500);

        expect(await status(id)).toBe('PENDING_REVIEW');
        expect(await wallet('user-001', 'USDT-SBX')).toEqual({ available: '4999.99000000', held: '5000.01000000' }); // el débito se deshizo
        expect(await count('ledger_entries')).toBe(ledgerBefore);
        expect(await count('compliance_decisions')).toBe(0);
        expect(await count('exchange_events')).toBe(2); // solo los de la creación; ninguno de la decisión
        await assertReconciled();
      } finally {
        await flaky.close();
      }
    });
  });
});
