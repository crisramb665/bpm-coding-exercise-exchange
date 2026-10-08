import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsOptional, IsString, Matches, MaxLength } from "class-validator";

const MAX_REASON = 500;

// Aprobar: el motivo es opcional (D14).
export class ApproveDto {
  @ApiPropertyOptional({
    maxLength: MAX_REASON,
    example: "Origen de fondos verificado",
  })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_REASON)
  reason?: string;
}

// Rechazar: el motivo es obligatorio y no puede ser solo espacios (D14). La base lo vuelve a exigir con un CHECK.
export class RejectDto {
  @ApiProperty({
    maxLength: MAX_REASON,
    example: "Origen de fondos no acreditado",
    description: "Obligatorio y no vacío.",
  })
  @IsString()
  @Matches(/\S/, { message: "reason es obligatorio y no puede estar vacío" })
  @MaxLength(MAX_REASON)
  reason!: string;
}
