import { Equals, IsString, Matches } from 'class-validator';
import { SOURCE_ASSET, TARGET_ASSET } from '../../common/money/money';

// Hasta 20 dígitos enteros y 8 decimales (numeric(28,8)). Sin signo, sin exponente, sin espacios ni separador de miles.
// Que sea mayor que 0 se comprueba aparte: la regex acepta "0" y "0.00000000".
export const AMOUNT_PATTERN = /^\d{1,20}(\.\d{1,8})?$/;

// source_amount es un string (S3): si llegara como número JSON, JSON.parse ya lo habría convertido a Number y
// perdido precisión, así que @IsString lo rechaza antes de que nadie lo lea.
export class CreateQuoteDto {
  @Equals(SOURCE_ASSET, { message: `source_asset debe ser ${SOURCE_ASSET}` })
  source_asset!: string;

  @Equals(TARGET_ASSET, { message: `target_asset debe ser ${TARGET_ASSET}` })
  target_asset!: string;

  @IsString({ message: 'source_amount debe ser un string, no un número' })
  @Matches(AMOUNT_PATTERN, { message: 'source_amount debe tener hasta 20 enteros y 8 decimales, sin signo ni exponente' })
  source_amount!: string;
}
