import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { closeDb, createApp, resetDb } from '../helpers';
import { ProbeController } from '../probe.controller';

// Caso B5 de docs/plan.md §9 (parte común): 401, 403, validación y formato de error.
describe('autenticación, roles y errores', () => {
  let app: INestApplication;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await createApp({ controllers: [ProbeController] });
    await resetDb();
  });

  afterAll(async () => {
    await app.close();
    await closeDb();
  });

  describe('401 UNAUTHENTICATED', () => {
    it('sin encabezado X-User-Id', async () => {
      const res = await http().get('/probe/any').expect(401);
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
    });

    it('con encabezado vacío', async () => {
      await http().get('/probe/any').set('X-User-Id', '   ').expect(401);
    });

    it('con un usuario que no existe', async () => {
      const res = await http().get('/probe/any').set('X-User-Id', 'fantasma').expect(401);
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
    });

    it('el 401 gana al 400: sin usuario no se llega a validar el cuerpo', async () => {
      await http().post('/probe/amount').send({ amount: 'abc' }).expect(401);
    });
  });

  describe('403 FORBIDDEN', () => {
    it('USER en una ruta de COMPLIANCE', async () => {
      const res = await http().get('/probe/compliance').set('X-User-Id', 'user-001').expect(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });

    it('COMPLIANCE en una ruta de USER', async () => {
      const res = await http().get('/probe/user').set('X-User-Id', 'compliance-001').expect(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });
  });

  describe('acceso permitido', () => {
    it('cada rol entra a su ruta', async () => {
      await http().get('/probe/user').set('X-User-Id', 'user-001').expect(200);
      await http().get('/probe/compliance').set('X-User-Id', 'compliance-001').expect(200);
    });

    it('una ruta sin @Roles admite a cualquier usuario autenticado', async () => {
      await http().get('/probe/any').set('X-User-Id', 'user-001').expect(200);
      await http().get('/probe/any').set('X-User-Id', 'compliance-001').expect(200);
    });
  });

  describe('400 VALIDATION_ERROR', () => {
    const post = (body: unknown) => http().post('/probe/amount').set('X-User-Id', 'user-001').send(body as object);

    it('acepta un monto string válido y lo devuelve intacto, sin pasar por Number', async () => {
      // Number('12345678901234567.12345678') daría 12345678901234568: pierde precisión. Como string llega exacto.
      const res = await post({ amount: '12345678901234567.12345678' }).expect(201);
      expect(res.body).toEqual({ amount: '12345678901234567.12345678' });
    });

    it('rechaza un número JSON (S3) aunque su valor sea válido', async () => {
      const res = await post({ amount: 999.99 }).expect(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.details.fields[0].field).toBe('amount');
    });

    it('rechaza 9 decimales, texto y cuerpo vacío', async () => {
      await post({ amount: '1.123456789' }).expect(400);
      await post({ amount: 'abc' }).expect(400);
      await post({}).expect(400);
    });

    it('rechaza propiedades desconocidas en lugar de ignorarlas', async () => {
      const res = await post({ amount: '1', extra: 'x' }).expect(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('formato de BusinessError', () => {
    it('serializa código, mensaje y detalles con el status definido', async () => {
      const res = await http().get('/probe/business-error').set('X-User-Id', 'user-001').expect(422);
      expect(res.body).toEqual({
        error: { code: 'QUOTE_EXPIRED', message: 'La cotización venció', details: { quote_id: 'q-1' } },
      });
    });
  });
});
