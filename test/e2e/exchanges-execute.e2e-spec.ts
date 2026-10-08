import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { MockComplianceProvider } from '../../src/compliance-service/mock-compliance.provider';
import { COMPLIANCE_PROVIDER, ComplianceProvider, ComplianceRequest, ComplianceResponse } from '../../src/compliance-service/compliance.types';
import { LedgerRepository } from '../../src/wallets/ledger.repository';
import { ExchangeDetailRepository } from '../../src/exchanges/exchange-detail.repository';
import { assertReconciled, closeDb, createApp, resetDb, testPool } from '../helpers';

// Proveedor de pruebas que envuelve al mock real y permite, por prueba, hacerlo fallar, retrasarlo, devolver basura o
// ejecutar código EN EL MEDIO de la consulta (donde el sistema real estaría esperando a un servicio externo).
class ControllableProvider implements ComplianceProvider {
  readonly name = 'MOCK';
  mode: 'normal' | 'fail' | 'invalid' = 'normal';
  hook?: (request: ComplianceRequest) => Promise<void>;
  private readonly real = new MockComplianceProvider();

  async assess(req: ComplianceRequest): Promise<ComplianceResponse> {
    if (this.hook) await this.hook(req);
    if (this.mode === 'fail') throw new Error('servicio de cumplimiento caído');
    if (this.mode === 'invalid') return { riskLevel: 'CRITICAL' } as unknown as ComplianceResponse;
    return this.real.assess(req);
  }
  reset(): void {
    this.mode = 'normal';
    this.hook = undefined;
  }
}

const provider = new ControllableProvider();
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('POST /exchanges: flujo completo (T12)', () => {
  let app: INestApplication;

  const http = (a: INestApplication = app) => request(a.getHttpServer());
  const createQuote = async (amount: string, a: INestApplication = app): Promise<string> =>
    (await http(a).post('/quotes').set('X-User-Id', 'user-001').send({ source_asset: 'USDT-SBX', target_asset: 'XAUT-SBX', source_amount: amount }).expect(201)).body.id;
  const exchange = (quoteId: string, key = 'key-1', a: INestApplication = app) =>
    http(a).post('/exchanges').set('X-User-Id', 'user-001').set('Idempotency-Key', key).send({ quote_id: quoteId });

  const wallet = async (asset: string): Promise<{ available: string; held: string; total: string }> =>
    (await testPool.query("SELECT available, held, total FROM wallets WHERE user_id = 'user-001' AND asset_code = $1", [asset])).rows[0];
  const count = async (table: string): Promise<number> => Number((await testPool.query<{ n: string }>(`SELECT count(*) AS n FROM ${table}`)).rows[0].n);
  const quoteStatus = async (id: string): Promise<string> => (await testPool.query<{ status: string }>('SELECT status FROM quotes WHERE id = $1', [id])).rows[0].status;
  const keyRows = async () => (await testPool.query('SELECT key, response_status FROM idempotency_keys ORDER BY key')).rows;

  // Un punto de encuentro: la consulta a cumplimiento de cada petición espera hasta que lleguen `n`. Así se garantiza que
  // las n peticiones ya pasaron su primera transacción ANTES de que cualquiera llegue a la segunda: es el escenario
  // exacto del doble gasto (todas vieron el mismo saldo).
  const barrier = (n: number): void => {
    let arrived = 0;
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    provider.hook = async () => {
      arrived += 1;
      if (arrived >= n) open();
      await gate;
    };
  };

  beforeAll(async () => {
    app = await createApp({ overrides: (b) => b.overrideProvider(COMPLIANCE_PROVIDER).useValue(provider) });
  });

  beforeEach(async () => {
    provider.reset();
    await resetDb();
  });

  afterAll(async () => {
    await app.close();
    await closeDb();
  });

  // ---------------------------------------------------------------------------------------------------------------
  describe('a: LOW se ejecuta automáticamente', () => {
    it('201 COMPLETED: debita USDT, acredita XAUT, consume la cotización y deja toda la trazabilidad', async () => {
      const quote = await createQuote('999.99');

      const res = await exchange(quote).expect(201);

      expect(res.headers['idempotent-replayed']).toBeUndefined();
      expect(res.body).toMatchObject({
        id: expect.any(String),
        user_id: 'user-001',
        status: 'COMPLETED',
        risk_level: 'LOW',
        requires_follow_up: false,
        failure_reason: null,
        decision: null,
        quote: {
          id: quote,
          source_asset: 'USDT-SBX',
          target_asset: 'XAUT-SBX',
          source_amount: '999.99000000',
          price: '2500.00000000',
          fee_rate: '0.010000',
          fee_amount: '9.99990000',
          net_amount: '989.99010000',
          target_amount: '0.39599604',
          status: 'USED',
        },
      });
      // Los dos movimientos, con el saldo anterior y posterior de cada uno.
      expect(res.body.movements.map((m: Record<string, string>) => [m.asset, m.entry_type, m.balance_type, m.amount, m.balance_before, m.balance_after])).toEqual([
        ['USDT-SBX', 'DEBIT', 'AVAILABLE', '999.99000000', '10000.00000000', '9000.01000000'],
        ['XAUT-SBX', 'CREDIT', 'AVAILABLE', '0.39599604', '0.00000000', '0.39599604'],
      ]);
      // La consulta a cumplimiento queda registrada con lo enviado y lo recibido.
      expect(res.body.compliance_checks).toEqual([
        expect.objectContaining({
          provider: 'MOCK',
          outcome: 'OK',
          risk_level: 'LOW',
          error_message: null,
          request_payload: { exchangeId: res.body.id, userId: 'user-001', sourceAsset: 'USDT-SBX', sourceAmount: '999.99000000' },
          response_payload: { riskLevel: 'LOW' },
        }),
      ]);
      // Historia: la crea el usuario y la completa el sistema.
      expect(res.body.events.map((e: Record<string, unknown>) => [e.from_status, e.to_status, e.actor_id])).toEqual([
        [null, 'PROCESSING', 'user-001'],
        ['PROCESSING', 'COMPLETED', null],
      ]);

      expect(await wallet('USDT-SBX')).toEqual({ available: '9000.01000000', held: '0.00000000', total: '9000.01000000' });
      expect(await wallet('XAUT-SBX')).toEqual({ available: '0.39599604', held: '0.00000000', total: '0.39599604' });
      expect(await quoteStatus(quote)).toBe('USED');
      await assertReconciled();
    });

    it('999,99999999 (un paso bajo 1.000) sigue siendo LOW, sin seguimiento', async () => {
      const res = await exchange(await createQuote('999.99999999')).expect(201);
      expect(res.body).toMatchObject({ status: 'COMPLETED', risk_level: 'LOW', requires_follow_up: false });
    });
  });

  // ---------------------------------------------------------------------------------------------------------------
  describe('b: MEDIUM se ejecuta y queda marcada para seguimiento', () => {
    it.each([
      ['1000', '990.00000000', '0.39600000'], // el límite inferior es MEDIUM
      ['2500', '2475.00000000', '0.99000000'], // ejemplo del enunciado
      ['5000', '4950.00000000', '1.98000000'], // el límite superior (inclusive) sigue siendo MEDIUM
    ])('%s USDT → COMPLETED, requires_follow_up = true, %s XAUT', async (amount, net, xaut) => {
      const quote = await createQuote(amount);

      const res = await exchange(quote).expect(201);

      expect(res.body).toMatchObject({
        status: 'COMPLETED',
        risk_level: 'MEDIUM',
        requires_follow_up: true,
        quote: { net_amount: net, target_amount: xaut, status: 'USED' },
      });
      expect((await wallet('XAUT-SBX')).available).toBe(xaut);
      await assertReconciled();
    });
  });

  // ---------------------------------------------------------------------------------------------------------------
  describe('g: HIGH queda retenida', () => {
    it('5.000,01 → 201 PENDING_REVIEW: el monto pasa de disponible a retenido y no se acredita XAUT', async () => {
      const quote = await createQuote('5000.01');

      const res = await exchange(quote).expect(201);

      expect(res.body).toMatchObject({
        status: 'PENDING_REVIEW',
        risk_level: 'HIGH',
        requires_follow_up: false,
        failure_reason: null,
        // El precio y la comisión originales quedan guardados en la cotización (R13).
        quote: { price: '2500.00000000', fee_amount: '50.00010000', target_amount: '1.98000396', status: 'USED' },
      });
      expect(res.body.movements.map((m: Record<string, string>) => [m.asset, m.entry_type, m.balance_type, m.amount, m.balance_before, m.balance_after])).toEqual([
        ['USDT-SBX', 'DEBIT', 'AVAILABLE', '5000.01000000', '10000.00000000', '4999.99000000'],
        ['USDT-SBX', 'CREDIT', 'HELD', '5000.01000000', '0.00000000', '5000.01000000'],
      ]);
      expect(await wallet('USDT-SBX')).toEqual({ available: '4999.99000000', held: '5000.01000000', total: '10000.00000000' });
      expect(await wallet('XAUT-SBX')).toEqual({ available: '0.00000000', held: '0.00000000', total: '0.00000000' });
      expect(res.body.events.map((e: Record<string, unknown>) => e.to_status)).toEqual(['PROCESSING', 'PENDING_REVIEW']);
      expect(await quoteStatus(quote)).toBe('USED');
      await assertReconciled();
    });

    it('5.000,00000001 (un paso sobre 5.000) ya es HIGH', async () => {
      const res = await exchange(await createQuote('5000.00000001')).expect(201);
      expect(res.body).toMatchObject({ status: 'PENDING_REVIEW', risk_level: 'HIGH' });
    });

    it('B4: 10.000 retiene TODO el saldo y deja el disponible en 0', async () => {
      const res = await exchange(await createQuote('10000')).expect(201);
      expect(res.body.status).toBe('PENDING_REVIEW');
      expect(await wallet('USDT-SBX')).toEqual({ available: '0.00000000', held: '10000.00000000', total: '10000.00000000' });
      await assertReconciled();
    });
  });

  // ---------------------------------------------------------------------------------------------------------------
  describe('e: idempotencia de la operación completa', () => {
    it.each(['999.99', '5000.01'])('repetir la misma petición (%s) devuelve la respuesta original, sin duplicar nada', async (amount) => {
      const quote = await createQuote(amount);
      const first = await exchange(quote).expect(201);
      const ledgerAfterFirst = await count('ledger_entries');
      const balancesAfterFirst = await wallet('USDT-SBX');

      const second = await exchange(quote).expect(201);

      expect(second.headers['idempotent-replayed']).toBe('true');
      expect(second.body).toEqual(first.body);
      expect(await count('exchanges')).toBe(1);
      expect(await count('compliance_checks')).toBe(1);
      expect(await count('ledger_entries')).toBe(ledgerAfterFirst);
      expect(await wallet('USDT-SBX')).toEqual(balancesAfterFirst);
      await assertReconciled();
    });

    it('f: la misma clave con OTRA cotización, tras una operación completa, es 409 y no hace nada', async () => {
      const a = await createQuote('100');
      const b = await createQuote('200');
      await exchange(a, 'k').expect(201);

      const res = await exchange(b, 'k').expect(409);

      expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_MISMATCH');
      expect(await count('exchanges')).toBe(1);
      expect(await quoteStatus(b)).toBe('ACTIVE');
    });

    it('B7: una cotización ya ejecutada no se puede usar de nuevo con otra clave', async () => {
      const quote = await createQuote('100');
      await exchange(quote, 'k1').expect(201);
      const res = await exchange(quote, 'k2').expect(409);
      expect(res.body.error.code).toBe('QUOTE_ALREADY_USED');
      expect(await count('exchanges')).toBe(1);
      expect(await count('ledger_entries')).toBe(3); // depósito inicial + los 2 de la única operación
    });
  });

  // ---------------------------------------------------------------------------------------------------------------
  describe('B6: el servicio de cumplimiento falla (R12, D7)', () => {
    it('503: la operación queda FAILED, sin tocar saldos, la cotización sigue disponible y la clave se libera', async () => {
      const quote = await createQuote('2500');
      provider.mode = 'fail';

      const res = await exchange(quote, 'mi-clave').expect(503);

      expect(res.body.error).toMatchObject({ code: 'COMPLIANCE_UNAVAILABLE', details: { exchange_id: expect.any(String) } });
      const exchangeId = res.body.error.details.exchange_id;

      const row = (await testPool.query('SELECT status, risk_level, failure_reason, requires_follow_up, idempotency_key FROM exchanges WHERE id = $1', [exchangeId])).rows[0];
      expect(row).toEqual({ status: 'FAILED', risk_level: null, failure_reason: 'COMPLIANCE_UNAVAILABLE', requires_follow_up: false, idempotency_key: 'mi-clave' });

      // La consulta fallida también queda registrada, con el motivo.
      const checks = (await testPool.query('SELECT provider, outcome, risk_level, response_payload, error_message, duration_ms FROM compliance_checks WHERE exchange_id = $1', [exchangeId])).rows;
      expect(checks).toEqual([
        { provider: 'MOCK', outcome: 'ERROR', risk_level: null, response_payload: null, error_message: 'servicio de cumplimiento caído', duration_ms: expect.any(Number) },
      ]);
      const events = (await testPool.query('SELECT from_status, to_status, actor_id, reason FROM exchange_events WHERE exchange_id = $1 ORDER BY id', [exchangeId])).rows;
      expect(events).toEqual([
        { from_status: null, to_status: 'PROCESSING', actor_id: 'user-001', reason: null },
        { from_status: 'PROCESSING', to_status: 'FAILED', actor_id: null, reason: 'COMPLIANCE_UNAVAILABLE' },
      ]);

      // Sin efectos sobre el dinero ni sobre la cotización.
      expect(await wallet('USDT-SBX')).toEqual({ available: '10000.00000000', held: '0.00000000', total: '10000.00000000' });
      expect(await wallet('XAUT-SBX')).toEqual({ available: '0.00000000', held: '0.00000000', total: '0.00000000' });
      expect(await count('ledger_entries')).toBe(1);
      expect(await quoteStatus(quote)).toBe('ACTIVE');
      expect(await keyRows()).toEqual([]); // la clave se liberó
      await assertReconciled();
    });

    it('reintentar con la MISMA clave cuando el servicio vuelve: se ejecuta (no se reproduce el 503)', async () => {
      const quote = await createQuote('2500');
      provider.mode = 'fail';
      await exchange(quote, 'k').expect(503);

      provider.mode = 'normal';
      const retry = await exchange(quote, 'k').expect(201);

      expect(retry.headers['idempotent-replayed']).toBeUndefined();
      expect(retry.body).toMatchObject({ status: 'COMPLETED', risk_level: 'MEDIUM' });
      expect((await testPool.query("SELECT status FROM exchanges WHERE quote_id = $1 ORDER BY created_at", [quote])).rows.map((r) => r.status)).toEqual(['FAILED', 'COMPLETED']);
      expect((await testPool.query('SELECT outcome FROM compliance_checks ORDER BY id')).rows.map((r) => r.outcome)).toEqual(['ERROR', 'OK']);
      await assertReconciled();
    });

    it('mientras el servicio siga caído, cada reintento vuelve a dar 503 (nunca se reproduce)', async () => {
      const quote = await createQuote('100');
      provider.mode = 'fail';
      const first = await exchange(quote, 'k').expect(503);
      const second = await exchange(quote, 'k').expect(503);
      expect(second.headers['idempotent-replayed']).toBeUndefined();
      expect(second.body.error.details.exchange_id).not.toBe(first.body.error.details.exchange_id); // una operación nueva
    });

    it('una respuesta inválida del servicio (nivel inexistente) se trata como falla, no como riesgo', async () => {
      provider.mode = 'invalid';
      const res = await exchange(await createQuote('100')).expect(503);
      expect(res.body.error.code).toBe('COMPLIANCE_UNAVAILABLE');
      expect(await wallet('USDT-SBX')).toMatchObject({ available: '10000.00000000' });
    });

    it('un servicio que no responde a tiempo (timeout) también es 503', async () => {
      process.env.COMPLIANCE_TIMEOUT_MS = '50';
      const slow = await createApp({ overrides: (b) => b.overrideProvider(COMPLIANCE_PROVIDER).useValue(provider) });
      try {
        provider.hook = async () => sleep(400);
        const quote = await createQuote('100', slow);
        const res = await exchange(quote, 'k', slow).expect(503);
        expect(res.body.error.code).toBe('COMPLIANCE_UNAVAILABLE');
        const check = (await testPool.query('SELECT outcome, error_message FROM compliance_checks')).rows[0];
        expect(check).toEqual({ outcome: 'ERROR', error_message: expect.stringMatching(/50 ms/) });
        expect(await wallet('USDT-SBX')).toMatchObject({ available: '10000.00000000' });
      } finally {
        delete process.env.COMPLIANCE_TIMEOUT_MS;
        await slow.close();
      }
    });
  });

  // ---------------------------------------------------------------------------------------------------------------
  describe('c: saldo insuficiente', () => {
    it('antes de consultar a cumplimiento: 422 sin crear nada (primera transacción)', async () => {
      const quote = await createQuote('10000.00000001');
      const res = await exchange(quote).expect(422);
      expect(res.body.error.code).toBe('INSUFFICIENT_FUNDS');
      expect(await count('exchanges')).toBe(0);
      expect(await count('compliance_checks')).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------------------------------------------
  describe('concurrencia (R15): peticiones HTTP simultáneas', () => {
    it('DOBLE GASTO: dos cotizaciones HIGH de 6.000 con 10.000 de saldo, ambas vieron el mismo saldo; solo una se ejecuta', async () => {
      const [qa, qb] = [await createQuote('6000'), await createQuote('6000')];
      barrier(2); // ambas pasan la primera transacción (10.000 ≥ 6.000) antes de que cualquiera llegue a la segunda

      const [ra, rb] = await Promise.all([exchange(qa, 'ka'), exchange(qb, 'kb')]);

      const statuses = [ra.status, rb.status].sort();
      expect(statuses).toEqual([201, 422]);
      const loser = ra.status === 422 ? ra : rb;
      const winner = ra.status === 201 ? ra : rb;
      const [loserQuote, winnerQuote] = ra.status === 422 ? [qa, qb] : [qb, qa];

      // La perdedora lo supo en la SEGUNDA transacción, bajo bloqueo: existe como FAILED con su motivo y su riesgo.
      expect(loser.body.error).toMatchObject({ code: 'INSUFFICIENT_FUNDS', details: { available: '4000.00000000', required: '6000.00000000', exchange_id: expect.any(String) } });
      const failed = (await testPool.query('SELECT status, risk_level, failure_reason FROM exchanges WHERE id = $1', [loser.body.error.details.exchange_id])).rows[0];
      expect(failed).toEqual({ status: 'FAILED', risk_level: 'HIGH', failure_reason: 'INSUFFICIENT_FUNDS' });

      expect(winner.body.status).toBe('PENDING_REVIEW');
      expect(await wallet('USDT-SBX')).toEqual({ available: '4000.00000000', held: '6000.00000000', total: '10000.00000000' });
      expect(await quoteStatus(winnerQuote)).toBe('USED');
      expect(await quoteStatus(loserQuote)).toBe('ACTIVE'); // la perdedora puede volver a intentarlo
      expect((await keyRows()).map((r) => r.key)).toEqual([ra.status === 201 ? 'ka' : 'kb']); // solo queda la clave de la ganadora
      expect(await count('compliance_checks')).toBe(2);
      await assertReconciled();
    });

    it('4 operaciones MEDIUM de 3.000 con 10.000 de saldo: se ejecutan 3 (9.000) y una es rechazada; el dinero cuadra', async () => {
      const quotes = await Promise.all([1, 2, 3, 4].map(() => createQuote('3000')));
      barrier(4);

      const responses = await Promise.all(quotes.map((q, i) => exchange(q, `k${i}`)));

      expect(responses.map((r) => r.status).sort()).toEqual([201, 201, 201, 422]);
      expect(await wallet('USDT-SBX')).toEqual({ available: '1000.00000000', held: '0.00000000', total: '1000.00000000' });
      expect((await wallet('XAUT-SBX')).available).toBe('3.56400000'); // 3 × 1,188
      expect(await count('exchanges')).toBe(4); // 3 COMPLETED + 1 FAILED
      await assertReconciled();
    });

    it('la MISMA clave 5 veces a la vez: se ejecuta UNA sola vez; las demás ven "en curso" o la respuesta reproducida', async () => {
      const quote = await createQuote('999.99');
      provider.hook = () => sleep(80); // ensancha la ventana en que la original sigue en curso

      const responses = await Promise.all(Array.from({ length: 5 }, () => exchange(quote, 'misma')));

      const originals = responses.filter((r) => r.status === 201 && r.headers['idempotent-replayed'] === undefined);
      const replays = responses.filter((r) => r.status === 201 && r.headers['idempotent-replayed'] === 'true');
      const inProgress = responses.filter((r) => r.status === 409);
      expect(originals).toHaveLength(1);
      expect(originals.length + replays.length + inProgress.length).toBe(5);
      inProgress.forEach((r) => expect(r.body.error.code).toBe('IDEMPOTENCY_IN_PROGRESS'));
      replays.forEach((r) => expect(r.body).toEqual(originals[0].body));

      expect(await count('exchanges')).toBe(1);
      expect(await count('ledger_entries')).toBe(3);
      await assertReconciled();
    });

    it('5 claves DISTINTAS sobre la misma cotización: se ejecuta UNA vez', async () => {
      const quote = await createQuote('999.99');
      provider.hook = () => sleep(80);

      const responses = await Promise.all(['a', 'b', 'c', 'd', 'e'].map((k) => exchange(quote, `clave-${k}`)));

      expect(responses.filter((r) => r.status === 201)).toHaveLength(1);
      responses.filter((r) => r.status !== 201).forEach((r) => {
        expect(r.status).toBe(409);
        expect(['QUOTE_IN_USE', 'QUOTE_ALREADY_USED']).toContain(r.body.error.code);
      });
      expect(await count('exchanges')).toBe(1);
      expect((await wallet('USDT-SBX')).available).toBe('9000.01000000'); // se debitó una sola vez
      await assertReconciled();
    });
  });

  // ---------------------------------------------------------------------------------------------------------------
  describe('el servicio externo se consulta FUERA de la transacción', () => {
    it('mientras se espera a cumplimiento no hay filas bloqueadas ni transacciones abiertas', async () => {
      const quote = await createQuote('100');
      const observed: Record<string, unknown> = {};

      provider.hook = async (req) => {
        // NOWAIT falla de inmediato si la fila está bloqueada por otra transacción. Si la app consultara a cumplimiento
        // con una transacción abierta (reteniendo estas filas), esto lanzaría el error 55P03 y la petición daría 503.
        const quoteId = (await testPool.query<{ quote_id: string }>('SELECT quote_id FROM exchanges WHERE id = $1', [req.exchangeId])).rows[0].quote_id;
        await testPool.query('SELECT id FROM exchanges WHERE id = $1 FOR UPDATE NOWAIT', [req.exchangeId]);
        await testPool.query('SELECT id FROM quotes WHERE id = $1 FOR UPDATE NOWAIT', [quoteId]);
        await testPool.query("SELECT id FROM wallets WHERE user_id = 'user-001' FOR UPDATE NOWAIT");
        observed.idleInTransaction = Number(
          (await testPool.query<{ n: string }>(
            "SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND state LIKE 'idle in transaction%' AND pid <> pg_backend_pid()",
          )).rows[0].n,
        );
        observed.exchangeStatusDuringCall = (await testPool.query<{ status: string }>('SELECT status FROM exchanges WHERE id = $1', [req.exchangeId])).rows[0].status;
      };

      await exchange(quote).expect(201); // si algo estuviera bloqueado, aquí habría un 503

      expect(observed.idleInTransaction).toBe(0);
      expect(observed.exchangeStatusDuringCall).toBe('PROCESSING'); // la primera transacción ya se había confirmado
    });
  });

  // ---------------------------------------------------------------------------------------------------------------
  describe('D9: la operación dejó de estar en PROCESSING mientras se esperaba a cumplimiento', () => {
    it('la segunda transacción no pisa nada: 409 EXCHANGE_NOT_PROCESSING, sin movimientos', async () => {
      const quote = await createQuote('100');
      // Simula la recuperación de huérfanas (solo documentada): marca FAILED y libera la clave mientras se espera.
      provider.hook = async (req) => {
        await testPool.query("UPDATE exchanges SET status = 'FAILED', failure_reason = 'RECOVERY_TIMEOUT' WHERE id = $1", [req.exchangeId]);
        await testPool.query('DELETE FROM idempotency_keys');
      };

      const res = await exchange(quote).expect(409);

      expect(res.body.error.code).toBe('EXCHANGE_NOT_PROCESSING');
      expect(await count('ledger_entries')).toBe(1);
      expect(await count('compliance_checks')).toBe(0);
      expect(await quoteStatus(quote)).toBe('ACTIVE');
      expect((await testPool.query('SELECT status, failure_reason FROM exchanges')).rows).toEqual([{ status: 'FAILED', failure_reason: 'RECOVERY_TIMEOUT' }]);
      await assertReconciled();
    });
  });

  // ---------------------------------------------------------------------------------------------------------------
  describe('D9 con carrera: la recuperación actúa JUSTO cuando la segunda transacción intenta empezar', () => {
    it('Tx2 espera el bloqueo de la operación, ve que ya es FAILED y responde 409 limpio (no un 500 al final)', async () => {
      const quote = await createQuote('100');
      let recovered!: Promise<void>;

      provider.hook = async (req) => {
        // La "recuperación" toma la fila de la operación, la marca FAILED y la suelta 400 ms DESPUÉS. La respuesta de
        // cumplimiento llega mientras tanto, así que Tx2 arranca con la fila bloqueada y aún sin confirmar.
        const recovery = await testPool.connect();
        await recovery.query('BEGIN');
        await recovery.query("UPDATE exchanges SET status = 'FAILED', failure_reason = 'RECOVERY_TIMEOUT' WHERE id = $1", [req.exchangeId]);
        await recovery.query('DELETE FROM idempotency_keys');
        recovered = new Promise<void>((resolve) =>
          setTimeout(() => {
            void recovery.query('COMMIT').then(() => {
              recovery.release();
              resolve();
            });
          }, 400),
        );
      };

      // Con el bloqueo FOR UPDATE de la operación, Tx2 espera, relee el estado ya confirmado (FAILED) y se aparta.
      // Sin él leería el estado viejo (PROCESSING), registraría la consulta, movería dinero, y fallaría recién en el último
      // UPDATE al chocar con el trigger de la máquina de estados: un 500 tras haber hecho trabajo inútil.
      const res = await exchange(quote).expect(409);
      await recovered;

      expect(res.body.error.code).toBe('EXCHANGE_NOT_PROCESSING');
      expect(await count('ledger_entries')).toBe(1);
      expect(await count('compliance_checks')).toBe(0);
      expect(await quoteStatus(quote)).toBe('ACTIVE');
      await assertReconciled();
    });
  });

  // ---------------------------------------------------------------------------------------------------------------
  describe('detalle de la operación', () => {
    it('incluye la decisión de Cumplimiento cuando existe (la T14 la creará; aquí se inserta a mano)', async () => {
      const created = await exchange(await createQuote('5000.01')).expect(201);
      const detailRepo = app.get(ExchangeDetailRepository);

      expect((await detailRepo.findById(testPool, created.body.id))?.decision).toBeNull();

      await testPool.query(
        "INSERT INTO compliance_decisions (exchange_id, reviewer_id, decision, reason) VALUES ($1, 'compliance-001', 'APPROVED', 'Origen de fondos verificado')",
        [created.body.id],
      );
      const detail = await detailRepo.findById(testPool, created.body.id);

      expect(detail?.decision).toEqual({
        reviewer_id: 'compliance-001',
        decision: 'APPROVED',
        reason: 'Origen de fondos verificado',
        decided_at: expect.any(Date),
      });
    });

    it('devuelve undefined para una operación que no existe', async () => {
      expect(await app.get(ExchangeDetailRepository).findById(testPool, '00000000-0000-4000-8000-000000000000')).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------------------------------------------
  describe('R5: atomicidad de la segunda transacción', () => {
    class FlakyLedger extends LedgerRepository {
      // Falla justo DESPUÉS de haber aplicado el débito: el crédito de XAUT lanza.
      override async applyMovement(...args: Parameters<LedgerRepository['applyMovement']>): ReturnType<LedgerRepository['applyMovement']> {
        const [, movement] = args;
        if (movement.entryType === 'CREDIT' && movement.balanceType === 'AVAILABLE') throw new Error('falla simulada a mitad de la transacción');
        return super.applyMovement(...args);
      }
    }

    it('si falla a mitad, se revierte TODO: sin débito, sin movimientos y sin cambios de estado', async () => {
      const flaky = await createApp({
        overrides: (b) => b.overrideProvider(COMPLIANCE_PROVIDER).useValue(provider).overrideProvider(LedgerRepository).useValue(new FlakyLedger()),
      });
      try {
        const quote = await createQuote('999.99', flaky);

        await exchange(quote, 'k', flaky).expect(500);

        // El débito se aplicó dentro de la transacción y se deshizo junto con todo lo demás.
        expect(await wallet('USDT-SBX')).toEqual({ available: '10000.00000000', held: '0.00000000', total: '10000.00000000' });
        expect(await wallet('XAUT-SBX')).toEqual({ available: '0.00000000', held: '0.00000000', total: '0.00000000' });
        expect(await count('ledger_entries')).toBe(1);
        expect(await count('compliance_checks')).toBe(0); // el registro de la consulta era parte de la transacción
        expect(await quoteStatus(quote)).toBe('ACTIVE');
        // Queda reservada (Tx1 ya había confirmado) y con la clave "en curso": el caso que cubre la recuperación de D9.
        expect((await testPool.query('SELECT status FROM exchanges')).rows).toEqual([{ status: 'PROCESSING' }]);
        expect(await keyRows()).toEqual([{ key: 'k', response_status: null }]);
        await assertReconciled();
      } finally {
        await flaky.close();
      }
    });
  });
});
