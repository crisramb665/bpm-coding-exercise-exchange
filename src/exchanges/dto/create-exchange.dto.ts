import { IsUUID } from 'class-validator';

// Lo único que envía el cliente es la cotización: precio, comisión y montos salen de lo guardado en ella (R9).
export class CreateExchangeDto {
  @IsUUID(undefined, { message: 'quote_id debe ser un uuid válido' })
  quote_id!: string;
}
