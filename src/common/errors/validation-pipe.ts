import { ValidationPipe } from '@nestjs/common';
import { ValidationError } from 'class-validator';
import { BusinessError } from './business-error';

// ValidationPipe global: valida los DTO y responde 400 VALIDATION_ERROR con el formato de error de la API.
export function createValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true, // descarta propiedades que el DTO no declara...
    forbidNonWhitelisted: true, // ...y en lugar de descartarlas en silencio, rechaza la petición.
    // transform queda en false (por defecto): los montos son strings y deben seguir siéndolo (S3).
    exceptionFactory: (errors: ValidationError[]) =>
      new BusinessError('VALIDATION_ERROR', 400, 'La solicitud no es válida', {
        fields: errors.map((e) => ({ field: e.property, messages: Object.values(e.constraints ?? {}) })),
      }),
  });
}
