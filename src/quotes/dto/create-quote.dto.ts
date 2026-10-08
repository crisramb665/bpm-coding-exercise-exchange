import { ApiProperty } from '@nestjs/swagger';
import { Equals, IsString, Matches } from 'class-validator';
import { SOURCE_ASSET, TARGET_ASSET } from '../../common/money/money';

// Hasta 20 dígitos enteros y 8 decimales (numeric(28,8)). Sin signo, sin exponente, sin espacios ni separador de miles.
// Que sea mayor que 0 se comprueba aparte: la regex acepta "0" y "0.00000000".
export const AMOUNT_PATTERN = /^\d{1,20}(\.\d{1,8})?$/;

// source_amount es un string (S3): si llegara como número JSON, JSON.parse ya lo habría convertido a Number y
// perdido precisión, así que @IsString lo rechaza antes de que nadie lo lea.
export class CreateQuoteDto {
  @ApiProperty({ example: SOURCE_ASSET, description: 'Único valor soportado: se paga con USDT-SBX.' })
  @Equals(SOURCE_ASSET, { message: `source_asset debe ser ${SOURCE_ASSET}` })
  source_asset!: string;

  @ApiProperty({ example: TARGET_ASSET, description: 'Único valor soportado: se recibe XAUT-SBX.' })
  @Equals(TARGET_ASSET, { message: `target_asset debe ser ${TARGET_ASSET}` })
  target_asset!: string;

  @ApiProperty({
    type: String,
    example: '2500',
    pattern: '^\\d{1,20}(\\.\\d{1,8})?$',
    description: 'Monto en USDT-SBX **como string**: hasta 20 enteros y 8 decimales, mayor que 0. Un número JSON se rechaza.',
  })
  @IsString({ message: 'source_amount debe ser un string, no un número' })
  @Matches(AMOUNT_PATTERN, { message: 'source_amount debe tener hasta 20 enteros y 8 decimales, sin signo ni exponente' })
  source_amount!: string;
}
