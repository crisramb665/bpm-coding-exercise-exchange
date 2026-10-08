import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

// Lo único que envía el cliente es la cotización: precio, comisión y montos salen de lo guardado en ella (R9).
export class CreateExchangeDto {
  @ApiProperty({ format: 'uuid', description: 'Id de una cotización ACTIVE y vigente, de POST /quotes.' })
  @IsUUID(undefined, { message: 'quote_id debe ser un uuid válido' })
  quote_id!: string;
}
