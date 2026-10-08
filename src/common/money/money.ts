import Decimal from 'decimal.js';

// Clon propio de Decimal con precisión de 40 dígitos. Los montos tienen hasta 28 dígitos (numeric(28,8)) y el
// Decimal global trae solo 20, con los que un producto o una suma podría redondearse en silencio.
// El clon evita además depender de (o alterar) la configuración global de decimal.js.
const Dec = Decimal.clone({ precision: 40 });

export const PRICE = new Dec('2500'); // USDT-SBX por 1 XAUT-SBX (R8)
export const FEE_RATE = new Dec('0.01'); // 1 % sobre el monto de origen (R8)
export const AMOUNT_DECIMALS = 8; // precisión máxima de todo monto (R8, D5)

// Par soportado: se paga con USDT-SBX para recibir XAUT-SBX (2). No hay otro par.
export const SOURCE_ASSET = 'USDT-SBX';
export const TARGET_ASSET = 'XAUT-SBX';

export interface QuoteAmounts {
  feeAmount: Decimal;
  netAmount: Decimal;
  targetAmount: Decimal;
}

// Calcula comisión, neto y monto destino (docs/spec.md §4). Función pura: no toca la base ni el reloj.
//   fee    = ceil8(source × 1 %)       redondeo hacia ARRIBA: la plataforma nunca cobra de menos (D5)
//   net    = source − fee
//   target = floor8(net ÷ 2.500)       redondeo hacia ABAJO: nunca se entrega más de lo cobrado (R8)
// Acepta string o Decimal, y siempre lo copia al Decimal de precisión 40: si el llamador usara el Decimal
// global (precisión 20), las operaciones se harían con la precisión del objeto que las ejecuta, no con la de aquí.
export function calculateQuote(sourceAmount: Decimal.Value): QuoteAmounts {
  const source = new Dec(sourceAmount);

  // Estas validaciones no son de entrada de usuario (eso lo hace el DTO, con 400): si fallan es un error de programación.
  // Con más de 8 decimales, numeric(28,8) redondearía el monto al guardarlo y la comisión dejaría de corresponder.
  if (!source.isFinite() || source.lte(0)) {
    throw new Error(`source_amount debe ser mayor que 0, recibió ${source}`);
  }
  if (source.decimalPlaces() > AMOUNT_DECIMALS) {
    throw new Error(`source_amount admite como máximo ${AMOUNT_DECIMALS} decimales, recibió ${source}`);
  }

  const feeAmount = source.times(FEE_RATE).toDecimalPlaces(AMOUNT_DECIMALS, Decimal.ROUND_UP);
  const netAmount = source.minus(feeAmount);
  // Dividir por 2.500 (= 2² · 5⁴) siempre da un decimal finito (un neto de 8 decimales da, como mucho, 12), así que
  // con precisión 40 la división es exacta y el redondeo hacia abajo opera sobre el valor verdadero.
  const targetAmount = netAmount.div(PRICE).toDecimalPlaces(AMOUNT_DECIMALS, Decimal.ROUND_DOWN);

  return { feeAmount, netAmount, targetAmount };
}

// Un monto como texto para la base de datos y la API: siempre 8 decimales, nunca notación científica.
export function formatAmount(amount: Decimal): string {
  return amount.toFixed(AMOUNT_DECIMALS);
}
