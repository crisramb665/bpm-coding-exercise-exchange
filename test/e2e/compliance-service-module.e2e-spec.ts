import { INestApplication } from '@nestjs/common';
import { ComplianceClient } from '../../src/compliance-service/compliance.client';
import { COMPLIANCE_PROVIDER, COMPLIANCE_TIMEOUT_MS, ComplianceProvider } from '../../src/compliance-service/compliance.types';
import { closeDb, createApp } from '../helpers';

const request = { exchangeId: 'e-1', userId: 'user-001', sourceAsset: 'USDT-SBX', sourceAmount: '5000.01' };

// Que el cableado de Nest funcione: el cliente recibe el proveedor y el timeout por inyección de dependencias,
// y el proveedor se puede sustituir en las pruebas (la forma en que se simulará la falla en la T12).
describe('ComplianceServiceModule', () => {
  afterAll(async () => {
    await closeDb();
  });

  it('por defecto el cliente usa el mock: 5.000,01 → HIGH', async () => {
    const app = await createApp();
    try {
      const result = await app.get(ComplianceClient).assess(request);
      expect(result).toMatchObject({ outcome: 'OK', provider: 'MOCK', riskLevel: 'HIGH' });
    } finally {
      await app.close();
    }
  });

  it('el proveedor se sustituye con overrideProvider: un proveedor que falla da ERROR', async () => {
    const failing: ComplianceProvider = {
      name: 'FAILING',
      assess: async () => {
        throw new Error('servicio caído');
      },
    };
    const app = await createApp({ overrides: (b) => b.overrideProvider(COMPLIANCE_PROVIDER).useValue(failing) });
    try {
      expect(await app.get(ComplianceClient).assess(request)).toMatchObject({
        outcome: 'ERROR',
        provider: 'FAILING',
        errorMessage: 'servicio caído',
      });
    } finally {
      await app.close();
    }
  });

  it('COMPLIANCE_MOCK_FAIL=true llega hasta el cliente como un resultado ERROR', async () => {
    process.env.COMPLIANCE_MOCK_FAIL = 'true';
    let app: INestApplication | undefined;
    try {
      app = await createApp();
      expect(await app.get(ComplianceClient).assess(request)).toMatchObject({ outcome: 'ERROR', provider: 'MOCK' });
    } finally {
      delete process.env.COMPLIANCE_MOCK_FAIL;
      await app?.close();
    }
  });

  it('sin COMPLIANCE_TIMEOUT_MS el timeout por defecto es de 2.000 ms (S7)', async () => {
    const app = await createApp();
    try {
      expect(app.get(COMPLIANCE_TIMEOUT_MS)).toBe(2000);
    } finally {
      await app.close();
    }
  });

  it('COMPLIANCE_TIMEOUT_MS llega al cliente: un proveedor lento con timeout de 30 ms da ERROR', async () => {
    const slow: ComplianceProvider = {
      name: 'SLOW',
      assess: () => new Promise((resolve) => setTimeout(() => resolve({ riskLevel: 'LOW' }), 300)),
    };
    process.env.COMPLIANCE_TIMEOUT_MS = '30';
    let app: INestApplication | undefined;
    try {
      app = await createApp({ overrides: (b) => b.overrideProvider(COMPLIANCE_PROVIDER).useValue(slow) });
      expect(await app.get(ComplianceClient).assess(request)).toMatchObject({
        outcome: 'ERROR',
        errorMessage: expect.stringMatching(/30 ms/),
      });
    } finally {
      delete process.env.COMPLIANCE_TIMEOUT_MS;
      await app?.close();
    }
  });

  it.each(['0', '-1', 'abc', '1.5', '', '1234567'])('un COMPLIANCE_TIMEOUT_MS inválido ("%s") impide arrancar', async (value) => {
    process.env.COMPLIANCE_TIMEOUT_MS = value;
    try {
      await expect(createApp()).rejects.toThrow(/COMPLIANCE_TIMEOUT_MS/);
    } finally {
      delete process.env.COMPLIANCE_TIMEOUT_MS;
    }
  });
});
