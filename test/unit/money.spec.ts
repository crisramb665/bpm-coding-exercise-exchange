import Decimal from 'decimal.js';
import { calculateQuote, formatAmount, riskLevelFor, RiskLevel } from '../../src/common/money/money';
import { randomAmounts } from '../helpers';

// Caso B1 de docs/plan.md §9: la tabla de montos de docs/spec.md §7, comparada como strings (nunca como Number).
describe('calculateQuote y riskLevelFor', () => {
  // [monto USDT, comisión, neto, XAUT, riesgo]
  const table: [string, string, string, string, RiskLevel][] = [
    ['999.99', '9.99990000', '989.99010000', '0.39599604', 'LOW'],
    ['1000', '10.00000000', '990.00000000', '0.39600000', 'MEDIUM'],
    ['2500', '25.00000000', '2475.00000000', '0.99000000', 'MEDIUM'], // ejemplo del enunciado
    ['5000', '50.00000000', '4950.00000000', '1.98000000', 'MEDIUM'],
    ['5000.01', '50.00010000', '4950.00990000', '1.98000396', 'HIGH'],
    ['10000', '100.00000000', '9900.00000000', '3.96000000', 'HIGH'],
    ['10000.00000001', '100.00000001', '9900.00000000', '3.96000000', 'HIGH'],
    ['0.12345678', '0.00123457', '0.12222221', '0.00004888', 'LOW'], // comisión ↑ y destino ↓
    ['0.00002526', '0.00000026', '0.00002500', '0.00000001', 'LOW'], // el mínimo que da algo de XAUT
    ['0.00002525', '0.00000026', '0.00002499', '0.00000000', 'LOW'], // destino 0 → AMOUNT_TOO_SMALL (D12)
  ];

  it.each(table)('%s USDT → comisión %s, neto %s, %s XAUT, riesgo %s', (source, fee, net, target, risk) => {
    const q = calculateQuote(source);
    expect(formatAmount(q.feeAmount)).toBe(fee);
    expect(formatAmount(q.netAmount)).toBe(net);
    expect(formatAmount(q.targetAmount)).toBe(target);
    expect(riskLevelFor(source)).toBe(risk);
  });

  describe('fronteras de riesgo (R10)', () => {
    it.each([
      ['0.00000001', 'LOW'],
      ['999.99', 'LOW'],
      ['999.99999999', 'LOW'], // un paso por debajo de 1.000
      ['1000', 'MEDIUM'], // 1.000 ya es MEDIUM
      ['5000', 'MEDIUM'], // 5.000 sigue siendo MEDIUM (inclusive)
      ['5000.00000001', 'HIGH'], // un paso por encima de 5.000
      ['5000.01', 'HIGH'],
    ])('%s → %s', (amount, risk) => {
      expect(riskLevelFor(amount)).toBe(risk);
    });
  });

  describe('exactitud', () => {
    it('no pierde precisión aunque el llamador use el Decimal global (precisión 20)', () => {
      // 28 dígitos: con la precisión por defecto (20) de un Decimal global, source × 1 % se redondearía mal.
      const big = new Decimal('12345678901234567890.12345678');
      const q = calculateQuote(big);
      expect(formatAmount(q.feeAmount)).toBe('123456789012345678.90123457'); // ceil8(123456789012345678.9012345678)
      expect(formatAmount(q.netAmount)).toBe('12222222112222222211.22222221');
      expect(formatAmount(q.targetAmount)).toBe('4888888844888888.88448888'); // floor8(netAmount / 2500)
    });

    it('acepta tanto string como Decimal con el mismo resultado', () => {
      expect(formatAmount(calculateQuote('2500').targetAmount)).toBe(
        formatAmount(calculateQuote(new Decimal('2500')).targetAmount),
      );
    });

    it('formatAmount devuelve 8 decimales y nunca notación científica', () => {
      expect(formatAmount(new Decimal('1e-8'))).toBe('0.00000001');
      expect(formatAmount(new Decimal('5'))).toBe('5.00000000');
      expect(formatAmount(new Decimal('1e21'))).toBe('1000000000000000000000.00000000');
    });

    // Comprobación cruzada con un cálculo independiente: aritmética entera con BigInt en unidades de 1e-8.
    // Si decimal.js y BigInt coinciden en miles de montos pseudoaleatorios, el redondeo es correcto.
    it('coincide con un cálculo de enteros BigInt en 2.000 montos pseudoaleatorios', () => {
      for (const source of randomAmounts(2000)) {
        const [int, frac] = source.split('.');
        const units = BigInt(int) * 100000000n + BigInt(frac);

        const fee = (units + 99n) / 100n; // ceil(units / 100)
        const net = units - fee;
        const target = net / 2500n; // floor: BigInt trunca hacia cero y net > 0

        const q = calculateQuote(source);
        expect(q.feeAmount.mul('1e8').toFixed(0)).toBe(fee.toString());
        expect(q.netAmount.mul('1e8').toFixed(0)).toBe(net.toString());
        expect(q.targetAmount.mul('1e8').toFixed(0)).toBe(target.toString());
      }
    });
  });

  describe('entradas inválidas (error de programación, no 400)', () => {
    it.each(['0', '-1', 'abc'])('rechaza %s', (bad) => {
      expect(() => calculateQuote(bad)).toThrow();
    });

    it('rechaza más de 8 decimales en lugar de redondear en silencio', () => {
      expect(() => calculateQuote('1.123456789')).toThrow(/8 decimales/);
    });
  });
});
