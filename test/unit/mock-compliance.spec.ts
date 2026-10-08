import { MockComplianceProvider, riskLevelForAmount } from '../../src/compliance-service/mock-compliance.provider';
import { RiskLevel } from '../../src/compliance-service/compliance.types';

// R10 (enunciado 3.7): el riesgo depende del monto bruto de origen en USDT-SBX.
describe('MockComplianceProvider', () => {
  describe('umbrales de riesgo', () => {
    // La tabla de docs/spec.md §7 más las fronteras exactas a ambos lados de 1.000 y 5.000.
    it.each<[string, RiskLevel]>([
      ['0.00000001', 'LOW'],
      ['0.12345678', 'LOW'],
      ['999.99', 'LOW'],
      ['999.99999999', 'LOW'], // un paso por debajo de 1.000
      ['1000', 'MEDIUM'], // 1.000 ya es MEDIUM
      ['1000.00000001', 'MEDIUM'],
      ['2500', 'MEDIUM'],
      ['5000', 'MEDIUM'], // 5.000 sigue siendo MEDIUM (inclusive)
      ['5000.00000001', 'HIGH'], // un paso por encima de 5.000
      ['5000.01', 'HIGH'],
      ['10000', 'HIGH'],
      ['99999999999999999999.99999999', 'HIGH'], // 28 dígitos: la comparación sigue siendo exacta
    ])('%s USDT → %s', (amount, risk) => {
      expect(riskLevelForAmount(amount)).toBe(risk);
    });
  });

  describe('assess', () => {
    const request = (sourceAmount: string, sourceAsset = 'USDT-SBX') => ({
      exchangeId: 'e-1',
      userId: 'user-001',
      sourceAsset,
      sourceAmount,
    });

    it('responde con el nivel de riesgo del monto', async () => {
      const provider = new MockComplianceProvider();
      expect(await provider.assess(request('999.99'))).toEqual({ riskLevel: 'LOW' });
      expect(await provider.assess(request('1000'))).toEqual({ riskLevel: 'MEDIUM' });
      expect(await provider.assess(request('5000'))).toEqual({ riskLevel: 'MEDIUM' });
      expect(await provider.assess(request('5000.01'))).toEqual({ riskLevel: 'HIGH' });
    });

    it('se identifica como MOCK (es el valor que se guarda en compliance_checks.provider)', () => {
      expect(new MockComplianceProvider().name).toBe('MOCK');
    });

    it('rechaza un activo distinto de USDT-SBX en lugar de evaluarlo con umbrales que no le corresponden', async () => {
      await expect(new MockComplianceProvider().assess(request('100', 'XAUT-SBX'))).rejects.toThrow(/USDT-SBX/);
    });

    describe('COMPLIANCE_MOCK_FAIL', () => {
      afterEach(() => {
        delete process.env.COMPLIANCE_MOCK_FAIL;
      });

      it('con "true" simula un servicio caído', async () => {
        process.env.COMPLIANCE_MOCK_FAIL = 'true';
        await expect(new MockComplianceProvider().assess(request('100'))).rejects.toThrow(/no disponible/);
      });

      it.each(['false', '', 'TRUE', '1'])('con "%s" funciona con normalidad (solo "true" activa la falla)', async (value) => {
        process.env.COMPLIANCE_MOCK_FAIL = value;
        expect(await new MockComplianceProvider().assess(request('100'))).toEqual({ riskLevel: 'LOW' });
      });
    });
  });
});
