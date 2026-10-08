import { ParseUUIDPipe } from '@nestjs/common';
import { BusinessError } from './business-error';

// 400 VALIDATION_ERROR con el mismo formato que produce el ValidationPipe de los DTO (details.fields).
// Para validar a mano parámetros de ruta o de query, que no pasan por un DTO.
export function validationError(field: string, message: string): BusinessError {
  return new BusinessError('VALIDATION_ERROR', 400, 'La solicitud no es válida', {
    fields: [{ field, messages: [message] }],
  });
}

// Pipe para un parámetro de ruta que debe ser uuid: @Param('id', uuidParam('id')).
// Sin exceptionFactory, ParseUUIDPipe respondería con el formato de error por defecto de Nest, no el de la API.
export function uuidParam(field: string): ParseUUIDPipe {
  return new ParseUUIDPipe({ exceptionFactory: () => validationError(field, `${field} debe ser un uuid válido`) });
}
