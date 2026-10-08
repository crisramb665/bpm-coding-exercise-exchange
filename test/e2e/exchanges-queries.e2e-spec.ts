import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { COMPLIANCE_PROVIDER } from '../../src/compliance-service/compliance.types';
import { ControllableProvider } from '../controllable-provider';
import { closeDb, createApp, insertExchange, insertQuote, resetDb, testPool } from '../helpers';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UNKNOWN = '00000000-0000-4000-8000-000000000001';
const provider = new ControllableProvider();

// Consultas de operaciones (T13): GET /exchanges y GET /exchanges/:id, y las reglas de quién ve qué (D6, D13).
describe('consultas de operaciones', () => {
  let app: INestApplication;

  const get = (path: string, userId: string | null = 'user-001') => {
    const req = request(app.getHttpServer()).get(path);
    return userId ? req.set('X-User-Id', userId) : req;
  };
  const createQuote = async (amount: string): Promise<string> =>
    (await request(app.getHttpServer()).post('/quotes').set('X-User-Id', 'user-001').send({ source_asset: 'USDT-SBX', target_asset: 'XAUT-SBX', source_amount: amount }).expect(201)).body.id;
  // Crea una cotización por HTTP, la ejecuta y comprueba el status esperado. Devuelve la respuesta.
  const execute = async (amount: string, key: string, expectedStatus: number) => {
    const quote = await createQuote(amount);
    return request(app.getHttpServer())
      .post('/exchanges')
      .set('X-User-Id', 'user-001')
      .set('Idempotency-Key', key)
      .send({ quote_id: quote })
      .expect(expectedStatus);
  };

  // Los ids de las operaciones de cada escenario, para comparar contra lo que devuelve la API.
  let low: string; // user-001, COMPLETED
  let high: string; // user-001, PENDING_REVIEW
  let failed: string; // user-001, FAILED
  let others: string; // user-002, PROCESSING

  beforeAll(async () => {
    app = await createApp({ overrides: (b) => b.overrideProvider(COMPLIANCE_PROVIDER).useValue(provider) });
  });

  beforeEach(async () => {
    provider.reset();
    await resetDb();
    await testPool.query("INSERT INTO users (id, role, name) VALUES ('user-002', 'USER', 'Otro usuario'), ('user-003', 'USER', 'Sin operaciones')");

    // Se crean en este orden, así que `failed` es la más reciente y `low` la más antigua.
    low = (await execute('999.99', 'k-low', 201)).body.id;
    high = (await execute('5000.01', 'k-high', 201)).body.id;
    provider.mode = 'fail';
    failed = (await execute('100', 'k-failed', 503)).body.error.details.exchange_id;
    provider.mode = 'normal';
    others = await insertExchange(await insertQuote({ amount: '777', userId: 'user-002' }), { userId: 'user-002' });
  });

  afterAll(async () => {
    await app.close();
    await closeDb();
  });

  const ids = (body: { id: string }[]): string[] => body.map((e) => e.id);

  // ---------------------------------------------------------------------------------------------------------------
  describe('GET /exchanges', () => {
    it('401 sin usuario', async () => {
      await get('/exchanges', null).expect(401);
    });

    it('un USER ve solo las suyas, de la más reciente a la más antigua, y no ve las de otro', async () => {
      const res = await get('/exchanges').expect(200);

      expect(ids(res.body)).toEqual([failed, high, low]);
      expect(ids(res.body)).not.toContain(others);
    });

    it('cada fila tiene exactamente los campos de la spec; los montos salen de la cotización (D10)', async () => {
      const res = await get('/exchanges').expect(200);
      const byId = Object.fromEntries(res.body.map((e: { id: string }) => [e.id, e]));

      expect(Object.keys(res.body[0]).sort()).toEqual(
        ['created_at', 'id', 'requires_follow_up', 'risk_level', 'source_amount', 'status', 'target_amount', 'user_id'],
      );
      expect(byId[low]).toEqual({
        id: low,
        user_id: 'user-001',
        status: 'COMPLETED',
        risk_level: 'LOW',
        requires_follow_up: false,
        source_amount: '999.99000000',
        target_amount: '0.39599604',
        created_at: expect.any(String),
      });
      expect(byId[high]).toMatchObject({ status: 'PENDING_REVIEW', risk_level: 'HIGH', source_amount: '5000.01000000', target_amount: '1.98000396' });
      expect(byId[failed]).toMatchObject({ status: 'FAILED', risk_level: null, source_amount: '100.00000000' });
    });

    it('un USER sin operaciones recibe una lista vacía, no un error', async () => {
      const res = await get('/exchanges', 'user-003').expect(200);
      expect(res.body).toEqual([]);
    });

    describe('?userId (D13)', () => {
      it('un USER puede enviar el suyo propio', async () => {
        const res = await get('/exchanges?userId=user-001').expect(200);
        expect(ids(res.body)).toEqual([failed, high, low]);
      });

      it('un USER que envía el de OTRO recibe 403, no una lista vacía ni su propia lista', async () => {
        const res = await get('/exchanges?userId=user-002').expect(403);
        expect(res.body.error.code).toBe('FORBIDDEN');
        expect(res.body.error).not.toHaveProperty('details'); // sin pistas sobre las operaciones del otro
      });

      it.each([['vacío', 'userId='], ['solo espacios', 'userId=%20%20'], ['repetido', 'userId=user-001&userId=user-002'], ['demasiado largo', `userId=${'u'.repeat(101)}`]])(
        '400 si es %s',
        async (_d, query) => {
          const res = await get(`/exchanges?${query}`).expect(400);
          expect(res.body.error.code).toBe('VALIDATION_ERROR');
          expect(res.body.error.details.fields[0].field).toBe('userId');
        },
      );
    });

    describe('COMPLIANCE', () => {
      it('sin filtro ve las de todos los usuarios', async () => {
        const res = await get('/exchanges', 'compliance-001').expect(200);
        expect(new Set(ids(res.body))).toEqual(new Set([low, high, failed, others]));
        expect(res.body).toHaveLength(4);
      });

      it('con ?userId ve solo las de ese usuario', async () => {
        expect(ids((await get('/exchanges?userId=user-002', 'compliance-001').expect(200)).body)).toEqual([others]);
        expect(ids((await get('/exchanges?userId=user-001', 'compliance-001').expect(200)).body)).toEqual([failed, high, low]);
      });

      it('con el ?userId de alguien sin operaciones (o que no existe) recibe una lista vacía', async () => {
        expect((await get('/exchanges?userId=user-003', 'compliance-001').expect(200)).body).toEqual([]);
        expect((await get('/exchanges?userId=fantasma', 'compliance-001').expect(200)).body).toEqual([]);
      });
    });

    describe('limit (supuesto S10)', () => {
      it('recorta a las N más recientes', async () => {
        expect(ids((await get('/exchanges?limit=2').expect(200)).body)).toEqual([failed, high]);
      });

      it.each(['0', '201', '-1', '1.5', 'abc', '', '1e2'])('400 si limit es "%s"', async (limit) => {
        const res = await get(`/exchanges?limit=${limit}`).expect(400);
        expect(res.body.error.details.fields[0].field).toBe('limit');
      });

      it('por defecto devuelve 50; con limit=200 devuelve todas', async () => {
        for (let i = 0; i < 52; i++) await insertExchange(await insertQuote({ amount: '1', userId: 'user-002' }), { userId: 'user-002', key: `bulk-${i}` });

        expect((await get('/exchanges', 'compliance-001').expect(200)).body).toHaveLength(50);
        expect((await get('/exchanges?limit=200', 'compliance-001').expect(200)).body).toHaveLength(4 + 52);
      });
    });
  });

  // ---------------------------------------------------------------------------------------------------------------
  describe('GET /exchanges/:id', () => {
    it('401 sin usuario', async () => {
      await get(`/exchanges/${low}`, null).expect(401);
    });

    it('400 si el id no es un uuid', async () => {
      const res = await get('/exchanges/no-es-uuid').expect(400);
      expect(res.body.error.details.fields[0].field).toBe('id');
    });

    it('el dueño recibe EXACTAMENTE el mismo detalle que recibió al crearla (cotización, movimientos, consulta, eventos)', async () => {
      const created = await execute('2500', 'k-detalle', 201);

      const res = await get(`/exchanges/${created.body.id}`).expect(200);

      expect(res.body).toEqual(created.body);
      expect(res.body).toMatchObject({
        id: expect.stringMatching(UUID),
        status: 'COMPLETED',
        risk_level: 'MEDIUM',
        requires_follow_up: true,
        quote: { source_amount: '2500.00000000', price: '2500.00000000', fee_amount: '25.00000000', target_amount: '0.99000000', status: 'USED' },
        decision: null,
      });
      expect(res.body.movements).toHaveLength(2);
      expect(res.body.compliance_checks).toHaveLength(1);
      expect(res.body.events.map((e: { to_status: string }) => e.to_status)).toEqual(['PROCESSING', 'COMPLETED']);
    });

    it('una operación retenida muestra la retención, y la decisión cuando Cumplimiento la toma', async () => {
      const before = (await get(`/exchanges/${high}`).expect(200)).body;
      expect(before.status).toBe('PENDING_REVIEW');
      expect(before.decision).toBeNull();
      expect(before.movements.map((m: { entry_type: string; balance_type: string }) => `${m.entry_type} ${m.balance_type}`)).toEqual(['DEBIT AVAILABLE', 'CREDIT HELD']);

      await testPool.query("INSERT INTO compliance_decisions (exchange_id, reviewer_id, decision, reason) VALUES ($1, 'compliance-001', 'APPROVED', 'Verificado')", [high]);

      const after = (await get(`/exchanges/${high}`).expect(200)).body;
      expect(after.decision).toEqual({ reviewer_id: 'compliance-001', decision: 'APPROVED', reason: 'Verificado', decided_at: expect.any(String) });
    });

    it('una operación FAILED muestra el motivo, la consulta fallida y ningún movimiento', async () => {
      const res = await get(`/exchanges/${failed}`).expect(200);

      expect(res.body).toMatchObject({ status: 'FAILED', risk_level: null, failure_reason: 'COMPLIANCE_UNAVAILABLE', movements: [], decision: null });
      expect(res.body.compliance_checks).toEqual([expect.objectContaining({ outcome: 'ERROR', risk_level: null, error_message: 'servicio de cumplimiento caído' })]);
      expect(res.body.events.map((e: { to_status: string }) => e.to_status)).toEqual(['PROCESSING', 'FAILED']);
    });

    it('404 EXCHANGE_NOT_FOUND si no existe', async () => {
      const res = await get(`/exchanges/${UNKNOWN}`).expect(404);
      expect(res.body.error).toMatchObject({ code: 'EXCHANGE_NOT_FOUND', details: { exchange_id: UNKNOWN } });
    });

    it('un USER que pide la de OTRO recibe el mismo 404 que si no existiera: no se revela que existe', async () => {
      const ajena = await get(`/exchanges/${others}`).expect(404);
      const inexistente = await get(`/exchanges/${UNKNOWN}`).expect(404);

      expect(ajena.body.error.code).toBe('EXCHANGE_NOT_FOUND');
      expect({ ...ajena.body.error, details: undefined }).toEqual({ ...inexistente.body.error, details: undefined });
      expect(JSON.stringify(ajena.body)).not.toContain('user-002'); // sin filtrar datos del otro usuario
    });

    it('un USER que pide una de otro no la ve aunque conozca su id (user-002 no ve las de user-001)', async () => {
      await get(`/exchanges/${low}`, 'user-002').expect(404);
    });

    it('COMPLIANCE puede ver la de cualquier usuario, también las que están en curso', async () => {
      const res = await get(`/exchanges/${low}`, 'compliance-001').expect(200);
      expect(res.body).toMatchObject({ id: low, user_id: 'user-001', status: 'COMPLETED' });

      const inProgress = await get(`/exchanges/${others}`, 'compliance-001').expect(200);
      expect(inProgress.body).toMatchObject({ id: others, user_id: 'user-002', status: 'PROCESSING', movements: [], compliance_checks: [] });
    });

    it('acepta el uuid en mayúsculas', async () => {
      await get(`/exchanges/${low.toUpperCase()}`).expect(200);
    });
  });
});
