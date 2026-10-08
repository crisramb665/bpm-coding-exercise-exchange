import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { BusinessError } from '../../src/common/errors/business-error';
import { ExchangesService, hashRequest, translateConstraintError } from '../../src/exchanges/exchanges.service';
import { assertReconciled, closeDb, createApp, insertExchange, insertQuote, ledgerMove, resetDb, testPool } from '../helpers';

const UNKNOWN_QUOTE = '00000000-0000-4000-8000-000000000001';

// Primera transacción de POST /exchanges (T11): idempotencia, bloqueo de la cotización, validaciones y reserva en
// PROCESSING. Los casos de éxito se prueban llamando a ExchangesService.begin() directamente, que es solo la primera
// transacción; el flujo completo (cumplimiento y saldos) se prueba en exchanges-execute.e2e-spec.ts.
describe('POST /exchanges: primera transacción', () => {
  let app: INestApplication;
  let service: ExchangesService;

  const post = (body: unknown, key: string | null = 'key-1', userId: string | null = 'user-001') => {
    const req = request(app.getHttpServer()).post('/exchanges');
    if (userId) req.set('X-User-Id', userId);
    if (key !== null) req.set('Idempotency-Key', key);
    return req.send(body as object);
  };
  const body = (quoteId: string) => ({ quote_id: quoteId });

  const count = async (table: string): Promise<number> =>
    Number((await testPool.query<{ n: string }>(`SELECT count(*) AS n FROM ${table}`)).rows[0].n);
  const keyRows = async () =>
    (await testPool.query('SELECT user_id, key, response_status, response_body, exchange_id FROM idempotency_keys ORDER BY key')).rows;
  const quoteStatus = async (id: string): Promise<string> =>
    (await testPool.query<{ status: string }>('SELECT status FROM quotes WHERE id = $1', [id])).rows[0].status;

  // Ejecuta begin() y devuelve el código del BusinessError si lo hay (para poder comparar resultados de peticiones paralelas).
  const outcome = (p: Promise<{ kind: string }>): Promise<string> =>
    p.then(
      (r) => r.kind,
      (e: unknown) => (e instanceof BusinessError ? e.code : `ERROR_INESPERADO: ${String(e)}`),
    );

  beforeAll(async () => {
    app = await createApp();
    service = app.get(ExchangesService);
  });

  beforeEach(async () => {
    await resetDb();
    await testPool.query("INSERT INTO users (id, role, name) VALUES ('user-002', 'USER', 'Otro usuario')");
  });

  afterAll(async () => {
    await app.close();
    await closeDb();
  });

  // ---------------------------------------------------------------------------------------------------------------
  describe('autenticación, rol y validación (400 no consume la clave)', () => {
    it('401 sin usuario', async () => {
      await post(body(UNKNOWN_QUOTE), 'k', null).expect(401);
    });

    it('403 si el rol es COMPLIANCE', async () => {
      const res = await post(body(UNKNOWN_QUOTE), 'k', 'compliance-001').expect(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
      expect(await keyRows()).toEqual([]);
    });

    it.each<[string, string | null]>([
      ['falta el encabezado', null],
      ['clave vacía', ''],
      ['clave solo de espacios', '   '],
      ['clave de 256 caracteres', 'k'.repeat(256)],
    ])('400 si %s', async (_d, key) => {
      const res = await post(body(UNKNOWN_QUOTE), key).expect(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.details.fields[0].field).toBe('Idempotency-Key');
      expect(await keyRows()).toEqual([]);
    });

    it('acepta una clave de exactamente 255 caracteres', async () => {
      await post(body(UNKNOWN_QUOTE), 'k'.repeat(255)).expect(404); // llega a la lógica: la cotización no existe
    });

    it.each<[string, unknown]>([
      ['sin quote_id', {}],
      ['quote_id que no es uuid', { quote_id: 'abc' }],
      ['quote_id numérico', { quote_id: 123 }],
      ['quote_id nulo', { quote_id: null }],
      ['propiedades desconocidas', { quote_id: UNKNOWN_QUOTE, amount: '1' }],
    ])('400 si el cuerpo tiene %s', async (_d, b) => {
      const res = await post(b).expect(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(await keyRows()).toEqual([]);
      expect(await count('exchanges')).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------------------------------------------
  describe('404 QUOTE_NOT_FOUND (definitivo: se guarda bajo la clave)', () => {
    it('una cotización inexistente', async () => {
      const res = await post(body(UNKNOWN_QUOTE)).expect(404);
      expect(res.body.error).toMatchObject({ code: 'QUOTE_NOT_FOUND', details: { quote_id: UNKNOWN_QUOTE } });

      expect(await keyRows()).toEqual([
        { user_id: 'user-001', key: 'key-1', response_status: 404, response_body: res.body, exchange_id: null },
      ]);
      expect(await count('exchanges')).toBe(0);
    });

    it('repetir la petición devuelve la MISMA respuesta, marcada como reproducida', async () => {
      const first = await post(body(UNKNOWN_QUOTE)).expect(404);
      expect(first.headers['idempotent-replayed']).toBeUndefined();

      const second = await post(body(UNKNOWN_QUOTE)).expect(404);
      expect(second.headers['idempotent-replayed']).toBe('true');
      expect(second.body).toEqual(first.body);
    });

    it('un uuid en MAYÚSCULAS es el mismo contenido: se reproduce, no es un conflicto', async () => {
      const lower = 'abcdefab-0000-4000-8000-00000000000b';
      await post(body(lower)).expect(404);
      const res = await post(body(lower.toUpperCase())).expect(404);
      expect(lower.toUpperCase()).not.toBe(lower); // la prueba solo sirve si realmente cambian
      expect(res.headers['idempotent-replayed']).toBe('true');
    });

    it('la cotización de OTRO usuario se trata como inexistente (no se revela que existe)', async () => {
      const ajena = await insertQuote({ amount: '100', userId: 'user-002' });
      const res = await post(body(ajena)).expect(404);
      expect(res.body.error.code).toBe('QUOTE_NOT_FOUND');
      expect(await quoteStatus(ajena)).toBe('ACTIVE');
      expect(await count('exchanges')).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------------------------------------------
  describe('d: cotización vencida (definitivo: se guarda)', () => {
    it('422 QUOTE_EXPIRED, la cotización pasa a EXPIRED y no se crea ninguna operación', async () => {
      const quote = await insertQuote({ amount: '100', ageSeconds: 60 });

      const res = await post(body(quote)).expect(422);

      expect(res.body.error.code).toBe('QUOTE_EXPIRED');
      expect(await quoteStatus(quote)).toBe('EXPIRED');
      expect(await count('exchanges')).toBe(0);
      expect((await keyRows())[0]).toMatchObject({ response_status: 422 });
    });

    it('repetir devuelve el mismo 422 reproducido', async () => {
      const quote = await insertQuote({ amount: '100', ageSeconds: 60 });
      const first = await post(body(quote)).expect(422);
      const second = await post(body(quote)).expect(422);
      expect(second.headers['idempotent-replayed']).toBe('true');
      expect(second.body).toEqual(first.body);
    });

    it('una cotización ya marcada EXPIRED sigue siendo 422 con otra clave', async () => {
      const quote = await insertQuote({ amount: '100', ageSeconds: 60 });
      await post(body(quote), 'k1').expect(422);
      const res = await post(body(quote), 'k2').expect(422);
      expect(res.body.error.code).toBe('QUOTE_EXPIRED');
      expect(res.headers['idempotent-replayed']).toBeUndefined(); // otra clave: no es una repetición
    });

    it('la frontera: vencida EN el instante expires_at; con 5 s de vigencia restante, no', async () => {
      const justExpired = await insertQuote({ amount: '100', ageSeconds: 30 }); // expires_at = ahora
      await post(body(justExpired), 'k-expired').expect(422);

      const stillValid = await insertQuote({ amount: '100', ageSeconds: 25 }); // quedan ~5 s
      const started = await service.begin('user-001', 'k-valid', stillValid);
      expect(started.kind).toBe('STARTED');
      expect(await quoteStatus(stillValid)).toBe('ACTIVE');
    });
  });

  // ---------------------------------------------------------------------------------------------------------------
  describe('c: saldo insuficiente (transitorio: NO se guarda, la clave se libera)', () => {
    it('422 INSUFFICIENT_FUNDS con el disponible y lo requerido; nada queda escrito', async () => {
      const quote = await insertQuote({ amount: '10000.00000001' }); // 1 unidad mínima más de lo que hay

      const res = await post(body(quote)).expect(422);

      expect(res.body.error).toMatchObject({
        code: 'INSUFFICIENT_FUNDS',
        details: { available: '10000.00000000', required: '10000.00000001', asset: 'USDT-SBX' },
      });
      expect(await keyRows()).toEqual([]); // la clave se liberó
      expect(await count('exchanges')).toBe(0);
      expect(await quoteStatus(quote)).toBe('ACTIVE'); // la cotización sigue disponible
      expect(await count('ledger_entries')).toBe(1); // solo el depósito inicial
    });

    it('con exactamente el saldo disponible (10.000) sí se reserva', async () => {
      const quote = await insertQuote({ amount: '10000' });
      expect((await service.begin('user-001', 'k', quote)).kind).toBe('STARTED');
    });

    it('al reintentar con la MISMA clave se vuelve a evaluar (no se reproduce) y puede tener éxito', async () => {
      const quote = await insertQuote({ amount: '15000' });
      const first = await post(body(quote)).expect(422);
      expect(first.headers['idempotent-replayed']).toBeUndefined();

      // El usuario recibe fondos entre los dos intentos (un abono de otra operación).
      const topUp = await insertExchange(await insertQuote({ amount: '1' }));
      await ledgerMove({ userId: 'user-001', asset: 'USDT-SBX', exchangeId: topUp, entryType: 'CREDIT', balanceType: 'AVAILABLE', amount: '5000' });

      const retry = await service.begin('user-001', 'key-1', quote); // misma clave 'key-1' del primer intento
      expect(retry.kind).toBe('STARTED');
      await assertReconciled();
    });
  });

  // ---------------------------------------------------------------------------------------------------------------
  describe('éxito de la reserva (Tx1 completa)', () => {
    it('crea la operación en PROCESSING con su evento y enlaza la clave; la cotización sigue ACTIVE (D8)', async () => {
      const quote = await insertQuote({ amount: '999.99' });
      const balancesBefore = (await testPool.query('SELECT available, held FROM wallets ORDER BY id')).rows;

      const result = await service.begin('user-001', 'key-ok', quote);

      expect(result).toEqual({ kind: 'STARTED', exchangeId: expect.any(String), sourceAsset: 'USDT-SBX', sourceAmount: '999.99000000' });
      const exchangeId = (result as { exchangeId: string }).exchangeId;

      const exchange = (await testPool.query('SELECT * FROM exchanges WHERE id = $1', [exchangeId])).rows[0];
      expect(exchange).toMatchObject({
        user_id: 'user-001',
        quote_id: quote,
        idempotency_key: 'key-ok',
        status: 'PROCESSING',
        risk_level: null,
        requires_follow_up: false,
        failure_reason: null,
      });

      const events = (await testPool.query('SELECT from_status, to_status, actor_id, reason FROM exchange_events WHERE exchange_id = $1', [exchangeId])).rows;
      expect(events).toEqual([{ from_status: null, to_status: 'PROCESSING', actor_id: 'user-001', reason: null }]);

      // La clave queda "en curso": enlazada a la operación, sin respuesta todavía.
      expect(await keyRows()).toEqual([
        { user_id: 'user-001', key: 'key-ok', response_status: null, response_body: null, exchange_id: exchangeId },
      ]);
      const hash = (await testPool.query<{ request_hash: string }>('SELECT request_hash FROM idempotency_keys')).rows[0].request_hash;
      expect(hash).toBe(hashRequest(quote));

      expect(await quoteStatus(quote)).toBe('ACTIVE');
      // La primera transacción no mueve dinero.
      expect((await testPool.query('SELECT available, held FROM wallets ORDER BY id')).rows).toEqual(balancesBefore);
      expect(await count('ledger_entries')).toBe(1);
      await assertReconciled();
    });
  });

  // ---------------------------------------------------------------------------------------------------------------
  describe('idempotencia mientras la operación está en curso', () => {
    it('misma clave y mismo contenido: 409 IDEMPOTENCY_IN_PROGRESS (la original aún no termina)', async () => {
      const quote = await insertQuote({ amount: '100' });
      await service.begin('user-001', 'k', quote);

      const res = await post(body(quote), 'k').expect(409);

      expect(res.body.error.code).toBe('IDEMPOTENCY_IN_PROGRESS');
      expect(await count('exchanges')).toBe(1);
    });

    it('f: misma clave con OTRO contenido: 409 IDEMPOTENCY_KEY_MISMATCH, sin efectos', async () => {
      const a = await insertQuote({ amount: '100' });
      const b = await insertQuote({ amount: '200' });
      await service.begin('user-001', 'k', a);

      const res = await post(body(b), 'k').expect(409);

      expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_MISMATCH');
      expect(await count('exchanges')).toBe(1);
      expect(await quoteStatus(b)).toBe('ACTIVE');
    });

    it('el conflicto de contenido tiene prioridad sobre "en curso"', async () => {
      const a = await insertQuote({ amount: '100' });
      await service.begin('user-001', 'k', a);
      const res = await post(body(UNKNOWN_QUOTE), 'k').expect(409);
      expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_MISMATCH');
    });

    it('f: tras un resultado guardado, otro contenido con la misma clave también es MISMATCH', async () => {
      await post(body(UNKNOWN_QUOTE), 'k').expect(404);
      const quote = await insertQuote({ amount: '100' });
      const res = await post(body(quote), 'k').expect(409);
      expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_MISMATCH');
    });

    it('la clave es por usuario: otro usuario puede usar la misma clave', async () => {
      await post(body(UNKNOWN_QUOTE), 'k', 'user-001').expect(404);
      const res = await post(body(UNKNOWN_QUOTE), 'k', 'user-002').expect(404);
      expect(res.headers['idempotent-replayed']).toBeUndefined(); // no es la misma clave: es la de otro usuario
      expect(await count('idempotency_keys')).toBe(2);
    });
  });

  // ---------------------------------------------------------------------------------------------------------------
  describe('una cotización, un solo intercambio vivo', () => {
    it('409 QUOTE_IN_USE si otra operación EN CURSO la tiene; transitorio: la clave se libera', async () => {
      const quote = await insertQuote({ amount: '100' });
      await insertExchange(quote, { key: 'otra-clave' }); // otra operación PROCESSING sobre la misma cotización

      const res = await post(body(quote), 'mi-clave').expect(409);

      expect(res.body.error.code).toBe('QUOTE_IN_USE');
      expect(await keyRows()).toEqual([]);
      expect(await count('exchanges')).toBe(1);
      expect(await quoteStatus(quote)).toBe('ACTIVE'); // no se tocó
    });

    it('el paso "¿en uso?" va ANTES del vencimiento: una cotización vencida con una operación en curso NO se marca EXPIRED', async () => {
      const quote = await insertQuote({ amount: '100', ageSeconds: 60 }); // ya vencida
      await insertExchange(quote, { key: 'otra' }); // pero otra operación ya la tomó cuando era válida

      const res = await post(body(quote), 'mi-clave').expect(409);

      expect(res.body.error.code).toBe('QUOTE_IN_USE');
      expect(await quoteStatus(quote)).toBe('ACTIVE'); // esta petición no la pisó con EXPIRED
    });

    it('B7: 409 QUOTE_ALREADY_USED si ya se usó (definitivo: se guarda y se reproduce)', async () => {
      const quote = await insertQuote({ amount: '100' });
      const exchange = await insertExchange(quote, { key: 'primera' });
      await testPool.query("UPDATE exchanges SET status = 'COMPLETED', risk_level = 'LOW' WHERE id = $1", [exchange]);
      await testPool.query("UPDATE quotes SET status = 'USED' WHERE id = $1", [quote]);

      const first = await post(body(quote), 'segunda').expect(409);
      expect(first.body.error.code).toBe('QUOTE_ALREADY_USED');
      expect((await keyRows()).find((r) => r.key === 'segunda')).toMatchObject({ response_status: 409 });

      const second = await post(body(quote), 'segunda').expect(409);
      expect(second.headers['idempotent-replayed']).toBe('true');
      expect(second.body).toEqual(first.body);
    });

    it('también si está en PENDING_REVIEW o REJECTED (USED nunca se reutiliza, D4)', async () => {
      for (const [i, finalStatus] of (['PENDING_REVIEW', 'REJECTED'] as const).entries()) {
        const quote = await insertQuote({ amount: '100' });
        const exchange = await insertExchange(quote, { key: `orig-${i}` });
        await testPool.query("UPDATE exchanges SET status = 'PENDING_REVIEW', risk_level = 'HIGH' WHERE id = $1", [exchange]);
        if (finalStatus === 'REJECTED') await testPool.query("UPDATE exchanges SET status = 'REJECTED' WHERE id = $1", [exchange]);
        await testPool.query("UPDATE quotes SET status = 'USED' WHERE id = $1", [quote]);

        const res = await post(body(quote), `nueva-${i}`).expect(409);
        expect(res.body.error.code).toBe('QUOTE_ALREADY_USED');
      }
    });

    it('una cotización USED sin operación asociada también se rechaza', async () => {
      const quote = await insertQuote({ amount: '100' });
      await testPool.query("UPDATE quotes SET status = 'USED' WHERE id = $1", [quote]);
      const res = await post(body(quote)).expect(409);
      expect(res.body.error.code).toBe('QUOTE_ALREADY_USED');
    });

    it('un intercambio FAILED NO bloquea la cotización: se puede volver a ejecutar (D7, D8)', async () => {
      const quote = await insertQuote({ amount: '100' });
      const failed = await insertExchange(quote, { key: 'intento-1' });
      await testPool.query("UPDATE exchanges SET status = 'FAILED', failure_reason = 'COMPLIANCE_UNAVAILABLE' WHERE id = $1", [failed]);

      const result = await service.begin('user-001', 'intento-2', quote);

      expect(result.kind).toBe('STARTED');
      const rows = (await testPool.query("SELECT status FROM exchanges WHERE quote_id = $1 ORDER BY created_at, status", [quote])).rows;
      expect(rows.map((r) => r.status).sort()).toEqual(['FAILED', 'PROCESSING']);
    });
  });

  // ---------------------------------------------------------------------------------------------------------------
  describe('concurrencia', () => {
    it('la MISMA clave 5 veces a la vez: una reserva y las otras 4 ven "en curso"; una sola operación', async () => {
      const quote = await insertQuote({ amount: '100' });

      const results = await Promise.all(Array.from({ length: 5 }, () => outcome(service.begin('user-001', 'misma', quote))));

      expect(results.filter((r) => r === 'STARTED')).toHaveLength(1);
      expect(results.filter((r) => r === 'IDEMPOTENCY_IN_PROGRESS')).toHaveLength(4);
      expect(await count('exchanges')).toBe(1);
      expect(await count('idempotency_keys')).toBe(1);
    });

    it('5 claves DISTINTAS sobre la misma cotización: una reserva y las otras 4 reciben QUOTE_IN_USE', async () => {
      const quote = await insertQuote({ amount: '100' });

      const results = await Promise.all(
        ['a', 'b', 'c', 'd', 'e'].map((key) => outcome(service.begin('user-001', `clave-${key}`, quote))),
      );

      expect(results.filter((r) => r === 'STARTED')).toHaveLength(1);
      expect(results.filter((r) => r === 'QUOTE_IN_USE')).toHaveLength(4);
      expect(await count('exchanges')).toBe(1);
      // Las 4 perdedoras liberaron su clave: solo existe la de la ganadora.
      expect(await count('idempotency_keys')).toBe(1);
    });

    it('la misma clave con DOS contenidos distintos a la vez: una reserva y la otra recibe MISMATCH', async () => {
      const a = await insertQuote({ amount: '100' });
      const b = await insertQuote({ amount: '200' });

      const results = await Promise.all([outcome(service.begin('user-001', 'k', a)), outcome(service.begin('user-001', 'k', b))]);

      expect([...results].sort()).toEqual(['IDEMPOTENCY_KEY_MISMATCH', 'STARTED']);
      expect(await count('exchanges')).toBe(1);
    });

    // Se bloquea con FOR NO KEY UPDATE y no con FOR UPDATE a propósito: el INSERT del intercambio tiene una clave foránea a la
    // cotización, que toma un bloqueo FOR KEY SHARE; ese SÍ choca con FOR UPDATE pero NO con FOR NO KEY UPDATE. Con
    // FOR UPDATE la prueba pasaría aunque Tx1 no bloqueara la cotización, porque se quedaría esperando en el INSERT.
    // FOR NO KEY UPDATE solo choca con el FOR UPDATE explícito de Tx1, que es lo que se quiere demostrar.
    it('Tx1 toma el bloqueo FOR UPDATE de la cotización: ESPERA a quien la tiene y continúa al liberarse', async () => {
      const quote = await insertQuote({ amount: '100' });
      const holder = await testPool.connect();
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT id FROM quotes WHERE id = $1 FOR NO KEY UPDATE', [quote]);

        let settled = false;
        const waiting = service.begin('user-001', 'k', quote).finally(() => {
          settled = true;
        });

        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(settled).toBe(false);

        await holder.query('COMMIT');
        expect((await waiting).kind).toBe('STARTED');
      } finally {
        holder.release();
      }
    });

    it('el vencimiento se mide al LEER la cotización, no al inicio de la transacción: si venció mientras esperaba el bloqueo, está vencida', async () => {
      const quote = await insertQuote({ amount: '100', ageSeconds: 28 }); // le quedan ~2 s de vigencia
      const holder = await testPool.connect();
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT id FROM quotes WHERE id = $1 FOR NO KEY UPDATE', [quote]);

        // Tx1 arranca ahora (la cotización aún es válida) pero espera el bloqueo más de lo que le queda de vigencia.
        const waiting = service.begin('user-001', 'k', quote).then(
          (r) => r.kind,
          (e: unknown) => (e instanceof BusinessError ? e.code : String(e)),
        );
        await new Promise((resolve) => setTimeout(resolve, 2600));
        await holder.query('COMMIT');

        // Con now() (hora de inicio de la transacción) se habría reservado una cotización que ya había vencido.
        expect(await waiting).toBe('QUOTE_EXPIRED');
        expect(await quoteStatus(quote)).toBe('EXPIRED');
        expect(await count('exchanges')).toBe(0);
      } finally {
        holder.release();
      }
    });

    it('una cotización liberada por un FAILED vuelve a estar disponible para las que perdieron', async () => {
      const quote = await insertQuote({ amount: '100' });
      const first = (await service.begin('user-001', 'a', quote)) as { exchangeId: string };
      await expect(service.begin('user-001', 'b', quote)).rejects.toMatchObject({ code: 'QUOTE_IN_USE' });

      // Simula lo que hará la T12 si cumplimiento falla: la operación pasa a FAILED y se libera su clave.
      await testPool.query("UPDATE exchanges SET status = 'FAILED', failure_reason = 'COMPLIANCE_UNAVAILABLE' WHERE id = $1", [first.exchangeId]);
      await testPool.query("DELETE FROM idempotency_keys WHERE key = 'a'");

      expect((await service.begin('user-001', 'b', quote)).kind).toBe('STARTED');
    });
  });

  // ---------------------------------------------------------------------------------------------------------------
  describe('funciones auxiliares', () => {
    it('hashRequest es estable, no distingue mayúsculas en el uuid y sí distingue cotizaciones', () => {
      const id = 'a1b2c3d4-0000-4000-8000-000000000001';
      expect(hashRequest(id)).toMatch(/^[0-9a-f]{64}$/);
      expect(hashRequest(id)).toBe(hashRequest(id));
      expect(hashRequest(id)).toBe(hashRequest(id.toUpperCase()));
      expect(hashRequest(id)).not.toBe(hashRequest('a1b2c3d4-0000-4000-8000-000000000002'));
    });

    it('translateConstraintError convierte el índice de cotización viva en QUOTE_IN_USE y deja pasar el resto', () => {
      const pgError = Object.assign(new Error('duplicate key'), { code: '23505', constraint: 'exchanges_quote_live_uq' });
      const translated = translateConstraintError(pgError, 'q-1');
      expect(translated).toBeInstanceOf(BusinessError);
      expect(translated).toMatchObject({ code: 'QUOTE_IN_USE', httpStatus: 409 });

      const other = Object.assign(new Error('otra'), { code: '23505', constraint: 'otro_indice' });
      expect(translateConstraintError(other, 'q-1')).toBe(other);
      const plain = new Error('x');
      expect(translateConstraintError(plain, 'q-1')).toBe(plain);
    });
  });
});
