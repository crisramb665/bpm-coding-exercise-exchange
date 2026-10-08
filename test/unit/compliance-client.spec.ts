import { ComplianceClient } from '../../src/compliance-service/compliance.client';
import { ComplianceProvider, ComplianceRequest, ComplianceResponse } from '../../src/compliance-service/compliance.types';

const request: ComplianceRequest = { exchangeId: 'e-1', userId: 'user-001', sourceAsset: 'USDT-SBX', sourceAmount: '5000.01' };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Proveedor de pruebas con la respuesta (o el comportamiento) que se le indique.
const providerOf = (assess: () => Promise<unknown>): ComplianceProvider => ({
  name: 'FAKE',
  assess: assess as () => Promise<ComplianceResponse>,
});

describe('ComplianceClient', () => {
  it('OK: devuelve el riesgo, el proveedor, lo enviado, lo recibido y la duración', async () => {
    const client = new ComplianceClient(providerOf(async () => ({ riskLevel: 'HIGH' })), 1000);

    const result = await client.assess(request);

    expect(result).toEqual({
      outcome: 'OK',
      provider: 'FAKE',
      riskLevel: 'HIGH',
      requestPayload: request,
      responsePayload: { riskLevel: 'HIGH' },
      durationMs: expect.any(Number),
    });
  });

  describe('ERROR: nunca lanza, devuelve un resultado que el flujo sabe tratar (D7)', () => {
    it('el proveedor lanza un Error', async () => {
      const client = new ComplianceClient(
        providerOf(async () => {
          throw new Error('503 del proveedor');
        }),
        1000,
      );
      expect(await client.assess(request)).toMatchObject({
        outcome: 'ERROR',
        provider: 'FAKE',
        errorMessage: '503 del proveedor',
        requestPayload: request,
      });
    });

    it('el proveedor lanza algo que no es un Error', async () => {
      const client = new ComplianceClient(providerOf(() => Promise.reject('texto suelto')), 1000);
      expect(await client.assess(request)).toMatchObject({ outcome: 'ERROR', errorMessage: 'texto suelto' });
    });

    it('el proveedor lanza de forma síncrona (antes de devolver una promesa)', async () => {
      const client = new ComplianceClient(
        providerOf(() => {
          throw new Error('falla síncrona');
        }),
        1000,
      );
      expect(await client.assess(request)).toMatchObject({ outcome: 'ERROR', errorMessage: 'falla síncrona' });
    });

    it.each([
      ['un nivel que no existe', { riskLevel: 'CRITICAL' }],
      ['un nivel en minúsculas', { riskLevel: 'low' }],
      ['sin riskLevel', {}],
      ['riskLevel null', { riskLevel: null }],
      ['una respuesta vacía', undefined],
      ['una respuesta null', null],
      ['un string en lugar de un objeto', 'HIGH'],
    ])('respuesta inválida: %s', async (_description, response) => {
      const client = new ComplianceClient(providerOf(async () => response), 1000);
      const result = await client.assess(request);
      expect(result).toMatchObject({ outcome: 'ERROR' });
      expect(result.outcome === 'ERROR' && result.errorMessage).toMatch(/Respuesta inválida/);
    });
  });

  describe('timeout', () => {
    it('un proveedor lento termina en ERROR a los ms indicados, sin esperar a que responda', async () => {
      const client = new ComplianceClient(
        providerOf(async () => {
          await sleep(500);
          return { riskLevel: 'LOW' };
        }),
        50,
      );

      const started = Date.now();
      const result = await client.assess(request);
      const elapsed = Date.now() - started;

      expect(result).toMatchObject({ outcome: 'ERROR', errorMessage: expect.stringMatching(/no respondió en 50 ms/) });
      expect(elapsed).toBeGreaterThanOrEqual(45); // esperó el timeout...
      expect(elapsed).toBeLessThan(400); // ...y no a los 500 ms del proveedor
      if (result.outcome === 'ERROR') expect(result.durationMs).toBeGreaterThanOrEqual(45);
    });

    it('un proveedor que nunca responde también termina en ERROR', async () => {
      const client = new ComplianceClient(providerOf(() => new Promise(() => undefined)), 30);
      expect(await client.assess(request)).toMatchObject({ outcome: 'ERROR', errorMessage: expect.stringMatching(/30 ms/) });
    });

    it('un proveedor que responde a tiempo no se ve afectado por el timeout', async () => {
      const client = new ComplianceClient(
        providerOf(async () => {
          await sleep(20);
          return { riskLevel: 'LOW' };
        }),
        500,
      );
      expect(await client.assess(request)).toMatchObject({ outcome: 'OK', riskLevel: 'LOW' });
    });

    it('no deja temporizadores vivos al terminar, ni cuando responde a tiempo ni cuando falla', async () => {
      // Con temporizadores simulados se puede contar cuántos quedan pendientes. Un temporizador de 2 s que sobrevive
      // a cada consulta es una fuga: mantiene vivo el proceso y se acumula bajo carga.
      jest.useFakeTimers();
      try {
        const ok = new ComplianceClient(providerOf(async () => ({ riskLevel: 'LOW' })), 2000);
        await ok.assess(request);
        expect(jest.getTimerCount()).toBe(0);

        const failing = new ComplianceClient(providerOf(() => Promise.reject(new Error('x'))), 2000);
        await failing.assess(request);
        expect(jest.getTimerCount()).toBe(0);
      } finally {
        jest.useRealTimers();
      }
    });

    it('si el proveedor falla DESPUÉS del timeout no queda un rechazo sin manejar que tumbe el proceso', async () => {
      const unhandled: unknown[] = [];
      const listener = (reason: unknown): void => {
        unhandled.push(reason);
      };
      process.on('unhandledRejection', listener);
      try {
        const client = new ComplianceClient(
          providerOf(async () => {
            await sleep(60);
            throw new Error('falla tardía');
          }),
          20,
        );
        expect(await client.assess(request)).toMatchObject({ outcome: 'ERROR' });
        await sleep(150); // da tiempo a que el proveedor falle por su cuenta
        expect(unhandled).toEqual([]);
      } finally {
        process.off('unhandledRejection', listener);
      }
    });
  });
});
