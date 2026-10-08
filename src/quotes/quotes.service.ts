import { Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import { BusinessError } from '../common/errors/business-error';
import { validationError } from '../common/errors/validation-error';
import { calculateQuote, FEE_RATE, formatAmount, PRICE, SOURCE_ASSET, TARGET_ASSET } from '../common/money/money';
import { CreateQuoteDto } from './dto/create-quote.dto';
import { QuoteRow, QuotesRepository } from './quotes.repository';

const DEFAULT_TTL_SECONDS = 30; // vigencia del enunciado (R8)

@Injectable()
export class QuotesService {
  private readonly ttlSeconds: number;

  constructor(private readonly quotes: QuotesRepository) {
    // La vigencia es configurable (QUOTE_TTL_SECONDS) para poder probar el vencimiento sin esperar 30 s (D14).
    // Un valor inválido hace fallar el arranque en lugar de generar cotizaciones que nunca vencen o que nacen vencidas.
    const raw = process.env.QUOTE_TTL_SECONDS ?? String(DEFAULT_TTL_SECONDS);
    if (!/^[1-9]\d{0,5}$/.test(raw)) {
      throw new Error(`QUOTE_TTL_SECONDS debe ser un entero positivo de hasta 6 dígitos, recibió "${raw}"`);
    }
    this.ttlSeconds = Number(raw); // segundos, no un monto
  }

  async create(userId: string, dto: CreateQuoteDto): Promise<QuoteRow> {
    // La regex del DTO acepta "0" y "0.00000000"; un monto no positivo es un 400.
    if (new Decimal(dto.source_amount).lte(0)) {
      throw validationError('source_amount', 'source_amount debe ser mayor que 0');
    }

    const { feeAmount, netAmount, targetAmount } = calculateQuote(dto.source_amount);

    // Un monto tan pequeño que el XAUT, redondeado hacia abajo, da 0 no se puede cotizar (D12).
    // El CHECK target_amount > 0 de la tabla lo respalda, pero aquí se responde con un error de negocio claro.
    if (targetAmount.isZero()) {
      throw new BusinessError('AMOUNT_TOO_SMALL', 422, 'El monto es demasiado pequeño: el XAUT-SBX a recibir sería 0', {
        source_amount: dto.source_amount,
      });
    }

    return this.quotes.insert({
      userId,
      sourceAsset: SOURCE_ASSET,
      targetAsset: TARGET_ASSET,
      sourceAmount: dto.source_amount,
      price: formatAmount(PRICE),
      feeRate: FEE_RATE.toFixed(6), // numeric(7,6)
      feeAmount: formatAmount(feeAmount),
      netAmount: formatAmount(netAmount),
      targetAmount: formatAmount(targetAmount),
      ttlSeconds: this.ttlSeconds,
    });
  }
}
