import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { closeDb, createApp, resetDb, testPool } from '../helpers';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('POST /quotes', () => {
  let app: INestApplication;

  const post = (body: unknown, userId: string | null = 'user-001') => {
    const req = request(app.getHttpServer()).post('/quotes');
    if (userId) req.set('X-User-Id', userId);
    return req.send(body as object);
  };
  const quoteBody = (amount: unknown) => ({ source_asset: 'USDT-SBX', target_asset: 'XAUT-SBX', source_amount: amount });
  const quoteCount = async (): Promise<number> =>
    Number((await testPool.query<{ n: string }>('SELECT count(*) AS n FROM quotes')).rows[0].n);

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

  describe('autenticación y rol', () => {
    it('401 sin usuario', async () => {
      const res = await post(quoteBody('100'), null).expect(401);
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
    });

    it('403 si el rol es COMPLIANCE (segregación de funciones)', async () => {
      const res = await post(quoteBody('100'), 'compliance-001').expect(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
      expect(await quoteCount()).toBe(0);
    });
  });

  describe('cotización exitosa', () => {
    it('ejemplo del enunciado: 2.500 USDT → comisión 25, neto 2.475, 0,99 XAUT', async () => {
      const res = await post(quoteBody('2500')).expect(201);

      expect(res.body).toEqual({
        id: expect.stringMatching(UUID),
        source_asset: 'USDT-SBX',
        target_asset: 'XAUT-SBX',
        source_amount: '2500.00000000',
        price: '2500.00000000',
        fee_rate: '0.010000',
        fee_amount: '25.00000000',
        net_amount: '2475.00000000',
        target_amount: '0.99000000',
        status: 'ACTIVE',
        created_at: expect.any(String),
        expires_at: expect.any(String),
      });
    });

    it('lo devuelto es exactamente lo guardado, a nombre de quien cotiza', async () => {
      const res = await post(quoteBody('999.99')).expect(201);

      const { rows } = await testPool.query(
        `SELECT user_id, source_amount, price, fee_rate, fee_amount, net_amount, target_amount, status
           FROM quotes WHERE id = $1`,
        [res.body.id],
      );
      expect(rows).toEqual([
        {
          user_id: 'user-001',
          source_amount: res.body.source_amount,
          price: res.body.price,
          fee_rate: res.body.fee_rate,
          fee_amount: res.body.fee_amount,
          net_amount: res.body.net_amount,
          target_amount: res.body.target_amount,
          status: 'ACTIVE',
        },
      ]);
    });

    // La tabla de docs/spec.md §7: [monto, comisión, neto, XAUT]
    it.each([
      ['999.99', '9.99990000', '989.99010000', '0.39599604'],
      ['1000', '10.00000000', '990.00000000', '0.39600000'],
      ['5000', '50.00000000', '4950.00000000', '1.98000000'],
      ['5000.01', '50.00010000', '4950.00990000', '1.98000396'],
      ['10000', '100.00000000', '9900.00000000', '3.96000000'],
      ['0.12345678', '0.00123457', '0.12222221', '0.00004888'], // comisión ↑, destino ↓
    ])('%s USDT → comisión %s, neto %s, %s XAUT', async (amount, fee, net, target) => {
      const res = await post(quoteBody(amount)).expect(201);
      expect(res.body).toMatchObject({ fee_amount: fee, net_amount: net, target_amount: target });
    });

    it('el monto máximo representable (20 enteros y 8 decimales) también se cotiza', async () => {
      const res = await post(quoteBody('99999999999999999999.99999999')).expect(201);
      expect(res.body.fee_amount).toBe('1000000000000000000.00000000'); // ceil8(source × 1 %)
    });

    it('cotizar no exige saldo (D14) y no mueve saldos ni ledger', async () => {
      const before = await testPool.query('SELECT user_id, asset_code, available, held FROM wallets ORDER BY 1, 2');
      const movementsBefore = (await testPool.query('SELECT count(*) AS n FROM ledger_entries')).rows[0].n;

      await post(quoteBody('50000')).expect(201); // user-001 solo tiene 10.000

      expect((await testPool.query('SELECT user_id, asset_code, available, held FROM wallets ORDER BY 1, 2')).rows).toEqual(
        before.rows,
      );
      expect((await testPool.query('SELECT count(*) AS n FROM ledger_entries')).rows[0].n).toBe(movementsBefore);
    });
  });

  describe('vigencia', () => {
    const secondsBetween = (body: { created_at: string; expires_at: string }): number =>
      (new Date(body.expires_at).getTime() - new Date(body.created_at).getTime()) / 1000;

    it('30 segundos por defecto, medidos con el reloj de la base', async () => {
      const res = await post(quoteBody('100')).expect(201);
      expect(secondsBetween(res.body)).toBe(30);
    });

    it('QUOTE_TTL_SECONDS la cambia (así las pruebas de vencimiento no esperan 30 s)', async () => {
      process.env.QUOTE_TTL_SECONDS = '5';
      const short = await createApp();
      try {
        const res = await request(short.getHttpServer())
          .post('/quotes')
          .set('X-User-Id', 'user-001')
          .send(quoteBody('100'))
          .expect(201);
        expect(secondsBetween(res.body)).toBe(5);
      } finally {
        delete process.env.QUOTE_TTL_SECONDS;
        await short.close();
      }
    });

    it.each(['0', '-5', 'abc', '1.5', ''])('un QUOTE_TTL_SECONDS inválido ("%s") impide arrancar', async (ttl) => {
      process.env.QUOTE_TTL_SECONDS = ttl;
      try {
        await expect(createApp()).rejects.toThrow(/QUOTE_TTL_SECONDS/);
      } finally {
        delete process.env.QUOTE_TTL_SECONDS;
      }
    });
  });

  describe('422 AMOUNT_TOO_SMALL (D12)', () => {
    it('0,00002526 USDT es el mínimo que da algo: 0,00000001 XAUT', async () => {
      const res = await post(quoteBody('0.00002526')).expect(201);
      expect(res.body.target_amount).toBe('0.00000001');
    });

    it('0,00002525 USDT da 0 XAUT al redondear hacia abajo: se rechaza y no se guarda nada', async () => {
      const res = await post(quoteBody('0.00002525')).expect(422);
      expect(res.body.error.code).toBe('AMOUNT_TOO_SMALL');
      expect(await quoteCount()).toBe(0);
    });

    it('0,00000001 USDT (la unidad mínima) también', async () => {
      await post(quoteBody('0.00000001')).expect(422);
    });
  });

  describe('400 VALIDATION_ERROR (B3)', () => {
    // [descripción, monto, campo que debe reportarse]
    it.each<[string, unknown]>([
      ['9 decimales', '1.123456789'],
      ['21 enteros', '100000000000000000000'],
      ['cero', '0'],
      ['cero con decimales', '0.00000000'],
      ['negativo', '-1'],
      ['texto', 'abc'],
      ['notación científica', '1e3'],
      ['cadena vacía', ''],
      ['con espacios', ' 5'],
      ['coma decimal', '1,5'],
      ['sin parte entera', '.5'],
      ['sin decimales tras el punto', '5.'],
      ['con signo +', '+5'],
      ['número JSON válido (S3)', 999.99],
      ['número JSON entero', 5],
      ['número JSON cero', 0],
      ['null', null],
      ['booleano', true],
      ['arreglo', ['5']],
    ])('rechaza %s', async (_description, amount) => {
      const res = await post(quoteBody(amount)).expect(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.details.fields.map((f: { field: string }) => f.field)).toContain('source_amount');
      expect(await quoteCount()).toBe(0);
    });

    it('a quien envía un número JSON le explica que el monto debe ser un string (S3)', async () => {
      const res = await post(quoteBody(999.99)).expect(400);
      // toEqual con matchers: si falla, Jest imprime la respuesta completa que se recibió, en vez de un TypeError opaco.
      expect(res.body.error.details.fields).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field: 'source_amount',
            messages: expect.arrayContaining([expect.stringContaining('debe ser un string')]),
          }),
        ]),
      );
    });

    it('rechaza que falte el monto o el cuerpo entero', async () => {
      await post({ source_asset: 'USDT-SBX', target_asset: 'XAUT-SBX' }).expect(400);
      await post({}).expect(400);
    });

    it.each([
      ['par invertido', { source_asset: 'XAUT-SBX', target_asset: 'USDT-SBX', source_amount: '100' }, 'source_asset'],
      ['mismo activo', { source_asset: 'USDT-SBX', target_asset: 'USDT-SBX', source_amount: '100' }, 'target_asset'],
      ['activo desconocido', { source_asset: 'BTC', target_asset: 'XAUT-SBX', source_amount: '100' }, 'source_asset'],
      ['sin activos', { source_amount: '100' }, 'source_asset'],
    ])('rechaza un par no soportado (D18, solo USDT-SBX → XAUT-SBX): %s', async (_description, body, field) => {
      const res = await post(body).expect(400);
      expect(res.body.error.details.fields.map((f: { field: string }) => f.field)).toContain(field);
      expect(await quoteCount()).toBe(0);
    });

    it('rechaza propiedades desconocidas, como user_id o price: el cliente no decide el precio', async () => {
      await post({ ...quoteBody('100'), price: '1' }).expect(400);
      await post({ ...quoteBody('100'), user_id: 'compliance-001' }).expect(400);
      expect(await quoteCount()).toBe(0);
    });
  });
});
