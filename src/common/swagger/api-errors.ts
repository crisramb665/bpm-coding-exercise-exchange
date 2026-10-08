import { applyDecorators } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional, ApiResponse } from '@nestjs/swagger';

class ErrorBody {
  @ApiProperty({ example: 'QUOTE_EXPIRED', description: 'Código estable de negocio: no cambia aunque cambie el mensaje.' })
  code!: string;

  @ApiProperty({ example: 'La cotización venció' })
  message!: string;

  @ApiPropertyOptional({ type: 'object', additionalProperties: true, description: 'Datos del error (ids, montos, campos inválidos…).' })
  details?: Record<string, unknown>;
}

// La forma de TODOS los errores de la API (docs/spec.md §5).
export class ErrorResponse {
  @ApiProperty({ type: ErrorBody })
  error!: ErrorBody;
}

const STATUS_NAMES: Record<number, string> = {
  400: 'Solicitud inválida',
  401: 'Sin usuario identificado',
  403: 'Rol no autorizado',
  404: 'No encontrado',
  409: 'Conflicto',
  422: 'Regla de negocio no cumplida',
  503: 'Servicio no disponible',
};

// Documenta las respuestas de error de un endpoint sin repetir un @ApiResponse por cada una:
//   @ApiErrors({ 404: 'QUOTE_NOT_FOUND', 422: 'QUOTE_EXPIRED · INSUFFICIENT_FUNDS' })
// El valor es el texto que describe qué códigos de negocio pueden venir con ese status.
export function ApiErrors(errors: Partial<Record<keyof typeof STATUS_NAMES, string>>): MethodDecorator & ClassDecorator {
  return applyDecorators(
    ...Object.entries(errors).map(([status, codes]) =>
      ApiResponse({ status: Number(status), description: `${STATUS_NAMES[Number(status)]}: ${codes}`, type: ErrorResponse }),
    ),
  );
}
